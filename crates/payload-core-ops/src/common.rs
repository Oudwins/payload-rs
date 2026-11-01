//! Utilities shared by the operations:
//! - `executeAccess` (packages/payload/src/auth/executeAccess.ts)
//! - `buildBeforeOperation` / `buildAfterOperation` (collections/operations/utilities)
//! - `sanitizeSortQuery` (collections/operations/utilities/sanitizeSortQuery.ts)
//! - `hasVersionsEnabled` / `hasDraftsEnabled` (utilities/getVersionsConfig.ts)
//! - the collection `beforeRead` / `afterRead` hook loops the operations inline.

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use crate::host::{self, call, call_fn, get, get_val, has, is_typeof_object, opt, val};

/// The destructured `executeAccess` operation args (`isReadingStaticFile` before its default).
pub struct AccessArgs {
  pub id: Val,
  pub slug: Val,
  pub data: Val,
  pub disable_errors: Val,
  pub is_reading_static_file: Val,
  pub req: Val,
}

impl AccessArgs {
  /// `{ slug, disableErrors, req }` (the other keys absent).
  pub fn new(slug: Val, disable_errors: Val, req: Val) -> AccessArgs {
    AccessArgs {
      id: Val::Undefined,
      slug,
      data: Val::Undefined,
      disable_errors,
      is_reading_static_file: Val::Undefined,
      req,
    }
  }
}

/// `executeAccess(args, access)`: returns its promise.
pub fn execute_access(a: AccessArgs, access: Val) -> JsResult<Local> {
  spawn(execute_access_body(a, access))
}

/// The body of `executeAccess` (after its parameter destructuring).
pub async fn execute_access_body(a: AccessArgs, access: Val) -> JsResult<Val> {
  {
    // isReadingStaticFile = false
    let is_reading_static_file =
      if a.is_reading_static_file.is_undefined() { Val::Bool(false) } else { a.is_reading_static_file.clone() };
    if js::truthy(access.get()) {
      let args = call(
        "accessArgs",
        &[a.id.get(), a.slug.get(), a.data.get(), is_reading_static_file.get(), a.req.get()],
      )?;
      let p = call_fn(access.get(), js::undefined(), &[args], "access")?;
      let resolved_constraint = await_js(p).await?;
      if !js::truthy(resolved_constraint.get()) && !js::truthy(a.disable_errors.get()) {
        let t = get(a.req.get(), "t")?;
        return Err(host::throw_from("forbidden", &[t]));
      }
      return Ok(resolved_constraint);
    }
    if js::truthy(get(a.req.get(), "user")?) {
      return Ok(Val::Bool(true));
    }
    if !js::truthy(a.disable_errors.get()) {
      let t = get(a.req.get(), "t")?;
      return Err(host::throw_from("forbidden", &[t]));
    }
    Ok(Val::Bool(false))
  }
}

/// `operationToHookOperation` (collections/operations/utilities/types.ts).
pub fn hook_operation(operation: &str) -> &'static str {
  match operation {
    "count" => "count",
    "countVersions" => "countVersions",
    "create" => "create",
    "delete" | "deleteByID" => "delete",
    "find" | "findByID" | "findVersionByID" | "findVersions" | "read" => "read",
    "findDistinct" | "readDistinct" => "readDistinct",
    "forgotPassword" => "forgotPassword",
    "login" => "login",
    "refresh" => "refresh",
    "resetPassword" => "resetPassword",
    "restoreVersion" => "restoreVersion",
    "unlock" => "unlock",
    "update" | "updateByID" => "update",
    _ => "",
  }
}

/// `buildBeforeOperation({ args, collection, operation, overrideAccess })`: returns its promise.
pub fn build_before_operation(
  args: Val,
  collection: Val,
  operation: &'static str,
  override_access: Val,
) -> JsResult<Local> {
  spawn(async move {
    let mut new_args = args.clone();
    // args.collection.config.hooks?.beforeOperation?.length
    let config = get(get(args.get(), "collection")?, "config")?;
    let length = opt(opt(get(config, "hooks")?, "beforeOperation")?, "length")?;
    if js::truthy(length) {
      let hook_operation = hook_operation(operation);
      let config = get(get(args.get(), "collection")?, "config")?;
      let hooks = host::iterable(get(get(config, "hooks")?, "beforeOperation")?)?;
      let mut i = 0;
      while i < js::array_length(hooks.get()) {
        let hook = host::element(hooks.get(), i)?;
        let context = get(get(args.get(), "req")?, "context")?;
        let req = get(args.get(), "req")?;
        let hook_args = call(
          "beforeOperationArgs",
          &[new_args.get(), collection.get(), context, js::string(hook_operation), override_access.get(), req],
        )?;
        let p = call_fn(hook, js::undefined(), &[hook_args], "hook")?;
        let hook_result = await_js(p).await?;
        if !hook_result.is_undefined() {
          new_args = hook_result;
        }
        i += 1;
      }
    }
    Ok(new_args)
  })
}

/// `buildAfterOperation({ args, collection, operation, overrideAccess, result })`: returns its
/// promise.
pub fn build_after_operation(
  args: Val,
  collection: Val,
  operation: &'static str,
  override_access: Val,
  result: Val,
) -> JsResult<Local> {
  spawn(async move {
    let mut new_result = result;
    // args.collection.config.hooks?.afterOperation?.length
    let config = get(get(args.get(), "collection")?, "config")?;
    let length = opt(opt(get(config, "hooks")?, "afterOperation")?, "length")?;
    if js::truthy(length) && !host::mutant(3) {
      let config = get(get(args.get(), "collection")?, "config")?;
      let hooks = host::iterable(get(get(config, "hooks")?, "afterOperation")?)?;
      let mut i = 0;
      while i < js::array_length(hooks.get()) {
        let hook = host::element(hooks.get(), i)?;
        let req = get(args.get(), "req")?;
        let hook_args = call(
          "afterOperationArgs",
          &[args.get(), collection.get(), js::string(operation), override_access.get(), req, new_result.get()],
        )?;
        let p = call_fn(hook, js::undefined(), &[hook_args], "hook")?;
        let hook_result = await_js(p).await?;
        if !hook_result.is_undefined() {
          new_result = hook_result;
        }
        i += 1;
      }
    }
    Ok(new_result)
  })
}

/// `hasVersionsEnabled(config)`: `Boolean(config?.versions)`.
pub fn has_versions_enabled(config: Local) -> JsResult<bool> {
  Ok(js::truthy(opt(config, "versions")?))
}

/// `hasDraftsEnabled(config)`:
/// `Boolean(config?.versions && typeof config.versions === 'object' && config.versions.drafts)`.
pub fn has_drafts_enabled(config: Local) -> JsResult<bool> {
  if !js::truthy(opt(config, "versions")?) {
    return Ok(false);
  }
  if js::type_of(get(config, "versions")?) != Type::Object {
    return Ok(false);
  }
  Ok(js::truthy(get(get(config, "versions")?, "drafts")?))
}

/// `sanitizeSortQuery({ fields, sort })`
pub fn sanitize_sort_query(fields: Local, sort: Local) -> JsResult<Local> {
  if !js::truthy(sort) {
    return Ok(js::undefined());
  }
  if js::is_array(sort) {
    // sort.map((sort) => sanitizeSort({ fields, sort }))
    return host::map_array(sort, "sort", |item| sanitize_sort(fields, item));
  }
  sanitize_sort(fields, sort)
}

/// `sanitizeSort({ fields, sort })` (private in sanitizeSortQuery.ts). Strings are handled here;
/// any other value goes to the JS copy, which throws exactly where the TS does.
fn sanitize_sort(fields: Local, sort: Local) -> JsResult<Local> {
  let Some(units) = js::get_string_utf16(sort) else {
    return call("sanitizeSortValue", &[fields, sort]);
  };
  let minus = u16::from(b'-');
  let dot = u16::from(b'.');
  // if (sort.indexOf('-') === 0) { desc = true; sortProperty = sortProperty.substring(1) }
  let desc = units.first() == Some(&minus);
  let property = if desc { &units[1..] } else { &units[..] };
  let mut fields = fields;
  for segment in property.split(|u| *u == dot) {
    // fields.find((each) => each.name === segment)
    let field = call("findByName", &[fields, host::string_utf16(segment)])?;
    if !js::truthy(field) {
      return Ok(sort);
    }
    if has(field, "fields")? {
      fields = get(field, "flattenedFields")?;
      continue;
    }
    if has(field, "virtual")? {
      let virtual_path = get(field, "virtual")?;
      if js::type_of(virtual_path) == Type::String {
        return call("prefixSort", &[js::boolean(desc), virtual_path]);
      }
    }
  }
  Ok(sort)
}

/// What a collection read hook loop replaces.
#[derive(Clone)]
pub enum HookTarget {
  /// `docRef = (await hook({ ..., doc: docRef, ... })) || docRef`
  Doc(Val),
  /// `obj.version = (await hook({ ..., doc: obj.version, ... })) || obj.version`
  Version(Val),
}

/// The collection `beforeRead`/`afterRead` hook loop of the read operations:
/// `for (const hook of collectionConfig.hooks[name]) { target = (await hook({ collection, context:
/// req.context, doc, [findMany: true,] overrideAccess, query, req })) || target }`.
/// Returns the final doc for [`HookTarget::Doc`] and `undefined` otherwise.
pub struct ReadHooks {
  pub collection_config: Val,
  pub hook_name: &'static str,
  pub find_many: bool,
  pub override_access: Val,
  pub query: Val,
  pub req: Val,
}

impl ReadHooks {
  pub async fn run(&self, target: HookTarget) -> JsResult<Val> {
    let hooks = host::iterable(get(get(self.collection_config.get(), "hooks")?, self.hook_name)?)?;
    let mut doc_ref = match &target {
      HookTarget::Doc(doc) => doc.clone(),
      HookTarget::Version(_) => Val::Undefined,
    };
    let mut i = 0;
    while i < js::array_length(hooks.get()) {
      let hook = host::element(hooks.get(), i)?;
      let context = get(self.req.get(), "context")?;
      let doc = match &target {
        HookTarget::Doc(_) => doc_ref.get(),
        HookTarget::Version(obj) => get(obj.get(), "version")?,
      };
      let hook_args = call(
        if self.find_many && !host::mutant(5) { "readManyHookArgs" } else { "readHookArgs" },
        &[self.collection_config.get(), context, doc, self.override_access.get(), self.query.get(), self.req.get()],
      )?;
      let p = call_fn(hook, js::undefined(), &[hook_args], "hook")?;
      let hook_result = if host::mutant(1) && !host::is_promise(p) { Val::from_local(p)? } else { await_js(p).await? };
      match &target {
        HookTarget::Doc(_) => {
          if js::truthy(hook_result.get()) {
            doc_ref = hook_result;
          }
        }
        HookTarget::Version(obj) => {
          let value = if js::truthy(hook_result.get()) { hook_result.get() } else { get(obj.get(), "version")? };
          host::set(obj.get(), "version", value)?;
        }
      }
      i += 1;
    }
    Ok(doc_ref)
  }
}

/// `collectionConfig?.hooks?.[name]?.length` (truthiness).
pub fn has_hooks(collection_config: Local, name: &str) -> JsResult<bool> {
  Ok(js::truthy(opt(opt(opt(collection_config, "hooks")?, name)?, "length")?))
}

/// `collectionConfig.hooks[name]?.length` (truthiness; `hooks` not optional).
pub fn has_hooks_strict(collection_config: Local, name: &str) -> JsResult<bool> {
  Ok(js::truthy(opt(opt(get(collection_config, "hooks")?, name)?, "length")?))
}

/// Reads `name` of a destructured-args array built by a host helper.
pub fn at(arr: Local, i: u32) -> JsResult<Val> {
  val(js::get_element(arr, i)?)
}

/// `a ?? b` on values.
pub fn nullish_or(a: Val, b: impl FnOnce() -> JsResult<Val>) -> JsResult<Val> {
  if host::is_nullish(a.get()) { b() } else { Ok(a) }
}

/// `a || b` on values.
pub fn or(a: Val, b: impl FnOnce() -> JsResult<Val>) -> JsResult<Val> {
  if js::truthy(a.get()) { Ok(a) } else { b() }
}

/// `typeof select?.version === 'object' ? select.version : undefined`
pub fn version_select(select: Local) -> JsResult<Local> {
  let version = opt(select, "version")?;
  if is_typeof_object(version) { get(select, "version") } else { Ok(js::undefined()) }
}

/// `await payload.db[method](args)` building the args after reading the method (callee first).
pub fn db_call(payload: Local, method: &str, build_args: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  let db = get(payload, "db")?;
  let f = get(db, method)?;
  let args = build_args()?;
  call_fn(f, db, &[args], &format!("payload.db.{method}"))
}

/// The `collectionConfig.slug` etc. as kept values.
pub fn get_v(o: &Val, name: &str) -> JsResult<Val> {
  get_val(o.get(), name)
}
