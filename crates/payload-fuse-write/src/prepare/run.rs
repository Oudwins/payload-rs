//! The state one prepare call shares between its traversal tasks.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use payload_engine::js::JsVal;

use super::exec::Exec;
use super::heap::{Heap, Ref, V};
use super::plan::WritePlan;
use super::{Bail, Entropy, FieldError, IdUse};
use payload_core_validate::Translate;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
  Create,
  Update,
}

impl Operation {
  pub fn name(self) -> &'static str {
    match self {
      Operation::Create => "create",
      Operation::Update => "update",
    }
  }
}

pub struct Run<'e> {
  pub plan: &'e WritePlan,
  pub operation: Operation,
  pub override_access: bool,
  /// `req.context?.isRestoringVersion`
  pub restoring_version: bool,
  /// `req.user` as `{ relationTo, value }` parts.
  pub user: Option<(String, JsVal)>,
  pub id: Option<JsVal>,
  pub t: Option<&'e dyn Translate>,
  pub language: &'e str,
  pub fallback_language: &'e [String],
  pub heap: RefCell<Heap>,
  pub entropy: RefCell<&'e mut dyn Entropy>,
  pub bail: RefCell<Option<Bail>>,
  pub errors: RefCell<Vec<FieldError>>,
  /// `req.context._submittedAuthorshipFields` once set (a heap object).
  pub submitted: Cell<Option<Ref>>,
  /// `req.context.internal` once lexical's `beforeValidate` created it (a heap object).
  pub internal: Cell<Option<Ref>>,
  /// The top-level `data` of the running `beforeChange`.
  pub root_data: Cell<Option<Ref>>,
  /// `req.context._isNewDoc` once set.
  pub is_new_doc: Cell<Option<bool>>,
  /// The order the context keys were first set.
  pub context_order: RefCell<Vec<&'static str>>,
}

impl<'e> Run<'e> {
  pub fn fail(&self, bail: Bail) {
    let mut slot = self.bail.borrow_mut();
    if slot.is_none() {
      *slot = Some(bail);
    }
  }

  pub fn failed(&self) -> bool {
    self.bail.borrow().is_some()
  }

  /// Records a bail and reports whether the step must stop.
  pub fn check<T>(&self, result: Result<T, Bail>) -> Option<T> {
    match result {
      Ok(value) => Some(value),
      Err(bail) => {
        self.fail(bail);
        None
      }
    }
  }

  pub fn now(&self) -> Result<f64, Bail> {
    self.entropy.borrow_mut().now()
  }

  pub fn object_id(&self, used_for: IdUse) -> Result<[u8; 12], Bail> {
    self.entropy.borrow_mut().object_id(used_for)
  }

  pub fn get(&self, obj: &V, key: &str) -> V {
    self.heap.borrow().get(obj, key)
  }

  pub fn set(&self, obj: Ref, key: &str, value: V) -> Result<(), Bail> {
    self.heap.borrow_mut().set(obj, key, value)
  }

  pub fn note_context(&self, key: &'static str) {
    let mut order = self.context_order.borrow_mut();
    if !order.contains(&key) {
      order.push(key);
    }
  }
}

/// What every traversal task holds: the call's state and the executor.
pub struct S<'r, 'e> {
  pub run: &'r Run<'e>,
  pub exec: Rc<Exec<'r>>,
}

impl<'r, 'e> Clone for S<'r, 'e> {
  fn clone(&self) -> Self {
    S { run: self.run, exec: self.exec.clone() }
  }
}
