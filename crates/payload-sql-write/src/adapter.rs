//! The parts of `DrizzleAdapter` read by the write transform.

use indexmap::IndexMap;
use payload_engine::js::JsVal;
use payload_engine::sql::schema::RawSchema;

/// Adapter state used by `transformForWrite`.
pub trait WriteAdapter {
  /// `adapter.name` (`'sqlite'`, `'postgres'`, ...)
  fn name(&self) -> &str;
  /// `adapter.blocksAsJSON`
  fn blocks_as_json(&self) -> bool;
  /// `adapter.tableNameMap.get(key)`
  fn table_name(&self, key: &str) -> Option<&str>;
  /// `Boolean(adapter.tables[table]._uuid)`, `None` when `adapter.tables[table]` is undefined.
  fn table_has_uuid(&self, table: &str) -> Option<bool>;
  /// `adapter.payload.config.blocks`
  fn config_blocks(&self) -> &JsVal;
  /// `block[InternalBlockTableNameIndex]`
  fn block_table_name_index(&self, block: &JsVal) -> Option<u32>;
}

/// [`WriteAdapter`] over the Rust raw schema. `config` must be the same decoded
/// config value the schema was built from (block identities are shared).
pub struct SchemaWriteAdapter<'a> {
  pub schema: &'a RawSchema,
  pub config: &'a JsVal,
  pub name: &'a str,
  pub blocks_as_json: bool,
}

impl WriteAdapter for SchemaWriteAdapter<'_> {
  fn name(&self) -> &str {
    self.name
  }

  fn blocks_as_json(&self) -> bool {
    self.blocks_as_json
  }

  fn table_name(&self, key: &str) -> Option<&str> {
    self.schema.table_name_map.get(key).map(String::as_str)
  }

  fn table_has_uuid(&self, table: &str) -> Option<bool> {
    self.schema.raw_tables.get(table)?.as_ref().map(|t| t.columns.contains_key("_uuid"))
  }

  fn config_blocks(&self) -> &JsVal {
    self.config.get("blocks")
  }

  fn block_table_name_index(&self, block: &JsVal) -> Option<u32> {
    self.schema.block_table_name_index.get(&block.identity()?).copied()
  }
}

/// [`WriteAdapter`] from plain data, e.g. captured adapter state.
#[derive(Debug, Default)]
pub struct StaticWriteAdapter {
  pub name: String,
  pub blocks_as_json: bool,
  pub table_name_map: IndexMap<String, String>,
  /// Every key of `adapter.tables` → whether the table has a `_uuid` column.
  pub tables: IndexMap<String, bool>,
  pub config_blocks: JsVal,
  /// Key under which block objects carry their `InternalBlockTableNameIndex`.
  pub block_index_key: Option<String>,
}

impl WriteAdapter for StaticWriteAdapter {
  fn name(&self) -> &str {
    &self.name
  }

  fn blocks_as_json(&self) -> bool {
    self.blocks_as_json
  }

  fn table_name(&self, key: &str) -> Option<&str> {
    self.table_name_map.get(key).map(String::as_str)
  }

  fn table_has_uuid(&self, table: &str) -> Option<bool> {
    self.tables.get(table).copied()
  }

  fn config_blocks(&self) -> &JsVal {
    &self.config_blocks
  }

  fn block_table_name_index(&self, block: &JsVal) -> Option<u32> {
    block.get(self.block_index_key.as_deref()?).as_num().map(|n| n as u32)
  }
}
