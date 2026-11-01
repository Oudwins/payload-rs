//! Port of drizzle-orm 0.45 `SQLiteDialect.buildRelationalQuery`
//! (`sqlite-core/dialect.js`) together with the `buildSelectQuery` pieces it
//! uses: turns a [`QueryConfig`] into one SQLite statement that returns the
//! nested relations as `json_array` / `json_group_array` values, plus the
//! selection tree needed to map rows back (`mapRelationalRow`).

use payload_engine::error::{EngineError, Result};
use payload_engine::js::num_to_json;

use crate::args::{OrderBy, QueryConfig, With};
use crate::schema::{Decoder, DrizzleSchema, Relation};
use crate::sql::{self, Sql};

#[derive(Clone, Debug)]
pub enum SelectionKind {
  Column { name: String, decoder: Decoder },
  /// `extras` entry, decoded with drizzle's `noopDecoder`.
  Extra { sql: Sql, alias: String },
  Relation { sql: Sql, is_one: bool, selection: Vec<SelectionItem> },
}

#[derive(Clone, Debug)]
pub struct SelectionItem {
  pub ts_key: String,
  pub kind: SelectionKind,
}

#[derive(Clone, Debug)]
pub struct BuiltRelationalQuery {
  pub sql: Sql,
  pub selection: Vec<SelectionItem>,
}

/// `findMany` vs `findFirst` (`{ ...config, limit: 1 }`, first row only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
  Many,
  First,
}

/// `db.query[tableTsName].findMany(config)` / `.findFirst(config)` SQL.
pub fn build_relational_query(
  schema: &DrizzleSchema,
  table_ts_name: &str,
  config: &QueryConfig,
  mode: Mode,
) -> Result<BuiltRelationalQuery> {
  let table = schema.table(table_ts_name)?;
  let first;
  let config = if mode == Mode::First {
    first = QueryConfig { limit: Some(1.0), ..config.clone() };
    &first
  } else {
    config
  };
  build(schema, table_ts_name, Some(config), &table.ts_name, None, None)
}

/// `config === true` is passed as `None`.
fn build(
  schema: &DrizzleSchema,
  table_ts_name: &str,
  config: Option<&QueryConfig>,
  table_alias: &str,
  nested_query_relation: Option<&Relation>,
  join_on: Option<Sql>,
) -> Result<BuiltRelationalQuery> {
  let table_config = schema.table(table_ts_name)?;
  let mut selection: Vec<SelectionItem> = Vec::new();
  let mut limit = None;
  let mut offset = None;
  let mut order_by: Vec<Sql> = Vec::new();
  let mut where_: Option<Sql> = None;

  match config {
    None => {
      selection = table_config
        .columns
        .iter()
        .map(|(key, column)| SelectionItem {
          ts_key: key.clone(),
          kind: SelectionKind::Column { name: column.name.clone(), decoder: column.decoder },
        })
        .collect();
    }
    Some(config) => {
      where_ = config.where_.clone();

      let mut selected_columns: Vec<String> = Vec::new();
      if let Some(columns) = &config.columns {
        let mut is_include_mode = false;
        for (field, value) in columns {
          let Some(value) = value else { continue };
          if table_config.columns.contains_key(field) {
            if !is_include_mode && *value {
              is_include_mode = true;
            }
            selected_columns.push(field.clone());
          }
        }
        if !selected_columns.is_empty() {
          selected_columns = if is_include_mode {
            selected_columns.into_iter().filter(|c| columns.get(c) == Some(&Some(true))).collect()
          } else {
            table_config.columns.keys().filter(|k| !selected_columns.contains(k)).cloned().collect()
          };
        }
      } else {
        selected_columns = table_config.columns.keys().cloned().collect();
      }

      for field in &selected_columns {
        let column = &table_config.columns[field];
        selection.push(SelectionItem {
          ts_key: field.clone(),
          kind: SelectionKind::Column { name: column.name.clone(), decoder: column.decoder },
        });
      }

      if let Some(extras) = &config.extras {
        for (ts_key, extra) in extras {
          selection.push(SelectionItem {
            ts_key: ts_key.clone(),
            kind: SelectionKind::Extra { sql: extra.sql.clone(), alias: extra.alias.clone() },
          });
        }
      }

      for item in config.order_by.iter().flatten() {
        order_by.push(match item {
          OrderBy::Column { key, order } => {
            let column = table_config.columns.get(key).ok_or_else(|| {
              EngineError::internal(format!("Cannot read properties of undefined (reading '{key}') in orderBy"))
            })?;
            let mut s = Sql::column(table_alias, &column.name);
            s.push_str(" ").push_str(order.as_str());
            s
          }
          OrderBy::Sql(s) => s.clone(),
        });
      }
      limit = config.limit;
      offset = config.offset;

      for (relation_key, value) in config.with.iter().flatten() {
        let relation_config = match value {
          With::Bool(false) => continue,
          With::Bool(true) => None,
          With::Config(c) => Some(c.as_ref()),
        };
        let relation = table_config.relations.get(relation_key).ok_or_else(|| {
          EngineError::internal("Cannot read properties of undefined (reading 'referencedTable')".to_string())
        })?;
        let normalized = schema.normalize_relation(relation_key, relation)?;
        let relation_table_alias = format!("{table_alias}_{relation_key}");
        let join_on = sql::and(normalized.fields.iter().zip(&normalized.references).map(|(field, reference)| {
          Some(sql::eq(&Sql::column(&relation_table_alias, reference), &Sql::column(table_alias, field)))
        }));
        let one_config;
        let nested_config = if relation.is_one() {
          one_config = QueryConfig { limit: Some(1.0), ..relation_config.cloned().unwrap_or_default() };
          Some(&one_config)
        } else {
          relation_config
        };
        let built = build(
          schema,
          &relation.referenced_table,
          nested_config,
          &relation_table_alias,
          Some(relation),
          join_on,
        )?;
        let mut field = Sql::raw("(");
        field.push(&built.sql).push_str(")");
        selection.push(SelectionItem {
          ts_key: relation_key.clone(),
          kind: SelectionKind::Relation { sql: field, is_one: relation.is_one(), selection: built.selection },
        });
      }
    }
  }

  if selection.is_empty() {
    return Err(EngineError::new(
      "DrizzleError",
      format!(
        "No fields selected for table \"{}\" (\"{table_alias}\"). You need to have at least one item in \"columns\", \"with\" or \"extras\". If you need to select all columns, omit the \"columns\" key or set it to undefined.",
        table_config.ts_name
      ),
    ));
  }

  let where_ = sql::and([join_on, where_]);
  let from_table = {
    let mut s = Sql::ident(&table_config.db_name);
    s.push_str(" ").push(&Sql::ident(table_alias));
    s
  };

  let result = if let Some(nested) = nested_query_relation {
    let mut field = Sql::raw("json_array(");
    let parts: Vec<Sql> = selection
      .iter()
      .map(|item| match &item.kind {
        SelectionKind::Column { name, .. } => Sql::ident(name),
        SelectionKind::Extra { sql, .. } => sql.clone(),
        SelectionKind::Relation { sql, .. } => sql.clone(),
      })
      .collect();
    field.push(&Sql::join(parts.iter(), ", ")).push_str(")");
    if !nested.is_one() {
      let mut many = Sql::raw("coalesce(json_group_array(");
      many.push(&field).push_str("), json_array())");
      field = many;
    }
    let mut data = field;
    data.push_str(" as \"data\"");

    let needs_subquery = limit.is_some() || offset.is_some() || !order_by.is_empty();
    if needs_subquery {
      let inner = select_query(&Sql::raw("*"), &from_table, where_.as_ref(), &order_by, limit, offset);
      let mut from = Sql::raw("(");
      from.push(&inner).push_str(") ").push(&Sql::ident(table_alias));
      select_query(&data, &from, None, &[], None, None)
    } else {
      select_query(&data, &from_table, where_.as_ref(), &[], None, None)
    }
  } else {
    let parts: Vec<Sql> = selection
      .iter()
      .map(|item| match &item.kind {
        // `buildSelection` (single table) reads `SQLiteNumericBigInt` columns as text; nested
        // `json_array` selections use the bare identifier.
        SelectionKind::Column { name, decoder: Decoder::NumericBigInt } => {
          let mut s = Sql::raw("cast(");
          s.push(&Sql::ident(name)).push_str(" as text)");
          s
        }
        SelectionKind::Column { name, .. } => Sql::ident(name),
        SelectionKind::Extra { sql, alias } => {
          let mut s = sql.clone();
          s.push_str(" as ").push(&Sql::ident(alias));
          s
        }
        SelectionKind::Relation { sql, .. } => {
          let mut s = sql.clone();
          s.push_str(" as ").push(&Sql::ident(&item.ts_key));
          s
        }
      })
      .collect();
    select_query(&Sql::join(parts.iter(), ", "), &from_table, where_.as_ref(), &order_by, limit, offset)
  };

  Ok(BuiltRelationalQuery { sql: result, selection })
}

/// `buildSelectQuery` for a query without joins/grouping:
/// `select <selection> from <table>[ where][ order by][ limit][ offset]`.
pub(crate) fn select_query(
  selection: &Sql,
  from: &Sql,
  where_: Option<&Sql>,
  order_by: &[Sql],
  limit: Option<f64>,
  offset: Option<f64>,
) -> Sql {
  let mut out = Sql::raw("select ");
  out.push(selection).push_str(" from ").push(from);
  if let Some(w) = where_ {
    out.push_str(" where ").push(w);
  }
  if !order_by.is_empty() {
    out.push_str(" order by ").push(&Sql::join(order_by.iter(), ", "));
  }
  push_limit_offset(&mut out, limit, offset);
  out
}

/// `buildLimit` (`typeof limit === 'number' && limit >= 0`) and the truthy
/// `offset` check of `buildSelectQuery`.
pub(crate) fn push_limit_offset(out: &mut Sql, limit: Option<f64>, offset: Option<f64>) {
  if let Some(limit) = limit.filter(|l| *l >= 0.0) {
    out.push_str(" limit ").push_param(num_to_json(limit));
  }
  if let Some(offset) = offset.filter(|o| *o != 0.0 && !o.is_nan()) {
    out.push_str(" offset ").push_param(num_to_json(offset));
  }
}
