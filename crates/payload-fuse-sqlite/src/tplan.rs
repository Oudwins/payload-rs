//! Compiled read-transform plans: what `transform/read` (`traverseFields`) decides from a
//! collection's `flattenedFields` alone (keys, column prefixes, array tables, relationship paths,
//! value conversions), computed once per fields array of the engine's config graph instead of per
//! document.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use payload_engine::fields::{field_is_virtual, field_should_be_localized};
use payload_engine::js::JsVal;
use payload_engine::strings::to_snake_case;

pub struct TPlan {
  pub fields: Vec<TField>,
}

pub struct TField {
  /// `field.name`: the key of the result.
  pub name: Arc<str>,
  /// `${fieldPrefix}${field.name}`: the key read from the drizzle row.
  pub field_name: Arc<str>,
  /// Inside a group / named tab: the prefixed key is deleted from the row afterwards.
  pub prefixed: bool,
  pub kind: TKind,
}

pub enum TKind {
  /// Skipped by the transform (`fieldIsVirtual`).
  Virtual,
  /// `new Date(value).toISOString()` of strings.
  Date,
  /// `Number.parseFloat` of strings.
  Number,
  /// The value as decoded (text, select, checkbox, json, rich text, ...).
  Plain,
  /// A hasOne relationship to one collection (a column): `Number(value)` for number ids.
  Relationship { number_id: bool },
  /// `_rels` rows at `path` (relative to the nearest array row): `${relationTo}ID` values.
  HasMany { path: Arc<str>, key: Arc<str> },
  /// `_rels` rows at `path`: `{ relationTo, value }` (the first one for hasOne).
  Polymorphic { path: Arc<str>, has_many: bool },
  /// Rows of the array table; `path` (relative to the nearest array row) prefixes the
  /// relationship paths of the rows (`needs_path`).
  Array { path: Arc<str>, fields: Arc<TPlan>, needs_path: bool },
  Group { fields: TPlan },
}

impl TPlan {
  /// Whether a field of this plan reads `_rels` (directly or in groups, not in nested arrays).
  fn reads_relationships(&self) -> bool {
    self.fields.iter().any(|f| match &f.kind {
      TKind::HasMany { .. } | TKind::Polymorphic { .. } => true,
      TKind::Group { fields } => fields.reads_relationships(),
      TKind::Array { needs_path, .. } => *needs_path,
      _ => false,
    })
  }
}

struct Compile<'a> {
  table_name_map: &'a indexmap::IndexMap<String, String>,
  collections: &'a JsVal,
}

fn cache() -> &'static Mutex<HashMap<usize, Option<Arc<TPlan>>>> {
  static CACHE: OnceLock<Mutex<HashMap<usize, Option<Arc<TPlan>>>>> = OnceLock::new();
  CACHE.get_or_init(Default::default)
}

/// The plan of a collection's `flattenedFields` on `table_name`, `None` when a field is outside
/// the subset. Cached by the identity of `fields` (kept alive by the cache).
pub fn plan(
  fields: &JsVal,
  table_name: &str,
  table_name_map: &indexmap::IndexMap<String, String>,
  collections: &JsVal,
) -> Option<Arc<TPlan>> {
  static KEEP: OnceLock<Mutex<Vec<JsVal>>> = OnceLock::new();
  let id = fields.identity()?;
  if let Some(known) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&id) {
    return known.clone();
  }
  let compiled = Compile { table_name_map, collections }.fields(fields, "", "", "", table_name).map(Arc::new);
  KEEP.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner()).push(fields.clone());
  cache().lock().unwrap_or_else(|e| e.into_inner()).insert(id, compiled.clone());
  compiled
}

impl Compile<'_> {
  /// `rel_path`: the path of this level relative to the nearest array row (`''` at a row root).
  fn fields(&self, fields: &JsVal, prefix: &str, rel_path: &str, table_path: &str, current_table: &str) -> Option<TPlan> {
    let mut out = Vec::new();
    for field in fields.as_arr()?.iter() {
      let JsVal::Str(name) = field.get("name") else {
        if field_is_virtual(field) {
          continue;
        }
        return None;
      };
      let field_name: Arc<str> = Arc::from(format!("{prefix}{name}"));
      if field_is_virtual(field) {
        out.push(TField { name: name.clone(), field_name, prefixed: !prefix.is_empty(), kind: TKind::Virtual });
        continue;
      }
      if field_should_be_localized(field, false) || field.get("localized").truthy() {
        return None;
      }
      let path: Arc<str> = Arc::from(format!("{rel_path}{name}"));
      let kind = match field.get("type").as_str().unwrap_or("") {
        "array" => {
          if field.get("dbName").truthy() && field_name.len() > 63 {
            return None;
          }
          let table_key = format!("{current_table}_{table_path}{}", to_snake_case(name));
          let array_table = self.table_name_map.get(&table_key)?;
          let rows = self.fields(field.get("flattenedFields"), "", "", "", array_table)?;
          let needs_path = rows.reads_relationships();
          TKind::Array { path, fields: Arc::new(rows), needs_path }
        }
        "group" | "tab" => TKind::Group {
          fields: self.fields(
            field.get("flattenedFields"),
            &format!("{field_name}_"),
            &format!("{rel_path}{name}."),
            &format!("{table_path}{}_", to_snake_case(name)),
            current_table,
          )?,
        },
        "relationship" | "upload" => match field.get("relationTo") {
          JsVal::Str(relation_to) if field.get("hasMany").truthy() => {
            TKind::HasMany { path, key: Arc::from(format!("{relation_to}ID")) }
          }
          JsVal::Str(relation_to) => {
            let related = self.collections.get(relation_to);
            if related.is_nullish() {
              return None;
            }
            TKind::Relationship { number_id: related.get("customIDType").as_str() == Some("number") }
          }
          JsVal::Arr(slugs) if slugs.iter().all(|s| s.as_str().is_some()) => {
            TKind::Polymorphic { path, has_many: field.get("hasMany").truthy() }
          }
          _ => return None,
        },
        "text" | "number" | "select" if field.get("hasMany").truthy() => return None,
        "blocks" | "join" | "point" => return None,
        "date" => TKind::Date,
        "number" => TKind::Number,
        _ => TKind::Plain,
      };
      out.push(TField { name: name.clone(), field_name, prefixed: !prefix.is_empty(), kind });
    }
    Some(TPlan { fields: out })
  }
}

/// `new Date(s).toISOString()` for a string already in that form (24 characters,
/// `YYYY-MM-DDTHH:mm:ss.sssZ`, every component in range): the same string.
pub fn is_canonical_iso(s: &str) -> bool {
  let b = s.as_bytes();
  if b.len() != 24 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'.' || b[23] != b'Z' {
    return false;
  }
  let num = |range: std::ops::Range<usize>| -> Option<u32> {
    let mut n = 0u32;
    for &c in &b[range] {
      if !c.is_ascii_digit() {
        return None;
      }
      n = n * 10 + u32::from(c - b'0');
    }
    Some(n)
  };
  let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second), Some(_ms)) =
    (num(0..4), num(5..7), num(8..10), num(11..13), num(14..16), num(17..19), num(20..23))
  else {
    return false;
  };
  let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
  let days = match month {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
    4 | 6 | 9 | 11 => 30,
    2 if leap => 29,
    2 => 28,
    _ => return false,
  };
  (1..=days).contains(&day) && hour < 24 && minute < 60 && second < 60
}

#[cfg(test)]
mod tests {
  use super::is_canonical_iso;

  #[test]
  fn canonical_iso_strings() {
    assert!(is_canonical_iso("2024-02-29T23:59:59.999Z"));
    assert!(is_canonical_iso("1999-12-31T00:00:00.000Z"));
    assert!(!is_canonical_iso("2023-02-29T00:00:00.000Z"));
    assert!(!is_canonical_iso("2024-13-01T00:00:00.000Z"));
    assert!(!is_canonical_iso("2024-01-01T24:00:00.000Z"));
    assert!(!is_canonical_iso("2024-01-01 00:00:00.000Z"));
    assert!(!is_canonical_iso("2024-01-01T00:00:00Z"));
    assert!(!is_canonical_iso("+02024-01-01T00:00:00.000"));
  }
}
