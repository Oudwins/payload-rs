//! A single-threaded emulation of V8's promise job queue, so Rust `async`
//! code interleaves exactly like the TS `async` functions it ports:
//!
//! - [`Rt::spawn`] is calling an `async` function: the body runs
//!   synchronously until its first await, and the returned [`Promise`]
//!   settles when the body returns/throws.
//! - [`Rt::await_promise`] is `await p` on a native promise: the
//!   continuation runs in the reaction job queued when `p` settles.
//! - [`Rt::all`] is `Promise.all` (one reaction job per element, the result
//!   settles inside the job of the last element / first rejection).
//!
//! Host operations (access functions, permissions) return a [`Promise`] that
//! the host settles with [`Rt::settle`], synchronously or later (from a job it
//! queued with [`Rt::queue_job`], or from [`crate::host::Host::on_idle`] when
//! the queue is empty, which models promises waiting on I/O).
//!
//! This mirrors `payload-core-runtime::executor` (which drives real JS
//! microtasks through napi) with the same spawn/await/all shape.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use payload_sql_read::Val;

use crate::js::{JsError, JsResult};

pub type Outcome = JsResult<Val>;
type Reaction = Box<dyn FnOnce(Outcome)>;
type Job = Box<dyn FnOnce()>;

enum PState {
  Pending(Vec<Reaction>),
  Settled(Outcome),
}

struct PromiseInner {
  state: RefCell<PState>,
  handled: Cell<bool>,
}

/// A native JS promise.
#[derive(Clone)]
pub struct Promise(Rc<PromiseInner>);

impl Promise {
  fn new() -> Self {
    Promise(Rc::new(PromiseInner { state: RefCell::new(PState::Pending(Vec::new())), handled: Cell::new(false) }))
  }

  pub fn outcome(&self) -> Option<Outcome> {
    match &*self.0.state.borrow() {
      PState::Settled(o) => Some(o.clone()),
      PState::Pending(_) => None,
    }
  }
}

struct RtInner {
  jobs: RefCell<VecDeque<Job>>,
  rejected: RefCell<Vec<Promise>>,
  jobs_run: Cell<u64>,
}

/// The job queue. Cheap to clone (shared).
#[derive(Clone)]
pub struct Rt(Rc<RtInner>);

impl Default for Rt {
  fn default() -> Self {
    Self::new()
  }
}

struct Task {
  future: RefCell<Option<Pin<Box<dyn Future<Output = Outcome>>>>>,
  promise: Promise,
  rt: Rt,
}

thread_local! {
  static CURRENT: RefCell<Vec<Rc<Task>>> = const { RefCell::new(Vec::new()) };
}

fn poll_task(task: &Rc<Task>) {
  let mut cx = Context::from_waker(Waker::noop());
  CURRENT.with(|c| c.borrow_mut().push(task.clone()));
  let result = {
    let mut slot = task.future.borrow_mut();
    match slot.as_mut() {
      Some(f) => f.as_mut().poll(&mut cx),
      None => Poll::Pending,
    }
  };
  CURRENT.with(|c| c.borrow_mut().pop());
  if let Poll::Ready(outcome) = result {
    let fut = task.future.borrow_mut().take();
    drop(fut);
    task.rt.settle(&task.promise, outcome);
  }
}

impl Rt {
  pub fn new() -> Self {
    Rt(Rc::new(RtInner { jobs: RefCell::new(VecDeque::new()), rejected: RefCell::new(Vec::new()), jobs_run: Cell::new(0) }))
  }

  /// A pending promise for the host to settle.
  pub fn pending(&self) -> Promise {
    Promise::new()
  }

  /// `Promise.resolve(value)` / an already settled promise.
  pub fn settled(&self, outcome: Outcome) -> Promise {
    let p = Promise::new();
    self.settle(&p, outcome);
    p
  }

  pub fn queue_job(&self, job: impl FnOnce() + 'static) {
    self.0.jobs.borrow_mut().push_back(Box::new(job));
  }

  /// Resolves/rejects `p` (no-op when already settled), queueing its reactions.
  pub fn settle(&self, p: &Promise, outcome: Outcome) {
    let reactions = {
      let mut state = p.0.state.borrow_mut();
      if matches!(*state, PState::Settled(_)) {
        return;
      }
      match std::mem::replace(&mut *state, PState::Settled(outcome.clone())) {
        PState::Pending(r) => r,
        PState::Settled(_) => Vec::new(),
      }
    };
    if outcome.is_err() && !p.0.handled.get() {
      self.0.rejected.borrow_mut().push(p.clone());
    }
    for reaction in reactions {
      let o = outcome.clone();
      self.queue_job(move || reaction(o));
    }
  }

  /// `p.then(f, f)`: `f` runs in a reaction job.
  pub fn then(&self, p: &Promise, f: impl FnOnce(Outcome) + 'static) {
    p.0.handled.set(true);
    let mut state = p.0.state.borrow_mut();
    match &mut *state {
      PState::Pending(reactions) => reactions.push(Box::new(f)),
      PState::Settled(o) => {
        let o = o.clone();
        drop(state);
        self.queue_job(move || f(o));
      }
    }
  }

  /// Calls an `async` function whose body is `future`.
  pub fn spawn(&self, future: impl Future<Output = Outcome> + 'static) -> Promise {
    let task = Rc::new(Task { future: RefCell::new(Some(Box::pin(future))), promise: Promise::new(), rt: self.clone() });
    poll_task(&task);
    task.promise.clone()
  }

  /// `await p`
  pub fn await_promise(&self, p: &Promise) -> Await {
    Await { rt: self.clone(), promise: p.clone(), slot: None }
  }

  /// `Promise.all(promises)` (resolves with an array of the values).
  pub fn all(&self, promises: &[Promise]) -> Promise {
    let result = Promise::new();
    let values = Rc::new(RefCell::new(vec![Val::Undefined; promises.len()]));
    let remaining = Rc::new(Cell::new(1usize));
    for (i, p) in promises.iter().enumerate() {
      remaining.set(remaining.get() + 1);
      let (rt, result, values, remaining) = (self.clone(), result.clone(), values.clone(), remaining.clone());
      self.then(p, move |o| match o {
        Ok(v) => {
          values.borrow_mut()[i] = v;
          remaining.set(remaining.get() - 1);
          if remaining.get() == 0 {
            let arr = Val::new_arr(values.borrow().clone());
            rt.settle(&result, Ok(arr));
          }
        }
        Err(e) => rt.settle(&result, Err(e)),
      });
    }
    remaining.set(remaining.get() - 1);
    if remaining.get() == 0 {
      self.settle(&result, Ok(Val::new_arr(values.borrow().clone())));
    }
    result
  }

  /// Runs one queued job; false when the queue is empty.
  pub fn run_one(&self) -> bool {
    let job = self.0.jobs.borrow_mut().pop_front();
    match job {
      Some(job) => {
        self.0.jobs_run.set(self.0.jobs_run.get() + 1);
        job();
        true
      }
      None => false,
    }
  }

  /// Drains the queue; when empty, lets `on_idle` settle externally completed
  /// work (returning false when nothing is left).
  pub fn run(&self, mut on_idle: impl FnMut(&Rt) -> bool) {
    loop {
      while self.run_one() {}
      if !on_idle(self) {
        break;
      }
    }
  }

  pub fn jobs_run(&self) -> u64 {
    self.0.jobs_run.get()
  }

  /// Rejections nobody handled (what Node reports as `unhandledRejection`).
  pub fn unhandled_rejections(&self) -> Vec<JsError> {
    self
      .0
      .rejected
      .borrow()
      .iter()
      .filter(|p| !p.0.handled.get())
      .filter_map(|p| p.outcome().and_then(|o| o.err()))
      .collect()
  }
}

/// The `await` operator (see [`Rt::await_promise`]).
pub struct Await {
  rt: Rt,
  promise: Promise,
  slot: Option<Rc<RefCell<Option<Outcome>>>>,
}

impl Future for Await {
  type Output = Outcome;

  fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Outcome> {
    if let Some(slot) = &self.slot {
      return match slot.borrow_mut().take() {
        Some(o) => Poll::Ready(o),
        None => Poll::Pending,
      };
    }
    let Some(task) = CURRENT.with(|c| c.borrow().last().cloned()) else {
      return Poll::Ready(Err(JsError::Engine(payload_engine::error::EngineError::internal(
        "await outside of a task",
      ))));
    };
    let slot = Rc::new(RefCell::new(None));
    let s2 = slot.clone();
    let promise = self.promise.clone();
    self.rt.then(&promise, move |o| {
      *s2.borrow_mut() = Some(o);
      poll_task(&task);
    });
    self.slot = Some(slot);
    Poll::Pending
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Mirrors:
  /// ```js
  /// const log = []
  /// const a = async () => { log.push('a1'); await null; log.push('a2'); await null; log.push('a3') }
  /// const b = async () => { log.push('b1'); await null; log.push('b2') }
  /// await Promise.all([a(), b()]); log.push('done')
  /// // a1 b1 a2 b2 a3 done
  /// ```
  #[test]
  fn interleaves_like_v8() {
    let rt = Rt::new();
    let log = Rc::new(RefCell::new(Vec::<&str>::new()));
    let resolved = |rt: &Rt| rt.settled(Ok(Val::Null));
    let (r, l) = (rt.clone(), log.clone());
    let a = rt.spawn(async move {
      l.borrow_mut().push("a1");
      r.await_promise(&resolved(&r)).await?;
      l.borrow_mut().push("a2");
      r.await_promise(&resolved(&r)).await?;
      l.borrow_mut().push("a3");
      Ok(Val::Undefined)
    });
    let (r, l) = (rt.clone(), log.clone());
    let b = rt.spawn(async move {
      l.borrow_mut().push("b1");
      r.await_promise(&resolved(&r)).await?;
      l.borrow_mut().push("b2");
      Ok(Val::Undefined)
    });
    let (r, l) = (rt.clone(), log.clone());
    rt.spawn(async move {
      r.await_promise(&r.all(&[a, b])).await?;
      l.borrow_mut().push("done");
      Ok(Val::Undefined)
    });
    rt.run(|_| false);
    assert_eq!(*log.borrow(), vec!["a1", "b1", "a2", "b2", "a3", "done"]);
  }
}
