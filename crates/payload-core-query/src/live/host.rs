//! JS helpers the live query port calls, installed by the binding's `init`
//! (`test/__rs/core-query/glue.ts` defines them), and the JS-semantic operations built on them.
//!
//! A helper is either a Payload function the TS calls at that point (`getEntityPermissions`,
//! `executeAccess`, `isolateObjectProperty`, `isNestedRelationshipQuery`, `fieldAffectsData`,
//! `deepCopyObjectSimple`, `QueryError`, ...) or a TS expression copied verbatim (destructuring
//! patterns with their defaults, `for...in` / `for...of` loops, `fields.find(...)`, spreads,
//! object literals), so property reads, iterator protocol steps, `this` values and V8 error
//! messages are the ones the TS produces. Control flow, awaits and task structure stay in Rust.

use std::cell::RefCell;
use std::rc::Rc;

use payload_core_runtime::host as rt;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

macro_rules! query_host {
  ($($field:ident => $js:literal),* $(,)?) => {
    pub struct QueryHost {
      $(pub $field: Persist,)*
    }

    /// Installs the helper object (`init(host)` of the binding).
    pub fn install(obj: Local) -> JsResult<()> {
      let f = |name: &str| -> JsResult<Persist> {
        let v = js::get_named(obj, name)?;
        if js::type_of(v) == Type::Undefined {
          return Err(js::engine_error(&format!("core query host helper `{name}` is missing")));
        }
        Persist::new(v)
      };
      let host = QueryHost { $($field: f($js)?,)* };
      HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
      Ok(())
    }
  };
}

query_host! {
  done => "DONE",
  for_in => "forIn",
  for_of => "forOf",
  next => "next",
  is_array => "isArray",
  in_op => "inOp",
  str => "str",
  object_entries => "objectEntries",
  push_path => "pushPath",
  greater_than_zero => "lengthGreaterThanZero",
  new_query_error => "newQueryError",
  new_api_error => "newAPIError",
  default_policies => "defaultPolicies",
  validate_query_paths_args => "validateQueryPathsArgs",
  validate_search_param_args => "validateSearchParamArgs",
  validate_sort_query_args => "validateSortQueryArgs",
  sanitize_join_query_args => "sanitizeJoinQueryArgs",
  get_localized_paths_args => "getLocalizedPathsArgs",
  get_field_by_path_args => "getFieldByPathArgs",
  sanitize_where_query_args => "sanitizeWhereQueryArgs",
  prefix_where_paths_args => "prefixWherePathsArgs",
  fields_of => "fieldsOf",
  slug_of => "slugOf",
  localized_paths_args => "localizedPathsArgs",
  collection_config_of => "collectionConfigOf",
  await_global_permissions => "awaitGlobalPermissions",
  await_collection_permissions => "awaitCollectionPermissions",
  await_execute_access => "awaitExecuteAccess",
  is_nested_relationship_query => "isNestedRelationshipQuery",
  some_nested => "someNested",
  field_affects_data => "fieldAffectsData",
  field_should_be_localized => "fieldShouldBeLocalized",
  has_where_access_result => "hasWhereAccessResult",
  deep_copy_object_simple => "deepCopyObjectSimple",
  find_fields_to_search => "findFieldsToSearch",
  find_in_block => "findInBlock",
  find_current => "findCurrent",
  find_collection_flattened_fields => "findCollectionFlattenedFields",
  find_block => "findBlock",
  blocks_of => "blocksOf",
  locale_codes_include => "localeCodesInclude",
  relation_to_field => "relationToField",
  id_field => "idField",
  text_field => "textField",
  strip_locale => "stripLocale",
  no_read_permission => "noReadPermission",
  scoped_and => "scopedAnd",
  append_and => "appendAnd",
  prefix_map => "prefixMap",
  nested_where => "nestedWhere",
  exists_true => "existsTrue",
  split_path => "splitPath",
  sort_path => "sortPath",
  sort_fields_of => "sortFieldsOf",
  joins_of => "joinsOf",
  polymorphic_joins_of => "polymorphicJoinsOf",
  join_collections_of => "joinCollectionsOf",
  is_polymorphic_join => "isPolymorphicJoin",
  join_sort => "joinSort",
  and_of => "andOf",
  path_to_query => "pathToQuery",
  field_by_path_result => "fieldByPathResult",
}

thread_local! {
  static HOST: RefCell<Option<Rc<QueryHost>>> = const { RefCell::new(None) };
}

pub fn host() -> JsResult<Rc<QueryHost>> {
  HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("core query binding not initialized"))
}

/// Calls a helper (`this` undefined).
pub fn call(f: &Persist, args: &[Local]) -> JsResult<Local> {
  js::call(f.get(), js::undefined(), args)
}

pub fn val(v: Local) -> JsResult<Val> {
  Val::from_local(v)
}

// ---------------------------------------------------------------------------------------------
// property operations (JS semantics: TypeErrors for nullish receivers, strict-mode writes)

/// `o[k]`
pub fn get(o: Local, k: Local) -> JsResult<Local> {
  rt::get(o, k)
}

/// `o.name`
pub fn get_named(o: Local, name: &str) -> JsResult<Local> {
  rt::get_named(o, name)
}

/// `o?.name`
pub fn get_optional(o: Local, name: &str) -> JsResult<Local> {
  rt::get_optional(o, js::key(name))
}

/// `o[k] = v` (strict mode)
pub fn set(o: Local, k: Local, v: Local) -> JsResult<()> {
  rt::set(o, k, v)
}

pub fn set_named(o: Local, name: &str, v: Local) -> JsResult<()> {
  rt::set(o, js::key(name), v)
}

/// `delete o[k]` (strict mode)
pub fn del(o: Local, k: Local) -> JsResult<()> {
  rt::del(o, k)
}

/// `key in obj` (TypeError for primitives).
pub fn in_op(key: &str, obj: Local) -> JsResult<bool> {
  if js::type_of(obj).is_object_like() {
    return js::has_property(obj, js::key(key));
  }
  Ok(js::truthy(call(&host()?.in_op, &[js::key(key), obj])?))
}

/// `Array.isArray(v)` (true for proxies of arrays, unlike `napi_is_array`).
pub fn is_array(v: Local) -> JsResult<bool> {
  if !js::type_of(v).is_object_like() {
    return Ok(false);
  }
  Ok(js::truthy(call(&host()?.is_array, &[v])?))
}

pub fn truthy(v: Local) -> bool {
  js::truthy(v)
}

/// `typeof v === 'object'` (true for `null`).
pub fn is_typeof_object(v: Local) -> bool {
  js::type_of(v).is_typeof_object()
}

pub fn is_string(v: Local) -> bool {
  js::type_of(v) == Type::String
}

/// `v === 'literal'`
pub fn str_eq(v: Local, lit: &str) -> bool {
  js::get_string_utf16(v).is_some_and(|u| eq(&u, lit))
}

/// `v === false`
pub fn is_false(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && !js::get_bool(v)
}

/// `v === true`
pub fn is_true(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && js::get_bool(v)
}

/// `` `${v}` `` (ToString, as template literals do).
pub fn to_string(v: Local) -> JsResult<Units> {
  if let Some(u) = js::get_string_utf16(v) {
    return Ok(u);
  }
  let s = call(&host()?.str, &[v])?;
  Ok(js::get_string_utf16(s).unwrap_or_default())
}

/// `errors.push({ path })`
pub fn push_path(errors: Local, path: &[u16]) -> JsResult<()> {
  call(&host()?.push_path, &[errors, string(path)]).map(|_| ())
}

/// `errors.length > 0`
pub fn has_errors(errors: Local) -> JsResult<bool> {
  Ok(js::truthy(call(&host()?.greater_than_zero, &[errors])?))
}

/// `new QueryError(errors)` (the payload class; `data` is `errors` itself).
pub fn query_error(errors: Local) -> JsResult<Thrown> {
  Ok(Thrown(val(call(&host()?.new_query_error, &[errors])?)?))
}

/// `new APIError(message)`
pub fn api_error(message: &str) -> JsResult<Thrown> {
  Ok(Thrown(val(call(&host()?.new_api_error, &[js::string(message)])?)?))
}

/// `Promise.all(promises)` over a fresh array of the task promises.
pub fn promise_all(promises: &[Val]) -> JsResult<Local> {
  let arr = js::array();
  for (i, p) in promises.iter().enumerate() {
    js::set_element(arr, i as u32, p.get())?;
  }
  rt::call_host(&rt::host()?.promise_all, &[arr])
}

// ---------------------------------------------------------------------------------------------
// iteration

/// A `for (const k in o)` / `for (const x of v)` loop, driven by a host generator that contains
/// the loop itself, so key snapshots, deletion checks, the iterator protocol and error messages
/// are V8's. Keep it as a [`Val`] when the loop body awaits.
pub struct Loop(pub Val);

impl Loop {
  /// `for (const key in o)`
  pub fn for_in(o: Local) -> JsResult<Loop> {
    Ok(Loop(val(call(&host()?.for_in, &[o])?)?))
  }

  /// `for (const item of v)`
  pub fn for_of(v: Local) -> JsResult<Loop> {
    Ok(Loop(val(call(&host()?.for_of, &[v])?)?))
  }

  /// A loop generator built by a site-specific helper (same expression text as the TS loop).
  pub fn from_helper(f: &Persist, args: &[Local]) -> JsResult<Loop> {
    Ok(Loop(val(call(f, args)?)?))
  }

  /// The next item, or `None` when the loop is done.
  pub fn next(&self) -> JsResult<Option<Local>> {
    let h = host()?;
    let item = call(&h.next, &[self.0.get()])?;
    Ok((!js::strict_equals(item, h.done.get())).then_some(item))
  }
}

// ---------------------------------------------------------------------------------------------
// strings: JS strings as UTF-16 code units (lone surrogates kept)

pub type Units = Vec<u16>;

pub fn units(s: &str) -> Units {
  s.encode_utf16().collect()
}

pub fn eq(u: &[u16], lit: &str) -> bool {
  u.iter().copied().eq(lit.encode_utf16())
}

/// The JS string with these code units.
pub fn string(u: &[u16]) -> Local {
  js::property_key_utf16(u)
}

/// Code units of a JS string value (`None` for non-strings).
pub fn units_of(v: Local) -> Option<Units> {
  js::get_string_utf16(v)
}

/// `s.split('.')`
pub fn split_dot(s: &[u16]) -> Vec<Units> {
  s.split(|u| *u == u16::from(b'.')).map(<[u16]>::to_vec).collect()
}

/// `parts.join('.')`
pub fn join_dot(parts: &[Units]) -> Units {
  let mut out = Units::new();
  for (i, p) in parts.iter().enumerate() {
    if i > 0 {
      out.push(u16::from(b'.'));
    }
    out.extend_from_slice(p);
  }
  out
}

/// `` `${a}.${b}` `` for strings.
pub fn dot(a: &[u16], b: &[u16]) -> Units {
  let mut out = a.to_vec();
  out.push(u16::from(b'.'));
  out.extend_from_slice(b);
  out
}

/// `s.replace(/<from>/g, to)` for a literal pattern (left to right, non-overlapping).
pub fn replace_all(s: &[u16], from: &str, to: &str) -> Units {
  let from = units(from);
  let to = units(to);
  let mut out = Units::new();
  let mut i = 0;
  while i < s.len() {
    if s[i..].starts_with(&from) {
      out.extend_from_slice(&to);
      i += from.len();
    } else {
      out.push(s[i]);
      i += 1;
    }
  }
  out
}

/// `s.replace('<from>', to)` (first occurrence).
pub fn replace_first(s: &[u16], from: &str, to: &str) -> Units {
  let from = units(from);
  match s.windows(from.len().max(1)).position(|w| w == from.as_slice()) {
    Some(i) if !from.is_empty() => {
      let mut out = s[..i].to_vec();
      out.extend(units(to));
      out.extend_from_slice(&s[i + from.len()..]);
      out
    }
    _ if from.is_empty() => {
      let mut out = units(to);
      out.extend_from_slice(s);
      out
    }
    _ => s.to_vec(),
  }
}

/// `['and', 'or'].includes(key.toLowerCase())`. No non-ASCII code point lowercases to an ASCII
/// letter of these words, so an ASCII case-insensitive comparison is exact.
pub fn is_and_or(key: &[u16]) -> bool {
  let lower: Vec<u16> = key
    .iter()
    .map(|u| if (u16::from(b'A')..=u16::from(b'Z')).contains(u) { u + 32 } else { *u })
    .collect();
  eq(&lower, "and") || eq(&lower, "or")
}

/// `SAFE_FIELD_PATH_REGEX.test(path)` (`/^\w+(?:\.\w+)*$/`, ASCII `\w`).
pub fn is_safe_field_path(path: &[u16]) -> bool {
  let word = |u: &u16| *u < 128 && ((*u as u8).is_ascii_alphanumeric() || *u == u16::from(b'_'));
  !path.is_empty() && path.split(|u| *u == u16::from(b'.')).all(|seg| !seg.is_empty() && seg.iter().all(word))
}
