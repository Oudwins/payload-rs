//! [`Components`] on the sibling ports: payload-mongo-query (`queries/*`,
//! `buildProjectionFromSelect`), payload-mongo-transform (`transform`), payload-mongo-joins
//! (`buildJoinAggregation`, `resolveJoins`) and payload-mongo-schema (`init`'s models).

use payload_engine::error::{EngineError, Result};
use payload_engine::host::Host;
use payload_engine::js::{JsVal, Obj};
use payload_mongo_joins as joins;
use payload_mongo_query as query;
use payload_mongo_transform as transform;
use serde_json::Value as Json;

use crate::components::{
  BuildQueryArgs, Components, JoinAggregationArgs, Operation, ResolveJoinsArgs, SortParamArgs, TransformArgs,
};
use crate::context::{Call, Graph};
use crate::host::{HostOp, LocalBoxFuture, ModelCall, ModelRef, MongoResult, get_session, host_op};
use crate::util::items_mut;

/// The real components. `options` is the `optionsJson` of `MongoEngine.create`.
pub struct Wired {
  transform_env: transform::TransformEnv,
  options: Json,
}

impl Wired {
  pub fn new(graph: &Graph, options: Json) -> Self {
    Wired { transform_env: transform::TransformEnv::new(graph.config().clone()), options }
  }
}

/// `payload.db.defaultIDType` of the MongoDB adapter.
fn default_id_type() -> &'static JsVal {
  static TEXT: std::sync::OnceLock<JsVal> = std::sync::OnceLock::new();
  TEXT.get_or_init(|| JsVal::str("text"))
}

fn query_env<'a>(call: &Call<'a>) -> query::QueryEnv<'a> {
  query::QueryEnv {
    config: call.graph.config(),
    collections: call.graph.root.get("collections"),
    blocks: call.graph.root.get("blocks"),
    default_id_type: default_id_type(),
    disable_fallback_sort: call.ctx.flag("disableFallbackSort").truthy(),
  }
}

/// The reads the query builders make, as host ops of the call.
struct QueryHost<'a, 'c> {
  call: &'a Call<'c>,
}

impl query::QueryHost for QueryHost<'_, '_> {
  fn model_op(&self, op: &query::ModelOp) -> LocalBoxFuture<'static, Result<JsVal>> {
    self.call.host.op(op.to_request())
  }

  fn collection_name(&self, slug: &str) -> Result<JsVal> {
    collection_name_sync(self.call, &ModelRef::Collections(slug.to_string()))
  }
}

/// `Model.collection.name` from the call context.
fn collection_name_sync(call: &Call<'_>, model: &ModelRef) -> Result<JsVal> {
  if !call.ctx.has_model(model) {
    // `adapter.collections[slug].collection` of a missing model
    return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'collection')"));
  }
  call.ctx.collection_name(model).map(JsVal::str).ok_or_else(|| {
    EngineError::internal(format!("the call context has no collection name for model {model:?} (context `models`)"))
  })
}

fn from_joins_model(model: &joins::ModelRef) -> ModelRef {
  match model {
    joins::ModelRef::Collection(slug) => ModelRef::Collections(slug.to_string()),
    joins::ModelRef::Versions(slug) => ModelRef::Versions(slug.to_string()),
    joins::ModelRef::Globals => ModelRef::Globals,
  }
}

async fn build_query_with(call: &Call<'_>, args: BuildQueryArgs<'_>) -> Result<JsVal> {
  let host = QueryHost { call };
  let cx = query::QueryCx::new(query_env(call), &host);
  query::build_query(
    &cx,
    query::BuildQueryArgs {
      collection_slug: args.collection_slug,
      fields: args.fields,
      global_slug: args.global_slug,
      locale: args.locale,
      where_: args.where_,
    },
  )
  .await
}

fn build_sort_with(call: &Call<'_>, args: SortParamArgs<'_>, sort_aggregation: Option<&mut Vec<JsVal>>) -> Result<JsVal> {
  let host = QueryHost { call };
  let cx = query::QueryCx::new(query_env(call), &host);
  query::build_sort_param(
    &cx,
    query::BuildSortArgs {
      fields: args.fields,
      locale: args.locale,
      parent_is_localized: false,
      sort: args.sort,
      sort_aggregation,
      timestamps: args.timestamps,
    },
  )
}

fn projection_with(call: &Call<'_>, fields: &JsVal, select: &JsVal) -> Result<JsVal> {
  let host = QueryHost { call };
  let cx = query::QueryCx::new(query_env(call), &host);
  Ok(query::build_projection_from_select(&cx, fields, select)?.unwrap_or_default())
}

impl Wired {
  fn run_transform(&self, call: &Call<'_>, args: TransformArgs<'_>) -> Result<()> {
    let global_slug = args.global_slug.map(JsVal::str);
    let targs = transform::TransformArgs {
      operation: match args.operation {
        Operation::Read => transform::Operation::Read,
        Operation::Write => transform::Operation::Write,
      },
      fields: args.fields,
      global_slug: global_slug.as_ref(),
      parent_is_localized: false,
      validate_relationships: true,
      use_big_int_for_number_ids: call.ctx.flag("useBigIntForNumberIDs").truthy(),
      allow_additional_keys: call.ctx.flag("allowAdditionalKeys").truthy(),
      now: call.now,
    };
    let empty = || JsVal::obj(Obj::new());
    let with_ops = args.update_ops.is_some();
    let state = transform::TransformState {
      data: std::mem::take(args.data),
      inc: if with_ops { empty() } else { JsVal::Undefined },
      push: if with_ops { empty() } else { JsVal::Undefined },
      add_to_set: if with_ops { empty() } else { JsVal::Undefined },
      pull: if with_ops { empty() } else { JsVal::Undefined },
    };
    let outcome = transform::transform(&self.transform_env, &targs, state);
    *args.data = outcome.state.data;
    if let Some(ops) = args.update_ops {
      let props = |v: &JsVal| v.as_obj().cloned().unwrap_or_default();
      ops.inc = props(&outcome.state.inc);
      ops.push = props(&outcome.state.push);
      ops.add_to_set = props(&outcome.state.add_to_set);
      ops.pull = props(&outcome.state.pull);
    }
    outcome.result.map(|_| ())
  }
}

impl Components for Wired {
  async fn build_query(&self, call: &Call<'_>, args: BuildQueryArgs<'_>) -> MongoResult<JsVal> {
    build_query_with(call, args).await
  }

  fn build_sort_param(
    &self,
    call: &Call<'_>,
    args: SortParamArgs<'_>,
    sort_aggregation: Option<&mut Vec<JsVal>>,
  ) -> MongoResult<JsVal> {
    build_sort_with(call, args, sort_aggregation)
  }

  fn build_projection_from_select(&self, call: &Call<'_>, fields: &JsVal, select: &JsVal) -> MongoResult<JsVal> {
    projection_with(call, fields, select)
  }

  fn transform(&self, call: &Call<'_>, args: TransformArgs<'_>) -> MongoResult<()> {
    self.run_transform(call, args)
  }

  async fn build_join_aggregation(&self, call: &Call<'_>, args: JoinAggregationArgs<'_>) -> MongoResult<Vec<JsVal>> {
    let env = JoinsEnv { call, wired: self };
    let versions = if args.versions { JsVal::Bool(true) } else { JsVal::Undefined };
    joins::build_join_aggregation(
      &env,
      &joins::JoinAggregationArgs {
        collection: args.collection,
        collection_config: args.collection_config,
        drafts_enabled: args.drafts_enabled,
        joins: args.joins,
        locale: args.locale,
        projection: args.projection,
        versions: &versions,
      },
    )
    .await
  }

  async fn resolve_joins(&self, call: &Call<'_>, args: ResolveJoinsArgs<'_>) -> MongoResult<()> {
    let env = JoinsEnv { call, wired: self };
    let resolve_args = joins::ResolveJoinsArgs {
      collection_slug: args.collection_slug,
      joins: args.joins,
      locale: args.locale,
      projection: &JsVal::Undefined,
      versions: args.versions,
    };
    if args.docs.is_nullish() {
      // `docs.length` of `null` / `undefined`
      return Err(EngineError::new(
        "TypeError",
        format!("Cannot read properties of {} (reading 'length')", args.docs.to_js_string()),
      ));
    }
    match items_mut(args.docs) {
      Some(docs) => joins::resolve_joins(&env, docs, &resolve_args).await,
      None => Ok(()),
    }
  }

  fn schema_description(&self, graph: &Graph, host: &dyn Host) -> MongoResult<Json> {
    let options = &self.options;
    let input = payload_mongo_schema::Input {
      config: graph.config(),
      collections: graph.root.get("collections"),
      blocks: graph.root.get("blocks"),
      collections_schema_options: &JsVal::from_json(options.get("collectionsSchemaOptions").unwrap_or(&Json::Null)),
    };
    let schema_options = payload_mongo_schema::Options {
      use_big_int_for_number_ids: options.get("useBigIntForNumberIDs").and_then(Json::as_bool).unwrap_or(false),
      auto_pluralization: options.get("autoPluralization").and_then(Json::as_bool) == Some(true),
      is_cache_enabled: options.get("isCacheEnabled").and_then(Json::as_bool).unwrap_or(false),
    };
    let description = payload_mongo_schema::build_mongo_models(host, input, &schema_options);
    Ok(description.to_json(&graph.root))
  }
}

/// [`joins::JoinsEnv`] of one call.
struct JoinsEnv<'a, 'c> {
  call: &'a Call<'c>,
  wired: &'a Wired,
}

impl joins::JoinsEnv for JoinsEnv<'_, '_> {
  fn config(&self) -> &JsVal {
    self.call.graph.config()
  }

  fn collection_config(&self, slug: &str) -> Option<JsVal> {
    self.call.graph.collection(slug).map(|c| c.get("config").clone())
  }

  fn has_model(&self, model: &joins::ModelRef) -> bool {
    self.call.ctx.has_model(&from_joins_model(model))
  }

  fn use_join_aggregations(&self) -> bool {
    self.call.ctx.use_join_aggregations()
  }

  fn disable_index_hints(&self) -> JsVal {
    self.call.ctx.flag("disableIndexHints").clone()
  }

  fn collation(&self) -> JsVal {
    self.call.ctx.collation().clone()
  }

  fn call_function(&self, function: &JsVal, arg: JsVal) -> Result<JsVal> {
    match function {
      JsVal::Fn(id) => self.call.functions.call_value(*id, &arg),
      _ => Err(EngineError::new("TypeError", format!("{} is not a function", function.to_js_string()))),
    }
  }

  async fn collection_name(&self, model: &joins::ModelRef) -> Result<JsVal> {
    let model = from_joins_model(model);
    if let Some(name) = self.call.ctx.collection_name(&model) {
      return Ok(JsVal::str(name));
    }
    let info = host_op(self.call.host, &HostOp::ModelInfo(model)).await?;
    Ok(info.get("collectionName").clone())
  }

  async fn build_query(&self, args: joins::BuildQueryArgs<'_>) -> Result<JsVal> {
    build_query_with(
      self.call,
      BuildQueryArgs {
        collection_slug: args.collection_slug,
        fields: args.fields,
        global_slug: None,
        locale: args.locale,
        where_: args.where_,
      },
    )
    .await
  }

  async fn model_build_query(&self, model: &joins::ModelRef, locale: &JsVal, where_: &JsVal) -> Result<JsVal> {
    let host = QueryHost { call: self.call };
    let cx = query::QueryCx::new(query_env(self.call), &host);
    let versions_fields;
    let target = match model {
      joins::ModelRef::Collection(slug) => query::ModelRef::Collection(slug),
      joins::ModelRef::Versions(slug) => {
        let is_collection = self.call.graph.collection(slug).is_some();
        versions_fields = if is_collection {
          self.call.graph.collection_version_fields(slug, true)
        } else {
          self.call.graph.global_version_fields(slug, true)
        };
        query::ModelRef::Versions { collection_slug: is_collection.then_some(&**slug), versions_fields: &versions_fields }
      }
      joins::ModelRef::Globals => query::ModelRef::Globals,
    };
    query::schema_build_query(&cx, target, query::SchemaBuildQueryArgs { global_slug: None, locale, where_ }).await
  }

  fn build_sort_param(&self, args: joins::SortParamArgs<'_>) -> Result<joins::SortParam> {
    let mut sort_aggregation = Vec::new();
    let sort = build_sort_with(
      self.call,
      SortParamArgs {
        fields: args.fields,
        locale: args.locale,
        sort: args.sort,
        timestamps: args.timestamps.truthy(),
        versions: args.versions.truthy(),
      },
      args.with_sort_aggregation.then_some(&mut sort_aggregation),
    )?;
    Ok(joins::SortParam { sort, sort_aggregation })
  }

  fn build_projection_from_select(&self, fields: &JsVal, select: &JsVal) -> Result<JsVal> {
    projection_with(self.call, fields, select)
  }

  fn transform_read(&self, data: JsVal, fields: &JsVal) -> Result<JsVal> {
    let mut data = data;
    self.wired.run_transform(
      self.call,
      TransformArgs { data: &mut data, fields, global_slug: None, operation: Operation::Read, update_ops: None },
    )?;
    Ok(data)
  }

  async fn get_session(&self) -> Result<JsVal> {
    get_session(self.call).await
  }

  async fn paginate(&self, args: joins::PaginateArgs) -> Result<JsVal> {
    let model = from_joins_model(&args.model);
    let mut options = args.options;
    let mut call = ModelCall::new(&model, "paginate", Vec::new());
    if let Some(count) = &args.custom_count {
      // `useCustomCountFn` is assigned before `limit` (when present), after the other options
      if let Some(props) = crate::util::props_mut(&mut options) {
        let at = props.get_index_of("limit").unwrap_or(props.len());
        props.shift_insert(at, "useCustomCountFn".into(), JsVal::Undefined);
      }
      call = call.fn_option(1, "useCustomCountFn", from_joins_op(count));
    }
    call.args = vec![args.query, options];
    host_op(self.call.host, &HostOp::Model(call)).await
  }

  fn model_op(&self, op: joins::ModelOp) -> impl Future<Output = Result<JsVal>> {
    self.call.host.op(op.to_request())
  }
}

fn from_joins_op(op: &joins::ModelOp) -> ModelCall {
  let mut call = ModelCall::new(&from_joins_model(&op.model), op.method, op.args.clone());
  call.chain = op.chain.clone();
  call
}
