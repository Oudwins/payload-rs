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

/// `JSON.parse(text)` as an engine value (see [`Val::to_js`]): JS key order, any nesting depth
/// (iterative, like V8), numbers rounded like V8 (`1e400` is `Infinity`), lone surrogates as
/// U+FFFD. Valid input is parsed straight into the engine value; for invalid input the UTF-16
/// parser reports V8's exact `SyntaxError`.
pub fn parse_to_js(text: &str) -> Result<payload_engine::js::JsVal> {
  match direct::parse(text) {
    Some(value) => Ok(value),
    None => Ok(parse(text)?.to_js()),
  }
}

/// A `JSON.parse` that builds engine values directly from UTF-8 text. It accepts exactly the
/// grammar of [`parse_units`] and gives up (`None`) on the first error.
mod direct {
  use payload_engine::js::{JsVal, Obj};

  enum Frame {
    Arr(Vec<JsVal>),
    Obj(Obj, String),
  }

  struct Parser<'a> {
    text: &'a str,
    s: &'a [u8],
    i: usize,
  }

  impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
      self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
      while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        self.i += 1;
      }
    }

    fn eat(&mut self, c: u8) -> Option<()> {
      self.ws();
      (self.peek() == Some(c)).then(|| self.i += 1)
    }

    fn literal(&mut self, word: &str, value: JsVal) -> Option<JsVal> {
      let end = self.i + word.len();
      (self.s.get(self.i..end) == Some(word.as_bytes())).then(|| {
        self.i = end;
        value
      })
    }

    fn hex4(&mut self) -> Option<u16> {
      let digits = std::str::from_utf8(self.s.get(self.i..self.i + 4)?).ok()?;
      if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
      }
      self.i += 4;
      u16::from_str_radix(digits, 16).ok()
    }

    /// The cursor is on the opening quote.
    fn string(&mut self) -> Option<String> {
      self.i += 1;
      let start = self.i;
      loop {
        match self.peek()? {
          b'"' => {
            let out = self.text[start..self.i].to_string();
            self.i += 1;
            return Some(out);
          }
          b'\\' => break,
          c if c < 0x20 => return None,
          _ => self.i += 1,
        }
      }
      // escapes: collect UTF-16 code units (a lone surrogate becomes U+FFFD)
      let mut units: Vec<u16> = self.text[start..self.i].encode_utf16().collect();
      loop {
        match self.peek()? {
          b'"' => {
            self.i += 1;
            return Some(String::from_utf16_lossy(&units));
          }
          b'\\' => {
            self.i += 1;
            let unit = match self.peek()? {
              b'"' => 0x22,
              b'\\' => 0x5c,
              b'/' => 0x2f,
              b'b' => 0x08,
              b'f' => 0x0c,
              b'n' => 0x0a,
              b'r' => 0x0d,
              b't' => 0x09,
              b'u' => {
                self.i += 1;
                units.push(self.hex4()?);
                continue;
              }
              _ => return None,
            };
            units.push(unit);
            self.i += 1;
          }
          c if c < 0x20 => return None,
          _ => {
            let run_start = self.i;
            while self.peek().is_some_and(|c| c != b'"' && c != b'\\' && c >= 0x20) {
              self.i += 1;
            }
            units.extend(self.text[run_start..self.i].encode_utf16());
          }
        }
      }
    }

    fn number(&mut self) -> Option<JsVal> {
      let start = self.i;
      let digits = |p: &mut Self| {
        let from = p.i;
        while p.peek().is_some_and(|c| c.is_ascii_digit()) {
          p.i += 1;
        }
        p.i > from
      };
      if self.peek() == Some(b'-') {
        self.i += 1;
      }
      match self.peek()? {
        b'0' => {
          self.i += 1;
          if self.peek().is_some_and(|c| c.is_ascii_digit()) {
            return None;
          }
        }
        b'1'..=b'9' => {
          digits(self);
        }
        _ => return None,
      }
      if self.peek() == Some(b'.') {
        self.i += 1;
        if !digits(self) {
          return None;
        }
      }
      if matches!(self.peek(), Some(b'e' | b'E')) {
        self.i += 1;
        if matches!(self.peek(), Some(b'+' | b'-')) {
          self.i += 1;
        }
        if !digits(self) {
          return None;
        }
      }
      Some(JsVal::Num(self.text[start..self.i].parse::<f64>().unwrap_or(f64::NAN)))
    }

    fn property_key(&mut self) -> Option<String> {
      self.ws();
      if self.peek() != Some(b'"') {
        return None;
      }
      let key = self.string()?;
      self.eat(b':')?;
      Some(key)
    }
  }

  /// `CreateDataProperty(obj, key, value)`: an existing key keeps its position, array-index keys
  /// are ordered first (ascending).
  fn define(obj: &mut Obj, key: String, value: JsVal) {
    if let Some(slot) = obj.get_mut(&key) {
      *slot = value;
      return;
    }
    match array_index(&key) {
      Some(index) => {
        let position =
          obj.keys().position(|k| array_index(k).is_none_or(|other| other > index)).unwrap_or(obj.len());
        obj.shift_insert(position, key, value);
      }
      None => {
        obj.insert(key, value);
      }
    }
  }

  fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
      return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
      return None;
    }
    let n: u64 = key.parse().ok()?;
    (n < u64::from(u32::MAX)).then_some(n as u32)
  }

  pub(super) fn parse(text: &str) -> Option<JsVal> {
    let mut p = Parser { text, s: text.as_bytes(), i: 0 };
    let mut stack: Vec<Frame> = Vec::new();
    'value: loop {
      p.ws();
      let mut value = match p.peek()? {
        b'{' => {
          p.i += 1;
          p.ws();
          if p.peek() == Some(b'}') {
            p.i += 1;
            JsVal::obj(Obj::new())
          } else {
            let key = p.property_key()?;
            stack.push(Frame::Obj(Obj::new(), key));
            continue 'value;
          }
        }
        b'[' => {
          p.i += 1;
          p.ws();
          if p.peek() == Some(b']') {
            p.i += 1;
            JsVal::arr(Vec::new())
          } else {
            stack.push(Frame::Arr(Vec::new()));
            continue 'value;
          }
        }
        b'"' => JsVal::str(p.string()?),
        b't' => p.literal("true", JsVal::Bool(true))?,
        b'f' => p.literal("false", JsVal::Bool(false))?,
        b'n' => p.literal("null", JsVal::Null)?,
        b'-' | b'0'..=b'9' => p.number()?,
        _ => return None,
      };
      loop {
        match stack.last_mut() {
          None => {
            p.ws();
            return (p.i == p.s.len()).then_some(value);
          }
          Some(Frame::Arr(items)) => {
            items.push(value);
            p.ws();
            match p.peek()? {
              b',' => {
                p.i += 1;
                continue 'value;
              }
              b']' => {
                p.i += 1;
                let Some(Frame::Arr(items)) = stack.pop() else { return None };
                value = JsVal::arr(items);
              }
              _ => return None,
            }
          }
          Some(Frame::Obj(obj, key)) => {
            define(obj, std::mem::take(key), value);
            p.ws();
            match p.peek()? {
              b',' => {
                p.i += 1;
                *key = p.property_key()?;
                continue 'value;
              }
              b'}' => {
                p.i += 1;
                let Some(Frame::Obj(obj, _)) = stack.pop() else { return None };
                value = JsVal::obj(obj);
              }
              _ => return None,
            }
          }
        }
      }
    }
  }
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

/// `JSON.parse` sources V8 reports as `"<source>" is not valid JSON`.
const SPECIAL_SOURCES: [&str; 4] = ["[object Object]", "undefined", "Infinity", "NaN"];
/// V8 `JsonParser::kMaxContextCharacters` / `kMinOriginalSourceLengthForContext`.
const MAX_CONTEXT_CHARACTERS: usize = 10;
const MIN_SOURCE_LENGTH_FOR_CONTEXT: usize = MAX_CONTEXT_CHARACTERS * 2 + 1;

/// The `SyntaxError` messages of V8's `JsonParser` (Node 24) that carry a position.
#[derive(Clone, Copy)]
enum Msg {
  UnexpectedNumber,
  UnexpectedString,
  UnterminatedString,
  ExpectedPropNameOrRBrace,
  ExpectedCommaOrRBrack,
  ExpectedCommaOrRBrace,
  ExpectedColonAfterPropertyName,
  ExpectedDoubleQuotedPropertyName,
  ExponentPartMissingNumber,
  UnterminatedFractionalNumber,
  NoNumberAfterMinusSign,
  BadControlCharacter,
  BadUnicodeEscape,
  BadEscapedCharacter,
  UnexpectedNonWhiteSpaceCharacter,
}

impl Msg {
  fn text(self) -> &'static str {
    match self {
      Msg::UnexpectedNumber => "Unexpected number",
      Msg::UnexpectedString => "Unexpected string",
      Msg::UnterminatedString => "Unterminated string",
      Msg::ExpectedPropNameOrRBrace => "Expected property name or '}'",
      Msg::ExpectedCommaOrRBrack => "Expected ',' or ']' after array element",
      Msg::ExpectedCommaOrRBrace => "Expected ',' or '}' after property value",
      Msg::ExpectedColonAfterPropertyName => "Expected ':' after property name",
      Msg::ExpectedDoubleQuotedPropertyName => "Expected double-quoted property name",
      Msg::ExponentPartMissingNumber => "Exponent part is missing a number",
      Msg::UnterminatedFractionalNumber => "Unterminated fractional number",
      Msg::NoNumberAfterMinusSign => "No number after minus sign",
      Msg::BadControlCharacter => "Bad control character in string literal",
      Msg::BadUnicodeEscape => "Bad Unicode escape",
      Msg::BadEscapedCharacter => "Bad escaped character",
      Msg::UnexpectedNonWhiteSpaceCharacter => "Unexpected non-whitespace character after",
    }
  }
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

  /// `CalculateFileLocation`: 1-based line and column of the cursor (`\r\n`, `\r` and `\n` end
  /// a line).
  fn line_column(&self) -> (usize, usize) {
    let mut line = 1;
    let mut line_start = 0;
    let mut k = 0;
    while k < self.i {
      if self.s[k] == 0x0d && k + 1 < self.i && self.s[k + 1] == 0x0a {
        k += 1;
      }
      if matches!(self.s[k], 0x0d | 0x0a) {
        line += 1;
        line_start = k + 1;
      }
      k += 1;
    }
    (line, 1 + k - line_start)
  }

  /// `ReportUnexpectedToken(token, message)` with an explicit message.
  fn error(&self, msg: Msg) -> EngineError {
    let (line, column) = self.line_column();
    let text = msg.text();
    let joiner = if matches!(msg, Msg::UnexpectedNonWhiteSpaceCharacter) { " JSON at" } else { " in JSON at" };
    syntax_error(format!("{text}{joiner} position {} (line {line} column {column})", self.i))
  }

  /// `ReportUnexpectedCharacter(current)`: the message for the token the current character
  /// starts (`LookUpErrorMessageForJsonToken`).
  fn unexpected(&self) -> EngineError {
    let Some(c) = self.peek() else { return syntax_error("Unexpected end of JSON input") };
    match c {
      0x22 => return self.error(Msg::UnexpectedString),
      0x2d | 0x30..=0x39 => return self.error(Msg::UnexpectedNumber),
      _ => {}
    }
    let source = String::from_utf16_lossy(self.s);
    if SPECIAL_SOURCES.contains(&source.as_str()) {
      return syntax_error(format!("\"{source}\" is not valid JSON"));
    }
    let token = String::from_utf16_lossy(&[c]);
    let len = self.s.len();
    let pos = self.i;
    let slice = |from: usize, to: usize| String::from_utf16_lossy(&self.s[from..to.min(len)]);
    syntax_error(if len < MIN_SOURCE_LENGTH_FOR_CONTEXT {
      format!("Unexpected token '{token}', \"{source}\" is not valid JSON")
    } else if pos < MAX_CONTEXT_CHARACTERS {
      format!("Unexpected token '{token}', \"{}\"... is not valid JSON", slice(0, pos + MAX_CONTEXT_CHARACTERS))
    } else if pos < len - MAX_CONTEXT_CHARACTERS {
      format!(
        "Unexpected token '{token}', ...\"{}\"... is not valid JSON",
        slice(pos - MAX_CONTEXT_CHARACTERS, pos + MAX_CONTEXT_CHARACTERS)
      )
    } else {
      format!("Unexpected token '{token}', ...\"{}\" is not valid JSON", slice(pos - MAX_CONTEXT_CHARACTERS, len))
    })
  }

  /// `ExpectNext(token, message)`: skips white space, then requires `c`.
  fn expect_next(&mut self, c: u16, msg: Msg) -> Result<()> {
    self.ws();
    if self.peek() == Some(c) {
      self.i += 1;
      Ok(())
    } else {
      Err(self.error(msg))
    }
  }

  /// `ScanLiteral(word)`; the first character already matched.
  fn literal(&mut self, word: &str, value: Val) -> Result<Val> {
    let word: Vec<u16> = word.encode_utf16().collect();
    let remaining = self.s.len() - self.i;
    if remaining >= word.len() && self.s[self.i + 1..self.i + word.len()] == word[1..] {
      self.i += word.len();
      return Ok(value);
    }
    self.i += 1;
    for k in 0..(word.len() - 1).min(remaining - 1) {
      if word[1 + k] != self.s[self.i] {
        return Err(self.unexpected());
      }
      self.i += 1;
    }
    Err(syntax_error("Unexpected end of JSON input"))
  }

  fn hex4(&mut self) -> Result<u16> {
    let mut v: u16 = 0;
    for _ in 0..4 {
      let d = match self.peek() {
        Some(c @ 0x30..=0x39) => c - 0x30,
        Some(c @ 0x41..=0x46) => c - 0x41 + 10,
        Some(c @ 0x61..=0x66) => c - 0x61 + 10,
        _ => return Err(self.error(Msg::BadUnicodeEscape)),
      };
      v = v * 16 + d;
      self.i += 1;
    }
    Ok(v)
  }

  /// `ScanJsonString`; the cursor is on the opening quote.
  fn string(&mut self) -> Result<JsStr> {
    self.i += 1;
    let mut out: Vec<u16> = Vec::new();
    loop {
      let Some(c) = self.peek() else { return Err(self.error(Msg::UnterminatedString)) };
      match c {
        0x22 => {
          self.i += 1;
          return Ok(JsStr::from_units(&out));
        }
        0x5c => {
          self.i += 1;
          // past the end or outside Latin-1: `ReportUnexpectedCharacter`
          let Some(e) = self.peek().filter(|e| *e <= 0xff) else { return Err(self.unexpected()) };
          match e {
            0x22 | 0x5c | 0x2f => out.push(e),
            0x62 => out.push(0x08),
            0x66 => out.push(0x0c),
            0x6e => out.push(0x0a),
            0x72 => out.push(0x0d),
            0x74 => out.push(0x09),
            0x75 => {
              self.i += 1;
              let u = self.hex4()?;
              out.push(u);
              continue;
            }
            _ => return Err(self.error(Msg::BadEscapedCharacter)),
          }
          self.i += 1;
        }
        c if c < 0x20 => return Err(self.error(Msg::BadControlCharacter)),
        c => {
          out.push(c);
          self.i += 1;
        }
      }
    }
  }

  /// `ParseJsonNumber`
  fn number(&mut self) -> Result<Val> {
    let start = self.i;
    let digit = |c: Option<u16>| matches!(c, Some(0x30..=0x39));
    if self.peek() == Some(0x2d) {
      self.i += 1;
      if !digit(self.peek()) {
        return Err(self.error(Msg::NoNumberAfterMinusSign));
      }
    }
    if self.peek() == Some(0x30) {
      self.i += 1;
      if digit(self.peek()) {
        return Err(self.error(Msg::UnexpectedNumber));
      }
    } else {
      while digit(self.peek()) {
        self.i += 1;
      }
    }
    if self.peek() == Some(0x2e) {
      self.i += 1;
      if !digit(self.peek()) {
        return Err(self.error(Msg::UnterminatedFractionalNumber));
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
        return Err(self.error(Msg::ExponentPartMissingNumber));
      }
      while digit(self.peek()) {
        self.i += 1;
      }
    }
    let text = String::from_utf16_lossy(&self.s[start..self.i]);
    Ok(Val::Num(text.parse::<f64>().unwrap_or(f64::NAN)))
  }

  /// A property key at the cursor (after `{` or `,`), followed by its `:`.
  fn property_key(&mut self, missing: Msg) -> Result<JsStr> {
    self.ws();
    if self.peek() != Some(0x22) {
      return Err(self.error(missing));
    }
    let key = self.string()?;
    self.expect_next(0x3a, Msg::ExpectedColonAfterPropertyName)?;
    Ok(key)
  }
}

/// `JSON.parse` over UTF-16 code units (iterative: nesting depth is unbounded, like V8), with
/// V8's `SyntaxError` messages.
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
          let key = p.property_key(Msg::ExpectedPropNameOrRBrace)?;
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
            return Err(p.error(Msg::UnexpectedNonWhiteSpaceCharacter));
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
            _ => return Err(p.error(Msg::ExpectedCommaOrRBrack)),
          }
        }
        Some(Frame::Obj(obj, key)) => {
          obj.define(&*key, value);
          p.ws();
          match p.peek() {
            Some(0x2c) => {
              p.i += 1;
              *key = p.property_key(Msg::ExpectedDoubleQuotedPropertyName)?;
              continue 'value;
            }
            Some(0x7d) => {
              p.i += 1;
              let Some(Frame::Obj(obj, _)) = stack.pop() else { unreachable!() };
              value = Val::from_obj(obj);
            }
            _ => return Err(p.error(Msg::ExpectedCommaOrRBrace)),
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
        Val::BigInt(_) => return Err(EngineError::new("TypeError", "Do not know how to serialize a BigInt")),
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

