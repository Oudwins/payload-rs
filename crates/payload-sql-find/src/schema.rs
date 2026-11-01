//! The drizzle relational schema (`db._.schema`: tables, columns and
//! relations) as seen by drizzle's relational query builder.
//!
//! It is built either from Payload's raw schema (`adapter.rawTables` +
//! `adapter.rawRelations`, mirroring `sqlite/schema/buildDrizzleTable.ts` and
//! `schema/buildDrizzleRelations.ts`) or from a JSON description of the live
//! drizzle schema (used by the differential harness, which also covers
//! `beforeSchemaInit`/`afterSchemaInit` hook modifications).

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use serde_json::Value as Json;

/// `column.mapFromDriverValue` of the drizzle `sqlite-core` column classes
/// (drizzle-orm 0.45 `sqlite-core/columns/*.js`). Payload's own tables only
/// use `Identity`, `Boolean`, `Json` and `Number`; the others are reachable
/// through `beforeSchemaInit` / `afterSchemaInit` extensions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decoder {
  /// `SQLiteText`, `SQLiteInteger`, `SQLiteReal`, ... (no mapping)
  Identity,
  /// `SQLiteBoolean` (`integer({ mode: 'boolean' })`): `Number(value) === 1`
  Boolean,
  /// `SQLiteTextJson`: `JSON.parse(value)`
  Json,
  /// `SQLiteNumericNumber`: `typeof value === 'number' ? value : Number(value)`
  Number,
  /// `SQLiteNumeric`: `typeof value === 'string' ? value : String(value)`
  NumericString,
  /// `SQLiteNumericBigInt`: `BigInt(value)`
  NumericBigInt,
  /// `SQLiteTimestamp` with `mode: 'timestamp'`: `new Date(value * 1e3)`
  Timestamp,
  /// `SQLiteTimestamp` with `mode: 'timestamp_ms'`: `new Date(value)`
  TimestampMs,
  /// `SQLiteBlobBuffer` (`blob()` / `blob({ mode: 'buffer' })`): the value as a `Buffer`
  BlobBuffer,
  /// `SQLiteBlobJson` (`blob({ mode: 'json' })`): `JSON.parse(buf.toString('utf8'))`
  BlobJson,
  /// `SQLiteBigInt` (`blob({ mode: 'bigint' })`): `BigInt(buf.toString('utf8'))`
  BlobBigInt,
  /// `SQLiteCustomColumn` (`customType`): `fromDriver(value)` when it is a
  /// function (called through the [`payload_engine::host::Host`] by its
  /// function id), otherwise the value itself.
  Custom(Option<u32>),
}

impl Decoder {
  /// From a drizzle `column.columnType` (columns whose decoder does not
  /// depend on the column config).
  pub fn from_column_type(column_type: &str) -> Self {
    Self::from_column(column_type, None, None)
  }

  /// From a drizzle column: `columnType`, `config.mode` (`SQLiteTimestamp`)
  /// and the function id of a custom column's `mapFrom` (`fromDriver`).
  pub fn from_column(column_type: &str, mode: Option<&str>, from_driver: Option<u32>) -> Self {
    match column_type {
      "SQLiteBoolean" => Decoder::Boolean,
      "SQLiteTextJson" => Decoder::Json,
      "SQLiteNumericNumber" => Decoder::Number,
      "SQLiteNumeric" => Decoder::NumericString,
      "SQLiteNumericBigInt" => Decoder::NumericBigInt,
      "SQLiteTimestamp" if mode == Some("timestamp") => Decoder::Timestamp,
      "SQLiteTimestamp" => Decoder::TimestampMs,
      "SQLiteBlobBuffer" => Decoder::BlobBuffer,
      "SQLiteBlobJson" => Decoder::BlobJson,
      "SQLiteBigInt" => Decoder::BlobBigInt,
      "SQLiteCustomColumn" => Decoder::Custom(from_driver),
      _ => Decoder::Identity,
    }
  }

  /// From a Payload `RawColumn['type']` (see `buildDrizzleTable.ts`).
  pub fn from_raw_type(raw_type: &str) -> Self {
    match raw_type {
      "boolean" => Decoder::Boolean,
      "geometry" | "jsonb" => Decoder::Json,
      "numeric" => Decoder::Number,
      _ => Decoder::Identity,
    }
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Column {
  /// Database column name.
  pub name: String,
  pub decoder: Decoder,
  /// `column.getSQLType()`
  pub sql_type: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RelationKind {
  /// `one(table, { fields, references })`: column db names.
  One { fields: Vec<String>, references: Vec<String> },
  Many,
  /// `one(table)` without a config (the reverse side of a one-to-one): a
  /// `One` relation whose join columns are inferred from the referenced
  /// table's matching `one(..., { fields, references })`.
  OneWithoutConfig,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Relation {
  pub kind: RelationKind,
  /// ts name of the source table.
  pub source_table: String,
  /// ts name of the referenced table.
  pub referenced_table: String,
  pub relation_name: Option<String>,
}

impl Relation {
  pub fn is_one(&self) -> bool {
    matches!(self.kind, RelationKind::One { .. } | RelationKind::OneWithoutConfig)
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Table {
  /// ts name (key in the drizzle schema).
  pub ts_name: String,
  /// Database table name (`Table.Symbol.OriginalName`).
  pub db_name: String,
  pub columns: IndexMap<String, Column>,
  pub relations: IndexMap<String, Relation>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DrizzleSchema {
  pub tables: IndexMap<String, Table>,
}

/// `normalizeRelation` result: join columns as db names.
pub struct NormalizedRelation {
  /// Columns of the source (parent) table.
  pub fields: Vec<String>,
  /// Columns of the referenced table.
  pub references: Vec<String>,
}

impl DrizzleSchema {
  pub fn table(&self, ts_name: &str) -> Result<&Table> {
    self.tables.get(ts_name).ok_or_else(|| EngineError::internal(format!("Table \"{ts_name}\" not found in schema")))
  }

  /// The column named `column` (database name) of the table whose database name is `table`.
  pub fn column_by_db_name(&self, table: &str, column: &str) -> Option<&Column> {
    let table = match self.tables.get(table) {
      Some(t) if t.db_name == table => t,
      _ => self.tables.values().find(|t| t.db_name == table)?,
    };
    table.columns.values().find(|c| c.name == column)
  }

  /// Payload's `adapter.tables[name]` existence check.
  pub fn has_table(&self, ts_name: &str) -> bool {
    self.tables.contains_key(ts_name)
  }

  /// `adapter.tables[table]?.[column]` truthiness.
  pub fn has_column(&self, ts_name: &str, column_key: &str) -> bool {
    self.tables.get(ts_name).is_some_and(|t| t.columns.contains_key(column_key))
  }

  /// Port of drizzle `relations.js` `normalizeRelation`.
  pub fn normalize_relation(&self, relation_key: &str, relation: &Relation) -> Result<NormalizedRelation> {
    if let RelationKind::One { fields, references } = &relation.kind {
      return Ok(NormalizedRelation { fields: fields.clone(), references: references.clone() });
    }
    let referenced = self.tables.get(&relation.referenced_table).ok_or_else(|| {
      EngineError::internal(format!("Table \"{}\" not found in schema", relation.referenced_table))
    })?;
    if !self.tables.contains_key(&relation.source_table) {
      return Err(EngineError::internal(format!("Table \"{}\" not found in schema", relation.source_table)));
    }
    let relation_name = relation.relation_name.as_deref().filter(|n| !n.is_empty());
    let reverse: Vec<(&String, &Relation)> = referenced
      .relations
      .iter()
      .filter(|(key, r)| match relation_name {
        Some(name) => {
          let same = referenced.ts_name == relation.source_table && key.as_str() == relation_key;
          !same && r.relation_name.as_deref() == Some(name)
        }
        None => r.referenced_table == relation.source_table,
      })
      .collect();
    if reverse.len() > 1 {
      return Err(EngineError::internal(match relation_name {
        Some(name) => format!("There are multiple relations with name \"{name}\" in table \"{}\"", referenced.ts_name),
        None => format!(
          "There are multiple relations between \"{}\" and \"{}\". Please specify relation name",
          referenced.ts_name, relation.source_table
        ),
      }));
    }
    if let Some((_, Relation { kind: RelationKind::One { fields, references }, .. })) = reverse.first() {
      return Ok(NormalizedRelation { fields: references.clone(), references: fields.clone() });
    }
    Err(EngineError::internal(format!(
      "There is not enough information to infer relation \"{}.{relation_key}\"",
      relation.source_table
    )))
  }

  /// Builds the schema from Payload's `rawTables` and `rawRelations`
  /// (`buildDrizzleTable.ts` for SQLite + `buildDrizzleRelations.ts`).
  pub fn from_raw(raw_tables: &Json, raw_relations: &Json) -> Result<Self> {
    let mut tables: IndexMap<String, Table> = IndexMap::new();
    for (key, raw) in raw_tables.as_object().into_iter().flatten() {
      if raw.is_null() {
        continue;
      }
      let db_name = raw.get("name").and_then(|n| n.as_str()).unwrap_or(key).to_string();
      let columns = raw
        .get("columns")
        .and_then(|c| c.as_object())
        .into_iter()
        .flatten()
        .map(|(col_key, col)| {
          let name = col.get("name").and_then(|n| n.as_str()).unwrap_or(col_key).to_string();
          let raw_type = col.get("type").and_then(|t| t.as_str()).unwrap_or("");
          let sql_type = match raw_type {
            "boolean" | "integer" | "serial" => "integer",
            "numeric" => "numeric",
            "uuid" => "text(36)",
            _ => "text",
          };
          (col_key.clone(), Column { name, decoder: Decoder::from_raw_type(raw_type), sql_type: sql_type.into() })
        })
        .collect();
      tables.insert(key.clone(), Table { ts_name: key.clone(), db_name, columns, relations: IndexMap::new() });
    }

    let column_name = |tables: &IndexMap<String, Table>, table: &str, key: &str| -> Result<String> {
      tables
        .get(table)
        .and_then(|t| t.columns.get(key))
        .map(|c| c.name.clone())
        .ok_or_else(|| EngineError::internal(format!("Column \"{table}\".\"{key}\" not found for relation")))
    };

    for (table_name, rels) in raw_relations.as_object().into_iter().flatten() {
      let mut relations = IndexMap::new();
      for (key, rel) in rels.as_object().into_iter().flatten() {
        let to = rel.get("to").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let relation_name = rel.get("relationName").and_then(|n| n.as_str()).map(str::to_string);
        if rel.get("type").and_then(|t| t.as_str()) == Some("one") {
          let fields = rel
            .get("fields")
            .and_then(|f| f.as_array())
            .into_iter()
            .flatten()
            .map(|f| {
              column_name(
                &tables,
                f.get("table").and_then(|t| t.as_str()).unwrap_or(""),
                f.get("name").and_then(|n| n.as_str()).unwrap_or(""),
              )
            })
            .collect::<Result<Vec<_>>>()?;
          let references = rel
            .get("references")
            .and_then(|f| f.as_array())
            .into_iter()
            .flatten()
            .map(|r| column_name(&tables, &to, r.as_str().unwrap_or("")))
            .collect::<Result<Vec<_>>>()?;
          relations.insert(
            key.clone(),
            Relation {
              kind: RelationKind::One { fields, references },
              source_table: table_name.clone(),
              referenced_table: to,
              relation_name,
            },
          );
        } else if tables.contains_key(&to) {
          relations.insert(
            key.clone(),
            Relation { kind: RelationKind::Many, source_table: table_name.clone(), referenced_table: to, relation_name },
          );
        }
      }
      if let Some(table) = tables.get_mut(table_name) {
        table.relations = relations;
      }
    }
    Ok(Self { tables })
  }

  /// Reads the live drizzle schema description produced by the harness
  /// (`test/__rs/find/harness.ts` `describeDrizzleSchema`):
  /// `{ [tsName]: { dbName, columns: { [key]: { name, columnType, sqlType, mode?, fromDriver? } },
  ///   relations: { [key]: { type, sourceTable, referencedTable, relationName?, fields?, references? } } } }`
  ///
  /// - `mode`: `column.config.mode` (decides `SQLiteTimestamp` seconds vs ms)
  /// - `fromDriver`: function id of a `SQLiteCustomColumn`'s `mapFrom`
  ///   (absent / `null` when it is not a function)
  /// - relation `type`: `one` (with `fields` / `references`), `one-no-config` or `many`
  pub fn from_json(json: &Json) -> Result<Self> {
    let mut tables = IndexMap::new();
    let str_of = |v: &Json, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let names = |v: Option<&Json>| -> Vec<String> {
      v.and_then(|a| a.as_array()).into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect()
    };
    for (ts_name, t) in json.as_object().ok_or_else(|| EngineError::internal("schema must be an object"))? {
      let columns = t
        .get("columns")
        .and_then(|c| c.as_object())
        .into_iter()
        .flatten()
        .map(|(k, c)| {
          (
            k.clone(),
            Column {
              name: str_of(c, "name"),
              decoder: Decoder::from_column(
                &str_of(c, "columnType"),
                c.get("mode").and_then(|m| m.as_str()),
                c.get("fromDriver").and_then(|f| f.as_u64()).and_then(|f| u32::try_from(f).ok()),
              ),
              sql_type: str_of(c, "sqlType"),
            },
          )
        })
        .collect();
      let relations = t
        .get("relations")
        .and_then(|c| c.as_object())
        .into_iter()
        .flatten()
        .map(|(k, r)| {
          let kind = match str_of(r, "type").as_str() {
            "one" => RelationKind::One { fields: names(r.get("fields")), references: names(r.get("references")) },
            "one-no-config" => RelationKind::OneWithoutConfig,
            _ => RelationKind::Many,
          };
          let relation = Relation {
            kind,
            source_table: str_of(r, "sourceTable"),
            referenced_table: str_of(r, "referencedTable"),
            relation_name: r.get("relationName").and_then(|n| n.as_str()).map(str::to_string),
          };
          (k.clone(), relation)
        })
        .collect();
      tables.insert(
        ts_name.clone(),
        Table { ts_name: ts_name.clone(), db_name: str_of(t, "dbName"), columns, relations },
      );
    }
    Ok(Self { tables })
  }
}
