//! A single-pass JSON scanner for values the direct writer splices into its output as they are
//! stored (json and rich text columns): it accepts exactly the texts `JSON.parse` accepts, and
//! for lexical rich text it follows the traversal of lexical's `afterRead` hook
//! (`value?.root?.children ?? []`, then `recurseNodeTree`), reporting a node whose `type` is in the
//! active set or a shape on which the hook would throw.

use std::collections::HashSet;

#[derive(Debug, PartialEq, Eq)]
pub enum Scan {
  /// Valid JSON; the lexical traversal (if requested) finds nothing to do.
  Inert,
  /// Valid JSON with a node the hook works on, or a shape it throws on.
  Active,
  /// Not valid JSON (`JSON.parse` throws).
  Invalid,
}

/// Scans `text`; `active` = lexical node types with node hooks or sub fields (`None`: plain JSON).
pub fn scan(text: &str, active: Option<&HashSet<String>>) -> Scan {
  let mut s = Scanner { b: text.as_bytes(), i: 0, active, found: false };
  s.ws();
  let role = if active.is_some() { Role::Value } else { Role::Plain };
  if s.value(role, 0).is_err() {
    return Scan::Invalid;
  }
  s.ws();
  if s.i != s.b.len() {
    return Scan::Invalid;
  }
  if s.found { Scan::Active } else { Scan::Inert }
}

/// What a value is in the lexical traversal.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
  /// Not visited by the traversal.
  Plain,
  /// The field value (`value?.root`).
  Value,
  /// `value.root` (`root?.children`).
  Root,
  /// `root.children`: the top-level nodes (`nodes?.length`, then `for...of`).
  TopNodes,
  /// An array of nodes reached through `node.children` (`Array.isArray` checked).
  Nodes,
  /// A node (`'children' in node`, `node.type`).
  Node,
}

struct Scanner<'a> {
  b: &'a [u8],
  i: usize,
  active: Option<&'a HashSet<String>>,
  /// An active node type or a throwing shape was seen.
  found: bool,
}

const MAX_DEPTH: usize = 512;

impl Scanner<'_> {
  fn ws(&mut self) {
    while let Some(&c) = self.b.get(self.i) {
      if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
        self.i += 1;
      } else {
        break;
      }
    }
  }

  fn peek(&self) -> Option<u8> {
    self.b.get(self.i).copied()
  }

  fn eat(&mut self, c: u8) -> Result<(), ()> {
    if self.peek() == Some(c) {
      self.i += 1;
      Ok(())
    } else {
      Err(())
    }
  }

  fn literal(&mut self, word: &[u8]) -> Result<(), ()> {
    if self.b[self.i..].starts_with(word) {
      self.i += word.len();
      Ok(())
    } else {
      Err(())
    }
  }

  /// A value in `role`; a node (or top-level node) that is not an object makes the hook throw.
  fn value(&mut self, role: Role, depth: usize) -> Result<(), ()> {
    if depth > MAX_DEPTH {
      return Err(());
    }
    let is_node = role == Role::Node;
    // `root.children` other than an array or null: `nodes?.length` / `for...of` may iterate or
    // throw (strings, objects with a `length`); conservative
    if role == Role::TopNodes && !matches!(self.peek(), Some(b'[' | b'n')) {
      self.found = true;
    }
    match self.peek().ok_or(())? {
      b'{' => self.object(role, depth),
      b'[' => {
        match role {
          // `for...of` over the top-level nodes / `node.children` arrays
          Role::TopNodes | Role::Nodes => self.array(Role::Node, depth),
          // an array as the node itself: `'children' in node` is fine on arrays, `node.type`
          // undefined; its own elements are not visited
          _ => self.array(Role::Plain, depth),
        }
      }
      b'"' => {
        self.string()?;
        // `'children' in node` throws for a string node
        if is_node {
          self.found = true;
        }
        Ok(())
      }
      b't' => self.literal(b"true").map(|()| self.primitive_node(is_node)),
      b'f' => self.literal(b"false").map(|()| self.primitive_node(is_node)),
      b'n' => self.literal(b"null").map(|()| self.primitive_node(is_node)),
      _ => self.number().map(|()| self.primitive_node(is_node)),
    }
  }

  /// `'children' in node` throws for primitives (and `null`).
  fn primitive_node(&mut self, is_node: bool) {
    if is_node {
      self.found = true;
    }
  }

  fn object(&mut self, role: Role, depth: usize) -> Result<(), ()> {
    self.eat(b'{')?;
    self.ws();
    if self.peek() == Some(b'}') {
      self.i += 1;
      return Ok(());
    }
    // duplicate keys that matter to the traversal: the last one wins in JSON.parse; treat a
    // repeated `root` / `children` / `type` as active (rare, conservative)
    let mut seen_children = false;
    let mut seen_root = false;
    let mut seen_type = false;
    loop {
      self.ws();
      let key_start = self.i;
      self.string()?;
      let key = &self.b[key_start..self.i];
      self.ws();
      self.eat(b':')?;
      self.ws();
      let child = match (role, key) {
        (Role::Value, b"\"root\"") => {
          if seen_root {
            self.found = true;
          }
          seen_root = true;
          Role::Root
        }
        (Role::Root, b"\"children\"") => {
          if seen_children {
            self.found = true;
          }
          seen_children = true;
          Role::TopNodes
        }
        (Role::Node, b"\"children\"") => {
          if seen_children {
            self.found = true;
          }
          seen_children = true;
          Role::Nodes
        }
        (Role::Node, b"\"type\"") => {
          if seen_type {
            self.found = true;
          }
          seen_type = true;
          let value_start = self.i;
          if self.peek() == Some(b'"') {
            self.string()?;
            let raw = &self.b[value_start..self.i];
            if self.is_active_type(raw) {
              self.found = true;
            }
          } else {
            self.value(Role::Plain, depth + 1)?;
          }
          self.ws();
          if self.after_member()? {
            return Ok(());
          }
          continue;
        }
        _ => Role::Plain,
      };
      // `node.children` that is not an array is not recursed into (`Array.isArray`)
      let child = if child == Role::Nodes && self.peek() != Some(b'[') { Role::Plain } else { child };
      self.value(child, depth + 1)?;
      self.ws();
      if self.after_member()? {
        return Ok(());
      }
    }
  }

  /// After a member: `,` (more) or `}` (done).
  fn after_member(&mut self) -> Result<bool, ()> {
    match self.peek() {
      Some(b',') => {
        self.i += 1;
        Ok(false)
      }
      Some(b'}') => {
        self.i += 1;
        Ok(true)
      }
      _ => Err(()),
    }
  }

  fn array(&mut self, item_role: Role, depth: usize) -> Result<(), ()> {
    self.eat(b'[')?;
    self.ws();
    if self.peek() == Some(b']') {
      self.i += 1;
      return Ok(());
    }
    loop {
      self.ws();
      self.value(item_role, depth + 1)?;
      self.ws();
      match self.peek() {
        Some(b',') => self.i += 1,
        Some(b']') => {
          self.i += 1;
          return Ok(());
        }
        _ => return Err(()),
      }
    }
  }

  /// A JSON string; `self.i` ends after the closing quote.
  fn string(&mut self) -> Result<(), ()> {
    self.eat(b'"')?;
    loop {
      let c = self.peek().ok_or(())?;
      self.i += 1;
      match c {
        b'"' => return Ok(()),
        b'\\' => {
          let e = self.peek().ok_or(())?;
          self.i += 1;
          match e {
            b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {}
            b'u' => {
              for _ in 0..4 {
                if !self.peek().is_some_and(|h| h.is_ascii_hexdigit()) {
                  return Err(());
                }
                self.i += 1;
              }
            }
            _ => return Err(()),
          }
        }
        0..=0x1f => return Err(()),
        _ => {}
      }
    }
  }

  fn number(&mut self) -> Result<(), ()> {
    if self.peek() == Some(b'-') {
      self.i += 1;
    }
    match self.peek() {
      Some(b'0') => self.i += 1,
      Some(b'1'..=b'9') => {
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
          self.i += 1;
        }
      }
      _ => return Err(()),
    }
    if self.peek() == Some(b'.') {
      self.i += 1;
      if !self.peek().is_some_and(|c| c.is_ascii_digit()) {
        return Err(());
      }
      while self.peek().is_some_and(|c| c.is_ascii_digit()) {
        self.i += 1;
      }
    }
    if matches!(self.peek(), Some(b'e' | b'E')) {
      self.i += 1;
      if matches!(self.peek(), Some(b'+' | b'-')) {
        self.i += 1;
      }
      if !self.peek().is_some_and(|c| c.is_ascii_digit()) {
        return Err(());
      }
      while self.peek().is_some_and(|c| c.is_ascii_digit()) {
        self.i += 1;
      }
    }
    Ok(())
  }

  /// Whether the raw JSON string `raw` (quotes included) names an active node type. Escaped
  /// strings are treated as active (conservative).
  fn is_active_type(&self, raw: &[u8]) -> bool {
    let Some(active) = self.active else { return false };
    let inner = &raw[1..raw.len() - 1];
    if inner.contains(&b'\\') {
      return true;
    }
    std::str::from_utf8(inner).map_or(true, |t| active.contains(t))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn validates_like_json_parse() {
    for ok in ["{}", "[]", "1", "-0.5e+3", "\"a\\u00e9\"", " {\"a\" : [1, true, null, {\"b\":\"c\"}]} ", "0"] {
      assert_eq!(scan(ok, None), Scan::Inert, "{ok}");
    }
    for bad in ["", "{", "[1,]", "01", "1.", "\"\t\"", "{'a':1}", "tru", "NaN", "1 2", "{\"a\":1,}", "\"\\x\""] {
      assert_eq!(scan(bad, None), Scan::Invalid, "{bad}");
    }
  }

  #[test]
  fn follows_the_lexical_traversal() {
    let active = set(&["upload", "link"]);
    let doc = r#"{"root":{"type":"root","children":[{"type":"paragraph","children":[{"type":"text","text":"upload"}]}]}}"#;
    assert_eq!(scan(doc, Some(&active)), Scan::Inert);
    let doc = r#"{"root":{"children":[{"type":"paragraph","children":[{"type":"link","children":[]}]}]}}"#;
    assert_eq!(scan(doc, Some(&active)), Scan::Active);
    // `fields.type` is not a node type
    let doc = r#"{"root":{"children":[{"type":"paragraph","fields":{"type":"upload"}}]}}"#;
    assert_eq!(scan(doc, Some(&active)), Scan::Inert);
    // a primitive node throws in the hook
    assert_eq!(scan(r#"{"root":{"children":[1]}}"#, Some(&active)), Scan::Active);
    assert_eq!(scan(r#"{"root":{"children":"ab"}}"#, Some(&active)), Scan::Active);
    assert_eq!(scan(r#"{"root":{"children":{"length":1}}}"#, Some(&active)), Scan::Active);
    assert_eq!(scan(r#"{"root":{"children":null}}"#, Some(&active)), Scan::Inert);
    assert_eq!(scan("null", Some(&active)), Scan::Inert);
    assert_eq!(scan(r#""text""#, Some(&active)), Scan::Inert);
  }
}

/// Whether valid JSON `text` is exactly `JSON.stringify(JSON.parse(text))`: no whitespace, numbers
/// as `Number::toString` (no `-0`), strings with only the escapes `JSON.stringify` writes, objects
/// without repeated or integer-like keys.
pub fn is_canonical(text: &str) -> bool {
  let mut c = Canonical { b: text.as_bytes(), s: text, i: 0 };
  c.value(0).is_some() && c.i == c.b.len()
}

struct Canonical<'a> {
  b: &'a [u8],
  s: &'a str,
  i: usize,
}

impl Canonical<'_> {
  fn value(&mut self, depth: usize) -> Option<()> {
    if depth > MAX_DEPTH {
      return None;
    }
    match *self.b.get(self.i)? {
      b'{' => {
        self.i += 1;
        if self.b.get(self.i) == Some(&b'}') {
          self.i += 1;
          return Some(());
        }
        let mut keys: Vec<&str> = Vec::new();
        loop {
          let start = self.i;
          self.string()?;
          let key = &self.s[start + 1..self.i - 1];
          if key.contains('\\') || payload_fuse::write::is_array_index_key(key) || keys.contains(&key) {
            return None;
          }
          keys.push(key);
          if self.b.get(self.i) != Some(&b':') {
            return None;
          }
          self.i += 1;
          self.value(depth + 1)?;
          match *self.b.get(self.i)? {
            b',' => self.i += 1,
            b'}' => {
              self.i += 1;
              return Some(());
            }
            _ => return None,
          }
        }
      }
      b'[' => {
        self.i += 1;
        if self.b.get(self.i) == Some(&b']') {
          self.i += 1;
          return Some(());
        }
        loop {
          self.value(depth + 1)?;
          match *self.b.get(self.i)? {
            b',' => self.i += 1,
            b']' => {
              self.i += 1;
              return Some(());
            }
            _ => return None,
          }
        }
      }
      b'"' => self.string(),
      b't' => self.word("true"),
      b'f' => self.word("false"),
      b'n' => self.word("null"),
      _ => self.number(),
    }
  }

  fn word(&mut self, word: &str) -> Option<()> {
    self.s[self.i..].starts_with(word).then(|| self.i += word.len())
  }

  fn number(&mut self) -> Option<()> {
    let start = self.i;
    while self.b.get(self.i).is_some_and(|c| matches!(c, b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')) {
      self.i += 1;
    }
    let literal = &self.s[start..self.i];
    // JSON grammar (a bare `1e+21` is valid JSON; `.5`, `01`, `1.` are not)
    let mut probe = Scanner { b: literal.as_bytes(), i: 0, active: None, found: false };
    if probe.number().is_err() || probe.i != literal.len() {
      return None;
    }
    let n = literal.parse::<f64>().ok()?;
    if !n.is_finite() || (n == 0.0 && n.is_sign_negative()) {
      return None;
    }
    (payload_engine::js::num_to_js_string(n) == literal).then_some(())
  }

  /// A string with `JSON.stringify`'s escaping only.
  fn string(&mut self) -> Option<()> {
    if self.b.get(self.i) != Some(&b'"') {
      return None;
    }
    self.i += 1;
    loop {
      match *self.b.get(self.i)? {
        b'"' => {
          self.i += 1;
          return Some(());
        }
        b'\\' => {
          self.i += 1;
          match *self.b.get(self.i)? {
            b'"' | b'\\' | b'b' | b'f' | b'n' | b'r' | b't' => self.i += 1,
            b'u' => {
              let hex = self.s.get(self.i + 1..self.i + 5)?;
              // `\u00xx` (lowercase) for the other control characters only
              let unit = u32::from_str_radix(hex, 16).ok()?;
              let control = unit < 0x20 && !matches!(unit, 0x08 | 0x09 | 0x0a | 0x0c | 0x0d);
              if !control || hex.bytes().any(|b| b.is_ascii_uppercase()) {
                return None;
              }
              self.i += 5;
            }
            _ => return None,
          }
        }
        0..=0x1f => return None,
        _ => self.i += 1,
      }
    }
  }
}

#[cfg(test)]
mod canonical_tests {
  use super::is_canonical;

  #[test]
  fn canonical_texts() {
    for ok in ["{}", "[]", "0", "-1.5", "1e+21", "1e-7", r#"{"a":[1,"x\n\u001f",null,true]}"#, r#""é/""#] {
      assert!(is_canonical(ok), "{ok}");
    }
    for bad in [" {}", "{ }", "-0", "1.0", "1E21", "100000000000000000000000", r#""\/""#, "\"\\u0041\"",r#""\u001F""#, r#"{"a":1,"a":2}"#, r#"{"1":1}"#, "[1, 2]"] {
      assert!(!is_canonical(bad), "{bad}");
    }
  }
}
