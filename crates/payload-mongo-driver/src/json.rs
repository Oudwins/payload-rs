//! JSON text whose `JSON.parse` is the JS value the mongoose lane returns.
//!
//! Only values `JSON.parse` reproduces exactly are written: `undefined`, ObjectId, Date, non-finite
//! numbers and opaque bson values bail (the call is re-run on the mongoose lane). Numbers are
//! written in a shortest round-trip form, so `JSON.parse` yields the identical double (`-0`
//! included); keys are written in the order the object holds them. Raw subtrees are transcoded
//! from BSON as they are: a repeated key is written twice, and `JSON.parse` keeps its first
//! position with the last value, like js-bson's assignments.

use mongodb::bson::{RawArray, RawBsonRef, RawDocument};

use crate::value::{Bail, LaneResult, Obj, V, is_unsupported_key};

pub fn write_value(out: &mut String, value: &V<'_>) -> LaneResult<()> {
  match value {
    V::Null => out.push_str("null"),
    V::Bool(true) => out.push_str("true"),
    V::Bool(false) => out.push_str("false"),
    V::Num(n) => write_number(out, *n)?,
    V::Int(i) => out.push_str(itoa::Buffer::new().format(*i)),
    V::Str(s) => write_string(out, s),
    V::Arr(items) => {
      out.push('[');
      for (index, item) in items.iter().enumerate() {
        if index > 0 {
          out.push(',');
        }
        write_value(out, item)?;
      }
      out.push(']');
    }
    V::Obj(obj) => write_object(out, obj)?,
    V::RawDoc(doc) => write_raw_document(out, doc)?,
    V::RawArr(array) => write_raw_array(out, array)?,
    V::Undefined => return Err(Bail("undefined value")),
    V::ObjectId(_) => return Err(Bail("ObjectId in result")),
    V::Date(_) => return Err(Bail("Date in result")),
    V::Opaque(kind) => return Err(Bail(kind)),
  }
  Ok(())
}

pub fn write_object(out: &mut String, obj: &Obj<'_>) -> LaneResult<()> {
  out.push('{');
  for (index, (key, value)) in obj.0.iter().enumerate() {
    if index > 0 {
      out.push(',');
    }
    write_string(out, key);
    out.push(':');
    write_value(out, value)?;
  }
  out.push('}');
  Ok(())
}

fn write_raw_document(out: &mut String, doc: &RawDocument) -> LaneResult<()> {
  out.push('{');
  for (index, entry) in doc.iter().enumerate() {
    let (key, value) = entry.map_err(|_| Bail("malformed bson"))?;
    if is_unsupported_key(key) {
      return Err(Bail("unsupported key"));
    }
    if index > 0 {
      out.push(',');
    }
    write_string(out, key);
    out.push(':');
    write_raw_value(out, value)?;
  }
  out.push('}');
  Ok(())
}

fn write_raw_array(out: &mut String, array: &RawArray) -> LaneResult<()> {
  out.push('[');
  for (index, value) in array.into_iter().enumerate() {
    if index > 0 {
      out.push(',');
    }
    write_raw_value(out, value.map_err(|_| Bail("malformed bson"))?)?;
  }
  out.push(']');
  Ok(())
}

fn write_raw_value(out: &mut String, value: RawBsonRef<'_>) -> LaneResult<()> {
  match value {
    RawBsonRef::Document(doc) => write_raw_document(out, doc),
    RawBsonRef::Array(array) => write_raw_array(out, array),
    RawBsonRef::String(s) => {
      write_string(out, s);
      Ok(())
    }
    other => write_value(out, &crate::value::decode_value(other)),
  }
}

fn write_number(out: &mut String, n: f64) -> LaneResult<()> {
  if !n.is_finite() {
    return Err(Bail("non-finite number"));
  }
  if n == 0.0 {
    out.push_str(if n.is_sign_negative() { "-0" } else { "0" });
    return Ok(());
  }
  if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
    out.push_str(itoa::Buffer::new().format(n as i64));
    return Ok(());
  }
  out.push_str(ryu::Buffer::new().format_finite(n));
  Ok(())
}

pub fn write_string(out: &mut String, s: &str) {
  out.push('"');
  let bytes = s.as_bytes();
  if !bytes.iter().any(|&b| b < 0x20 || b == b'"' || b == b'\\') {
    out.push_str(s);
    out.push('"');
    return;
  }
  let mut start = 0;
  for (index, &byte) in bytes.iter().enumerate() {
    let escape = match byte {
      b'"' => "\\\"",
      b'\\' => "\\\\",
      b'\n' => "\\n",
      b'\r' => "\\r",
      b'\t' => "\\t",
      0x08 => "\\b",
      0x0c => "\\f",
      0..=0x1f => "",
      _ => continue,
    };
    out.push_str(&s[start..index]);
    if escape.is_empty() {
      out.push_str(&format!("\\u{byte:04x}"));
    } else {
      out.push_str(escape);
    }
    start = index + 1;
  }
  out.push_str(&s[start..]);
  out.push('"');
}

#[cfg(test)]
mod tests {
  use super::*;
  use mongodb::bson::rawdoc;

  fn json(value: V<'_>) -> String {
    let mut out = String::new();
    write_value(&mut out, &value).unwrap();
    out
  }

  #[test]
  fn numbers_round_trip() {
    assert_eq!(json(V::Num(-0.0)), "-0");
    assert_eq!(json(V::Num(3.0)), "3");
    assert_eq!(json(V::Num(0.1)), "0.1");
    assert_eq!(json(V::Num(1e21)), "1e21");
    assert_eq!(json(V::Num(1.5e-7)), "1.5e-7");
    assert_eq!(json(V::Int(-9_007_199_254_740_992)), "-9007199254740992");
    assert!(write_value(&mut String::new(), &V::Num(f64::NAN)).is_err());
  }

  #[test]
  fn strings_escape() {
    assert_eq!(json(V::Str("a\"b\\c\n\u{1}é\u{2028}".into())), "\"a\\\"b\\\\c\\n\\u0001é\u{2028}\"");
  }

  #[test]
  fn raw_subtrees_transcode_and_bail() {
    let doc = rawdoc! { "a": 1, "b": { "c": [1.5, "x", null, true] } };
    assert_eq!(json(V::RawDoc(&doc)), r#"{"a":1,"b":{"c":[1.5,"x",null,true]}}"#);
    let with_id = rawdoc! { "a": { "b": mongodb::bson::oid::ObjectId::new() } };
    assert!(write_value(&mut String::new(), &V::RawDoc(&with_id)).is_err());
    let with_proto = rawdoc! { "a": { "__proto__": 1 } };
    assert!(write_value(&mut String::new(), &V::RawDoc(&with_proto)).is_err());
  }
}
