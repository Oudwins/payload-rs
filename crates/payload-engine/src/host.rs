use crate::error::Result;
use crate::js::JsVal;

/// Calls back into the JS runtime that owns the config.
pub trait Host {
  /// Calls the JS function registered under `id` with a single argument and
  /// returns its (synchronous) result.
  fn call(&self, id: u32, arg: &serde_json::Value) -> Result<JsVal>;

  /// [`Host::call`] with a JS value argument. Hosts that can pass JS values exactly (own keys
  /// holding `undefined`, `Date`s, ...) override this; the default passes `arg.to_json()`, which
  /// drops keys holding `undefined` like `JSON.stringify`.
  fn call_value(&self, id: u32, arg: &JsVal) -> Result<JsVal> {
    self.call(id, &arg.to_json())
  }
}

/// A host for configs without functions in the paths the engine calls.
pub struct NoHost;

impl Host for NoHost {
  fn call(&self, id: u32, _arg: &serde_json::Value) -> Result<JsVal> {
    Err(crate::error::EngineError::internal(format!("no JS host available to call function {id}")))
  }
}
