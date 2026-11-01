//! `JSON.parse` / `JSON.stringify` over [`Val`] with JS string semantics.
//!
//! Unlike `serde_json`, strings are UTF-16 based: `\udXXX` escapes of lone
//! surrogates (which `JSON.stringify` emits for ill-formed strings) decode into
//! [`JsStr::Utf16`](crate::jsstr::JsStr) and [`stringify`] emits them again, so
//! such strings round-trip across the TS boundary unchanged.
//!
//! Objects are created with `CreateDataProperty` semantics (an own
//! `"__proto__"` key stays an own property, duplicate keys keep the first
//! position and the last value), exactly like `JSON.parse`.

use payload_engine::error::{EngineError, Result};

use crate::jsops::num_to_string;
use crate::jsstr::JsStr;
use crate::value::{Builtin, JsObject, Val};

fn syntax_error(message: impl Into<String>) -> EngineError {
  EngineError::new("SyntaxError", message)
}

/// `JSON.parse(text)`
pub fn parse(text: &str) -> Result<Val> {
  let units: Vec<u16> = text.encode_utf16().collect();
  parse_units(&units)
}

/// `JSON.parse(text)` for any JS string.
pub fn parse_js(text: &JsStr) -> Result<Val> {
  parse_units(&text.units())
}

enum Frame {
  Arr(Vec<Val>),
  Obj(JsObject, JsStr),
}

struct Parser<'a> {
  s: &'a [u16],
  i: usize,
}

impl Parser<'_> {
  fn peek(&self) -> Option<u16> {
    self.s.get(self.i).copied()
  }

  fn ws(&mut self) {
    while matches!(self.peek(), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
      self.i += 1;
    }
  }

  fn unexpected(&self) -> EngineError {
    match self.peek() {
      None => syntax_error("Unexpected end of JSON input"),
      Some(c) => syntax_error(format!(
        "Unexpected token '{}', \"{}\" is not valid JSON",
        String::from_utf16_lossy(&[c]),
        String::from_utf16_lossy(&self.s[..self.s.len().min(32)])
      )),
    }
  }

  fn expect(&mut self, c: u16) -> Result<()> {
    if self.peek() == Some(c) {
      self.i += 1;
      Ok(())
    } else {
      Err(self.unexpected())
    }
  }

  fn literal(&mut self, word: &str, value: Val) -> Result<Val> {
    for c in word.encode_utf16() {
      self.expect(c)?;
    }
    Ok(value)
  }

  fn hex4(&mut self) -> Result<u16> {
    let mut v: u16 = 0;
    for _ in 0..4 {
      let c = self.peek().ok_or_else(|| self.unexpected())?;
      let d = match c {
        0x30..=0x39 => c - 0x30,
        0x41..=0x46 => c - 0x41 + 10,
        0x61..=0x66 => c - 0x61 + 10,
        _ => return Err(self.unexpected()),
      };
      v = v * 16 + d;
      self.i += 1;
    }
    Ok(v)
  }

  fn string(&mut self) -> Result<JsStr> {
    self.expect(0x22)?;
    let mut out: Vec<u16> = Vec::new();
    loop {
      let c = self.peek().ok_or_else(|| syntax_error("Unterminated string in JSON"))?;
      self.i += 1;
      match c {
        0x22 => return Ok(JsStr::from_units(&out)),
        0x5c => {
          let e = self.peek().ok_or_else(|| self.unexpected())?;
          self.i += 1;
          match e {
            0x22 | 0x5c | 0x2f => out.push(e),
            0x62 => out.push(0x08),
            0x66 => out.push(0x0c),
            0x6e => out.push(0x0a),
            0x72 => out.push(0x0d),
            0x74 => out.push(0x09),
            0x75 => {
              let u = self.hex4()?;
              out.push(u);
            }
            _ => {
              self.i -= 1;
              return Err(self.unexpected());
            }
          }
        }
        c if c < 0x20 => {
          self.i -= 1;
          return Err(syntax_error("Bad control character in string literal in JSON"));
        }
        c => out.push(c),
      }
    }
  }

  fn number(&mut self) -> Result<Val> {
    let start = self.i;
    let digit = |c: Option<u16>| matches!(c, Some(0x30..=0x39));
    if self.peek() == Some(0x2d) {
      self.i += 1;
    }
    match self.peek() {
      Some(0x30) => self.i += 1,
      Some(0x31..=0x39) => {
        while digit(self.peek()) {
          self.i += 1;
        }
      }
      _ => return Err(self.unexpected()),
    }
    if self.peek() == Some(0x2e) {
      self.i += 1;
      if !digit(self.peek()) {
        return Err(self.unexpected());
      }
      while digit(self.peek()) {
        self.i += 1;
      }
    }
    if matches!(self.peek(), Some(0x65 | 0x45)) {
      self.i += 1;
      if matches!(self.peek(), Some(0x2b | 0x2d)) {
        self.i += 1;
      }
      if !digit(self.peek()) {
        return Err(self.unexpected());
      }
      while digit(self.peek()) {
        self.i += 1;
      }
    }
    let text = String::from_utf16_lossy(&self.s[start..self.i]);
    Ok(Val::Num(text.parse::<f64>().unwrap_or(f64::NAN)))
  }
}

/// `JSON.parse` over UTF-16 code units (iterative: nesting depth is unbounded, like V8).
pub fn parse_units(s: &[u16]) -> Result<Val> {
  let mut p = Parser { s, i: 0 };
  let mut stack: Vec<Frame> = Vec::new();
  'value: loop {
    p.ws();
    let mut value = match p.peek() {
      Some(0x7b) => {
        p.i += 1;
        p.ws();
        if p.peek() == Some(0x7d) {
          p.i += 1;
          Val::from_obj(JsObject::new())
        } else {
          let key = p.string()?;
          p.ws();
          p.expect(0x3a)?;
          stack.push(Frame::Obj(JsObject::new(), key));
          continue 'value;
        }
      }
      Some(0x5b) => {
        p.i += 1;
        p.ws();
        if p.peek() == Some(0x5d) {
          p.i += 1;
          Val::new_arr(Vec::new())
        } else {
          stack.push(Frame::Arr(Vec::new()));
          continue 'value;
        }
      }
      Some(0x22) => Val::Str(p.string()?),
      Some(0x74) => p.literal("true", Val::Bool(true))?,
      Some(0x66) => p.literal("false", Val::Bool(false))?,
      Some(0x6e) => p.literal("null", Val::Null)?,
      Some(0x2d | 0x30..=0x39) => p.number()?,
      _ => return Err(p.unexpected()),
    };
    // Attach the completed value to its parents.
    loop {
      match stack.last_mut() {
        None => {
          p.ws();
          if p.i != s.len() {
            return Err(p.unexpected());
          }
          return Ok(value);
        }
        Some(Frame::Arr(items)) => {
          items.push(value);
          p.ws();
          match p.peek() {
            Some(0x2c) => {
              p.i += 1;
              continue 'value;
            }
            Some(0x5d) => {
              p.i += 1;
              let Some(Frame::Arr(items)) = stack.pop() else { unreachable!() };
              value = Val::new_arr(items);
            }
            _ => return Err(p.unexpected()),
          }
        }
        Some(Frame::Obj(obj, key)) => {
          obj.define(&*key, value);
          p.ws();
          match p.peek() {
            Some(0x2c) => {
              p.i += 1;
              p.ws();
              *key = p.string()?;
              p.ws();
              p.expect(0x3a)?;
              continue 'value;
            }
            Some(0x7d) => {
              p.i += 1;
              let Some(Frame::Obj(obj, _)) = stack.pop() else { unreachable!() };
              value = Val::from_obj(obj);
            }
            _ => return Err(p.unexpected()),
          }
        }
      }
    }
  }
}

/// `JSON.stringify(value)` for the plain trees produced by [`crate::encoding::encode`]
/// (well-formed output: lone surrogates as `\udXXX`; iterative). Returns `None` for a
/// root that `JSON.stringify` maps to `undefined`.
pub fn stringify(value: &Val) -> Result<Option<String>> {
  enum Work {
    Enter(Val),
    Raw(String),
  }
  if is_omitted(value) {
    return Ok(None);
  }
  let mut out = String::new();
  let mut work = vec![Work::Enter(value.clone())];
  while let Some(item) = work.pop() {
    match item {
      Work::Raw(s) => out.push_str(&s),
      Work::Enter(value) => match &value {
        Val::Arr(a) => {
          let items = a.borrow().to_vec();
          out.push('[');
          work.push(Work::Raw("]".into()));
          for (i, item) in items.into_iter().enumerate().rev() {
            work.push(if is_omitted(&item) { Work::Raw("null".into()) } else { Work::Enter(item) });
            if i > 0 {
              work.push(Work::Raw(",".into()));
            }
          }
        }
        Val::Obj(o) => {
          let entries: Vec<_> = o.borrow().entries().into_iter().filter(|(_, v)| !is_omitted(v)).collect();
          out.push('{');
          work.push(Work::Raw("}".into()));
          for (i, (k, v)) in entries.into_iter().enumerate().rev() {
            work.push(Work::Enter(v));
            let mut prefix = String::from(if i > 0 { "," } else { "" });
            quote(&k, &mut prefix);
            prefix.push(':');
            work.push(Work::Raw(prefix));
          }
        }
        leaf => write_leaf(leaf, &mut out),
      },
    }
  }
  Ok(Some(out))
}

fn is_omitted(value: &Val) -> bool {
  matches!(value, Val::Undefined | Val::Builtin(Builtin::Function(_)))
}

fn write_leaf(value: &Val, out: &mut String) {
  match value {
    Val::Null => out.push_str("null"),
    Val::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
    Val::Num(n) if n.is_finite() => out.push_str(&num_to_string(*n)),
    Val::Num(_) => out.push_str("null"),
    Val::Str(s) => quote(s, out),
    Val::Date(t) => match crate::date::to_iso_string(*t) {
      Ok(iso) => quote(&JsStr::from(iso), out),
      Err(_) => out.push_str("null"),
    },
    Val::Builtin(Builtin::ObjectPrototype) => out.push_str("{}"),
    _ => {}
  }
}

/// `JSON.stringify(string)`
pub fn quote(s: &JsStr, out: &mut String) {
  out.push('"');
  match s {
    JsStr::Utf8(s) => {
      for c in s.chars() {
        escape_char(c, out);
      }
    }
    JsStr::Utf16(units) => {
      for r in char::decode_utf16(units.iter().copied()) {
        match r {
          Ok(c) => escape_char(c, out),
          Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
      }
    }
  }
  out.push('"');
}

fn escape_char(c: char, out: &mut String) {
  match c {
    '"' => out.push_str("\\\""),
    '\\' => out.push_str("\\\\"),
    '\u{08}' => out.push_str("\\b"),
    '\u{0c}' => out.push_str("\\f"),
    '\n' => out.push_str("\\n"),
    '\r' => out.push_str("\\r"),
    '\t' => out.push_str("\\t"),
    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
    c => out.push(c),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn roundtrip(text: &str) -> String {
    stringify(&parse(text).expect("parse")).expect("stringify").expect("defined")
  }

  #[test]
  fn lone_surrogates_round_trip() {
    assert_eq!(roundtrip(r#"{"title":"a\ud83d"}"#), r#"{"title":"a\ud83d"}"#);
    assert_eq!(roundtrip(r#"["\ud83d\ude00","\udc00x"]"#), r#"["😀","\udc00x"]"#);
    let v = parse(r#""\ud83d""#).expect("parse");
    assert_eq!(v.as_js_str().map(JsStr::utf16_len), Some(1));
  }

  #[test]
  fn json_parse_semantics() {
    assert_eq!(roundtrip(r#" {"b":1,"a":2,"b":3,"__proto__":{"x":1}} "#), r#"{"b":3,"a":2,"__proto__":{"x":1}}"#);
    assert_eq!(roundtrip("[1e2,-0,0.5,1E-7]"), "[100,0,0.5,1e-7]");
    for bad in ["", "[1,]", "01", "1.", "\"\t\"", "{\"a\" 1}", "[1] x", "'a'", "\"\\x\"", "+1", "NaN"] {
      assert_eq!(parse(bad).expect_err(bad).name, "SyntaxError", "{bad}");
    }
  }

  #[test]
  fn deep_nesting_does_not_recurse() {
    // V8's JSON.parse accepts any depth; parse, encode, decode, stringify and drop are
    // iterative, so this runs on a 2 MB test thread.
    let depth = 200_000;
    let text = format!("{}1{}", "[{\"a\":".repeat(depth), "}]".repeat(depth));
    let parsed = parse(&text).map_err(|e| e.to_string()).expect("deep parses");
    let decoded = crate::encoding::decode(&parsed);
    let tree = crate::encoding::encode(&decoded).map_err(|e| e.to_string()).expect("encodes");
    assert_eq!(stringify(&tree).ok().flatten().as_deref(), Some(text.as_str()));
  }
}

