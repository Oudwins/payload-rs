//! JavaScript builtin semantics used by the query builder: `Number()`, `String()`,
//! `parseInt`/`parseFloat`, `JSON.stringify`, `new Date(...)` / `toISOString()` and the
//! small regexes from `@payloadcms/drizzle/src/utilities` (dates live in [`crate::js_date`]).

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;

/// JS `WhiteSpace` + `LineTerminator` (what `String.prototype.trim` removes).
pub fn is_js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
      | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
  )
}

/// `Number.prototype.toString()` (radix 10).
pub fn number_to_string(n: f64) -> String {
  payload_engine::js::num_to_js_string(n)
}

/// JS `String(value)`.
pub fn js_string(v: &JsVal) -> String {
  match v {
    JsVal::Num(n) => number_to_string(*n),
    JsVal::Arr(a) => a.iter().map(|v| if v.is_nullish() { String::new() } else { js_string(v) }).collect::<Vec<_>>().join(","),
    other => other.to_js_string(),
  }
}

/// Parses the `StrDecimalLiteral` prefix of `s`; returns the value and the byte length consumed.
fn decimal_prefix(s: &str) -> Option<(f64, usize)> {
  let b = s.as_bytes();
  let mut i = 0;
  if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
    i += 1;
  }
  if s[i..].starts_with("Infinity") {
    let end = i + "Infinity".len();
    let v = if b.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    return Some((v, end));
  }
  let int_start = i;
  while i < b.len() && b[i].is_ascii_digit() {
    i += 1;
  }
  let mut has_digits = i > int_start;
  if i < b.len() && b[i] == b'.' {
    let frac_start = i + 1;
    let mut j = frac_start;
    while j < b.len() && b[j].is_ascii_digit() {
      j += 1;
    }
    if j > frac_start || has_digits {
      has_digits = has_digits || j > frac_start;
      i = j;
    }
  }
  if !has_digits {
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
  let text = &s[..i];
  let text = text.strip_suffix('.').unwrap_or(text);
  let parsed: f64 = text.parse().ok()?;
  Some((parsed, i))
}

/// Digits of a power-of-two radix (2, 8, 16) as V8's `InternalStringToIntDouble` converts them:
/// exact up to 53 significant bits, then rounded half to even (`Infinity` past the double range).
pub fn pow2_radix_to_f64(digits: &str, radix: u32) -> f64 {
  let bits_per_digit = radix.trailing_zeros();
  let mut mantissa: u64 = 0;
  let mut significant_bits = 0usize;
  let mut round_bit = false;
  let mut sticky = false;
  let mut dropped = 0usize;
  for c in digits.chars() {
    let d = c.to_digit(radix).unwrap_or(0);
    for shift in (0..bits_per_digit).rev() {
      let bit = (d >> shift) & 1 == 1;
      if significant_bits == 0 && !bit {
        continue;
      }
      if significant_bits < 53 {
        mantissa = (mantissa << 1) | u64::from(bit);
        significant_bits += 1;
      } else {
        if dropped == 0 {
          round_bit = bit;
        } else {
          sticky |= bit;
        }
        dropped += 1;
      }
    }
  }
  if round_bit && (sticky || mantissa & 1 == 1) {
    mantissa += 1;
  }
  let exponent = i32::try_from(dropped).unwrap_or(i32::MAX);
  // `mantissa` may be 2^53 after rounding up; still exact as a double.
  if exponent > 1100 { f64::INFINITY } else { mantissa as f64 * 2f64.powi(exponent) }
}

/// JS `StringToNumber` (used by `Number(string)`).
pub fn string_to_number(s: &str) -> f64 {
  let t = s.trim_matches(is_js_whitespace);
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

/// JS `Number(value)`.
pub fn js_number(v: &JsVal) -> f64 {
  if let Some(ms) = v.as_date() {
    return ms;
  }
  match v {
    JsVal::Undefined | JsVal::Fn(_) => f64::NAN,
    JsVal::Null => 0.0,
    JsVal::Bool(b) => f64::from(u8::from(*b)),
    JsVal::Num(n) => *n,
    JsVal::Str(s) => string_to_number(s),
    JsVal::Arr(_) => string_to_number(&js_string(v)),
    JsVal::Obj(_) => f64::NAN,
  }
}

/// The hint of `ToPrimitive`: `Number(value)` asks for a number, `String(value)` for a string.
#[derive(Clone, Copy, PartialEq)]
enum Hint {
  Number,
  String,
}

/// Whether `ToPrimitive(value, hint)` (`OrdinaryToPrimitive`) throws. An object's conversion
/// methods are tried in hint order (`valueOf` then `toString` for numbers, the reverse for
/// strings): a method that is not callable is skipped, the inherited `Object.prototype.valueOf`
/// returns the object itself (skipped too) and the inherited `toString` gives `"[object Object]"`.
/// When neither gives a primitive it is a `TypeError`. An own method that is a JS function would
/// be called, which this side cannot do: that is an internal error, not a guessed result. Array
/// items are converted with the string hint (`join`).
fn check_to_primitive(v: &JsVal, hint: Hint, joining: &mut Vec<usize>) -> Result<()> {
  if v.typed().is_some() {
    return Ok(());
  }
  match v {
    JsVal::Obj(o) => {
      let order = if hint == Hint::Number { ["valueOf", "toString"] } else { ["toString", "valueOf"] };
      for name in order {
        match o.get(name) {
          Some(JsVal::Fn(_)) => {
            return Err(EngineError::internal(format!(
              "payload-sql-query: converting an object whose own `{name}` is a function to a primitive is not supported"
            )));
          }
          Some(_) => {}
          None if name == "toString" => return Ok(()),
          None => {}
        }
      }
      Err(EngineError::new("TypeError", "Cannot convert object to primitive value"))
    }
    JsVal::Arr(items) => {
      let id = std::sync::Arc::as_ptr(items) as usize;
      if joining.contains(&id) {
        return Ok(());
      }
      joining.push(id);
      for item in items.iter() {
        check_to_primitive(item, Hint::String, joining)?;
      }
      joining.pop();
      Ok(())
    }
    _ => Ok(()),
  }
}

/// JS `Number(value)`, including the `TypeError` of an object without a primitive value.
pub fn js_number_checked(v: &JsVal) -> Result<f64> {
  check_to_primitive(v, Hint::Number, &mut Vec::new())?;
  Ok(js_number(v))
}

/// JS `String(value)`, including the `TypeError` of an object without a primitive value.
pub fn js_string_checked(v: &JsVal) -> Result<String> {
  check_to_primitive(v, Hint::String, &mut Vec::new())?;
  Ok(js_string(v))
}

/// JS `parseFloat(value)`.
pub fn parse_float(v: &JsVal) -> f64 {
  let s = js_string(v);
  let t = s.trim_start_matches(is_js_whitespace);
  decimal_prefix(t).map(|(v, _)| v).unwrap_or(f64::NAN)
}

/// JS `parseInt(value)` without a radix.
pub fn parse_int(v: &JsVal) -> f64 {
  let s = js_string(v);
  let mut t = s.trim_start_matches(is_js_whitespace);
  let mut sign = 1.0;
  if let Some(rest) = t.strip_prefix('-') {
    sign = -1.0;
    t = rest;
  } else if let Some(rest) = t.strip_prefix('+') {
    t = rest;
  }
  let mut radix = 10;
  if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
    radix = 16;
    t = rest;
  }
  let digits: String = t.chars().take_while(|c| c.is_digit(radix)).collect();
  if digits.is_empty() {
    return f64::NAN;
  }
  if radix == 10 {
    // Decimal digits are converted exactly like a decimal literal.
    return sign * digits.parse::<f64>().unwrap_or(f64::NAN);
  }
  sign * pow2_radix_to_f64(&digits, radix)
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

fn json_write(v: &JsVal, out: &mut String) -> bool {
  // `Date.prototype.toJSON`: the ISO string, `null` for an invalid date
  if let Some(ms) = v.as_date() {
    match to_iso_string(ms) {
      Ok(iso) => json_quote(&iso, out),
      Err(_) => out.push_str("null"),
    }
    return true;
  }
  match v {
    JsVal::Undefined | JsVal::Fn(_) => return false,
    JsVal::Null => out.push_str("null"),
    JsVal::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
    JsVal::Num(n) => {
      if n.is_finite() {
        out.push_str(&number_to_string(*n))
      } else {
        out.push_str("null")
      }
    }
    JsVal::Str(s) => json_quote(s, out),
    JsVal::Arr(a) => {
      out.push('[');
      for (i, item) in a.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        if !json_write(item, out) {
          out.push_str("null");
        }
      }
      out.push(']');
    }
    JsVal::Obj(o) => {
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
        json_write(item, out);
      }
      out.push('}');
    }
  }
  true
}

/// `JSON.stringify(value)`; `None` when the result is `undefined`.
pub fn json_stringify(v: &JsVal) -> Option<String> {
  let mut out = String::new();
  json_write(v, &mut out).then_some(out)
}

pub use crate::js_date::{date_parse, to_iso_string};

/// `uuid.validate` (uuid v9/v10 regex).
pub fn uuid_validate(v: &JsVal) -> bool {
  let Some(s) = v.as_str() else { return false };
  let s = s.to_ascii_lowercase();
  if s == "00000000-0000-0000-0000-000000000000" || s == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
    return true;
  }
  let b = s.as_bytes();
  if b.len() != 36 {
    return false;
  }
  for (i, c) in b.iter().enumerate() {
    let ok = match i {
      8 | 13 | 18 | 23 => *c == b'-',
      14 => (b'1'..=b'8').contains(c),
      19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
      _ => c.is_ascii_hexdigit(),
    };
    if !ok {
      return false;
    }
  }
  true
}

/// JS `\w`.
pub fn is_word_char(c: char) -> bool {
  c.is_ascii_alphanumeric() || c == '_'
}

/// `str.replace(/__/g, '.')`
pub fn replace_double_underscore(s: &str) -> String {
  s.replace("__", ".")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn number_formatting() {
    for (n, s) in [
      (1e21, "1e+21"),
      (1e-7, "1e-7"),
      (123.456, "123.456"),
      (0.000001, "0.000001"),
      (1.5e300, "1.5e+300"),
      (-0.0, "0"),
      (9007199254740992.0, "9007199254740992"),
      (1e20, "100000000000000000000"),
      (-12.5, "-12.5"),
    ] {
      assert_eq!(number_to_string(n), s);
    }
  }

  #[test]
  fn string_numbers() {
    assert_eq!(string_to_number(" 12 "), 12.0);
    assert_eq!(string_to_number(""), 0.0);
    assert!(string_to_number("12abc").is_nan());
    assert_eq!(string_to_number("0x1A"), 26.0);
    assert_eq!(string_to_number("1e3"), 1000.0);
    assert_eq!(string_to_number(".5"), 0.5);
    assert_eq!(string_to_number("5."), 5.0);
    assert!(string_to_number(".").is_nan());
    assert!(string_to_number("inf").is_nan());
    assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
    assert_eq!(parse_int(&JsVal::str("12.7abc")), 12.0);
    assert!(parse_int(&JsVal::str("abc")).is_nan());
    assert_eq!(parse_float(&JsVal::str(" 1.5e2x")), 150.0);
  }
}
