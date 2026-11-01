//! JS builtins used by `transform/read`: `Number()`, `Number.parseFloat`,
//! `Number.prototype.toString`, `JSON.parse` (dates live in [`crate::date`]).

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;

use crate::jsstr::JsStr;
use crate::value::{Builtin, Val};

/// JS `WhiteSpace` and `LineTerminator` (what `String.prototype.trim` removes).
pub fn is_js_whitespace(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
      | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
  )
}

/// `Number.prototype.toString()` (radix 10), e.g. `1e21`, `1.5e-7`, `0.000001`.
pub fn num_to_string(n: f64) -> String {
  payload_engine::js::num_to_js_string(n)
}

/// Length of the longest prefix of `s` matching `StrDecimalLiteral`
/// (without `Infinity`), or 0.
fn decimal_prefix_len(s: &[u8]) -> usize {
  let mut i = 0;
  if i < s.len() && (s[i] == b'+' || s[i] == b'-') {
    i += 1;
  }
  let int_start = i;
  while i < s.len() && s[i].is_ascii_digit() {
    i += 1;
  }
  let int_digits = i - int_start;
  let mut frac_digits = 0;
  if i < s.len() && s[i] == b'.' {
    let mut j = i + 1;
    while j < s.len() && s[j].is_ascii_digit() {
      j += 1;
    }
    frac_digits = j - i - 1;
    if int_digits > 0 || frac_digits > 0 {
      i = j;
    }
  }
  if int_digits == 0 && frac_digits == 0 {
    return 0;
  }
  if i < s.len() && (s[i] == b'e' || s[i] == b'E') {
    let mut j = i + 1;
    if j < s.len() && (s[j] == b'+' || s[j] == b'-') {
      j += 1;
    }
    let exp_start = j;
    while j < s.len() && s[j].is_ascii_digit() {
      j += 1;
    }
    if j > exp_start {
      i = j;
    }
  }
  i
}

/// Parses a validated decimal literal prefix.
fn parse_decimal(s: &str) -> f64 {
  let mut normalized = String::with_capacity(s.len() + 2);
  let mut rest = s;
  if let Some(r) = rest.strip_prefix('-') {
    normalized.push('-');
    rest = r;
  } else if let Some(r) = rest.strip_prefix('+') {
    rest = r;
  }
  if rest.starts_with('.') {
    normalized.push('0');
  }
  normalized.push_str(rest);
  if normalized.ends_with('.') {
    normalized.push('0');
  }
  normalized = normalized.replace(".e", ".0e").replace(".E", ".0E");
  normalized.parse::<f64>().unwrap_or(f64::NAN)
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

fn parse_radix(digits: &str, radix: u32) -> f64 {
  if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
    return f64::NAN;
  }
  pow2_radix_to_f64(digits, radix)
}

/// `StringToNumber` (`Number(string)`).
pub fn string_to_number(s: &str) -> f64 {
  let t = s.trim_matches(is_js_whitespace);
  if t.is_empty() {
    return 0.0;
  }
  let lower_prefix = t.get(..2).map(|p| p.to_ascii_lowercase());
  match lower_prefix.as_deref() {
    Some("0x") => return parse_radix(&t[2..], 16),
    Some("0o") => return parse_radix(&t[2..], 8),
    Some("0b") => return parse_radix(&t[2..], 2),
    _ => {}
  }
  match t {
    "Infinity" | "+Infinity" => return f64::INFINITY,
    "-Infinity" => return f64::NEG_INFINITY,
    _ => {}
  }
  let len = decimal_prefix_len(t.as_bytes());
  if len == 0 || len != t.len() {
    return f64::NAN;
  }
  parse_decimal(t)
}

/// `Number.parseFloat(string)`
pub fn parse_float(s: &str) -> f64 {
  let t = s.trim_start_matches(is_js_whitespace);
  for (prefix, value) in [("Infinity", f64::INFINITY), ("+Infinity", f64::INFINITY), ("-Infinity", f64::NEG_INFINITY)] {
    if t.starts_with(prefix) {
      return value;
    }
  }
  let len = decimal_prefix_len(t.as_bytes());
  if len == 0 {
    return f64::NAN;
  }
  parse_decimal(&t[..len])
}

/// `Number(value)` (`ToNumber`), including the `TypeError` of an object that cannot be
/// converted to a primitive (own non-callable `valueOf` and `toString`).
pub fn to_number(v: &Val) -> Result<f64> {
  Ok(match v {
    Val::Undefined => f64::NAN,
    Val::Null => 0.0,
    Val::Bool(b) => f64::from(u8::from(*b)),
    Val::Num(n) => *n,
    // Lone surrogates are never white space or digits, so U+FFFD gives the same result.
    Val::Str(s) => string_to_number(&s.to_lossy()),
    Val::Date(t) => *t,
    // `Number(10n)` is `10` (rounded to the nearest double)
    Val::BigInt(d) => d.parse::<f64>().unwrap_or(f64::NAN),
    Val::Arr(_) | Val::Obj(_) => to_number(&ordinary_to_primitive(v, false, &mut Vec::new())?)?,
    // `Object.prototype` and built-in functions print `[object Object]` / their source.
    Val::Builtin(_) => f64::NAN,
  })
}

/// `OrdinaryToPrimitive(value, hint)` for an array or ordinary object (`hint_string` for
/// `String(value)`, otherwise `number`). Methods are looked up through the prototype chain: the
/// inherited `valueOf` returns the object itself, the inherited `toString` gives
/// `"[object Object]"` (arrays: `join(',')`). Data rows can only shadow them with non-callable
/// values, which are skipped; `TypeError` when neither yields a primitive.
fn ordinary_to_primitive(v: &Val, hint_string: bool, joining: &mut Vec<usize>) -> Result<Val> {
  let order = if hint_string { ["toString", "valueOf"] } else { ["valueOf", "toString"] };
  for name in order {
    match crate::props::get(v, name)? {
      Val::Builtin(Builtin::Function("toString")) => {
        return Ok(match v {
          Val::Arr(a) => Val::Str(JsStr::from(array_join(a, joining)?)),
          _ => Val::str("[object Object]"),
        });
      }
      // `valueOf` (and any other built-in reachable here) returns an object
      Val::Builtin(Builtin::Function(_)) => {}
      // not callable
      _ => {}
    }
  }
  Err(EngineError::new("TypeError", "Cannot convert object to primitive value"))
}

/// `Array.prototype.join(',')`: nullish items print as `''`, as does a reference to an array
/// that is already being joined (V8's cycle detection).
fn array_join(a: &crate::value::ArrRef, joining: &mut Vec<usize>) -> Result<String> {
  let id = std::rc::Rc::as_ptr(a) as *const () as usize;
  if joining.contains(&id) {
    return Ok(String::new());
  }
  joining.push(id);
  let items = a.borrow().to_vec();
  let mut out = String::new();
  for (i, item) in items.iter().enumerate() {
    if i > 0 {
      out.push(',');
    }
    let part = match item {
      Val::Undefined | Val::Null => String::new(),
      Val::Arr(_) | Val::Obj(_) => ordinary_to_primitive(item, true, joining)?.to_js_string(),
      other => other.to_js_string(),
    };
    out.push_str(&part);
  }
  joining.pop();
  Ok(out)
}

/// `Number(value)` for a config value.
pub fn js_to_number(v: &JsVal) -> f64 {
  if let Some(t) = v.as_date() {
    return t;
  }
  match v {
    JsVal::Undefined | JsVal::Fn(_) | JsVal::Obj(_) => f64::NAN,
    JsVal::Null => 0.0,
    JsVal::Bool(b) => f64::from(u8::from(*b)),
    JsVal::Num(n) => *n,
    JsVal::Str(s) => string_to_number(s),
    JsVal::Arr(_) => string_to_number(&v.to_js_string()),
  }
}

/// `ToIntegerOrInfinity`
pub fn to_integer_or_infinity(n: f64) -> f64 {
  if n.is_nan() { 0.0 } else { n.trunc() }
}

/// Resolves a relative `Array.prototype.slice` end index.
pub fn relative_index(n: f64, len: usize) -> usize {
  let len_f = len as f64;
  let rel = to_integer_or_infinity(n);
  let idx = if rel < 0.0 { (len_f + rel).max(0.0) } else { rel.min(len_f) };
  idx as usize
}

/// `left > right` where `left` is a number and `right` an arbitrary config value
/// (Abstract Relational Comparison with `right` converted via `ToNumber`).
pub fn num_gt_js(left: f64, right: &JsVal) -> bool {
  let r = js_to_number(right);
  left > r
}

/// `JSON.parse(text)` (see [`crate::json`]).
pub fn json_parse(text: &JsStr) -> Result<Val> {
  crate::json::parse_js(text)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn number_to_string() {
    assert_eq!(num_to_string(1.0), "1");
    assert_eq!(num_to_string(-1.5), "-1.5");
    assert_eq!(num_to_string(1e21), "1e+21");
    assert_eq!(num_to_string(123456789012345680000.0), "123456789012345680000");
    assert_eq!(num_to_string(1.5e-7), "1.5e-7");
    assert_eq!(num_to_string(0.000001), "0.000001");
    assert_eq!(num_to_string(0.1 + 0.2), "0.30000000000000004");
  }

  #[test]
  fn string_numbers() {
    assert_eq!(string_to_number(" 12 "), 12.0);
    assert_eq!(string_to_number(""), 0.0);
    assert_eq!(string_to_number("0x10"), 16.0);
    assert!(string_to_number("-0x10").is_nan());
    assert!(string_to_number("1e").is_nan());
    assert!(string_to_number("inf").is_nan());
    assert_eq!(string_to_number("1."), 1.0);
    assert_eq!(string_to_number(".5"), 0.5);
    assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
    assert_eq!(parse_float("1.5abc"), 1.5);
    assert_eq!(parse_float("  -.5e3x"), -500.0);
    assert!(parse_float("abc").is_nan());
    assert_eq!(parse_float("1e"), 1.0);
  }
}
