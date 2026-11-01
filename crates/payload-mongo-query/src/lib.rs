//! Port of `@payloadcms/db-mongodb`'s `queries/*` (`buildQuery`, `parseParams`,
//! `buildAndOrConditions`, `buildSearchParam`, `sanitizeQueryValue`, `buildSortParam`,
//! `getLocalizedSortProperty`, the `Model.buildQuery` static of `getBuildQueryPlugin`) and
//! `utilities/buildProjectionFromSelect.ts`, plus payload's `getLocalizedPaths` / `getFieldByPath`
//! on decoded config values.
//!
//! Payload where / sort / select + field config become the MongoDB filter / sort / projection (and
//! the `$lookup` stages of `sortAggregation`) exactly as the TS hands them to mongoose: typed
//! `ObjectId`s, `Date`s and pass-through user values (same [`JsVal`] identity where the TS passes
//! the same object). The reads the TS makes while building a filter (relationship / join sub
//! queries, `Model.collection.name`) go through [`QueryHost`], in the TS order.
//!
//! Entry points: [`build_query`] (`buildQuery`), [`schema_build_query`] (`Model.buildQuery`),
//! [`build_sort_param`], [`get_localized_sort_property`], [`build_projection_from_select`].

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;

use payload_engine::error::Result;
use payload_engine::js::JsVal;

pub mod js;
pub mod merge;
pub mod paths;
pub mod projection;
pub mod sanitize;
pub mod search;
pub mod sort;

pub use projection::build_projection_from_select;
pub use search::{BuildQueryArgs, ModelRef, SchemaBuildQueryArgs, build_query, parse_params, schema_build_query};
pub use sort::{BuildSortArgs, build_sort_param, get_localized_sort_property};

use crate::js::JsObj;

/// What the builders read from `payload` / the adapter.
#[derive(Clone, Copy)]
pub struct QueryEnv<'a> {
  /// `payload.config` (`localization`, `blocks`, `globals`).
  pub config: &'a JsVal,
  /// `payload.collections`: slug -> `{ config, customIDType }`.
  pub collections: &'a JsVal,
  /// `payload.blocks`: slug -> block.
  pub blocks: &'a JsVal,
  /// `payload.db.defaultIDType` (`'text'` for MongoDB).
  pub default_id_type: &'a JsVal,
  /// `adapter.disableFallbackSort`
  pub disable_fallback_sort: bool,
}

impl<'a> QueryEnv<'a> {
  /// The env of a graph shaped `{ config, collections, blocks, defaultIDType }` (missing
  /// `defaultIDType` reads as `undefined`).
  pub fn from_root(root: &'a JsVal, disable_fallback_sort: bool) -> Self {
    QueryEnv {
      config: root.get("config"),
      collections: root.get("collections"),
      blocks: root.get("blocks"),
      default_id_type: root.get("defaultIDType"),
      disable_fallback_sort,
    }
  }
}

/// A `Model` static call on `adapter.collections[slug]`, awaited once, as the host op
/// `{ op: 'model', model: { kind: 'collections', slug }, method, args, chain }`
/// (MONGO_ENGINE_CONTRACT.md "Host ops"). None of these pass a session (like upstream).
#[derive(Clone, Debug)]
pub struct ModelOp {
  pub slug: String,
  pub method: &'static str,
  pub args: Vec<JsVal>,
  /// Query methods applied in order before the await (`[['lean', []], ['select', [s]]]`).
  pub chain: Vec<(&'static str, Vec<JsVal>)>,
  /// `post: 'toObject'`: the result is hydrated documents the TS reads `doc._id` from; the host
  /// maps them through `doc.toObject()` (non-lean documents do not cross the boundary).
  pub to_object: bool,
}

impl ModelOp {
  /// The host op request object.
  pub fn to_request(&self) -> JsVal {
    let model = JsObj::new().with("kind", JsVal::str("collections")).with("slug", JsVal::str(self.slug.as_str()));
    let chain = self
      .chain
      .iter()
      .map(|(name, args)| JsVal::arr(vec![JsVal::str(*name), JsVal::arr(args.clone())]))
      .collect();
    let request = JsObj::new()
      .with("op", JsVal::str("model"))
      .with("model", model.into_val())
      .with("method", JsVal::str(self.method))
      .with("args", JsVal::arr(self.args.clone()))
      .with("chain", JsVal::arr(chain));
    if self.to_object {
      request.with("post", JsVal::str("toObject")).into_val()
    } else {
      request.into_val()
    }
  }
}

pub type LocalBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// The JS side the builders read the database through.
pub trait QueryHost {
  /// Issues a model query (when called, like the TS expression `Model.find(...)`) and returns the
  /// future of its awaited result. The builders await each one before issuing the next, in the TS
  /// order.
  fn model_op(&self, op: &ModelOp) -> LocalBoxFuture<'static, Result<JsVal>>;
  /// `adapter.collections[slug].collection.name` (read synchronously by `buildSortParam`).
  fn collection_name(&self, slug: &str) -> Result<JsVal>;
}

/// An in-place assignment the TS makes to an object it was given (`object[key] = value`), which
/// the caller's original object must receive too. `object` is the decoded argument value (compare
/// with [`JsVal::identity`]); `key` is a property name or array index.
#[derive(Clone, Debug)]
pub struct Mutation {
  pub object: JsVal,
  pub key: String,
  pub value: JsVal,
}

/// One builder call: env, host and the argument mutations it made.
pub struct QueryCx<'a> {
  pub env: QueryEnv<'a>,
  pub host: &'a dyn QueryHost,
  mutations: RefCell<Vec<Mutation>>,
  depth: Cell<usize>,
  /// Stack address when the outermost level was entered.
  stack_base: Cell<usize>,
}

/// Nesting depth (of `and` / `or` conditions, relationship hops, `select` objects) past which the
/// builders throw V8's stack overflow `RangeError` instead of overflowing the native stack.
pub const MAX_NESTING: usize = 2000;

/// Native stack the recursion may use below the outermost level before throwing that `RangeError`
/// (like V8, which limits stack usage, not depth; debug builds use ~12 KiB per `and` level).
/// Only wheres / selects nested this deep can differ from the TS (in whether / where they throw).
pub const STACK_BUDGET: usize = 1 << 20;

#[inline(never)]
fn stack_address() -> usize {
  let marker = 0u8;
  std::hint::black_box(&marker) as *const u8 as usize
}

/// Leaves one nesting level when dropped (see [`QueryCx::enter`]).
pub(crate) struct DepthGuard<'c>(&'c Cell<usize>);

impl Drop for DepthGuard<'_> {
  fn drop(&mut self) {
    self.0.set(self.0.get().saturating_sub(1));
  }
}

impl<'a> QueryCx<'a> {
  pub fn new(env: QueryEnv<'a>, host: &'a dyn QueryHost) -> Self {
    QueryCx { env, host, mutations: RefCell::new(Vec::new()), depth: Cell::new(0), stack_base: Cell::new(0) }
  }

  /// Enters one nesting level (`RangeError` past [`MAX_NESTING`]).
  pub(crate) fn enter(&self) -> Result<DepthGuard<'_>> {
    let here = stack_address();
    if self.depth.get() == 0 {
      self.stack_base.set(here);
    }
    if self.depth.get() >= MAX_NESTING || self.stack_base.get().abs_diff(here) > STACK_BUDGET {
      return Err(payload_engine::error::EngineError::new("RangeError", "Maximum call stack size exceeded"));
    }
    self.depth.set(self.depth.get() + 1);
    Ok(DepthGuard(&self.depth))
  }

  pub(crate) fn mutated(&self, object: &JsVal, key: impl Into<String>, value: JsVal) {
    self.mutations.borrow_mut().push(Mutation { object: object.clone(), key: key.into(), value });
  }

  /// The argument mutations made so far (in order), clearing the list.
  pub fn take_mutations(&self) -> Vec<Mutation> {
    std::mem::take(&mut self.mutations.borrow_mut())
  }

  /// `payload.config.localization`
  pub(crate) fn localization(&self) -> &JsVal {
    self.env.config.get("localization")
  }

  /// `payload.collections[slug]`
  pub(crate) fn collection(&self, slug: &str) -> &JsVal {
    self.env.collections.get(slug)
  }

  /// `payload.collections[slug]?.customIDType`
  pub(crate) fn custom_id_type(&self, slug: &str) -> &JsVal {
    self.collection(slug).get("customIDType")
  }
}
