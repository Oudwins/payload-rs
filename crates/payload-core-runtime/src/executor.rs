//! Single-threaded executor that runs Rust `async` code with JS async-function semantics.
//!
//! - [`spawn`] is "calling an async function": the future is polled synchronously until its first
//!   await, and a native JS promise for its completion is returned (resolved/rejected through a
//!   napi deferred exactly when the body returns/throws).
//! - [`await_js`] is the JS `await` operator: it calls a compiled JS async function whose only
//!   step is `await value` (V8's own Await: PromiseResolve + PerformPromiseThen, no species), and
//!   whose continuation resumes the task. The task is re-polled synchronously inside that reaction
//!   job, where an `await` continuation would run.
//!
//! As long as the Rust code awaits exactly where the TS code awaits (and composes concurrency
//! through JS `Promise.all` over spawned task promises), the interleaving of user callbacks is
//! identical to upstream, tick for tick.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

use napi::sys;

use crate::js::{self, JsResult, Local, Persist, Thrown, Val};

pub type TaskFuture = Pin<Box<dyn Future<Output = JsResult<Val>>>>;

struct Task {
  future: RefCell<Option<TaskFuture>>,
  /// Null while a [`spawn_tail`] task runs its first (synchronous) poll: its promise is only
  /// created if it suspends or does not end in a tail await.
  deferred: Cell<sys::napi_deferred>,
  /// Set when a resume arrives while the task is being polled; the running poll then polls again
  /// instead of dropping the wake-up.
  repoll: Cell<bool>,
  /// The tail await a [`spawn_tail`] body reached in its first poll: `(promise, value)`.
  tail: RefCell<Option<(Local, Val)>>,
}

/// How a [`spawn_tail`] task body ends.
pub enum Tail {
  /// `return value`
  Return(Val),
  /// `await promise; return value` as the body's last two steps, where `promise` is a native
  /// promise (`Promise.all(...)`, an engine task promise). Must be used right away (it holds a
  /// `Local`): return it from the body.
  Await(Local, Val),
}

struct AwaitSlot {
  task: Rc<Task>,
  result: RefCell<Option<JsResult<Val>>>,
}

thread_local! {
  static CURRENT: RefCell<Vec<Rc<Task>>> = const { RefCell::new(Vec::new()) };
  static WAITING: RefCell<Slab> = const { RefCell::new(Slab { items: Vec::new(), free: Vec::new() }) };
  static AWAIT_HELPER: RefCell<Option<Persist>> = const { RefCell::new(None) };
  static THEN_RETURN: RefCell<Option<Persist>> = const { RefCell::new(None) };
  static STATS: Cell<(u64, u64)> = const { Cell::new((0, 0)) };
  /// The callee of the [`call`] the task being polled just made (taken by its driver), with its
  /// virtual frame size.
  static NESTED_CALL: RefCell<Option<(Rc<Task>, usize)>> = const { RefCell::new(None) };
  /// Bytes of the TS frames that nested [`call`]s stand for and that are not on the native stack
  /// (the callers suspended by drivers on this thread).
  static VIRTUAL_STACK: Cell<usize> = const { Cell::new(0) };
  /// Lowest native stack address a JS -> native call reached before V8's RangeError (measured once
  /// per thread by [`install_native_await`]); 0 = unknown (no emulated limit).
  static STACK_LIMIT: Cell<usize> = const { Cell::new(0) };
}

struct Slab {
  items: Vec<Option<Rc<AwaitSlot>>>,
  free: Vec<u32>,
}

/// The native-await helpers, compiled in the current env (strict mode, no globals read at call
/// time). `awaitValue(value, token)` IS a JS `await value`: an async function whose only await is
/// `await value`, resuming the Rust task from its continuation. So V8 itself performs Await:
/// PromiseResolve(%Promise%, value) (one `value.constructor` read for a native promise, a
/// NewPromiseResolveThenableJob with one `then` read for thenables and subclass instances) and
/// PerformPromiseThen WITHOUT a result capability (no SpeciesConstructor, no second `constructor`
/// read, no `Symbol.species` read); the continuation runs in the same reaction job as the TS
/// `await` continuation. Its own promise is never exposed (always fulfilled with `undefined`).
/// `thenReturn(promise, value)` is `async (p, v) => { await p; return v }`: exactly the async
/// function tail it stands for (see [`spawn_tail`]).
const AWAIT_HELPERS_SOURCE: &str = "'use strict'; (resume) => [\
  async function awaitValue(value, token) { \
    let result; \
    try { result = await value } catch (error) { resume(token, false, error); return } \
    resume(token, true, result) \
  }, \
  async function thenReturn(promise, value) { await promise; return value }]";

/// Compiles the native-await helpers (see [`AWAIT_HELPERS_SOURCE`]) for `resume` (the binding's
/// `resume` export) and installs them. Returns `[awaitValue, thenReturn]` so the TS glue's own
/// `await f(...)` host helpers can use the same `awaitValue`.
pub fn install_native_await(resume: Local) -> JsResult<Local> {
  if STACK_LIMIT.with(|l| l.get()) == 0 {
    measure_stack_limit()?;
  }
  let factory = js::run_script(AWAIT_HELPERS_SOURCE)?;
  let pair = js::call(factory, js::undefined(), &[resume])?;
  let await_value = Persist::new(js::get_element(pair, 0)?)?;
  let then_return = Persist::new(js::get_element(pair, 1)?)?;
  AWAIT_HELPER.with(|h| *h.borrow_mut() = Some(await_value));
  THEN_RETURN.with(|h| *h.borrow_mut() = Some(then_return));
  Ok(pair)
}

/// The installed `awaitValue(value, token)` helper (for host glue that awaits in JS).
pub fn await_value_helper() -> JsResult<Local> {
  AWAIT_HELPER
    .with(|h| h.borrow().as_ref().map(|p| p.get()))
    .ok_or_else(|| js::engine_error("core runtime not initialized"))
}

/// Number of tasks spawned and JS awaits performed on this thread (for benchmarks/tests).
pub fn stats() -> (u64, u64) {
  STATS.with(|s| s.get())
}

/// Takes back one entry count (for exports that are not engine work, like `stats`).
pub fn uncount_entry() {
  crate::js::uncount_entry();
}

/// Number of Node-API entries into the core engine crates on this thread (counted by
/// [`crate::js::set_env`]: exports of every binding, validator natives, resume callbacks).
pub fn entries() -> u64 {
  crate::js::entries()
}

/// Equivalent of calling a JS `async` function: runs `future` synchronously until its first
/// await and returns the promise of its completion.
pub fn spawn(future: impl Future<Output = JsResult<Val>> + 'static) -> JsResult<Local> {
  STATS.with(|s| {
    let (t, a) = s.get();
    s.set((t + 1, a))
  });
  let (deferred, promise) = js::create_promise()?;
  let task = Rc::new(Task {
    future: RefCell::new(Some(Box::pin(future))),
    deferred: Cell::new(deferred),
    repoll: Cell::new(false),
    tail: RefCell::new(None),
  });
  poll_task(&task);
  Ok(promise)
}

/// [`spawn`] for an async function body that may end with `await promise; return value`
/// ([`Tail::Await`]). When the body gets there in its first, synchronous poll (it never suspended),
/// no task promise, resume or deferred is needed: the call returns
/// `(async (p, v) => { await p; return v })(promise, value)`: the very same async-function tail
/// (V8's Await on `promise`, then `return value` settling a fresh async-function promise in that
/// reaction job; a rejection passes through the same way). Otherwise it is a [`spawn`]ed task
/// whose tail is a real [`await_js`].
pub fn spawn_tail(future: impl Future<Output = JsResult<Tail>> + 'static) -> JsResult<Local> {
  STATS.with(|s| {
    let (t, a) = s.get();
    s.set((t + 1, a))
  });
  let wrapped = async move {
    match future.await? {
      Tail::Return(value) => Ok(value),
      Tail::Await(promise, value) => {
        let first_poll = CURRENT.with(|c| {
          let c = c.borrow();
          match c.last() {
            Some(task) if task.deferred.get().is_null() => {
              *task.tail.borrow_mut() = Some((promise, value.clone()));
              true
            }
            _ => false,
          }
        });
        if first_poll {
          return Ok(Val::Undefined);
        }
        await_js(promise).await?;
        Ok(value)
      }
    }
  };
  let task = Rc::new(Task {
    future: RefCell::new(Some(Box::pin(wrapped))),
    deferred: Cell::new(std::ptr::null_mut()),
    repoll: Cell::new(false),
    tail: RefCell::new(None),
  });
  match poll_ready(&task) {
    Some(Poll::Ready(result)) => {
      if let Some((promise, value)) = task.tail.borrow_mut().take() {
        if cfg!(feature = "mutant-tail-skip-tick") && value.is_undefined() {
          return Ok(promise);
        }
        let helper = THEN_RETURN.with(|h| h.borrow().as_ref().map(|p| p.get()));
        let Some(helper) = helper else {
          return Err(js::engine_error("core runtime not initialized"));
        };
        return js::call_unguarded(helper, js::undefined(), &[promise, value.get()]);
      }
      let (deferred, promise) = js::create_promise()?;
      match result {
        Ok(v) => js::resolve_deferred(deferred, v.get()),
        Err(Thrown(e)) => js::reject_deferred(deferred, e.get()),
      }
      Ok(promise)
    }
    _ => {
      // Suspended: from now on it is an ordinary task, settled through its deferred.
      let (deferred, promise) = js::create_promise()?;
      task.deferred.set(deferred);
      Ok(promise)
    }
  }
}

fn poll_task(task: &Rc<Task>) {
  if let Some(Poll::Ready(result)) = poll_ready(task) {
    settle(task.deferred.get(), result);
  }
}

/// `f(...)` of an async function `f`, evaluated inside an engine task (`let p = call(f(..)).await?`
/// is the TS `const p = f(..)`): the callee's synchronous prefix runs right away, before the caller
/// continues, and the caller gets the callee's promise, exactly like [`spawn`]. But the callee is
/// run by the task's driver loop after the caller's poll has returned, not inside it, so nested
/// async calls (fields in fields, `and` in `and`) use no native stack per level and every depth
/// the TS accepts is accepted. NOT a JS await: no tick passes; the returned promise `Local` is
/// valid for the rest of the current synchronous segment. Await it immediately.
///
/// Stack overflow is emulated: each nesting level counts `frame` bytes (what the TS frames of one
/// level take, at most) against V8's real stack limit, so a nesting deeper than the TS frames
/// would fit throws V8's intrinsic `RangeError: Maximum call stack size exceeded` from the call
/// (rejecting/throwing where the TS overflow would surface), at a depth no shallower than the TS
/// one as long as `frame` does not exceed the TS frame size. [`call`] uses [`MIN_TS_FRAME`].
pub fn call(future: impl Future<Output = JsResult<Val>> + 'static) -> Call {
  call_with_frame(future, MIN_TS_FRAME)
}

/// Smallest native stack a TS async function call level takes in V8 (measured: an
/// `async (n) => f(n - 1)` chain overflows after ~12,400 levels of the ~984 KB stack, ~80 bytes per
/// level; test/__rs/core-runtime/semantics.mjs). Lower bound for every nested async call.
pub const MIN_TS_FRAME: usize = 64;

/// [`call`] with the virtual frame size of one TS nesting level of this construct.
pub fn call_with_frame(future: impl Future<Output = JsResult<Val>> + 'static, frame: usize) -> Call {
  Call { state: CallState::Start(Box::pin(future)), frame }
}

pub struct Call {
  state: CallState,
  frame: usize,
}

/// Whether a nested call of `frame` more virtual bytes would overflow V8's stack.
fn would_overflow(frame: usize) -> bool {
  let limit = STACK_LIMIT.with(|l| l.get());
  if limit == 0 {
    return false;
  }
  let marker = 0u8;
  let sp = std::hint::black_box(&marker) as *const u8 as usize;
  let virtual_bytes = VIRTUAL_STACK.with(|v| v.get()) + frame;
  sp.saturating_sub(virtual_bytes) < limit
}

/// Measures the native stack address where V8 throws its RangeError on this thread (JS recursion
/// through a native probe until V8 refuses), for [`call`]'s emulated limit.
fn measure_stack_limit() -> JsResult<()> {
  unsafe extern "C" fn probe(env: sys::napi_env, _info: sys::napi_callback_info) -> sys::napi_value {
    let _ = env;
    let marker = 0u8;
    let sp = std::hint::black_box(&marker) as *const u8 as usize;
    STACK_LIMIT.with(|l| {
      if l.get() == 0 || sp < l.get() {
        l.set(sp)
      }
    });
    std::ptr::null_mut()
  }
  let recurse = js::run_script(
    "'use strict'; (probe) => { const f = () => { probe(); f() }; try { f() } catch (e) { if (!(e instanceof RangeError)) throw e } }",
  )?;
  let probe_fn = js::create_function("probe", probe, std::ptr::null_mut());
  STACK_LIMIT.with(|l| l.set(0));
  js::call(recurse, js::undefined(), &[probe_fn])?;
  Ok(())
}

enum CallState {
  Start(TaskFuture),
  Called(Local),
  Done,
}

impl Future for Call {
  type Output = JsResult<Local>;

  fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<JsResult<Local>> {
    match std::mem::replace(&mut self.state, CallState::Done) {
      CallState::Start(future) => {
        if CURRENT.with(|c| c.borrow().is_empty()) {
          return Poll::Ready(Err(js::engine_error("call outside of an engine task")));
        }
        if NESTED_CALL.with(|r| r.borrow().is_some()) {
          return Poll::Ready(Err(js::engine_error("two nested calls in one poll")));
        }
        if would_overflow(self.frame) {
          drop(future);
          return Poll::Ready(Err(js::range_error("Maximum call stack size exceeded")));
        }
        STATS.with(|s| {
          let (t, a) = s.get();
          s.set((t + 1, a))
        });
        let (deferred, promise) = match js::create_promise() {
          Ok(created) => created,
          Err(e) => return Poll::Ready(Err(e)),
        };
        let callee = Rc::new(Task {
          future: RefCell::new(Some(future)),
          deferred: Cell::new(deferred),
          repoll: Cell::new(false),
          tail: RefCell::new(None),
        });
        NESTED_CALL.with(|r| *r.borrow_mut() = Some((callee, self.frame)));
        self.state = CallState::Called(promise);
        Poll::Pending
      }
      CallState::Called(promise) => Poll::Ready(Ok(promise)),
      CallState::Done => Poll::Ready(Err(js::engine_error("call polled after completion"))),
    }
  }
}

/// Runs `future` (which must not reach a JS await: e.g. a traversal that only makes nested
/// [`call`]s) to completion now, for synchronous exports, and returns its result.
pub fn run_sync(future: impl Future<Output = JsResult<Val>> + 'static) -> JsResult<Val> {
  let task = Rc::new(Task {
    future: RefCell::new(Some(Box::pin(future))),
    deferred: Cell::new(std::ptr::null_mut()),
    repoll: Cell::new(false),
    tail: RefCell::new(None),
  });
  match poll_ready(&task) {
    Some(Poll::Ready(result)) => result,
    _ => Err(js::engine_error("run_sync: the future suspended at a JS await")),
  }
}

/// Drives `task`: polls it and runs the synchronous prefix of every async call it makes through
/// [`call`] (and their calls, ...) from this loop, with an explicit stack instead of native
/// recursion, so nesting depth costs heap, not native stack. Returns `task`'s poll result: `None`
/// if it is being polled already (the running poll will poll again).
fn poll_ready(task: &Rc<Task>) -> Option<Poll<JsResult<Val>>> {
  /// Callees being driven; dropping it (also on unwind) takes their virtual frames back.
  struct Callees(Vec<(Rc<Task>, usize)>);
  impl Drop for Callees {
    fn drop(&mut self) {
      let frames: usize = self.0.iter().map(|(_, frame)| frame).sum();
      let _ = VIRTUAL_STACK.try_with(|v| v.set(v.get().saturating_sub(frames)));
    }
  }
  let mut callees = Callees(Vec::new());
  let callees = &mut callees.0;
  loop {
    let current = callees.last().map(|(t, _)| t).unwrap_or(task).clone();
    let poll = poll_once(&current);
    if let Some((callee, frame)) = NESTED_CALL.with(|r| r.borrow_mut().take()) {
      // `current` is suspended inside `call(f(...))`: run the callee now, then resume `current`
      VIRTUAL_STACK.with(|v| v.set(v.get() + frame));
      callees.push((callee, frame));
      continue;
    }
    let Some((callee, frame)) = callees.pop() else {
      return poll;
    };
    VIRTUAL_STACK.with(|v| v.set(v.get() - frame));
    // The callee returned or reached its first JS await: settle it (or leave its promise pending)
    // and resume its caller, which gets the promise.
    if let Some(Poll::Ready(result)) = poll {
      settle(callee.deferred.get(), result);
    }
  }
}

fn settle(deferred: sys::napi_deferred, result: JsResult<Val>) {
  match result {
    Ok(v) => js::resolve_deferred(deferred, v.get()),
    Err(Thrown(e)) => js::reject_deferred(deferred, e.get()),
  }
}

/// Polls `task` once (again while resumes arrive during the poll, unless it made a nested
/// [`call`]). `None` if it is being polled already; on completion the future is dropped.
fn poll_once(task: &Rc<Task>) -> Option<Poll<JsResult<Val>>> {
  let waker = noop_waker();
  let mut cx = Context::from_waker(&waker);
  let Ok(mut slot) = task.future.try_borrow_mut() else {
    task.repoll.set(true);
    return None;
  };
  CURRENT.with(|c| c.borrow_mut().push(task.clone()));
  let result = loop {
    task.repoll.set(false);
    let poll = match slot.as_mut() {
      Some(future) => future.as_mut().poll(&mut cx),
      None => Poll::Pending,
    };
    if poll.is_ready() || !task.repoll.get() || NESTED_CALL.with(|r| r.borrow().is_some()) {
      break poll;
    }
  };
  CURRENT.with(|c| c.borrow_mut().pop());
  if result.is_ready() {
    let future = slot.take();
    drop(slot);
    drop(future);
  }
  Some(result)
}

/// JS `await value`. `value` must be a handle created in the current synchronous segment; the
/// returned future must be awaited immediately.
pub fn await_js(value: Local) -> AwaitJs {
  AwaitJs { state: AwaitState::Start(value) }
}

/// `await f(...)` where the call is made by a host helper, saving the separate napi calls for
/// building the args, calling and awaiting. Calls `helper(token, ...args)` right away (so this
/// must be called from inside the running task, where the TS evaluates the call, and the
/// returned future awaited immediately). The helper must make the call and pass its result to
/// the host's `awaitValue(result, token)`; that is the JS `await` (same reaction job). A
/// synchronous throw from the helper (the callee threw) completes the future with that error
/// without awaiting, like a throw inside the awaited call expression.
pub fn await_call(helper: Local, args: &[Local]) -> AwaitJs {
  await_call_returning(helper, args).0
}

/// [`await_call`], also returning what the helper returned (`undefined` if it threw), for
/// helpers that hand back values they created on the way (e.g. arrays to reuse in later calls).
pub fn await_call_returning(helper: Local, args: &[Local]) -> (AwaitJs, Local) {
  STATS.with(|s| {
    let (t, a) = s.get();
    s.set((t, a + 1))
  });
  let failed = |e| (AwaitJs { state: AwaitState::Failed(e) }, js::undefined());
  let Some(task) = CURRENT.with(|c| c.borrow().last().cloned()) else {
    return failed(js::engine_error("await outside of an engine task"));
  };
  const MAX_ARGS: usize = 32;
  if args.len() >= MAX_ARGS {
    return failed(js::engine_error("await_call: too many arguments"));
  }
  let slot = Rc::new(AwaitSlot { task, result: RefCell::new(None) });
  let token = register(slot.clone());
  let mut all = [js::undefined(); MAX_ARGS];
  all[0] = js::number(f64::from(token));
  all[1..=args.len()].copy_from_slice(args);
  match js::call_unguarded(helper, js::undefined(), &all[..=args.len()]) {
    Ok(returned) => (AwaitJs { state: AwaitState::Waiting(slot) }, returned),
    Err(e) => {
      release(token);
      failed(e)
    }
  }
}

fn register(slot: Rc<AwaitSlot>) -> u32 {
  WAITING.with(|w| {
    let mut w = w.borrow_mut();
    match w.free.pop() {
      Some(i) => {
        w.items[i as usize] = Some(slot);
        i
      }
      None => {
        w.items.push(Some(slot));
        (w.items.len() - 1) as u32
      }
    }
  })
}

fn release(token: u32) {
  WAITING.with(|w| {
    let mut w = w.borrow_mut();
    w.items[token as usize] = None;
    w.free.push(token);
  });
}

pub struct AwaitJs {
  state: AwaitState,
}

enum AwaitState {
  Start(Local),
  Waiting(Rc<AwaitSlot>),
  Failed(Thrown),
  Done,
}

impl Future for AwaitJs {
  type Output = JsResult<Val>;

  fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<JsResult<Val>> {
    match std::mem::replace(&mut self.state, AwaitState::Done) {
      AwaitState::Start(value) => {
        STATS.with(|s| {
          let (t, a) = s.get();
          s.set((t, a + 1))
        });
        let Some(task) = CURRENT.with(|c| c.borrow().last().cloned()) else {
          return Poll::Ready(Err(js::engine_error("await outside of an engine task")));
        };
        let slot = Rc::new(AwaitSlot { task, result: RefCell::new(None) });
        let token = register(slot.clone());
        let helper = AWAIT_HELPER.with(|h| h.borrow().as_ref().map(|p| p.get()));
        let Some(helper) = helper else {
          release(token);
          return Poll::Ready(Err(js::engine_error("core runtime not initialized")));
        };
        if let Err(e) = js::call_unguarded(helper, js::undefined(), &[value, js::number(token as f64)]) {
          release(token);
          return Poll::Ready(Err(e));
        }
        self.state = AwaitState::Waiting(slot);
        Poll::Pending
      }
      AwaitState::Waiting(slot) => {
        let result = slot.result.borrow_mut().take();
        match result {
          Some(r) => Poll::Ready(r),
          None => {
            self.state = AwaitState::Waiting(slot);
            Poll::Pending
          }
        }
      }
      AwaitState::Failed(e) => Poll::Ready(Err(e)),
      AwaitState::Done => Poll::Ready(Err(js::engine_error("await polled after completion"))),
    }
  }
}

/// Called (through the binding's `resume` export) from the promise reaction job.
pub fn resume(token: u32, ok: bool, value: Local) -> JsResult<()> {
  let slot = WAITING.with(|w| {
    let mut w = w.borrow_mut();
    let slot = w.items.get_mut(token as usize).and_then(Option::take);
    if slot.is_some() {
      w.free.push(token);
    }
    slot
  });
  let Some(slot) = slot else {
    return Err(js::engine_error("unknown await token"));
  };
  // A conversion failure is delivered to the task as a rejection instead of being lost.
  let result = match Val::from_local(value) {
    Ok(v) if ok => Ok(v),
    Ok(v) => Err(Thrown(v)),
    Err(e) => Err(e),
  };
  *slot.result.borrow_mut() = Some(result);
  poll_task(&slot.task);
  Ok(())
}

fn noop_waker() -> Waker {
  const VTABLE: RawWakerVTable =
    RawWakerVTable::new(|_| RawWaker::new(std::ptr::null(), &VTABLE), |_| {}, |_| {}, |_| {});
  unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
}
