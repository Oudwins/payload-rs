//! The write methods: `create.ts`, `createGlobal.ts`, `createVersion.ts`,
//! `createGlobalVersion.ts`, `updateOne.ts`, `upsert.ts`, `updateMany.ts`, `updateGlobal.ts`,
//! `updateVersion.ts`, `updateGlobalVersion.ts`, `updateJobs.ts`, `deleteOne.ts`, `deleteMany.ts`,
//! `deleteVersions.ts`.
//!
//! Every method returns the result and the caller's `data` / `versionData` as the method left it
//! (the TS mutates the caller's object: `createdAt`, the write transform, `_id`, ...).

use payload_engine::error::EngineError;
use payload_engine::js::{JsVal, Obj};

use crate::components::{BuildQueryArgs, Components, Operation, SortParamArgs, TransformArgs, UpdateOps};
use crate::context::Call;
use crate::entity::{get_collection, get_global, handle_error, is_valid_object_id_string, new_object_id};
use crate::host::{HostOp, ModelCall, ModelRef, MongoResult, get_session, host_op};
use crate::read::{empty_obj, model_op, or, or_default, slug_arg};
use crate::util::{
  delete, gt_num, has_near_constraint, is_num, new_date, now_iso, obj, read, set, spread_into,
};

/// A method's outcome: the result (or error) and the argument it mutates (`[key, value]` as the
/// method left it, also after a failure).
pub struct WriteOutcome {
  pub result: MongoResult<JsVal>,
  pub mutated: Option<(&'static str, JsVal)>,
}

impl WriteOutcome {
  pub fn plain(result: MongoResult<JsVal>) -> Self {
    Self { result, mutated: None }
  }
}

/// Generates the public method: owns the mutated argument, runs the body on it, and reports it.
macro_rules! mutating {
  ($name:ident, $inner:ident, $key:literal $(, $extra:expr)?) => {
    pub async fn $name<C: Components>(components: &C, call: &Call<'_>, args: &JsVal) -> WriteOutcome {
      let mut value = args.get($key).clone();
      let result = $inner(components, call, args, &mut value $(, $extra)?).await;
      WriteOutcome { result, mutated: Some(($key, value)) }
    }
  };
}

/// `if (!data.createdAt) data.createdAt = new Date().toISOString()`
fn default_created_at(call: &Call<'_>, data: &mut JsVal) -> MongoResult<()> {
  if !read(data, "createdAt")?.truthy() {
    set(data, "createdAt", JsVal::str(now_iso((call.now)())?))?;
  }
  Ok(())
}

/// The first element of an array result (`const [doc] = await Model.create([data], options)`).
fn first(value: &JsVal) -> JsVal {
  value.as_arr().and_then(|items| items.first().cloned()).unwrap_or_default()
}

fn create_options(session: JsVal) -> JsVal {
  obj([("session", session), ("timestamps", JsVal::Bool(false))])
}

mutating!(create, create_inner, "data");

async fn create_inner<C: Components>(
  components: &C,
  call: &Call<'_>,
  args: &JsVal,
  data: &mut JsVal,
) -> MongoResult<JsVal> {
  let collection_slug = slug_arg(args, "collection");
  let custom_id = args.get("customID").clone();
  let returning = args.get("returning").clone();

  let entity = get_collection(call, &collection_slug, false)?;
  let collection_config = entity.config;

  default_created_at(call, &mut *data)?;

  components.transform(
    call,
    TransformArgs {
      data: &mut *data,
      fields: collection_config.get("fields"),
      global_slug: None,
      operation: Operation::Write,
      update_ops: None,
    },
  )?;

  if entity.custom_id_type.truthy() {
    let id = data.get("id").clone();
    set(&mut *data, "_id", id)?;
  } else if custom_id.truthy() {
    let id = match &custom_id {
      JsVal::Str(s) if is_valid_object_id_string(s) => new_object_id(&custom_id)?,
      _ => custom_id.clone(),
    };
    set(&mut *data, "_id", id)?;
  } else if call.ctx.flag("allowIDOnCreate").truthy() && data.get("id").truthy() {
    match new_object_id(data.get("id")) {
      Ok(id) => set(&mut *data, "_id", id)?,
      Err(error) => {
        let shown = serde_json::to_string(&data.get("id").to_json()).unwrap_or_default();
        host_op(
          call.host,
          &HostOp::LogError {
            msg: format!(
              "It appears you passed ID to create operation data but it cannot be sanitized to ObjectID, value - {shown}"
            ),
          },
        )
        .await?;
        return Err(error.into());
      }
    }
  }

  let session = get_session(call).await?;
  let options = create_options(session);
  let created = model_op(
    call,
    ModelCall::new(&entity.model, "create", vec![JsVal::arr(vec![data.clone()]), options]).to_object(),
  )
  .await
  .map_err(|error| handle_error(call, error, Some(&collection_slug), None))?;

  if matches!(returning, JsVal::Bool(false)) {
    return Ok(JsVal::Null);
  }
  let mut doc = first(&created);
  components.transform(
    call,
    TransformArgs {
      data: &mut doc,
      fields: collection_config.get("fields"),
      global_slug: None,
      operation: Operation::Read,
      update_ops: None,
    },
  )?;
  Ok(doc)
}

mutating!(create_global, create_global_inner, "data");

async fn create_global_inner<C: Components>(
  components: &C,
  call: &Call<'_>,
  args: &JsVal,
  data: &mut JsVal,
) -> MongoResult<JsVal> {
  let global_slug = slug_arg(args, "slug");
  let returning = args.get("returning").clone();

  let entity = get_global(call, &global_slug, false)?;
  default_created_at(call, &mut *data)?;

  components.transform(
    call,
    TransformArgs {
      data: &mut *data,
      fields: entity.config.get("fields"),
      global_slug: Some(&global_slug),
      operation: Operation::Write,
      update_ops: None,
    },
  )?;

  let session = get_session(call).await?;
  let created = model_op(
    call,
    ModelCall::new(&entity.model, "create", vec![JsVal::arr(vec![data.clone()]), create_options(session)]).to_object(),
  )
  .await?;
  if matches!(returning, JsVal::Bool(false)) {
    return Ok(JsVal::Null);
  }
  let mut result = first(&created);
  components.transform(
    call,
    TransformArgs { data: &mut result, fields: entity.config.get("fields"), global_slug: None, operation: Operation::Read, update_ops: None },
  )?;
  Ok(result)
}

// `createVersion.ts` / `createGlobalVersion.ts`
mutating!(create_version, create_version_inner, "versionData", false);
mutating!(create_global_version, create_version_inner, "versionData", true);

async fn create_version_inner<C: Components>(
  components: &C,
  call: &Call<'_>,
  args: &JsVal,
  version_data: &mut JsVal,
  global: bool,
) -> MongoResult<JsVal> {
  let (model, fields) = if global {
    let slug = slug_arg(args, "globalSlug");
    let entity = get_global(call, &slug, true)?;
    (entity.model, call.graph.global_version_fields(&slug, false))
  } else {
    let slug = slug_arg(args, "collectionSlug");
    let entity = get_collection(call, &slug, true)?;
    (entity.model, call.graph.collection_version_fields(&slug, false))
  };
  let returning = args.get("returning").clone();

  let mut data = Obj::new();
  data.insert("autosave".into(), args.get("autosave").clone());
  data.insert("createdAt".into(), args.get("createdAt").clone());
  data.insert("latest".into(), JsVal::Bool(true));
  if !global {
    data.insert("parent".into(), args.get("parent").clone());
  }
  data.insert("publishedLocale".into(), args.get("publishedLocale").clone());
  data.insert("snapshot".into(), args.get("snapshot").clone());
  data.insert("updatedAt".into(), args.get("updatedAt").clone());
  data.insert("version".into(), version_data.clone());
  let mut data = JsVal::obj(data);
  default_created_at(call, &mut data)?;

  let transformed = components.transform(
    call,
    TransformArgs { data: &mut data, fields: &fields, global_slug: None, operation: Operation::Write, update_ops: None },
  );
  // the caller's `versionData` is `data.version` (the same object)
  *version_data = data.get("version").clone();
  transformed?;

  let session = get_session(call).await?;
  let options = create_options(session);
  let created =
    model_op(call, ModelCall::new(&model, "create", vec![JsVal::arr(vec![data.clone()]), options.clone()]).to_object())
      .await?;
  let mut doc = first(&created);

  let mut and = vec![obj([("_id", obj([("$ne", read(&doc, "_id")?.clone())]))])];
  if !global {
    and.push(obj([("$or", JsVal::arr(vec![obj([("parent", obj([("$eq", data.get("parent").clone())]))])]))]));
  }
  and.push(obj([("latest", obj([("$eq", JsVal::Bool(true))]))]));
  if !global {
    and.push(obj([("updatedAt", obj([("$lt", new_date(doc.get("updatedAt")))]))]));
  }
  model_op(
    call,
    ModelCall::new(
      &model,
      "updateMany",
      vec![obj([("$and", JsVal::arr(and))]), obj([("$unset", obj([("latest", JsVal::Num(1.0))]))]), options],
    ),
  )
  .await?;

  if matches!(returning, JsVal::Bool(false)) {
    return Ok(JsVal::Null);
  }
  components.transform(
    call,
    TransformArgs { data: &mut doc, fields: &fields, global_slug: None, operation: Operation::Read, update_ops: None },
  )?;
  Ok(doc)
}

/// `transform({ $addToSet, $inc, $pull, $push, ..., operation: 'write' })` then the update document:
/// the operators that were filled, with `$set: data`, or `data` itself.
fn write_with_operators<C: Components>(
  components: &C,
  call: &Call<'_>,
  data: &mut JsVal,
  fields: &JsVal,
) -> MongoResult<JsVal> {
  let mut ops = UpdateOps::default();
  components.transform(
    call,
    TransformArgs { data, fields, global_slug: None, operation: Operation::Write, update_ops: Some(&mut ops) },
  )?;
  let mut update_ops = Obj::new();
  if !ops.inc.is_empty() {
    update_ops.insert("$inc".into(), JsVal::obj(ops.inc));
  }
  if !ops.push.is_empty() {
    update_ops.insert("$push".into(), JsVal::obj(ops.push));
  }
  if !ops.add_to_set.is_empty() {
    update_ops.insert("$addToSet".into(), JsVal::obj(ops.add_to_set));
  }
  if !ops.pull.is_empty() {
    update_ops.insert("$pull".into(), JsVal::obj(ops.pull));
  }
  if update_ops.is_empty() {
    return Ok(data.clone());
  }
  update_ops.insert("$set".into(), data.clone());
  Ok(JsVal::obj(update_ops))
}

/// `{ ...optionsArgs, session, timestamps: false }`
fn base_options(options_args: &JsVal, session: JsVal) -> Obj {
  let mut out = Obj::new();
  spread_into(&mut out, options_args);
  out.insert("session".into(), session);
  out.insert("timestamps".into(), JsVal::Bool(false));
  out
}

/// `{ ...baseOptions, lean: true, projection, returnDocument: 'after' }` (`returnDocument` only when
/// given).
fn find_options(base: &Obj, projection: Option<JsVal>, return_after: bool) -> Obj {
  let mut out = base.clone();
  out.insert("lean".into(), JsVal::Bool(true));
  if let Some(projection) = projection {
    out.insert("projection".into(), projection);
  }
  if return_after {
    out.insert("returnDocument".into(), JsVal::str("after"));
  }
  out
}

/// `{ ...findOptions, ...extra }`
fn extend(base: &Obj, extra: Vec<(&str, JsVal)>) -> JsVal {
  let mut out = base.clone();
  for (k, v) in extra {
    out.insert(k.to_string(), v);
  }
  JsVal::obj(out)
}

mutating!(update_one, update_one_inner, "data");

async fn update_one_inner<C: Components>(
  components: &C,
  call: &Call<'_>,
  args: &JsVal,
  data: &mut JsVal,
) -> MongoResult<JsVal> {
  let id = args.get("id").clone();
  let collection_slug = slug_arg(args, "collection");
  let locale = args.get("locale").clone();
  let options_args = or_default(args.get("options"), empty_obj);
  let returning = args.get("returning").clone();
  let select = args.get("select").clone();
  let where_arg = or_default(args.get("where"), empty_obj);

  let entity = get_collection(call, &collection_slug, false)?;
  let collection_config = entity.config;
  let where_ = if id.truthy() { obj([("id", obj([("equals", id.clone())]))]) } else { where_arg };
  let fields = collection_config.get("fields");

  let query = components
    .build_query(
      call,
      BuildQueryArgs {
        collection_slug: Some(&collection_slug),
        fields: collection_config.get("flattenedFields"),
        global_slug: None,
        locale: &locale,
        where_: &where_,
      },
    )
    .await?;

  let update_data = write_with_operators(components, call, &mut *data, fields)?;

  let session = get_session(call).await?;
  let base = base_options(&options_args, session);
  let projection = components.build_projection_from_select(call, collection_config.get("flattenedFields"), &select)?;
  let find = find_options(&base, Some(projection), true);

  let outcome: MongoResult<Option<JsVal>> = async {
    if matches!(returning, JsVal::Bool(false)) {
      model_op(call, ModelCall::new(&entity.model, "updateOne", vec![query.clone(), update_data.clone(), JsVal::obj(base)]))
        .await?;
      components.transform(
        call,
        TransformArgs { data: &mut *data, fields, global_slug: None, operation: Operation::Read, update_ops: None },
      )?;
      return Ok(None);
    }
    let result =
      model_op(call, ModelCall::new(&entity.model, "findOneAndUpdate", vec![query.clone(), update_data.clone(), JsVal::obj(find)]))
        .await?;
    Ok(Some(result))
  }
  .await;
  let result = match outcome {
    Ok(Some(result)) => result,
    Ok(None) => return Ok(JsVal::Null),
    Err(error) => return Err(handle_error(call, error, Some(&collection_slug), None)),
  };

  if !result.truthy() {
    return Ok(JsVal::Null);
  }
  let mut result = result;
  components.transform(
    call,
    TransformArgs { data: &mut result, fields, global_slug: None, operation: Operation::Read, update_ops: None },
  )?;
  Ok(result)
}

/// `upsert.ts`: `this.updateOne({ collection, data, locale, options: { upsert: true }, req, returning,
/// select, where })` through the adapter object.
pub async fn upsert(call: &Call<'_>, args: &JsVal) -> MongoResult<JsVal> {
  let mut forwarded = Obj::new();
  forwarded.insert("collection".into(), args.get("collection").clone());
  forwarded.insert("data".into(), args.get("data").clone());
  forwarded.insert("locale".into(), args.get("locale").clone());
  forwarded.insert("options".into(), obj([("upsert", JsVal::Bool(true))]));
  forwarded.insert("returning".into(), args.get("returning").clone());
  forwarded.insert("select".into(), args.get("select").clone());
  forwarded.insert("where".into(), args.get("where").clone());
  host_op(
    call.host,
    &HostOp::AdapterCall {
      method: "updateOne",
      args: JsVal::obj(forwarded),
      from_call_args: &["collection", "data", "locale", "returning", "select", "where"],
    },
  )
  .await
}

mutating!(update_many, update_many_inner, "data");

async fn update_many_inner<C: Components>(
  components: &C,
  call: &Call<'_>,
  args: &JsVal,
  data: &mut JsVal,
) -> MongoResult<JsVal> {
  let collection_slug = slug_arg(args, "collection");
  let limit = args.get("limit").clone();
  let locale = args.get("locale").clone();
  let options_args = or_default(args.get("options"), empty_obj);
  let returning = args.get("returning").clone();
  let select = args.get("select").clone();
  let sort_arg = args.get("sort").clone();
  let where_ = args.get("where").clone();

  let has_near = if where_.truthy() { has_near_constraint(&where_)? } else { false };
  let entity = get_collection(call, &collection_slug, false)?;
  let collection_config = entity.config;

  let mut sort = JsVal::Undefined;
  if !has_near {
    sort = components.build_sort_param(
      call,
      SortParamArgs {
        fields: collection_config.get("flattenedFields"),
        locale: &locale,
        sort: &or(&sort_arg, collection_config.get("defaultSort")),
        timestamps: true,
        versions: false,
      },
      None,
    )?;
  }

  let mut query = components
    .build_query(
      call,
      BuildQueryArgs {
        collection_slug: Some(&collection_slug),
        fields: collection_config.get("flattenedFields"),
        global_slug: None,
        locale: &locale,
        where_: &where_,
      },
    )
    .await?;

  let update_data = write_with_operators(components, call, &mut *data, collection_config.get("fields"))?;

  let session = get_session(call).await?;
  let base = base_options(&options_args, session);
  let projection = components.build_projection_from_select(call, collection_config.get("flattenedFields"), &select)?;
  let find = find_options(&base, Some(projection), false);

  let outcome: MongoResult<bool> = async {
    if matches!(limit, JsVal::Num(_)) && gt_num(&limit, 0.0) {
      let documents = model_op(
        call,
        ModelCall::new(
          &entity.model,
          "find",
          vec![
            query.clone(),
            empty_obj(),
            extend(&find, vec![("limit", limit.clone()), ("projection", obj([("_id", JsVal::Num(1.0))])), ("sort", sort.clone())]),
          ],
        ),
      )
      .await?;
      if documents.as_arr().is_some_and(<[JsVal]>::is_empty) {
        return Ok(false);
      }
      query = obj([("_id", obj([("$in", ids_of(&documents)?)]))]);
    }
    model_op(call, ModelCall::new(&entity.model, "updateMany", vec![query.clone(), update_data.clone(), JsVal::obj(base.clone())]))
      .await?;
    Ok(true)
  }
  .await;
  match outcome {
    Ok(true) => {}
    Ok(false) => return Ok(JsVal::Null),
    Err(error) => return Err(handle_error(call, error, Some(&collection_slug), None)),
  }

  if matches!(returning, JsVal::Bool(false)) {
    return Ok(JsVal::Null);
  }
  let mut result =
    model_op(call, ModelCall::new(&entity.model, "find", vec![query, empty_obj(), extend(&find, vec![("sort", sort)])])).await?;
  components.transform(
    call,
    TransformArgs {
      data: &mut result,
      fields: collection_config.get("fields"),
      global_slug: None,
      operation: Operation::Read,
      update_ops: None,
    },
  )?;
  Ok(result)
}

/// `documents.map((doc) => doc._id)`
fn ids_of(documents: &JsVal) -> MongoResult<JsVal> {
  let Some(items) = documents.as_arr() else {
    return Err(EngineError::new("TypeError", "documents.map is not a function").into());
  };
  Ok(JsVal::arr(items.iter().map(|doc| read(doc, "_id").cloned()).collect::<Result<Vec<_>, _>>()?))
}

mutating!(update_global, update_global_inner, "data");

async fn update_global_inner<C: Components>(
  components: &C,
  call: &Call<'_>,
  args: &JsVal,
  data: &mut JsVal,
) -> MongoResult<JsVal> {
  let global_slug = slug_arg(args, "slug");
  let options_args = or_default(args.get("options"), empty_obj);
  let returning = args.get("returning").clone();
  let select = args.get("select").clone();

  let entity = get_global(call, &global_slug, false)?;
  let fields = entity.config.get("fields");

  components.transform(
    call,
    TransformArgs { data: &mut *data, fields, global_slug: Some(&global_slug), operation: Operation::Write, update_ops: None },
  )?;

  let session = get_session(call).await?;
  let base = base_options(&options_args, session);
  let projection = components.build_projection_from_select(call, entity.config.get("flattenedFields"), &select)?;
  let find = find_options(&base, Some(projection), true);
  let filter = obj([("globalType", JsVal::str(global_slug.as_str()))]);

  if matches!(returning, JsVal::Bool(false)) {
    model_op(call, ModelCall::new(&entity.model, "updateOne", vec![filter, data.clone(), JsVal::obj(base)])).await?;
    return Ok(JsVal::Null);
  }
  let mut result =
    model_op(call, ModelCall::new(&entity.model, "findOneAndUpdate", vec![filter, data.clone(), JsVal::obj(find)])).await?;
  components.transform(
    call,
    TransformArgs { data: &mut result, fields, global_slug: Some(&global_slug), operation: Operation::Read, update_ops: None },
  )?;
  Ok(result)
}

// `updateVersion.ts` / `updateGlobalVersion.ts`
mutating!(update_version, update_version_inner, "versionData", false);
mutating!(update_global_version, update_version_inner, "versionData", true);

async fn update_version_inner<C: Components>(
  components: &C,
  call: &Call<'_>,
  args: &JsVal,
  version_data: &mut JsVal,
  global: bool,
) -> MongoResult<JsVal> {
  let id = args.get("id").clone();
  let locale = args.get("locale").clone();
  let options_args = or_default(args.get("options"), empty_obj);
  let returning = args.get("returning").clone();
  let select = args.get("select").clone();
  let where_ = args.get("where").clone();

  let (model, fields, flattened_fields) = if global {
    let slug = slug_arg(args, "global");
    let entity = get_global(call, &slug, true)?;
    (entity.model, call.graph.global_version_fields(&slug, false), call.graph.global_version_fields(&slug, true))
  } else {
    let slug = slug_arg(args, "collection");
    let entity = get_collection(call, &slug, true)?;
    (entity.model, call.graph.collection_version_fields(&slug, false), call.graph.collection_version_fields(&slug, true))
  };
  let where_to_use = if where_.truthy() { where_ } else { obj([("id", obj([("equals", id)]))]) };

  let query = components
    .build_query(
      call,
      BuildQueryArgs { collection_slug: None, fields: &flattened_fields, global_slug: None, locale: &locale, where_: &where_to_use },
    )
    .await?;

  components.transform(
    call,
    TransformArgs { data: &mut *version_data, fields: &fields, global_slug: None, operation: Operation::Write, update_ops: None },
  )?;

  let session = get_session(call).await?;
  let base = base_options(&options_args, session);
  let projection = components.build_projection_from_select(call, &flattened_fields, &select)?;
  let find = find_options(&base, Some(projection), true);

  if matches!(returning, JsVal::Bool(false)) {
    model_op(call, ModelCall::new(&model, "updateOne", vec![query, version_data.clone(), JsVal::obj(base)])).await?;
    return Ok(JsVal::Null);
  }
  let mut doc =
    model_op(call, ModelCall::new(&model, "findOneAndUpdate", vec![query, version_data.clone(), JsVal::obj(find)])).await?;
  if !doc.truthy() {
    return Ok(JsVal::Null);
  }
  components.transform(
    call,
    TransformArgs { data: &mut doc, fields: &fields, global_slug: None, operation: Operation::Read, update_ops: None },
  )?;
  Ok(doc)
}

mutating!(update_jobs, update_jobs_inner, "data");

async fn update_jobs_inner<C: Components>(
  components: &C,
  call: &Call<'_>,
  args: &JsVal,
  data: &mut JsVal,
) -> MongoResult<JsVal> {
  let id = args.get("id").clone();
  let limit = args.get("limit").clone();
  let returning = args.get("returning").clone();
  let sort_arg = args.get("sort").clone();
  let where_arg = args.get("where").clone();

  // `!data?.log?.length && !(data.log && typeof data.log === 'object' && '$push' in data.log)`
  let log = if data.is_nullish() { JsVal::Undefined } else { data.get("log").clone() };
  let log_length = if log.is_nullish() { JsVal::Undefined } else { length_of(&log) };
  if !log_length.truthy() {
    let log = read(&data, "log")?.clone();
    let has_push = log.truthy() && log.type_of() == "object" && log.has("$push");
    if !has_push {
      delete(&mut *data, "log")?;
    }
  }

  let where_ = if id.truthy() { obj([("id", obj([("equals", id.clone())]))]) } else { where_arg };
  let entity = get_collection(call, "payload-jobs", false)?;
  let collection_config = entity.config;
  let model = entity.model;
  let collection_slug = collection_config.get("slug").to_js_string();

  let sort = components.build_sort_param(
    call,
    SortParamArgs {
      fields: collection_config.get("flattenedFields"),
      locale: &JsVal::Undefined,
      sort: &or(&sort_arg, collection_config.get("defaultSort")),
      timestamps: true,
      versions: false,
    },
    None,
  )?;

  let query = components
    .build_query(
      call,
      BuildQueryArgs {
        collection_slug: Some(&collection_slug),
        fields: collection_config.get("flattenedFields"),
        global_slug: None,
        locale: &JsVal::Undefined,
        where_: &where_,
      },
    )
    .await?;

  let update_data = write_with_operators(components, call, &mut *data, collection_config.get("fields"))?;

  let session = get_session(call).await?;
  let mut base = Obj::new();
  base.insert("session".into(), session);
  base.insert("timestamps".into(), JsVal::Bool(false));
  let find = find_options(&base, None, true);
  let returning_false = matches!(returning, JsVal::Bool(false));

  enum Flow {
    Return(JsVal),
    Result(JsVal),
  }

  let outcome: MongoResult<Flow> = async {
    if id.truthy() {
      if returning_false {
        model_op(call, ModelCall::new(&model, "updateOne", vec![query.clone(), update_data.clone(), JsVal::obj(base.clone())]))
          .await?;
        components.transform(
          call,
          TransformArgs {
            data: &mut *data,
            fields: collection_config.get("fields"),
            global_slug: None,
            operation: Operation::Read,
            update_ops: None,
          },
        )?;
        return Ok(Flow::Return(JsVal::Null));
      }
      let doc =
        model_op(call, ModelCall::new(&model, "findOneAndUpdate", vec![query.clone(), update_data.clone(), JsVal::obj(find.clone())]))
          .await?;
      return Ok(Flow::Result(if doc.truthy() { JsVal::arr(vec![doc]) } else { JsVal::arr(Vec::new()) }));
    }
    if is_num(&limit, 1.0) {
      let projection = if returning_false { obj([("_id", JsVal::Num(1.0))]) } else { JsVal::Undefined };
      let doc = model_op(
        call,
        ModelCall::new(
          &model,
          "findOneAndUpdate",
          vec![query.clone(), update_data.clone(), extend(&find, vec![("projection", projection), ("sort", sort.clone())])],
        ),
      )
      .await?;
      if returning_false {
        return Ok(Flow::Return(JsVal::Null));
      }
      return Ok(Flow::Result(if doc.truthy() { JsVal::arr(vec![doc]) } else { JsVal::arr(Vec::new()) }));
    }
    if matches!(limit, JsVal::Num(_)) && gt_num(&limit, 1.0) {
      let candidates = model_op(
        call,
        ModelCall::new(
          &model,
          "find",
          vec![
            query.clone(),
            empty_obj(),
            extend(&find, vec![("limit", limit.clone()), ("projection", obj([("_id", JsVal::Num(1.0))])), ("sort", sort.clone())]),
          ],
        ),
      )
      .await?;
      if candidates.as_arr().is_some_and(<[JsVal]>::is_empty) {
        return Ok(Flow::Return(JsVal::Null));
      }
      let candidate_ids = ids_of(&candidates)?;
      let processing_token = data.get("processingToken").clone();
      if matches!(processing_token, JsVal::Str(_)) {
        let claim_query =
          obj([("$and", JsVal::arr(vec![query.clone(), obj([("_id", obj([("$in", candidate_ids.clone())]))])]))]);
        model_op(call, ModelCall::new(&model, "updateMany", vec![claim_query, update_data.clone(), JsVal::obj(base.clone())]))
          .await?;
        if returning_false {
          return Ok(Flow::Return(JsVal::Null));
        }
        let claimed = obj([
          ("_id", obj([("$in", candidate_ids)])),
          ("processingToken", obj([("$eq", processing_token)])),
        ]);
        let result =
          model_op(call, ModelCall::new(&model, "find", vec![claimed, empty_obj(), extend(&find, vec![("sort", sort.clone())])]))
            .await?;
        return Ok(Flow::Result(result));
      }
      let limited = obj([("_id", obj([("$in", candidate_ids)]))]);
      model_op(call, ModelCall::new(&model, "updateMany", vec![limited.clone(), update_data.clone(), JsVal::obj(base.clone())]))
        .await?;
      if returning_false {
        return Ok(Flow::Return(JsVal::Null));
      }
      let result =
        model_op(call, ModelCall::new(&model, "find", vec![limited, empty_obj(), extend(&find, vec![("sort", sort.clone())])]))
          .await?;
      return Ok(Flow::Result(result));
    }
    model_op(call, ModelCall::new(&model, "updateMany", vec![query.clone(), update_data.clone(), JsVal::obj(base.clone())]))
      .await?;
    if returning_false {
      return Ok(Flow::Return(JsVal::Null));
    }
    let result =
      model_op(call, ModelCall::new(&model, "find", vec![query.clone(), empty_obj(), extend(&find, vec![("sort", sort.clone())])]))
        .await?;
    Ok(Flow::Result(result))
  }
  .await;

  let mut result = match outcome {
    Ok(Flow::Return(value)) => return Ok(value),
    Ok(Flow::Result(result)) => result,
    Err(error) => return Err(handle_error(call, error, Some(&collection_slug), None)),
  };
  components.transform(
    call,
    TransformArgs {
      data: &mut result,
      fields: collection_config.get("fields"),
      global_slug: None,
      operation: Operation::Read,
      update_ops: None,
    },
  )?;
  Ok(result)
}

/// `value.length`
fn length_of(value: &JsVal) -> JsVal {
  match value {
    JsVal::Arr(a) => JsVal::Num(a.len() as f64),
    JsVal::Str(s) => JsVal::Num(s.encode_utf16().count() as f64),
    JsVal::Fn(_) => JsVal::Undefined,
    _ => value.get("length").clone(),
  }
}

pub async fn delete_one<C: Components>(components: &C, call: &Call<'_>, args: &JsVal) -> MongoResult<JsVal> {
  let collection_slug = slug_arg(args, "collection");
  let returning = args.get("returning").clone();
  let select = args.get("select").clone();
  let where_ = args.get("where").clone();

  let entity = get_collection(call, &collection_slug, false)?;
  let collection_config = entity.config;
  let query = components
    .build_query(
      call,
      BuildQueryArgs {
        collection_slug: Some(&collection_slug),
        fields: collection_config.get("flattenedFields"),
        global_slug: None,
        locale: &JsVal::Undefined,
        where_: &where_,
      },
    )
    .await?;

  let projection = components.build_projection_from_select(call, collection_config.get("flattenedFields"), &select)?;
  let session = get_session(call).await?;
  let options = obj([("projection", projection), ("session", session)]);

  if matches!(returning, JsVal::Bool(false)) {
    model_op(call, ModelCall::new(&entity.model, "deleteOne", vec![query, options]).chain("lean", Vec::new())).await?;
    return Ok(JsVal::Null);
  }
  let mut doc =
    model_op(call, ModelCall::new(&entity.model, "findOneAndDelete", vec![query, options]).chain("lean", Vec::new())).await?;
  if !doc.truthy() {
    return Ok(JsVal::Null);
  }
  components.transform(
    call,
    TransformArgs {
      data: &mut doc,
      fields: collection_config.get("fields"),
      global_slug: None,
      operation: Operation::Read,
      update_ops: None,
    },
  )?;
  Ok(doc)
}

pub async fn delete_many<C: Components>(components: &C, call: &Call<'_>, args: &JsVal) -> MongoResult<JsVal> {
  let collection_slug = slug_arg(args, "collection");
  let where_ = args.get("where").clone();
  let entity = get_collection(call, &collection_slug, false)?;
  let query = components
    .build_query(
      call,
      BuildQueryArgs {
        collection_slug: Some(&collection_slug),
        fields: entity.config.get("flattenedFields"),
        global_slug: None,
        locale: &JsVal::Undefined,
        where_: &where_,
      },
    )
    .await?;
  let session = get_session(call).await?;
  model_op(call, ModelCall::new(&entity.model, "deleteMany", vec![query, obj([("session", session)])])).await?;
  Ok(JsVal::Undefined)
}

pub async fn delete_versions<C: Components>(components: &C, call: &Call<'_>, args: &JsVal) -> MongoResult<JsVal> {
  let collection_slug = args.get("collection").clone();
  let global_slug = args.get("globalSlug").clone();
  let locale = args.get("locale").clone();
  let where_ = args.get("where").clone();

  let (model, fields): (ModelRef, JsVal) = if global_slug.truthy() {
    let slug = global_slug.to_js_string();
    let entity = get_global(call, &slug, true)?;
    (entity.model, call.graph.global_version_fields(&slug, true))
  } else if collection_slug.truthy() {
    let slug = collection_slug.to_js_string();
    let entity = get_collection(call, &slug, true)?;
    (entity.model, call.graph.collection_version_fields(&slug, true))
  } else {
    return Err(EngineError::api("Either collection or globalSlug must be passed.").into());
  };

  let query = components
    .build_query(call, BuildQueryArgs { collection_slug: None, fields: &fields, global_slug: None, locale: &locale, where_: &where_ })
    .await?;
  let session = get_session(call).await?;
  model_op(call, ModelCall::new(&model, "deleteMany", vec![query, obj([("session", session)])])).await?;
  Ok(JsVal::Undefined)
}
