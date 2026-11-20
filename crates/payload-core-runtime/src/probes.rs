//! Probe exports for the runtime's JS-semantics differentials (test/__rs/core-runtime/semantics):
//! each runs one runtime primitive on live JS values so a test can compare it with the TS
//! construct it stands for (constructor reads, ticks, trap counts, setter calls, error classes).

use std::cell::Cell;
use std::rc::Rc;

use crate::executor::{Tail, await_js, spawn, spawn_tail};
use crate::host;
use crate::js::{self, JsResult, Local, Val};

/// `(async (v) => await v)(value)` as an engine task.
pub fn await_once(value: Local) -> JsResult<Local> {
  let value = Val::from_local(value)?;
  spawn(async move { await_js(value.get()).await })
}

/// `(async (v) => { await v; await v; return v })(value)`-like chain of `n` awaits of `value`.
pub fn await_n(value: Local, n: u32) -> JsResult<Local> {
  let value = Val::from_local(value)?;
  spawn(async move {
    let mut last = Val::Undefined;
    for _ in 0..n {
      last = await_js(value.get()).await?;
    }
    Ok(last)
  })
}

/// `(async (p, v) => { await p; return v })(promise, value)` through `spawn_tail`.
pub fn await_tail(promise: Local, value: Local) -> JsResult<Local> {
  let value = Val::from_local(value)?;
  let promise = Val::from_local(promise)?;
  spawn_tail(async move { Ok(Tail::Await(promise.get(), value)) })
}

/// A function `g` such that `g(...args)` returns `f(g, ...args)` (`f` is called with
/// `this === undefined`): retained / re-entrant / recursive use of an engine closure. `g.calls()`
/// is not exposed; the body counts its calls in `counter.n`.
pub fn closure_probe(f: Local, counter: Local) -> JsResult<Local> {
  let f = Val::from_local(f)?;
  let counter = Val::from_local(counter)?;
  let calls = Rc::new(Cell::new(0u32));
  let self_ref: Rc<std::cell::RefCell<Option<Val>>> = Rc::new(std::cell::RefCell::new(None));
  let inner = self_ref.clone();
  let g = js::closure("probe", move |_this, args| {
    calls.set(calls.get() + 1);
    host::set(counter.get(), js::key("n"), js::number(f64::from(calls.get())))?;
    let me = inner.borrow().as_ref().map(Val::get).unwrap_or_else(js::undefined);
    let mut all = vec![me];
    all.extend_from_slice(args);
    js::call(f.get(), js::undefined(), &all)
  })?;
  // weak in spirit: the cycle g -> body -> g is only a test fixture
  *self_ref.borrow_mut() = Some(Val::from_local(g)?);
  Ok(g)
}

/// An [`js::arrow`] of `arity` that returns its arguments as an array.
pub fn arrow_probe(arity: u32) -> JsResult<Local> {
  js::arrow(arity as usize, |args| js::array_literal(args))
}

/// Nested engine tasks `depth` deep (each level a `spawn` polled synchronously, like nested async
/// field/query functions without awaits); the innermost calls `leaf()`. Returns the task promise.
pub fn nest(depth: u32, leaf: Local) -> JsResult<Local> {
  let leaf = Val::from_local(leaf)?;
  nest_level(depth, leaf)
}

fn nest_level(depth: u32, leaf: Val) -> JsResult<Local> {
  spawn(async move {
    if depth == 0 {
      return Val::from_local(js::call(leaf.get(), js::undefined(), &[])?);
    }
    let inner = nest_level(depth - 1, leaf)?;
    Val::from_local(inner)
  })
}

/// [`nest`] through [`crate::executor::call`] (the stackless nested async call).
pub fn nest_call(depth: u32, leaf: Local) -> JsResult<Local> {
  let leaf = Val::from_local(leaf)?;
  spawn(nest_call_level(depth, leaf))
}

fn nest_call_level(depth: u32, leaf: Val) -> std::pin::Pin<Box<dyn std::future::Future<Output = JsResult<Val>>>> {
  Box::pin(async move {
    if depth == 0 {
      return Val::from_local(js::call(leaf.get(), js::undefined(), &[])?);
    }
    let inner = crate::executor::call(nest_call_level(depth - 1, leaf)).await?;
    Val::from_local(inner)
  })
}

thread_local! {
  static LIVE_PROBE_CLOSURES: Cell<i64> = const { Cell::new(0) };
}

struct LiveGuard;

impl Drop for LiveGuard {
  fn drop(&mut self) {
    LIVE_PROBE_CLOSURES.with(|c| c.set(c.get() - 1));
  }
}

/// A closure `(x) => x + 1`-like body whose captured state counts as live until the GC finalizes
/// the function (for the GC-tied lifetime test). See [`live_closures`].
pub fn counted_closure() -> JsResult<Local> {
  LIVE_PROBE_CLOSURES.with(|c| c.set(c.get() + 1));
  let guard = LiveGuard;
  js::closure("counted", move |_this, args| {
    let _keep = &guard;
    Ok(args.first().copied().unwrap_or_else(js::undefined))
  })
}

pub fn live_closures() -> i64 {
  LIVE_PROBE_CLOSURES.with(|c| c.get())
}
