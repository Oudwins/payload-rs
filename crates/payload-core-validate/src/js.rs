//! JavaScript builtin semantics the default validators depend on: `typeof`, property access,
//! `String(v)` / `Number(v)` / `parseFloat(v)` (with the `TypeError`s `ToPrimitive` throws),
//! `<` / `>`, `===` / SameValueZero, `JSON.stringify`, `Number.prototype.toString` and
//! `bson-objectid`'s `ObjectId.isValid`.
//!
//! Values are [`JsVal`]s decoded from the `serializeForEngine` format, so they are JSON-like
//! data: plain objects have `Object.prototype` and arrays `Array.prototype`. Own properties that
//! shadow `toString` / `valueOf` are honoured: non-callable ones make `ToPrimitive` throw a
//! `TypeError` like V8; callable ones (`JsVal::Fn`) would require calling back into JS and are
//! reported as an unsupported-value error instead of silently diverging.

use std::cmp::Ordering;

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj, date_to_iso_string};

/// `Object.prototype` property names: `obj[key]` resolves to an inherited value for these.
pub const OBJECT_PROTOTYPE_KEYS: &[&str] = &[
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
];

pub fn type_error(message: impl Into<String>) -> EngineError {
  EngineError::new("TypeError", message)
}

/// A JS function found inside a value would have to be called (`toString`, `valueOf`, `toJSON`).
pub fn unsupported_function(context: &str) -> EngineError {
  EngineError::internal(format!("calling a JS function found in a value is not supported ({context})"))
}

/// JS `typeof`.
pub fn type_of(v: &JsVal) -> &'static str {
  match v {
    JsVal::Undefined => "undefined",
    JsVal::Null | JsVal::Arr(_) | JsVal::Obj(_) => "object",
    JsVal::Bool(_) => "boolean",
    JsVal::Num(_) => "number",
    JsVal::Str(_) => "string",
    JsVal::Fn(_) => "function",
  }
}

/// JS `WhiteSpace` + `LineTerminator` (what `String.prototype.trim` removes).
pub fn is_js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
      | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
  )
}

/// `string.trim()`
pub fn trim(s: &str) -> &str {
  s.trim_matches(is_js_whitespace)
}

/// JS `string.length` (UTF-16 code units).
pub fn str_len(s: &str) -> usize {
  s.encode_utf16().count()
}

/// `string[index]`: the UTF-16 code unit at `index`. A lone surrogate half (which a Rust string
/// can't hold) is returned as U+FFFD, which behaves the same for every use here (truthy, `NaN`
/// for `parseFloat`).
fn str_index(s: &str, index: usize) -> Option<String> {
  let unit = s.encode_utf16().nth(index)?;
  Some(char::from_u32(u32::from(unit)).unwrap_or('\u{FFFD}').to_string())
}

/// Parses a canonical array index (`"0"`, `"12"`, not `"01"`).
fn array_index(key: &str) -> Option<usize> {
  if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  key.parse().ok()
}

/// `value[key]` / `value.key`; throws a `TypeError` for `undefined` / `null` like V8.
pub fn get(v: &JsVal, key: &str) -> Result<JsVal> {
  match v {
    JsVal::Undefined | JsVal::Null => Err(type_error(format!(
      "Cannot read properties of {} (reading '{key}')",
      if v.is_null() { "null" } else { "undefined" }
    ))),
    _ => Ok(get_opt(v, key)),
  }
}

/// `value?.[key]`
pub fn get_opt(v: &JsVal, key: &str) -> JsVal {
  match v {
    JsVal::Str(s) => {
      if key == "length" {
        JsVal::Num(str_len(s) as f64)
      } else {
        array_index(key).and_then(|i| str_index(s, i)).map(JsVal::str).unwrap_or_default()
      }
    }
    JsVal::Arr(a) => {
      if key == "length" {
        JsVal::Num(a.len() as f64)
      } else {
        array_index(key).and_then(|i| a.get(i).cloned()).unwrap_or_default()
      }
    }
    JsVal::Obj(o) => o.get(key).cloned().unwrap_or_default(),
    _ => JsVal::Undefined,
  }
}

/// `ToPrimitive` of an object: `[object Object]` for plain objects, `join(',')` for arrays.
fn object_to_primitive_string(o: &Obj) -> Result<String> {
  if o.get("valueOf").is_some_and(JsVal::is_fn) || o.get("toString").is_some_and(JsVal::is_fn) {
    return Err(unsupported_function("ToPrimitive"));
  }
  if o.contains_key("toString") {
    return Err(type_error("Cannot convert object to primitive value"));
  }
  Ok("[object Object]".into())
}

/// `Date.prototype.toString` of a valid date (time value in ms). It prints the process time
/// zone's display name, which only JS (ICU) can produce: validators pass
/// [`crate::ValidateHost::date_to_string`].
pub type DateText<'a> = &'a dyn Fn(f64) -> Result<String>;

/// No host: a valid `Date`'s text is unsupported.
pub fn no_date_text(_ms: f64) -> Result<String> {
  Err(unsupported_function("Date.prototype.toString"))
}

fn date_string(ms: f64, date_text: DateText) -> Result<String> {
  if ms.is_nan() { Ok("Invalid Date".into()) } else { date_text(ms) }
}

/// JS `String(value)` / template literal interpolation / `ToPropertyKey`.
pub fn to_string(v: &JsVal) -> Result<String> {
  to_string_with(v, &no_date_text)
}

/// [`to_string`] with the text of valid `Date`s from `date_text`.
pub fn to_string_with(v: &JsVal, date_text: DateText) -> Result<String> {
  if let Some(ms) = v.as_date() {
    return date_string(ms, date_text);
  }
  Ok(match v {
    JsVal::Undefined => "undefined".into(),
    JsVal::Null => "null".into(),
    JsVal::Bool(b) => b.to_string(),
    JsVal::Num(n) => number_to_string(*n),
    JsVal::Str(s) => s.to_string(),
    JsVal::Arr(a) => {
      let mut out = String::new();
      for (i, item) in a.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        if !item.is_nullish() {
          out.push_str(&to_string_with(item, date_text)?);
        }
      }
      out
    }
    JsVal::Obj(o) => object_to_primitive_string(o)?,
    JsVal::Fn(_) => return Err(unsupported_function("String(function)")),
  })
}

/// `value.toString()` (method call, `value` is not nullish).
pub fn call_to_string(v: &JsVal, receiver_name: &str) -> Result<String> {
  call_to_string_with(v, receiver_name, &no_date_text)
}

/// [`call_to_string`] with the text of valid `Date`s from `date_text`.
pub fn call_to_string_with(v: &JsVal, receiver_name: &str, date_text: DateText) -> Result<String> {
  if let Some(ms) = v.as_date() {
    return date_string(ms, date_text);
  }
  match v {
    JsVal::Undefined | JsVal::Null => Err(type_error(format!(
      "Cannot read properties of {} (reading 'toString')",
      if v.is_null() { "null" } else { "undefined" }
    ))),
    JsVal::Obj(o) => match o.get("toString") {
      Some(JsVal::Fn(_)) => Err(unsupported_function("value.toString()")),
      Some(_) => Err(type_error(format!("{receiver_name}.toString is not a function"))),
      None => Ok("[object Object]".into()),
    },
    _ => to_string_with(v, date_text),
  }
}

/// JS `Number(value)` (`ToNumber`).
pub fn to_number(v: &JsVal) -> Result<f64> {
  if let Some(ms) = v.as_date() {
    return Ok(ms);
  }
  Ok(match v {
    JsVal::Undefined => f64::NAN,
    JsVal::Null => 0.0,
    JsVal::Bool(b) => f64::from(u8::from(*b)),
    JsVal::Num(n) => *n,
    JsVal::Str(s) => string_to_number(s),
    // Inside an array, a valid date's text starts with a weekday name: any letter gives the
    // same `NaN`.
    JsVal::Arr(_) | JsVal::Obj(_) => string_to_number(&to_string_with(v, &|_| Ok("Date".into()))?),
    JsVal::Fn(_) => return Err(unsupported_function("Number(function)")),
  })
}

/// JS `parseFloat(value)`.
pub fn parse_float(v: &JsVal) -> Result<f64> {
  // `String(date)` starts with a weekday name or is `Invalid Date`: never a number.
  if v.as_date().is_some() {
    return Ok(f64::NAN);
  }
  Ok(parse_float_str(&to_string(v)?))
}

pub fn parse_float_str(s: &str) -> f64 {
  let t = s.trim_start_matches(is_js_whitespace);
  decimal_prefix(t).map(|(v, _)| v).unwrap_or(f64::NAN)
}

/// Longest `StrDecimalLiteral` prefix of `s` (ASCII grammar): value and byte length.
fn decimal_prefix(s: &str) -> Option<(f64, usize)> {
  let b = s.as_bytes();
  let mut i = 0;
  let negative = b.first() == Some(&b'-');
  if matches!(b.first(), Some(b'+' | b'-')) {
    i = 1;
  }
  if s[i..].starts_with("Infinity") {
    return Some((if negative { f64::NEG_INFINITY } else { f64::INFINITY }, i + "Infinity".len()));
  }
  let int_start = i;
  while i < b.len() && b[i].is_ascii_digit() {
    i += 1;
  }
  let int_digits = i - int_start;
  let mut frac_digits = 0;
  if i < b.len() && b[i] == b'.' {
    let mut j = i + 1;
    while j < b.len() && b[j].is_ascii_digit() {
      j += 1;
    }
    frac_digits = j - (i + 1);
    if int_digits > 0 || frac_digits > 0 {
      i = j;
    }
  }
  if int_digits == 0 && frac_digits == 0 {
    return None;
  }
  if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
    let mut j = i + 1;
    if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
      j += 1;
    }
    let exp_start = j;
    while j < b.len() && b[j].is_ascii_digit() {
      j += 1;
    }
    if j > exp_start {
      i = j;
    }
  }
  let parsed: f64 = s[..i].parse().ok()?;
  Some((parsed, i))
}

/// Converts digits of a power-of-two radix with round-half-to-even, like V8.
fn pow2_radix_to_f64(digits: &str, radix: u32) -> f64 {
  let bits_per_digit = radix.trailing_zeros();
  let mut bits: Vec<bool> = Vec::with_capacity(digits.len() * bits_per_digit as usize);
  for c in digits.chars() {
    let d = c.to_digit(radix).unwrap_or(0);
    for shift in (0..bits_per_digit).rev() {
      let bit = (d >> shift) & 1 == 1;
      if bit || !bits.is_empty() {
        bits.push(bit);
      }
    }
  }
  if bits.len() <= 53 {
    return bits.iter().fold(0.0, |acc, b| acc * 2.0 + f64::from(u8::from(*b)));
  }
  let mut mantissa: u64 = bits[..53].iter().fold(0, |acc, b| (acc << 1) | u64::from(*b));
  let round = bits[53];
  let sticky = bits[54..].iter().any(|b| *b);
  if round && (sticky || mantissa & 1 == 1) {
    mantissa += 1;
  }
  let exponent = (bits.len() - 53) as i32;
  mantissa as f64 * 2f64.powi(exponent)
}

/// JS `StringToNumber` (`Number(string)`).
pub fn string_to_number(s: &str) -> f64 {
  let t = trim(s);
  if t.is_empty() {
    return 0.0;
  }
  let radix = match t.get(..2) {
    Some("0x" | "0X") => Some(16),
    Some("0o" | "0O") => Some(8),
    Some("0b" | "0B") => Some(2),
    _ => None,
  };
  if let Some(radix) = radix {
    let digits = &t[2..];
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
      return f64::NAN;
    }
    return pow2_radix_to_f64(digits, radix);
  }
  match decimal_prefix(t) {
    Some((v, len)) if len == t.len() => v,
    _ => f64::NAN,
  }
}

/// `Number.prototype.toString()` (radix 10).
pub fn number_to_string(n: f64) -> String {
  if n.is_nan() {
    return "NaN".into();
  }
  if n == 0.0 {
    return "0".into();
  }
  if n.is_infinite() {
    return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
  }
  if n < 0.0 {
    return format!("-{}", number_to_string(-n));
  }
  let (digits, exp) = shortest_digits(n);
  let k = digits.len() as i32;
  let point = exp + 1;
  if k <= point && point <= 21 {
    format!("{digits}{}", "0".repeat((point - k) as usize))
  } else if 0 < point && point <= 21 {
    format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
  } else if -6 < point && point <= 0 {
    format!("0.{}{digits}", "0".repeat((-point) as usize))
  } else {
    let e = point - 1;
    let sign = if e < 0 { '-' } else { '+' };
    if k == 1 {
      format!("{digits}e{sign}{}", e.abs())
    } else {
      format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
    }
  }
}

fn split_exp_form(s: &str) -> (String, i32) {
  let (mantissa, exp) = s.split_once('e').unwrap_or((s, "0"));
  (mantissa.chars().filter(|c| *c != '.').collect(), exp.parse().unwrap_or(0))
}

/// Shortest round-trip decimal digits of a finite positive `n` and the exponent of the first.
///
/// Rust picks the closest shortest representation but rounds half up when `n` lies exactly
/// between two of them; `Number::toString` (and V8) picks the even one, so ties are re-checked
/// against the exact decimal expansion.
fn shortest_digits(n: f64) -> (String, i32) {
  let (digits, exp) = split_exp_form(&format!("{n:e}"));
  let k = digits.len();
  let last = digits.as_bytes()[k - 1];
  if (last - b'0') % 2 == 1 {
    let (exact, exact_exp) = split_exp_form(&format!("{n:.1100e}"));
    let e = exact.as_bytes();
    let is_tie = exact_exp == exp
      && e.len() > k
      && e[k] == b'5'
      && e[k + 1..].iter().all(|d| *d == b'0')
      && exact[..k - 1] == digits[..k - 1]
      && e[k - 1] + 1 == last;
    if is_tie {
      let even = &exact[..k];
      let candidate = format!("{}{}e{}", &even[..1], if k > 1 { format!(".{}", &even[1..]) } else { String::new() }, exp);
      if candidate.parse::<f64>().is_ok_and(|v| v == n) {
        return (even.to_string(), exp);
      }
    }
  }
  (digits, exp)
}

/// `ToPrimitive(value, number)` for the relational operators.
fn to_primitive(v: &JsVal) -> Result<JsVal> {
  if let Some(ms) = v.as_date() {
    return Ok(JsVal::Num(ms));
  }
  Ok(match v {
    JsVal::Arr(_) | JsVal::Obj(_) => JsVal::str(to_string(v)?),
    JsVal::Fn(_) => return Err(unsupported_function("ToPrimitive(function)")),
    other => other.clone(),
  })
}

/// `IsLessThan(x, y)`: `None` is the spec's `undefined` (a `NaN` operand).
fn is_less_than(x: &JsVal, y: &JsVal) -> Result<Option<bool>> {
  let px = to_primitive(x)?;
  let py = to_primitive(y)?;
  if let (JsVal::Str(a), JsVal::Str(b)) = (&px, &py) {
    return Ok(Some(a.encode_utf16().cmp(b.encode_utf16()) == Ordering::Less));
  }
  let nx = to_number(&px)?;
  let ny = to_number(&py)?;
  if nx.is_nan() || ny.is_nan() {
    return Ok(None);
  }
  Ok(Some(nx < ny))
}

/// `x < y`
pub fn lt(x: &JsVal, y: &JsVal) -> Result<bool> {
  Ok(is_less_than(x, y)?.unwrap_or(false))
}

/// `x > y`
pub fn gt(x: &JsVal, y: &JsVal) -> Result<bool> {
  Ok(is_less_than(y, x)?.unwrap_or(false))
}

/// `x === y`
pub fn strict_eq(x: &JsVal, y: &JsVal) -> bool {
  x.strict_eq(y)
}

/// SameValueZero (`Array.prototype.includes`, `Map` keys).
pub fn same_value_zero(x: &JsVal, y: &JsVal) -> bool {
  match (x, y) {
    (JsVal::Num(a), JsVal::Num(b)) if a.is_nan() && b.is_nan() => true,
    _ => x.strict_eq(y),
  }
}

fn json_quote(s: &str, out: &mut String) {
  out.push('"');
  for c in s.chars() {
    match c {
      '"' => out.push_str("\\\""),
      '\\' => out.push_str("\\\\"),
      '\u{8}' => out.push_str("\\b"),
      '\u{c}' => out.push_str("\\f"),
      '\n' => out.push_str("\\n"),
      '\r' => out.push_str("\\r"),
      '\t' => out.push_str("\\t"),
      c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
      c => out.push(c),
    }
  }
  out.push('"');
}

/// Writes `v`; `Ok(false)` when it serializes to `undefined`.
fn json_write(v: &JsVal, out: &mut String) -> Result<bool> {
  match v {
    JsVal::Undefined | JsVal::Fn(_) => return Ok(false),
    JsVal::Null => out.push_str("null"),
    JsVal::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
    JsVal::Num(n) => out.push_str(&if n.is_finite() { number_to_string(*n) } else { "null".into() }),
    JsVal::Str(s) => json_quote(s, out),
    JsVal::Arr(a) => {
      out.push('[');
      for (i, item) in a.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        if !json_write(item, out)? {
          out.push_str("null");
        }
      }
      out.push(']');
    }
    JsVal::Obj(_) if v.as_date().is_some() => {
      // `Date.prototype.toJSON`: `toISOString()`, `null` for an invalid date.
      match v.as_date().and_then(date_to_iso_string) {
        Some(iso) => json_quote(&iso, out),
        None => out.push_str("null"),
      }
    }
    JsVal::Obj(o) => {
      if o.get("toJSON").is_some_and(JsVal::is_fn) {
        return Err(unsupported_function("toJSON"));
      }
      out.push('{');
      let mut first = true;
      for (k, item) in o.iter() {
        if matches!(item, JsVal::Undefined | JsVal::Fn(_)) {
          continue;
        }
        if !first {
          out.push(',');
        }
        first = false;
        json_quote(k, out);
        out.push(':');
        json_write(item, out)?;
      }
      out.push('}');
    }
  }
  Ok(true)
}

/// `JSON.stringify(value)`; `None` when the result is `undefined`.
pub fn json_stringify(v: &JsVal) -> Result<Option<String>> {
  let mut out = String::new();
  Ok(json_write(v, &mut out)?.then_some(out))
}

/// `${JSON.stringify(value)}` (`undefined` interpolates as `"undefined"`).
pub fn json_stringify_interpolated(v: &JsVal) -> Result<String> {
  Ok(json_stringify(v)?.unwrap_or_else(|| "undefined".into()))
}

/// `bson-objectid` `ObjectId.isValid(id)` for JSON-like values.
///
/// An object is valid when it is an `ObjectID` / `Buffer` instance (data snapshots never are) or
/// duck-types as one through a `toHexString` function: that check reads the object's `id`, which
/// only the live object can answer, so it is an unsupported-value error here (the live
/// validators in `payload-core-validate-live` call the real `ObjectId.isValid`).
pub fn object_id_is_valid(v: &JsVal) -> Result<bool> {
  Ok(match v {
    JsVal::Num(_) => true,
    JsVal::Str(s) => {
      let len = str_len(s);
      len == 12 || (len == 24 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    }
    JsVal::Obj(o) if o.get("toHexString").is_some_and(JsVal::is_fn) => {
      return Err(unsupported_function("ObjectId.isValid (toHexString duck typing)"));
    }
    _ => false,
  })
}

/// `new ObjectId(id).toHexString()` of an id `ObjectId.isValid` accepted: only reached for
/// objects, which need the live `ObjectId` (see [`object_id_is_valid`]).
pub fn object_id_to_hex_string(v: &JsVal) -> Result<JsVal> {
  match v {
    JsVal::Str(s) if str_len(s) == 24 => Ok(JsVal::str(s.to_ascii_lowercase())),
    _ => Err(unsupported_function("new ObjectId(val).toHexString()")),
  }
}

/// `Array.prototype.join(separator)`
pub fn join(items: &[JsVal], separator: &str) -> Result<String> {
  let mut out = String::new();
  for (i, item) in items.iter().enumerate() {
    if i > 0 {
      out.push_str(separator);
    }
    if !item.is_nullish() {
      out.push_str(&to_string(item)?);
    }
  }
  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn number_to_string_matches_v8() {
    assert_eq!(number_to_string(1e21), "1e+21");
    assert_eq!(number_to_string(1e-7), "1e-7");
    assert_eq!(number_to_string(123.456), "123.456");
    assert_eq!(number_to_string(0.000001), "0.000001");
    assert_eq!(number_to_string(-1.5e300), "-1.5e+300");
    assert_eq!(number_to_string(601396.3813476562), "601396.3813476562");
    assert_eq!(number_to_string(-196943.09985351562), "-196943.09985351562");
    assert_eq!(number_to_string(33154152566567.062), "33154152566567.062");
  }

  #[test]
  fn string_to_number_rounds_hex_like_v8() {
    assert_eq!(string_to_number("0x20000000000001"), 9007199254740992.0);
    assert_eq!(string_to_number("0x20000000000003"), 9007199254740996.0);
    assert!(string_to_number("0x").is_nan());
    assert_eq!(string_to_number(" 1.e3 "), 1000.0);
    assert!(string_to_number("inf").is_nan());
  }
}
