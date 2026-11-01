//! Ports of the leaf transforms:
//! `relationships.ts`, `selects.ts`, `texts.ts`, `numbers.ts`,
//! `utilities/validateExistingBlockIsIdentical.ts#resolveBlockTableName`
//! and `payload/shared#valueIsValueWithRelation`.

use payload_engine::js::{JsVal, Obj};

use crate::adapter::WriteAdapter;
use crate::js::{js_insert, to_js_string};

fn order(i: usize) -> JsVal {
  JsVal::Num((i + 1) as f64)
}

pub(crate) fn locale_val(locale: Option<&str>) -> JsVal {
  locale.map(JsVal::str).unwrap_or(JsVal::Undefined)
}

/// `if (locale)` for an optional locale string.
pub(crate) fn locale_truthy(locale: Option<&str>) -> bool {
  locale.is_some_and(|l| !l.is_empty())
}

/// `valueIsValueWithRelation`
pub(crate) fn value_is_value_with_relation(value: &JsVal) -> bool {
  matches!(value, JsVal::Obj(o) if o.contains_key("relationTo") && o.contains_key("value"))
}

/// `transformRelationship` (relationships.ts)
pub(crate) fn transform_relationship(base_row: &Obj, data: &JsVal, field: &JsVal, relationships: &mut Vec<Obj>) {
  let relations: Vec<JsVal> = match data {
    JsVal::Arr(a) => a.to_vec(),
    other => vec![other.clone()],
  };
  let relation_to = field.get("relationTo");
  let has_many = field.has("hasMany") && field.get("hasMany").truthy();

  for (i, relation) in relations.into_iter().enumerate() {
    if !relation.truthy() {
      continue;
    }
    let mut relation_row = base_row.clone();
    if has_many {
      js_insert(&mut relation_row, "order", order(i));
    }

    if matches!(relation_to, JsVal::Arr(_)) && value_is_value_with_relation(&relation) {
      let key = format!("{}ID", to_js_string(relation.get("relationTo")));
      js_insert(&mut relation_row, key, relation.get("value").clone());
      relationships.push(relation_row);
    } else if let Some(relation_to) = relation_to.as_str() {
      js_insert(&mut relation_row, format!("{relation_to}ID"), relation);
      relationships.push(relation_row);
    }
  }
}

/// `transformSelects` (selects.ts)
pub(crate) fn transform_selects(id: &JsVal, data: &JsVal, locale: Option<&str>) -> Vec<Obj> {
  data
    .items()
    .enumerate()
    .map(|(i, value)| {
      let mut row = Obj::new();
      row.insert("order".into(), order(i));
      row.insert("parent".into(), id.clone());
      row.insert("value".into(), value.clone());
      if locale_truthy(locale) {
        row.insert("locale".into(), locale_val(locale));
      }
      row
    })
    .collect()
}

/// `transformTexts` (texts.ts)
pub(crate) fn transform_texts(base_row: &Obj, data: &[JsVal], texts: &mut Vec<Obj>) {
  for (i, val) in data.iter().enumerate() {
    let mut row = base_row.clone();
    js_insert(&mut row, "order", order(i));
    js_insert(&mut row, "text", val.clone());
    texts.push(row);
  }
}

/// `transformNumbers` (numbers.ts)
pub(crate) fn transform_numbers(base_row: &Obj, data: &[JsVal], numbers: &mut Vec<Obj>) {
  for (i, val) in data.iter().enumerate() {
    let mut row = base_row.clone();
    js_insert(&mut row, "number", val.clone());
    js_insert(&mut row, "order", order(i));
    numbers.push(row);
  }
}

/// `resolveBlockTableName(block, originalTableName)`. A missing original name
/// is `undefined` in TS and renders as `"undefined"` here.
pub(crate) fn resolve_block_table_name(adapter: &dyn WriteAdapter, block: &JsVal, original: Option<&str>) -> String {
  let original = original.unwrap_or("undefined");
  match adapter.block_table_name_index(block) {
    Some(index) if index != 0 => format!("{original}_{index}"),
    _ => original.to_string(),
  }
}
