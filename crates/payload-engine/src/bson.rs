//! BSON values the MongoDB engine exchanges with JS (`ObjectId`, `RegExp`, `Decimal128`,
//! `Binary`, Node `Buffer`), with the JS semantics of the classes upstream uses (`bson` 7, as
//! re-exported by `mongoose.Types` / `mongoose.mongo`).
//!
//! Values are [`JsVal`]s created by [`JsVal::bson_value`] (an empty object registered in the typed
//! side table, like `Date`s): [`JsVal::bson`] reads them back. Every generic `JsVal` helper treats
//! them as JS objects (`typeof` `'object'`, truthy, `===` by identity), [`JsVal::to_js_string`] /
//! [`JsVal::to_json`] follow the classes' `toString` / `toJSON`, and the boundary encoding is
//! (decoded only by [`crate::js::decode_graph_bson`] / [`crate::js::decode_value_bson`], written by
//! every encoder):
//!
//! | value        | encoding                                                  |
//! | ------------ | --------------------------------------------------------- |
//! | `ObjectId`   | `{ "$oid": "<24 lowercase hex>" }`                        |
//! | `RegExp`     | `{ "$regex": { "source": "...", "flags": "..." } }`       |
//! | `Decimal128` | `{ "$decimal": "<Decimal128.prototype.toString()>" }`     |
//! | `Binary`     | `{ "$binary": { "base64": "...", "subType": <0..=255> } }`|
//! | `Buffer`     | `{ "$buffer": "<base64>" }` (Node `Buffer` / `Uint8Array`) |

use std::sync::Arc;

use crate::js::JsVal;

/// A BSON / binary JS value (see the module docs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BsonValue {
  /// `new ObjectId(...)`: its 12 bytes.
  ObjectId([u8; 12]),
  /// A JS `RegExp` (`regexp.source`, `regexp.flags`).
  RegExp { source: Arc<str>, flags: Arc<str> },
  /// A `Decimal128`, as its `toString()` (exact: `Decimal128.fromString(d.toString())` gives back
  /// the same value, exponent and sign included).
  Decimal128(Arc<str>),
  /// A bson `Binary` (`sub_type`, the bytes up to `position`).
  Binary { sub_type: u8, bytes: Arc<[u8]> },
  /// A Node `Buffer` (or other `Uint8Array`).
  Buffer(Arc<[u8]>),
}

impl BsonValue {
  /// `String(value)`: `toHexString()`, `RegExp.prototype.toString`, `Decimal128.toString()`,
  /// `Binary.toString()` / `Buffer.toString()` (utf8, invalid sequences replaced).
  pub fn to_js_string(&self) -> String {
    match self {
      BsonValue::ObjectId(bytes) => object_id_to_hex(bytes),
      BsonValue::RegExp { source, flags } => format!("/{source}/{flags}"),
      BsonValue::Decimal128(s) => s.to_string(),
      BsonValue::Binary { bytes, .. } | BsonValue::Buffer(bytes) => String::from_utf8_lossy(bytes).into_owned(),
    }
  }

  /// `JSON.parse(JSON.stringify(value))`: the hex string, `{}` for a `RegExp`,
  /// `{ $numberDecimal }`, the base64 string of a `Binary`, `{ type: 'Buffer', data }`.
  pub fn to_json(&self) -> serde_json::Value {
    match self {
      BsonValue::ObjectId(bytes) => serde_json::Value::String(object_id_to_hex(bytes)),
      BsonValue::RegExp { .. } => serde_json::json!({}),
      BsonValue::Decimal128(s) => serde_json::json!({ "$numberDecimal": &**s }),
      BsonValue::Binary { bytes, .. } => serde_json::Value::String(base64_encode(bytes)),
      BsonValue::Buffer(bytes) => serde_json::json!({ "type": "Buffer", "data": bytes.iter().copied().collect::<Vec<u8>>() }),
    }
  }
}

impl JsVal {
  /// `new ObjectId(bytes)`
  pub fn object_id(bytes: [u8; 12]) -> JsVal {
    JsVal::bson_value(BsonValue::ObjectId(bytes))
  }

  /// `new ObjectId(hex)` for a string `ObjectId.isValid` accepts (24 hex digits, any case),
  /// `None` where the constructor throws `BSONError`.
  pub fn object_id_from_hex(hex: &str) -> Option<JsVal> {
    object_id_bytes_from_hex(hex).map(JsVal::object_id)
  }

  /// `new RegExp(source, flags)` (both as JS reports them: `regexp.source`, `regexp.flags`).
  pub fn regexp(source: impl Into<Arc<str>>, flags: impl Into<Arc<str>>) -> JsVal {
    JsVal::bson_value(BsonValue::RegExp { source: source.into(), flags: flags.into() })
  }

  /// `Decimal128.fromString(s)` for the canonical string `s` (as `toString()` returns it).
  pub fn decimal128(s: impl Into<Arc<str>>) -> JsVal {
    JsVal::bson_value(BsonValue::Decimal128(s.into()))
  }

  /// `new Binary(bytes, subType)`
  pub fn binary(sub_type: u8, bytes: impl Into<Arc<[u8]>>) -> JsVal {
    JsVal::bson_value(BsonValue::Binary { sub_type, bytes: bytes.into() })
  }

  /// `Buffer.from(bytes)`
  pub fn buffer(bytes: impl Into<Arc<[u8]>>) -> JsVal {
    JsVal::bson_value(BsonValue::Buffer(bytes.into()))
  }

  /// The 12 bytes of an `ObjectId`.
  pub fn as_object_id(&self) -> Option<[u8; 12]> {
    match self.bson() {
      Some(BsonValue::ObjectId(bytes)) => Some(bytes),
      _ => None,
    }
  }

  /// Whether this is an `ObjectId` (`isObjectID` / `value instanceof Types.ObjectId`).
  pub fn is_object_id(&self) -> bool {
    self.as_object_id().is_some()
  }

  /// `objectId.toHexString()` of an `ObjectId`.
  pub fn object_id_hex(&self) -> Option<String> {
    self.as_object_id().map(|bytes| object_id_to_hex(&bytes))
  }

  /// `this.equals(other)` for an `ObjectId` `this` (`ObjectId.prototype.equals`, bson 7): another
  /// `ObjectId` compares its bytes, a string its `toLowerCase()` with the hex string; `None` when
  /// `this` is not an `ObjectId` or `other` is an object whose answer depends on a JS
  /// `toHexString` method (not modelled).
  pub fn object_id_equals(&self, other: &JsVal) -> Option<bool> {
    let bytes = self.as_object_id()?;
    match other {
      JsVal::Undefined | JsVal::Null => Some(false),
      JsVal::Str(s) => Some(s.to_lowercase() == object_id_to_hex(&bytes)),
      JsVal::Obj(o) => match other.bson() {
        Some(BsonValue::ObjectId(other_bytes)) => Some(other_bytes == bytes),
        Some(_) => Some(false),
        None if other.typed().is_some() => Some(false),
        None => match o.get("toHexString") {
          Some(JsVal::Fn(_)) => None,
          _ => Some(false),
        },
      },
      _ => Some(false),
    }
  }
}

/// `ObjectId.isValid(value)` (bson 7) for the values whose answer does not depend on JS methods:
/// strings (24 hex digits), `ObjectId`s, 12-byte `Buffer`s; `None` for other objects (the
/// constructor reads `toHexString` / `id` there).
pub fn object_id_is_valid(value: &JsVal) -> Option<bool> {
  match value {
    JsVal::Undefined | JsVal::Null => Some(false),
    JsVal::Str(s) => Some(object_id_bytes_from_hex(s).is_some()),
    // `new ObjectId(number)` throws in bson 7 ("does not match the accepted types")
    JsVal::Num(_) | JsVal::Bool(_) | JsVal::Fn(_) => Some(false),
    JsVal::Arr(_) => None,
    JsVal::Obj(_) => match value.bson() {
      Some(BsonValue::ObjectId(_)) => Some(true),
      Some(BsonValue::Buffer(bytes)) => Some(bytes.len() == 12),
      Some(_) => None,
      None if value.typed().is_some() => None,
      None => None,
    },
  }
}

/// The bytes of a 24 digit hex string (`ObjectId.validateHexString`), `None` otherwise.
pub fn object_id_bytes_from_hex(hex: &str) -> Option<[u8; 12]> {
  let digits = hex.as_bytes();
  if digits.len() != 24 {
    return None;
  }
  let mut out = [0u8; 12];
  for (i, pair) in digits.chunks(2).enumerate() {
    out[i] = (hex_digit(pair[0])? << 4) | hex_digit(pair[1])?;
  }
  Some(out)
}

/// `objectId.toHexString()`
pub fn object_id_to_hex(bytes: &[u8; 12]) -> String {
  const DIGITS: &[u8; 16] = b"0123456789abcdef";
  let mut out = String::with_capacity(24);
  for b in bytes {
    out.push(DIGITS[(b >> 4) as usize] as char);
    out.push(DIGITS[(b & 15) as usize] as char);
  }
  out
}

fn hex_digit(b: u8) -> Option<u8> {
  match b {
    b'0'..=b'9' => Some(b - b'0'),
    b'a'..=b'f' => Some(b - b'a' + 10),
    b'A'..=b'F' => Some(b - b'A' + 10),
    _ => None,
  }
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (`buffer.toString('base64')`).
pub fn base64_encode(bytes: &[u8]) -> String {
  let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
  for chunk in bytes.chunks(3) {
    let n = (u32::from(chunk[0]) << 16)
      | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
      | u32::from(chunk.get(2).copied().unwrap_or(0));
    out.push(BASE64[(n >> 18) as usize & 63] as char);
    out.push(BASE64[(n >> 12) as usize & 63] as char);
    out.push(if chunk.len() > 1 { BASE64[(n >> 6) as usize & 63] as char } else { '=' });
    out.push(if chunk.len() > 2 { BASE64[n as usize & 63] as char } else { '=' });
  }
  out
}

/// Decodes standard base64 as [`base64_encode`] writes it (padding optional), `None` for other
/// input.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
  let digits = text.trim_end_matches('=').as_bytes();
  if text.len() - digits.len() > 2 || digits.len() % 4 == 1 {
    return None;
  }
  let value = |b: u8| -> Option<u32> {
    Some(match b {
      b'A'..=b'Z' => b - b'A',
      b'a'..=b'z' => b - b'a' + 26,
      b'0'..=b'9' => b - b'0' + 52,
      b'+' => 62,
      b'/' => 63,
      _ => return None,
    } as u32)
  };
  let mut out = Vec::with_capacity(digits.len() * 3 / 4);
  for chunk in digits.chunks(4) {
    let mut n = 0u32;
    for (i, &b) in chunk.iter().enumerate() {
      n |= value(b)? << (18 - 6 * i);
    }
    out.push((n >> 16) as u8);
    if chunk.len() > 2 {
      out.push((n >> 8) as u8);
    }
    if chunk.len() > 3 {
      out.push(n as u8);
    }
  }
  Some(out)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::js::{decode_value_bson, encode_value, encode_value_text};

  #[test]
  fn base64_round_trips() {
    for (bytes, text) in [(&b""[..], ""), (b"h", "aA=="), (b"hi", "aGk="), (b"hi!", "aGkh"), (&[0xff, 0x00, 0xfe, 0x7f][..], "/wD+fw==")] {
      assert_eq!(base64_encode(bytes), text);
      assert_eq!(base64_decode(text).as_deref(), Some(bytes));
    }
    assert_eq!(base64_decode("a"), None);
    assert_eq!(base64_decode("a*=="), None);
  }

  #[test]
  fn object_id_semantics() {
    assert_eq!(object_id_bytes_from_hex("abcdefghijkl"), None);
    let id = JsVal::object_id_from_hex("ABCDEF0123456789ABCDEF01").expect("valid");
    assert_eq!(id.object_id_hex().as_deref(), Some("abcdef0123456789abcdef01"));
    assert_eq!(id.to_js_string(), "abcdef0123456789abcdef01");
    assert_eq!(id.to_json(), serde_json::json!("abcdef0123456789abcdef01"));
    assert_eq!(id.type_of(), "object");
    assert!(id.truthy() && id.is_object_like() && id.typed().is_none());
    let same = JsVal::object_id_from_hex("abcdef0123456789abcdef01").expect("valid");
    assert!(!id.strict_eq(&same));
    assert_eq!(id.object_id_equals(&same), Some(true));
    assert_eq!(id.object_id_equals(&JsVal::str("ABCDEF0123456789ABCDEF01")), Some(true));
    assert_eq!(id.object_id_equals(&JsVal::Null), Some(false));
    assert_eq!(object_id_is_valid(&JsVal::str("507f1f77bcf86cd799439011")), Some(true));
    assert_eq!(object_id_is_valid(&JsVal::Num(123.0)), Some(false));
  }

  #[test]
  fn bson_values_round_trip_through_the_encoding() {
    let doc = JsVal::obj(
      [
        ("_id".to_string(), JsVal::object_id_from_hex("507f1f77bcf86cd799439011").expect("valid")),
        ("re".to_string(), JsVal::regexp("a\\/b", "gi")),
        ("d".to_string(), JsVal::decimal128("1.50")),
        ("bin".to_string(), JsVal::binary(4, b"hi".to_vec())),
        ("buf".to_string(), JsVal::buffer(b"hi!".to_vec())),
        ("when".to_string(), JsVal::date(0.0)),
        // user data shaped like markers stays plain data
        ("fake".to_string(), JsVal::obj([("$oid".to_string(), JsVal::str("507f1f77bcf86cd799439011"))].into_iter().collect())),
        ("op".to_string(), JsVal::obj([("$regex".to_string(), JsVal::str("abc"))].into_iter().collect())),
      ]
      .into_iter()
      .collect(),
    );
    let encoded = encode_value(&doc);
    assert_eq!(
      encoded,
      serde_json::json!({
        "_id": { "$oid": "507f1f77bcf86cd799439011" },
        "re": { "$regex": { "source": "a\\/b", "flags": "gi" } },
        "d": { "$decimal": "1.50" },
        "bin": { "$binary": { "base64": "aGk=", "subType": 4 } },
        "buf": { "$buffer": "aGkh" },
        "when": { "$date": "1970-01-01T00:00:00.000Z" },
        "fake": { "$obj": { "$oid": "507f1f77bcf86cd799439011" } },
        "op": { "$obj": { "$regex": "abc" } },
      })
    );
    assert_eq!(serde_json::from_str::<serde_json::Value>(&encode_value_text(&doc)).expect("json"), encoded);
    let decoded = decode_value_bson(&encoded).expect("decode");
    assert_eq!(decoded.get("_id").bson(), doc.get("_id").bson());
    assert_eq!(decoded.get("re").bson(), Some(BsonValue::RegExp { source: "a\\/b".into(), flags: "gi".into() }));
    assert_eq!(decoded.get("re").to_js_string(), "/a\\/b/gi");
    assert_eq!(decoded.get("d").to_json(), serde_json::json!({ "$numberDecimal": "1.50" }));
    assert_eq!(decoded.get("bin").bson(), Some(BsonValue::Binary { sub_type: 4, bytes: b"hi".to_vec().into() }));
    assert_eq!(decoded.get("buf").bson(), Some(BsonValue::Buffer(b"hi!".to_vec().into())));
    assert_eq!(decoded.get("when").as_date(), Some(0.0));
    assert_eq!(decoded.get("fake").get("$oid").as_str(), Some("507f1f77bcf86cd799439011"));
    assert!(decoded.get("fake").bson().is_none());
    assert_eq!(encode_value(&decoded), encoded);
    // the non-bson decoders keep the new markers as plain objects (SQLite path unchanged)
    let plain = crate::js::decode_graph_typed(&serde_json::json!({ "objects": [], "root": { "$oid": "507f1f77bcf86cd799439011" } })).expect("decode");
    assert!(plain.bson().is_none());
    assert_eq!(plain.get("$oid").as_str(), Some("507f1f77bcf86cd799439011"));
    // invalid markers are errors, not panics
    for bad in [
      serde_json::json!({ "$oid": "zz" }),
      serde_json::json!({ "$oid": 1 }),
      serde_json::json!({ "$binary": { "base64": "a", "subType": 0 } }),
      serde_json::json!({ "$binary": { "base64": "aGk=", "subType": 256 } }),
      serde_json::json!({ "$regex": "x" }),
      serde_json::json!({ "$decimal": 1 }),
      serde_json::json!({ "$buffer": "***" }),
    ] {
      assert!(decode_value_bson(&bad).is_err(), "{bad}");
    }
  }
}
