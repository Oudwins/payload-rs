//! `database/sanitizeJoinQuery.ts` on the core runtime executor.

use std::cell::RefCell;
use std::rc::Rc;

use payload_core_runtime::executor::{await_call, await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use super::host::{
  Loop, call, get, get_named, has_errors, host, is_false, is_typeof_object, promise_all, query_error, set, set_named,
  truthy, val,
};
use super::validate::{QueryPathsArgs, SortQueryArgs, validate_query_paths, validate_sort_query_body};
use super::where_query::{combine_queries, sanitize_where_query};

/// The destructured `sanitizeJoinQuery` arguments.
pub struct JoinQueryArgs {
  pub collection_config: Val,
  pub joins: Val,
  pub override_access: Val,
  pub req: Val,
}

impl JoinQueryArgs {
  pub fn from_array(a: Local) -> JsResult<Self> {
    let e = |i| -> JsResult<Val> { val(js::get_element(a, i)?) };
    Ok(Self { collection_config: e(0)?, joins: e(1)?, override_access: e(2)?, req: e(3)? })
  }
}

pub async fn sanitize_join_query_body(a: JoinQueryArgs) -> JsResult<Val> {
  let h = host()?;
  if is_false(a.joins.get()) {
    return Ok(Val::Bool(false));
  }
  let joins_query = if truthy(a.joins.get()) { a.joins.clone() } else { val(js::object())? };

  let errors = val(js::array())?;
  let promises: Rc<RefCell<Vec<Val>>> = Rc::new(RefCell::new(Vec::new()));
  let state = Rc::new(JoinState { errors, joins_query, override_access: a.override_access.clone(), promises, req: a.req });

  let collection_slugs = Loop::for_in(get_named(a.collection_config.get(), "joins")?)?;
  while let Some(collection_slug) = collection_slugs.next()? {
    let collection_slug = val(collection_slug)?;
    let joins = Loop::from_helper(&h.joins_of, &[a.collection_config.get(), collection_slug.get()])?;
    while let Some(join) = joins.next()? {
      let promise = spawn(sanitize_join_field_query(state.clone(), collection_slug.clone(), val(join)?))?;
      await_js(promise).await?;
    }
  }

  let polymorphic_joins = Loop::from_helper(&h.polymorphic_joins_of, &[a.collection_config.get()])?;
  while let Some(join) = polymorphic_joins.next()? {
    let join = val(join)?;
    let collection_slugs = Loop::from_helper(&h.join_collections_of, &[join.get()])?;
    while let Some(collection_slug) = collection_slugs.next()? {
      let promise = spawn(sanitize_join_field_query(state.clone(), val(collection_slug)?, join.clone()))?;
      await_js(promise).await?;
    }
  }

  let snapshot = state.promises.borrow().clone();
  await_js(promise_all(&snapshot)?).await?;

  if has_errors(state.errors.get())? {
    return Err(query_error(state.errors.get())?);
  }
  Ok(state.joins_query.clone())
}

struct JoinState {
  errors: Val,
  joins_query: Val,
  override_access: Val,
  promises: Rc<RefCell<Vec<Val>>>,
  req: Val,
}

/// `sanitizeJoinFieldQuery({ collectionSlug, errors, join, joinsQuery, overrideAccess, promises, req })`
async fn sanitize_join_field_query(s: Rc<JoinState>, collection_slug: Val, join: Val) -> JsResult<Val> {
  let h = host()?;
  // `const { joinPath } = join` (V8's destructuring TypeError for a nullish `join`)
  let join_path = val(call(&h.join_path_of, &[join.get()])?)?;

  if is_false(get(s.joins_query.get(), join_path.get())?) {
    return Ok(Val::Undefined);
  }

  let join_collection_config = val(call(&h.collection_config_of, &[s.req.get(), collection_slug.get()])?)?;

  let access_result = if !truthy(s.override_access.get()) {
    await_call(h.await_execute_access.get(), &[join_collection_config.get(), s.req.get()]).await?
  } else {
    Val::Bool(true)
  };

  if is_false(access_result.get()) {
    set(s.joins_query.get(), join_path.get(), js::boolean(false))?;
    return Ok(Val::Undefined);
  }

  if !truthy(get(s.joins_query.get(), join_path.get())?) {
    set(s.joins_query.get(), join_path.get(), js::object())?;
  }

  let join_query = val(get(s.joins_query.get(), join_path.get())?)?;
  let join_query_local = join_query.get();

  if !truthy(get_named(join_query_local, "where")?) {
    set_named(join_query_local, "where", js::object())?;
  }

  if truthy(get_named(get_named(join.get(), "field")?, "where")?) {
    let current = get_named(join_query_local, "where")?;
    let copy = call(&h.deep_copy_object_simple, &[get_named(get_named(join.get(), "field")?, "where")?])?;
    let combined = combine_queries(current, copy)?;
    set_named(join_query_local, "where", combined)?;
  }

  let polymorphic_join = call(&h.is_polymorphic_join, &[join.get()])?;
  let where_ = get_named(join_query_local, "where")?;
  let validate_where = validate_query_paths(QueryPathsArgs {
    collection_config: join_collection_config.clone(),
    errors: s.errors.clone(),
    global_config: Val::Undefined,
    override_access: s.override_access.clone(),
    policies: Val::Undefined,
    polymorphic_join: val(polymorphic_join)?,
    req: s.req.clone(),
    show_hidden_fields: Val::Undefined,
    version_fields: Val::Undefined,
    where_: val(where_)?,
  })?;
  let validate_where = val(validate_where)?;
  let sort = call(&h.join_sort, &[join_query.get(), join.get(), join_collection_config.get()])?;
  let validate_sort = spawn(validate_sort_query_body(SortQueryArgs {
    collection_config: join_collection_config.clone(),
    global_config: Val::Undefined,
    override_access: s.override_access.clone(),
    req: s.req.clone(),
    sort: val(sort)?,
    version_fields: Val::Undefined,
  }))?;
  let validate_sort = val(validate_sort)?;
  s.promises.borrow_mut().extend([validate_where, validate_sort]);

  // `joinQuery` is the local read once above (no await since)
  let access_result = access_result.get();
  if is_typeof_object(access_result) {
    let fields = get_named(join_collection_config.get(), "flattenedFields")?;
    let payload = get_named(s.req.get(), "payload")?;
    sanitize_where_query(fields, payload, access_result)?;
    let current = get_named(join_query.get(), "where")?;
    let combined = combine_queries(current, access_result)?;
    set_named(join_query.get(), "where", combined)?;
  }
  Ok(Val::Undefined)
}
