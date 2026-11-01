//! String helpers that reproduce the npm packages and JS builtins Payload uses.

/// JS `\W`: anything except `[A-Za-z0-9_]`.
fn is_js_non_word(c: char) -> bool {
  !(c.is_ascii_alphanumeric() || c == '_')
}

/// JS `\s`.
fn is_js_space(c: char) -> bool {
  matches!(
    c,
    '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
      | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
  )
}

/// JS line terminators, not matched by `.`.
fn is_line_terminator(c: char) -> bool {
  matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `string.replace(/[\W_]+(.|$)/g, (m, next) => next ? ' ' + next : '')`
fn replace_separators(s: &str) -> String {
  let chars: Vec<char> = s.chars().collect();
  let mut out = String::with_capacity(s.len());
  let mut i = 0;
  while i < chars.len() {
    if is_js_non_word(chars[i]) || chars[i] == '_' {
      let mut j = i;
      while j < chars.len() && (is_js_non_word(chars[j]) || chars[j] == '_') {
        j += 1;
      }
      // The greedy run swallows line terminators (they are `\W`), so it is
      // followed either by a word char (matched by `.`) or by the end (`$`).
      if j < chars.len() {
        out.push(' ');
        out.push(chars[j]);
        i = j + 1;
      } else {
        i = j;
      }
    } else {
      out.push(chars[i]);
      i += 1;
    }
  }
  out
}

fn has_camel(s: &str) -> bool {
  let chars: Vec<char> = s.chars().collect();
  chars.windows(2).any(|w| {
    (w[0].is_ascii_lowercase() && w[1].is_ascii_uppercase()) || (w[0].is_ascii_uppercase() && w[1].is_ascii_lowercase())
  })
}

/// `string.replace(/(.)([A-Z]+)/g, (m, prev, uppers) => prev + ' ' + uppers.toLowerCase().split('').join(' '))`
fn uncamelize(s: &str) -> String {
  let chars: Vec<char> = s.chars().collect();
  let mut out = String::with_capacity(s.len() * 2);
  let mut i = 0;
  while i < chars.len() {
    if !is_line_terminator(chars[i]) && i + 1 < chars.len() && chars[i + 1].is_ascii_uppercase() {
      out.push(chars[i]);
      let mut j = i + 1;
      let mut uppers = Vec::new();
      while j < chars.len() && chars[j].is_ascii_uppercase() {
        uppers.push(chars[j].to_ascii_lowercase());
        j += 1;
      }
      out.push(' ');
      out.push_str(&uppers.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(" "));
      i = j;
    } else {
      out.push(chars[i]);
      i += 1;
    }
  }
  out
}

/// npm `to-no-case`
pub fn to_no_case(s: &str) -> String {
  if s.chars().any(is_js_space) {
    return s.to_lowercase();
  }
  if s.chars().any(|c| matches!(c, '_' | '-' | '.' | ':')) {
    let unseparated = replace_separators(s);
    return if unseparated.is_empty() { s.to_lowercase() } else { unseparated.to_lowercase() };
  }
  if has_camel(s) {
    return uncamelize(s).to_lowercase();
  }
  s.to_lowercase()
}

/// npm `to-space-case`
pub fn to_space_case(s: &str) -> String {
  replace_separators(&to_no_case(s)).trim_matches(is_js_space).to_string()
}

/// npm `to-snake-case`
pub fn to_snake_case(s: &str) -> String {
  to_space_case(s).chars().map(|c| if is_js_space(c) { '_' } else { c }).collect()
}

/// JS `string.length` (UTF-16 code units).
pub fn js_len(s: &str) -> usize {
  s.encode_utf16().count()
}

/// JS `string.slice(0, end)` in UTF-16 code units, as a Rust string: a surrogate pair cut in
/// half leaves a lone surrogate, which a Rust string cannot hold, so it becomes U+FFFD. Use
/// [`js_slice_to_units`] for the exact JS result.
pub fn js_slice_to(s: &str, end: usize) -> String {
  String::from_utf16_lossy(&js_slice_to_units(s, end))
}

/// JS `string.slice(0, end)` as the exact UTF-16 code units (may end with a lone surrogate).
pub fn js_slice_to_units(s: &str, end: usize) -> Vec<u16> {
  s.encode_utf16().take(end).collect()
}

/// Whether `units` is not valid UTF-16 (contains a surrogate that is not part of a pair).
pub fn has_lone_surrogate(units: &[u16]) -> bool {
  char::decode_utf16(units.iter().copied()).any(|c| c.is_err())
}

/// `JSON.stringify`-compatible text for `value`, where every string (object key or value) found in
/// `exact` is written as its exact UTF-16 code units instead (lone surrogates as `\uXXXX`
/// escapes, which `JSON.parse` turns back into lone surrogates).
///
/// This carries JS strings that a Rust `String` cannot hold (see [`js_slice_to`]) across the JSON
/// boundary: `exact` maps the lossy Rust string to the JS string's code units.
pub fn json_to_string_with_utf16(value: &serde_json::Value, exact: &std::collections::HashMap<String, Vec<u16>>) -> String {
  if exact.is_empty() {
    return value.to_string();
  }
  let mut out = String::new();
  write_json(value, exact, &mut out);
  out
}

fn write_json_string(s: &str, exact: &std::collections::HashMap<String, Vec<u16>>, out: &mut String) {
  let Some(units) = exact.get(s) else {
    out.push_str(&serde_json::Value::String(s.to_string()).to_string());
    return;
  };
  out.push('"');
  for unit in char::decode_utf16(units.iter().copied()) {
    match unit {
      Ok(c) => {
        let encoded = serde_json::Value::String(c.to_string()).to_string();
        out.push_str(&encoded[1..encoded.len() - 1]);
      }
      Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
    }
  }
  out.push('"');
}

fn write_json(value: &serde_json::Value, exact: &std::collections::HashMap<String, Vec<u16>>, out: &mut String) {
  match value {
    serde_json::Value::String(s) => write_json_string(s, exact, out),
    serde_json::Value::Array(items) => {
      out.push('[');
      for (i, item) in items.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        write_json(item, exact, out);
      }
      out.push(']');
    }
    serde_json::Value::Object(entries) => {
      out.push('{');
      for (i, (key, item)) in entries.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        write_json_string(key, exact, out);
        out.push(':');
        write_json(item, exact, out);
      }
      out.push('}');
    }
    other => out.push_str(&other.to_string()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn snake_case_matches_npm() {
    assert_eq!(to_snake_case("camelCase"), "camel_case");
    assert_eq!(to_snake_case("myFieldID"), "my_field_i_d");
    assert_eq!(to_snake_case("my-collection"), "my_collection");
    assert_eq!(to_snake_case("_status"), "status");
    assert_eq!(to_snake_case("payload-preferences"), "payload_preferences");
    assert_eq!(to_snake_case("Title"), "title");
    assert_eq!(to_snake_case("title"), "title");
    assert_eq!(to_snake_case("a.b"), "a_b");
    assert_eq!(to_snake_case("ABC"), "abc");
    assert_eq!(to_snake_case("field1"), "field1");
    assert_eq!(to_snake_case("enum_posts_"), "enum_posts");
  }

  #[test]
  fn slices_keep_lone_surrogates() {
    let name = "ab\u{1F600}c";
    assert_eq!(js_slice_to_units(name, 3), vec![0x61, 0x62, 0xD83D]);
    assert!(has_lone_surrogate(&js_slice_to_units(name, 3)));
    assert!(!has_lone_surrogate(&js_slice_to_units(name, 4)));
    assert_eq!(js_slice_to(name, 3), "ab\u{FFFD}");
    let lossy = format!("{}_idx", js_slice_to(name, 3));
    let mut units = js_slice_to_units(name, 3);
    units.extend("_idx".encode_utf16());
    let exact = std::collections::HashMap::from([(lossy.clone(), units)]);
    let value = serde_json::json!({ lossy.clone(): { "name": lossy, "other": "x\"\u{1F600}" } });
    assert_eq!(
      json_to_string_with_utf16(&value, &exact),
      r#"{"ab\ud83d_idx":{"name":"ab\ud83d_idx","other":"x\"😀"}}"#
    );
    assert_eq!(json_to_string_with_utf16(&value, &Default::default()), value.to_string());
  }
}
