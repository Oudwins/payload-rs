//! The write methods as real JS async functions (review items 10 / 11).
//!
//! Each binding method is a JS `async function <name>(args)` compiled once per env
//! ([`wrapper_source`]); its body drives the Rust method body:
//!
//! ```js
//! async function create(args) {
//!   let value = start(0, this, args)               // Rust body, up to its first await (or its end)
//!   for (let t = task(); t !== -1; t = task()) {    // -1: the body returned `value`
//!     let ok = true
//!     try { value = await value } catch (error) { ok = false; value = error }
//!     value = resume(t, ok, value)                  // Rust body, up to its next await (or its end)
//!   }
//!   return value
//! }
//! ```
//!
//! So every upstream `await x` of a write method is a native `await x` of an async function (same
//! PromiseResolve / PerformPromiseThen, constructor reads and ticks), the body's synchronous throw
//! rejects the promise like upstream's, `return v` resolves it like upstream's (a returned promise is
//! adopted, as in upsert), and the installed method is an AsyncFunction: not a constructor, no own
//! `prototype`, own `length` 1 / `name`, `[[Prototype]]` %AsyncFunction.prototype%.
//!
//! Residual differences from upstream's async functions (review items 10 / 11), all of them about
//! source text and stack frames, none about values, order or timing:
//! - `Function.prototype.toString` returns the wrapper's source (`async function create(args)
//!   { let value = start(0, this, args) ... }`), not db-mongodb's compiled source;
//! - stack traces / `Error.prepareStackTrace` call sites: the wrapper frame has no script origin
//!   (`<anonymous>`), the native `start` / `resume` calls add no JS frame, and the one-expression JS
//!   helpers (crates/payload-mongo-live-write/src/helpers.js: destructuring, `Model.x(...)` call
//!   sites, literals) add a frame named after the helper between the wrapper and the callee
//!   (upstream: the callee is called directly from `create (create.ts:58)`); V8 messages that do
//!   not name frames (destructuring, `x is not a function`, non-iterable) are identical;
//! - async stack traces show `at async create (<anonymous>)` where upstream shows the source file.
//!
//! Inside a body, [`wait`] is the `await` (it hands the value to the wrapper and returns what the
//! wrapper's `await` produced). Bodies must not use `payload_core_runtime::executor::await_js`
//! directly (that would await on the core executor, not in the wrapper); nested async functions they
//! call (getSession, buildQuery, ...) are separate tasks returning promises, awaited with [`wait`].

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

use payload_core_runtime::js::{self, JsResult, Local, Thrown, Val};

/// A method body: the future of the Rust port of one upstream async function body.
pub type Body = Pin<Box<dyn Future<Output = JsResult<Val>>>>;

struct Task {
  future: RefCell<Option<Body>>,
  /// The value the body is awaiting (set by [`Wait`] on its first poll).
  awaiting: RefCell<Option<Val>>,
  /// The outcome of the wrapper's `await` (set by [`resume`] before the poll).
  delivered: RefCell<Option<JsResult<Val>>>,
}

thread_local! {
  /// Tasks being polled (innermost last): a body can call another write method synchronously
  /// (upsert's `this.updateOne(...)`), whose wrapper starts a nested task.
  static CURRENT: RefCell<Vec<Rc<Task>>> = const { RefCell::new(Vec::new()) };
  static SUSPENDED: RefCell<Slab> = const { RefCell::new(Slab { items: Vec::new(), free: Vec::new() }) };
  /// What the last `start` / `resume` left: the suspended task's token, or -1 (the body ended).
  static LAST: Cell<i64> = const { Cell::new(-1) };
}

struct Slab {
  items: Vec<Option<Rc<Task>>>,
  free: Vec<u32>,
}

/// `start(index, this, args)`: runs the body until its first await; returns the awaited value
/// (`task()` is then its token) or the return value (`task()` is -1). A throw of the body is thrown.
pub fn start(body: Body) -> JsResult<Local> {
  let task = Rc::new(Task { future: RefCell::new(Some(body)), awaiting: RefCell::new(None), delivered: RefCell::new(None) });
  step(task, None)
}

/// `resume(token, ok, value)`: delivers the wrapper's `await` outcome and runs the body until its
/// next await or its end (same results as [`start`]).
pub fn resume(token: u32, ok: bool, value: Local) -> JsResult<Local> {
  let task = SUSPENDED.with(|s| {
    let mut s = s.borrow_mut();
    let task = s.items.get_mut(token as usize).and_then(Option::take);
    if task.is_some() {
      s.free.push(token);
    }
    task
  });
  let Some(task) = task else {
    LAST.with(|l| l.set(-1));
    return Err(js::engine_error("mongo live write: unknown task token"));
  };
  let delivered = match Val::from_local(value) {
    Ok(v) if ok => Ok(v),
    Ok(v) => Err(Thrown(v)),
    Err(e) => Err(e),
  };
  step(task, Some(delivered))
}

/// `task()`: see [`start`].
pub fn last() -> i64 {
  LAST.with(Cell::get)
}

fn step(task: Rc<Task>, delivered: Option<JsResult<Val>>) -> JsResult<Local> {
  *task.delivered.borrow_mut() = delivered;
  let waker = noop_waker();
  let mut cx = Context::from_waker(&waker);
  CURRENT.with(|c| c.borrow_mut().push(task.clone()));
  let poll = {
    let mut slot = task.future.borrow_mut();
    match slot.as_mut() {
      Some(future) => future.as_mut().poll(&mut cx),
      None => Poll::Ready(Err(js::engine_error("mongo live write: task polled after completion"))),
    }
  };
  CURRENT.with(|c| c.borrow_mut().pop());
  match poll {
    Poll::Ready(result) => {
      task.future.borrow_mut().take();
      LAST.with(|l| l.set(-1));
      result.map(|v| v.get())
    }
    Poll::Pending => {
      let Some(awaiting) = task.awaiting.borrow_mut().take() else {
        task.future.borrow_mut().take();
        LAST.with(|l| l.set(-1));
        return Err(js::engine_error("mongo live write: a method body suspended outside `wait`"));
      };
      let token = SUSPENDED.with(|s| {
        let mut s = s.borrow_mut();
        match s.free.pop() {
          Some(i) => {
            s.items[i as usize] = Some(task.clone());
            i
          }
          None => {
            s.items.push(Some(task.clone()));
            (s.items.len() - 1) as u32
          }
        }
      });
      LAST.with(|l| l.set(i64::from(token)));
      Ok(awaiting.get())
    }
  }
}

/// `await value` inside a method body (must be awaited right away, in the segment that created
/// `value`).
pub fn wait(value: Local) -> Wait {
  Wait { state: WaitState::Start(value) }
}

pub struct Wait {
  state: WaitState,
}

enum WaitState {
  Start(Local),
  Waiting,
  Done,
}

impl Future for Wait {
  type Output = JsResult<Val>;

  fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<JsResult<Val>> {
    let Some(task) = CURRENT.with(|c| c.borrow().last().cloned()) else {
      return Poll::Ready(Err(js::engine_error("mongo live write: await outside of a method body")));
    };
    match std::mem::replace(&mut self.state, WaitState::Done) {
      WaitState::Start(value) => match Val::from_local(value) {
        Ok(v) => {
          *task.awaiting.borrow_mut() = Some(v);
          self.state = WaitState::Waiting;
          Poll::Pending
        }
        Err(e) => Poll::Ready(Err(e)),
      },
      WaitState::Waiting => match task.delivered.borrow_mut().take() {
        Some(result) => Poll::Ready(result),
        None => {
          self.state = WaitState::Waiting;
          Poll::Pending
        }
      },
      WaitState::Done => Poll::Ready(Err(js::engine_error("mongo live write: await polled after completion"))),
    }
  }
}

/// The JS source of the wrapper factory: `(start, resume, task) => ({ create: async function
/// create(args) {...}, ... })`, one wrapper per `(property, function name)`, the index being the
/// position in `methods`.
pub fn wrapper_source(methods: &[(&str, &str)]) -> String {
  let mut source = String::from("(function (start, resume, task) {\n  'use strict'\n  return {\n");
  for (index, (property, name)) in methods.iter().enumerate() {
    source.push_str(&format!(
      "    {property}: async function {name}(args) {{\n      let value = start({index}, this, args)\n      for (let t = task(); t !== -1; t = task()) {{\n        let ok = true\n        try {{\n          value = await value\n        }} catch (error) {{\n          ok = false\n          value = error\n        }}\n        value = resume(t, ok, value)\n      }}\n      return value\n    }},\n"
    ));
  }
  source.push_str("  }\n})");
  source
}

fn noop_waker() -> Waker {
  const VTABLE: RawWakerVTable =
    RawWakerVTable::new(|_| RawWaker::new(std::ptr::null(), &VTABLE), |_| {}, |_| {}, |_| {});
  unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
}
