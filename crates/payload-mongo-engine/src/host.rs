//! Host ops (MONGO_ENGINE_CONTRACT.md "Host ops"): every database call of the TS methods is built
//! here and executed by the TS host on the adapter's mongoose models, on the JS thread.
//!
//! A host op is issued when it is created ([`MongoHost::op`] calls into JS right away, like the TS
//! expression `Model.find(...)`), and its future resolves when the host's promise settles. The
//! methods await each op exactly where the TS awaits it; `Promise.all` is [`join_all`].

use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

use payload_engine::error::EngineError;
use payload_engine::js::{JsVal, Obj};

pub type LocalBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Failure of an engine call: an engine error (rebuilt as a Payload error by the glue) or a JS
/// value a host op threw ([`EngineError::thrown`], rethrown as it is).
pub type MongoError = EngineError;

pub type MongoResult<T> = std::result::Result<T, EngineError>;

/// `adapter.collections[slug]` / `adapter.versions[slug]` / `adapter.globals`, resolved by the host
/// when the op runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelRef {
  Collections(String),
  Versions(String),
  Globals,
}

impl ModelRef {
  pub fn to_request(&self) -> JsVal {
    match self {
      ModelRef::Collections(slug) => obj([("kind", JsVal::str("collections")), ("slug", JsVal::str(slug.as_str()))]),
      ModelRef::Versions(slug) => obj([("kind", JsVal::str("versions")), ("slug", JsVal::str(slug.as_str()))]),
      ModelRef::Globals => obj([("kind", JsVal::str("globals"))]),
    }
  }
}

/// `Model[method](...args)` then `chain` applied in order, awaited once; `post: "toObject"` maps
/// the hydrated documents through `doc.toObject()`.
#[derive(Clone, Debug)]
pub struct ModelCall {
  pub model: ModelRef,
  pub method: &'static str,
  pub args: Vec<JsVal>,
  pub chain: Vec<(&'static str, Vec<JsVal>)>,
  pub to_object: bool,
  /// Function-valued options: `args[index][key] = () => Promise.resolve(<call, not awaited>)`
  /// (mongoose-paginate-v2's `useCustomCountFn`). The key is appended to the options object, where
  /// the TS assigns it after the other options.
  pub fn_options: Vec<(usize, &'static str, ModelCall)>,
}

impl ModelCall {
  pub fn new(model: &ModelRef, method: &'static str, args: Vec<JsVal>) -> Self {
    Self { model: model.clone(), method, args, chain: Vec::new(), to_object: false, fn_options: Vec::new() }
  }

  pub fn chain(mut self, method: &'static str, args: Vec<JsVal>) -> Self {
    self.chain.push((method, args));
    self
  }

  pub fn to_object(mut self) -> Self {
    self.to_object = true;
    self
  }

  pub fn fn_option(mut self, index: usize, key: &'static str, call: ModelCall) -> Self {
    self.fn_options.push((index, key, call));
    self
  }

  pub fn to_request(&self) -> JsVal {
    let mut out = Obj::new();
    out.insert("op".into(), JsVal::str("model"));
    out.insert("model".into(), self.model.to_request());
    out.insert("method".into(), JsVal::str(self.method));
    out.insert("args".into(), JsVal::arr(self.args.clone()));
    if !self.chain.is_empty() {
      out.insert(
        "chain".into(),
        JsVal::arr(
          self.chain.iter().map(|(method, args)| JsVal::arr(vec![JsVal::str(*method), JsVal::arr(args.clone())])).collect(),
        ),
      );
    }
    if self.to_object {
      out.insert("post".into(), JsVal::str("toObject"));
    }
    if !self.fn_options.is_empty() {
      out.insert(
        "fnOptions".into(),
        JsVal::arr(
          self
            .fn_options
            .iter()
            .map(|(index, key, call)| {
              obj([("arg", JsVal::Num(*index as f64)), ("key", JsVal::str(*key)), ("call", call.to_request())])
            })
            .collect(),
        ),
      );
    }
    JsVal::obj(out)
  }
}

/// One host op.
#[derive(Clone, Debug)]
pub enum HostOp {
  Model(ModelCall),
  /// `getSession(adapter, req)` on the call's original `req` (only issued when the call has one).
  GetSession,
  /// `{ collectionName, modelName }` of a model, read when the op runs.
  ModelInfo(ModelRef),
  /// `this[method]({ ...args, req })`: an adapter method called through the adapter object (so
  /// user overrides apply), with the call's original `req` added. The keys in `from_call_args`
  /// take the caller's original values (`args[key]` of the call: same objects, so the inner
  /// call's mutations reach the caller, like upstream passing its own `data`).
  AdapterCall { method: &'static str, args: JsVal, from_call_args: &'static [&'static str] },
  /// `payload.logger.error(msg)`
  LogError { msg: String },
}

impl HostOp {
  /// The contract request (a tree, encoded with the bson-aware encoder).
  pub fn to_request(&self) -> JsVal {
    match self {
      HostOp::Model(call) => call.to_request(),
      HostOp::GetSession => obj([("op", JsVal::str("getSession"))]),
      HostOp::ModelInfo(model) => obj([("op", JsVal::str("modelInfo")), ("model", model.to_request())]),
      HostOp::AdapterCall { method, args, from_call_args } => {
        let mut out = Obj::new();
        out.insert("op".into(), JsVal::str("adapterCall"));
        out.insert("method".into(), JsVal::str(*method));
        out.insert("args".into(), args.clone());
        if !from_call_args.is_empty() {
          out.insert("fromCallArgs".into(), JsVal::arr(from_call_args.iter().map(|k| JsVal::str(*k)).collect()));
        }
        JsVal::obj(out)
      }
      HostOp::LogError { msg } => obj([("op", JsVal::str("logError")), ("msg", JsVal::str(msg.as_str()))]),
    }
  }
}

/// The JS side of one engine call.
pub trait MongoHost {
  /// Issues `request` (a [`HostOp::to_request`] tree) now; resolves with the op's result.
  fn op(&self, request: JsVal) -> LocalBoxFuture<'static, MongoResult<JsVal>>;
}

/// Issues a typed host op.
pub fn host_op(host: &dyn MongoHost, op: &HostOp) -> LocalBoxFuture<'static, MongoResult<JsVal>> {
  host.op(op.to_request())
}

/// `await getSession(this, req)`: `undefined` without a `req` (no op), otherwise the host's session
/// handle (or `undefined`).
pub async fn get_session(call: &crate::context::Call<'_>) -> MongoResult<JsVal> {
  if !call.ctx.has_req {
    return Ok(JsVal::Undefined);
  }
  host_op(call.host, &HostOp::GetSession).await
}

/// `await Promise.all(futures)`: resolves with every result in order, or fails with the first
/// failure (in completion order) without waiting for the rest.
pub fn join_all<'a, T: 'a>(
  futures: Vec<LocalBoxFuture<'a, MongoResult<T>>>,
) -> LocalBoxFuture<'a, MongoResult<Vec<T>>> {
  struct JoinAll<'a, T> {
    pending: Vec<Option<LocalBoxFuture<'a, MongoResult<T>>>>,
    results: Vec<Option<T>>,
  }
  impl<T> Unpin for JoinAll<'_, T> {}
  impl<T> Future for JoinAll<'_, T> {
    type Output = MongoResult<Vec<T>>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
      let this = self.get_mut();
      for (slot, result) in this.pending.iter_mut().zip(this.results.iter_mut()) {
        if let Some(future) = slot {
          match future.as_mut().poll(cx) {
            Poll::Ready(Ok(value)) => {
              *result = Some(value);
              *slot = None;
            }
            Poll::Ready(Err(error)) => {
              this.pending.clear();
              return Poll::Ready(Err(error));
            }
            Poll::Pending => {}
          }
        }
      }
      if this.pending.iter().any(Option::is_some) {
        return Poll::Pending;
      }
      Poll::Ready(Ok(this.results.iter_mut().map(|r| r.take().expect("joined result")).collect()))
    }
  }
  let len = futures.len();
  Box::pin(JoinAll { pending: futures.into_iter().map(Some).collect(), results: (0..len).map(|_| None).collect() })
}

/// A host op whose result is settled from outside (the binding's promise reactions, or a replay).
pub struct Settlable {
  slot: Rc<RefCell<SlotState>>,
}

enum SlotState {
  Waiting(Option<Waker>),
  Settled(MongoResult<JsVal>),
  Taken,
}

/// The settling side of a [`Settlable`].
#[derive(Clone)]
pub struct Settler {
  slot: Rc<RefCell<SlotState>>,
}

impl Settlable {
  pub fn new() -> (Settlable, Settler) {
    let slot = Rc::new(RefCell::new(SlotState::Waiting(None)));
    (Settlable { slot: Rc::clone(&slot) }, Settler { slot })
  }

  /// An op that is already settled (still awaited like a promise).
  pub fn settled(result: MongoResult<JsVal>) -> Settlable {
    Settlable { slot: Rc::new(RefCell::new(SlotState::Settled(result))) }
  }
}

impl Settler {
  /// Settles the op (once; later calls are ignored) and wakes its task.
  pub fn settle(&self, result: MongoResult<JsVal>) {
    let previous = std::mem::replace(&mut *self.slot.borrow_mut(), SlotState::Taken);
    match previous {
      SlotState::Waiting(waker) => {
        *self.slot.borrow_mut() = SlotState::Settled(result);
        if let Some(waker) = waker {
          waker.wake();
        }
      }
      other => *self.slot.borrow_mut() = other,
    }
  }
}

impl Future for Settlable {
  type Output = MongoResult<JsVal>;
  fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
    let mut slot = self.slot.borrow_mut();
    match std::mem::replace(&mut *slot, SlotState::Taken) {
      SlotState::Settled(result) => Poll::Ready(result),
      SlotState::Waiting(_) => {
        *slot = SlotState::Waiting(Some(cx.waker().clone()));
        Poll::Pending
      }
      SlotState::Taken => Poll::Ready(Err(EngineError::internal("host op polled after it finished"))),
    }
  }
}

/// A waker that does nothing: the binding re-polls a call's task whenever one of its ops settles.
pub fn noop_waker() -> Waker {
  const VTABLE: RawWakerVTable = RawWakerVTable::new(|_| RawWaker::new(std::ptr::null(), &VTABLE), |_| {}, |_| {}, |_| {});
  // SAFETY: every vtable function ignores the (null) data pointer.
  unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
}

/// Polls `future` once with a no-op waker.
pub fn poll_once<T>(future: &mut LocalBoxFuture<'_, T>) -> Poll<T> {
  let waker = noop_waker();
  let mut cx = Context::from_waker(&waker);
  future.as_mut().poll(&mut cx)
}

/// Runs a future whose host ops settle synchronously (replays, tests): polls until it finishes,
/// `None` if it is still waiting for an op nobody settles.
pub fn run_to_completion<T>(mut future: LocalBoxFuture<'_, T>) -> Option<T> {
  for _ in 0..64 {
    if let Poll::Ready(value) = poll_once(&mut future) {
      return Some(value);
    }
  }
  None
}

pub(crate) fn obj<const N: usize>(entries: [(&str, JsVal); N]) -> JsVal {
  JsVal::obj(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}
