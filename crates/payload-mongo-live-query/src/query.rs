//! `queries/buildQuery.ts`, `parseParams.ts`, `buildAndOrConditions.ts`, `buildSearchParams.ts`
//! and the `Model.buildQuery` static of `getBuildQueryPlugin.ts` on live objects.
//!
//! Every TS `async` function is one spawned task (its own native promise), called where the TS
//! calls it and awaited with `await_js` where the TS awaits it; `return asyncFn(...)` resolves the
//! task with the callee's promise (the thenable resolution the TS async function performs). The
//! caller's `where` objects are read (and passed through) live, the sub-queries call
//! `Model.buildQuery`, `Model.find(...).lean().select(...)`, `Model.find(filter, { lean: true })`
//! and `Model.distinct(...)` directly on the models `getCollection` resolves, at the TS points.

use std::cell::Cell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use payload_core_runtime::executor::{self, await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

use payload_mongo_live::bson::is_object_id;
use payload_mongo_live::entity::get_collection;
use crate::host::{
  Flow, ForOf, api_error, api_error_status, arg, array, call, call_method, call_method_with, call_with_callback, concat,
  for_of, for_of_flow, get, get_k, get_opt, host, is_array, is_string, new_object_id, object, object_id_is_valid,
  object_keys, object_named, parse_float, prop_key, push, replace_locale_or_default, set, set_k, str_is, template,
  typeof_object, units, val,
};
use crate::sanitize::{SanitizeArgs, sanitize_query_value};

/// The arguments `parseParams` / `buildAndOrConditions` / `buildSearchParam` pass down unchanged.
pub struct Scope {
  pub collection_slug: Val,
  pub fields: Val,
  pub global_slug: Val,
  pub locale: Val,
  pub parent_is_localized: Val,
  pub payload: Val,
}

pub struct BuildQueryArgs {
  pub adapter: Local,
  pub collection_slug: Local,
  pub fields: Local,
  pub global_slug: Local,
  pub locale: Local,
  pub where_: Local,
}

type TaskFuture = Pin<Box<dyn Future<Output = JsResult<Val>>>>;

/// Builds and boxes a task's future in its own frame, which is gone before the task's first
/// (synchronous) poll: only a pointer stays on the native stack of the caller, so nested
/// `and` / `or` levels (each a synchronous chain of task polls, like the TS call stack) use as
/// little stack as possible before V8's stack limit is reached.
#[inline(never)]
fn make_task<C, F>(make: C) -> TaskFuture
where
  C: FnOnce() -> F,
  F: Future<Output = JsResult<Val>> + 'static,
{
  Box::pin(make())
}

/// `spawn` of the future `make` builds (see [`make_task`]).
fn spawn_task<C, F>(make: C) -> JsResult<Local>
where
  C: FnOnce() -> F,
  F: Future<Output = JsResult<Val>> + 'static,
{
  spawn(make_task(make))
}

fn nullish(v: Local) -> bool {
  matches!(js::type_of(v), Type::Undefined | Type::Null)
}

// ---------------------------------------------------------------------------------------------
// buildQuery

/// `buildQuery({ adapter, collectionSlug, fields, globalSlug, locale, where })`: the promise of
/// the async function.
pub fn build_query(a: BuildQueryArgs) -> JsResult<Local> {
  let adapter = val(a.adapter)?;
  let scope = (val(a.collection_slug)?, val(a.fields)?, val(a.global_slug)?, val(a.locale)?);
  let where_ = val(a.where_)?;
  spawn_task(move || build_query_body(adapter, scope, where_))
}

/// The `buildQuery` export: destructures its argument inside the async function.
pub fn build_query_entry(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn_task(move || async move {
    let d = call(&host()?.build_query_args, &[args.get()])?;
    let adapter = val(js::get_element(d, 0)?)?;
    let scope = (
      val(js::get_element(d, 1)?)?,
      val(js::get_element(d, 2)?)?,
      val(js::get_element(d, 3)?)?,
      val(js::get_element(d, 4)?)?,
    );
    let where_ = val(js::get_element(d, 5)?)?;
    build_query_body(adapter, scope, where_).await
  })
}

async fn build_query_body(adapter: Val, scope: (Val, Val, Val, Val), where_: Val) -> JsResult<Val> {
  let payload = val(get(adapter.get(), "payload")?)?;
  let (collection_slug, fields, global_slug, locale) = scope;
  let scope = Rc::new(Scope { collection_slug, fields, global_slug, locale, parent_is_localized: Val::Bool(false), payload });
  let promise = parse_params(scope, where_)?;
  let result = await_js(promise).await?;
  Ok(result)
}

// ---------------------------------------------------------------------------------------------
// parseParams / buildAndOrConditions

/// Emulated native stack of one TS `parseParams` / `buildAndOrConditions` call (each `and` / `or`
/// level is one of each). The TS limit depends on V8's tier: measured in the int-test runner (debug
/// addon, ~982 KB stack; probes.int.spec.ts "max and-nesting"), 1127 levels cold and 3441 once its
/// frames are optimized. Rust uses the optimized frame (~286 bytes per level): it rejects with V8's
/// RangeError at about the deepest nesting the TS ever accepts, never shallower.
const TS_LEVEL_FRAME: usize = 143;

/// `parseParams({ collectionSlug, fields, globalSlug, locale, parentIsLocalized, payload, where })`
pub fn parse_params(scope: Rc<Scope>, where_: Val) -> JsResult<Local> {
  spawn_task(move || parse_params_body(scope, where_))
}

/// The loop state of `parseParams` (kept across its awaits).
struct ParseParams {
  result: Val,
  /// `for (const relationOrPath of Object.keys(where))`
  keys: Option<ForOf>,
  /// `for (const operator of validOperators)` of the current key, with its `pathOperators`
  operators: Option<(ForOf, Val)>,
  /// the current `relationOrPath` and its `validOperators`
  current_key: Val,
  valid_operators: Val,
}

/// What `parseParams` awaits next.
enum ParseStep {
  Done,
  /// `await buildAndOrConditions({ ..., where: condition })`, then `result[op] = built` if non-empty
  AndOr(Val, Option<&'static str>),
  /// `await buildSearchParam({ ..., incomingPath: relationOrPath, operator, val })`
  Search(Val, Val, Val),
}

impl ParseParams {
  #[inline(never)]
  fn start(where_: &Val) -> JsResult<ParseParams> {
    let result = val(js::object())?;
    let keys = if typeof_object(where_.get()) {
      // We need to determine if the whereKey is an AND, OR, or a schema path
      Some(ForOf::with(&host()?.for_of_keys, &[where_.get()])?)
    } else {
      None
    };
    Ok(ParseParams { result, keys, operators: None, current_key: Val::Undefined, valid_operators: Val::Undefined })
  }

  /// Runs the synchronous part up to the next await (the callee is called by the async body, so
  /// its synchronous part does not run inside this frame).
  #[inline(never)]
  fn next(&mut self, where_: &Val) -> JsResult<ParseStep> {
    let h = host()?;
    loop {
      if let Some((operators, path_operators)) = &self.operators {
        let next = match operators.next() {
          Ok(n) => n,
          Err(e) => {
            // a throwing `next` does not close its own iterator
            self.operators = None;
            return Err(e);
          }
        };
        if let Some(operator) = next {
          let value = get_k(path_operators.get(), operator)?;
          let relation_or_path = self.current_key.clone();
          return Ok(ParseStep::Search(relation_or_path, val(operator)?, val(value)?));
        }
        self.operators = None;
      }
      let Some(keys) = &self.keys else { return Ok(ParseStep::Done) };
      let relation_or_path = match keys.next() {
        Ok(Some(k)) => k,
        Ok(None) => return Ok(ParseStep::Done),
        Err(e) => {
          self.keys = None;
          return Err(e);
        }
      };
      let condition = get_k(where_.get(), relation_or_path)?;
      let condition_operator = if is_lower(relation_or_path, "and")? {
        Some("$and")
      } else if is_lower(relation_or_path, "or")? {
        Some("$or")
      } else {
        None
      };
      if is_array(condition)? {
        return Ok(ParseStep::AndOr(val(condition)?, condition_operator));
      }
      // It's a path - and there can be multiple comparisons on a single path.
      // For example - title like 'test' and title not equal to 'tester'
      // So we need to loop on keys again here to handle each operator independently
      let path_operators = get_k(where_.get(), relation_or_path)?;
      if typeof_object(path_operators) {
        let hh = h.clone();
        let valid_operators = call_with_callback(object_keys(path_operators)?, "filter", "Object.keys(...)", 1, &[], move |args| {
          call(&hh.valid_operator, &[arg(args, 0)])
        })?;
        self.current_key = val(relation_or_path)?;
        self.valid_operators = val(valid_operators)?;
        self.operators =
          Some((ForOf::with(&h.for_of_valid_operators, &[valid_operators])?, val(path_operators)?));
      }
    }
  }

  #[inline(never)]
  fn and_or_built(&mut self, built: &Val, condition_operator: Option<&'static str>) -> JsResult<()> {
    if js::get_f64(get(built.get(), "length")?) > 0.0
      && let Some(op) = condition_operator
    {
      set(self.result.get(), op, built.get())?;
    }
    Ok(())
  }

  #[inline(never)]
  fn search_param_built(&mut self, search_param: &Val) -> JsResult<()> {
    let built = call(
      &host()?.search_param_built,
      &[self.result.get(), search_param.get(), self.valid_operators.get()],
    )?;
    self.result = val(built)?;
    Ok(())
  }

  /// The loop bodies threw: IteratorClose of the open loops (inner first), the error wins.
  #[inline(never)]
  fn close_throw(&mut self, e: Thrown) -> Thrown {
    if let Some((operators, _)) = self.operators.take() {
      operators.close_throw(&e);
    }
    if let Some(keys) = self.keys.take() {
      keys.close_throw(&e);
    }
    e
  }
}

/// `s.toLowerCase() === lit`
fn is_lower(s: Local, lit: &str) -> JsResult<bool> {
  Ok(str_is(call_method(s, "toLowerCase", &[], "relationOrPath")?, lit))
}

async fn parse_params_body(scope: Rc<Scope>, where_: Val) -> JsResult<Val> {
  let mut state = ParseParams::start(&where_)?;
  loop {
    let step = match state.next(&where_) {
      Ok(step) => step,
      Err(e) => return Err(state.close_throw(e)),
    };
    match step {
      ParseStep::Done => return Ok(state.result),
      ParseStep::AndOr(condition, condition_operator) => {
        // `await buildAndOrConditions(...)`: a nested async call run by the task's driver (no
        // native stack per `and` / `or` level)
        let outcome = match executor::call_with_frame(build_and_or_conditions_body(scope.clone(), condition), TS_LEVEL_FRAME).await {
          Ok(promise) => await_js(promise).await,
          Err(e) => Err(e),
        };
        if let Err(e) = outcome.and_then(|built| state.and_or_built(&built, condition_operator)) {
          return Err(state.close_throw(e));
        }
      }
      ParseStep::Search(incoming_path, operator, value) => {
        let args = SearchArgs { scope: scope.clone(), incoming_path, operator, val: value };
        let outcome = match executor::call(build_search_param_body(args)).await {
          Ok(promise) => await_js(promise).await,
          Err(e) => Err(e),
        };
        if let Err(e) = outcome.and_then(|search_param| state.search_param_built(&search_param)) {
          return Err(state.close_throw(e));
        }
      }
    }
  }
}

/// `buildAndOrConditions({ ..., where })`
pub fn build_and_or_conditions(scope: Rc<Scope>, where_: Val) -> JsResult<Local> {
  spawn_task(move || build_and_or_conditions_body(scope, where_))
}

/// `if (Object.keys(result).length > 0) completedConditions.push(result)`
#[inline(never)]
fn push_condition(completed_conditions: &Val, result: &Val) -> JsResult<()> {
  if js::get_f64(get(object_keys(result.get())?, "length")?) > 0.0 {
    push(completed_conditions.get(), "completedConditions", || Ok(result.get()))?;
  }
  Ok(())
}

/// The next `typeof condition === 'object'` condition of the `for...of` (`None` when done).
#[inline(never)]
fn next_condition(conditions: &ForOf) -> JsResult<Option<Val>> {
  while let Some(condition) = conditions.next()? {
    if typeof_object(condition) {
      return Ok(Some(val(condition)?));
    }
  }
  Ok(None)
}

async fn build_and_or_conditions_body(scope: Rc<Scope>, where_: Val) -> JsResult<Val> {
  let completed_conditions = val(js::array())?;
  // Loop over all AND / OR operations and add them to the AND / OR query param
  // Operations should come through as an array
  let conditions = ForOf::with(&host()?.for_of_where, &[where_.get()])?;
  while let Some(condition) = next_condition(&conditions)? {
    let outcome = match executor::call_with_frame(parse_params_body(scope.clone(), condition), TS_LEVEL_FRAME).await {
      Ok(promise) => await_js(promise).await,
      Err(e) => Err(e),
    };
    if let Err(e) = outcome.and_then(|result| push_condition(&completed_conditions, &result)) {
      conditions.close_throw(&e);
      return Err(e);
    }
  }
  Ok(completed_conditions)
}

// ---------------------------------------------------------------------------------------------
// buildSearchParam

pub struct SearchArgs {
  pub scope: Rc<Scope>,
  pub incoming_path: Val,
  pub operator: Val,
  pub val: Val,
}

/// `{ path, value }`
fn search_param(path: Local, value: Local) -> JsResult<Local> {
  object_named(&[("path", path), ("value", value)])
}

/// `{ $in }`
fn in_of(ids: Local) -> JsResult<Local> {
  object_named(&[("$in", ids)])
}

/// `{ [k]: v }` where `v` is evaluated after the key's `ToPropertyKey`.
fn obj1_with(k: Local, v: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  let key = prop_key(k)?;
  let value = v()?;
  object(&[(key, value)])
}

/// `{ [k]: v }` of an already evaluated value.
fn obj1(k: Local, v: Local) -> JsResult<Local> {
  obj1_with(k, || Ok(v))
}

/// `x === n` for a number `n`
fn is_number(x: Local, n: f64) -> bool {
  js::type_of(x) == Type::Number && js::get_f64(x) == n
}

/// The join path of a join field (`relationshipField = getFieldByPath({ fields:
/// collectionConfig.flattenedFields, path: <owner>.on })`, the APIError, the `<locale>`
/// replacement).
fn join_path_of(collection_config: Local, on_owner: Local, payload: Local, locale: Local) -> JsResult<Local> {
  let h = host()?;
  let relationship_field =
    call(&h.get_field_by_path, &[get(collection_config, "flattenedFields")?, get(on_owner, "on")?])?;
  if !js::truthy(relationship_field) {
    return Err(api_error(&units("Relationship field was not found"))?);
  }

  let mut path = get(relationship_field, "localizedPath")?;
  if js::truthy(get(relationship_field, "pathHasLocalized")?) && js::truthy(get(get(payload, "config")?, "localization")?) {
    path = replace_locale_or_default(path, locale, payload)?;
  }
  Ok(path)
}

/// `buildSearchParam({ collectionSlug, fields, globalSlug, incomingPath, locale, operator,
/// parentIsLocalized, payload, val })`: Convert the Payload key / value / operator into a MongoDB query
pub fn build_search_param(a: SearchArgs) -> JsResult<Local> {
  spawn_task(move || build_search_param_body(a))
}

async fn build_search_param_body(a: SearchArgs) -> JsResult<Val> {
  let h = host()?;
  let scope = a.scope.clone();
  let payload = scope.payload.get();
  let operator = a.operator.get();
  let value_arg = a.val.get();

  // Replace GraphQL nested field double underscore formatting
  let mut sanitized_path = call(&h.replace_dunder, &[a.incoming_path.get()])?;
  if str_is(sanitized_path, "id") {
    sanitized_path = js::string("_id");
  }

  let mut paths = js::array();

  let mut has_custom_id = false;

  if str_is(sanitized_path, "_id") {
    let collection_slug = scope.collection_slug.get();
    let custom_id_field_type = if js::truthy(collection_slug) {
      get_opt(get_k(get(payload, "collections")?, collection_slug)?, "customIDType")?
    } else {
      js::undefined()
    };

    let mut id_field_type = js::string("text");

    if js::truthy(custom_id_field_type) {
      id_field_type = custom_id_field_type;
      has_custom_id = true;
    }

    push(paths, "paths", || {
      let parent_is_localized = scope.parent_is_localized.get();
      let field = object_named(&[("name", js::string("id")), ("type", id_field_type)])?;
      object_named(&[
        ("collectionSlug", collection_slug),
        ("complete", js::boolean(true)),
        ("field", field),
        ("parentIsLocalized", if nullish(parent_is_localized) { js::boolean(false) } else { parent_is_localized }),
        ("path", js::string("_id")),
      ])
    })?;
  } else {
    paths = call(
      &h.get_localized_paths,
      &[
        scope.collection_slug.get(),
        scope.fields.get(),
        scope.global_slug.get(),
        sanitized_path,
        scope.locale.get(),
        scope.parent_is_localized.get(),
        payload,
      ],
    )?;
  }

  if !js::truthy(get_k(paths, js::number(0.0))?) {
    return Ok(Val::Undefined);
  }

  let first = call(&h.first_field_path, &[paths])?;
  let field = js::get_element(first, 0)?;
  let path = js::get_element(first, 1)?;
  let paths_length = || get(paths, "length");

  let is_rel_or_upload =
    |field: Local| -> JsResult<bool> { Ok(str_is(get(field, "type")?, "relationship") || str_is(get(field, "type")?, "upload")) };

  if js::truthy(call(&h.has_many_operator, &[operator])?)
    && is_number(paths_length()?, 1.0)
    && is_rel_or_upload(field)?
    && js::truthy(get(field, "hasMany")?)
    && is_string(get(field, "relationTo")?)
    && js::truthy(call(&h.is_nested_relationship_query, &[value_arg])?)
  {
    let promise = build_has_many_relationship_search_param(HasManyArgs {
      field: val(field)?,
      locale: scope.locale.clone(),
      nested_where: a.val.clone(),
      operator: a.operator.clone(),
      path: val(path)?,
      payload: scope.payload.clone(),
    })?;
    return val(promise);
  }

  if str_is(operator, "contains")
    && is_number(paths_length()?, 1.0)
    && str_is(get(field, "type")?, "join")
    && is_string(get(field, "collection")?)
    && js::truthy(call(&h.is_nested_relationship_query, &[value_arg])?)
  {
    let promise = build_join_contains_search_param(JoinContainsArgs {
      field: val(field)?,
      locale: scope.locale.clone(),
      nested_where: a.val.clone(),
      payload: scope.payload.clone(),
    })?;
    return val(promise);
  }

  if (str_is(operator, "contains") || str_is(operator, "like") || str_is(operator, "not_like"))
    && (js::truthy(call(&h.is_nested_relationship_query, &[value_arg])?)
      || (is_array(value_arg)?
        && js::truthy({
          let hh = h.clone();
          call_with_callback(value_arg, "some", "val", 1, &[], move |args| {
            call(&hh.is_nested_relationship_query, &[arg(args, 0)])
          })?
        })))
  {
    let message = concat(&[
      &units("Invalid value for \""),
      &template(operator)?,
      &units("\" on path \""),
      &template(path)?,
      &units("\": expected a string."),
    ]);
    return Err(api_error_status(&message, 400.0)?);
  }

  if !js::truthy(path) {
    return Ok(Val::Undefined);
  }

  let sanitized = sanitize_query_value(&SanitizeArgs {
    field,
    has_custom_id: js::boolean(has_custom_id),
    locale: scope.locale.get(),
    operator,
    parent_is_localized: scope.parent_is_localized.get(),
    path,
    payload,
    val: value_arg,
  })?;

  if !js::truthy(sanitized) {
    return Ok(Val::Undefined);
  }

  // const { operator: formattedOperator, rawQuery, val: formattedValue } = sanitizedQueryValue
  let formatted_operator = get(sanitized, "operator")?;
  let raw_query = get(sanitized, "rawQuery")?;
  let formatted_value = get(sanitized, "val")?;

  if js::truthy(raw_query) && is_number(paths_length()?, 1.0) {
    return val(object_named(&[("value", raw_query)])?);
  }

  if !js::truthy(formatted_operator) {
    return Ok(Val::Undefined);
  }

  // If there are multiple collections to search through,
  // Recursively build up a list of query constraints
  if payload_mongo_live::host::gt(paths_length()?, js::number(1.0))? {
    return relationship_hops(scope, val(paths)?, val(path)?, val(formatted_operator)?, a.val.clone()).await;
  }

  if js::truthy(call(&h.valid_operator, &[formatted_operator])?) {
    let operator_key = get_k(h.operator_map.get(), formatted_operator)?;

    if is_rel_or_upload(field)? {
      let has_number_id_relation = Rc::new(Cell::new(false));
      let multi_id_condition = if str_is(operator_key, "$ne") { "$and" } else { "$or" };

      let first = obj1_with(path, || obj1(operator_key, formatted_value))?;
      let conditions = array(&[first])?;
      let result = object_named(&[("value", object_named(&[(multi_id_condition, conditions)])?)])?;

      if is_string(formatted_value) {
        if object_id_is_valid(formatted_value)? {
          push(conditions, "result.value[multiIDCondition]", || {
            obj1_with(path, || obj1_with(operator_key, || new_object_id(formatted_value)))
          })?;
        } else {
          let relation_tos =
            if is_array(get(field, "relationTo")?)? { get(field, "relationTo")? } else { array(&[get(field, "relationTo")?])? };
          call_with_callback(
            relation_tos,
            "forEach",
            "(Array.isArray(...) ? field.relationTo : [field.relationTo])",
            1,
            &[],
            {
              let (found, payload) = (has_number_id_relation.clone(), val(payload)?);
              move |args: &[Local]| {
                let custom = get_opt(get_k(get(payload.get(), "collections")?, arg(args, 0))?, "customIDType")?;
                if str_is(custom, "number") {
                  found.set(true);
                }
                Ok(js::undefined())
              }
            },
          )?;

          if has_number_id_relation.get() {
            push(conditions, "result.value[multiIDCondition]", || {
              obj1_with(path, || obj1_with(operator_key, || parse_float(formatted_value)))
            })?;
          }
        }
      }

      let length = get(conditions, "length")?;
      if js::type_of(length) == Type::Number && js::get_f64(length) > 1.0 {
        return val(result);
      }
    }

    if str_is(formatted_operator, "like") && is_string(formatted_value) {
      let words = call_method(formatted_value, "split", &[js::string(" ")], "formattedValue")?;
      let and = like_words(words, path, false)?;
      return val(object_named(&[("value", object_named(&[("$and", and)])?)])?);
    }

    if str_is(formatted_operator, "not_like") && is_string(formatted_value) {
      let words = call_method(formatted_value, "split", &[js::string(" ")], "formattedValue")?;
      let and = like_words(words, path, true)?;
      return val(object_named(&[("value", object_named(&[("$and", and)])?)])?);
    }

    // Some operators like 'near' need to define a full query
    // so if there is no operator key, just return the value
    if !js::truthy(operator_key) {
      return val(search_param(path, formatted_value)?);
    }

    return val(search_param(path, obj1(operator_key, formatted_value)?)?);
  }
  Ok(Val::Undefined)
}

/// `words.map((word) => ({ [path]: { $options: 'i', $regex: escapeRegExp(word) } }))` (with
/// `$not` around the regex for `not_like`)
fn like_words(words: Local, path: Local, not: bool) -> JsResult<Local> {
  let (h, path) = (host()?, val(path)?);
  call_with_callback(words, "map", "words", 1, &[], move |args| {
    obj1_with(path.get(), || {
      let regex = object_named(&[("$options", js::string("i")), ("$regex", call(&h.escape_reg_exp, &[arg(args, 0)])?)])?;
      if not { object_named(&[("$not", regex)]) } else { Ok(regex) }
    })
  })
}

/// What a relationship hop does next.
enum Hop {
  Continue,
  Return(Val),
}

/// The `paths.length > 1` part of `buildSearchParam`: relationship / join hops, from the last
/// collection back to the queried one.
async fn relationship_hops(
  scope: Rc<Scope>,
  paths: Val,
  path: Val,
  formatted_operator: Val,
  original_val: Val,
) -> JsResult<Val> {
  let h = host()?;
  // Remove top collection and reverse array to work backwards from top
  let both = call(&h.hop_paths, &[paths.get()])?;
  let paths_to_query = val(js::get_element(both, 0)?)?;
  let parent_paths = val(js::get_element(both, 1)?)?;

  let mut relationship_query = val(object_named(&[("value", js::object())])?)?;

  let entries = ForOf::with(&h.for_of_hop_entries, &[paths_to_query.get()])?;
  loop {
    let Some(entry) = entries.next()? else { break };
    let hop = HopArgs {
      i: val(js::get_element(entry, 0)?)?,
      collection_slug: val(js::get_element(entry, 1)?)?,
      sub_path: val(js::get_element(entry, 2)?)?,
    };
    match relationship_hop(&scope, &hop, &paths_to_query, &parent_paths, &path, &formatted_operator, &original_val, &mut relationship_query).await {
      Ok(Hop::Continue) => {}
      Ok(Hop::Return(v)) => {
        entries.close()?;
        return Ok(v);
      }
      Err(e) => {
        entries.close_throw(&e);
        return Err(e);
      }
    }
  }

  Ok(relationship_query)
}

struct HopArgs {
  i: Val,
  collection_slug: Val,
  sub_path: Val,
}

#[allow(clippy::too_many_arguments)]
async fn relationship_hop(
  scope: &Rc<Scope>,
  hop: &HopArgs,
  paths_to_query: &Val,
  parent_paths: &Val,
  path: &Val,
  formatted_operator: &Val,
  original_val: &Val,
  relationship_query: &mut Val,
) -> JsResult<Hop> {
  let h = host()?;
  let i = hop.i.get();
  let collection_slug = hop.collection_slug.get();
  // The arrays are reversed together, so both entries describe the same relationship hop.
  let parent_field = val(get_opt(get_k(parent_paths.get(), i)?, "field")?)?;

  if !js::truthy(parent_field.get()) {
    return Ok(Hop::Return(Val::Undefined));
  }

  if !js::truthy(collection_slug) {
    let message = concat(&[&units("Collection with the slug "), &template(collection_slug)?, &units(" was not found.")]);
    return Err(api_error(&message)?);
  }

  let payload = scope.payload.get();
  let collection = get_collection(get(payload, "db")?, collection_slug, false)?;
  let collection_config = collection.collection_config;
  let sub_model = collection.model;
  let i_plus_1 = || payload_mongo_live::host::add(hop.i.get(), js::number(1.0));
  let is_last = || -> JsResult<bool> { Ok(js::strict_equals(i_plus_1()?, get(paths_to_query.get(), "length")?)) };

  if is_number(i, 0.0) {
    let build = crate::host::method(sub_model.get(), "buildQuery", "SubModel")?;
    let where_ = obj1_with(hop.sub_path.get(), || obj1(formatted_operator.get(), original_val.get()))?;
    let args = object_named(&[("locale", scope.locale.get()), ("payload", payload), ("where", where_)])?;
    let built = build.call(&[args])?;
    let sub_query = await_js(built).await?;

    let select = object_named(&[("_id", js::boolean(true))])?;

    let mut join_path = Val::Null;

    if str_is(get(parent_field.get(), "type")?, "join") {
      let path = join_path_of(collection_config.get(), parent_field.get(), scope.payload.get(), scope.locale.get())?;
      set_k(select, path, js::boolean(true))?;
      join_path = val(path)?;
    }

    if js::truthy(join_path.get()) {
      set_k(select, join_path.get(), js::boolean(true))?;
    }

    let query = call_method(sub_model.get(), "find", &[sub_query.get()], "SubModel")?;
    let query = call_method(query, "lean", &[], "SubModel.find(...)")?;
    let query = call_method(query, "select", &[select], "SubModel.find(...).lean(...)")?;
    let result = await_js(query).await?;

    let ins_v = val(js::array())?;
    let (hh, join_path_v, ins_cb) = (h.clone(), join_path.clone(), ins_v.clone());
    call_with_callback(result.get(), "forEach", "result", 1, &[], move |args| {
      let (h, ins) = (&hh, ins_cb.get());
      let doc = arg(args, 0);
      let join_path = join_path_v.get();
      if js::truthy(join_path) {
        let mut reference = doc;

        for_of_flow(call(&h.for_of_segments, &[join_path])?, |segment| {
          if is_array(reference)? {
            let segment = val(segment)?;
            let mapped = call_with_callback(reference, "map", "ref", 1, &[], move |args| {
              let item = arg(args, 0);
              if js::type_of(item).is_typeof_object() && js::truthy(item) {
                get_k(item, segment.get())
              } else {
                Ok(js::undefined())
              }
            })?;
            let flat = call_method(mapped, "flat", &[], "ref.map(...)")?;
            reference = call_with_callback(flat, "filter", "ref.map(...).flat(...)", 1, &[], |args| {
              Ok(js::boolean(!nullish(arg(args, 0))))
            })?;
            Ok(Flow::<()>::Next)
          } else if js::type_of(reference).is_typeof_object() && js::truthy(reference) {
            reference = get_k(reference, segment)?;
            Ok(Flow::Next)
          } else {
            reference = js::undefined();
            Ok(Flow::Break)
          }
        })?;

        if is_array(reference)? {
          for_of(reference, |item| {
            if is_object_id(item)? {
              push(ins, "$in", || Ok(item))?;
            }
            Ok(None::<()>)
          })?;
        } else if is_object_id(reference)? {
          push(ins, "$in", || Ok(reference))?;
        }
      } else {
        let string_id = call_method(get(doc, "_id")?, "toString", &[], "doc._id")?;
        if object_id_is_valid(string_id)? {
          push(ins, "$in", || get(doc, "_id"))?;
        } else {
          push(ins, "$in", || Ok(string_id))?;
        }
      }
      Ok(js::undefined())
    })?;
    let ins = ins_v.get();

    if is_number(get(paths_to_query.get(), "length")?, 1.0) {
      let result_path = if js::truthy(join_path.get()) { js::string("_id") } else { path.get() };
      return Ok(Hop::Return(val(search_param(result_path, in_of(ins)?)?)?));
    }

    let next_sub_path = get_opt(get_k(paths_to_query.get(), i_plus_1()?)?, "path")?;

    if js::truthy(next_sub_path) {
      let value = if js::truthy(join_path.get()) {
        object_named(&[("_id", in_of(ins)?)])?
      } else {
        obj1_with(next_sub_path, || in_of(ins))?
      };
      *relationship_query = val(object_named(&[("value", value)])?)?;
    }

    return Ok(Hop::Continue);
  }

  let sub_query = val(get(relationship_query.get(), "value")?)?;

  // Follow this join back to its parent IDs.
  if str_is(get(parent_field.get(), "type")?, "join") {
    let join_path = join_path_of(collection_config.get(), parent_field.get(), scope.payload.get(), scope.locale.get())?;

    let distinct = call_method(sub_model.get(), "distinct", &[join_path, sub_query.get()], "SubModel")?;
    let ins = await_js(distinct).await?;
    if is_last()? {
      return Ok(Hop::Return(val(search_param(js::string("_id"), in_of(ins.get())?)?)?));
    }

    *relationship_query = val(object_named(&[("value", object_named(&[("_id", in_of(ins.get())?)])?)])?)?;
    return Ok(Hop::Continue);
  }

  let found = call_method(sub_model.get(), "find", &[sub_query.get(), h.sub_query_options.get()], "SubModel")?;
  let result = await_js(found).await?;

  let ins = call_with_callback(result.get(), "map", "result", 1, &[], |args| get(arg(args, 0), "_id"))?;

  // If it is the last recursion then pass through the search param
  if is_last()? {
    *relationship_query = val(search_param(path.get(), in_of(ins)?)?)?;
  } else {
    let next_sub_path = get_opt(get_k(paths_to_query.get(), i_plus_1()?)?, "path")?;
    if js::truthy(next_sub_path) {
      *relationship_query = val(object_named(&[("value", obj1_with(next_sub_path, || in_of(ins))?)])?)?;
    }
  }
  Ok(Hop::Continue)
}

struct HasManyArgs {
  field: Val,
  locale: Val,
  nested_where: Val,
  operator: Val,
  path: Val,
  payload: Val,
}

/// `buildHasManyRelationshipSearchParam({ field, locale, nestedWhere, operator, path, payload })`
fn build_has_many_relationship_search_param(a: HasManyArgs) -> JsResult<Local> {
  spawn_task(move || async move {
    let h = host()?;
    let field = a.field.get();
    let payload = a.payload.get();
    if (!str_is(get(field, "type")?, "relationship") && !str_is(get(field, "type")?, "upload"))
      || !js::truthy(get(field, "hasMany")?)
      || !is_string(get(field, "relationTo")?)
      || !js::truthy(call(&h.is_nested_relationship_query, &[a.nested_where.get()])?)
    {
      return Ok(Val::Undefined);
    }

    let collection = get_collection(get(payload, "db")?, get(field, "relationTo")?, false)?;
    let related_model = collection.model;
    let path_locale = if js::truthy(get(get(payload, "config")?, "localization")?) {
      let locale_codes = get(get(get(payload, "config")?, "localization")?, "localeCodes")?;
      let path = a.path.clone();
      call_with_callback(locale_codes, "find", "payload.config.localization.localeCodes", 1, &[], move |args| {
        let segments = call_method(path.get(), "split", &[js::string(".")], "path")?;
        let last = call_method(segments, "at", &[js::number(-1.0)], "path.split(...)")?;
        Ok(js::boolean(js::strict_equals(last, arg(args, 0))))
      })?
    } else {
      js::undefined()
    };
    let build = crate::host::method(related_model.get(), "buildQuery", "RelatedModel")?;
    let locale = if nullish(path_locale) { a.locale.get() } else { path_locale };
    let args = object_named(&[("locale", locale), ("payload", payload), ("where", a.nested_where.get())])?;
    let built = build.call(&[args])?;
    let matching_related_documents_query = await_js(built).await?;

    let operator = a.operator.get();
    if str_is(operator, "contains") {
      let promise = find_related_document_ids(related_model.clone(), matching_related_documents_query.clone())?;
      let ids = await_js(promise).await?;
      return val(search_param(a.path.get(), in_of(ids.get())?)?);
    }
    if str_is(operator, "equals") {
      // Every related document satisfies an empty nested query.
      if !js::truthy(get(object_keys(matching_related_documents_query.get())?, "length")?) {
        return val(search_param(a.path.get(), object_named(&[("$nin", js::array())])?)?);
      }

      let promise = find_related_document_ids(related_model.clone(), matching_related_documents_query.clone())?;
      let ids = await_js(promise).await?;
      let not = object_named(&[("$elemMatch", object_named(&[("$nin", ids.get())])?)])?;
      return val(search_param(a.path.get(), object_named(&[("$not", not)])?)?);
    }
    if str_is(operator, "not_equals") {
      let promise = find_related_document_ids(related_model.clone(), matching_related_documents_query.clone())?;
      let ids = await_js(promise).await?;
      return val(search_param(a.path.get(), object_named(&[("$nin", ids.get())])?)?);
    }
    Ok(Val::Undefined)
  })
}

/// `findRelatedDocumentIDs = async (query) => (await RelatedModel.find(query).lean().select({ _id: true })).map((document) => document._id)`
fn find_related_document_ids(related_model: Val, query: Val) -> JsResult<Local> {
  spawn_task(move || async move {
    let found = call_method(related_model.get(), "find", &[query.get()], "RelatedModel")?;
    let found = call_method(found, "lean", &[], "RelatedModel.find(...)")?;
    let found = call_method_with(found, "select", "RelatedModel.find(...).lean(...)", || {
      Ok(vec![object_named(&[("_id", js::boolean(true))])?])
    })?;
    let documents = await_js(found).await?;
    let ids = call_with_callback(documents.get(), "map", "(intermediate value)", 1, &[], |args| get(arg(args, 0), "_id"))?;
    val(ids)
  })
}

struct JoinContainsArgs {
  field: Val,
  locale: Val,
  nested_where: Val,
  payload: Val,
}

/// `buildJoinContainsSearchParam({ field, locale, nestedWhere, payload })`
fn build_join_contains_search_param(a: JoinContainsArgs) -> JsResult<Local> {
  spawn_task(move || async move {
    let h = host()?;
    let field = a.field.get();
    let payload = a.payload.get();
    if !str_is(get(field, "type")?, "join")
      || !is_string(get(field, "collection")?)
      || !js::truthy(call(&h.is_nested_relationship_query, &[a.nested_where.get()])?)
    {
      return Ok(Val::Undefined);
    }

    let collection = get_collection(get(payload, "db")?, get(field, "collection")?, false)?;
    let joined_model = collection.model;

    let join_path = val(join_path_of(collection.collection_config.get(), field, payload, a.locale.get())?)?;

    let build = crate::host::method(joined_model.get(), "buildQuery", "JoinedModel")?;
    let args = object_named(&[("locale", a.locale.get()), ("payload", payload), ("where", a.nested_where.get())])?;
    let built = build.call(&[args])?;
    let sub_query = await_js(built).await?;

    let distinct = call_method(joined_model.get(), "distinct", &[join_path.get(), sub_query.get()], "JoinedModel")?;
    let parent_ids = await_js(distinct).await?;

    val(search_param(js::string("_id"), in_of(parent_ids.get())?)?)
  })
}

// ---------------------------------------------------------------------------------------------
// exported entries of the module-internal functions (upstream exports them from their files)

fn scope_from(d: Local, indices: [u32; 6]) -> JsResult<Rc<Scope>> {
  Ok(Rc::new(Scope {
    collection_slug: val(js::get_element(d, indices[0])?)?,
    fields: val(js::get_element(d, indices[1])?)?,
    global_slug: val(js::get_element(d, indices[2])?)?,
    locale: val(js::get_element(d, indices[3])?)?,
    parent_is_localized: val(js::get_element(d, indices[4])?)?,
    payload: val(js::get_element(d, indices[5])?)?,
  }))
}

/// `parseParams(args)` export.
pub fn parse_params_entry(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn_task(move || async move {
    // { collectionSlug, fields, globalSlug, locale, parentIsLocalized, payload, where }
    let d = call(&host()?.parse_params_args, &[args.get()])?;
    let scope = scope_from(d, [0, 1, 2, 3, 4, 5])?;
    parse_params_body(scope, val(js::get_element(d, 6)?)?).await
  })
}

/// `buildSearchParam(args)` export.
pub fn build_search_param_entry(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn_task(move || async move {
    // { collectionSlug, fields, globalSlug, incomingPath, locale, operator, parentIsLocalized, payload, val }
    let d = call(&host()?.build_search_param_args, &[args.get()])?;
    let scope = scope_from(d, [0, 1, 2, 4, 6, 7])?;
    build_search_param_body(SearchArgs {
      scope,
      incoming_path: val(js::get_element(d, 3)?)?,
      operator: val(js::get_element(d, 5)?)?,
      val: val(js::get_element(d, 8)?)?,
    })
    .await
  })
}

/// `buildAndOrConditions(args)` export (the same destructuring as `parseParams`, inside the async
/// function: a destructuring error rejects).
pub fn build_and_or_conditions_entry(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn_task(move || async move {
    let d = call(&host()?.parse_params_args, &[args.get()])?;
    let scope = scope_from(d, [0, 1, 2, 3, 4, 5])?;
    build_and_or_conditions_body(scope, val(js::get_element(d, 6)?)?).await
  })
}

/// `sanitizeQueryValue(args)` export (synchronous, like upstream).
pub fn sanitize_query_value_entry(args: Local) -> JsResult<Local> {
  // { field, hasCustomID, locale, operator, parentIsLocalized, path, payload, val }
  let d = call(&host()?.sanitize_query_value_args, &[args])?;
  let e = |i| js::get_element(d, i);
  sanitize_query_value(&SanitizeArgs {
    field: e(0)?,
    has_custom_id: e(1)?,
    locale: e(2)?,
    operator: e(3)?,
    parent_is_localized: e(4)?,
    path: e(5)?,
    payload: e(6)?,
    val: e(7)?,
  })
}

// ---------------------------------------------------------------------------------------------
// getBuildQueryPlugin / Model.buildQuery

thread_local! {
  /// db-mongodb's `getBuildQueryPlugin` (verbatim in the host) over the Rust `parseParams`.
  static GET_BUILD_QUERY_PLUGIN: std::cell::RefCell<Option<Persist>> = const { std::cell::RefCell::new(None) };
}

/// Creates the host's `getBuildQueryPlugin` for this binding's `parseParams` export (`init`).
pub fn install_build_query_plugin(parse_params_export: Local) -> JsResult<()> {
  let f = call(&host()?.create_get_build_query_plugin, &[parse_params_export])?;
  let f = Persist::new(f)?;
  GET_BUILD_QUERY_PLUGIN.with(|g| *g.borrow_mut() = Some(f));
  Ok(())
}

/// `getBuildQueryPlugin({ collectionSlug, versionsFields } = {})`: returns upstream's
/// `function buildQueryPlugin(schema)`, which assigns the `async function schemaBuildQuery` static
/// (real JS functions; `schemaBuildQuery` awaits the Rust `parseParams`).
pub fn get_build_query_plugin(args: Local) -> JsResult<Local> {
  let f = GET_BUILD_QUERY_PLUGIN
    .with(|g| g.borrow().as_ref().map(Persist::get))
    .ok_or_else(|| js::engine_error("mongo live query binding not initialized"))?;
  js::call(f, js::undefined(), &[args])
}
