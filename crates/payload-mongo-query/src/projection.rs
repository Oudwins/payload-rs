//! `buildProjectionFromSelect` (utilities/buildProjectionFromSelect.ts). The TS mutates its deep
//! copy of `select` while traversing (`fieldSelect.id = true`, `blocksSelect[slug] = {}`), so the
//! copy is a mutable tree here.

use indexmap::IndexMap;
use payload_engine::error::Result;
use payload_engine::fields::{field_affects_data, field_should_be_localized};
use payload_engine::js::JsVal;

use crate::QueryCx;
use crate::js::{JsObj, get, is_array_index, set_on_primitive_error, template, unsupported};

/// `deepCopyObjectSimple(select)`: plain objects are copied (and stay mutable), other values kept.
#[derive(Clone, Debug)]
enum Sel {
  Obj(IndexMap<String, Sel>),
  Val(JsVal),
}

impl Sel {
  fn copy(cx: &QueryCx, v: &JsVal) -> Result<Sel> {
    Ok(match v {
      JsVal::Obj(o) if crate::js::is_plain_object(v) => {
        let _depth = cx.enter()?;
        let mut out = IndexMap::new();
        for (k, item) in o.iter() {
          out.insert(k.clone(), Sel::copy(cx, item)?);
        }
        Sel::Obj(out)
      }
      // `ObjectId`s become their hex string, like `deepCopyObjectSimple`
      _ if v.is_object_id() => Sel::Val(JsVal::str(v.object_id_hex().unwrap_or_default())),
      other => Sel::Val(other.clone()),
    })
  }

  /// `select[key]`
  fn read(&self, key: &str) -> Result<Sel> {
    match self {
      Sel::Obj(o) => Ok(o.get(key).cloned().unwrap_or(Sel::Val(JsVal::Undefined))),
      Sel::Val(v) => get(v, key).map(Sel::Val),
    }
  }

  fn get_mut(&mut self, key: &str) -> Option<&mut Sel> {
    match self {
      Sel::Obj(o) => o.get_mut(key),
      Sel::Val(_) => None,
    }
  }

  /// `select[key] = value`
  fn set(&mut self, key: &str, value: Sel) -> Result<()> {
    match self {
      Sel::Obj(o) => {
        o.insert(key.to_owned(), value);
        Ok(())
      }
      Sel::Val(v @ (JsVal::Arr(_) | JsVal::Obj(_))) => {
        let _ = v;
        Err(unsupported("setting a property on a non-plain select value"))
      }
      Sel::Val(v) => Err(set_on_primitive_error(v, key)),
    }
  }

  fn is_true(&self) -> bool {
    matches!(self, Sel::Val(JsVal::Bool(true)))
  }

  fn is_false(&self) -> bool {
    matches!(self, Sel::Val(JsVal::Bool(false)))
  }

  fn is_undefined(&self) -> bool {
    matches!(self, Sel::Val(JsVal::Undefined))
  }

  fn truthy(&self) -> bool {
    match self {
      Sel::Obj(_) => true,
      Sel::Val(v) => v.truthy(),
    }
  }

  /// `typeof value === 'object'` (`null` included)
  fn is_object_type(&self) -> bool {
    match self {
      Sel::Obj(_) => true,
      Sel::Val(v) => v.type_of() == "object",
    }
  }
}

/// `getSelectMode(select)`
fn get_select_mode(cx: &QueryCx, select: &Sel) -> Result<&'static str> {
  let _depth = cx.enter()?;
  let entries: Vec<Sel> = match select {
    Sel::Obj(o) => {
      // for-in order: array-index keys first
      let mut keys: Vec<&String> = o.keys().collect();
      keys.sort_by_key(|k| if is_array_index(k) { (0, k.parse::<u64>().unwrap_or(0)) } else { (1, 0) });
      keys.into_iter().map(|k| o[k].clone()).collect()
    }
    Sel::Val(JsVal::Arr(a)) => a.iter().map(|v| Sel::copy(cx, v)).collect::<Result<_>>()?,
    Sel::Val(_) => Vec::new(),
  };
  for value in &entries {
    if value.is_false() {
      return Ok("exclude");
    }
    if value.is_object_type() {
      return get_select_mode(cx, value);
    }
  }
  Ok("include")
}

fn add_field_to_projection(
  cx: &QueryCx,
  database_schema_path: &str,
  field: &JsVal,
  parent_is_localized: bool,
  projection: &mut JsObj,
) -> Result<()> {
  let name = template(&get(field, "name")?);
  let localization = cx.localization();
  if parent_is_localized && localization.truthy() {
    for locale in get(localization, "localeCodes")?.items() {
      let locale_path = database_schema_path.replacen("<locale>", &template(locale), 1);
      projection.set(format!("{locale_path}{name}"), JsVal::Bool(true));
    }
  } else {
    projection.set(format!("{database_schema_path}{name}"), JsVal::Bool(true));
  }
  Ok(())
}

struct Traverse<'a> {
  database_schema_path: &'a str,
  fields: &'a JsVal,
  parent_is_localized: bool,
  select_all_on_current_level: bool,
  select_mode: &'static str,
}

fn traverse_fields(cx: &QueryCx, args: Traverse, projection: &mut JsObj, select: &mut Sel) -> Result<()> {
  let _depth = cx.enter()?;
  let Traverse { database_schema_path, fields, parent_is_localized, select_all_on_current_level, select_mode } = args;

  for field in fields.items() {
    let affects_data = field_affects_data(field);
    let name = if affects_data { template(&get(field, "name")?) } else { String::new() };

    if affects_data {
      let selected = select.read(&name)?;
      if select_mode == "include" {
        if selected.is_true() || select_all_on_current_level {
          add_field_to_projection(cx, database_schema_path, field, parent_is_localized, projection)?;
          continue;
        }
        if !selected.truthy() {
          continue;
        }
      }

      if select_mode == "exclude" {
        if selected.is_undefined() {
          add_field_to_projection(cx, database_schema_path, field, parent_is_localized, projection)?;
          continue;
        }
        if selected.is_false() {
          continue;
        }
      }
    }

    let mut field_database_schema_path = database_schema_path.to_owned();
    if affects_data {
      field_database_schema_path = format!("{database_schema_path}{name}.");
      if field_should_be_localized(field, parent_is_localized) {
        field_database_schema_path = format!("{field_database_schema_path}<locale>.");
      }
    }

    let ty = get(field, "type")?;
    let field_localized = parent_is_localized || get(field, "localized")?.truthy();
    match ty.as_str().unwrap_or_default() {
      ty @ ("array" | "group" | "tab") => {
        // `select[field.name]` is read before it is mutated
        let mut placeholder = select.read(&name)?;
        let field_select = match select.get_mut(&name) {
          Some(s) => s,
          None => &mut placeholder,
        };

        if ty == "array" && select_mode == "include" {
          field_select.set("id", Sel::Val(JsVal::Bool(true)))?;
        }

        traverse_fields(
          cx,
          Traverse {
            database_schema_path: &field_database_schema_path,
            fields: &get(field, "flattenedFields")?,
            parent_is_localized: field_localized,
            select_all_on_current_level: false,
            select_mode,
          },
          projection,
          field_select,
        )?;
      }
      "blocks" => {
        let mut placeholder = select.read(&name)?;
        let blocks_select = match select.get_mut(&name) {
          Some(s) => s,
          None => &mut placeholder,
        };

        for block in get(field, "blocks")?.items() {
          let block = match block {
            JsVal::Str(slug) => cx.env.blocks.get(slug).clone(),
            other => other.clone(),
          };
          if !block.truthy() {
            continue;
          }
          let slug = template(&get(&block, "slug")?);
          let block_fields = get(&block, "flattenedFields")?;

          let block_entry = blocks_select.read(&slug)?;
          if (select_mode == "include" && block_entry.is_true()) || (select_mode == "exclude" && block_entry.is_undefined()) {
            traverse_fields(
              cx,
              Traverse {
                database_schema_path: &field_database_schema_path,
                fields: &block_fields,
                parent_is_localized: field_localized,
                select_all_on_current_level: true,
                select_mode: "include",
              },
              projection,
              &mut Sel::Obj(IndexMap::new()),
            )?;
            continue;
          }

          let mut block_select_mode = select_mode;
          if select_mode == "exclude" && block_entry.is_false() {
            block_select_mode = "include";
          }

          if !blocks_select.read(&slug)?.is_object_type() {
            blocks_select.set(&slug, Sel::Obj(IndexMap::new()))?;
          }

          let mut placeholder = blocks_select.read(&slug)?;
          let block_select = match blocks_select.get_mut(&slug) {
            Some(s) => s,
            None => &mut placeholder,
          };

          if block_select_mode == "include" && block_select.is_object_type() {
            block_select.set("id", Sel::Val(JsVal::Bool(true)))?;
            block_select.set("blockType", Sel::Val(JsVal::Bool(true)))?;
          }

          traverse_fields(
            cx,
            Traverse {
              database_schema_path: &field_database_schema_path,
              fields: &block_fields,
              parent_is_localized: field_localized,
              select_all_on_current_level: false,
              select_mode: block_select_mode,
            },
            projection,
            block_select,
          )?;
        }
      }
      "relationship" | "upload" => {
        // The raw value is needed for population even when a nested select is given.
        add_field_to_projection(cx, database_schema_path, field, parent_is_localized, projection)?;
      }
      _ => {}
    }
  }
  Ok(())
}

/// `buildProjectionFromSelect({ adapter, fields, select })`: `None` when `select` is falsy.
pub fn build_projection_from_select(cx: &QueryCx, fields: &JsVal, select: &JsVal) -> Result<Option<JsVal>> {
  if !select.truthy() {
    return Ok(None);
  }

  let mut projection = JsObj::new().with("_id", JsVal::Bool(true));
  let mut select = Sel::copy(cx, select)?;
  let select_mode = get_select_mode(cx, &select)?;

  traverse_fields(
    cx,
    Traverse {
      database_schema_path: "",
      fields,
      parent_is_localized: false,
      select_all_on_current_level: false,
      select_mode,
    },
    &mut projection,
    &mut select,
  )?;

  Ok(Some(projection.into_val()))
}
