//! `database/queryValidation/{validateQueryPaths,validateSearchParams,validateSortQuery}.ts` on the
//! core runtime executor. One Rust task per TS `async` function call, `await_js`/`await_call`
//! exactly where the TS awaits, `Promise.all` over the task promises in the TS order (including
//! the promises a path callback pushes after `Promise.all` already started, which it does not
//! await), and every read/write of the user's `where`, `policies`, `errors` and `req` at the TS
//! point.

use std::cell::RefCell;
use std::rc::Rc;

use payload_core_runtime::executor::{await_call, await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use super::host::{
  Loop, Units, call, del, dot, eq, get, get_named, get_optional, has_errors, host, in_op, is_and_or, is_array,
  is_safe_field_path, is_string, is_true, is_typeof_object, join_dot, promise_all, push_path, query_error,
  replace_all, replace_first, set, set_named, split_dot, str_eq, string, truthy, units, units_of, val,
};
use super::paths::{LocalizedPathsArgs, PathToQuery, get_localized_paths};
use super::where_query::prefix_where_paths;

/// `validOperators`
pub const VALID_OPERATORS: [&str; 16] = [
  "equals",
  "contains",
  "not_equals",
  "in",
  "all",
  "not_in",
  "exists",
  "greater_than",
  "greater_than_equal",
  "less_than",
  "less_than_equal",
  "like",
  "not_like",
  "within",
  "intersects",
  "near",
];

/// `hasManyRelationshipOperators`
const HAS_MANY_RELATIONSHIP_OPERATORS: [&str; 3] = ["contains", "not_equals", "equals"];

/// The destructured `validateQueryPaths` arguments. `errors`/`policies` that are `undefined`
/// get their defaults inside the task, like the parameter pattern.
#[derive(Clone)]
pub struct QueryPathsArgs {
  pub collection_config: Val,
  pub errors: Val,
  pub global_config: Val,
  pub override_access: Val,
  pub policies: Val,
  pub polymorphic_join: Val,
  pub req: Val,
  pub show_hidden_fields: Val,
  pub version_fields: Val,
  pub where_: Val,
}

impl QueryPathsArgs {
  /// From the `validateQueryPathsArgs` host destructuring (same order).
  pub fn from_array(a: Local) -> JsResult<Self> {
    let e = |i| -> JsResult<Val> { val(js::get_element(a, i)?) };
    Ok(Self {
      collection_config: e(0)?,
      errors: e(1)?,
      global_config: e(2)?,
      override_access: e(3)?,
      policies: e(4)?,
      polymorphic_join: e(5)?,
      req: e(6)?,
      show_hidden_fields: e(7)?,
      version_fields: e(8)?,
      where_: e(9)?,
    })
  }
}

/// `validateQueryPaths(args)` called with already destructured args: returns its promise.
pub fn validate_query_paths(args: QueryPathsArgs) -> JsResult<Local> {
  spawn(validate_query_paths_body(args))
}

pub async fn validate_query_paths_body(a: QueryPathsArgs) -> JsResult<Val> {
  let h = host()?;
  let errors = if a.errors.is_undefined() { val(js::array())? } else { a.errors.clone() };
  let policies = if a.policies.is_undefined() { val(call(&h.default_policies, &[])?)? } else { a.policies.clone() };
  let fields = val(call(
    &h.fields_of,
    &[a.version_fields.get(), a.global_config.get(), a.collection_config.get()],
  )?)?;

  let where_ = a.where_.get();
  if !is_typeof_object(where_) {
    return Ok(Val::Undefined);
  }

  let mut promises: Vec<Val> = Vec::new();
  let paths = Loop::for_in(where_)?;
  while let Some(path) = paths.next()? {
    let constraint = get(where_, path)?;
    let path_units = units_of(path).unwrap_or_default();

    if is_and_or(&path_units) && is_array(constraint)? {
      let items = Loop::for_of(constraint)?;
      while let Some(item) = items.next()? {
        let collection = truthy(a.collection_config.get());
        promises.push(val(validate_query_paths(QueryPathsArgs {
          collection_config: if collection { a.collection_config.clone() } else { Val::Undefined },
          errors: errors.clone(),
          global_config: if collection { Val::Undefined } else { a.global_config.clone() },
          override_access: a.override_access.clone(),
          policies: policies.clone(),
          polymorphic_join: a.polymorphic_join.clone(),
          req: a.req.clone(),
          show_hidden_fields: a.show_hidden_fields.clone(),
          version_fields: a.version_fields.clone(),
          where_: val(item)?,
        })?)?);
      }
    } else if is_array(constraint)? {
      push_path(errors.get(), &path_units)?;
    } else if !is_array(constraint)? {
      let operators = Loop::for_in(constraint)?;
      while let Some(operator) = operators.next()? {
        let value = get(constraint, operator)?;
        let operator_units = units_of(operator).unwrap_or_default();
        if VALID_OPERATORS.iter().any(|o| eq(&operator_units, o)) {
          promises.push(val(spawn(validate_search_param_body(SearchParamArgs {
            collection_config: a.collection_config.clone(),
            constraint: a.where_.clone(),
            errors: errors.clone(),
            fields: fields.clone(),
            global_config: a.global_config.clone(),
            operator: operator_units,
            override_access: a.override_access.clone(),
            parent_is_localized: Val::Undefined,
            path: path_units.clone(),
            policies: policies.clone(),
            polymorphic_join: a.polymorphic_join.clone(),
            req: a.req.clone(),
            show_hidden_fields: a.show_hidden_fields.clone(),
            val: val(value)?,
            version_fields: a.version_fields.clone(),
          }))?)?);
        } else {
          push_path(errors.get(), &dot(&path_units, &operator_units))?;
        }
      }
    }
  }

  await_js(promise_all(&promises)?).await?;
  if has_errors(errors.get())? {
    return Err(query_error(errors.get())?);
  }
  Ok(Val::Undefined)
}

/// The destructured `validateSearchParam` arguments.
#[derive(Clone)]
pub struct SearchParamArgs {
  pub collection_config: Val,
  pub constraint: Val,
  pub errors: Val,
  pub fields: Val,
  pub global_config: Val,
  pub operator: Units,
  pub override_access: Val,
  pub parent_is_localized: Val,
  pub path: Units,
  pub policies: Val,
  pub polymorphic_join: Val,
  pub req: Val,
  pub show_hidden_fields: Val,
  pub val: Val,
  pub version_fields: Val,
}

impl SearchParamArgs {
  /// From the `validateSearchParamArgs` host destructuring (same order). `operator` and `path`
  /// are strings in every upstream call; other values are converted with `String()`.
  pub fn from_array(a: Local) -> JsResult<Self> {
    let e = |i| -> JsResult<Val> { val(js::get_element(a, i)?) };
    let s = |i| -> JsResult<Units> { super::host::to_string(js::get_element(a, i)?) };
    Ok(Self {
      collection_config: e(0)?,
      constraint: e(1)?,
      errors: e(2)?,
      fields: e(3)?,
      global_config: e(4)?,
      operator: s(5)?,
      override_access: e(6)?,
      parent_is_localized: e(7)?,
      path: s(8)?,
      policies: e(9)?,
      polymorphic_join: e(10)?,
      req: e(11)?,
      show_hidden_fields: e(12)?,
      val: e(13)?,
      version_fields: e(14)?,
    })
  }
}

/// `field.type === 'relationship' || field.type === 'upload'`
fn is_rel_or_upload(field: Local) -> JsResult<bool> {
  Ok(str_eq(get_named(field, "type")?, "relationship") || str_eq(get_named(field, "type")?, "upload"))
}

/// `policies[group]![slug] = await <permissions call>`: the assignment target's base is read
/// before the call, the property written after the await.
async fn assign_permissions(policies: &Val, group: &str, slug: &Val, helper: Local, args: &[Local]) -> JsResult<()> {
  let base = val(get_named(policies.get(), group)?)?;
  let permissions = await_call(helper, args).await?;
  set(base.get(), slug.get(), permissions.get())
}

pub async fn validate_search_param_body(a: SearchParamArgs) -> JsResult<Val> {
  let h = host()?;
  let incoming_path = a.path.clone();
  let sanitized_path =
    if eq(&incoming_path, "_id") { units("id") } else { replace_all(&incoming_path, "__", ".") };
  let mut paths: Vec<PathToQuery> = Vec::new();
  let slug = val(call(&h.slug_of, &[a.collection_config.get(), a.global_config.get()])?)?;

  let block_references_permissions = val(js::object())?;

  if truthy(a.global_config.get()) && !truthy(get(get_named(a.policies.get(), "globals")?, slug.get())?) {
    assign_permissions(
      &a.policies,
      "globals",
      &slug,
      h.await_global_permissions.get(),
      &[block_references_permissions.get(), a.global_config.get(), a.req.get()],
    )
    .await?;
  }

  if !eq(&sanitized_path, "id") {
    let read = call(&h.localized_paths_args, &[a.collection_config.get(), a.global_config.get(), a.req.get()])?;
    paths = get_localized_paths(&LocalizedPathsArgs {
      collection_slug: js::get_element(read, 0)?,
      fields: a.fields.get(),
      global_slug: js::get_element(read, 1)?,
      incoming_path: string(&sanitized_path),
      locale: js::get_element(read, 2)?,
      override_access: truthy(a.override_access.get()),
      parent_is_localized: a.parent_is_localized.get(),
      payload: js::get_element(read, 3)?,
      show_hidden_fields: truthy(a.show_hidden_fields.get()),
    })?;
  }
  let promises: Rc<RefCell<Vec<Val>>> = Rc::new(RefCell::new(Vec::new()));
  let operator = a.operator.clone();
  let operator_is = |o: &str| eq(&operator, o);

  let relationship_field = if paths.len() == 1 { paths[0].field.get() } else { js::undefined() };
  let has_nested_where = truthy(call(&h.is_nested_relationship_query, &[a.val.get()])?);
  let related_collection_slug = if truthy(relationship_field)
    && is_rel_or_upload(relationship_field)?
    && truthy(get_named(relationship_field, "hasMany")?)
    && is_string(get_named(relationship_field, "relationTo")?)
  {
    get_named(relationship_field, "relationTo")?
  } else {
    js::undefined()
  };
  let related_collection_slug = val(related_collection_slug)?;
  let is_nested_has_many_query = HAS_MANY_RELATIONSHIP_OPERATORS.iter().any(|o| operator_is(o))
    && has_nested_where
    && truthy(related_collection_slug.get());

  if operator_is("like") || operator_is("not_like") || operator_is("contains") {
    let is_legitimate_nested_contains = operator_is("contains") && is_nested_has_many_query;
    let contains_plain_object = has_nested_where || truthy(call(&h.some_nested, &[a.val.get()])?);
    if contains_plain_object && !is_legitimate_nested_contains {
      push_path(a.errors.get(), &incoming_path)?;
      return Ok(Val::Undefined);
    }
  }

  if is_nested_has_many_query && truthy(related_collection_slug.get()) {
    let collection_config = call(&h.collection_config_of, &[a.req.get(), related_collection_slug.get()])?;
    let promise = validate_query_paths(QueryPathsArgs {
      collection_config: val(collection_config)?,
      errors: a.errors.clone(),
      global_config: Val::Undefined,
      override_access: a.override_access.clone(),
      policies: a.policies.clone(),
      polymorphic_join: Val::Undefined,
      req: a.req.clone(),
      show_hidden_fields: a.show_hidden_fields.clone(),
      version_fields: Val::Undefined,
      where_: a.val.clone(),
    })?;
    promises.borrow_mut().push(val(promise)?);
  }

  // Sanitize relation.otherRelation.id to relation.otherRelation
  if paths.last().is_some_and(|p| eq(&p.path, "id")) {
    let previous_field = if paths.len() >= 2 { paths[paths.len() - 2].field.get() } else { js::undefined() };
    if truthy(previous_field)
      && is_rel_or_upload(previous_field)?
      && is_string(get_named(previous_field, "relationTo")?)
    {
      paths.pop();
    }
  }

  let shared = Rc::new(Shared {
    args: a,
    block_references_permissions,
    incoming_path,
    is_nested_has_many_query,
    paths,
    promises: promises.clone(),
  });
  let mut mapped = Vec::with_capacity(shared.paths.len());
  for i in 0..shared.paths.len() {
    mapped.push(val(spawn(path_callback(shared.clone(), i))?)?);
  }
  promises.borrow_mut().extend(mapped);

  let snapshot = promises.borrow().clone();
  await_js(promise_all(&snapshot)?).await?;
  Ok(Val::Undefined)
}

/// What the `paths.map(async (...) => ...)` callbacks close over.
struct Shared {
  args: SearchParamArgs,
  block_references_permissions: Val,
  incoming_path: Units,
  is_nested_has_many_query: bool,
  paths: Vec<PathToQuery>,
  promises: Rc<RefCell<Vec<Val>>>,
}

/// The `async ({ collectionSlug, field, invalid, path }, i) => { ... }` callback.
async fn path_callback(s: Rc<Shared>, i: usize) -> JsResult<Val> {
  let h = host()?;
  let a = &s.args;
  let PathToQuery { collection_slug, field, invalid, path, .. } = s.paths[i].clone();
  let errors = &a.errors;
  let incoming_path = &s.incoming_path;

  if invalid {
    let is_unknown_polymorphic_join_field =
      truthy(a.polymorphic_join.get()) && !truthy(field.get()) && is_safe_field_path(incoming_path);
    if !is_unknown_polymorphic_join_field {
      push_path(errors.get(), &path)?;
    }
    return Ok(Val::Undefined);
  }

  // where: { relatedPosts: { equals: 1}} -> { 'relatedPosts.id': { equals: 1}}
  if str_eq(get_named(field.get(), "type")?, "join") && path == *incoming_path {
    let constraint = a.constraint.get();
    let target = string(&dot(&path, &units("id")));
    let moved = get(constraint, string(&path))?;
    set(constraint, target, moved)?;
    del(constraint, string(&path))?;
  }

  if in_op("virtual", field.get())? && truthy(get_named(field.get(), "virtual")?) && is_true(get_named(field.get(), "virtual")?) {
    push_path(errors.get(), &path)?;
  }

  if truthy(a.polymorphic_join.get()) && eq(&path, "relationTo") {
    return Ok(Val::Undefined);
  }

  if !truthy(a.override_access.get()) && truthy(call(&h.field_affects_data, &[field.get()])?) {
    if truthy(collection_slug.get()) {
      let collections = get_named(a.policies.get(), "collections")?;
      if !truthy(get(collections, collection_slug.get())?) {
        assign_permissions(
          &a.policies,
          "collections",
          &collection_slug,
          h.await_collection_permissions.get(),
          &[s.block_references_permissions.get(), a.req.get(), collection_slug.get()],
        )
        .await?;
      }

      if (eq(incoming_path, "hash") || eq(incoming_path, "salt"))
        && truthy(get_named(a.collection_config.get(), "auth")?)
        && !truthy(get_optional(get_named(a.collection_config.get(), "auth")?, "disableLocalStrategy")?)
      {
        push_path(errors.get(), incoming_path)?;
      }

      let related_collection_read_permission = val(get_named(
        get(get_named(a.policies.get(), "collections")?, collection_slug.get())?,
        "read",
      )?)?;
      let traversed_field = if i > 0 { s.paths[i - 1].field.get() } else { js::undefined() };
      let is_relationship_hop = truthy(traversed_field)
        && (str_eq(get_named(traversed_field, "type")?, "relationship")
          || str_eq(get_named(traversed_field, "type")?, "upload")
          || str_eq(get_named(traversed_field, "type")?, "join"));

      let read = related_collection_read_permission.get();
      if is_relationship_hop && truthy(read) && is_typeof_object(read) && truthy(get_named(read, "where")?) {
        let relationship_path = join_dot(&s.paths[..i].iter().map(|p| p.path.clone()).collect::<Vec<_>>());
        let mutable_where = a.constraint.get();
        let existing_and = if is_array(get_named(mutable_where, "and")?)? {
          get_named(mutable_where, "and")?
        } else {
          js::array()
        };

        let is_has_many_relationship = is_rel_or_upload(traversed_field)? && truthy(get_named(traversed_field, "hasMany")?);
        let is_join = str_eq(get_named(traversed_field, "type")?, "join");

        if is_has_many_relationship || is_join {
          let related_field_path = s.paths.last().map(|p| p.path.clone()).unwrap_or_default();
          if !related_field_path.is_empty() {
            let and = call(
              &h.scoped_and,
              &[
                existing_and,
                string(&relationship_path),
                string(&related_field_path),
                string(&a.operator),
                a.val.get(),
                read,
              ],
            )?;
            set_named(mutable_where, "and", and)?;
            del(mutable_where, string(incoming_path))?;
          }
        } else {
          let access_where = prefix_where_paths(string(&relationship_path), get_named(read, "where")?)?;
          let and = call(&h.append_and, &[existing_and, access_where])?;
          set_named(mutable_where, "and", and)?;
        }
      }
    }

    let mut field_path = units_of(call(&h.strip_locale, &[string(&path), a.req.get()])?).unwrap_or_default();
    if is_rel_or_upload(field.get())? && is_array(get_named(field.get(), "relationTo")?)? {
      field_path = replace_first(&field_path, ".value", "");
    }

    let entity_type = if truthy(a.global_config.get()) { "globals" } else { "collections" };
    let entity_slug =
      if truthy(collection_slug.get()) { collection_slug.get() } else { get_named(a.global_config.get(), "slug")? };
    let mut segments = split_dot(&field_path);

    let mut field_access = get_named(get(get_named(a.policies.get(), entity_type)?, entity_slug)?, "fields")?;
    if truthy(a.version_fields.get())
      && ["parent", "version", "snapshot", "latest"].iter().any(|s| eq(&segments[0], s))
    {
      segments.remove(0);
    }

    if !segments.is_empty() {
      for segment in &segments {
        let key = string(segment);
        if truthy(get(field_access, key)?) {
          if in_op("fields", get(field_access, key)?)? {
            field_access = get_named(get(field_access, key)?, "fields")?;
          } else {
            field_access = get(field_access, key)?;
          }
        }
      }
      if truthy(call(&h.no_read_permission, &[field_access])?) {
        push_path(errors.get(), &field_path)?;
      }
    }
  }

  if !s.is_nested_has_many_query && i > 1 {
    // paths.slice(1).reverse(): only the first entry (the deepest path) is validated
    if let Some(deepest) = s.paths.last() {
      let collection_config = call(&h.collection_config_of, &[a.req.get(), deepest.collection_slug.get()])?;
      let where_ = call(&h.nested_where, &[string(&deepest.path), string(&a.operator), a.val.get()])?;
      let promise = validate_query_paths(QueryPathsArgs {
        collection_config: val(collection_config)?,
        errors: errors.clone(),
        global_config: Val::Undefined,
        override_access: a.override_access.clone(),
        policies: a.policies.clone(),
        polymorphic_join: Val::Undefined,
        req: a.req.clone(),
        show_hidden_fields: a.show_hidden_fields.clone(),
        version_fields: Val::Undefined,
        where_: val(where_)?,
      })?;
      s.promises.borrow_mut().push(val(promise)?);
    }
  }

  Ok(Val::Undefined)
}

/// The destructured `validateSortQuery` arguments.
pub struct SortQueryArgs {
  pub collection_config: Val,
  pub global_config: Val,
  pub override_access: Val,
  pub req: Val,
  pub sort: Val,
  pub version_fields: Val,
}

impl SortQueryArgs {
  pub fn from_array(a: Local) -> JsResult<Self> {
    let e = |i| -> JsResult<Val> { val(js::get_element(a, i)?) };
    Ok(Self {
      collection_config: e(0)?,
      global_config: e(1)?,
      override_access: e(2)?,
      req: e(3)?,
      sort: e(4)?,
      version_fields: e(5)?,
    })
  }
}

pub async fn validate_sort_query_body(a: SortQueryArgs) -> JsResult<Val> {
  let h = host()?;
  if truthy(a.override_access.get()) || !truthy(a.sort.get()) {
    return Ok(Val::Undefined);
  }

  let fields =
    call(&h.fields_of, &[a.version_fields.get(), a.global_config.get(), a.collection_config.get()])?;
  let sort_fields = call(&h.sort_fields_of, &[a.sort.get()])?;
  let where_ = js::object();

  let items = Loop::for_of(sort_fields)?;
  while let Some(sort_field) = items.next()? {
    let path = call(&h.sort_path, &[sort_field])?;
    let read = call(&h.localized_paths_args, &[a.collection_config.get(), a.global_config.get(), a.req.get()])?;
    let paths = get_localized_paths(&LocalizedPathsArgs {
      collection_slug: js::get_element(read, 0)?,
      fields,
      global_slug: js::get_element(read, 1)?,
      incoming_path: path,
      locale: js::get_element(read, 2)?,
      override_access: true,
      parent_is_localized: js::undefined(),
      payload: js::get_element(read, 3)?,
      show_hidden_fields: false,
    })?;

    if !str_eq(path, "id") && !str_eq(path, "_id") && paths.iter().all(|p| !p.invalid) {
      set(where_, path, call(&h.exists_true, &[])?)?;
    }
  }

  if js::array_length(js::own_keys(where_)?) == 0 {
    return Ok(Val::Undefined);
  }

  let collection = truthy(a.collection_config.get());
  let promise = validate_query_paths(QueryPathsArgs {
    collection_config: if collection { a.collection_config.clone() } else { Val::Undefined },
    errors: Val::Undefined,
    global_config: if collection { Val::Undefined } else { a.global_config.clone() },
    override_access: a.override_access.clone(),
    policies: Val::Undefined,
    polymorphic_join: Val::Undefined,
    req: a.req.clone(),
    show_hidden_fields: Val::Undefined,
    version_fields: a.version_fields.clone(),
    where_: val(where_)?,
  })?;
  await_js(promise).await?;
  Ok(Val::Undefined)
}
