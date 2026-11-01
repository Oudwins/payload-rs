//! JS operations on live values with V8's semantics, over raw Node-API.
//!
//! Property reads use `napi_get_property` ([[Get]]: getters, proxies, prototype chain,
//! `ToPropertyKey` of computed keys); reads on primitives and nullish receivers go through the
//! shell's `get` helper so V8 boxes / throws its own `TypeError`. Object and array literals are
//! built with `napi_define_properties` (CreateDataProperty, never a setter). Array methods the TS
//! calls on JS arrays (`.some`, `.filter`, ...) are looked up like the TS does; when the result is
//! the realm's builtin and the receiver a real array, the builtin's spec steps run here with
//! Node-API element operations (`HasProperty` / `Get` / live `length`, `ArraySpeciesCreate`),
//! otherwise the real method is called with a Rust callback. `for...of` does the same with the
//! shell's `arrayIterator` check (default iterator: index walk; otherwise the full iterator
//! protocol, including `IteratorClose`).

use std::cell::Cell;
use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Persist, Thrown, Type, Val, check};

/// The constructor `ArraySpeciesCreate` uses: `%Array%`, or the one `@@species` gave.
#[derive(Clone, Copy)]
enum Species {
  Array,
  Constructor(Local),
}

/// Intrinsics and helpers of one binding (shell.js `bootstrap({...})`).
pub struct Cx {
  pub next: Persist,
  symbols: Persist,
  array_iterator_prototype: Persist,
  array_values: Persist,
  some: Persist,
  for_each: Persist,
  filter: Persist,
  map: Persist,
  find: Persist,
  includes: Persist,
  index_of: Persist,
  push: Persist,
  array_iterator: Persist,
  literal_iterator: Persist,
  species_method: Persist,
  species_marker: Persist,
  species_box: Persist,
  h_get: Persist,
  h_is_array: Persist,
  h_lt: Persist,
  h_gt: Persist,
  h_string: Persist,
  h_number: Persist,
  pub h_date_parse: Persist,
  pub h_email_test: Persist,
  pub h_object_id_is_valid: Persist,
  pub h_object_id_hex: Persist,
  pub h_find_collection: Persist,
  pub h_object_keys_length: Persist,
  h_error: Persist,
  h_type_error: Persist,
  pub h_duplicates_message: Persist,
  pub h_invalid_relationships_message: Persist,
  pub h_invalid_selections_message: Persist,
}

impl Cx {
  pub fn new(host: Local) -> JsResult<Cx> {
    let f = |name: &str| -> JsResult<Persist> { Persist::new(js::get_named(host, name)?) };
    Ok(Cx {
      next: f("NEXT")?,
      symbols: f("symbols")?,
      array_iterator_prototype: f("arrayIteratorPrototype")?,
      array_values: f("arrayValues")?,
      some: f("some")?,
      for_each: f("forEach")?,
      filter: f("filter")?,
      map: f("map")?,
      find: f("find")?,
      includes: f("includes")?,
      index_of: f("indexOf")?,
      push: f("push")?,
      array_iterator: f("arrayIterator")?,
      literal_iterator: f("literalIterator")?,
      species_method: f("speciesMethod")?,
      species_marker: f("SPECIES")?,
      species_box: f("species")?,
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

  /// Calls a shell helper as a plain function.
  pub fn helper(&self, helper: &Persist, args: &[Local]) -> JsResult<Local> {
    js::call(helper.get(), js::undefined(), args)
  }

  // -------------------------------------------------------------------------------------------
  // Property access

  /// `o.name`
  pub fn get(&self, o: impl Js, name: &str) -> JsResult<Local> {
    self.get_key(o, js::key(name))
  }

  /// `o[key]` (`ToPropertyKey(key)` by V8).
  pub fn get_key(&self, o: impl Js, key: Local) -> JsResult<Local> {
    if o.kind().is_object_like() {
      js::get_property(o.local(), key)
    } else {
      self.helper(&self.h_get, &[o.local(), key])
    }
  }

  /// `o?.name`
  pub fn get_opt(&self, o: impl Js, name: &str) -> JsResult<Local> {
    if is_nullish(o) { Ok(js::undefined()) } else { self.get(o, name) }
  }

  /// `o?.[key]`
  pub fn get_opt_key(&self, o: impl Js, key: Local) -> JsResult<Local> {
    if is_nullish(o) { Ok(js::undefined()) } else { self.get_key(o, key) }
  }

  /// `o[index]`
  pub fn get_index(&self, o: impl Js, index: u32) -> JsResult<Local> {
    if o.kind().is_object_like() {
      js::get_element(o.local(), index)
    } else {
      self.helper(&self.h_get, &[o.local(), js::number(f64::from(index))])
    }
  }

  /// `o.length` (a primitive string's own `length` is read without a call).
  pub fn length(&self, o: impl Js) -> JsResult<Local> {
    match if o.tag().is_none() || is_string(o) { string_length(o.local()) } else { None } {
      Some(n) => Ok(js::number(n as f64)),
      None => self.get(o, "length"),
    }
  }

  /// `o?.length`
  pub fn length_opt(&self, o: impl Js) -> JsResult<Local> {
    if is_nullish(o) { Ok(js::undefined()) } else { self.length(o) }
  }

  fn symbol(&self, index: u32) -> JsResult<Local> {
    js::get_element(self.symbols.get(), index)
  }

  // -------------------------------------------------------------------------------------------
  // Operators and builtins

  /// `Array.isArray(v)` (`napi_is_array` is false for proxies of arrays: those ask the realm).
  pub fn is_array(&self, v: impl Js) -> JsResult<bool> {
    if v.kind() != Type::Object {
      return Ok(false);
    }
    if js::is_array(v.local()) {
      return Ok(true);
    }
    Ok(js::truthy(self.helper(&self.h_is_array, &[v.local()])?))
  }

  /// `a < b`
  pub fn lt(&self, a: impl Js, b: impl Js) -> JsResult<bool> {
    if let (Some(a), Some(b)) = (number_value(a), number_value(b)) {
      return Ok(a < b);
    }
    Ok(js::truthy(self.helper(&self.h_lt, &[a.local(), b.local()])?))
  }

  /// `a > b`
  pub fn gt(&self, a: impl Js, b: impl Js) -> JsResult<bool> {
    if let (Some(a), Some(b)) = (number_value(a), number_value(b)) {
      return Ok(a > b);
    }
    Ok(js::truthy(self.helper(&self.h_gt, &[a.local(), b.local()])?))
  }

  /// `String(v)` (symbols allowed).
  pub fn string(&self, v: impl Js) -> JsResult<Local> {
    match ty(v) {
      Type::String => Ok(v.local()),
      Type::Symbol => self.helper(&self.h_string, &[v.local()]),
      _ => to_string(v.local()),
    }
  }

  /// `Number(v)`
  pub fn number(&self, v: impl Js) -> JsResult<f64> {
    match ty(v) {
      Type::Number => Ok(js::get_f64(v.local())),
      Type::String | Type::Boolean | Type::Undefined | Type::Null | Type::Symbol => {
        let mut out = ptr::null_mut();
        check(unsafe { sys::napi_coerce_to_number(js::env(), v.local().0, &mut out) })?;
        Ok(js::get_f64(Local(out)))
      }
      _ => Ok(js::get_f64(self.helper(&self.h_number, &[v.local()])?)),
    }
  }

  /// `parseFloat(v)`
  pub fn parse_float(&self, v: impl Js) -> JsResult<f64> {
    if let Some(n) = number_value(v) {
      // `ToString` of a number parses back to the same number, except `-0` ("0").
      return Ok(if n == 0.0 { 0.0 } else { n });
    }
    let s = to_string(v.local())?;
    Ok(parse_float_utf16(&js::get_string_utf16(s).unwrap_or_default()))
  }

  /// `parseFloat(String(v))`
  pub fn parse_float_of_string(&self, v: impl Js) -> JsResult<f64> {
    match ty(v) {
      Type::Number => self.parse_float(v),
      Type::Symbol => Ok(f64::NAN),
      _ => self.parse_float(self.string(v)?),
    }
  }

  /// `isNumber(value)` (`payload/src/utilities/isNumber.ts`)
  pub fn is_number(&self, value: impl Js) -> JsResult<bool> {
    match ty(value) {
      Type::Undefined | Type::Null => return Ok(false),
      Type::Number => return Ok(!js::get_f64(value.local()).is_nan()),
      Type::String => {
        if js::get_string_utf16(value.local()).is_some_and(|units| units.iter().all(|u| is_js_whitespace(*u))) {
          return Ok(false);
        }
      }
      _ => {}
    }
    Ok(!self.number(value)?.is_nan())
  }

  // -------------------------------------------------------------------------------------------
  // Calls, literals, errors

  /// Calls `func` (the callee `expr`) with `this`; V8's `TypeError` when it is not callable.
  pub fn call(&self, func: impl Js, this: Local, args: &[Local], expr: &str) -> JsResult<Local> {
    if ty(func) != Type::Function {
      return Err(self.type_error(&format!("{expr} is not a function")));
    }
    js::call(func.local(), this, args)
  }

  /// `receiver.method(...args)`: `expr` is the receiver's source text.
  pub fn call_method(&self, receiver: impl Js, method: &str, args: &[Local], expr: &str) -> JsResult<Local> {
    let func = self.get(receiver, method)?;
    self.call(func, receiver.local(), args, &format!("{expr}.{method}"))
  }

  /// `t(key)` / `t(key, vars)` with the destructured `t`.
  pub fn t(&self, t: impl Js, key: &str, vars: Option<Local>) -> JsResult<Local> {
    match vars {
      Some(vars) => self.call(t, js::undefined(), &[js::string(key), vars], "t"),
      None => self.call(t, js::undefined(), &[js::string(key)], "t"),
    }
  }

  /// An object literal (own data properties in source order).
  pub fn object(&self, entries: &[(&str, Local)]) -> JsResult<Local> {
    let o = js::object();
    let descs: Vec<sys::napi_property_descriptor> =
      entries.iter().map(|(name, value)| data_property(js::key(name), *value)).collect();
    check(unsafe { sys::napi_define_properties(js::env(), o.0, descs.len(), descs.as_ptr()) })?;
    Ok(o)
  }

  /// An array literal.
  pub fn array_of(&self, items: &[Local]) -> JsResult<Local> {
    let a = js::array();
    for (i, item) in items.iter().enumerate() {
      define_index(a, i as u32, *item)?;
    }
    Ok(a)
  }

  pub fn type_error(&self, message: &str) -> Thrown {
    self.error_with(&self.h_type_error, message)
  }

  /// `new Error(message)`
  pub fn error(&self, message: &str) -> Thrown {
    self.error_with(&self.h_error, message)
  }

  fn error_with(&self, ctor: &Persist, message: &str) -> Thrown {
    match self.helper(ctor, &[js::string(message)]).and_then(Val::from_local) {
      Ok(v) => Thrown(v),
      Err(e) => e,
    }
  }

  // -------------------------------------------------------------------------------------------
  // Array methods

  /// Looks up `receiver[name]` (as the TS does); `Some(func)` when the builtin's steps run here.
  fn builtin(&self, receiver: Local, name: &str, intrinsic: &Persist) -> JsResult<(Local, bool)> {
    let func = self.get(receiver, name)?;
    Ok((func, js::is_array(receiver) && js::strict_equals(func, intrinsic.get())))
  }

  /// `receiver.some(f)`
  pub fn some(&self, receiver: impl Js, expr: &str, f: &dyn Fn(Local) -> JsResult<bool>) -> JsResult<Local> {
    let receiver = receiver.local();
    let (func, is_builtin) = self.builtin(receiver, "some", &self.some)?;
    if is_builtin {
      let len = js::array_length(receiver);
      for k in 0..len {
        if has_element(receiver, k)? && f(js::get_element(receiver, k)?)? {
          return Ok(js::boolean(true));
        }
      }
      return Ok(js::boolean(false));
    }
    let callback = |args: &[Local]| Ok(js::boolean(f(args[0])?));
    with_callback(&callback, |cb| self.call(func, receiver, &[cb], &format!("{expr}.some")))
  }

  /// `receiver.forEach(f)`
  pub fn for_each(&self, receiver: impl Js, expr: &str, f: &dyn Fn(Local) -> JsResult<()>) -> JsResult<()> {
    let receiver = receiver.local();
    let (func, is_builtin) = self.builtin(receiver, "forEach", &self.for_each)?;
    if is_builtin {
      let len = js::array_length(receiver);
      for k in 0..len {
        if has_element(receiver, k)? {
          f(js::get_element(receiver, k)?)?;
        }
      }
      return Ok(());
    }
    let callback = |args: &[Local]| {
      f(args[0])?;
      Ok(js::undefined())
    };
    with_callback(&callback, |cb| self.call(func, receiver, &[cb], &format!("{expr}.forEach"))).map(|_| ())
  }

  /// `receiver.filter(f)`
  pub fn filter(&self, receiver: impl Js, expr: &str, f: &dyn Fn(Local) -> JsResult<bool>) -> JsResult<Local> {
    let receiver = receiver.local();
    let (func, species) = self.species_method(receiver, "filter", &self.filter)?;
    if let Some(species) = species {
      let len = js::array_length(receiver);
      let out = self.array_species_create(species, 0)?;
      let mut to = 0;
      for k in 0..len {
        if has_element(receiver, k)? {
          let value = js::get_element(receiver, k)?;
          if f(value)? {
            define_index(out, to, value)?;
            to += 1;
          }
        }
      }
      return Ok(out);
    }
    let callback = |args: &[Local]| Ok(js::boolean(f(args[0])?));
    with_callback(&callback, |cb| self.call(func, receiver, &[cb], &format!("{expr}.filter")))
  }

  /// `receiver.map(f)`
  pub fn map(&self, receiver: impl Js, expr: &str, f: &dyn Fn(Local) -> JsResult<Local>) -> JsResult<Local> {
    let receiver = receiver.local();
    let (func, species) = self.species_method(receiver, "map", &self.map)?;
    if let Some(species) = species {
      let len = js::array_length(receiver);
      let out = self.array_species_create(species, len)?;
      for k in 0..len {
        if has_element(receiver, k)? {
          let mapped = f(js::get_element(receiver, k)?)?;
          define_index(out, k, mapped)?;
        }
      }
      return Ok(out);
    }
    let callback = |args: &[Local]| f(args[0]);
    with_callback(&callback, |cb| self.call(func, receiver, &[cb], &format!("{expr}.map")))
  }

  /// `receiver.find(f)`
  pub fn find(&self, receiver: impl Js, expr: &str, f: &dyn Fn(Local) -> JsResult<bool>) -> JsResult<Local> {
    let receiver = receiver.local();
    let (func, is_builtin) = self.builtin(receiver, "find", &self.find)?;
    if is_builtin {
      let len = js::array_length(receiver);
      for k in 0..len {
        let value = js::get_element(receiver, k)?;
        if f(value)? {
          return Ok(value);
        }
      }
      return Ok(js::undefined());
    }
    let callback = |args: &[Local]| Ok(js::boolean(f(args[0])?));
    with_callback(&callback, |cb| self.call(func, receiver, &[cb], &format!("{expr}.find")))
  }

  /// `receiver.includes(value)`
  pub fn includes(&self, receiver: impl Js, value: impl Js, expr: &str) -> JsResult<Local> {
    let (receiver, value) = (receiver.local(), value.local());
    let (func, is_builtin) = self.builtin(receiver, "includes", &self.includes)?;
    if is_builtin {
      let len = js::array_length(receiver);
      for k in 0..len {
        if same_value_zero(js::get_element(receiver, k)?, value) {
          return Ok(js::boolean(true));
        }
      }
      return Ok(js::boolean(false));
    }
    self.call(func, receiver, &[value], &format!("{expr}.includes"))
  }

  /// `receiver.indexOf(value)`
  pub fn index_of(&self, receiver: impl Js, value: impl Js, expr: &str) -> JsResult<Local> {
    let (receiver, value) = (receiver.local(), value.local());
    let (func, is_builtin) = self.builtin(receiver, "indexOf", &self.index_of)?;
    if is_builtin {
      let len = js::array_length(receiver);
      for k in 0..len {
        if has_element(receiver, k)? && js::strict_equals(js::get_element(receiver, k)?, value) {
          return Ok(js::number(f64::from(k)));
        }
      }
      return Ok(js::number(-1.0));
    }
    self.call(func, receiver, &[value], &format!("{expr}.indexOf"))
  }

  /// `receiver.push(value)`
  pub fn push(&self, receiver: impl Js, value: impl Js, expr: &str) -> JsResult<()> {
    let (receiver, value) = (receiver.local(), value.local());
    let (func, is_builtin) = self.builtin(receiver, "push", &self.push)?;
    if is_builtin {
      // `Set(O, len, value, true)` (the new length follows from the element write).
      return js::set_element(receiver, js::array_length(receiver), value);
    }
    self.call(func, receiver, &[value], &format!("{expr}.push")).map(|_| ())
  }

  /// The method lookup of a `.filter` / `.map` call and, when it is the builtin on a real array,
  /// the `constructor` / `@@species` reads of its `ArraySpeciesCreate` (shell `speciesMethod`):
  /// `(method, None)` to call the method, `(_, Some(species))` to run the builtin's steps.
  fn species_method(&self, receiver: Local, name: &str, intrinsic: &Persist) -> JsResult<(Local, Option<Species>)> {
    let args = [receiver, js::key(name), intrinsic.get(), js::boolean(js::is_array(receiver))];
    let found = self.helper(&self.species_method, &args)?;
    if js::strict_equals(found, self.next.get()) {
      return Ok((found, Some(Species::Array)));
    }
    if js::strict_equals(found, self.species_marker.get()) {
      return Ok((found, Some(Species::Constructor(js::get_named(self.species_box.get(), "C")?))));
    }
    Ok((found, None))
  }

  /// The rest of `ArraySpeciesCreate(original, length)`.
  fn array_species_create(&self, species: Species, length: u32) -> JsResult<Local> {
    let c = match species {
      Species::Array => {
        let mut out = ptr::null_mut();
        check(unsafe { sys::napi_create_array_with_length(js::env(), length as usize, &mut out) })?;
        return Ok(Local(out));
      }
      Species::Constructor(c) => c,
    };
    if ty(c) != Type::Function {
      return Err(self.type_error("object.constructor[Symbol.species] is not a constructor"));
    }
    let mut out = ptr::null_mut();
    let arg = js::number(f64::from(length));
    check(unsafe { sys::napi_new_instance(js::env(), c.0, 1, &arg.0, &mut out) })?;
    Ok(Local(out))
  }

  // -------------------------------------------------------------------------------------------
  // for...of

  /// `for (const item of items) { body }` (no awaits in the body). `body` returns `Some(v)` for a
  /// `return v` out of the loop. `expr` is the source text of `items` (V8's "is not iterable").
  pub fn for_of(&self, items: impl Js, expr: &str, body: &dyn Fn(Local) -> JsResult<Option<Local>>) -> JsResult<Option<Local>> {
    if is_nullish(items) {
      return Err(self.type_error(&format!("{expr} is not iterable")));
    }
    let items = items.local();
    let method = if js::is_array(items) {
      let method = self.helper(&self.array_iterator, &[items])?;
      if js::strict_equals(method, self.next.get()) {
        return self.for_of_default(items, body);
      }
      method
    } else {
      self.get_key(items, self.symbol(0)?)?
    };
    self.for_of_protocol(items, method, expr, body)
  }

  /// `for (const item of [value]) { body }` over an engine-created literal (only built when the
  /// iteration needs the object).
  pub fn for_of_literal(&self, value: impl Js, expr: &str, body: &dyn Fn(Local) -> JsResult<Option<Local>>) -> JsResult<Option<Local>> {
    let value = value.local();
    let method = self.helper(&self.literal_iterator, &[])?;
    if !js::strict_equals(method, self.next.get()) {
      let items = self.array_of(&[value])?;
      return self.for_of_protocol(items, method, expr, body);
    }
    match body(value) {
      Ok(None) => Ok(None),
      Ok(Some(v)) => {
        self.close_literal_iterator(value, false)?;
        Ok(Some(v))
      }
      Err(e) => {
        let _ = self.close_literal_iterator(value, true);
        Err(e)
      }
    }
  }

  fn close_literal_iterator(&self, value: Local, is_throw: bool) -> JsResult<()> {
    let ret = js::get_named(self.array_iterator_prototype.get(), "return")?;
    if is_nullish(ret) {
      return Ok(());
    }
    let iterator = js::call(self.array_values.get(), self.array_of(&[value])?, &[])?;
    self.call_return(iterator, ret, is_throw)
  }

  /// `const [a, b] = entry` for an engine-created two-element `entry` (a `Map` entry): GetIterator,
  /// two IteratorStepValues and IteratorClose (two targets never exhaust the iterator). Returns
  /// the bound values, which only differ from `(a, b)` under a replaced array iterator.
  pub fn destructure_pair(&self, a: Local, b: Local) -> JsResult<(Local, Local)> {
    let method = self.helper(&self.literal_iterator, &[])?;
    if js::strict_equals(method, self.next.get()) {
      let ret = js::get_named(self.array_iterator_prototype.get(), "return")?;
      if !is_nullish(ret) {
        let iterator = js::call(self.array_values.get(), self.array_of(&[a, b])?, &[])?;
        self.call_return(iterator, ret, false)?;
      }
      return Ok((a, b));
    }
    if ty(method) != Type::Function {
      return Err(self.type_error("object is not iterable"));
    }
    let iterator = js::call(method, self.array_of(&[a, b])?, &[])?;
    if !ty(iterator).is_object_like() {
      return Err(self.type_error("Result of the Symbol.iterator method is not an object"));
    }
    let next = js::get_named(iterator, "next")?;
    let mut values = [js::undefined(); 2];
    for slot in &mut values {
      let result = self.call(next, iterator, &[], "iterator.next")?;
      if !ty(result).is_object_like() {
        return Err(self.iterator_result_error(result));
      }
      if js::truthy(js::get_named(result, "done")?) {
        return Ok((values[0], values[1]));
      }
      *slot = js::get_named(result, "value")?;
    }
    self.iterator_close(iterator, false)?;
    Ok((values[0], values[1]))
  }

  /// The default array iterator: one element per step, `length` read live.
  fn for_of_default(&self, items: Local, body: &dyn Fn(Local) -> JsResult<Option<Local>>) -> JsResult<Option<Local>> {
    let mut index = 0;
    while index < js::array_length(items) {
      let item = js::get_element(items, index)?;
      index += 1;
      match body(item) {
        Ok(None) => {}
        Ok(Some(v)) => {
          self.close_default_iterator(items, false)?;
          return Ok(Some(v));
        }
        Err(e) => {
          let _ = self.close_default_iterator(items, true);
          return Err(e);
        }
      }
    }
    Ok(None)
  }

  /// `IteratorClose` of an array iterator: `return` is looked up on `%ArrayIteratorPrototype%`
  /// (where an array iterator finds it); when one is installed it is called with a fresh
  /// iterator of `items`.
  fn close_default_iterator(&self, items: Local, is_throw: bool) -> JsResult<()> {
    let ret = js::get_named(self.array_iterator_prototype.get(), "return")?;
    if is_nullish(ret) {
      return Ok(());
    }
    let iterator = js::call(self.array_values.get(), items, &[])?;
    self.call_return(iterator, ret, is_throw)
  }

  /// The full iterator protocol with an already read `@@iterator` method.
  fn for_of_protocol(
    &self,
    items: Local,
    method: Local,
    expr: &str,
    body: &dyn Fn(Local) -> JsResult<Option<Local>>,
  ) -> JsResult<Option<Local>> {
    if ty(method) != Type::Function {
      return Err(self.type_error(&format!("{expr} is not iterable")));
    }
    let iterator = js::call(method, items, &[])?;
    if !ty(iterator).is_object_like() {
      return Err(self.type_error("Result of the Symbol.iterator method is not an object"));
    }
    let next = js::get_named(iterator, "next")?;
    loop {
      let result = self.call(next, iterator, &[], "iterator.next")?;
      if !ty(result).is_object_like() {
        return Err(self.iterator_result_error(result));
      }
      if js::truthy(js::get_named(result, "done")?) {
        return Ok(None);
      }
      let item = js::get_named(result, "value")?;
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
    let ret = js::get_named(iterator, "return")?;
    if is_nullish(ret) {
      return Ok(());
    }
    self.call_return(iterator, ret, is_throw)
  }

  fn call_return(&self, iterator: Local, ret: Local, is_throw: bool) -> JsResult<()> {
    if ty(ret) != Type::Function {
      return Err(self.type_error(&format!("{} is not a function", self.describe(ret))));
    }
    let result = js::call(ret, iterator, &[])?;
    if !is_throw && !ty(result).is_object_like() {
      return Err(self.iterator_result_error(result));
    }
    Ok(())
  }

  fn iterator_result_error(&self, result: Local) -> Thrown {
    let text = self.describe(result);
    self.type_error(&format!("Iterator result {text} is not an object"))
  }

  fn describe(&self, v: Local) -> String {
    self.string(v).ok().and_then(js::get_string).unwrap_or_default()
  }
}

// ---------------------------------------------------------------------------------------------
// Value helpers

/// A handle the engine knows the `typeof` / truthiness of: a validator argument with the tag the
/// shell computed (shell.js `tag`), or any value classified by [`V::of`].
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
const OBJECT: u8 = 8;
const FUNCTION: u8 = 9;
const SYMBOL: u8 = 10;
const BIGINT: u8 = 11;
const FALSY_BIGINT: u8 = 12;

impl V {
  /// An argument with its shell tag.
  pub fn tagged(v: Local, tag: u8) -> V {
    V { v, tag }
  }

  pub fn of(v: Local) -> V {
    let tag = match js::type_of(v) {
      Type::Undefined => UNDEFINED,
      Type::Null => NULL,
      Type::Boolean => {
        if js::get_bool(v) {
          TRUE
        } else {
          FALSE
        }
      }
      Type::Number => {
        let n = js::get_f64(v);
        if n == 0.0 || n.is_nan() { FALSY_NUMBER } else { NUMBER }
      }
      Type::String => {
        if string_length(v) == Some(0) {
          EMPTY_STRING
        } else {
          STRING
        }
      }
      Type::Object | Type::External => OBJECT,
      Type::Function => FUNCTION,
      Type::Symbol => SYMBOL,
      Type::BigInt => {
        if js::truthy(v) {
          BIGINT
        } else {
          FALSY_BIGINT
        }
      }
    };
    V { v, tag }
  }
}

/// Values the predicates below work on: raw handles (classified with Node-API on each use) and
/// tagged [`V`]s (classified once).
pub trait Js: Copy {
  fn local(self) -> Local;
  fn kind(self) -> Type;
  fn is_truthy(self) -> bool;
  /// `Some(tag)` when known without a Node-API call.
  fn tag(self) -> Option<u8>;
}

impl Js for Local {
  fn local(self) -> Local {
    self
  }

  fn kind(self) -> Type {
    js::type_of(self)
  }

  fn is_truthy(self) -> bool {
    js::truthy(self)
  }

  fn tag(self) -> Option<u8> {
    None
  }
}

impl Js for V {
  fn local(self) -> Local {
    self.v
  }

  fn kind(self) -> Type {
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

  fn is_truthy(self) -> bool {
    matches!(self.tag, TRUE | NUMBER | STRING | OBJECT | FUNCTION | SYMBOL | BIGINT)
  }

  fn tag(self) -> Option<u8> {
    Some(self.tag)
  }
}

pub fn ty(v: impl Js) -> Type {
  v.kind()
}

pub fn is_nullish(v: impl Js) -> bool {
  matches!(v.kind(), Type::Undefined | Type::Null)
}

pub fn is_string(v: impl Js) -> bool {
  match v.tag() {
    Some(tag) => matches!(tag, EMPTY_STRING | STRING),
    None => string_length(v.local()).is_some(),
  }
}

/// `typeof v === 'number'`
pub fn is_number_type(v: impl Js) -> bool {
  number_value(v).is_some()
}

/// `typeof v === 'object'` (true for `null`).
pub fn is_typeof_object(v: impl Js) -> bool {
  v.kind().is_typeof_object()
}

pub fn truthy(v: impl Js) -> bool {
  v.is_truthy()
}

/// `v === true`
pub fn is_true(v: impl Js) -> bool {
  match v.tag() {
    Some(tag) => tag == TRUE,
    None => {
      let mut b = false;
      (unsafe { sys::napi_get_value_bool(js::env(), v.local().0, &mut b) }) == sys::Status::napi_ok && b
    }
  }
}

/// `v === false`
pub fn is_false(v: impl Js) -> bool {
  match v.tag() {
    Some(tag) => tag == FALSE,
    None => {
      let mut b = true;
      (unsafe { sys::napi_get_value_bool(js::env(), v.local().0, &mut b) }) == sys::Status::napi_ok && !b
    }
  }
}

pub fn strict_eq(a: impl Js, b: impl Js) -> bool {
  js::strict_equals(a.local(), b.local())
}

/// `v === n`
pub fn eq_num(v: impl Js, n: f64) -> bool {
  number_value(v) == Some(n)
}

/// `v === 'literal'`
pub fn eq_str(v: impl Js, s: &str) -> bool {
  if v.tag().is_some_and(|tag| !matches!(tag, EMPTY_STRING | STRING)) {
    return false;
  }
  // `s` is an ASCII literal: equal strings have the same length in UTF-16 and Latin-1.
  let mut buf = [0u8; 32];
  let mut len = 0usize;
  if s.len() >= buf.len() || string_length(v.local()) != Some(s.len()) {
    return s.len() >= buf.len() && js::str_equals(v.local(), s);
  }
  let status = unsafe {
    sys::napi_get_value_string_latin1(js::env(), v.local().0, buf.as_mut_ptr().cast(), buf.len(), &mut len)
  };
  status == sys::Status::napi_ok && &buf[..len] == s.as_bytes()
}

/// The value of a number, `None` for anything else.
pub fn number_value(v: impl Js) -> Option<f64> {
  if v.tag().is_some_and(|tag| !matches!(tag, FALSY_NUMBER | NUMBER)) {
    return None;
  }
  let mut n = 0.0;
  ((unsafe { sys::napi_get_value_double(js::env(), v.local().0, &mut n) }) == sys::Status::napi_ok).then_some(n)
}

/// UTF-16 length of a string, `None` for anything else.
pub fn string_length(v: Local) -> Option<usize> {
  let mut len = 0usize;
  ((unsafe { sys::napi_get_value_string_utf16(js::env(), v.0, ptr::null_mut(), 0, &mut len) }) == sys::Status::napi_ok)
    .then_some(len)
}

/// SameValueZero
pub fn same_value_zero(a: Local, b: Local) -> bool {
  if js::strict_equals(a, b) {
    return true;
  }
  matches!((number_value(a), number_value(b)), (Some(x), Some(y)) if x.is_nan() && y.is_nan())
}

pub fn yes() -> Local {
  js::boolean(true)
}

/// `ToString(v)` (template literal / string concatenation; throws for symbols).
pub fn to_string(v: Local) -> JsResult<Local> {
  if is_string(v) {
    return Ok(v);
  }
  let mut out = ptr::null_mut();
  check(unsafe { sys::napi_coerce_to_string(js::env(), v.0, &mut out) })?;
  Ok(Local(out))
}

/// `` `${a}${b}` `` for an engine string `b`.
pub fn concat(a: Local, b: &str) -> JsResult<Local> {
  let mut units = js::get_string_utf16(to_string(a)?).unwrap_or_default();
  units.extend(b.encode_utf16());
  let mut v = ptr::null_mut();
  check(unsafe { sys::napi_create_string_utf16(js::env(), units.as_ptr(), units.len() as isize, &mut v) })?;
  Ok(Local(v))
}

fn has_element(o: Local, index: u32) -> JsResult<bool> {
  let mut r = false;
  check(unsafe { sys::napi_has_element(js::env(), o.0, index, &mut r) })?;
  Ok(r)
}

fn data_property(name: Local, value: Local) -> sys::napi_property_descriptor {
  sys::napi_property_descriptor {
    utf8name: ptr::null(),
    name: name.0,
    method: None,
    getter: None,
    setter: None,
    value: value.0,
    attributes: sys::PropertyAttributes::writable
      | sys::PropertyAttributes::enumerable
      | sys::PropertyAttributes::configurable,
    data: ptr::null_mut(),
  }
}

/// `CreateDataPropertyOrThrow(o, ToString(index), value)`
fn define_index(o: Local, index: u32, value: Local) -> JsResult<()> {
  let name = index.to_string();
  let desc = data_property(js::key(&name), value);
  check(unsafe { sys::napi_define_properties(js::env(), o.0, 1, &desc) })
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
