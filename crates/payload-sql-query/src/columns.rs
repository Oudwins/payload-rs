//! Port of `queries/getTableColumnFromPath.ts` and `queries/addJoinTable.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{field_should_be_localized, tab_has_name};
use payload_engine::js::{JsVal, Obj};
use payload_engine::strings::to_snake_case;

use crate::adapter::{QueryAdapter, read_undefined, snake_case_of};
use crate::js_ops::{js_string, uuid_validate};
use crate::paths::{append_field_to_storage_path, field_type, find_field, get_field_by_path, resolve_relationship_path};
use crate::sql::{self, Expr, Join, Sql, TableRef};
use crate::where_val::WhereVal;

/// An extra `{ columnName, table, value }` constraint discovered while resolving a path.
#[derive(Clone, Debug)]
pub struct Constraint {
  pub column_name: String,
  pub table: TableRef,
  pub value: JsVal,
}

/// A JS array of constraints, shared by reference like in TS.
pub type Constraints = Rc<RefCell<Vec<Constraint>>>;

/// `Record<string, GenericColumn>` of selected fields; `None` values mirror `undefined`.
pub type SelectFields = IndexMap<String, Option<Expr>>;

/// `{ idType, rawColumn }` of a polymorphic relationship `value` query.
#[derive(Clone, Debug)]
pub struct PolyColumn {
  pub id_type: String,
  pub raw_column: Sql,
}

/// `getNotNullColumnByValue`
#[derive(Clone, Debug)]
pub enum NotNullColumn {
  /// `() => 'id'`
  Id,
  /// Finds `val` in `relationTo` and returns `${relation}ID`.
  RelationTo(Vec<JsVal>),
}

impl NotNullColumn {
  pub fn get(&self, val: &JsVal) -> Option<String> {
    match self {
      NotNullColumn::Id => Some("id".into()),
      NotNullColumn::RelationTo(list) => {
        list.iter().find(|r| r.strict_eq(val)).map(|r| format!("{}ID", js_string(r)))
      }
    }
  }
}

/// `TableColumn`
#[derive(Clone, Debug)]
pub struct TableColumn {
  pub column_name: Option<String>,
  pub columns: Option<Vec<PolyColumn>>,
  pub constraints: Constraints,
  pub field: JsVal,
  pub get_not_null_column_by_value: Option<NotNullColumn>,
  pub path_segments: Option<Vec<String>>,
  pub raw_column: Option<Sql>,
  pub table: Option<TableRef>,
}

/// Arguments of `getTableColumnFromPath` (minus `adapter`, `joins` and `selectFields`).
#[derive(Clone, Debug)]
pub struct ColumnArgs {
  pub alias_table: Option<TableRef>,
  pub collection_path: String,
  pub column_prefix: String,
  pub constraint_path: String,
  pub constraints: Constraints,
  pub fields: JsVal,
  pub locale: Option<String>,
  pub parent_alias_table: Option<TableRef>,
  pub parent_is_localized: bool,
  pub path_segments: Vec<String>,
  pub root_table_name: Option<String>,
  pub select_locale: bool,
  pub table_name: String,
  pub table_name_suffix: String,
  /// The raw query value (`where[path][operator]`).
  pub value: WhereVal,
}

impl ColumnArgs {
  pub fn new(collection_path: &str, fields: JsVal, table_name: &str, path_segments: Vec<String>, value: WhereVal) -> Self {
    Self {
      alias_table: None,
      collection_path: collection_path.to_string(),
      column_prefix: String::new(),
      constraint_path: String::new(),
      constraints: Rc::new(RefCell::new(Vec::new())),
      fields,
      locale: None,
      parent_alias_table: None,
      parent_is_localized: false,
      path_segments,
      root_table_name: None,
      select_locale: false,
      table_name: table_name.to_string(),
      table_name_suffix: String::new(),
      value,
    }
  }
}

/// `addJoinTable({ type, condition, isOneToMany, joins, queryPath, table })`
pub fn add_join_table(joins: &mut Vec<Join>, join: Join) {
  let name = join.table.ref_name().to_string();
  if !joins.iter().any(|j| j.table.ref_name() == name) {
    joins.push(join);
  }
}

pub(crate) fn locale_val(locale: &Option<String>) -> JsVal {
  locale.as_ref().map(|l| JsVal::str(l.as_str())).unwrap_or(JsVal::Undefined)
}

fn locale_truthy(locale: &Option<String>) -> bool {
  locale.as_ref().is_some_and(|l| !l.is_empty())
}

fn join(condition: Option<Sql>, table: TableRef) -> Join {
  Join { condition, is_one_to_many: false, query_path: None, table, join_type: None }
}

fn id_field(adapter: &QueryAdapter) -> JsVal {
  let mut o = Obj::new();
  o.insert("name".into(), JsVal::str("id"));
  o.insert("type".into(), JsVal::str(if adapter.is_uuid_id() { "text" } else { "number" }));
  JsVal::obj(o)
}

fn opt<T>(v: Option<T>, prop: &str) -> Result<T> {
  v.ok_or_else(|| read_undefined(prop))
}

fn name_of(field: &JsVal) -> String {
  js_string(field.get("name"))
}

/// `getTableColumnFromPath(args)`
pub fn get_table_column_from_path(
  adapter: &QueryAdapter,
  args: ColumnArgs,
  joins: &mut Vec<Join>,
  select_fields: &mut SelectFields,
) -> Result<TableColumn> {
  let ColumnArgs {
    mut alias_table,
    collection_path,
    column_prefix,
    constraint_path: incoming_constraint_path,
    mut constraints,
    fields,
    locale: incoming_locale,
    parent_alias_table,
    parent_is_localized,
    path_segments: incoming_segments,
    root_table_name: incoming_root_table_name,
    select_locale,
    table_name,
    table_name_suffix,
    value,
  } = args;

  let field_path = incoming_segments.first().map(String::as_str);
  let mut locale = incoming_locale;
  let root_table_name = incoming_root_table_name.filter(|s| !s.is_empty()).unwrap_or_else(|| table_name.clone());
  let table_containing_field =
    parent_alias_table.clone().or_else(|| alias_table.clone()).or_else(|| adapter.table(Some(&root_table_name)));
  let mut constraint_path = incoming_constraint_path;

  let field = find_field(&fields, field_path).cloned();
  let mut new_table_name = Some(table_name.clone());

  let Some(field) = field else {
    if field_path == Some("id") {
      let table = adapter.table_req(Some(&table_name), "id")?;
      select_fields.insert("id".into(), adapter.col(&table, "id"));
      return Ok(TableColumn {
        column_name: Some("id".into()),
        columns: None,
        constraints,
        field: id_field(adapter),
        get_not_null_column_by_value: None,
        path_segments: None,
        raw_column: None,
        table: Some(table),
      });
    }
    return Err(EngineError::api(format!("Cannot find field for path at {}", field_path.unwrap_or("undefined"))));
  };

  let localization = adapter.localization().truthy();
  let field_name = name_of(&field);
  let field_localized = field.get("localized").truthy();
  let mut localized_path_query = false;
  let mut path_segments = incoming_segments.clone();
  let field_storage_path = append_field_to_storage_path(&field, &constraint_path);
  let is_field_localized = field_should_be_localized(&field, parent_is_localized);

  if is_field_localized && localization {
    let codes = adapter.locale_codes();
    if let Some(matched) = codes.iter().find(|c| path_segments.get(1) == Some(*c)) {
      locale = Some(matched.clone());
      localized_path_query = true;
      path_segments.remove(1);
    }
  }

  let rest_segments = || path_segments.get(1..).unwrap_or(&[]).to_vec();
  let child_localized = parent_is_localized || field_localized;

  match field_type(&field) {
    "array" => {
      let new_name = adapter.table_name_map(&format!("{table_name}_{table_name_suffix}{}", to_snake_case(&field_name)));
      let array_parent_table = alias_table.clone().or_else(|| adapter.table(Some(&table_name)));
      constraint_path = format!("{field_storage_path}.");
      let parent_id = adapter.col_of(array_parent_table.as_ref(), "id")?;
      let new_table = adapter.table(new_name.as_deref());
      let first = sql::eq(parent_id.as_ref(), opt_operand(adapter.col_of(new_table.as_ref(), "_parentID")?));
      let new_table = opt(new_table, "_parentID")?;
      if locale_truthy(&locale) && is_field_localized && localization {
        let mut conditions = vec![Some(first)];
        if select_locale {
          select_fields.insert("_locale".into(), adapter.col(&new_table, "_locale"));
        }
        if locale.as_deref() != Some("all") {
          conditions.push(Some(sql::eq(adapter.col(&new_table, "_locale").as_ref(), locale_val(&locale))));
        }
        add_join_table(joins, Join { is_one_to_many: true, ..join(sql::and(conditions), new_table.clone()) });
      } else {
        add_join_table(joins, Join { is_one_to_many: true, ..join(Some(first), new_table.clone()) });
      }
      let mut next = ColumnArgs::new(&collection_path, field.get("flattenedFields").clone(), &new_table.name, rest_segments(), value);
      next.constraint_path = constraint_path;
      next.constraints = constraints;
      next.locale = locale;
      next.parent_alias_table = alias_table;
      next.parent_is_localized = child_localized;
      next.root_table_name = Some(root_table_name);
      next.select_locale = select_locale;
      next.table_name = new_name.unwrap_or_default();
      return get_table_column_from_path(adapter, next, joins, select_fields);
    }
    "blocks" if !adapter.opts.blocks_as_json => {
      if path_segments.get(1).map(String::as_str) == Some("blockType") {
        let block_types: Vec<JsVal> = match value.view() {
          JsVal::Arr(items) => items.to_vec(),
          other => vec![other],
        };
        for block_type in block_types {
          let mut block = adapter.block(&block_type).clone();
          if block.is_nullish() {
            block = field
              .get("blocks")
              .items()
              .find(|b| b.as_str().is_none() && b.get("slug").strict_eq(&block_type))
              .cloned()
              .unwrap_or(JsVal::Undefined);
          }
          if block.is_nullish() {
            return Err(read_undefined("slug"));
          }
          let block_table = adapter.resolve_block_table_name(
            &block,
            adapter.table_name_map(&format!("{table_name}_blocks_{}", snake_case_of(block.get("slug"))?)),
          );
          let (alias, _) = adapter.get_table_alias(Some(&block_table))?;
          let main = adapter.table_req(Some(&table_name), "id")?;
          joins.push(join(
            Some(sql::eq(adapter.col(&main, "id").as_ref(), opt_operand(adapter.col(&alias, "_parentID")))),
            alias.clone(),
          ));
          constraints.borrow_mut().push(Constraint {
            column_name: "_path".into(),
            table: alias,
            value: JsVal::str(format!("{constraint_path}{}", path_segments[0])),
          });
        }
        return Ok(TableColumn {
          column_name: None,
          columns: None,
          constraints,
          field,
          get_not_null_column_by_value: Some(NotNullColumn::Id),
          path_segments: None,
          raw_column: None,
          table: adapter.table(Some(&table_name)),
        });
      }

      let mut block_table_column: Option<TableColumn> = None;
      for raw_block in field.get("blocks").items() {
        let block = if let Some(slug) = raw_block.as_str() { adapter.blocks.get(slug).clone() } else { raw_block.clone() };
        if block.is_nullish() {
          return Err(read_undefined("slug"));
        }
        let block_table_name = adapter.resolve_block_table_name(
          &block,
          adapter.table_name_map(&format!("{table_name}_blocks_{}", to_snake_case(&js_string(block.get("slug"))))),
        );
        let block_constraints: Constraints = Rc::new(RefCell::new(Vec::new()));
        let mut block_select_fields = SelectFields::new();

        let parent = alias_table.clone().or_else(|| adapter.table(Some(&table_name)));
        let parent_id = adapter.col_of(parent.as_ref(), "id")?;
        let new_table = adapter.table(Some(&block_table_name));
        let parent_id_col = adapter.col_of(new_table.as_ref(), "_parentID")?;
        let new_table = opt(new_table, "_parentID")?;
        let block_join = if is_field_localized && localization {
          let mut conditions = vec![Some(sql::eq(parent_id.as_ref(), opt_operand(parent_id_col.clone())))];
          if locale.as_deref() != Some("all") {
            conditions.push(Some(sql::eq(adapter.col(&new_table, "_locale").as_ref(), locale_val(&locale))));
          }
          join(sql::and(conditions), new_table.clone())
        } else {
          join(Some(sql::eq(parent_id.as_ref(), opt_operand(parent_id_col.clone()))), new_table.clone())
        };

        let mut new_joins = joins.clone();
        let mut next = ColumnArgs::new(&collection_path, block.get("flattenedFields").clone(), &block_table_name, rest_segments(), value.clone());
        next.constraint_path = format!("{field_storage_path}.");
        next.constraints = block_constraints.clone();
        next.locale = locale.clone();
        next.parent_is_localized = child_localized;
        next.root_table_name = Some(root_table_name.clone());
        next.select_locale = select_locale;
        // Errors are fine here: not every block has the field.
        let Ok(result) = get_table_column_from_path(adapter, next, &mut new_joins, &mut block_select_fields) else {
          continue;
        };
        let mut merged = constraints.borrow().clone();
        merged.extend(block_constraints.borrow().iter().cloned());
        constraints = Rc::new(RefCell::new(merged));
        // `selectFields = { ...selectFields, ...blockSelectFields }` only rebinds a local.

        let previous_length = joins.len();
        joins.push(block_join);
        if new_joins.len() > previous_length {
          joins.extend(new_joins.drain(previous_length..));
        }
        block_table_column = Some(result);
        break;
      }
      if let Some(btc) = block_table_column {
        return Ok(TableColumn {
          column_name: btc.column_name,
          columns: None,
          constraints,
          field: btc.field,
          get_not_null_column_by_value: None,
          path_segments: Some(rest_segments()),
          raw_column: btc.raw_column,
          table: btc.table,
        });
      }
    }
    "group" => {
      if locale_truthy(&locale) && is_field_localized && localization {
        let locales_name = format!("{table_name}{}", adapter.opts.locales_suffix);
        let main = adapter.table(Some(&table_name));
        let main_id = adapter.col_of(main.as_ref(), "id")?;
        let new_table = adapter.table(Some(&locales_name));
        let parent_col = adapter.col_of(new_table.as_ref(), "_parentID")?;
        let new_table = opt(new_table, "_parentID")?;
        let mut condition = sql::eq(main_id.as_ref(), opt_operand(parent_col));
        if locale.as_deref() != Some("all") {
          condition = sql::and(vec![Some(condition), Some(sql::eq(adapter.col(&new_table, "_locale").as_ref(), locale_val(&locale)))])
            .unwrap_or_default();
        }
        add_join_table(joins, join(Some(condition), new_table));
        new_table_name = Some(locales_name);
      }
      let mut next = ColumnArgs::new(&collection_path, field.get("flattenedFields").clone(), new_table_name.as_deref().unwrap_or(""), rest_segments(), value);
      next.alias_table = alias_table;
      next.column_prefix = format!("{column_prefix}{field_name}_");
      next.constraint_path = format!("{field_storage_path}.");
      next.constraints = constraints;
      next.locale = locale;
      next.parent_is_localized = child_localized;
      next.root_table_name = Some(root_table_name);
      next.select_locale = select_locale;
      next.table_name_suffix = format!("{table_name_suffix}{}_", to_snake_case(&field_name));
      return get_table_column_from_path(adapter, next, joins, select_fields);
    }
    "join" => {
      let collection = field.get("collection");
      if collection.as_arr().is_some() {
        return Err(EngineError::api("Not supported"));
      }
      let new_collection_path = rest_segments().join(".");
      let on = js_string(field.get("on"));
      let join_config = adapter.collection_config(collection)?;
      let join_fields = join_config.get("flattenedFields");
      if let Some(on_field) = get_field_by_path(join_fields, &on) {
        if matches!(field_type(on_field), "relationship" | "upload") && on_field.get("relationTo").as_arr().is_some() {
          return Err(EngineError::api("Not supported"));
        }
      }

      if field.get("hasMany").truthy() {
        let relation_table_name = format!(
          "{}{}",
          adapter.table_name_map(&to_snake_case(&js_string(collection))).unwrap_or_else(|| "undefined".into()),
          adapter.opts.relationships_suffix
        );
        let rels_query_path = format!("{constraint_path}{field_name}._rels");
        let existing = joins.iter().find(|j| j.query_path.as_deref() == Some(&rels_query_path)).map(|j| j.table.clone());
        let alias_rel = match &existing {
          Some(t) => t.clone(),
          None => adapter.get_table_alias(Some(&relation_table_name))?.0,
        };
        let Some(relationship_field) = get_field_by_path(join_fields, &on) else {
          return Err(EngineError::api("Relationship was not found"));
        };
        if existing.is_none() {
          let tcf_id = adapter.col_of(table_containing_field.as_ref(), "id")?;
          let rel_col = adapter.col(&alias_rel, &format!("{}ID", js_string(relationship_field.get("relationTo"))));
          let condition = sql::and(vec![
            Some(sql::eq(tcf_id.as_ref(), opt_operand(rel_col))),
            Some(sql::like(adapter.col(&alias_rel, "path").as_ref(), JsVal::str(on.as_str()))),
          ]);
          add_join_table(joins, Join { query_path: Some(rels_query_path), ..join(condition, alias_rel.clone()) });
        }
        if new_collection_path == "id" {
          return Ok(TableColumn {
            column_name: Some("parent".into()),
            columns: None,
            constraints,
            field: id_field(adapter),
            get_not_null_column_by_value: None,
            path_segments: None,
            raw_column: None,
            table: Some(alias_rel),
          });
        }
        let relationship_table_name = adapter.table_name_map(&to_snake_case(&js_string(join_config.get("slug"))));
        let main_query_path = format!("{constraint_path}{field_name}");
        let existing_main = joins.iter().find(|j| j.query_path.as_deref() == Some(&main_query_path)).map(|j| j.table.clone());
        let relationship_table = match &existing_main {
          Some(t) => t.clone(),
          None => adapter.get_table_alias(relationship_table_name.as_deref())?.0,
        };
        if existing_main.is_none() {
          let cond = sql::eq(adapter.col(&alias_rel, "parent").as_ref(), opt_operand(adapter.col(&relationship_table, "id")));
          joins.push(Join { query_path: Some(main_query_path), ..join(Some(cond), relationship_table.clone()) });
        }
        let rel_table_name = relationship_table_name.unwrap_or_default();
        let mut next = ColumnArgs::new(&new_collection_path, join_fields.clone(), &rel_table_name, rest_segments(), value);
        next.alias_table = Some(relationship_table);
        next.constraints = constraints;
        next.locale = locale;
        next.root_table_name = Some(rel_table_name);
        next.select_locale = select_locale;
        return get_table_column_from_path(adapter, next, joins, select_fields);
      }

      let join_table_name = adapter.table_name_map(&to_snake_case(&js_string(join_config.get("slug"))));
      let query_path = format!("{constraint_path}{field_name}");
      let existing = joins.iter().find(|j| j.query_path.as_deref() == Some(&query_path)).map(|j| j.table.clone());
      let new_alias_table = match &existing {
        Some(t) => t.clone(),
        None => adapter.get_table_alias(join_table_name.as_deref())?.0,
      };
      if existing.is_none() {
        let on_segments: Vec<&str> = on.split('.').collect();
        let first_seg_field = if on_segments.len() > 1 { find_field(join_fields, Some(on_segments[0])) } else { None };
        let array_table_name = if first_seg_field.is_some_and(|f| field_type(f) == "array") {
          adapter.table_name_map(&format!(
            "{}_{}",
            join_table_name.as_deref().unwrap_or("undefined"),
            to_snake_case(on_segments[0])
          ))
        } else {
          None
        };
        let parent_id = match &alias_table {
          Some(t) => adapter.col(t, "id"),
          None => adapter.col_of(adapter.table(Some(&table_name)).as_ref(), "id")?,
        };
        if let Some(array_table_name) = array_table_name.filter(|s| !s.is_empty()) {
          let (array_alias, _) = adapter.get_table_alias(Some(&array_table_name))?;
          joins.push(Join {
            query_path: Some(format!("{constraint_path}{field_name}._array")),
            ..join(
              Some(sql::eq(adapter.col(&array_alias, &on_segments[1..].join("_")).as_ref(), opt_operand(parent_id))),
              array_alias.clone(),
            )
          });
          joins.push(Join {
            query_path: Some(query_path.clone()),
            ..join(
              Some(sql::eq(adapter.col(&new_alias_table, "id").as_ref(), opt_operand(adapter.col(&array_alias, "_parentID")))),
              new_alias_table.clone(),
            )
          });
        } else {
          joins.push(Join {
            query_path: Some(query_path.clone()),
            ..join(
              Some(sql::eq(adapter.col(&new_alias_table, &on.replace('.', "_")).as_ref(), opt_operand(parent_id))),
              new_alias_table.clone(),
            )
          });
        }
      }
      if new_collection_path == "id" {
        return Ok(TableColumn {
          column_name: Some("id".into()),
          columns: None,
          constraints,
          field: id_field(adapter),
          get_not_null_column_by_value: None,
          path_segments: None,
          raw_column: None,
          table: Some(new_alias_table),
        });
      }
      let mut next = ColumnArgs::new(
        &new_collection_path,
        join_fields.clone(),
        join_table_name.as_deref().unwrap_or(""),
        rest_segments(),
        value,
      );
      next.alias_table = Some(new_alias_table);
      next.constraints = constraints;
      next.locale = locale;
      return get_table_column_from_path(adapter, next, joins, select_fields);
    }
    "number" | "text" => {
      if field.get("hasMany").truthy() {
        let (table_type, column_name) = if field_type(&field) == "number" { ("numbers", "number") } else { ("texts", "text") };
        let many_table_name = format!("{root_table_name}_{table_type}");
        let existing = joins.iter().find(|j| j.query_path.as_deref() == Some(&field_storage_path)).map(|j| j.table.clone());
        let table = match existing {
          Some(t) => t,
          None => adapter.get_table_alias(Some(&many_table_name))?.0,
        };
        let tcf_id = adapter.col_of(table_containing_field.as_ref(), "id")?;
        let join_constraints = vec![
          Some(sql::eq(tcf_id.as_ref(), opt_operand(adapter.col(&table, "parent")))),
          Some(sql::like(adapter.col(&table, "path").as_ref(), JsVal::str(field_storage_path.as_str()))),
        ];
        let condition = if locale_truthy(&locale) && is_field_localized && localization {
          let mut conditions = join_constraints;
          if locale.as_deref() != Some("all") {
            conditions.push(Some(sql::eq(adapter.col(&table, "_locale").as_ref(), locale_val(&locale))));
          }
          sql::and(conditions)
        } else {
          sql::and(join_constraints)
        };
        add_join_table(joins, Join { query_path: Some(field_storage_path.clone()), ..join(condition, table.clone()) });
        return Ok(TableColumn {
          column_name: Some(column_name.into()),
          columns: None,
          constraints,
          field,
          get_not_null_column_by_value: None,
          path_segments: None,
          raw_column: None,
          table: Some(table),
        });
      }
    }
    "relationship" | "upload" => {
      let new_collection_path = rest_segments().join(".");
      let relation_to = field.get("relationTo").clone();

      if relation_to.as_arr().is_some() || field.get("hasMany").truthy() {
        let relationship_path =
          resolve_relationship_path(adapter, &fields, locale.clone(), parent_is_localized, &field_name, &constraint_path)?;
        let Some(relationship_path) = relationship_path else {
          return Err(EngineError::api(format!("Relationship path could not be resolved: {collection_path}")));
        };
        let relation_table_name = format!("{root_table_name}{}", adapter.opts.relationships_suffix);
        let query_path = format!("{constraint_path}.{field_name}");
        let existing = joins.iter().find(|j| j.query_path.as_deref() == Some(&query_path)).map(|j| j.table.clone());
        let (alias_rel, alias_rel_name) = match existing {
          Some(t) => {
            let name = t.ref_name().to_string();
            (t, name)
          }
          None => adapter.get_table_alias(Some(&relation_table_name))?,
        };

        if select_locale && relationship_path.is_localized && localization {
          select_fields.insert("_locale".into(), adapter.col(&alias_rel, "locale"));
        }

        let tcf_id = adapter.col_of(table_containing_field.as_ref(), "id")?;
        let mut conditions = vec![
          Some(sql::eq(tcf_id.as_ref(), opt_operand(adapter.col(&alias_rel, "parent")))),
          Some(sql::like(adapter.col(&alias_rel, "path").as_ref(), JsVal::str(relationship_path.path.as_str()))),
        ];
        if locale_truthy(&relationship_path.locale)
          && relationship_path.locale.as_deref() != Some("all")
          && relationship_path.is_localized
          && localization
        {
          conditions.push(Some(sql::eq(adapter.col(&alias_rel, "locale").as_ref(), locale_val(&relationship_path.locale))));
        }
        add_join_table(joins, Join { query_path: Some(query_path), ..join(sql::and(conditions), alias_rel.clone()) });

        select_fields.insert(format!("{relation_table_name}.path"), adapter.col(&alias_rel, "path"));

        let (new_alias_table, next_fields, next_table_name);
        if let Some(rel) = relation_to.as_str() {
          let relationship_config = adapter.collection_config(&relation_to)?;
          let target = adapter.table_name_map(&to_snake_case(&js_string(relationship_config.get("slug"))));
          let (alias, _) = adapter.get_table_alias(target.as_deref())?;
          joins.push(join(
            Some(sql::eq(adapter.col(&alias, "id").as_ref(), opt_operand(adapter.col(&alias_rel, &format!("{rel}ID"))))),
            alias.clone(),
          ));
          if new_collection_path.is_empty() || new_collection_path == "id" {
            return Ok(TableColumn {
              column_name: Some(format!("{rel}ID")),
              columns: None,
              constraints,
              field,
              get_not_null_column_by_value: None,
              path_segments: None,
              raw_column: None,
              table: Some(alias_rel),
            });
          }
          new_alias_table = alias;
          next_fields = relationship_config.get("flattenedFields").clone();
          next_table_name = target;
        } else if new_collection_path == "value" {
          let value = value.view();
          let relation_tos: Vec<JsVal> = relation_to.items().cloned().collect();
          let mut has_custom = false;
          for r in &relation_tos {
            if adapter.collection(r)?.get("customIDType").truthy() {
              has_custom = true;
              break;
            }
          }
          let mut columns = Vec::new();
          for r in &relation_tos {
            let mut id_type = if adapter.is_uuid_id() { "uuid".to_string() } else { "number".to_string() };
            let custom = adapter.collection(r)?.get("customIDType");
            if custom.truthy() {
              id_type = js_string(custom);
            }
            let text_or_uuid = id_type == "text" || id_type == "uuid";
            if matches!(value, JsVal::Num(_)) && text_or_uuid {
              continue;
            }
            if let Some(items) = value.as_arr() {
              if items.iter().all(|v| matches!(v, JsVal::Num(_))) && text_or_uuid {
                continue;
              }
            }
            if value.truthy() && value.as_arr().is_none() && id_type == "uuid" && has_custom && !uuid_validate(&value) {
              continue;
            }
            if let Some(items) = value.as_arr() {
              if id_type == "uuid" && has_custom && !items.iter().any(uuid_validate) {
                continue;
              }
            }
            let rel_table = adapter.table_name_map(&to_snake_case(&js_string(adapter.collection_config(r)?.get("slug"))));
            columns.push(PolyColumn {
              id_type,
              raw_column: Sql::raw(format!("\"{alias_rel_name}\".\"{}_id\"", rel_table.unwrap_or_else(|| "undefined".into()))),
            });
          }
          return Ok(TableColumn {
            column_name: None,
            columns: Some(columns),
            constraints,
            field,
            get_not_null_column_by_value: None,
            path_segments: None,
            raw_column: None,
            table: Some(alias_rel),
          });
        } else if new_collection_path == "relationTo" {
          let list = match &relation_to {
            JsVal::Arr(items) => items.to_vec(),
            other => vec![other.clone()],
          };
          return Ok(TableColumn {
            column_name: None,
            columns: None,
            constraints,
            field,
            get_not_null_column_by_value: Some(NotNullColumn::RelationTo(list)),
            path_segments: None,
            raw_column: None,
            table: Some(alias_rel),
          });
        } else if is_polymorphic_relationship(&value.view()) {
          let rel_table = adapter.table_name_map(&to_snake_case(&js_string(
            adapter.collection_config_read(value.view().get("relationTo"), "slug")?.get("slug"),
          )));
          return Ok(TableColumn {
            column_name: None,
            columns: None,
            constraints,
            field,
            get_not_null_column_by_value: None,
            path_segments: None,
            raw_column: Some(Sql::raw(format!(
              "\"{alias_rel_name}\".\"{}_id\"",
              rel_table.unwrap_or_else(|| "undefined".into())
            ))),
            table: Some(alias_rel),
          });
        } else if value.is_distinct() {
          let mut shape = Vec::new();
          for r in relation_to.items() {
            let rel_table = adapter.table_name_map(&to_snake_case(&js_string(adapter.collection_config(r)?.get("slug"))));
            shape.push((
              js_string(r),
              Sql::raw(format!("\"{alias_rel_name}\".\"{}_id\"", rel_table.unwrap_or_else(|| "undefined".into()))),
            ));
          }
          let raw_column = sql::json_build_object(&shape)?;
          return Ok(TableColumn {
            column_name: None,
            columns: None,
            constraints,
            field,
            get_not_null_column_by_value: None,
            path_segments: None,
            raw_column: Some(raw_column),
            table: Some(alias_rel),
          });
        } else {
          return Err(EngineError::api("Not supported"));
        }

        let next_table_name = next_table_name.unwrap_or_default();
        let mut next = ColumnArgs::new(&new_collection_path, next_fields, &next_table_name, rest_segments(), value);
        next.alias_table = Some(new_alias_table);
        next.constraints = constraints;
        next.locale = locale;
        next.root_table_name = Some(next_table_name);
        next.select_locale = select_locale;
        return get_table_column_from_path(adapter, next, joins, select_fields);
      } else if path_segments.len() > 1 && !(path_segments.len() == 2 && path_segments[1] == "id") {
        let column_name = format!("{column_prefix}{field_name}");
        let rel_config = adapter.collection_config(&relation_to)?;
        let target = adapter.table_name_map(&to_snake_case(&js_string(rel_config.get("slug"))));
        let (new_alias_table, _) = adapter.get_table_alias(target.as_deref())?;

        if is_field_localized && localization {
          let locales_name = format!("{root_table_name}{}", adapter.opts.locales_suffix);
          let (alias_locale_table, _) = adapter.get_table_alias(Some(&locales_name))?;
          let tcf_id = adapter.col_of(table_containing_field.as_ref(), "id")?;
          let mut conditions = vec![Some(sql::eq(adapter.col(&alias_locale_table, "_parentID").as_ref(), opt_operand(tcf_id)))];
          if select_locale {
            select_fields.insert("_locale".into(), adapter.col(&alias_locale_table, "_locale"));
          }
          if locale.as_deref() != Some("all") {
            conditions.push(Some(sql::eq(adapter.col(&alias_locale_table, "_locale").as_ref(), locale_val(&locale))));
          }
          let locales_table = adapter.table(Some(&locales_name)).ok_or_else(|| read_undefined("Symbol(drizzle:Name)"))?;
          add_join_table(joins, join(sql::and(conditions), locales_table.clone()));
          joins.push(join(
            Some(sql::eq(adapter.col(&locales_table, &column_name).as_ref(), opt_operand(adapter.col(&new_alias_table, "id")))),
            new_alias_table.clone(),
          ));
        } else {
          let right = match &alias_table {
            Some(t) => adapter.col(t, &column_name),
            None => adapter.col_of(adapter.table(Some(&table_name)).as_ref(), &column_name)?,
          };
          joins.push(join(Some(sql::eq(adapter.col(&new_alias_table, "id").as_ref(), opt_operand(right))), new_alias_table.clone()));
        }

        let target = target.unwrap_or_default();
        let mut next = ColumnArgs::new(&new_collection_path, rel_config.get("flattenedFields").clone(), &target, rest_segments(), value);
        next.alias_table = Some(new_alias_table);
        next.constraints = constraints;
        next.locale = locale;
        return get_table_column_from_path(adapter, next, joins, select_fields);
      }
    }
    "select" => {
      if field.get("hasMany").truthy() {
        let select_table_name =
          adapter.table_name_map(&format!("{table_name}_{table_name_suffix}{}", to_snake_case(&field_name)));
        let id_column = match &alias_table {
          Some(t) => adapter.col(t, "id"),
          None => adapter.col_of(adapter.table(Some(&table_name)).as_ref(), "id")?,
        };
        let new_table = adapter.table(select_table_name.as_deref());
        let parent = opt(new_table.as_ref().map(|t| adapter.col(t, "parent")), "parent")?;
        let new_table = opt(new_table, "parent")?;
        let first = sql::eq(id_column.as_ref(), opt_operand(parent));
        if locale_truthy(&locale) && is_field_localized && localization {
          let mut conditions =
            vec![Some(first), Some(sql::eq(adapter.col(&new_table, "_locale").as_ref(), locale_val(&locale)))];
          if locale.as_deref() != Some("all") {
            conditions.push(Some(sql::eq(adapter.col(&new_table, "_locale").as_ref(), locale_val(&locale))));
          }
          add_join_table(joins, join(sql::and(conditions), new_table.clone()));
        } else {
          add_join_table(joins, join(Some(first), new_table.clone()));
        }
        return Ok(TableColumn {
          column_name: Some("value".into()),
          columns: None,
          constraints,
          field,
          get_not_null_column_by_value: None,
          path_segments: None,
          raw_column: None,
          table: Some(new_table),
        });
      }
    }
    "tab" => {
      let mut next = ColumnArgs::new(
        &collection_path,
        field.get("flattenedFields").clone(),
        new_table_name.as_deref().unwrap_or(""),
        rest_segments(),
        value,
      );
      next.alias_table = alias_table;
      next.constraints = constraints;
      next.locale = locale;
      next.parent_is_localized = child_localized;
      next.root_table_name = Some(root_table_name);
      next.select_locale = select_locale;
      if tab_has_name(&field) {
        next.column_prefix = format!("{column_prefix}{field_name}_");
        next.constraint_path = format!("{field_storage_path}.");
        next.table_name_suffix = format!("{table_name_suffix}{}_", to_snake_case(&field_name));
      } else {
        next.column_prefix = column_prefix;
        next.constraint_path = constraint_path;
        next.table_name_suffix = table_name_suffix;
      }
      return get_table_column_from_path(adapter, next, joins, select_fields);
    }
    _ => {}
  }

  let mut new_table = adapter.table(new_table_name.as_deref());

  if is_field_localized && localization {
    let parent_table = alias_table.clone().or_else(|| adapter.table(Some(&table_name)));
    let locales_name = format!("{table_name}{}", adapter.opts.locales_suffix);
    new_table = if localized_path_query {
      Some(adapter.get_table_alias(Some(&locales_name))?.0)
    } else {
      adapter.table(Some(&locales_name))
    };
    new_table_name = Some(locales_name);
    let parent_id = adapter.col_of(parent_table.as_ref(), "id")?;
    let parent_col = adapter.col_of(new_table.as_ref(), "_parentID")?;
    let nt = opt(new_table.clone(), "_parentID")?;
    let mut condition = sql::eq(parent_id.as_ref(), opt_operand(parent_col));
    if locale.as_deref() != Some("all") {
      condition = sql::and(vec![Some(condition), Some(sql::eq(adapter.col(&nt, "_locale").as_ref(), locale_val(&locale)))])
        .unwrap_or_default();
    }
    if select_locale {
      select_fields.insert("_locale".into(), adapter.col(&nt, "_locale"));
    }
    add_join_table(joins, join(Some(condition), nt));
    alias_table = None;
  }

  let target_table = alias_table.or(new_table);
  let column_key = format!("{column_prefix}{field_name}");
  let target_col = adapter.col_of(target_table.as_ref(), &column_key)?;
  select_fields.insert(format!("{}.{column_key}", new_table_name.as_deref().unwrap_or("undefined")), target_col);

  Ok(TableColumn {
    column_name: Some(column_key),
    columns: None,
    constraints,
    field,
    get_not_null_column_by_value: None,
    path_segments: Some(path_segments),
    raw_column: None,
    table: target_table,
  })
}

pub(crate) fn opt_operand(e: Option<Expr>) -> crate::sql::Operand {
  match e {
    Some(e) => crate::sql::Operand::Expr(e),
    None => crate::sql::Operand::Val(JsVal::Undefined),
  }
}

/// `isPolymorphicRelationship(value)`
pub fn is_polymorphic_relationship(value: &JsVal) -> bool {
  value.truthy() && value.as_obj().is_some() && value.has("relationTo") && value.get("relationTo").as_str().is_some() && value.has("value")
}
