//! What the ported modules take from the rest of `@payloadcms/db-mongodb` and from mongoose,
//! behind one trait so the modules stay a 1:1 translation of their TS sources.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use payload_engine::error::{EngineError, Result};
use payload_engine::js::JsVal;

use crate::util::{obj, s};

/// Which mongoose model of the adapter (`adapter.collections[slug]`, `adapter.versions[slug]`,
/// `adapter.globals`), resolved by the host when an op runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelRef {
  Collection(Arc<str>),
  Versions(Arc<str>),
  Globals,
}

impl ModelRef {
  /// The contract's `model` object: `{ kind, slug? }`.
  pub fn to_js(&self) -> JsVal {
    match self {
      ModelRef::Collection(slug) => obj([("kind", s("collections")), ("slug", s(slug.clone()))]),
      ModelRef::Versions(slug) => obj([("kind", s("versions")), ("slug", s(slug.clone()))]),
      ModelRef::Globals => obj([("kind", s("globals"))]),
    }
  }
}

/// One mongoose model call: `Model[method](...args)` with `chain` applied in order, awaited once
/// (MONGO_ENGINE_CONTRACT.md "Host ops", `{"op": "model"}`).
#[derive(Clone, Debug)]
pub struct ModelOp {
  pub model: ModelRef,
  pub method: &'static str,
  pub args: Vec<JsVal>,
  pub chain: Vec<(&'static str, Vec<JsVal>)>,
}

impl ModelOp {
  pub fn new(model: ModelRef, method: &'static str, args: Vec<JsVal>) -> Self {
    ModelOp { model, method, args, chain: Vec::new() }
  }

  pub fn chain(mut self, method: &'static str, args: Vec<JsVal>) -> Self {
    self.chain.push((method, args));
    self
  }

  /// The contract request `{ op: 'model', model, method, args, chain }`.
  pub fn to_request(&self) -> JsVal {
    obj([
      ("op", s("model")),
      ("model", self.model.to_js()),
      ("method", s(self.method)),
      ("args", JsVal::arr(self.args.clone())),
      (
        "chain",
        JsVal::arr(self.chain.iter().map(|(m, a)| JsVal::arr(vec![s(*m), JsVal::arr(a.clone())])).collect()),
      ),
    ])
  }
}

/// `buildQuery({ adapter, collectionSlug, fields, locale, where })` (queries/buildQuery.ts).
pub struct BuildQueryArgs<'a> {
  pub collection_slug: Option<&'a str>,
  pub fields: &'a JsVal,
  pub locale: &'a JsVal,
  pub where_: &'a JsVal,
}

/// `buildSortParam({ adapter, config, fields, locale, sort, sortAggregation, timestamps, versions })`
/// (queries/buildSortParam.ts).
pub struct SortParamArgs<'a> {
  pub fields: &'a JsVal,
  pub locale: &'a JsVal,
  pub sort: &'a JsVal,
  pub timestamps: &'a JsVal,
  /// `versions` (`undefined` when the caller does not pass it)
  pub versions: &'a JsVal,
  /// Whether the caller passes a `sortAggregation` array (relationship sorts push `$lookup`
  /// stages into it; without it they are not resolved).
  pub with_sort_aggregation: bool,
}

/// What `buildSortParam` returns, plus the stages it pushed into `sortAggregation`.
pub struct SortParam {
  pub sort: JsVal,
  pub sort_aggregation: Vec<JsVal>,
}

/// `Model.paginate(query, options)` (mongoose-paginate-v2). `options` is the TS
/// `paginationOptions` without `useCustomCountFn`; `custom_count` is the model call that function
/// returns (`() => Promise.resolve(Model.countDocuments(...))`), when the TS sets it.
pub struct PaginateArgs {
  pub model: ModelRef,
  pub query: JsVal,
  pub options: JsVal,
  pub custom_count: Option<ModelOp>,
}

/// The adapter, its payload instance and the modules the ported code imports.
///
/// Implementations must hand host ops to JS in the order the methods are called (an op may be
/// issued when its future is created or when it is first polled: the ported code polls futures
/// in creation order).
#[allow(async_fn_in_trait)]
pub trait JoinsEnv {
  /// `adapter.payload.config`
  fn config(&self) -> &JsVal;
  /// `adapter.payload.collections[slug]?.config` (`None` when the collection does not exist).
  fn collection_config(&self, slug: &str) -> Option<JsVal>;
  /// Whether the model exists (`adapter.collections[slug]` / `adapter.versions[slug]`).
  fn has_model(&self, model: &ModelRef) -> bool;
  /// `adapter.useJoinAggregations`
  fn use_join_aggregations(&self) -> bool;
  /// `adapter.disableIndexHints`
  fn disable_index_hints(&self) -> JsVal;
  /// `adapter.collation`
  fn collation(&self) -> JsVal;
  /// Calls a config function (`join.getForeignPath`) with one argument.
  fn call_function(&self, function: &JsVal, arg: JsVal) -> Result<JsVal>;

  /// `Model.collection.name`
  async fn collection_name(&self, model: &ModelRef) -> Result<JsVal>;
  /// `buildQuery(...)` (queries/buildQuery.ts)
  async fn build_query(&self, args: BuildQueryArgs<'_>) -> Result<JsVal>;
  /// `Model.buildQuery({ locale, payload, where })`, the static of `getBuildQueryPlugin`.
  async fn model_build_query(&self, model: &ModelRef, locale: &JsVal, where_: &JsVal) -> Result<JsVal>;
  /// `buildSortParam(...)` (queries/buildSortParam.ts)
  fn build_sort_param(&self, args: SortParamArgs<'_>) -> Result<SortParam>;
  /// `buildProjectionFromSelect({ adapter, fields, select })`
  fn build_projection_from_select(&self, fields: &JsVal, select: &JsVal) -> Result<JsVal>;
  /// `transform({ adapter, data, fields, operation: 'read' })`; returns the transformed data.
  fn transform_read(&self, data: JsVal, fields: &JsVal) -> Result<JsVal>;
  /// `getSession(adapter, req)`: a host object handle or `undefined`.
  async fn get_session(&self) -> Result<JsVal>;
  /// `Model.paginate(query, options)`
  async fn paginate(&self, args: PaginateArgs) -> Result<JsVal>;
  /// Runs one model call on the host.
  fn model_op(&self, op: ModelOp) -> impl Future<Output = Result<JsVal>>;
}

/// `getCollection({ adapter, collectionSlug, versions })` (utilities/getEntity.ts): the
/// collection config and its model.
pub fn get_collection<E: JoinsEnv>(env: &E, slug: &str, versions: bool) -> Result<(JsVal, ModelRef)> {
  let Some(config) = env.collection_config(slug) else {
    return Err(EngineError::api(format!(
      "ERROR: Failed to retrieve collection with the slug \"{slug}\". Does not exist."
    )));
  };
  let model = if versions { ModelRef::Versions(slug.into()) } else { ModelRef::Collection(slug.into()) };
  if !env.has_model(&model) {
    return Err(EngineError::api(if versions {
      format!("ERROR: Failed to retrieve collection version model with the slug \"{slug}\". Does not exist.")
    } else {
      format!("ERROR: Failed to retrieve collection model with the slug \"{slug}\". Does not exist.")
    }));
  }
  Ok((config, model))
}

/// `Promise.all(futures)`: polls every future in order until all are done; the result is the
/// first error (in completion order) or every output in order. Futures that are still running
/// when another one fails keep running to completion, like the promises in JS.
pub async fn join_all<T, F: Future<Output = Result<T>>>(futures: Vec<F>) -> Result<Vec<T>> {
  let mut futures: Vec<Pin<Box<F>>> = futures.into_iter().map(Box::pin).collect();
  let mut outputs: Vec<Option<T>> = futures.iter().map(|_| None).collect();
  let mut done = vec![false; futures.len()];
  let mut first_error: Option<EngineError> = None;
  std::future::poll_fn(move |cx: &mut Context<'_>| {
    for i in 0..futures.len() {
      if done[i] {
        continue;
      }
      if let Poll::Ready(result) = futures[i].as_mut().poll(cx) {
        done[i] = true;
        match result {
          Ok(value) => outputs[i] = Some(value),
          Err(error) => {
            first_error.get_or_insert(error);
          }
        }
      }
    }
    if done.iter().any(|d| !d) {
      return Poll::Pending;
    }
    if let Some(error) = first_error.take() {
      return Poll::Ready(Err(error));
    }
    Poll::Ready(Ok(outputs.iter_mut().map(|o| o.take().expect("every future completed")).collect()))
  })
  .await
}

/// `Promise.all([a, b])`
pub async fn join2<A, B>(a: impl Future<Output = Result<A>>, b: impl Future<Output = Result<B>>) -> Result<(A, B)> {
  enum Either<A, B> {
    A(A),
    B(B),
  }
  let a = async move { a.await.map(Either::A) };
  let b = async move { b.await.map(Either::B) };
  let futures: Vec<Pin<Box<dyn Future<Output = Result<Either<A, B>>>>>> = vec![Box::pin(a), Box::pin(b)];
  let mut out = join_all(futures).await?.into_iter();
  match (out.next(), out.next()) {
    (Some(Either::A(a)), Some(Either::B(b))) => Ok((a, b)),
    _ => Err(EngineError::internal("join2: outputs out of order")),
  }
}
