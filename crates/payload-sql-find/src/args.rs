//! drizzle's relational query config (`DBQueryConfig<'many'>`): the object
//! `buildFindManyArgs` returns and `db.query[table].findMany()` receives.
//!
//! Functions and drizzle SQL objects of the TS config are represented by
//! their rendered form:
//! - `orderBy: ({ _order }, { asc }) => [asc(_order)]` is
//!   [`OrderBy::Column`] (a column of the current table, rendered through the
//!   current table alias),
//! - any other order/where/extras SQL is a pre-rendered [`Sql`] fragment, in
//!   the form drizzle renders it inside the relational query (i.e. after
//!   `mapColumnsInSQLToAlias(sql, tableAlias)`).
//!
//! The JSON form (`to_json` / `from_json`) is the one the differential harness
//! (test/__rs/find/harness.ts `serializeQueryConfig`) produces from a live TS
//! config.

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::js::num_to_json;
use serde_json::{Map, Value as Json, json};

use crate::sql::Sql;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
  Asc,
  Desc,
}

impl Order {
  pub fn as_str(self) -> &'static str {
    match self {
      Order::Asc => "asc",
      Order::Desc => "desc",
    }
  }
}

#[derive(Clone, Debug, PartialEq)]
pub enum OrderBy {
  /// `asc(columns[key])` / `desc(columns[key])` for a column of the current table.
  Column { key: String, order: Order },
  /// Pre-rendered order expression.
  Sql(Sql),
}

/// A `config.extras` entry: `sql\`...\`.as(alias)`.
#[derive(Clone, Debug, PartialEq)]
pub struct Extra {
  pub sql: Sql,
  pub alias: String,
}

/// A value of `config.with`: `true` or a nested config. Falsy values are kept
/// (drizzle filters them out when building the query).
#[derive(Clone, Debug, PartialEq)]
pub enum With {
  Bool(bool),
  Config(Box<QueryConfig>),
}

impl With {
  pub fn config_mut(&mut self) -> Option<&mut QueryConfig> {
    match self {
      With::Config(c) => Some(c),
      With::Bool(_) => None,
    }
  }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct QueryConfig {
  /// `columns`: `None` value = an own property set to `undefined`.
  pub columns: Option<IndexMap<String, Option<bool>>>,
  pub with: Option<IndexMap<String, With>>,
  pub extras: Option<IndexMap<String, Extra>>,
  pub order_by: Option<Vec<OrderBy>>,
  pub where_: Option<Sql>,
  /// JS numbers (`NaN` and fractions are possible from `findMany`).
  pub limit: Option<f64>,
  pub offset: Option<f64>,
}

impl QueryConfig {
  pub fn columns_mut(&mut self) -> &mut IndexMap<String, Option<bool>> {
    self.columns.get_or_insert_with(IndexMap::new)
  }

  pub fn with_mut(&mut self) -> &mut IndexMap<String, With> {
    self.with.get_or_insert_with(IndexMap::new)
  }

  pub fn extras_mut(&mut self) -> &mut IndexMap<String, Extra> {
    self.extras.get_or_insert_with(IndexMap::new)
  }

  /// Serializes to the harness JSON form.
  pub fn to_json(&self) -> Json {
    let mut out = Map::new();
    if let Some(columns) = &self.columns {
      out.insert(
        "columns".into(),
        Json::Object(columns.iter().map(|(k, v)| (k.clone(), v.map(Json::Bool).unwrap_or(Json::Null))).collect()),
      );
    }
    if let Some(with) = &self.with {
      out.insert(
        "with".into(),
        Json::Object(
          with
            .iter()
            .map(|(k, v)| {
              (
                k.clone(),
                match v {
                  With::Bool(b) => Json::Bool(*b),
                  With::Config(c) => c.to_json(),
                },
              )
            })
            .collect(),
        ),
      );
    }
    if let Some(extras) = &self.extras {
      out.insert(
        "extras".into(),
        Json::Object(
          extras
            .iter()
            .map(|(k, e)| (k.clone(), json!({ "sql": e.sql.sql, "params": e.sql.to_json()["params"], "alias": e.alias })))
            .collect(),
        ),
      );
    }
    if let Some(order_by) = &self.order_by {
      out.insert(
        "orderBy".into(),
        Json::Array(
          order_by
            .iter()
            .map(|o| match o {
              OrderBy::Column { key, order } => json!({ "column": key, "order": order.as_str() }),
              OrderBy::Sql(sql) => sql.to_json(),
            })
            .collect(),
        ),
      );
    }
    if let Some(where_) = &self.where_ {
      out.insert("where".into(), where_.to_json());
    }
    if let Some(limit) = self.limit {
      out.insert("limit".into(), num_to_json(limit));
    }
    if let Some(offset) = self.offset {
      out.insert("offset".into(), num_to_json(offset));
    }
    Json::Object(out)
  }

  /// Parses the harness JSON form. A missing `limit`/`offset` is `undefined`;
  /// `null` stands for `NaN` (JSON cannot carry it).
  pub fn from_json(json: &Json) -> Result<Self> {
    let obj = json.as_object().ok_or_else(|| EngineError::internal("query config must be an object"))?;
    let mut config = QueryConfig::default();
    if let Some(columns) = obj.get("columns").and_then(|c| c.as_object()) {
      config.columns = Some(columns.iter().map(|(k, v)| (k.clone(), v.as_bool())).collect());
    }
    if let Some(with) = obj.get("with").and_then(|c| c.as_object()) {
      let mut out = IndexMap::new();
      for (k, v) in with {
        out.insert(
          k.clone(),
          match v {
            Json::Object(_) => With::Config(Box::new(QueryConfig::from_json(v)?)),
            other => With::Bool(other.as_bool().unwrap_or(false)),
          },
        );
      }
      config.with = Some(out);
    }
    if let Some(extras) = obj.get("extras").and_then(|c| c.as_object()) {
      let mut out = IndexMap::new();
      for (k, v) in extras {
        let sql = Sql::from_json(v).ok_or_else(|| EngineError::internal(format!("invalid extras entry {k}")))?;
        let alias = v.get("alias").and_then(|a| a.as_str()).unwrap_or(k).to_string();
        out.insert(k.clone(), Extra { sql, alias });
      }
      config.extras = Some(out);
    }
    if let Some(order_by) = obj.get("orderBy").and_then(|c| c.as_array()) {
      let mut out = Vec::new();
      for o in order_by {
        if let Some(key) = o.get("column").and_then(|c| c.as_str()) {
          let order = if o.get("order").and_then(|c| c.as_str()) == Some("desc") { Order::Desc } else { Order::Asc };
          out.push(OrderBy::Column { key: key.to_string(), order });
        } else {
          out.push(OrderBy::Sql(Sql::from_json(o).ok_or_else(|| EngineError::internal("invalid orderBy entry"))?));
        }
      }
      config.order_by = Some(out);
    }
    if let Some(where_) = obj.get("where") {
      config.where_ = Sql::from_json(where_);
    }
    let num = |k: &str| obj.get(k).map(|v| v.as_f64().unwrap_or(f64::NAN));
    config.limit = num("limit");
    config.offset = num("offset");
    Ok(config)
  }
}
