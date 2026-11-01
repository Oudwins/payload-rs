//! JS string values, including ill-formed UTF-16 (lone surrogates).
//!
//! JS strings are sequences of UTF-16 code units and may contain unpaired
//! surrogates (e.g. a truncated emoji `"a\ud83d"`), which Rust `str` cannot
//! hold. [`JsStr`] stores well-formed strings as UTF-8 and ill-formed strings
//! as their UTF-16 code units. The representation is canonical (a string is
//! `Utf16` if and only if it contains a lone surrogate), so equality and hashing
//! are plain code-unit equality, exactly like JS `===`.
//!
//! At the JSON boundary lone surrogates appear as `\udXXX` escapes (what
//! `JSON.stringify` emits); [`crate::json`] decodes and re-emits them so they
//! round-trip unchanged.

use std::borrow::Cow;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

#[derive(Clone)]
pub enum JsStr {
  /// Well-formed string.
  Utf8(Rc<str>),
  /// String containing at least one lone surrogate (never well-formed).
  Utf16(Rc<[u16]>),
}

/// A borrowed property key (`&str` for well-formed keys, code units otherwise).
#[derive(Clone, Copy, Debug)]
pub enum KeyRef<'a> {
  Utf8(&'a str),
  Utf16(&'a [u16]),
}

impl JsStr {
  pub fn from_units(units: &[u16]) -> Self {
    match String::from_utf16(units) {
      Ok(s) => JsStr::Utf8(Rc::from(s)),
      Err(_) => JsStr::Utf16(Rc::from(units)),
    }
  }

  /// The string as `&str` when it is well-formed.
  pub fn as_str(&self) -> Option<&str> {
    match self {
      JsStr::Utf8(s) => Some(s),
      JsStr::Utf16(_) => None,
    }
  }

  /// UTF-8 with every lone surrogate replaced by U+FFFD.
  pub fn to_lossy(&self) -> Cow<'_, str> {
    match self {
      JsStr::Utf8(s) => Cow::Borrowed(s),
      JsStr::Utf16(u) => Cow::Owned(String::from_utf16_lossy(u)),
    }
  }

  pub fn units(&self) -> Cow<'_, [u16]> {
    match self {
      JsStr::Utf8(s) => Cow::Owned(s.encode_utf16().collect()),
      JsStr::Utf16(u) => Cow::Borrowed(u),
    }
  }

  /// `string.length`
  pub fn utf16_len(&self) -> usize {
    match self {
      JsStr::Utf8(s) => s.encode_utf16().count(),
      JsStr::Utf16(u) => u.len(),
    }
  }

  pub fn is_empty(&self) -> bool {
    match self {
      JsStr::Utf8(s) => s.is_empty(),
      JsStr::Utf16(u) => u.is_empty(),
    }
  }

  pub fn key(&self) -> KeyRef<'_> {
    match self {
      JsStr::Utf8(s) => KeyRef::Utf8(s),
      JsStr::Utf16(u) => KeyRef::Utf16(u),
    }
  }

  /// `string.startsWith(prefix)`
  pub fn starts_with(&self, prefix: &str) -> bool {
    match self {
      JsStr::Utf8(s) => s.starts_with(prefix),
      JsStr::Utf16(u) => {
        let p: Vec<u16> = prefix.encode_utf16().collect();
        u.starts_with(&p)
      }
    }
  }

  /// `string.replace(pattern, replacement)` with a string pattern (first occurrence only).
  pub fn replace_first(&self, pattern: &str, replacement: &str) -> JsStr {
    match self {
      JsStr::Utf8(s) => JsStr::from(s.replacen(pattern, replacement, 1).as_str()),
      JsStr::Utf16(u) => {
        let p: Vec<u16> = pattern.encode_utf16().collect();
        let pos = if p.is_empty() { Some(0) } else { u.windows(p.len()).position(|w| w == p.as_slice()) };
        match pos {
          None => self.clone(),
          Some(i) => {
            let mut out = u[..i].to_vec();
            out.extend(replacement.encode_utf16());
            out.extend_from_slice(&u[i + p.len()..]);
            JsStr::from_units(&out)
          }
        }
      }
    }
  }

  /// `string.split(separator)` for a single (BMP) character separator.
  pub fn split(&self, separator: char) -> Vec<JsStr> {
    match self {
      JsStr::Utf8(s) => s.split(separator).map(JsStr::from).collect(),
      JsStr::Utf16(u) => {
        let mut buf = [0u16; 2];
        let sep = separator.encode_utf16(&mut buf)[0];
        u.split(|c| *c == sep).map(JsStr::from_units).collect()
      }
    }
  }

  /// String concatenation (joins surrogate halves into pairs, like JS).
  pub fn concat<'a>(parts: impl IntoIterator<Item = &'a JsStr>) -> JsStr {
    let parts: Vec<&JsStr> = parts.into_iter().collect();
    if parts.iter().all(|p| matches!(p, JsStr::Utf8(_))) {
      let mut s = String::new();
      for p in parts {
        s.push_str(p.as_str().unwrap_or_default());
      }
      return JsStr::from(s.as_str());
    }
    let mut units = Vec::new();
    for p in parts {
      units.extend_from_slice(&p.units());
    }
    JsStr::from_units(&units)
  }
}

impl Default for JsStr {
  fn default() -> Self {
    JsStr::Utf8(Rc::from(""))
  }
}

impl From<&str> for JsStr {
  fn from(s: &str) -> Self {
    JsStr::Utf8(Rc::from(s))
  }
}

impl From<String> for JsStr {
  fn from(s: String) -> Self {
    JsStr::Utf8(Rc::from(s))
  }
}

impl PartialEq for JsStr {
  fn eq(&self, other: &Self) -> bool {
    match (self, other) {
      (JsStr::Utf8(a), JsStr::Utf8(b)) => a == b,
      (JsStr::Utf16(a), JsStr::Utf16(b)) => a == b,
      // Canonical representation: a well-formed and an ill-formed string are never equal.
      _ => false,
    }
  }
}

impl Eq for JsStr {}

impl Hash for JsStr {
  fn hash<H: Hasher>(&self, state: &mut H) {
    self.key().hash(state);
  }
}

impl fmt::Debug for JsStr {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      JsStr::Utf8(s) => write!(f, "{s:?}"),
      JsStr::Utf16(u) => write!(f, "utf16{u:x?}"),
    }
  }
}

impl fmt::Display for JsStr {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(&self.to_lossy())
  }
}

impl<'a> From<&'a str> for KeyRef<'a> {
  fn from(s: &'a str) -> Self {
    KeyRef::Utf8(s)
  }
}

impl<'a> From<&'a String> for KeyRef<'a> {
  fn from(s: &'a String) -> Self {
    KeyRef::Utf8(s)
  }
}

impl<'a> From<&'a JsStr> for KeyRef<'a> {
  fn from(s: &'a JsStr) -> Self {
    s.key()
  }
}

impl KeyRef<'_> {
  pub fn to_js_str(self) -> JsStr {
    match self {
      KeyRef::Utf8(s) => JsStr::from(s),
      KeyRef::Utf16(u) => JsStr::from_units(u),
    }
  }

  pub fn is(self, s: &str) -> bool {
    matches!(self, KeyRef::Utf8(k) if k == s)
  }

  pub fn to_lossy(self) -> String {
    match self {
      KeyRef::Utf8(s) => s.to_string(),
      KeyRef::Utf16(u) => String::from_utf16_lossy(u),
    }
  }
}

impl Hash for KeyRef<'_> {
  fn hash<H: Hasher>(&self, state: &mut H) {
    match self {
      KeyRef::Utf8(s) => s.hash(state),
      KeyRef::Utf16(u) => {
        state.write_u8(0xfe);
        u.hash(state);
      }
    }
  }
}

impl indexmap::Equivalent<JsStr> for KeyRef<'_> {
  fn equivalent(&self, key: &JsStr) -> bool {
    match (self, key) {
      (KeyRef::Utf8(a), JsStr::Utf8(b)) => *a == &**b,
      (KeyRef::Utf16(a), JsStr::Utf16(b)) => *a == &**b,
      _ => false,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn canonical_and_lossless() {
    let lone = JsStr::from_units(&[0x61, 0xd83d]);
    assert!(matches!(lone, JsStr::Utf16(_)));
    assert_eq!(lone.utf16_len(), 2);
    let pair = JsStr::from_units(&[0xd83d, 0xde00]);
    assert_eq!(pair.as_str(), Some("😀"));
    let joined = JsStr::concat([&JsStr::from_units(&[0xd83d]), &JsStr::from_units(&[0xde00])]);
    assert_eq!(joined, pair);
    assert_eq!(lone.replace_first("a", "b").units().as_ref(), &[0x62, 0xd83d]);
  }
}
