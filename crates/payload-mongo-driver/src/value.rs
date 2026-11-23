//! The documents a lean mongoose read hands to `transform`, as Rust values.
//!
//! The Node driver decodes BSON with js-bson (`promoteValues`, `promoteLongs`, no `promoteBuffers`,
//! no `bsonRegExp`, no `useBigInt64`): int32 / double / int64 within +-2^53 become numbers, strings,
//! booleans, null, arrays and plain objects (keys assigned in BSON order: a repeated key keeps its
//! first position and takes the last value), ObjectId / Date become class instances, everything
//! else (Decimal128, Binary, Long beyond 2^53, RegExp, Timestamp, Code, DBRef, MinKey, ...) another
//! object. [`V`] keeps exactly the distinctions the read transform and the JSON materialization
//! need; values the lane cannot carry through `JSON.parse` are [`V::Opaque`] and make the call fall
//! back to the mongoose lane.
//!
//! Decoding is lazy: nested documents and arrays stay borrowed BSON ([`V::RawDoc`] /
//! [`V::RawArr`]) until the transform visits them ([`V::materialize`]); subtrees it never visits
//! (rich text, json fields, ...) are transcoded to JSON directly. Strings are borrowed.

use std::borrow::Cow;

use mongodb::bson::{RawArray, RawBsonRef, RawDocument};

/// Why a call left the driver lane (it is re-run on the mongoose lane, which produces upstream's
/// result or error).
#[derive(Debug)]
pub struct Bail(pub &'static str);

pub type LaneResult<T> = Result<T, Bail>;

#[derive(Clone, Debug)]
pub enum V<'a> {
  /// An own property whose value is `undefined`.
  Undefined,
  Null,
  Bool(bool),
  /// int32 and double values (JS numbers).
  Num(f64),
  /// int64 within +-2^53 (js-bson promotes it to a number).
  Int(i64),
  Str(Cow<'a, str>),
  Arr(Vec<V<'a>>),
  Obj(Obj<'a>),
  ObjectId([u8; 12]),
  /// Milliseconds since the epoch (BSON datetime).
  Date(i64),
  /// Any value JSON cannot carry (an object for `typeof` / truthiness).
  Opaque(&'static str),
  /// A document not decoded yet (a plain object).
  RawDoc(&'a RawDocument),
  /// An array not decoded yet.
  RawArr(&'a RawArray),
}

/// A plain JS object with string keys in insertion order (integer-like keys are ordered by V8
/// itself, identically for objects js-bson builds and for objects `JSON.parse` builds).
#[derive(Clone, Debug, Default)]
pub struct Obj<'a>(pub Vec<(Cow<'a, str>, V<'a>)>);

impl<'a> Obj<'a> {
  pub fn get(&self, key: &str) -> Option<&V<'a>> {
    self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
  }

  pub fn get_mut(&mut self, key: &str) -> Option<&mut V<'a>> {
    self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
  }

  pub fn has(&self, key: &str) -> bool {
    self.0.iter().any(|(k, _)| k == key)
  }

  /// `o[key] = value` on a plain object: an existing key keeps its position.
  pub fn set(&mut self, key: &'a str, value: V<'a>) {
    match self.get_mut(key) {
      Some(slot) => *slot = value,
      None => self.0.push((Cow::Borrowed(key), value)),
    }
  }

  /// `delete o[key]`.
  pub fn delete(&mut self, key: &str) {
    if let Some(index) = self.0.iter().position(|(k, _)| k == key) {
      self.0.remove(index);
    }
  }
}

impl<'a> V<'a> {
  /// JS truthiness.
  pub fn truthy(&self) -> bool {
    match self {
      V::Undefined | V::Null => false,
      V::Bool(b) => *b,
      V::Num(n) => !(*n == 0.0 || n.is_nan()),
      V::Int(i) => *i != 0,
      V::Str(s) => !s.is_empty(),
      V::Arr(_)
      | V::Obj(_)
      | V::ObjectId(_)
      | V::Date(_)
      | V::Opaque(_)
      | V::RawDoc(_)
      | V::RawArr(_) => true,
    }
  }

  /// `typeof v === 'object'` (null included).
  pub fn is_object_type(&self) -> bool {
    matches!(
      self,
      V::Null | V::Arr(_) | V::Obj(_) | V::ObjectId(_) | V::Date(_) | V::Opaque(_) | V::RawDoc(_) | V::RawArr(_)
    )
  }

  /// A plain object (decoded or not).
  pub fn is_plain_object(&self) -> bool {
    matches!(self, V::Obj(_) | V::RawDoc(_))
  }

  /// `Array.isArray(v)`.
  pub fn is_array(&self) -> bool {
    matches!(self, V::Arr(_) | V::RawArr(_))
  }

  /// Decodes a raw document / array one level (its children stay raw).
  pub fn materialize(&mut self) -> LaneResult<()> {
    match self {
      V::RawDoc(doc) => *self = V::Obj(decode_document(doc)?),
      V::RawArr(array) => *self = V::Arr(decode_array(array)?),
      _ => {}
    }
    Ok(())
  }

  /// The plain object, decoded.
  pub fn obj_mut(&mut self) -> LaneResult<Option<&mut Obj<'a>>> {
    self.materialize()?;
    Ok(match self {
      V::Obj(obj) => Some(obj),
      _ => None,
    })
  }

  /// The array, decoded.
  pub fn arr_mut(&mut self) -> LaneResult<Option<&mut Vec<V<'a>>>> {
    self.materialize()?;
    Ok(match self {
      V::Arr(items) => Some(items),
      _ => None,
    })
  }

  pub fn as_str(&self) -> Option<&str> {
    match self {
      V::Str(s) => Some(s),
      _ => None,
    }
  }
}

/// js-bson's `promoteLongs` range.
const MAX_PROMOTED_LONG: i64 = 1 << 53;

/// Keys a lane document must not have: `__proto__` (js-bson defines it specially, `JSON.parse`
/// creates an own property) and `$ref` (js-bson turns `{ $ref, $id }` documents into DBRefs).
pub fn is_unsupported_key(key: &str) -> bool {
  key == "__proto__" || key == "$ref"
}

/// One level of `doc`: scalars decoded, nested documents / arrays raw.
pub fn decode_document(doc: &RawDocument) -> LaneResult<Obj<'_>> {
  let mut obj = Obj(Vec::new());
  // a repeated key is rare: the linear search only runs when the key's bucket was seen
  let mut seen = 0u64;
  for entry in doc.iter() {
    let (key, value) = entry.map_err(|_| Bail("malformed bson"))?;
    if is_unsupported_key(key) {
      return Err(Bail("unsupported key"));
    }
    let bucket = 1u64 << (key_bucket(key) & 63);
    if seen & bucket != 0 {
      obj.set(key, decode_value(value));
    } else {
      seen |= bucket;
      obj.0.push((Cow::Borrowed(key), decode_value(value)));
    }
  }
  Ok(obj)
}

fn key_bucket(key: &str) -> u32 {
  let bytes = key.as_bytes();
  let first = bytes.first().copied().unwrap_or(0) as u32;
  let last = bytes.last().copied().unwrap_or(0) as u32;
  first.wrapping_mul(31) ^ last.wrapping_mul(7) ^ bytes.len() as u32
}

pub fn decode_array(array: &RawArray) -> LaneResult<Vec<V<'_>>> {
  let mut out = Vec::new();
  for value in array {
    out.push(decode_value(value.map_err(|_| Bail("malformed bson"))?));
  }
  Ok(out)
}

pub fn decode_value(value: RawBsonRef<'_>) -> V<'_> {
  match value {
    RawBsonRef::Double(n) => V::Num(n),
    RawBsonRef::Int32(n) => V::Num(n as f64),
    RawBsonRef::Int64(n) => {
      if (-MAX_PROMOTED_LONG..=MAX_PROMOTED_LONG).contains(&n) {
        V::Int(n)
      } else {
        V::Opaque("long")
      }
    }
    RawBsonRef::String(s) => V::Str(Cow::Borrowed(s)),
    RawBsonRef::Boolean(b) => V::Bool(b),
    RawBsonRef::Null => V::Null,
    RawBsonRef::Document(d) => V::RawDoc(d),
    RawBsonRef::Array(a) => V::RawArr(a),
    RawBsonRef::ObjectId(oid) => V::ObjectId(oid.bytes()),
    RawBsonRef::DateTime(dt) => V::Date(dt.timestamp_millis()),
    RawBsonRef::Decimal128(_) => V::Opaque("decimal128"),
    RawBsonRef::Binary(_) => V::Opaque("binary"),
    RawBsonRef::RegularExpression(_) => V::Opaque("regexp"),
    RawBsonRef::Timestamp(_) => V::Opaque("timestamp"),
    RawBsonRef::JavaScriptCode(_) | RawBsonRef::JavaScriptCodeWithScope(_) => V::Opaque("code"),
    RawBsonRef::Symbol(_) => V::Opaque("symbol"),
    RawBsonRef::Undefined => V::Opaque("undefined"),
    RawBsonRef::MaxKey | RawBsonRef::MinKey => V::Opaque("minmaxkey"),
    RawBsonRef::DbPointer(_) => V::Opaque("dbpointer"),
  }
}

pub fn object_id_hex(bytes: &[u8; 12]) -> String {
  const HEX: &[u8; 16] = b"0123456789abcdef";
  let mut out = String::with_capacity(24);
  for byte in bytes {
    out.push(HEX[(byte >> 4) as usize] as char);
    out.push(HEX[(byte & 15) as usize] as char);
  }
  out
}

/// `new Date(ms).toISOString()`, or `None` where V8 throws `RangeError: Invalid time value`.
pub fn date_iso(ms: i64) -> Option<String> {
  const MAX_TIME: i64 = 8_640_000_000_000_000;
  if !(-MAX_TIME..=MAX_TIME).contains(&ms) {
    return None;
  }
  let days = ms.div_euclid(86_400_000);
  let ms_of_day = ms.rem_euclid(86_400_000);
  let (year, month, day) = civil_from_days(days);
  let hour = ms_of_day / 3_600_000;
  let minute = ms_of_day / 60_000 % 60;
  let second = ms_of_day / 1000 % 60;
  let millis = ms_of_day % 1000;
  let mut out = String::with_capacity(27);
  if (0..=9999).contains(&year) {
    push_number(&mut out, year as u64, 4);
  } else {
    out.push(if year < 0 { '-' } else { '+' });
    push_number(&mut out, year.unsigned_abs(), 6);
  }
  out.push('-');
  push_number(&mut out, month as u64, 2);
  out.push('-');
  push_number(&mut out, day as u64, 2);
  out.push('T');
  push_number(&mut out, hour as u64, 2);
  out.push(':');
  push_number(&mut out, minute as u64, 2);
  out.push(':');
  push_number(&mut out, second as u64, 2);
  out.push('.');
  push_number(&mut out, millis as u64, 3);
  out.push('Z');
  Some(out)
}

/// `value` in decimal, zero-padded to `width`.
fn push_number(out: &mut String, value: u64, width: usize) {
  let mut buffer = itoa::Buffer::new();
  let text = buffer.format(value);
  for _ in text.len()..width {
    out.push('0');
  }
  out.push_str(text);
}

/// Howard Hinnant's `civil_from_days` (proleptic Gregorian calendar, like ECMAScript).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = doy - (153 * mp + 2) / 5 + 1;
  let m = if mp < 10 { mp + 3 } else { mp - 9 };
  (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn iso_dates_match_v8() {
    assert_eq!(date_iso(0).unwrap(), "1970-01-01T00:00:00.000Z");
    assert_eq!(date_iso(1_700_000_000_123).unwrap(), "2023-11-14T22:13:20.123Z");
    assert_eq!(date_iso(-1).unwrap(), "1969-12-31T23:59:59.999Z");
    assert_eq!(date_iso(-62_198_755_200_000).unwrap(), "-000001-01-01T00:00:00.000Z");
    assert_eq!(date_iso(253_402_300_800_000).unwrap(), "+010000-01-01T00:00:00.000Z");
    assert_eq!(date_iso(8_640_000_000_000_000).unwrap(), "+275760-09-13T00:00:00.000Z");
    assert!(date_iso(8_640_000_000_000_001).is_none());
  }
}
