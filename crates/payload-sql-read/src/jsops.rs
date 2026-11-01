//! JS builtins used by `transform/read`: `Number()`, `Number.parseFloat`,
//! `Number.prototype.toString`, `JSON.parse` (dates live in [`crate::date`]).

use payload_engine::error::Result;
use payload_engine::js::JsVal;

use crate::jsstr::JsStr;
use crate::value::Val;

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
  if n.is_nan() {
    return "NaN".into();
  }
  if n == 0.0 {
    return "0".into();
  }
  if n.is_infinite() {
    return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
  }
  let sign = if n < 0.0 { "-" } else { "" };
  // `{:e}` yields the shortest round-tripping digits, e.g. `1.2345e-7`.
  let sci = format!("{:e}", n.abs());
  let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
  let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
  let exp: i32 = exp.parse().unwrap_or(0);
  let k = digits.len() as i32;
  let n_exp = exp + 1;
  let body = if k <= n_exp && n_exp <= 21 {
    format!("{digits}{}", "0".repeat((n_exp - k) as usize))
  } else if 0 < n_exp && n_exp <= 21 {
    format!("{}.{}", &digits[..n_exp as usize], &digits[n_exp as usize..])
  } else if -6 < n_exp && n_exp <= 0 {
    format!("0.{}{digits}", "0".repeat((-n_exp) as usize))
  } else {
    let e = n_exp - 1;
    let e_sign = if e >= 0 { "+" } else { "-" };
    if k == 1 {
      format!("{digits}e{e_sign}{}", e.abs())
    } else {
      format!("{}.{}e{e_sign}{}", &digits[..1], &digits[1..], e.abs())
    }
  };
  format!("{sign}{body}")
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

fn parse_radix(digits: &str, radix: u32) -> f64 {
  if digits.is_empty() {
    return f64::NAN;
  }
  let mut acc: u128 = 0;
  let mut approx = 0f64;
  let mut overflow = false;
  for c in digits.chars() {
    let Some(d) = c.to_digit(radix) else { return f64::NAN };
    if !overflow {
      match acc.checked_mul(radix as u128).and_then(|v| v.checked_add(d as u128)) {
        Some(v) => acc = v,
        None => {
          overflow = true;
          approx = acc as f64 * radix as f64 + d as f64;
        }
      }
    } else {
      approx = approx * radix as f64 + d as f64;
    }
  }
  if overflow { approx } else { acc as f64 }
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

/// `Number(value)` (`ToNumber`).
pub fn to_number(v: &Val) -> f64 {
  match v {
    Val::Undefined => f64::NAN,
    Val::Null => 0.0,
    Val::Bool(b) => f64::from(u8::from(*b)),
    Val::Num(n) => *n,
    // Lone surrogates are never white space or digits, so U+FFFD gives the same result.
    Val::Str(s) => string_to_number(&s.to_lossy()),
    Val::Date(t) => *t,
    Val::Arr(_) => string_to_number(&v.to_js_string()),
    Val::Obj(_) | Val::Builtin(_) => f64::NAN,
  }
}

/// `Number(value)` for a config value.
pub fn js_to_number(v: &JsVal) -> f64 {
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
