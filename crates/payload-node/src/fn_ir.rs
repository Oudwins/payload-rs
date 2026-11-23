//! napi binding of the function compiler (crates/payload-fn-ir), driven by
//! `packages/engine-rs/src/compile/`:
//!
//! ```ts
//! fnIrInit({ opaqueObject, opaqueFunction, opaquePrimitive, FnRef, Partial, createNullProto }): void
//! fnIrAnalyze(source): { free, isAsync, params, argKeys } | { reject: string }
//! fnIrReserve(): number
//! fnIrCompile(id, source, resolutions, label): string | null   // reject reason, or null
//! fnIrEvaluate(id, args: unknown[]): External | string           // result, or the bail reason
//! fnIrCompare(result: External, jsResult: unknown): 0 | 1 | 2    // match, mismatch, unverifiable
//! fnIrResultToJs(result: External): unknown                      // undefined if not representable
//! fnIrShouldVerify(id) / fnIrRecord(id, outcome) / fnIrStats(id) / fnIrSetPolicy(first, every)
//! fnIrIsActive(id) / fnIrDescribe(id)
//! ```
//!
//! Values cross as snapshots made by the JS side (`compile/snapshot.ts`): plain objects, arrays
//! and primitives only, with the `opaque*` sentinels standing for anything else, `FnRef`
//! instances for compiled functions and `Partial` wrappers for partial objects (`req`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::ptr;
use std::sync::Arc;

use napi::bindgen_prelude::{Either, External, Object, Unknown};
use napi::{Env, JsValue, Result, sys};
use napi_derive::napi;
use payload_fn_ir::compile::{self, PathTrie, Resolution};
use payload_fn_ir::ir::Builtin;
use payload_fn_ir::value::{Callable, Object as VObject, OpaqueKind, Value};
use payload_fn_ir::{guard, registry};

struct Deps {
  opaque_object: sys::napi_ref,
  opaque_function: sys::napi_ref,
  opaque_primitive: sys::napi_ref,
  fn_ref: sys::napi_ref,
  partial: sys::napi_ref,
  create_null_proto: sys::napi_ref,
}

thread_local! {
  static DEPS: RefCell<Option<Deps>> = const { RefCell::new(None) };
}

fn err(msg: impl Into<String>) -> napi::Error {
  napi::Error::from_reason(msg.into())
}

fn ok(status: sys::napi_status) -> Result<()> {
  if status == sys::Status::napi_ok { Ok(()) } else { Err(err(format!("napi call failed ({status})"))) }
}

unsafe fn named(env: sys::napi_env, o: sys::napi_value, key: &str) -> Result<sys::napi_value> {
  let mut out = ptr::null_mut();
  let key = std::ffi::CString::new(key).map_err(|_| err("key"))?;
  ok(unsafe { sys::napi_get_named_property(env, o, key.as_ptr(), &mut out) })?;
  Ok(out)
}

unsafe fn make_ref(env: sys::napi_env, v: sys::napi_value) -> Result<sys::napi_ref> {
  let mut r = ptr::null_mut();
  ok(unsafe { sys::napi_create_reference(env, v, 1, &mut r) })?;
  Ok(r)
}

unsafe fn deref(env: sys::napi_env, r: sys::napi_ref) -> Result<sys::napi_value> {
  let mut v = ptr::null_mut();
  ok(unsafe { sys::napi_get_reference_value(env, r, &mut v) })?;
  Ok(v)
}

#[napi]
pub fn fn_ir_init(env: Env, deps: Object) -> Result<()> {
  let e = env.raw();
  let d = deps.raw();
  unsafe {
    let deps = Deps {
      opaque_object: make_ref(e, named(e, d, "opaqueObject")?)?,
      opaque_function: make_ref(e, named(e, d, "opaqueFunction")?)?,
      opaque_primitive: make_ref(e, named(e, d, "opaquePrimitive")?)?,
      fn_ref: make_ref(e, named(e, d, "FnRef")?)?,
      partial: make_ref(e, named(e, d, "Partial")?)?,
      create_null_proto: make_ref(e, named(e, d, "createNullProto")?)?,
    };
    DEPS.with(|cell| *cell.borrow_mut() = Some(deps));
  }
  Ok(())
}

fn trie_json(t: &PathTrie) -> serde_json::Value {
  let mut members = serde_json::Map::new();
  for (k, v) in &t.members {
    members.insert(k.clone(), trie_json(v));
  }
  serde_json::json!({ "value": t.used_as_value, "members": members })
}

#[napi]
pub fn fn_ir_analyze(source: String) -> serde_json::Value {
  match compile::analyze(&source) {
    Ok(a) => {
      let mut free = serde_json::Map::new();
      for (k, v) in &a.free {
        free.insert(k.clone(), trie_json(v));
      }
      serde_json::json!({ "free": free, "isAsync": a.is_async, "params": a.params, "argKeys": a.arg_keys })
    }
    Err(r) => serde_json::json!({ "reject": r.0 }),
  }
}

#[napi]
pub fn fn_ir_reserve() -> u32 {
  registry::reserve()
}

#[napi]
pub fn fn_ir_compile(env: Env, id: u32, source: String, resolutions: Unknown, label: String) -> Result<Option<String>> {
  let e = env.raw();
  let resolutions = unsafe { decode_resolutions(e, resolutions.raw())? };
  let analysis = match compile::analyze(&source) {
    Ok(a) => a,
    Err(r) => return Ok(Some(r.0)),
  };
  match compile::compile(&source, &resolutions) {
    Ok(def) => {
      registry::install(
        id,
        def,
        registry::FnMeta { is_async: analysis.is_async, arg_keys: analysis.arg_keys, label },
      );
      Ok(None)
    }
    Err(r) => Ok(Some(r.0)),
  }
}

unsafe fn decode_resolutions(e: sys::napi_env, o: sys::napi_value) -> Result<HashMap<String, Resolution>> {
  let mut out = HashMap::new();
  for (k, v) in unsafe { own_entries(e, o)? } {
    out.insert(k, unsafe { decode_resolution(e, v)? });
  }
  Ok(out)
}

unsafe fn decode_resolution(e: sys::napi_env, o: sys::napi_value) -> Result<Resolution> {
  let kind = unsafe { string_of(e, named(e, o, "kind")?)? }.ok_or_else(|| err("resolution kind"))?;
  Ok(match kind.as_str() {
    "value" => Resolution::Value(unsafe { to_value(e, named(e, o, "value")?, 0)? }),
    "function" => {
      let mut id = 0f64;
      ok(unsafe { sys::napi_get_value_double(e, named(e, o, "id")?, &mut id) })?;
      Resolution::Function(id as u32)
    }
    "builtin" => {
      let path = unsafe { string_of(e, named(e, o, "path")?)? }.ok_or_else(|| err("builtin path"))?;
      match Builtin::from_path(&path) {
        Some(b) => Resolution::Builtin(b),
        None => Resolution::Unresolved(format!("intrinsic {path} is not supported")),
      }
    }
    "namespace" => Resolution::Namespace(unsafe { decode_resolutions(e, named(e, o, "members")?)? }),
    _ => Resolution::Unresolved(unsafe { string_of(e, named(e, o, "reason")?)? }.unwrap_or_default()),
  })
}

unsafe fn type_of(e: sys::napi_env, v: sys::napi_value) -> Result<sys::napi_valuetype> {
  let mut t = 0;
  ok(unsafe { sys::napi_typeof(e, v, &mut t) })?;
  Ok(t)
}

unsafe fn string_of(e: sys::napi_env, v: sys::napi_value) -> Result<Option<String>> {
  if unsafe { type_of(e, v)? } != sys::ValueType::napi_string {
    return Ok(None);
  }
  let mut len = 0usize;
  ok(unsafe { sys::napi_get_value_string_utf8(e, v, ptr::null_mut(), 0, &mut len) })?;
  let mut buf = vec![0u8; len + 1];
  let mut written = 0usize;
  ok(unsafe { sys::napi_get_value_string_utf8(e, v, buf.as_mut_ptr().cast(), len + 1, &mut written) })?;
  buf.truncate(written);
  String::from_utf8(buf).map(Some).map_err(|_| err("utf8"))
}

unsafe fn own_entries(e: sys::napi_env, o: sys::napi_value) -> Result<Vec<(String, sys::napi_value)>> {
  let mut keys = ptr::null_mut();
  ok(unsafe {
    sys::napi_get_all_property_names(
      e,
      o,
      sys::KeyCollectionMode::own_only,
      sys::KeyFilter::enumerable | sys::KeyFilter::skip_symbols,
      sys::KeyConversion::numbers_to_strings,
      &mut keys,
    )
  })?;
  let mut len = 0u32;
  ok(unsafe { sys::napi_get_array_length(e, keys, &mut len) })?;
  let mut out = Vec::with_capacity(len as usize);
  for i in 0..len {
    let mut k = ptr::null_mut();
    ok(unsafe { sys::napi_get_element(e, keys, i, &mut k) })?;
    let mut v = ptr::null_mut();
    ok(unsafe { sys::napi_get_property(e, o, k, &mut v) })?;
    out.push((unsafe { string_of(e, k)? }.ok_or_else(|| err("key"))?, v));
  }
  Ok(out)
}

unsafe fn strict_eq(e: sys::napi_env, a: sys::napi_value, b: sys::napi_value) -> Result<bool> {
  let mut r = false;
  ok(unsafe { sys::napi_strict_equals(e, a, b, &mut r) })?;
  Ok(r)
}

unsafe fn instance_of(e: sys::napi_env, v: sys::napi_value, ctor: sys::napi_value) -> Result<bool> {
  let mut r = false;
  ok(unsafe { sys::napi_instanceof(e, v, ctor, &mut r) })?;
  Ok(r)
}

fn with_deps<T>(f: impl FnOnce(&Deps) -> Result<T>) -> Result<T> {
  DEPS.with(|cell| match &*cell.borrow() {
    Some(d) => f(d),
    None => Err(err("fnIrInit was not called")),
  })
}

/// Converts a JS-side snapshot to a [`Value`].
unsafe fn to_value(e: sys::napi_env, v: sys::napi_value, depth: u32) -> Result<Value> {
  if depth > 200 {
    return Ok(Value::Opaque(OpaqueKind::Object));
  }
  let t = unsafe { type_of(e, v)? };
  Ok(match t {
    sys::ValueType::napi_undefined => Value::Undefined,
    sys::ValueType::napi_null => Value::Null,
    sys::ValueType::napi_boolean => {
      let mut b = false;
      ok(unsafe { sys::napi_get_value_bool(e, v, &mut b) })?;
      Value::Bool(b)
    }
    sys::ValueType::napi_number => {
      let mut n = 0f64;
      ok(unsafe { sys::napi_get_value_double(e, v, &mut n) })?;
      Value::Number(n)
    }
    sys::ValueType::napi_string => Value::String(Arc::from(unsafe { string_of(e, v)? }.unwrap_or_default().as_str())),
    sys::ValueType::napi_object => {
      let (oo, of, op, fr, pa) = with_deps(|d| unsafe {
        Ok((
          deref(e, d.opaque_object)?,
          deref(e, d.opaque_function)?,
          deref(e, d.opaque_primitive)?,
          deref(e, d.fn_ref)?,
          deref(e, d.partial)?,
        ))
      })?;
      if unsafe { strict_eq(e, v, oo)? } {
        return Ok(Value::Opaque(OpaqueKind::Object));
      }
      if unsafe { strict_eq(e, v, of)? } {
        return Ok(Value::Opaque(OpaqueKind::Function));
      }
      if unsafe { strict_eq(e, v, op)? } {
        return Ok(Value::Opaque(OpaqueKind::Primitive));
      }
      if unsafe { instance_of(e, v, fr)? } {
        let mut id = 0f64;
        ok(unsafe { sys::napi_get_value_double(e, named(e, v, "id")?, &mut id) })?;
        return Ok(Value::Func(Callable::Fn(id as u32)));
      }
      let (target, closed) =
        if unsafe { instance_of(e, v, pa)? } { (unsafe { named(e, v, "value")? }, false) } else { (v, true) };
      let mut is_array = false;
      ok(unsafe { sys::napi_is_array(e, target, &mut is_array) })?;
      if is_array {
        let mut len = 0u32;
        ok(unsafe { sys::napi_get_array_length(e, target, &mut len) })?;
        let mut items = Vec::with_capacity(len as usize);
        for i in 0..len {
          let mut el = ptr::null_mut();
          ok(unsafe { sys::napi_get_element(e, target, i, &mut el) })?;
          items.push(unsafe { to_value(e, el, depth + 1)? });
        }
        return Ok(Value::Array(Arc::new(items)));
      }
      let mut proto = ptr::null_mut();
      ok(unsafe { sys::napi_get_prototype(e, target, &mut proto) })?;
      let null_proto = unsafe { type_of(e, proto)? } == sys::ValueType::napi_null;
      let mut o = VObject { closed, null_proto, ..VObject::default() };
      for (k, val) in unsafe { own_entries(e, target)? } {
        o.set(Arc::from(k.as_str()), unsafe { to_value(e, val, depth + 1)? });
      }
      Value::Object(Arc::new(o))
    }
    sys::ValueType::napi_function => Value::Opaque(OpaqueKind::Function),
    _ => Value::Opaque(OpaqueKind::Primitive),
  })
}

/// Converts a result to JS; `None` when it holds something without a JS equivalent here.
unsafe fn from_value(e: sys::napi_env, v: &Value) -> Result<Option<sys::napi_value>> {
  let mut out = ptr::null_mut();
  match v {
    Value::Undefined => ok(unsafe { sys::napi_get_undefined(e, &mut out) })?,
    Value::Null => ok(unsafe { sys::napi_get_null(e, &mut out) })?,
    Value::Bool(b) => ok(unsafe { sys::napi_get_boolean(e, *b, &mut out) })?,
    Value::Number(n) => ok(unsafe { sys::napi_create_double(e, *n, &mut out) })?,
    Value::String(s) => ok(unsafe { sys::napi_create_string_utf8(e, s.as_ptr().cast(), s.len() as isize, &mut out) })?,
    Value::Array(items) => {
      ok(unsafe { sys::napi_create_array_with_length(e, items.len(), &mut out) })?;
      for (i, item) in items.iter().enumerate() {
        let Some(x) = (unsafe { from_value(e, item)? }) else { return Ok(None) };
        ok(unsafe { sys::napi_set_element(e, out, i as u32, x) })?;
      }
    }
    Value::Object(o) => {
      if !o.closed {
        return Ok(None);
      }
      if o.null_proto {
        let f = with_deps(|d| unsafe { deref(e, d.create_null_proto) })?;
        let mut undefined = ptr::null_mut();
        ok(unsafe { sys::napi_get_undefined(e, &mut undefined) })?;
        ok(unsafe { sys::napi_call_function(e, undefined, f, 0, ptr::null(), &mut out) })?;
      } else {
        ok(unsafe { sys::napi_create_object(e, &mut out) })?;
      }
      for (k, val) in &o.props {
        let Some(x) = (unsafe { from_value(e, val)? }) else { return Ok(None) };
        let mut key = ptr::null_mut();
        ok(unsafe { sys::napi_create_string_utf8(e, k.as_ptr().cast(), k.len() as isize, &mut key) })?;
        ok(unsafe { sys::napi_set_property(e, out, key, x) })?;
      }
    }
    _ => return Ok(None),
  }
  Ok(Some(out))
}

#[napi]
pub fn fn_ir_evaluate(env: Env, id: u32, args: Unknown) -> Result<Either<External<Value>, String>> {
  let e = env.raw();
  let args = match unsafe { to_value(e, args.raw(), 0)? } {
    Value::Array(a) => a,
    _ => return Err(err("fnIrEvaluate: args must be an array")),
  };
  Ok(match payload_fn_ir::evaluate(id, &args) {
    Ok(v) => Either::A(External::new(v)),
    Err(b) => Either::B(b.reason().to_string()),
  })
}

/// 0: equal, 1: different, 2: not comparable (the compiled result holds opaque values).
#[napi]
pub fn fn_ir_compare(env: Env, result: &External<Value>, js_result: Unknown) -> Result<u32> {
  let theirs = unsafe { to_value(env.raw(), js_result.raw(), 0)? };
  let ours: &Value = result;
  if !comparable(ours) {
    return Ok(2);
  }
  Ok(if ours.same_structure(&theirs) { 0 } else { 1 })
}

fn comparable(v: &Value) -> bool {
  match v {
    Value::Array(items) => items.iter().all(comparable),
    Value::Object(o) => o.closed && o.props.values().all(comparable),
    Value::Opaque(_) | Value::Func(_) | Value::RegExp(_) | Value::Promise(_) => false,
    _ => true,
  }
}

#[napi]
pub fn fn_ir_result_to_js(env: Env, result: &External<Value>) -> Result<Unknown<'_>> {
  let e = env.raw();
  let v = match unsafe { from_value(e, result)? } {
    Some(v) => v,
    None => {
      let mut u = ptr::null_mut();
      ok(unsafe { sys::napi_get_undefined(e, &mut u) })?;
      u
    }
  };
  Ok(unsafe { Unknown::from_raw_unchecked(e, v) })
}

#[napi]
pub fn fn_ir_should_verify(id: u32) -> bool {
  guard::should_verify(id)
}

#[napi]
pub fn fn_ir_record(id: u32, outcome: u32) {
  guard::record(
    id,
    match outcome {
      0 => guard::Outcome::Match,
      1 => guard::Outcome::Mismatch,
      _ => guard::Outcome::Bail,
    },
  );
}

#[napi]
pub fn fn_ir_stats(id: u32) -> serde_json::Value {
  let s = guard::stats(id);
  serde_json::json!({
    "calls": s.calls,
    "verified": s.verified,
    "mismatches": s.mismatches,
    "bails": s.bails,
    "deoptimized": s.deoptimized,
  })
}

#[napi]
pub fn fn_ir_set_policy(first: f64, sample_every: f64) {
  let first = if first.is_finite() { first.max(0.0) as u64 } else { u64::MAX };
  guard::set_policy(guard::Policy { first, sample_every: sample_every.max(0.0) as u64 });
}

#[napi]
pub fn fn_ir_is_active(id: u32) -> bool {
  registry::is_active(id)
}

#[napi]
pub fn fn_ir_deoptimize(id: u32) {
  registry::deoptimize(id)
}

#[napi]
pub fn fn_ir_describe(id: u32) -> Option<String> {
  registry::describe(id)
}
