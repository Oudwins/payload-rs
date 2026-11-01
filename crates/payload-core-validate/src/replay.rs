//! A [`ValidateHost`] + [`Translate`] for running the validators against a JS host that can only
//! answer asynchronously (`filterOptions`, `payloadDataLoader.find` return promises) or from
//! outside the Rust call (`req.t`, `logger.error`, `Date.prototype.toString`).
//!
//! The validators are deterministic functions of their inputs and of the host's answers, so a
//! run is replayed from the start with a journal of the answers so far: answered calls return
//! their recorded reply, and the first unanswered call interrupts the run and is reported as a
//! [`HostRequest`]. The JS side performs it (awaiting where TS awaits), records the reply and
//! runs again. Every JS-observable call therefore happens exactly once, in TS order, with the
//! same synchronous segments between awaits.

use std::cell::{Cell, RefCell};

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};

use crate::host::{FilterOptionsCall, FindArgs, ValidateHost};
use crate::i18n::Translate;
use crate::ValidationResult;

/// The answer to one [`HostRequest`].
#[derive(Clone, Debug)]
pub enum Reply {
  /// The call returned this value (`filterOptions`, `find`).
  Value(JsVal),
  /// The call returned this string (`t`, `Date.prototype.toString`).
  Text(String),
  /// The call returned nothing worth recording (`logger.error`).
  Unit,
  /// The call threw (or its promise rejected). The JS side keeps the thrown value.
  Thrown,
}

/// The kind of `filterOptions` call, with the argument object shapes of [`FilterOptionsCall`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterOptionsKind {
  Blocks,
  Relationship,
  Select,
}

/// An error handed to `logger.error`: a JS exception from the journal, or one the Rust code
/// raised (a `TypeError` where V8 throws one).
#[derive(Clone, Debug)]
pub enum LoggedError {
  Thrown(usize),
  Engine(EngineError),
}

/// What the run needs from JS next.
#[derive(Clone, Debug)]
pub enum HostRequest {
  /// `req.t(key, vars)` (synchronous)
  T { key: String, vars: Option<Obj> },
  /// `String(new Date(ms))` (synchronous)
  DateToString { ms: f64 },
  /// `req.payload.logger.error({ err, msg })` (synchronous)
  LogError { msg: String, err: LoggedError },
  /// `await filterOptions({...})`. `relation_to` is the relationship call's collection.
  FilterOptions { func: u32, kind: FilterOptionsKind, relation_to: JsVal },
  /// `await req.payloadDataLoader.find({ collection, ..., where })`. `where` is
  /// `{ and: [{ id: { in: ids } }] }` plus the option filter when `has_option_filter`.
  Find { collection: JsVal, override_access: JsVal, ids: JsVal, has_option_filter: bool },
  /// `return validateJSONSchema({ jsonSchema, value })` (tail call, never answered)
  JsonSchema,
  /// `return editor.validate(value, options)` (tail call, never answered)
  RichText,
}

/// How a run ended.
#[derive(Debug)]
pub enum Outcome<T> {
  Done(T),
  /// A JS exception from the journal propagated out of the validator (rethrow it as is).
  Thrown(usize),
  /// An error raised by the Rust code (what the TS validator would throw).
  Error(EngineError),
  Request(HostRequest),
}

const INTERRUPT: &str = "ReplayInterrupt";
const THROWN: &str = "ReplayThrown";

/// The journal of one validator run.
#[derive(Default)]
pub struct Replay {
  replies: Vec<Reply>,
  cursor: Cell<usize>,
  pending: RefCell<Option<HostRequest>>,
}

impl Replay {
  pub fn new() -> Self {
    Self::default()
  }

  /// Answers the request of the last run.
  pub fn reply(&mut self, reply: Reply) {
    self.replies.push(reply);
  }

  /// Runs `f` from the start against the journal.
  pub fn run<T>(&self, f: impl FnOnce(&Self) -> Result<T>) -> Outcome<T> {
    self.cursor.set(0);
    self.pending.replace(None);
    let result = f(self);
    if let Some(request) = self.pending.take() {
      return Outcome::Request(request);
    }
    match result {
      Ok(value) => Outcome::Done(value),
      Err(err) => match self.thrown_index(&err) {
        Some(index) => Outcome::Thrown(index),
        None => Outcome::Error(err),
      },
    }
  }

  fn thrown_index(&self, err: &EngineError) -> Option<usize> {
    if err.name != THROWN {
      return None;
    }
    let index = err.data.as_ref()?.as_u64()? as usize;
    matches!(self.replies.get(index), Some(Reply::Thrown)).then_some(index)
  }

  /// The recorded reply of the next call, or an interrupt requesting it.
  fn next(&self, request: impl FnOnce() -> HostRequest) -> Result<Reply> {
    let index = self.cursor.get();
    self.cursor.set(index + 1);
    match self.replies.get(index) {
      Some(Reply::Thrown) => {
        Err(EngineError::new(THROWN, "a JS host call threw").with_data(serde_json::json!(index)))
      }
      Some(reply) => Ok(reply.clone()),
      None => {
        // Only the first unanswered call is requested; later ones can't be reached.
        let mut pending = self.pending.borrow_mut();
        if pending.is_none() {
          *pending = Some(request());
        }
        Err(EngineError::new(INTERRUPT, "waiting for the JS host"))
      }
    }
  }

  fn tail(&self, request: HostRequest) -> Result<ValidationResult> {
    let mut pending = self.pending.borrow_mut();
    if pending.is_none() {
      *pending = Some(request);
    }
    Err(EngineError::new(INTERRUPT, "tail call into the JS host"))
  }
}

fn diverged(what: &str) -> EngineError {
  EngineError::internal(format!("validator replay diverged: expected a {what} reply"))
}

impl Translate for Replay {
  fn t(&self, key: &str, vars: Option<&Obj>) -> Result<String> {
    match self.next(|| HostRequest::T { key: key.to_string(), vars: vars.cloned() })? {
      Reply::Text(text) => Ok(text),
      _ => Err(diverged("t")),
    }
  }
}

impl ValidateHost for Replay {
  fn filter_options(&self, func: u32, call: FilterOptionsCall<'_>) -> Result<JsVal> {
    let (kind, relation_to) = match call {
      FilterOptionsCall::Blocks { .. } => (FilterOptionsKind::Blocks, JsVal::Undefined),
      FilterOptionsCall::Relationship { relation_to, .. } => (FilterOptionsKind::Relationship, relation_to.clone()),
      FilterOptionsCall::Select { .. } => (FilterOptionsKind::Select, JsVal::Undefined),
    };
    match self.next(|| HostRequest::FilterOptions { func, kind, relation_to })? {
      Reply::Value(value) => Ok(value),
      _ => Err(diverged("filterOptions")),
    }
  }

  fn find(&self, args: FindArgs<'_>) -> Result<JsVal> {
    let and = args.where_.get("and").as_arr().unwrap_or(&[]);
    let request = || HostRequest::Find {
      collection: args.collection.clone(),
      override_access: args.override_access.clone(),
      ids: and.first().map(|id| id.get("id").get("in").clone()).unwrap_or_default(),
      has_option_filter: and.len() > 1,
    };
    match self.next(request)? {
      Reply::Value(value) => Ok(value),
      _ => Err(diverged("find")),
    }
  }

  fn log_error(&self, msg: &str, err: &EngineError) -> Result<()> {
    let logged = match self.thrown_index(err) {
      Some(index) => LoggedError::Thrown(index),
      None => LoggedError::Engine(err.clone()),
    };
    match self.next(|| HostRequest::LogError { msg: msg.to_string(), err: logged })? {
      Reply::Unit => Ok(()),
      _ => Err(diverged("logger.error")),
    }
  }

  fn validate_json_schema(&self, _json_schema: &JsVal, _value: &JsVal) -> Result<ValidationResult> {
    self.tail(HostRequest::JsonSchema)
  }

  fn rich_text_validate(&self, _editor: &JsVal, _value: &JsVal, _options: &JsVal) -> Result<ValidationResult> {
    self.tail(HostRequest::RichText)
  }

  fn date_to_string(&self, ms: f64) -> Result<String> {
    match self.next(|| HostRequest::DateToString { ms })? {
      Reply::Text(text) => Ok(text),
      _ => Err(diverged("Date.prototype.toString")),
    }
  }

  fn is_interrupt(&self, err: &EngineError) -> bool {
    err.name == INTERRUPT && self.pending.borrow().is_some()
  }
}
