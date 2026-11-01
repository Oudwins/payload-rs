//! Single-threaded executor that runs Rust `async` code with JS async-function semantics.
//!
//! - [`spawn`] is "calling an async function": the future is polled synchronously until its first
//!   await, and a native JS promise for its completion is returned (resolved/rejected through a
//!   napi deferred exactly when the body returns/throws).
//! - [`await_js`] is the JS `await` operator: it performs `PromiseResolve(v).then(resume)` via the
//!   host helper, so the continuation runs in the same microtask an `await` continuation would.
//!   The task is re-polled synchronously inside that reaction job.
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
  deferred: Cell<sys::napi_deferred>,
  /// Set when a resume arrives while the task is being polled; the running poll then polls again
  /// instead of dropping the wake-up.
  repoll: Cell<bool>,
}

struct AwaitSlot {
  task: Rc<Task>,
  result: RefCell<Option<JsResult<Val>>>,
}

thread_local! {
  static CURRENT: RefCell<Vec<Rc<Task>>> = const { RefCell::new(Vec::new()) };
  static WAITING: RefCell<Slab> = const { RefCell::new(Slab { items: Vec::new(), free: Vec::new() }) };
  static AWAIT_HELPER: RefCell<Option<Persist>> = const { RefCell::new(None) };
  static STATS: Cell<(u64, u64)> = const { Cell::new((0, 0)) };
}

struct Slab {
  items: Vec<Option<Rc<AwaitSlot>>>,
  free: Vec<u32>,
}

/// Installs the JS helper `(value, token) => void` that performs
/// `Promise.resolve(value).then(v => resume(token, true, v), e => resume(token, false, e))`.
pub fn install_await_helper(helper: Local) -> JsResult<()> {
  let p = Persist::new(helper)?;
  AWAIT_HELPER.with(|h| *h.borrow_mut() = Some(p));
  Ok(())
}

/// Number of tasks spawned and JS awaits performed on this thread (for benchmarks/tests).
pub fn stats() -> (u64, u64) {
  STATS.with(|s| s.get())
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
  });
  poll_task(&task);
  Ok(promise)
}

fn poll_task(task: &Rc<Task>) {
  let waker = noop_waker();
  let mut cx = Context::from_waker(&waker);
  let Ok(mut slot) = task.future.try_borrow_mut() else {
    task.repoll.set(true);
    return;
  };
  CURRENT.with(|c| c.borrow_mut().push(task.clone()));
  let result = loop {
    task.repoll.set(false);
    let poll = match slot.as_mut() {
      Some(future) => future.as_mut().poll(&mut cx),
      None => Poll::Pending,
    };
    if poll.is_ready() || !task.repoll.get() {
      break poll;
    }
  };
  CURRENT.with(|c| c.borrow_mut().pop());
  if let Poll::Ready(result) = result {
    let future = slot.take();
    drop(slot);
    let deferred = task.deferred.get();
    match result {
      Ok(v) => js::resolve_deferred(deferred, v.get()),
      Err(Thrown(e)) => js::reject_deferred(deferred, e.get()),
    }
    drop(future);
  }
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
  match js::call(helper, js::undefined(), &all[..=args.len()]) {
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
        if let Err(e) = js::call(helper, js::undefined(), &[value, js::number(token as f64)]) {
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
