//! A direct decoder of fused requests: JSON text straight into [`JsVal`]s with the
//! `serializeForEngine` markers of plain trees (`$undefined`, `$num`, `$date`, `$bigint`, `$obj`)
//! decoded on the way, instead of `serde_json::Value` plus `decode_graph_typed`. Anything else
//! (`$ref` / `$fn` markers, lone surrogates, deep nesting) returns `None` and the caller uses the
//! general decoder.

use payload_engine::js::{JsVal, Obj, parse_iso_date};

const MAX_DEPTH: usize = 256;

pub fn parse(text: &str) -> Option<JsVal> {
  let mut p = Parser { b: text.as_bytes(), s: text, i: 0 };
  p.ws();
  let value = p.value(0)?;
  p.ws();
  (p.i == p.b.len()).then_some(value)
}

struct Parser<'a> {
  b: &'a [u8],
  s: &'a str,
  i: usize,
}

impl Parser<'_> {
  fn ws(&mut self) {
    while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
      self.i += 1;
    }
  }

  fn value(&mut self, depth: usize) -> Option<JsVal> {
    if depth > MAX_DEPTH {
      return None;
    }
    match *self.b.get(self.i)? {
      b'n' => self.word("null", JsVal::Null),
      b't' => self.word("true", JsVal::Bool(true)),
      b'f' => self.word("false", JsVal::Bool(false)),
      b'"' => self.string().map(JsVal::str),
      b'[' => {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
          self.i += 1;
          return Some(JsVal::arr(items));
        }
        loop {
          self.ws();
          items.push(self.value(depth + 1)?);
          self.ws();
          match self.b.get(self.i)? {
            b',' => self.i += 1,
            b']' => {
              self.i += 1;
              return Some(JsVal::arr(items));
            }
            _ => return None,
          }
        }
      }
      b'{' => self.object(depth),
      _ => self.number(),
    }
  }

  fn object(&mut self, depth: usize) -> Option<JsVal> {
    self.i += 1;
    let mut members = Obj::new();
    self.ws();
    if self.b.get(self.i) == Some(&b'}') {
      self.i += 1;
      return Some(JsVal::obj(members));
    }
    loop {
      self.ws();
      let key = self.string()?;
      self.ws();
      if self.b.get(self.i) != Some(&b':') {
        return None;
      }
      self.i += 1;
      self.ws();
      let value = self.value(depth + 1)?;
      if members.contains_key(&key) {
        // `serializeForEngine` never repeats keys
        return None;
      }
      members.insert(key, value);
      self.ws();
      match self.b.get(self.i)? {
        b',' => self.i += 1,
        b'}' => {
          self.i += 1;
          break;
        }
        _ => return None,
      }
    }
    if members.len() == 1 {
      let (key, value) = members.iter().next()?;
      if key.starts_with('$') {
        return marker(key, value);
      }
    }
    Some(JsVal::obj(members))
  }

  fn word(&mut self, word: &str, value: JsVal) -> Option<JsVal> {
    if self.s[self.i..].starts_with(word) {
      self.i += word.len();
      Some(value)
    } else {
      None
    }
  }

  fn digits(&mut self) -> bool {
    let start = self.i;
    while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
      self.i += 1;
    }
    self.i > start
  }

  fn number(&mut self) -> Option<JsVal> {
    let start = self.i;
    if self.b.get(self.i) == Some(&b'-') {
      self.i += 1;
    }
    match self.b.get(self.i)? {
      b'0' => self.i += 1,
      b'1'..=b'9' => {
        self.digits();
      }
      _ => return None,
    }
    if self.b.get(self.i) == Some(&b'.') {
      self.i += 1;
      if !self.digits() {
        return None;
      }
    }
    if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
      self.i += 1;
      if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
        self.i += 1;
      }
      if !self.digits() {
        return None;
      }
    }
    self.s[start..self.i].parse::<f64>().ok().map(JsVal::Num)
  }

  fn hex4(&mut self) -> Option<u32> {
    let digits = self.s.get(self.i..self.i + 4)?;
    if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
      return None;
    }
    self.i += 4;
    u32::from_str_radix(digits, 16).ok()
  }

  fn string(&mut self) -> Option<String> {
    if self.b.get(self.i) != Some(&b'"') {
      return None;
    }
    self.i += 1;
    let mut out = String::new();
    let mut start = self.i;
    loop {
      match *self.b.get(self.i)? {
        b'"' => {
          out.push_str(&self.s[start..self.i]);
          self.i += 1;
          return Some(out);
        }
        b'\\' => {
          out.push_str(&self.s[start..self.i]);
          self.i += 1;
          let e = *self.b.get(self.i)?;
          self.i += 1;
          match e {
            b'"' => out.push('"'),
            b'\\' => out.push('\\'),
            b'/' => out.push('/'),
            b'b' => out.push('\u{8}'),
            b'f' => out.push('\u{c}'),
            b'n' => out.push('\n'),
            b'r' => out.push('\r'),
            b't' => out.push('\t'),
            b'u' => {
              let unit = self.hex4()?;
              if (0xd800..0xdc00).contains(&unit) {
                // a surrogate pair, or a lone surrogate this side cannot represent
                if !self.s[self.i..].starts_with("\\u") {
                  return None;
                }
                self.i += 2;
                let low = self.hex4()?;
                if !(0xdc00..0xe000).contains(&low) {
                  return None;
                }
                out.push(char::from_u32(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00))?);
              } else {
                out.push(char::from_u32(unit)?);
              }
            }
            _ => return None,
          }
          start = self.i;
        }
        0..=0x1f => return None,
        _ => self.i += 1,
      }
    }
  }
}

/// A single-key `$` object: a marker of the plain tree encoding, or a key a user object could
/// only have had escaped (`$obj`); anything else is left to the general decoder.
fn marker(key: &str, value: &JsVal) -> Option<JsVal> {
  match key {
    "$undefined" => Some(JsVal::Undefined),
    "$num" => Some(JsVal::Num(match value.as_str()? {
      "Infinity" => f64::INFINITY,
      "-Infinity" => f64::NEG_INFINITY,
      _ => f64::NAN,
    })),
    "$date" => Some(JsVal::date(value.as_str().and_then(parse_iso_date).unwrap_or(f64::NAN))),
    "$bigint" => Some(JsVal::bigint(value.as_str()?)),
    "$obj" => match value {
      JsVal::Obj(_) => Some(value.clone()),
      _ => None,
    },
    // `$ref`, `$fn`, BSON markers, and single-key user objects whose key starts with `$` but was
    // not escaped (the general decoder knows which keys are reserved)
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::parse;
  use payload_engine::js::JsVal;

  #[test]
  fn decodes_markers() {
    let v = parse(r#"{"a":{"$undefined":true},"b":[1,-0.5e1,"xé"],"c":{"$obj":{"x":1}},"d":{"$date":"2024-01-01T00:00:00.000Z"}}"#).unwrap();
    assert!(v.get("a").is_undefined());
    assert_eq!(v.get("b").as_arr().unwrap()[1].as_num(), Some(-5.0));
    assert_eq!(v.get("b").as_arr().unwrap()[2].as_str(), Some("xé"));
    assert_eq!(v.get("c").get("x").as_num(), Some(1.0));
    // an escaped user object with a reserved key: left to the general decoder
    assert!(parse(r#"{"c":{"$obj":{"$ref":1}}}"#).is_none());
    assert_eq!(v.get("d").as_date(), Some(1_704_067_200_000.0));
    assert!(parse(r#"{"a":{"$ref":1}}"#).is_none());
    assert!(parse(r#""\ud800""#).is_none());
    assert!(parse(r#"{"a":1,"a":2}"#).is_none());
    assert!(matches!(parse("[]"), Some(JsVal::Arr(_))));
  }
}
