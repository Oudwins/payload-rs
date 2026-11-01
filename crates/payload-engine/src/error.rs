use std::fmt;

/// An error that maps onto a Payload error class on the TS side
/// (`APIError`, `InvalidConfiguration`, `ValidationError`, ...).
#[derive(Clone, Debug)]
pub struct EngineError {
  /// Name of the Payload error class to construct, or `Error`.
  pub name: String,
  pub message: String,
  /// Extra constructor data (e.g. validation errors, http status).
  pub data: Option<serde_json::Value>,
  /// Set when this error is a JS value a host operation threw (MongoDB engine host ops): the
  /// binding rethrows the original value instead of building an error from `name` / `message`.
  pub thrown: Option<Box<HostThrow>>,
}

/// A JS value a host operation threw, kept by the host for the rest of the call
/// (`{ $hostObject: handle }`), with the properties engine code branches on.
#[derive(Clone, Debug)]
pub struct HostThrow {
  pub handle: u32,
  /// `typeof error === 'object' && error !== null`
  pub is_object: bool,
  /// `error.message` when `'message' in error`.
  pub message: Option<crate::js::JsVal>,
  /// `error.code` when `'code' in error`.
  pub code: Option<crate::js::JsVal>,
  /// `error.keyValue` when `'keyValue' in error`.
  pub key_value: Option<crate::js::JsVal>,
}

pub type Result<T> = std::result::Result<T, EngineError>;

impl EngineError {
  pub fn new(name: impl Into<String>, message: impl Into<String>) -> Self {
    Self { name: name.into(), message: message.into(), data: None, thrown: None }
  }

  /// The error for a JS value a host operation threw (`name` is the thrown value's `name` when it
  /// is a string, for diagnostics only).
  pub fn host_throw(name: impl Into<String>, thrown: HostThrow) -> Self {
    let message = match &thrown.message {
      Some(crate::js::JsVal::Str(m)) => m.to_string(),
      _ => String::new(),
    };
    Self { name: name.into(), message, data: None, thrown: Some(Box::new(thrown)) }
  }

  pub fn internal(message: impl Into<String>) -> Self {
    Self::new("Error", message)
  }

  pub fn api(message: impl Into<String>) -> Self {
    Self::new("APIError", message)
  }

  pub fn invalid_configuration(message: impl Into<String>) -> Self {
    Self::new("InvalidConfiguration", message)
  }

  pub fn with_data(mut self, data: serde_json::Value) -> Self {
    self.data = Some(data);
    self
  }

  /// `{ name, message, data }`, or `{ rethrow: handle }` for a value a host operation threw.
  pub fn to_json(&self) -> serde_json::Value {
    if let Some(thrown) = &self.thrown {
      return serde_json::json!({ "rethrow": thrown.handle });
    }
    serde_json::json!({ "name": self.name, "message": self.message, "data": self.data })
  }
}

impl fmt::Display for EngineError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}: {}", self.name, self.message)
  }
}

impl std::error::Error for EngineError {}
