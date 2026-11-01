//! Port of `packages/drizzle/src/transform/write` (`transformForWrite`):
//! splits incoming document data into the main row, locale rows, array and
//! block rows, relationships, hasMany texts/numbers/selects and the rows to
//! delete or append. See RUST_PORT.md for ownership and porting rules.

pub mod adapter;
pub mod field_path;
pub mod js;
mod small;
mod traverse;
pub mod types;

use payload_engine::error::Result;
use payload_engine::js::JsVal;

pub use adapter::{SchemaWriteAdapter, StaticWriteAdapter, WriteAdapter};
pub use types::{ArrayRowToInsert, BlockRowToInsert, NestedRowToInsert, Row, RowToInsert, RowValue, SqlExpr, encode_value};

use traverse::{Args, Ctx, Level, Shared, traverse_fields};

/// Arguments of `transformForWrite` (index.ts) except `data`.
#[derive(Clone, Copy)]
pub struct TransformForWriteArgs<'a> {
  pub adapter: &'a dyn WriteAdapter,
  pub enable_atomic_writes: bool,
  /// `FlattenedField[]`
  pub fields: &'a JsVal,
  pub parent_is_localized: bool,
  /// Defaults to `''` in TS.
  pub path: &'a str,
  pub table_name: &'a str,
  /// Milliseconds used for `new Date()` (auto `updatedAt`); `None` reads the clock.
  pub now: Option<f64>,
}

/// `transformForWrite`. `data` is mutated in place exactly like the TS
/// implementation mutates its argument (also when an error is returned).
pub fn transform_for_write(args: TransformForWriteArgs<'_>, data: &mut JsVal) -> Result<RowToInsert> {
  let ctx = Ctx { adapter: args.adapter, base_table_name: args.table_name, now: args.now.unwrap_or_else(js::now_ms) };
  let mut out = RowToInsert::default();
  let mut sh = Shared::default();

  {
    let mut lvl = Level {
      arrays: &mut out.arrays,
      arrays_to_push: &mut out.arrays_to_push,
      locales: &mut out.locales,
      row: &mut out.row,
      relationships_to_append: &mut out.relationships_to_append,
    };
    let traverse_args = Args {
      column_prefix: "",
      enable_atomic_writes: args.enable_atomic_writes,
      field_prefix: "",
      fields: args.fields,
      forced_locale: None,
      inside_array_or_block: false,
      parent_is_localized: args.parent_is_localized,
      parent_table_name: args.table_name,
      path: args.path,
      within_array_or_block_locale: None,
    };
    traverse_fields(&ctx, &mut sh, &mut lvl, traverse_args, data)?;
  }

  let Shared {
    blocks,
    blocks_to_delete,
    numbers,
    numbers_to_delete,
    relationships,
    relationships_to_delete,
    selects,
    texts,
    texts_to_delete,
  } = sh;
  out.blocks = blocks;
  out.blocks_to_delete = blocks_to_delete;
  out.numbers = numbers;
  out.numbers_to_delete = numbers_to_delete;
  out.relationships = relationships;
  out.relationships_to_delete = relationships_to_delete;
  out.selects = selects;
  out.texts = texts;
  out.texts_to_delete = texts_to_delete;

  Ok(out)
}
