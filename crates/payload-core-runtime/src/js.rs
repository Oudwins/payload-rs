//! Thin, allocation-free wrappers over raw Node-API.
//!
//! Rules (enforced by convention, see RUST_CORE_DESIGN.md):
//! - [`Local`] handles are only valid inside the current synchronous segment (the napi
//!   callback that is running). Never keep one across an `.await`.
//! - Anything kept across an `.await` is a [`Val`] (primitives copied, everything else a
//!   [`Persist`] reference).
//! - All JS-observable operations go through these helpers so the engine performs exactly the
//!   property reads/writes/calls the TS reference does, in the same order.

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr;
use std::rc::Rc;

use napi::sys;

thread_local! {
  static ENV: Cell<sys::napi_env> = const { Cell::new(ptr::null_mut()) };
  /// JS array holding primitives napi cannot reference (strings, bigints): `Val::Slot` indexes.
  static SLOTS: std::cell::RefCell<(Option<Persist>, Vec<u32>, u32)> = const { std::cell::RefCell::new((None, Vec::new(), 0)) };
}

/// A slot in the primitive table. Freed (set to undefined, index recycled) on drop.
pub struct Slot(u32);

impl Slot {
  fn new(value: Local) -> JsResult<Slot> {
    SLOTS.with(|s| {
      let mut s = s.borrow_mut();
      if s.0.is_none() {
        s.0 = Some(Persist::new(array())?);
      }
      let index = match s.1.pop() {
        Some(i) => i,
        None => {
          s.2 += 1;
          s.2 - 1
        }
      };
      set_element(s.0.as_ref().map(|p| p.get()).unwrap_or_else(undefined), index, value)?;
      Ok(Slot(index))
    })
  }

  pub fn get(&self) -> Local {
    SLOTS.with(|s| {
      let s = s.borrow();
      match &s.0 {
        Some(arr) => get_element(arr.get(), self.0).unwrap_or_else(|_| undefined()),
        None => undefined(),
      }
    })
  }
}

impl Drop for Slot {
  fn drop(&mut self) {
    if env().is_null() {
      return;
    }
    // `try_with`: slots owned by other thread locals may be dropped during thread-local
    // destruction, after the table itself.
    let _ = SLOTS.try_with(|s| {
      if let Ok(mut s) = s.try_borrow_mut() {
        if let Some(arr) = &s.0 {
          let _ = set_element(arr.get(), self.0, undefined());
        }
        s.1.push(self.0);
      }
    });
  }
}

/// Registers (once per env) a cleanup hook that clears the recorded env when the Node.js
/// environment shuts down, so persistent handles dropped afterwards (thread-local caches during
/// thread teardown) do not call into a dead env.
pub fn register_env_cleanup(env: sys::napi_env) {
  unsafe extern "C" fn cleanup(_arg: *mut c_void) {
    let _ = ENV.try_with(|e| e.set(ptr::null_mut()));
    let _ = CLEANUP_REGISTERED.try_with(|r| r.set(false));
  }
  if CLEANUP_REGISTERED.with(|r| r.replace(true)) {
    return;
  }
  unsafe { sys::napi_add_env_cleanup_hook(env, Some(cleanup), ptr::null_mut()) };
}

thread_local! {
  static CLEANUP_REGISTERED: Cell<bool> = const { Cell::new(false) };
}

/// Records the env of the napi call that is currently running. Every exported entry point and
/// every resume callback sets it before touching JS. Also counts the call: every Node-API entry
/// into a core engine crate (runtime, field hooks, validators, query, operations) goes through
/// here, so tests can tell whether a run reached the engine at all (see [`entries`]).
pub fn set_env(env: sys::napi_env) {
  ENV.with(|e| e.set(env));
  ENTRIES.with(|e| e.set(e.get() + 1));
}

thread_local! {
  static ENTRIES: Cell<u64> = const { Cell::new(0) };
}

/// [`set_env`] for finalizers: garbage collection runs them at any time, which is not a call into
/// the engine, so they are not counted.
pub fn set_env_uncounted(env: sys::napi_env) {
  ENV.with(|e| e.set(env));
}

/// Takes back one [`set_env`] count (for entries that are not engine work, like `stats`).
pub fn uncount_entry() {
  ENTRIES.with(|e| e.set(e.get().saturating_sub(1)));
}

/// Number of Node-API entries into the core engine crates on this thread ([`set_env`] calls).
pub fn entries() -> u64 {
  ENTRIES.with(|e| e.get())
}

/// The current env, or null once the thread's locals are being destroyed (drops of persistent
/// handles during thread-local teardown then skip their napi calls).
pub fn env() -> sys::napi_env {
  ENV.try_with(|e| e.get()).unwrap_or(ptr::null_mut())
}

#[derive(Clone, Copy, Debug)]
#[repr(transparent)]
pub struct Local(pub sys::napi_value);

/// A JS value thrown by user code or by the engine, kept alive across awaits.
pub struct Thrown(pub Val);

pub type JsResult<T> = Result<T, Thrown>;

/// Persistent reference to a JS value (strong, refcount 1).
pub struct Persist(sys::napi_ref);

impl Persist {
  #[track_caller]
  pub fn new(value: Local) -> JsResult<Persist> {
    let mut r = ptr::null_mut();
    check(unsafe { sys::napi_create_reference(env(), value.0, 1, &mut r) })?;
    Ok(Persist(r))
  }

  pub fn get(&self) -> Local {
    let mut v = ptr::null_mut();
    unsafe { sys::napi_get_reference_value(env(), self.0, &mut v) };
    Local(v)
  }
}

impl Drop for Persist {
  fn drop(&mut self) {
    let env = env();
    if !env.is_null() {
      unsafe { sys::napi_delete_reference(env, self.0) };
    }
  }
}

/// A JS value that survives awaits. Booleans and numbers are copied, strings and bigints live in
/// the slot table (napi cannot reference primitives), objects/functions/symbols are shared
/// persistent references so identity is preserved.
#[derive(Clone)]
pub enum Val {
  Undefined,
  Null,
  Bool(bool),
  Num(f64),
  Ref(Rc<Persist>),
  Slot(Rc<Slot>),
}

impl Val {
  pub fn from_local(v: Local) -> JsResult<Val> {
    Ok(match type_of(v) {
      Type::Undefined => Val::Undefined,
      Type::Null => Val::Null,
      Type::Boolean => Val::Bool(get_bool(v)),
      Type::Number => Val::Num(get_f64(v)),
      Type::String | Type::BigInt => Val::Slot(Rc::new(Slot::new(v)?)),
      _ => Val::Ref(Rc::new(Persist::new(v)?)),
    })
  }

  pub fn get(&self) -> Local {
    match self {
      Val::Undefined => undefined(),
      Val::Null => null(),
      Val::Bool(b) => boolean(*b),
      Val::Num(n) => number(*n),
      Val::Ref(p) => p.get(),
      Val::Slot(s) => s.get(),
    }
  }

  pub fn is_undefined(&self) -> bool {
    matches!(self, Val::Undefined)
  }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Type {
  Undefined,
  Null,
  Boolean,
  Number,
  String,
  Symbol,
  Object,
  Function,
  External,
  BigInt,
}

impl Type {
  /// `typeof` result, as JS reports it.
  pub fn js_typeof(self) -> &'static str {
    match self {
      Type::Undefined => "undefined",
      Type::Null | Type::Object | Type::External => "object",
      Type::Boolean => "boolean",
      Type::Number => "number",
      Type::String => "string",
      Type::Symbol => "symbol",
      Type::Function => "function",
      Type::BigInt => "bigint",
    }
  }

  /// `typeof v === 'object'` (true for null).
  pub fn is_typeof_object(self) -> bool {
    self.js_typeof() == "object"
  }

  /// Values napi can do property operations on directly.
  pub fn is_object_like(self) -> bool {
    matches!(self, Type::Object | Type::Function | Type::External)
  }
}

#[track_caller]
pub fn check(status: sys::napi_status) -> JsResult<()> {
  if status == sys::Status::napi_ok {
    return Ok(());
  }
  let env = env();
  let mut message = String::from("napi call failed");
  unsafe {
    let mut info: *const sys::napi_extended_error_info = ptr::null();
    if sys::napi_get_last_error_info(env, &mut info) == sys::Status::napi_ok
      && !info.is_null()
      && !(*info).error_message.is_null()
    {
      message = std::ffi::CStr::from_ptr((*info).error_message).to_string_lossy().into_owned();
    }
    let mut pending = false;
    sys::napi_is_exception_pending(env, &mut pending);
    if pending {
      let mut exc = ptr::null_mut();
      sys::napi_get_and_clear_last_exception(env, &mut exc);
      return Err(Thrown(Val::from_local(Local(exc)).unwrap_or(Val::Undefined)));
    }
  }
  let at = std::panic::Location::caller();
  Err(engine_error(&format!("{message} ({}:{})", at.file(), at.line())))
}

/// An `Error` created by the engine itself (not by user code).
pub fn engine_error(message: &str) -> Thrown {
  let env = env();
  unsafe {
    let msg = string(message);
    let mut err = ptr::null_mut();
    sys::napi_create_error(env, ptr::null_mut(), msg.0, &mut err);
    Thrown(Val::from_local(Local(err)).unwrap_or(Val::Undefined))
  }
}

pub fn undefined() -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_get_undefined(env(), &mut v) };
  Local(v)
}

pub fn null() -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_get_null(env(), &mut v) };
  Local(v)
}

pub fn boolean(b: bool) -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_get_boolean(env(), b, &mut v) };
  Local(v)
}

pub fn number(n: f64) -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_create_double(env(), n, &mut v) };
  Local(v)
}

pub fn string(s: &str) -> Local {
  let mut v = ptr::null_mut();
  // ASCII is valid Latin-1, which V8 copies without UTF-8 decoding.
  if s.is_ascii() {
    unsafe { sys::napi_create_string_latin1(env(), s.as_ptr().cast(), s.len() as isize, &mut v) };
  } else {
    unsafe { sys::napi_create_string_utf8(env(), s.as_ptr().cast(), s.len() as isize, &mut v) };
  }
  Local(v)
}

/// Exact UTF-16 copy of a JS string (lone surrogates preserved), or `None` for non-strings.
pub fn get_string_utf16(v: Local) -> Option<Vec<u16>> {
  if type_of(v) != Type::String {
    return None;
  }
  let env = env();
  let mut len = 0usize;
  unsafe {
    sys::napi_get_value_string_utf16(env, v.0, ptr::null_mut(), 0, &mut len);
    let mut buf = vec![0u16; len + 1];
    sys::napi_get_value_string_utf16(env, v.0, buf.as_mut_ptr(), len + 1, &mut len);
    buf.truncate(len);
    Some(buf)
  }
}

/// The internalized property-key string with these UTF-16 code units (equal, as a JS value, to
/// the string they were copied from).
pub fn property_key_utf16(units: &[u16]) -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::node_api_create_property_key_utf16(env(), units.as_ptr(), units.len() as isize, &mut v) };
  Local(v)
}

pub fn object() -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_create_object(env(), &mut v) };
  Local(v)
}

pub fn array() -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_create_array(env(), &mut v) };
  Local(v)
}

pub fn global() -> Local {
  let mut v = ptr::null_mut();
  unsafe { sys::napi_get_global(env(), &mut v) };
  Local(v)
}

pub fn type_of(v: Local) -> Type {
  let mut t = 0;
  unsafe { sys::napi_typeof(env(), v.0, &mut t) };
  match t {
    sys::ValueType::napi_undefined => Type::Undefined,
    sys::ValueType::napi_null => Type::Null,
    sys::ValueType::napi_boolean => Type::Boolean,
    sys::ValueType::napi_number => Type::Number,
    sys::ValueType::napi_string => Type::String,
    sys::ValueType::napi_symbol => Type::Symbol,
    sys::ValueType::napi_function => Type::Function,
    sys::ValueType::napi_external => Type::External,
    9 => Type::BigInt,
    _ => Type::Object,
  }
}

pub fn get_bool(v: Local) -> bool {
  let mut b = false;
  unsafe { sys::napi_get_value_bool(env(), v.0, &mut b) };
  b
}

pub fn get_f64(v: Local) -> f64 {
  let mut n = 0.0;
  unsafe { sys::napi_get_value_double(env(), v.0, &mut n) };
  n
}

/// Rust copy of a JS string (lone surrogates become U+FFFD). Only used for engine-internal
/// comparisons and paths, never written back where identity/exact content matters.
pub fn get_string(v: Local) -> Option<String> {
  if type_of(v) != Type::String {
    return None;
  }
  let env = env();
  let mut len = 0usize;
  unsafe {
    sys::napi_get_value_string_utf8(env, v.0, ptr::null_mut(), 0, &mut len);
    let mut buf = vec![0u8; len + 1];
    sys::napi_get_value_string_utf8(env, v.0, buf.as_mut_ptr().cast(), len + 1, &mut len);
    buf.truncate(len);
    Some(String::from_utf8_lossy(&buf).into_owned())
  }
}

/// `Boolean(v)` / truthiness. ToBoolean never throws.
pub fn truthy(v: Local) -> bool {
  match type_of(v) {
    Type::Undefined | Type::Null => false,
    Type::Boolean => get_bool(v),
    Type::Number => {
      let n = get_f64(v);
      n != 0.0 && !n.is_nan()
    }
    Type::Object | Type::Function | Type::Symbol | Type::External => true,
    Type::String | Type::BigInt => {
      let mut out = ptr::null_mut();
      unsafe { sys::napi_coerce_to_bool(env(), v.0, &mut out) };
      get_bool(Local(out))
    }
  }
}

/// `a === b`
pub fn strict_equals(a: Local, b: Local) -> bool {
  let mut r = false;
  unsafe { sys::napi_strict_equals(env(), a.0, b.0, &mut r) };
  r
}

pub fn is_array(v: Local) -> bool {
  let mut r = false;
  unsafe { sys::napi_is_array(env(), v.0, &mut r) };
  r
}

pub fn str_equals(v: Local, s: &str) -> bool {
  type_of(v) == Type::String && get_string(v).as_deref() == Some(s)
}

/// `obj[key]` for objects/functions (napi fast path; [[Get]] incl. prototype chain, getters and
/// proxy traps). Callers handle primitives via the host's JS fallback.
#[track_caller]
pub fn get_property(obj: Local, key: Local) -> JsResult<Local> {
  let mut v = ptr::null_mut();
  check(unsafe { sys::napi_get_property(env(), obj.0, key.0, &mut v) })?;
  Ok(Local(v))
}

#[track_caller]
pub fn get_named(obj: Local, name: &str) -> JsResult<Local> {
  get_property(obj, key(name))
}

/// `key in obj` (objects only).
#[track_caller]
pub fn has_property(obj: Local, key: Local) -> JsResult<bool> {
  let mut r = false;
  check(unsafe { sys::napi_has_property(env(), obj.0, key.0, &mut r) })?;
  Ok(r)
}

#[track_caller]
pub fn set_property(obj: Local, key: Local, value: Local) -> JsResult<()> {
  check(unsafe { sys::napi_set_property(env(), obj.0, key.0, value.0) })
}

#[track_caller]
pub fn set_named(obj: Local, name: &str, value: Local) -> JsResult<()> {
  set_property(obj, key(name), value)
}

/// FNV-1a: engine key names are short literals; SipHash dominated key lookups.
#[derive(Default)]
pub struct FnvHasher(u64);

impl std::hash::Hasher for FnvHasher {
  fn finish(&self) -> u64 {
    self.0
  }

  fn write(&mut self, bytes: &[u8]) {
    let mut h = if self.0 == 0 { 0xcbf2_9ce4_8422_2325 } else { self.0 };
    for b in bytes {
      h ^= u64::from(*b);
      h = h.wrapping_mul(0x0100_0000_01b3);
    }
    self.0 = h;
  }
}

type FnvMap<K, V> = std::collections::HashMap<K, V, std::hash::BuildHasherDefault<FnvHasher>>;

thread_local! {
  static KEYS: std::cell::RefCell<FnvMap<String, Slot>> = std::cell::RefCell::new(FnvMap::default());
}

/// Internalized property-key string for `name` (engine-side names only). ASCII names are
/// created directly (one string-table lookup, cheaper than any cache over napi handles); others
/// are cached per thread.
pub fn key(name: &str) -> Local {
  if name.is_ascii() {
    let mut v = ptr::null_mut();
    unsafe {
      sys::node_api_create_property_key_latin1(env(), name.as_ptr().cast(), name.len() as isize, &mut v)
    };
    return Local(v);
  }
  if let Some(v) = KEYS.with(|k| k.borrow().get(name).map(|s| s.get())) {
    return v;
  }
  let mut v = ptr::null_mut();
  unsafe {
    sys::node_api_create_property_key_utf8(env(), name.as_ptr().cast(), name.len() as isize, &mut v)
  };
  if let Ok(slot) = Slot::new(Local(v)) {
    KEYS.with(|k| k.borrow_mut().insert(name.to_string(), slot));
  }
  Local(v)
}

/// `delete obj[key]` (objects only). Returns false when the property is non-configurable.
#[track_caller]
pub fn delete_property(obj: Local, key: Local) -> JsResult<bool> {
  let mut r = false;
  check(unsafe { sys::napi_delete_property(env(), obj.0, key.0, &mut r) })?;
  Ok(r)
}

#[track_caller]
pub fn get_element(arr: Local, index: u32) -> JsResult<Local> {
  let mut v = ptr::null_mut();
  check(unsafe { sys::napi_get_element(env(), arr.0, index, &mut v) })?;
  Ok(Local(v))
}

#[track_caller]
pub fn set_element(arr: Local, index: u32, value: Local) -> JsResult<()> {
  check(unsafe { sys::napi_set_element(env(), arr.0, index, value.0) })
}

pub fn array_length(arr: Local) -> u32 {
  let mut n = 0;
  unsafe { sys::napi_get_array_length(env(), arr.0, &mut n) };
  n
}

/// `arr.push(value)` for engine-owned arrays (fieldPromises / populationPromises).
#[track_caller]
pub fn push(arr: Local, value: Local) -> JsResult<()> {
  let len = array_length(arr);
  set_element(arr, len, value)
}

/// `Object.keys(obj)` for objects: own, enumerable, string keys, in spec order.
#[track_caller]
pub fn own_keys(obj: Local) -> JsResult<Local> {
  let mut v = ptr::null_mut();
  check(unsafe {
    sys::napi_get_all_property_names(
      env(),
      obj.0,
      sys::KeyCollectionMode::own_only,
      sys::KeyFilter::enumerable | sys::KeyFilter::skip_symbols,
      sys::KeyConversion::numbers_to_strings,
      &mut v,
    )
  })?;
  Ok(Local(v))
}

#[track_caller]
pub fn call(func: Local, this: Local, args: &[Local]) -> JsResult<Local> {
  let mut out = ptr::null_mut();
  // `Local` is `repr(transparent)` over `napi_value`.
  let raw = args.as_ptr().cast::<sys::napi_value>();
  check(unsafe { sys::napi_call_function(env(), this.0, func.0, args.len(), raw, &mut out) })?;
  Ok(Local(out))
}

/// Creates a promise and its deferred.
#[track_caller]
pub fn create_promise() -> JsResult<(sys::napi_deferred, Local)> {
  let mut d = ptr::null_mut();
  let mut p = ptr::null_mut();
  check(unsafe { sys::napi_create_promise(env(), &mut d, &mut p) })?;
  Ok((d, Local(p)))
}

pub fn resolve_deferred(d: sys::napi_deferred, value: Local) {
  unsafe { sys::napi_resolve_deferred(env(), d, value.0) };
}

pub fn reject_deferred(d: sys::napi_deferred, value: Local) {
  unsafe { sys::napi_reject_deferred(env(), d, value.0) };
}

pub fn throw(value: Local) {
  unsafe { sys::napi_throw(env(), value.0) };
}

pub fn create_function(
  name: &str,
  cb: unsafe extern "C" fn(sys::napi_env, sys::napi_callback_info) -> sys::napi_value,
  data: *mut c_void,
) -> Local {
  let mut f = ptr::null_mut();
  unsafe {
    sys::napi_create_function(env(), name.as_ptr().cast(), name.len() as isize, Some(cb), data, &mut f)
  };
  Local(f)
}

/// Reads up to `N` callback arguments (missing ones are `undefined`) and the data pointer.
pub fn callback_args<const N: usize>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> ([Local; N], *mut c_void) {
  let mut argc = N;
  let mut argv = [ptr::null_mut(); N];
  let mut data = ptr::null_mut();
  unsafe {
    sys::napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(), ptr::null_mut(), &mut data)
  };
  let undef = undefined();
  let mut out = [undef; N];
  for (i, slot) in out.iter_mut().enumerate().take(argc.min(N)) {
    *slot = Local(argv[i]);
  }
  (out, data)
}

pub struct HandleScope(sys::napi_escapable_handle_scope);

impl HandleScope {
  pub fn open() -> HandleScope {
    let mut s = ptr::null_mut();
    unsafe { sys::napi_open_escapable_handle_scope(env(), &mut s) };
    HandleScope(s)
  }

  pub fn escape(&self, v: Local) -> Local {
    let mut out = ptr::null_mut();
    unsafe { sys::napi_escape_handle(env(), self.0, v.0, &mut out) };
    Local(out)
  }
}

impl Drop for HandleScope {
  fn drop(&mut self) {
    unsafe { sys::napi_close_escapable_handle_scope(env(), self.0) };
  }
}

/// Creates a JS array of strings.
pub fn string_array<'a>(items: impl Iterator<Item = &'a str>) -> JsResult<Local> {
  let arr = array();
  for (i, s) in items.enumerate() {
    set_element(arr, i as u32, string(s))?;
  }
  Ok(arr)
}
