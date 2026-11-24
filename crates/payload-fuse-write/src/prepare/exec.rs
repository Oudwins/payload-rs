//! A model of V8's microtask queue for the write-side traversals, so their observable effects
//! (property insertion order, the order of validation errors, the order the row ids are taken)
//! happen in upstream's order. Upstream runs one `async` function per field and
//! `Promise.all`s them; which field writes first depends on how many ticks each one awaits.
//!
//! Semantics reproduced (ECMAScript, V8 since the await optimization):
//! - calling an async function runs its body synchronously up to the first `await` ([`Exec::spawn`]
//!   polls the new task at once) and returns its promise, fulfilled when the body returns;
//! - `await v` of a non-promise or of a native promise resumes one job after `v` is fulfilled
//!   ([`tick`], [`Promise::wait`]);
//! - `Promise.all(promises)` registers a reaction on each element at the call, fulfils one job
//!   after the last element is fulfilled ([`Exec::all`]); `Promise.all([])` is fulfilled at once.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

type Task<'a> = Pin<Box<dyn Future<Output = ()> + 'a>>;

#[derive(Default)]
struct Queue(Mutex<VecDeque<usize>>);

impl Queue {
  fn push(&self, id: usize) {
    self.0.lock().unwrap_or_else(|e| e.into_inner()).push_back(id);
  }

  fn pop(&self) -> Option<usize> {
    self.0.lock().unwrap_or_else(|e| e.into_inner()).pop_front()
  }
}

struct TaskWaker {
  queue: Arc<Queue>,
  id: usize,
}

impl Wake for TaskWaker {
  fn wake(self: Arc<Self>) {
    self.queue.push(self.id);
  }

  fn wake_by_ref(self: &Arc<Self>) {
    self.queue.push(self.id);
  }
}

pub struct Exec<'a> {
  queue: Arc<Queue>,
  tasks: RefCell<Vec<Option<Task<'a>>>>,
}

pub struct Promise<T> {
  state: Rc<RefCell<PromiseState<T>>>,
}

impl<T> Clone for Promise<T> {
  fn clone(&self) -> Self {
    Promise { state: self.state.clone() }
  }
}

struct PromiseState<T> {
  value: Option<T>,
  waiters: Vec<Waker>,
}

impl<T: Clone> Promise<T> {
  fn new() -> Self {
    Promise { state: Rc::new(RefCell::new(PromiseState { value: None, waiters: Vec::new() })) }
  }

  fn fulfill(&self, value: T) {
    let waiters = {
      let mut state = self.state.borrow_mut();
      state.value = Some(value);
      std::mem::take(&mut state.waiters)
    };
    for waiter in waiters {
      waiter.wake();
    }
  }

  /// `await promise`.
  pub fn wait(&self) -> Wait<T> {
    Wait { promise: self.clone(), registered: false }
  }
}

pub struct Wait<T> {
  promise: Promise<T>,
  registered: bool,
}

impl<T: Clone> Future for Wait<T> {
  type Output = T;

  fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
    if self.registered {
      // resumed by the reaction job: the promise is fulfilled
      if let Some(value) = self.promise.state.borrow().value.clone() {
        return Poll::Ready(value);
      }
      return Poll::Pending;
    }
    self.registered = true;
    let mut state = self.promise.state.borrow_mut();
    if state.value.is_some() {
      cx.waker().wake_by_ref();
    } else {
      state.waiters.push(cx.waker().clone());
    }
    Poll::Pending
  }
}

/// `await <non-promise>`: one job.
pub fn tick() -> Tick {
  Tick { yielded: false }
}

pub struct Tick {
  yielded: bool,
}

impl Future for Tick {
  type Output = ();

  fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
    if self.yielded {
      return Poll::Ready(());
    }
    self.yielded = true;
    cx.waker().wake_by_ref();
    Poll::Pending
  }
}

/// `await` `n` times a non-promise (or `n` jobs of promise resolution machinery).
pub async fn ticks(n: usize) {
  for _ in 0..n {
    tick().await;
  }
}

impl<'a> Exec<'a> {
  pub fn new() -> Rc<Self> {
    Rc::new(Exec { queue: Arc::new(Queue::default()), tasks: RefCell::new(Vec::new()) })
  }

  /// Calls an async function: runs it up to its first await now, returns its promise.
  pub fn spawn<T: Clone + 'a>(&self, body: impl Future<Output = T> + 'a) -> Promise<T> {
    let promise = Promise::new();
    let settle = promise.clone();
    let task: Task<'a> = Box::pin(async move {
      let value = body.await;
      settle.fulfill(value);
    });
    let id = {
      let mut tasks = self.tasks.borrow_mut();
      tasks.push(Some(task));
      tasks.len() - 1
    };
    self.poll(id);
    promise
  }

  /// `Promise.all(promises)` (the values are not needed by the traversals).
  pub fn all(&self, promises: Vec<Promise<()>>) -> Promise<()> {
    let all = Promise::new();
    if promises.is_empty() {
      all.fulfill(());
      return all;
    }
    let remaining = Rc::new(RefCell::new(promises.len()));
    for promise in promises {
      let remaining = remaining.clone();
      let all = all.clone();
      // the element reaction: one job after the element is fulfilled
      self.spawn(async move {
        promise.wait().await;
        let left = {
          let mut left = remaining.borrow_mut();
          *left -= 1;
          *left
        };
        if left == 0 {
          all.fulfill(());
        }
      });
    }
    all
  }

  fn poll(&self, id: usize) {
    let Some(mut task) = self.tasks.borrow_mut().get_mut(id).and_then(Option::take) else {
      return;
    };
    let waker = Waker::from(Arc::new(TaskWaker { queue: self.queue.clone(), id }));
    let mut cx = Context::from_waker(&waker);
    if task.as_mut().poll(&mut cx).is_pending() {
      self.tasks.borrow_mut()[id] = Some(task);
    }
  }

  /// Runs jobs until the queue is empty.
  pub fn run(&self) {
    while let Some(id) = self.queue.pop() {
      self.poll(id);
    }
  }

  /// Drops every unfinished task (they may hold the executor: breaks the cycle).
  pub fn clear(&self) {
    let tasks = std::mem::take(&mut *self.tasks.borrow_mut());
    drop(tasks);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn await_order_follows_ticks() {
    let exec = Exec::new();
    let log = Rc::new(RefCell::new(Vec::new()));
    let e = exec.clone();
    let l = log.clone();
    exec.spawn(async move {
      let a = {
        let l = l.clone();
        e.spawn(async move {
          ticks(2).await;
          l.borrow_mut().push("a");
        })
      };
      let b = {
        let l = l.clone();
        e.spawn(async move {
          tick().await;
          l.borrow_mut().push("b");
        })
      };
      e.all(vec![a, b]).wait().await;
      l.borrow_mut().push("all");
    });
    exec.run();
    exec.clear();
    assert_eq!(*log.borrow(), vec!["b", "a", "all"]);
  }
}
