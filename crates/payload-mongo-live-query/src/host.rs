//! JS helpers the port calls (installed by the binding's `init(host)`, see
//! `test/__rs/mongo-live-query/glue.ts`) and the JS-semantic operations built on them.
//!
//! A helper is either a function the TS calls at that point (payload's `getLocalizedPaths`,
//! `getFieldByPath`, `deepMergeWithCombinedArrays`, `escapeRegExp`, `isNestedRelationshipQuery`,
//! mongoose's `Types`, `APIError`, `parseFloat`, ...) or a TS expression copied verbatim where its
//! exact semantics come from the language itself (parameter destructuring with its V8 messages,
//! `for...of`, array destructuring, spreads, template-literal `ToString`). Control flow, the
//! callbacks of `forEach` / `map` / `reduce` / `some` / `find` / `filter` and every await stay in
//! Rust.

use std::cell::RefCell;
use std::ptr;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::host as rt;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val};

macro_rules! live_query_host {
  ($($field:ident => $js:literal),* $(,)?) => {
    pub struct Host {
      $(pub $field: Persist,)*
    }

    /// Installs the helper object (`init(host)` of the binding).
    pub fn install(obj: Local) -> JsResult<()> {
      let f = |name: &str| -> JsResult<Persist> {
        let v = js::get_named(obj, name)?;
        if js::type_of(v) == Type::Undefined {
          return Err(js::engine_error(&format!("mongo live query host helper `{name}` is missing")));
        }
        Persist::new(v)
      };
      let host = Host { $($field: f($js)?,)* };
      HOST.with(|h| *h.borrow_mut() = Some(Rc::new(host)));
      Ok(())
    }
  };
}

live_query_host! {
  done => "DONE",
  for_of => "forOf",
  for_of_keys => "forOfKeys",
  for_of_where => "forOfWhere",
  for_of_valid_operators => "forOfValidOperators",
  for_of_hop_entries => "forOfHopEntries",
  for_of_segments => "forOfSegments",
  for_of_blocks => "forOfBlocks",
  step => "step",
  close_return => "closeReturn",
  close_throw => "closeThrow",
  in_op => "inOp",
  template => "template",
  string_of => "stringOf",
  to_property_key => "toPropertyKey",
  new_date => "newDate",
  is_nan_date_parse => "isNaNDateParse",
  is_nan_number => "isNaNNumber",
  replace => "replace",
  replace_dunder => "replaceDunder",
  replace_locale_or_default => "replaceLocaleOrDefault",
  first_field_path => "firstFieldPath",
  hop_paths => "hopPaths",
  search_param_built => "searchParamBuilt",
  build_exists_query => "buildExistsQuery",
  spread_filtered => "spreadFiltered",
  operator_map => "operatorMap",
  create_get_build_query_plugin => "createGetBuildQueryPlugin",
  destructure4 => "destructure4",
  spread => "spread",
  is_nested_relationship_query => "isNestedRelationshipQuery",
  valid_operator => "isValidOperator",
  has_many_operator => "isHasManyRelationshipOperator",
  get_localized_paths => "getLocalizedPaths",
  get_field_by_path => "getFieldByPath",
  escape_reg_exp => "escapeRegExp",
  create_array_from_comma_delineated => "createArrayFromCommaDelineated",
  field_should_be_localized => "fieldShouldBeLocalized",
  field_affects_data => "fieldAffectsData",
  field_is_presentational_only => "fieldIsPresentationalOnly",
  deep_copy_object_simple => "deepCopyObjectSimple",
  get_select_mode => "getSelectMode",
  sub_query_options => "subQueryOptions",
  build_query_args => "buildQueryArgs",
  parse_params_args => "parseParamsArgs",
  build_search_param_args => "buildSearchParamArgs",
  sanitize_query_value_args => "sanitizeQueryValueArgs",
  build_sort_param_args => "buildSortParamArgs",
  localized_sort_property_args => "getLocalizedSortPropertyArgs",
  projection_args => "buildProjectionFromSelectArgs",
}

thread_local! {
  static HOST: RefCell<Option<Rc<Host>>> = const { RefCell::new(None) };
}

pub fn host() -> JsResult<Rc<Host>> {
  HOST
    .with(|h| h.borrow().clone())
    .ok_or_else(|| js::engine_error("mongo live query binding not initialized"))
}

/// Calls a helper (`this` undefined).
pub fn call(f: &Persist, args: &[Local]) -> JsResult<Local> {
  js::call(f.get(), js::undefined(), args)
}

pub fn val(v: Local) -> JsResult<Val> {
  Val::from_local(v)
}

// ---------------------------------------------------------------------------------------------
// strings (UTF-16 code units, exactly as JS sees them)

pub type Units = Vec<u16>;

pub fn units(s: &str) -> Units {
  s.encode_utf16().collect()
}

/// The code units of a JS string value, `None` for other values.
pub fn units_of(v: Local) -> Option<Units> {
  js::get_string_utf16(v)
}

/// A JS string with these code units.
pub fn string(u: &[u16]) -> Local {
  js::property_key_utf16(u)
}

pub fn eq(u: &[u16], lit: &str) -> bool {
  u.len() == lit.len() && u.iter().zip(lit.bytes()).all(|(a, b)| *a == u16::from(b))
}

/// `v === 'lit'`
pub fn str_is(v: Local, lit: &str) -> bool {
  js::type_of(v) == Type::String && units_of(v).is_some_and(|u| eq(&u, lit))
}

pub fn is_string(v: Local) -> bool {
  js::type_of(v) == Type::String
}

pub fn concat(parts: &[&[u16]]) -> Units {
  let mut out = Units::with_capacity(parts.iter().map(|p| p.len()).sum());
  for p in parts {
    out.extend_from_slice(p);
  }
  out
}

/// Template-literal `${v}` (`ToString`, which throws for symbols and calls `toString` /
/// `valueOf` of objects, like the TS).
pub fn template(v: Local) -> JsResult<Units> {
  if let Some(u) = units_of(v) {
    return Ok(u);
  }
  let s = call(&host()?.template, &[v])?;
  Ok(units_of(s).unwrap_or_default())
}

// ---------------------------------------------------------------------------------------------
// property operations

/// `o[name]` (JS semantics for any `o`)
pub fn get(o: Local, name: &str) -> JsResult<Local> {
  rt::get(o, js::key(name))
}

/// `o[k]`
pub fn get_k(o: Local, k: Local) -> JsResult<Local> {
  rt::get(o, k)
}

/// `o?.[name]`
pub fn get_opt(o: Local, name: &str) -> JsResult<Local> {
  rt::get_optional(o, js::key(name))
}

/// `o[name] = v` (strict mode)
pub fn set(o: Local, name: &str, v: Local) -> JsResult<()> {
  rt::set(o, js::key(name), v)
}

/// `o[k] = v` (strict mode)
pub fn set_k(o: Local, k: Local, v: Local) -> JsResult<()> {
  rt::set(o, k, v)
}

/// `delete o[k]` (strict mode)
pub fn del_k(o: Local, k: Local) -> JsResult<()> {
  rt::del(o, k)
}

/// A property of an object literal (`{ [k]: v }`): CreateDataProperty, so `__proto__` and keys
/// with setters on `Object.prototype` become own data properties like in the literal.
pub fn define(o: Local, k: Local, v: Local) -> JsResult<()> {
  let desc = sys::napi_property_descriptor {
    utf8name: ptr::null(),
    name: k.0,
    method: None,
    getter: None,
    setter: None,
    value: v.0,
    attributes: sys::PropertyAttributes::writable
      | sys::PropertyAttributes::enumerable
      | sys::PropertyAttributes::configurable,
    data: ptr::null_mut(),
  };
  js::check(unsafe { sys::napi_define_properties(js::env(), o.0, 1, &desc) })
}

/// An object literal with these properties, in order.
pub fn object(props: &[(Local, Local)]) -> JsResult<Local> {
  let o = js::object();
  for (k, v) in props {
    define(o, *k, *v)?;
  }
  Ok(o)
}

/// `{ name: v, ... }` with static names.
pub fn object_named(props: &[(&str, Local)]) -> JsResult<Local> {
  let o = js::object();
  for (k, v) in props {
    define(o, js::key(k), *v)?;
  }
  Ok(o)
}

/// An array literal.
pub fn array(items: &[Local]) -> JsResult<Local> {
  let a = js::array();
  for (i, v) in items.iter().enumerate() {
    define(a, js::key(&i.to_string()), *v)?;
  }
  Ok(a)
}

/// `key in o`
pub fn has(o: Local, key: &str) -> JsResult<bool> {
  if js::type_of(o).is_object_like() {
    return js::has_property(o, js::key(key));
  }
  Ok(js::get_bool(call(&host()?.in_op, &[js::key(key), o])?))
}

/// `typeof v === 'object'` (true for `null`)
pub fn typeof_object(v: Local) -> bool {
  js::type_of(v).is_typeof_object()
}

/// `ToPropertyKey(k)` of a computed key (`{ [k]: v }`, `o[k] = v`): strings and symbols are their
/// own key; anything else goes through the language (`toString` / `valueOf` of objects, a symbol
/// returned by `toString`, the canonical number spelling).
pub fn prop_key(k: Local) -> JsResult<Local> {
  match js::type_of(k) {
    Type::String | Type::Symbol => Ok(k),
    _ => call(&host()?.to_property_key, &[k]),
  }
}

// ---------------------------------------------------------------------------------------------
// global built-ins (read where the TS evaluates the identifier: replaced globals are seen)

/// The current value of the global binding `name` (`Number`, `parseFloat`, `Array`, ...).
pub fn global(name: &str) -> JsResult<Local> {
  js::get_named(js::global(), name)
}

/// A callee evaluated before the arguments of the call (`recv.name`, `Global.name`, `parseFloat`):
/// [`Method::call`] checks callability after the arguments were evaluated, like V8.
pub struct Method {
  this: Local,
  func: Local,
  expr: String,
}

impl Method {
  /// `this.func(...args)` (`TypeError: <expr> is not a function` for a non-callable).
  pub fn call(&self, args: &[Local]) -> JsResult<Local> {
    if js::type_of(self.func) != Type::Function {
      return Err(type_error(&format!("{} is not a function", self.expr))?);
    }
    js::call(self.func, self.this, args)
  }
}

/// `recv.name` read now (`expr` is the receiver's source text).
pub fn method(recv: Local, name: &str, expr: &str) -> JsResult<Method> {
  Ok(Method { this: recv, func: get(recv, name)?, expr: format!("{expr}.{name}") })
}

/// `Global.name` read now (`Number.isNaN`, `Array.isArray`, `Object.keys`).
pub fn global_method(global_name: &str, name: &str) -> JsResult<Method> {
  let this = global(global_name)?;
  Ok(Method { this, func: get(this, name)?, expr: format!("{global_name}.{name}") })
}

/// A global function read now (`parseFloat`, `Number`, `Boolean`), called with `this` undefined.
pub fn global_function(name: &str) -> JsResult<Method> {
  Ok(Method { this: js::undefined(), func: global(name)?, expr: name.to_string() })
}

/// `Array.isArray(v)` (the global at call time; true for proxies of arrays)
pub fn is_array(v: Local) -> JsResult<bool> {
  Ok(js::truthy(global_method("Array", "isArray")?.call(&[v])?))
}

/// `Object.keys(v)` (the global at call time)
pub fn object_keys(v: Local) -> JsResult<Local> {
  global_method("Object", "keys")?.call(&[v])
}

/// `parseFloat(v)` (the global at call time)
pub fn parse_float(v: Local) -> JsResult<Local> {
  global_function("parseFloat")?.call(&[v])
}

/// `Number(v)` (the global at call time)
pub fn number(v: Local) -> JsResult<Local> {
  global_function("Number")?.call(&[v])
}

/// `Boolean(v)` (the global at call time)
pub fn boolean_of(v: Local) -> JsResult<Local> {
  global_function("Boolean")?.call(&[v])
}

/// `Number.isNaN(v)` (the global at call time)
pub fn is_nan(v: Local) -> JsResult<bool> {
  Ok(js::truthy(global_method("Number", "isNaN")?.call(&[v])?))
}

/// `arr.length` of an array the engine created or got from `Object.keys` / `split`.
pub fn length(arr: Local) -> u32 {
  js::array_length(arr)
}

/// `recv.name(...args)` with arguments that have no effects of their own (already evaluated
/// values); `expr` is the receiver's source text for V8's `"<expr>.<name> is not a function"`.
pub fn call_method(recv: Local, name: &str, args: &[Local], expr: &str) -> JsResult<Local> {
  method(recv, name, expr)?.call(args)
}

/// `recv.name(<args>)` where evaluating the arguments has effects: the method is read first, then
/// `args` runs, then the call (callability checked at the call, like V8).
pub fn call_method_with(
  recv: Local,
  name: &str,
  expr: &str,
  args: impl FnOnce() -> JsResult<Vec<Local>>,
) -> JsResult<Local> {
  let m = method(recv, name, expr)?;
  let args = args()?;
  m.call(&args)
}

/// `arr.push(<value>)` through the receiver's `push` (read before the argument is evaluated).
pub fn push(arr: Local, expr: &str, value: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  let m = method(arr, "push", expr)?;
  let v = value()?;
  m.call(&[v])
}

/// `['a', 'b', ...].includes(v)`: a fresh array literal and the current `includes`.
pub fn lit_includes(lits: &[&str], v: Local) -> JsResult<bool> {
  let items: Vec<Local> = lits.iter().map(|l| js::string(l)).collect();
  let arr = array(&items)?;
  let text = format!("[{}]", lits.iter().map(|l| format!("'{l}'")).collect::<Vec<_>>().join(", "));
  Ok(js::truthy(call_method(arr, "includes", &[v], &text)?))
}

/// A `TypeError` with this message (the realm's class).
pub fn type_error(message: &str) -> JsResult<Thrown> {
  Ok(payload_mongo_live::error::new_error("TypeError", &[js::string(message)]))
}

/// `new APIError(message)`
pub fn api_error(message: &[u16]) -> JsResult<Thrown> {
  Ok(payload_mongo_live::error::new_error("APIError", &[string(message)]))
}

/// `new APIError(message, status)`
pub fn api_error_status(message: &[u16], status: f64) -> JsResult<Thrown> {
  Ok(payload_mongo_live::error::new_error("APIError", &[string(message), js::number(status)]))
}

// ---------------------------------------------------------------------------------------------
// `Types.ObjectId` (mongoose's, read where the TS evaluates the callee: before the argument)

fn object_id_class() -> JsResult<Local> {
  get(payload_mongo_live::bson::types()?, "ObjectId")
}

/// `Types.ObjectId.isValid(<arg>)`
pub fn is_valid_object_id(arg: impl FnOnce() -> JsResult<Local>) -> JsResult<bool> {
  let ctor = object_id_class()?;
  let m = Method { this: ctor, func: get(ctor, "isValid")?, expr: "Types.ObjectId.isValid".to_string() };
  let a = arg()?;
  Ok(js::truthy(m.call(&[a])?))
}

/// `Types.ObjectId.isValid(v)` of an already evaluated value.
pub fn object_id_is_valid(v: Local) -> JsResult<bool> {
  is_valid_object_id(|| Ok(v))
}

/// `new Types.ObjectId(<arg>)`
pub fn new_object_id_of(arg: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  let ctor = object_id_class()?;
  let a = arg()?;
  payload_mongo_live::bson::construct(ctor, &[a], "Types.ObjectId")
}

/// `new Types.ObjectId(v)` of an already evaluated value.
pub fn new_object_id(v: Local) -> JsResult<Local> {
  new_object_id_of(|| Ok(v))
}

/// `s.replace('<locale>', replacement)` (string replacement patterns included)
pub fn replace_locale(s: Local, replacement: Local) -> JsResult<Local> {
  call(&host()?.replace, &[s, js::string("<locale>"), replacement])
}

/// `path.replace('<locale>', locale || payload.config.localization.defaultLocale)`
pub fn replace_locale_or_default(path: Local, locale: Local, payload: Local) -> JsResult<Local> {
  call(&host()?.replace_locale_or_default, &[path, locale, payload])
}

// ---------------------------------------------------------------------------------------------
// `for...of`

/// A `for...of` loop over a JS value, stepped from Rust (a generator running the real loop, so
/// the iterator protocol, holes and V8's errors are the language's). Survives awaits.
pub struct ForOf(Val);

impl ForOf {
  pub fn new(iterable: Local) -> JsResult<ForOf> {
    Ok(ForOf(val(call(&host()?.for_of, &[iterable])?)?))
  }

  /// The loop of a host generator that runs the upstream `for...of` statement itself (its iterable
  /// expression, head destructuring and V8's `<expr> is not iterable` message); `args` are the
  /// variables the expression reads.
  pub fn with(generator: &Persist, args: &[Local]) -> JsResult<ForOf> {
    Ok(ForOf(val(call(generator, args)?)?))
  }

  /// The next value, `None` when done.
  pub fn next(&self) -> JsResult<Option<Local>> {
    let h = host()?;
    let v = call(&h.step, &[self.0.get()])?;
    if js::strict_equals(v, h.done.get()) { Ok(None) } else { Ok(Some(v)) }
  }

  /// Leaving the loop with `return` / `break`: IteratorClose with a normal completion (errors of
  /// the iterator's `return` propagate).
  pub fn close(&self) -> JsResult<()> {
    call(&host()?.close_return, &[self.0.get()]).map(|_| ())
  }

  /// Leaving the loop because its body threw: IteratorClose with a throw completion (the original
  /// error wins).
  pub fn close_throw(&self, e: &Thrown) {
    if let Ok(h) = host() {
      let _ = call(&h.close_throw, &[self.0.get(), e.0.get()]);
    }
  }
}

/// What a `for...of` body does next.
pub enum Flow<R> {
  Next,
  /// `break`
  Break,
  /// `return r`
  Return(R),
}

/// Runs `body` for each value of `for (const x of iterable)` (synchronous loops).
pub fn for_of_flow<R>(iterable: Local, mut body: impl FnMut(Local) -> JsResult<Flow<R>>) -> JsResult<Option<R>> {
  let it = ForOf::new(iterable)?;
  loop {
    let Some(v) = it.next()? else { return Ok(None) };
    match body(v) {
      Ok(Flow::Next) => {}
      Ok(Flow::Break) => {
        it.close()?;
        return Ok(None);
      }
      Ok(Flow::Return(r)) => {
        it.close()?;
        return Ok(Some(r));
      }
      Err(e) => {
        it.close_throw(&e);
        return Err(e);
      }
    }
  }
}

/// Runs `body` for each value of `for (const x of iterable)` (synchronous loops). `body` returns
/// `Ok(Some(r))` to `return r` from inside the loop.
pub fn for_of<R>(iterable: Local, mut body: impl FnMut(Local) -> JsResult<Option<R>>) -> JsResult<Option<R>> {
  for_of_flow(iterable, |v| Ok(match body(v)? {
    None => Flow::Next,
    Some(r) => Flow::Return(r),
  }))
}

// ---------------------------------------------------------------------------------------------
// callbacks (`arr.forEach((doc) => { ... })` with the arrow function's body in Rust)

/// The arrow callback `(a[, b]) => body(...)` (the runtime's `js::arrow`: upstream `length`, not
/// constructible, no `prototype`, empty name). The body is owned by the function (freed with it),
/// so user code may keep the callback and call it later, re-entrantly or recursively, like the TS
/// closure: it must capture `Val`s, never `Local`s.
pub fn arrow(arity: usize, body: impl Fn(&[Local]) -> JsResult<Local> + 'static) -> JsResult<Local> {
  js::arrow(arity, body)
}

/// `recv.name((a[, b]) => body(...), ...extra)` with the real method of `recv` (read before the
/// arguments are evaluated, callability checked at the call).
pub fn call_with_callback(
  recv: Local,
  name: &str,
  expr: &str,
  arity: usize,
  extra: &[Local],
  body: impl Fn(&[Local]) -> JsResult<Local> + 'static,
) -> JsResult<Local> {
  let m = method(recv, name, expr)?;
  let cb = arrow(arity, body)?;
  let mut args = Vec::with_capacity(1 + extra.len());
  args.push(cb);
  args.extend_from_slice(extra);
  m.call(&args)
}

/// Argument `i` of a callback (`undefined` when missing).
pub fn arg(args: &[Local], i: usize) -> Local {
  args.get(i).copied().unwrap_or_else(js::undefined)
}
