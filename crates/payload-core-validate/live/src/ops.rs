//! JS operations on live values with V8's semantics, over raw Node-API.
//!
//! Every Node-API call goes through the binding's own `env` ([`Cx`]), so the hot paths make no
//! thread-local lookups. Property keys come from the running call's frame (keys.rs) when the
//! shell passed them, else they are created on use.
//!
//! Property reads use `napi_get_property` ([[Get]]: getters, proxies, prototype chain,
//! `ToPropertyKey` of computed keys); reads on primitives and nullish receivers go through the
//! shell's `get` helper so V8 boxes / throws its own `TypeError`. Object and array literals are
//! built with `napi_define_properties` (CreateDataProperty, never a setter).
//!
//! Array methods the TS calls (`.some`, `.filter`, `.includes`, ...): the shell looks the method
//! up like the TS does and, when it is the realm's builtin, calls the builtin itself with
//! `element`, a JS arrow that runs the engine closure set around that call
//! ([`Cx::with_engine_callback`]): the builtin's own steps, no emulation. Anything else is called
//! from here with a fresh function. `.push` always calls the method found. `for...of` over a JS
//! array is a JS loop of the shell (one per TS loop, so V8 names the TS expression in its
//! errors) whose body is the engine closure; over an engine-created `[value]` literal the
//! shell's `literalIter` checks the default iterator (reads on `Array.prototype` /
//! `%ArrayIteratorPrototype%`) and the literal is only built for a replaced one.
//!
//! Values handed to an engine closure live in that callback's handle scope: anything kept after
//! it returns is a [`Held`] (the `Map` keys of `select`).

use std::cell::Cell;
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Type, Val, check};

use crate::keys::{K, KEY_COUNT, NAMES};

/// A strong reference to an object, function or symbol of the binding. Never deleted: the
/// binding lives as long as the module that created it.
pub struct Ref(sys::napi_ref);

/// The strings the shell passed to the running native (keys.rs).
pub struct Frame {
  pub keys: *const sys::napi_value,
  pub count: usize,
  pub map: &'static [u8; KEY_COUNT],
}

/// Intrinsics and helpers of one binding (shell.js `bootstrap({...})`).
pub struct Cx {
  env: sys::napi_env,
  frame: Cell<*const Frame>,
  next: Ref,
  shell_box: Ref,
  array_iterator_prototype: Ref,
  array_values: Ref,
  /// The Rust closure the shell's `callback` runs (set around the helper calls that pass it to
  /// a builtin).
  closure: Cell<Option<*const EngineCallback>>,
  some: Ref,
  for_each: Ref,
  filter: Ref,
  map: Ref,
  find: Ref,
  includes: Ref,
  index_of: Ref,
  h_call_array: Ref,
  h_call_array_with: Ref,
  h_call_literal: Ref,
  h_for_of_strings: Ref,
  h_for_of_numbers: Ref,
  h_for_of_block_slugs: Ref,
  h_for_of_value: Ref,
  h_literal_iter: Ref,
  h_literal_pairs: Ref,
  h_get: Ref,
  h_is_array: Ref,
  h_lt: Ref,
  h_gt: Ref,
  h_string: Ref,
  h_number: Ref,
  pub h_date_parse: Ref,
  pub h_email_test: Ref,
  pub h_object_id_is_valid: Ref,
  pub h_object_id_hex: Ref,
  pub h_find_collection: Ref,
  pub h_object_keys_length: Ref,
  h_error: Ref,
  h_type_error: Ref,
  pub h_duplicates_message: Ref,
  pub h_invalid_relationships_message: Ref,
  pub h_invalid_selections_message: Ref,
}

/// A Rust closure called by the shell's `callback` with the first argument (the element a
/// builtin array method passes).
type EngineCallback = dyn Fn(Local) -> JsResult<Local>;

/// The `for...of` loops of the TS over arrays (shell `forOf*`, one per loop so V8's
/// `<expr> is not iterable` names the TS expression).
#[derive(Clone, Copy)]
pub enum Loop {
  StringsToValidate,
  NumbersToValidate,
  AllBlockSlugs,
  Value,
}

const INDEX_KEYS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

impl Cx {
  pub fn new(env: sys::napi_env, host: Local) -> JsResult<Cx> {
    let f = |name: &str| -> JsResult<Ref> {
      let value = js::get_named(host, name)?;
      let mut r = ptr::null_mut();
      check(unsafe { sys::napi_create_reference(env, value.0, 1, &mut r) })?;
      Ok(Ref(r))
    };
    Ok(Cx {
      env,
      frame: Cell::new(ptr::null()),
      next: f("NEXT")?,
      shell_box: f("box")?,
      array_iterator_prototype: f("arrayIteratorPrototype")?,
      array_values: f("arrayValues")?,
      closure: Cell::new(None),
      some: f("some")?,
      for_each: f("forEach")?,
      filter: f("filter")?,
      map: f("map")?,
      find: f("find")?,
      includes: f("includes")?,
      index_of: f("indexOf")?,
      h_call_array: f("callArray")?,
      h_call_array_with: f("callArrayWith")?,
      h_call_literal: f("callLiteral")?,
      h_for_of_strings: f("forOfStringsToValidate")?,
      h_for_of_numbers: f("forOfNumbersToValidate")?,
      h_for_of_block_slugs: f("forOfAllBlockSlugs")?,
      h_for_of_value: f("forOfValue")?,
      h_literal_iter: f("literalIter")?,
      h_literal_pairs: f("literalPairs")?,
      h_get: f("get")?,
      h_is_array: f("isArray")?,
      h_lt: f("lt")?,
      h_gt: f("gt")?,
      h_string: f("String")?,
      h_number: f("Number")?,
      h_date_parse: f("dateParse")?,
      h_email_test: f("emailTest")?,
      h_object_id_is_valid: f("objectIdIsValid")?,
      h_object_id_hex: f("objectIdHex")?,
      h_find_collection: f("findCollection")?,
      h_object_keys_length: f("objectKeysLength")?,
      h_error: f("error")?,
      h_type_error: f("typeError")?,
      h_duplicates_message: f("duplicatesMessage")?,
      h_invalid_relationships_message: f("invalidRelationshipsMessage")?,
      h_invalid_selections_message: f("invalidSelectionsMessage")?,
    })
  }

  #[inline]
  fn r(&self, r: &Ref) -> Local {
    let mut v = ptr::null_mut();
    unsafe { sys::napi_get_reference_value(self.env, r.0, &mut v) };
    Local(v)
  }

  /// Makes `frame` the running call's strings; returns the previous one for [`Cx::leave`]
  /// (natives re-enter through user code).
  pub fn enter(&self, frame: *const Frame) -> *const Frame {
    self.frame.replace(frame)
  }

  pub fn leave(&self, previous: *const Frame) {
    self.frame.set(previous);
  }

  /// The string `k` (a property key or a literal value).
  #[inline]
  pub fn k(&self, k: K) -> Local {
    let frame = self.frame.get();
    if !frame.is_null() {
      // SAFETY: the frame lives on the stack of the running native, which restores the previous
      // frame before it returns.
      let frame = unsafe { &*frame };
      let i = usize::from(frame.map[k as usize]);
      if i < frame.count {
        return Local(unsafe { *frame.keys.add(i) });
      }
    }
    self.create_key(NAMES[k as usize])
  }

  fn create_key(&self, name: &str) -> Local {
    let mut v = ptr::null_mut();
    unsafe { sys::node_api_create_property_key_latin1(self.env, name.as_ptr().cast(), name.len() as isize, &mut v) };
    Local(v)
  }

  /// The `NEXT` marker: the shell continues the TS body.
  pub fn next(&self) -> Local {
    self.r(&self.next)
  }

  // -------------------------------------------------------------------------------------------
  // Primitives and classification

  pub fn undefined(&self) -> Local {
    let mut v = ptr::null_mut();
    unsafe { sys::napi_get_undefined(self.env, &mut v) };
    Local(v)
  }

  pub fn undefined_v(&self) -> V {
    V { v: self.undefined(), tag: UNDEFINED }
  }

  pub fn boolean(&self, b: bool) -> Local {
    let mut v = ptr::null_mut();
    unsafe { sys::napi_get_boolean(self.env, b, &mut v) };
    Local(v)
  }

  pub fn yes(&self) -> Local {
    self.boolean(true)
  }

  pub fn number(&self, n: f64) -> Local {
    let mut v = ptr::null_mut();
    unsafe { sys::napi_create_double(self.env, n, &mut v) };
    Local(v)
  }

  pub fn number_v(&self, n: f64) -> V {
    V { v: self.number(n), tag: if n == 0.0 || n.is_nan() { FALSY_NUMBER } else { NUMBER } }
  }

  /// A string made at run time (not one of keys.rs).
  pub fn string_utf16(&self, units: &[u16]) -> JsResult<Local> {
    let mut v = ptr::null_mut();
    check(unsafe { sys::napi_create_string_utf16(self.env, units.as_ptr(), units.len() as isize, &mut v) })?;
    Ok(Local(v))
  }

  /// A binding the shell did not tag, classified ([`V::unclassified`]).
  pub fn classify(&self, v: V) -> V {
    if v.tag == UNCLASSIFIED { self.of(v.v) } else { v }
  }

  /// `typeof` and truthiness of a value the engine got from JS.
  pub fn of(&self, v: Local) -> V {
    let mut t = 0;
    unsafe { sys::napi_typeof(self.env, v.0, &mut t) };
    let tag = match t {
      sys::ValueType::napi_undefined => UNDEFINED,
      sys::ValueType::napi_null => NULL,
      sys::ValueType::napi_boolean => {
        let mut b = false;
        unsafe { sys::napi_get_value_bool(self.env, v.0, &mut b) };
        if b { TRUE } else { FALSE }
      }
      sys::ValueType::napi_number => {
        let n = self.f64_value(v);
        if n == 0.0 || n.is_nan() { FALSY_NUMBER } else { NUMBER }
      }
      sys::ValueType::napi_string => {
        if self.utf16_len(v) == 0 {
          EMPTY_STRING
        } else {
          STRING
        }
      }
      sys::ValueType::napi_symbol => SYMBOL,
      sys::ValueType::napi_function => FUNCTION,
      9 => {
        let mut out = ptr::null_mut();
        let mut b = false;
        unsafe {
          sys::napi_coerce_to_bool(self.env, v.0, &mut out);
          sys::napi_get_value_bool(self.env, out, &mut b);
        }
        if b { BIGINT } else { FALSY_BIGINT }
      }
      _ => OBJECT,
    };
    V { v, tag }
  }

  fn f64_value(&self, v: Local) -> f64 {
    let mut n = 0.0;
    unsafe { sys::napi_get_value_double(self.env, v.0, &mut n) };
    n
  }

  /// A number result of a shell helper (`None` for anything else).
  fn number_result(&self, v: Local) -> Option<f64> {
    let mut n = 0.0;
    ((unsafe { sys::napi_get_value_double(self.env, v.0, &mut n) }) == sys::Status::napi_ok).then_some(n)
  }

  pub fn u32_value(&self, v: Local) -> u32 {
    let mut n = 0;
    unsafe { sys::napi_get_value_uint32(self.env, v.0, &mut n) };
    n
  }

  fn utf16_len(&self, v: Local) -> usize {
    let mut len = 0usize;
    unsafe { sys::napi_get_value_string_utf16(self.env, v.0, ptr::null_mut(), 0, &mut len) };
    len
  }

  /// Exact UTF-16 copy of a string value.
  pub fn utf16(&self, v: V) -> Vec<u16> {
    if !v.is_string() {
      return Vec::new();
    }
    let len = self.utf16_len(v.v);
    let mut buf = vec![0u16; len + 1];
    let mut out = 0usize;
    unsafe { sys::napi_get_value_string_utf16(self.env, v.v.0, buf.as_mut_ptr(), len + 1, &mut out) };
    buf.truncate(out);
    buf
  }

  /// The value of a number.
  pub fn num(&self, v: V) -> Option<f64> {
    v.is_number().then(|| self.f64_value(v.v))
  }

  /// UTF-16 length of a string.
  pub fn str_len(&self, v: V) -> Option<usize> {
    v.is_string().then(|| self.utf16_len(v.v))
  }

  pub fn strict_eq(&self, a: Local, b: Local) -> bool {
    let mut r = false;
    unsafe { sys::napi_strict_equals(self.env, a.0, b.0, &mut r) };
    r
  }

  /// `v === n`
  pub fn eq_num(&self, v: V, n: f64) -> bool {
    self.num(v) == Some(n)
  }

  /// `v === 'literal'`: the UTF-16 code units of `v` against those of `s`.
  pub fn eq_str(&self, v: V, s: &str) -> bool {
    if !v.is_string() {
      return false;
    }
    let expected = s.encode_utf16();
    let len = self.utf16_len(v.v);
    if len != expected.clone().count() {
      return false;
    }
    let mut stack = [0u16; 32];
    let mut heap = Vec::new();
    let buf: &mut [u16] = if len < stack.len() {
      &mut stack[..len + 1]
    } else {
      heap.resize(len + 1, 0);
      &mut heap
    };
    let mut out = 0usize;
    let status = unsafe { sys::napi_get_value_string_utf16(self.env, v.v.0, buf.as_mut_ptr(), len + 1, &mut out) };
    status == sys::Status::napi_ok && out == len && buf[..len].iter().copied().eq(expected)
  }

  fn raw_is_array(&self, v: Local) -> bool {
    let mut r = false;
    unsafe { sys::napi_is_array(self.env, v.0, &mut r) };
    r
  }

  /// A real array (`napi_is_array` is false for proxies).
  pub fn is_real_array(&self, v: V) -> bool {
    v.is_object_like() && self.raw_is_array(v.v)
  }

  /// `Array.isArray(v)`. A real array always is one and a non-proxy object never becomes one
  /// (the shell's `atag` tells those apart); anything else asks the realm, where the TS asks
  /// (a revoked proxy throws there).
  pub fn is_array(&self, v: V) -> JsResult<bool> {
    match v.tag {
      PLAIN_OBJECT => Ok(false),
      OBJECT | ARRAY_HINT | UNKNOWN_OBJECT | FUNCTION => {
        if self.raw_is_array(v.v) {
          return Ok(true);
        }
        Ok(self.of(self.helper(&self.h_is_array, &[v.v])?).truthy())
      }
      _ => Ok(false),
    }
  }

  pub fn array_length(&self, a: Local) -> u32 {
    let mut n = 0;
    unsafe { sys::napi_get_array_length(self.env, a.0, &mut n) };
    n
  }

  fn get_element(&self, o: Local, index: u32) -> JsResult<Local> {
    let mut v = ptr::null_mut();
    check(unsafe { sys::napi_get_element(self.env, o.0, index, &mut v) })?;
    Ok(Local(v))
  }

  // -------------------------------------------------------------------------------------------
  // Property access

  fn raw_get(&self, o: Local, key: Local) -> JsResult<Local> {
    let mut v = ptr::null_mut();
    check(unsafe { sys::napi_get_property(self.env, o.0, key.0, &mut v) })?;
    Ok(Local(v))
  }

  /// `o.k`
  pub fn get(&self, o: V, k: K) -> JsResult<Local> {
    self.get_key(o, self.k(k))
  }

  /// `o.k`, classified.
  pub fn get_v(&self, o: V, k: K) -> JsResult<V> {
    Ok(self.of(self.get(o, k)?))
  }

  /// `o[key]` (`ToPropertyKey(key)` by V8).
  pub fn get_key(&self, o: V, key: Local) -> JsResult<Local> {
    if o.is_object_like() { self.raw_get(o.v, key) } else { self.helper(&self.h_get, &[o.v, key]) }
  }

  /// `o?.k`
  pub fn get_opt(&self, o: V, k: K) -> JsResult<V> {
    if o.is_nullish() { Ok(self.undefined_v()) } else { self.get_v(o, k) }
  }

  /// `o?.[key]`
  pub fn get_opt_key(&self, o: V, key: Local) -> JsResult<V> {
    if o.is_nullish() { Ok(self.undefined_v()) } else { Ok(self.of(self.get_key(o, key)?)) }
  }

  /// `o[index]`
  pub fn get_index(&self, o: V, index: u32) -> JsResult<V> {
    let v = if o.is_object_like() {
      self.get_element(o.v, index)?
    } else {
      self.helper(&self.h_get, &[o.v, self.number(f64::from(index))])?
    };
    Ok(self.of(v))
  }

  /// `o.length` (a primitive string's and a real array's own `length` are read without a call).
  pub fn length(&self, o: V) -> JsResult<V> {
    if let Some(n) = self.str_len(o) {
      return Ok(self.number_v(n as f64));
    }
    if self.is_real_array(o) {
      return Ok(self.number_v(f64::from(self.array_length(o.v))));
    }
    self.get_v(o, K::Length)
  }

  /// `o.length === 0` (a string's emptiness is in its tag).
  pub fn length_is_zero(&self, o: V) -> JsResult<bool> {
    match o.tag {
      EMPTY_STRING => Ok(true),
      STRING => Ok(false),
      _ if self.is_real_array(o) => Ok(self.array_length(o.v) == 0),
      _ => Ok(self.eq_num(self.get_v(o, K::Length)?, 0.0)),
    }
  }

  /// `o?.length`
  pub fn length_opt(&self, o: V) -> JsResult<V> {
    if o.is_nullish() { Ok(self.undefined_v()) } else { self.length(o) }
  }

  fn box_get(&self, k: K) -> JsResult<Local> {
    self.raw_get(self.r(&self.shell_box), self.k(k))
  }

  // -------------------------------------------------------------------------------------------
  // Operators and builtins

  /// `a < b`
  pub fn lt(&self, a: V, b: V) -> JsResult<bool> {
    match self.primitive_less(a, b) {
      Some(r) => Ok(r),
      None => Ok(self.of(self.helper(&self.h_lt, &[a.v, b.v])?).truthy()),
    }
  }

  /// `a > b`
  pub fn gt(&self, a: V, b: V) -> JsResult<bool> {
    match self.primitive_less(b, a) {
      Some(r) => Ok(r),
      None => Ok(self.of(self.helper(&self.h_gt, &[a.v, b.v])?).truthy()),
    }
  }

  /// `IsLessThan(x, y)` for primitives other than symbols and bigints (`None`: the operator
  /// needs `ToPrimitive` / BigInt semantics, done by the shell).
  fn primitive_less(&self, x: V, y: V) -> Option<bool> {
    if let (Some(a), Some(b)) = (self.num(x), self.num(y)) {
      return Some(a < b);
    }
    if x.is_string() && y.is_string() {
      return Some(self.utf16(x) < self.utf16(y));
    }
    Some(self.primitive_to_number(x)? < self.primitive_to_number(y)?)
  }

  /// `ToNumber` of a primitive that is not a symbol or bigint (no user code can run).
  fn primitive_to_number(&self, v: V) -> Option<f64> {
    match v.tag {
      UNDEFINED => Some(f64::NAN),
      NULL | FALSE => Some(0.0),
      TRUE => Some(1.0),
      FALSY_NUMBER | NUMBER => Some(self.f64_value(v.v)),
      EMPTY_STRING | STRING => {
        let mut out = ptr::null_mut();
        let status = unsafe { sys::napi_coerce_to_number(self.env, v.v.0, &mut out) };
        (status == sys::Status::napi_ok).then(|| self.f64_value(Local(out)))
      }
      _ => None,
    }
  }

  /// `String(v)` (symbols allowed).
  pub fn string(&self, v: V) -> JsResult<V> {
    match v.ty() {
      Type::String => Ok(v),
      Type::Symbol => Ok(self.of(self.helper(&self.h_string, &[v.v])?)),
      _ => self.to_string(v),
    }
  }

  /// `ToString(v)` (template literal / string concatenation; throws for symbols).
  pub fn to_string(&self, v: V) -> JsResult<V> {
    if v.is_string() {
      return Ok(v);
    }
    let mut out = ptr::null_mut();
    check(unsafe { sys::napi_coerce_to_string(self.env, v.v.0, &mut out) })?;
    Ok(self.of(Local(out)))
  }

  /// `` `${a}${b}` `` for an engine string `b`.
  pub fn concat(&self, a: V, b: &str) -> JsResult<Local> {
    let mut units = self.utf16(self.to_string(a)?);
    units.extend(b.encode_utf16());
    self.string_utf16(&units)
  }

  /// `Number(v)`
  pub fn to_number(&self, v: V) -> JsResult<f64> {
    if let Some(n) = self.num(v) {
      return Ok(n);
    }
    match v.ty() {
      Type::String | Type::Boolean | Type::Undefined | Type::Null | Type::Symbol => {
        let mut out = ptr::null_mut();
        check(unsafe { sys::napi_coerce_to_number(self.env, v.v.0, &mut out) })?;
        Ok(self.f64_value(Local(out)))
      }
      _ => Ok(self.f64_value(self.helper(&self.h_number, &[v.v])?)),
    }
  }

  /// `parseFloat(v)`
  pub fn parse_float(&self, v: V) -> JsResult<f64> {
    if let Some(n) = self.num(v) {
      // `ToString` of a number parses back to the same number, except `-0` ("0").
      return Ok(if n == 0.0 { 0.0 } else { n });
    }
    let s = self.to_string(v)?;
    Ok(parse_float_utf16(&self.utf16(s)))
  }

  /// `parseFloat(String(v))`
  pub fn parse_float_of_string(&self, v: V) -> JsResult<f64> {
    match v.ty() {
      Type::Number => self.parse_float(v),
      Type::Symbol => Ok(f64::NAN),
      _ => self.parse_float(self.string(v)?),
    }
  }

  /// `isNumber(value)` (`payload/src/utilities/isNumber.ts`)
  pub fn is_number(&self, value: V) -> JsResult<bool> {
    match value.ty() {
      Type::Undefined | Type::Null => return Ok(false),
      Type::Number => return Ok(!self.f64_value(value.v).is_nan()),
      Type::String => {
        if self.utf16(value).iter().all(|u| is_js_whitespace(*u)) {
          return Ok(false);
        }
      }
      _ => {}
    }
    Ok(!self.to_number(value)?.is_nan())
  }

  // -------------------------------------------------------------------------------------------
  // Calls, literals, errors

  /// Calls a shell helper (an arrow function: `this` is not used).
  pub fn helper(&self, helper: &Ref, args: &[Local]) -> JsResult<Local> {
    let func = self.r(helper);
    self.raw_call(func, func, args)
  }

  fn raw_call(&self, func: Local, this: Local, args: &[Local]) -> JsResult<Local> {
    let mut out = ptr::null_mut();
    let raw = args.as_ptr().cast::<sys::napi_value>();
    check(unsafe { sys::napi_call_function(self.env, this.0, func.0, args.len(), raw, &mut out) })?;
    Ok(Local(out))
  }

  /// Calls `func` with `this`; V8's `TypeError` (`<expr> is not a function`, `expr` being the
  /// concatenated source text of the callee) when it is not callable.
  pub fn call(&self, func: V, this: Local, args: &[Local], expr: &[&str]) -> JsResult<Local> {
    if !func.is_function() {
      return Err(self.type_error(&format!("{} is not a function", expr.concat())));
    }
    self.raw_call(func.v, this, args)
  }

  /// `receiver.method(...args)`: `expr` is the receiver's source text.
  pub fn call_method(&self, receiver: V, method: K, args: &[Local], expr: &str) -> JsResult<Local> {
    let func = self.get_v(receiver, method)?;
    self.call(func, receiver.v, args, &[expr, ".", NAMES[method as usize]])
  }

  /// `t(key)` / `t(key, vars)` with the destructured `t`.
  pub fn t(&self, t: V, key: K, vars: Option<Local>) -> JsResult<Local> {
    match vars {
      Some(vars) => self.call(t, self.undefined(), &[self.k(key), vars], &["t"]),
      None => self.call(t, self.undefined(), &[self.k(key)], &["t"]),
    }
  }

  /// An object literal (own data properties in source order).
  pub fn object(&self, entries: &[(K, Local)]) -> JsResult<Local> {
    let mut o = ptr::null_mut();
    unsafe { sys::napi_create_object(self.env, &mut o) };
    let mut descs = [data_property(ptr::null_mut(), ptr::null_mut()); 8];
    let mut heap = Vec::new();
    let descs: &mut [sys::napi_property_descriptor] = if entries.len() <= descs.len() {
      &mut descs[..entries.len()]
    } else {
      heap.resize(entries.len(), data_property(ptr::null_mut(), ptr::null_mut()));
      &mut heap
    };
    for (desc, (name, value)) in descs.iter_mut().zip(entries) {
      *desc = data_property(self.k(*name).0, value.0);
    }
    check(unsafe { sys::napi_define_properties(self.env, o, descs.len(), descs.as_ptr()) })?;
    Ok(Local(o))
  }

  /// An array literal.
  pub fn array_of(&self, items: &[Local]) -> JsResult<Local> {
    let mut a = ptr::null_mut();
    check(unsafe { sys::napi_create_array(self.env, &mut a) })?;
    for (i, item) in items.iter().enumerate() {
      self.define_index(Local(a), i as u32, *item)?;
    }
    Ok(Local(a))
  }

  /// `CreateDataPropertyOrThrow(o, ToString(index), value)`
  fn define_index(&self, o: Local, index: u32, value: Local) -> JsResult<()> {
    let name = match INDEX_KEYS.get(index as usize) {
      Some(name) => self.create_key(name),
      None => self.create_key(&index.to_string()),
    };
    let desc = data_property(name.0, value.0);
    check(unsafe { sys::napi_define_properties(self.env, o.0, 1, &desc) })
  }

  pub fn type_error(&self, message: &str) -> Thrown {
    self.error_with(&self.h_type_error, message)
  }

  /// `new Error(message)`
  pub fn error(&self, message: &str) -> Thrown {
    self.error_with(&self.h_error, message)
  }

  fn error_with(&self, ctor: &Ref, message: &str) -> Thrown {
    let units: Vec<u16> = message.encode_utf16().collect();
    match self.string_utf16(&units).and_then(|m| self.helper(ctor, &[m])).and_then(Val::from_local) {
      Ok(v) => Thrown(v),
      Err(e) => e,
    }
  }

  // -------------------------------------------------------------------------------------------
  // Array methods

  /// Runs `body` while the shell's `callback` calls `f` (re-entrant: the previous closure is
  /// restored, also on unwind).
  pub fn with_engine_callback<'f, R>(
    &self,
    f: &'f (dyn Fn(Local) -> JsResult<Local> + 'f),
    body: impl FnOnce() -> JsResult<R>,
  ) -> JsResult<R> {
    struct Restore<'a>(&'a Cell<Option<*const EngineCallback>>, Option<*const EngineCallback>);
    impl Drop for Restore<'_> {
      fn drop(&mut self) {
        self.0.set(self.1);
      }
    }
    // SAFETY: lifetime erasure; the pointer is only called through `closure`, which `Restore`
    // resets before `f` goes out of scope.
    let f: *const EngineCallback =
      unsafe { std::mem::transmute::<&'f (dyn Fn(Local) -> JsResult<Local> + 'f), &'static EngineCallback>(f) };
    let _restore = Restore(&self.closure, self.closure.replace(Some(f)));
    body()
  }

  /// The closure the shell's `callback` runs now.
  pub fn engine_closure(&self) -> Option<*const EngineCallback> {
    self.closure.get()
  }

  /// `receiver.name(f)`: shell `callArray` looks the method up (as the TS does) and calls it
  /// when it is the builtin, with the shell's `callback`; anything else is called here with a
  /// fresh function (V8's `<expr>.<name> is not a function` when it is not callable).
  fn call_array(
    &self,
    receiver: V,
    name: K,
    builtin: &Ref,
    expr: &str,
    f: &dyn Fn(Local) -> JsResult<Local>,
  ) -> JsResult<Local> {
    let next = self.next();
    let args = [receiver.v, self.k(name), self.r(builtin)];
    let result = self.with_engine_callback(f, || self.helper(&self.h_call_array, &args))?;
    if !self.strict_eq(result, next) {
      return Ok(result);
    }
    let func = self.of(self.box_get(K::BoxM)?);
    let callback = |args: &[Local]| f(args[0]);
    with_callback(&callback, |cb| self.call(func, receiver.v, &[cb], &[expr, ".", NAMES[name as usize]]))
  }

  /// `receiver.name(value)` for `includes` / `indexOf` (shell `callArrayWith`).
  fn call_array_with(&self, receiver: V, name: K, builtin: &Ref, value: V, expr: &str) -> JsResult<V> {
    let next = self.next();
    let result = self.helper(&self.h_call_array_with, &[receiver.v, self.k(name), self.r(builtin), value.v])?;
    if !self.strict_eq(result, next) {
      return Ok(self.of(result));
    }
    let func = self.of(self.box_get(K::BoxM)?);
    Ok(self.of(self.call(func, receiver.v, &[value.v], &[expr, ".", NAMES[name as usize]])?))
  }

  /// `receiver.some(f)`
  pub fn some(&self, receiver: V, expr: &str, f: &dyn Fn(V) -> JsResult<bool>) -> JsResult<V> {
    let callback = |item: Local| Ok(self.boolean(f(self.of(item))?));
    Ok(self.of(self.call_array(receiver, K::SomeKey, &self.some, expr, &callback)?))
  }

  /// `receiver.forEach(f)`
  pub fn for_each(&self, receiver: V, expr: &str, f: &dyn Fn(V) -> JsResult<()>) -> JsResult<()> {
    let callback = |item: Local| {
      f(self.of(item))?;
      Ok(self.undefined())
    };
    self.call_array(receiver, K::ForEach, &self.for_each, expr, &callback).map(|_| ())
  }

  /// `receiver.filter(f)`
  pub fn filter(&self, receiver: V, expr: &str, f: &dyn Fn(V) -> JsResult<bool>) -> JsResult<V> {
    let callback = |item: Local| Ok(self.boolean(f(self.of(item))?));
    Ok(self.of(self.call_array(receiver, K::Filter, &self.filter, expr, &callback)?))
  }

  /// `[item].filter(f)` over an engine literal: shell `callLiteral` makes the literal and looks
  /// the method up on it; anything but the builtin is called here with a fresh function.
  pub fn filter_literal(&self, item: V, expr: &str, f: &dyn Fn(V) -> JsResult<bool>) -> JsResult<V> {
    let next = self.next();
    let callback = |item: Local| Ok(self.boolean(f(self.of(item))?));
    let args = [item.v, self.k(K::Filter), self.r(&self.filter)];
    let result = self.with_engine_callback(&callback, || self.helper(&self.h_call_literal, &args))?;
    if !self.strict_eq(result, next) {
      return Ok(self.of(result));
    }
    let literal = self.box_get(K::BoxA)?;
    let func = self.of(self.box_get(K::BoxM)?);
    let callback = |args: &[Local]| callback(args[0]);
    Ok(self.of(with_callback(&callback, |cb| self.call(func, literal, &[cb], &[expr, ".filter"]))?))
  }

  /// `receiver.map(f)`
  pub fn map(&self, receiver: V, expr: &str, f: &dyn Fn(V) -> JsResult<Local>) -> JsResult<V> {
    let callback = |item: Local| f(self.of(item));
    Ok(self.of(self.call_array(receiver, K::Map, &self.map, expr, &callback)?))
  }

  /// `receiver.find(f)`
  pub fn find(&self, receiver: V, expr: &str, f: &dyn Fn(V) -> JsResult<bool>) -> JsResult<V> {
    let callback = |item: Local| Ok(self.boolean(f(self.of(item))?));
    Ok(self.of(self.call_array(receiver, K::Find, &self.find, expr, &callback)?))
  }

  /// `receiver.includes(value)`
  pub fn includes(&self, receiver: V, value: V, expr: &str) -> JsResult<V> {
    self.call_array_with(receiver, K::Includes, &self.includes, value, expr)
  }

  /// `receiver.indexOf(value)`
  pub fn index_of(&self, receiver: V, value: V, expr: &str) -> JsResult<V> {
    self.call_array_with(receiver, K::IndexOf, &self.index_of, value, expr)
  }

  /// `receiver.push(value)`: the method found is always called (the builtin's `Set`s of the
  /// element and of `length` throw on failure, which Node-API's `[[Set]]` does not report).
  pub fn push(&self, receiver: V, value: Local, expr: &str) -> JsResult<()> {
    let func = self.get_v(receiver, K::Push)?;
    self.call(func, receiver.v, &[value], &[expr, ".push"]).map(|_| ())
  }

  /// SameValueZero
  pub fn same_value_zero(&self, a: V, b: V) -> bool {
    if self.strict_eq(a.v, b.v) {
      return true;
    }
    matches!((self.num(a), self.num(b)), (Some(x), Some(y)) if x.is_nan() && y.is_nan())
  }

  /// Keeps `v` beyond the running callback's handle scope (a `Map` key of the TS).
  pub fn hold(&self, v: V) -> JsResult<Held> {
    Ok(match v.tag {
      UNDEFINED => Held::Undefined,
      NULL => Held::Null,
      TRUE => Held::Bool(true),
      FALSE => Held::Bool(false),
      FALSY_NUMBER | NUMBER => Held::Num(self.f64_value(v.v)),
      EMPTY_STRING | STRING => Held::Str(self.utf16(v)),
      BIGINT | FALSY_BIGINT => {
        let (mut sign, mut count) = (0, 0usize);
        check(unsafe { sys::napi_get_value_bigint_words(self.env, v.v.0, &mut sign, &mut count, ptr::null_mut()) })?;
        let mut words = vec![0u64; count];
        check(unsafe { sys::napi_get_value_bigint_words(self.env, v.v.0, &mut sign, &mut count, words.as_mut_ptr()) })?;
        words.truncate(count);
        Held::BigInt(sign, words)
      }
      _ => {
        let mut r = ptr::null_mut();
        check(unsafe { sys::napi_create_reference(self.env, v.v.0, 1, &mut r) })?;
        Held::Ref(self.env, r)
      }
    })
  }

  /// SameValueZero(held, v)
  pub fn held_equals(&self, held: &Held, v: V) -> bool {
    match held {
      Held::Undefined => v.tag == UNDEFINED,
      Held::Null => v.tag == NULL,
      Held::Bool(b) => v.tag == if *b { TRUE } else { FALSE },
      Held::Num(x) => self.num(v).is_some_and(|y| *x == y || (x.is_nan() && y.is_nan())),
      Held::Str(units) => v.is_string() && self.utf16(v) == *units,
      Held::BigInt(..) => matches!(v.tag, BIGINT | FALSY_BIGINT) && self.hold(v).is_ok_and(|other| other == *held),
      Held::Ref(_, r) => (v.is_object_like() || v.tag == SYMBOL) && self.strict_eq(self.r(&Ref(*r)), v.v),
    }
  }

  /// The JS value of `held` (an equal primitive, or the same object).
  pub fn held_value(&self, held: &Held) -> JsResult<Local> {
    Ok(match held {
      Held::Undefined => self.undefined(),
      Held::Null => {
        let mut v = ptr::null_mut();
        unsafe { sys::napi_get_null(self.env, &mut v) };
        Local(v)
      }
      Held::Bool(b) => self.boolean(*b),
      Held::Num(n) => self.number(*n),
      Held::Str(units) => self.string_utf16(units)?,
      Held::BigInt(sign, words) => {
        let mut v = ptr::null_mut();
        check(unsafe { sys::napi_create_bigint_words(self.env, *sign, words.len(), words.as_ptr(), &mut v) })?;
        Local(v)
      }
      Held::Ref(_, r) => self.r(&Ref(*r)),
    })
  }

  // -------------------------------------------------------------------------------------------
  // for...of

  /// `for (const item of items) { body }` (no awaits in the body), as a JS loop of the shell
  /// whose body calls `body`. `body` returns `Some(v)` for a `return v` out of the loop.
  pub fn for_of(&self, items: V, site: Loop, body: &dyn Fn(V) -> JsResult<Option<Local>>) -> JsResult<Option<Local>> {
    let next = self.next();
    let callback = |item: Local| Ok(body(self.of(item))?.unwrap_or(next));
    let helper = match site {
      Loop::StringsToValidate => &self.h_for_of_strings,
      Loop::NumbersToValidate => &self.h_for_of_numbers,
      Loop::AllBlockSlugs => &self.h_for_of_block_slugs,
      Loop::Value => &self.h_for_of_value,
    };
    let result = self.with_engine_callback(&callback, || self.helper(helper, &[items.v]))?;
    Ok((!self.strict_eq(result, next)).then_some(result))
  }

  /// `for (const item of [value]) { body }` over an engine-created literal (only built when the
  /// iteration needs the object).
  pub fn for_of_literal(&self, value: V, expr: &str, body: &dyn Fn(V) -> JsResult<Option<Local>>) -> JsResult<Option<Local>> {
    let result = self.helper(&self.h_literal_iter, &[])?;
    match self.number_result(result) {
      Some(0.0) => match body(value) {
        Ok(None) => Ok(None),
        Ok(Some(v)) => {
          self.close_default_iterator(self.array_of(&[value.v])?, false)?;
          Ok(Some(v))
        }
        Err(e) => {
          let _ = self.array_of(&[value.v]).and_then(|items| self.close_default_iterator(items, true));
          Err(e)
        }
      },
      Some(1.0) => {
        let method = self.of(self.box_get(K::BoxM)?);
        self.for_of_protocol(self.array_of(&[value.v])?, method, expr, body)
      }
      _ => {
        let next = self.of(self.box_get(K::BoxN)?);
        let iterator = self.raw_call(self.r(&self.array_values), self.array_of(&[value.v])?, &[])?;
        self.iterate(iterator, next, body)
      }
    }
  }

  /// `for (const [a, b] of map.entries()) { body(a, b) }` over the engine's `Map` entries (`new
  /// Map()` is emulated): the array-destructuring steps of each entry. `is_quiet(i)` is true
  /// when entry `i`'s body makes no observable operation, so the destructuring reads of the
  /// following entries are made by one shell call (shell `literalPairs`).
  pub fn for_of_pairs(
    &self,
    entries: &[(Local, Local)],
    is_quiet: &dyn Fn(usize) -> bool,
    body: &dyn Fn(V, V) -> JsResult<()>,
  ) -> JsResult<()> {
    let mut i = 0;
    while i < entries.len() {
      let mut last = i;
      while last + 1 < entries.len() && is_quiet(last) {
        last += 1;
      }
      let count = last - i + 1;
      let result = self.helper(&self.h_literal_pairs, &[self.number(count as f64)])?;
      let result = self.number_result(result).unwrap_or(0.0) as usize;
      let (done, code) = (result / 4, result % 4);
      for (a, b) in &entries[i..i + done.min(count)] {
        body(self.of(*a), self.of(*b))?;
      }
      if done >= count {
        i = last + 1;
        continue;
      }
      let (a, b) = entries[i + done];
      let (a, b) = match code {
        1 => {
          let method = self.of(self.box_get(K::BoxM)?);
          self.destructure_pair(self.array_of(&[a, b])?, method)?
        }
        2 => {
          let next = self.of(self.box_get(K::BoxN)?);
          let iterator = self.raw_call(self.r(&self.array_values), self.array_of(&[a, b])?, &[])?;
          self.destructure_steps(iterator, next)?
        }
        _ => {
          let ret = self.of(self.box_get(K::BoxR)?);
          let iterator = self.raw_call(self.r(&self.array_values), self.array_of(&[a, b])?, &[])?;
          self.call_return(iterator, ret, false)?;
          (self.of(a), self.of(b))
        }
      };
      body(a, b)?;
      i += done + 1;
    }
    Ok(())
  }

  /// `const [a, b] = items` with a replaced `@@iterator` method.
  fn destructure_pair(&self, items: Local, method: V) -> JsResult<(V, V)> {
    if !method.is_function() {
      return Err(self.type_error("object is not iterable"));
    }
    let iterator = self.raw_call(method.v, items, &[])?;
    let next = self.iterator_next(iterator)?;
    self.destructure_steps(iterator, next)
  }

  /// Two `IteratorStepValue`s and `IteratorClose` (two targets never exhaust the iterator).
  fn destructure_steps(&self, iterator: Local, next: V) -> JsResult<(V, V)> {
    let mut values = [self.undefined_v(); 2];
    for slot in &mut values {
      let result = self.of(self.call_value(next, iterator)?);
      if !result.is_object_like() {
        return Err(self.iterator_result_error(result));
      }
      if self.get_v(result, K::Done)?.truthy() {
        return Ok((values[0], values[1]));
      }
      *slot = self.get_v(result, K::Value)?;
    }
    self.iterator_close(iterator, false)?;
    Ok((values[0], values[1]))
  }

  /// `GetIterator`'s `Result of the Symbol.iterator method` check and the `next` read.
  fn iterator_next(&self, iterator: Local) -> JsResult<V> {
    let iterator = self.of(iterator);
    if !iterator.is_object_like() {
      return Err(self.type_error("Result of the Symbol.iterator method is not an object"));
    }
    self.get_v(iterator, K::Next)
  }

  /// `IteratorClose` of an array iterator: `return` is looked up on `%ArrayIteratorPrototype%`
  /// (where an array iterator finds it); when one is installed it is called with a fresh
  /// iterator of `items`.
  fn close_default_iterator(&self, items: Local, is_throw: bool) -> JsResult<()> {
    let ret = self.of(self.raw_get(self.r(&self.array_iterator_prototype), self.k(K::Return))?);
    if ret.is_nullish() {
      return Ok(());
    }
    let iterator = self.raw_call(self.r(&self.array_values), items, &[])?;
    self.call_return(iterator, ret, is_throw)
  }

  /// The full iterator protocol with an already read `@@iterator` method.
  fn for_of_protocol(
    &self,
    items: Local,
    method: V,
    expr: &str,
    body: &dyn Fn(V) -> JsResult<Option<Local>>,
  ) -> JsResult<Option<Local>> {
    if !method.is_function() {
      return Err(self.type_error(&format!("{expr} is not iterable")));
    }
    let iterator = self.raw_call(method.v, items, &[])?;
    let next = self.iterator_next(iterator)?;
    self.iterate(iterator, next, body)
  }

  /// The iterator protocol after `GetIterator`.
  fn iterate(&self, iterator: Local, next: V, body: &dyn Fn(V) -> JsResult<Option<Local>>) -> JsResult<Option<Local>> {
    loop {
      let result = self.of(self.call_value(next, iterator)?);
      if !result.is_object_like() {
        return Err(self.iterator_result_error(result));
      }
      if self.get_v(result, K::Done)?.truthy() {
        return Ok(None);
      }
      let item = self.get_v(result, K::Value)?;
      match body(item) {
        Ok(None) => {}
        Ok(Some(v)) => {
          self.iterator_close(iterator, false)?;
          return Ok(Some(v));
        }
        Err(e) => {
          let _ = self.iterator_close(iterator, true);
          return Err(e);
        }
      }
    }
  }

  /// `IteratorClose(iterator, completion)`; for a throw completion its own errors are dropped
  /// (the caller rethrows the original).
  fn iterator_close(&self, iterator: Local, is_throw: bool) -> JsResult<()> {
    let ret = self.of(self.raw_get(iterator, self.k(K::Return))?);
    if ret.is_nullish() {
      return Ok(());
    }
    self.call_return(iterator, ret, is_throw)
  }

  /// Calls an iterator method the TS reaches without a callee expression (`next` / `return`):
  /// V8 names the value by its type when it is not callable (`number 5 is not a function`).
  fn call_value(&self, func: V, this: Local) -> JsResult<Local> {
    if !func.is_function() {
      let text = |v: V| self.string(v).map(|s| String::from_utf16_lossy(&self.utf16(s))).unwrap_or_default();
      let callee = match func.ty() {
        Type::Undefined => "undefined".to_string(),
        Type::Null => "object null".to_string(),
        Type::Boolean => format!("boolean {}", text(func)),
        Type::Number => format!("number {}", text(func)),
        Type::String => format!("string \"{}\"", text(func)),
        Type::Symbol => "symbol".to_string(),
        Type::BigInt => "bigint".to_string(),
        _ => "object".to_string(),
      };
      return Err(self.type_error(&format!("{callee} is not a function")));
    }
    self.raw_call(func.v, this, &[])
  }

  fn call_return(&self, iterator: Local, ret: V, is_throw: bool) -> JsResult<()> {
    let result = self.of(self.call_value(ret, iterator)?);
    if !is_throw && !result.is_object_like() {
      return Err(self.iterator_result_error(result));
    }
    Ok(())
  }

  fn iterator_result_error(&self, result: V) -> Thrown {
    let text = self.describe(result);
    self.type_error(&format!("Iterator result {text} is not an object"))
  }

  fn describe(&self, v: V) -> String {
    self.string(v).map(|s| String::from_utf16_lossy(&self.utf16(s))).unwrap_or_default()
  }
}

// ---------------------------------------------------------------------------------------------
// Values

/// A value kept across handle scopes: primitives copied (identity of primitives is not
/// observable), objects, functions and symbols referenced.
#[derive(PartialEq)]
pub enum Held {
  Undefined,
  Null,
  Bool(bool),
  Num(f64),
  Str(Vec<u16>),
  BigInt(i32, Vec<u64>),
  Ref(sys::napi_env, sys::napi_ref),
}

impl Drop for Held {
  fn drop(&mut self) {
    if let Held::Ref(env, r) = self {
      unsafe { sys::napi_delete_reference(*env, *r) };
    }
  }
}

/// A handle the engine knows the `typeof` / truthiness of: a validator argument with the tag the
/// shell computed (shell.js `tag` / `atag`), or a value classified by [`Cx::of`].
#[derive(Clone, Copy)]
pub struct V {
  pub v: Local,
  tag: u8,
}

const UNDEFINED: u8 = 0;
const NULL: u8 = 1;
const TRUE: u8 = 2;
const FALSE: u8 = 3;
const FALSY_NUMBER: u8 = 4;
const NUMBER: u8 = 5;
const EMPTY_STRING: u8 = 6;
const STRING: u8 = 7;
/// An object, `Array.isArray` not known.
const OBJECT: u8 = 8;
const FUNCTION: u8 = 9;
const SYMBOL: u8 = 10;
const BIGINT: u8 = 11;
const FALSY_BIGINT: u8 = 12;
/// `atag`: an object `Array.isArray` was true for (a real array or a proxy of one).
const ARRAY_HINT: u8 = 13;
/// `atag`: an object that is neither an array nor a proxy, so never an array.
const PLAIN_OBJECT: u8 = 14;
/// `atag`: a proxy (its `Array.isArray` may throw once revoked).
const UNKNOWN_OBJECT: u8 = 15;
/// A binding the shell did not tag (see [`Cx::classify`]); no predicate may be asked of it.
const UNCLASSIFIED: u8 = 16;

impl V {
  /// An argument with its shell tag.
  pub fn tagged(v: Local, tag: u8) -> V {
    V { v, tag }
  }

  /// A binding the shell passes without a tag: [`Cx::classify`] it before use.
  pub fn unclassified(v: Local) -> V {
    V { v, tag: UNCLASSIFIED }
  }

  pub fn ty(self) -> Type {
    debug_assert!(self.tag != UNCLASSIFIED, "unclassified binding");
    match self.tag {
      UNDEFINED => Type::Undefined,
      NULL => Type::Null,
      TRUE | FALSE => Type::Boolean,
      FALSY_NUMBER | NUMBER => Type::Number,
      EMPTY_STRING | STRING => Type::String,
      FUNCTION => Type::Function,
      SYMBOL => Type::Symbol,
      BIGINT | FALSY_BIGINT => Type::BigInt,
      _ => Type::Object,
    }
  }

  pub fn truthy(self) -> bool {
    debug_assert!(self.tag != UNCLASSIFIED, "unclassified binding");
    !matches!(self.tag, UNDEFINED | NULL | FALSE | FALSY_NUMBER | EMPTY_STRING | FALSY_BIGINT)
  }

  pub fn is_nullish(self) -> bool {
    debug_assert!(self.tag != UNCLASSIFIED, "unclassified binding");
    matches!(self.tag, UNDEFINED | NULL)
  }

  pub fn is_undefined(self) -> bool {
    self.tag == UNDEFINED
  }

  pub fn is_null(self) -> bool {
    self.tag == NULL
  }

  pub fn is_true(self) -> bool {
    self.tag == TRUE
  }

  pub fn is_false(self) -> bool {
    self.tag == FALSE
  }

  pub fn is_boolean(self) -> bool {
    matches!(self.tag, TRUE | FALSE)
  }

  pub fn is_number(self) -> bool {
    matches!(self.tag, FALSY_NUMBER | NUMBER)
  }

  pub fn is_string(self) -> bool {
    matches!(self.tag, EMPTY_STRING | STRING)
  }

  pub fn is_function(self) -> bool {
    self.tag == FUNCTION
  }

  /// Objects and functions (Node-API can do property operations on them directly).
  pub fn is_object_like(self) -> bool {
    matches!(self.tag, OBJECT | FUNCTION | ARRAY_HINT | PLAIN_OBJECT | UNKNOWN_OBJECT)
  }

  /// `typeof v === 'object'` (true for `null`).
  pub fn is_typeof_object(self) -> bool {
    matches!(self.tag, NULL | OBJECT | ARRAY_HINT | PLAIN_OBJECT | UNKNOWN_OBJECT)
  }
}

fn data_property(name: sys::napi_value, value: sys::napi_value) -> sys::napi_property_descriptor {
  sys::napi_property_descriptor {
    utf8name: ptr::null(),
    name,
    method: None,
    getter: None,
    setter: None,
    value,
    attributes: sys::PropertyAttributes::writable
      | sys::PropertyAttributes::enumerable
      | sys::PropertyAttributes::configurable,
    data: ptr::null_mut(),
  }
}

/// JS `WhiteSpace` and `LineTerminator` code units (`String.prototype.trim`, `StrWhiteSpaceChar`).
pub fn is_js_whitespace(unit: u16) -> bool {
  matches!(
    unit,
    0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F
      | 0x3000 | 0xFEFF
  )
}

/// `parseFloat` of a string: leading `StrWhiteSpaceChar`s, then the longest prefix that is a
/// `StrDecimalLiteral` (sign, `Infinity`, digits with an optional fraction and exponent).
pub fn parse_float_utf16(units: &[u16]) -> f64 {
  let start = units.iter().position(|u| !is_js_whitespace(*u)).unwrap_or(units.len());
  let s = &units[start..];
  let at = |i: usize| s.get(i).copied().unwrap_or(0);
  let is_digit = |u: u16| (0x30..=0x39).contains(&u);
  let mut i = 0;
  let is_negative = at(0) == u16::from(b'-');
  if is_negative || at(0) == u16::from(b'+') {
    i = 1;
  }
  let infinity: Vec<u16> = "Infinity".encode_utf16().collect();
  if s.len() >= i + infinity.len() && s[i..i + infinity.len()] == infinity[..] {
    return if is_negative { f64::NEG_INFINITY } else { f64::INFINITY };
  }
  let int_start = i;
  while is_digit(at(i)) {
    i += 1;
  }
  let int_digits = i - int_start;
  if at(i) == u16::from(b'.') {
    let mut k = i + 1;
    while is_digit(at(k)) {
      k += 1;
    }
    let frac_digits = k - (i + 1);
    if int_digits == 0 && frac_digits == 0 {
      return f64::NAN;
    }
    i = k;
  } else if int_digits == 0 {
    return f64::NAN;
  }
  if at(i) == u16::from(b'e') || at(i) == u16::from(b'E') {
    let mut k = i + 1;
    if at(k) == u16::from(b'+') || at(k) == u16::from(b'-') {
      k += 1;
    }
    let digits = k;
    while is_digit(at(k)) {
      k += 1;
    }
    if k > digits {
      i = k;
    }
  }
  let literal: String = s[..i].iter().map(|u| char::from(*u as u8)).collect();
  literal.parse::<f64>().unwrap_or(f64::NAN)
}

// ---------------------------------------------------------------------------------------------
// Callbacks for non-builtin array methods

type Callback = dyn Fn(&[Local]) -> JsResult<Local>;

/// Heap cell behind a callback function: points at the Rust closure while it may be called.
struct CallbackCell(Cell<Option<*const Callback>>);

unsafe extern "C" fn callback_trampoline(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  js::set_env(env);
  let (args, data) = js::callback_args::<3>(env, info);
  let cell = unsafe { &*(data as *const CallbackCell) };
  let result = match cell.0.get() {
    // SAFETY: the pointer is cleared before the closure it points at goes out of scope.
    Some(f) => catch_unwind(AssertUnwindSafe(|| unsafe { (*f)(&args) }))
      .unwrap_or_else(|_| Err(js::engine_error("payload validator callback panicked"))),
    None => Err(js::engine_error("payload validator callback called after the validator returned")),
  };
  match result {
    Ok(v) => v.0,
    Err(Thrown(e)) => {
      js::throw(e.get());
      ptr::null_mut()
    }
  }
}

unsafe extern "C" fn free_callback_cell(_env: sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
  drop(unsafe { Box::from_raw(data as *mut CallbackCell) });
}

struct ClearOnDrop(*const CallbackCell);

impl Drop for ClearOnDrop {
  fn drop(&mut self) {
    // SAFETY: the function holding the cell is referenced by the current handle scope, so its
    // finalizer (which frees the cell) can't have run yet.
    unsafe { (*self.0).0.set(None) };
  }
}

/// Runs `body` with a fresh JS function that calls `f` (the TS arrow passed to a user-replaced
/// array method). The function only calls `f` until `body` returns; a retained function throws
/// afterwards instead of touching freed memory.
fn with_callback<'f, R>(
  f: &'f (dyn Fn(&[Local]) -> JsResult<Local> + 'f),
  body: impl FnOnce(Local) -> JsResult<R>,
) -> JsResult<R> {
  // SAFETY: lifetime erasure; the pointer is cleared by `ClearOnDrop` before `f` is dropped.
  let f: *const Callback = unsafe {
    std::mem::transmute::<&'f (dyn Fn(&[Local]) -> JsResult<Local> + 'f), &'static Callback>(f)
  };
  let cell = Box::into_raw(Box::new(CallbackCell(Cell::new(Some(f)))));
  let _clear = ClearOnDrop(cell);
  let func = js::create_function("", callback_trampoline, cell.cast());
  check(unsafe {
    sys::napi_add_finalizer(js::env(), func.0, cell.cast(), Some(free_callback_cell), ptr::null_mut(), ptr::null_mut())
  })?;
  body(func)
}
