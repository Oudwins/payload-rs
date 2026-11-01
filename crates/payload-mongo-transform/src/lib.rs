//! Port of `packages/db-mongodb/src/utilities/transform.ts` (Payload ⇄ MongoDB data transform,
//! read and write directions, in place) and the pure db-mongodb utilities (`isObjectID`,
//! `handleError`, `getCollection` / `getGlobal`, `getDBName`), operating on typed values
//! (`ObjectId`, `Date`, `bigint`, ... as [`payload_engine::js::JsVal`]s, MONGO_ENGINE_CONTRACT.md
//! "Values").
//!
//! `transform` mutates its arguments in place, and callers observe that (the documents returned
//! by `find`, the `data` of `create` / `updateOne`, the update operator objects). [`transform`]
//! reproduces it: the roots are imported into a mutable, identity-preserving model
//! ([`value::Val`]), transformed exactly like the TS, and exported back with object identity
//! preserved (an object reachable from two places stays one object; objects the TS keeps stay the
//! input objects). Use [`transform_val`] to run several steps on the same live values.
//!
//! Verified against upstream by replaying recorded upstream calls exactly (values, key order, own
//! `undefined` keys, typed values, sharing, object identity, partial mutations before errors):
//! crates/payload-mongo-transform/tests/replay.rs and tests/utilities.rs, recordings from
//! test/__rs/mongo-transform (record.mjs).
//!
//! Known differences (explicit `Error`s whose message ends in "is not supported by the engine",
//! never silent results):
//! - data that would store an inherited built-in as an own property (a field named after an
//!   `Object.prototype` / `Array.prototype` member, e.g. `constructor`, with no own value: upstream
//!   assigns `ref.constructor = Object`); reading `__proto__`;
//! - observing the internals of `Decimal128` / `Binary` / `Buffer` / `RegExp` / host objects /
//!   functions where upstream would enumerate or read them (malformed documents only);
//! - named (non-index) properties on arrays; data nested deeper than 3000 levels; more than 1000
//!   nested traversals (dotted-key expansions) end in V8's `RangeError: Maximum call stack size
//!   exceeded`, at a depth that need not equal V8's;
//! - `TypeError` messages of degenerate configs (fields that are not arrays) approximate V8's.

pub mod flatten;
pub mod transform;
pub mod utilities;
pub mod value;

use payload_engine::error::Result;
use payload_engine::js::JsVal;

pub use transform::{Operation, Operators, TransformArgs, TransformEnv, bson_error, system_now, transform_val};
pub use utilities::{
  CollectionEntity, DbNameTarget, ModelKind, ModelRef, extract_field_from_message, get_collection, get_db_name, get_global,
  handle_error, handle_host_error, is_object_id,
};
pub use value::{Exporter, Importer, Val};

/// The values `transform` mutates: `data` and the update operator objects (`undefined` when the
/// caller does not pass one).
#[derive(Clone, Debug, Default)]
pub struct TransformState {
  pub data: JsVal,
  pub inc: JsVal,
  pub push: JsVal,
  pub add_to_set: JsVal,
  pub pull: JsVal,
}

/// The state after `transform` (also after a failure: the mutations made before the error was
/// thrown are kept, like in JS) and its result (`null` / `undefined`, or the error thrown).
#[derive(Debug)]
pub struct TransformOutcome {
  pub state: TransformState,
  pub result: Result<JsVal>,
}

/// Runs `transform` on `state`. Values shared between the roots stay shared.
pub fn transform(env: &TransformEnv, args: &TransformArgs<'_>, state: TransformState) -> TransformOutcome {
  let mut importer = Importer::default();
  let imported = (|| -> Result<_> {
    Ok((
      importer.import(&state.data)?,
      Operators {
        inc: importer.import(&state.inc)?,
        push: importer.import(&state.push)?,
        add_to_set: importer.import(&state.add_to_set)?,
        pull: importer.import(&state.pull)?,
      },
    ))
  })();
  let (data, ops) = match imported {
    Ok(v) => v,
    Err(e) => return TransformOutcome { state, result: Err(e) },
  };
  let result = transform_val(env, args, &data, &ops);
  let mut exporter = Exporter::default();
  let exported = (|| -> Result<_> {
    Ok(TransformState {
      data: exporter.export(&data)?,
      inc: exporter.export(&ops.inc)?,
      push: exporter.export(&ops.push)?,
      add_to_set: exporter.export(&ops.add_to_set)?,
      pull: exporter.export(&ops.pull)?,
    })
  })();
  match (exported, result) {
    (Ok(state), result) => TransformOutcome { state, result: result.and_then(|v| exporter.export(&v)) },
    (Err(e), _) => TransformOutcome { state, result: Err(e) },
  }
}

/// `transform({ adapter, data, fields, operation: 'read' })`, returning the transformed `data`.
pub fn transform_read(
  env: &TransformEnv,
  fields: &JsVal,
  data: JsVal,
  use_big_int_for_number_ids: bool,
  allow_additional_keys: bool,
) -> Result<JsVal> {
  let args = TransformArgs {
    operation: Operation::Read,
    fields,
    global_slug: None,
    parent_is_localized: false,
    validate_relationships: true,
    use_big_int_for_number_ids,
    allow_additional_keys,
    now: &system_now,
  };
  let outcome = transform(env, &args, TransformState { data, ..Default::default() });
  outcome.result.map(|_| outcome.state.data)
}
