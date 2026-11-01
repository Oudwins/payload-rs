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
}

pub type Result<T> = std::result::Result<T, EngineError>;

impl EngineError {
  pub fn new(name: impl Into<String>, message: impl Into<String>) -> Self {
    Self { name: name.into(), message: message.into(), data: None }
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

  pub fn to_json(&self) -> serde_json::Value {
    serde_json::json!({ "name": self.name, "message": self.message, "data": self.data })
  }
}

impl fmt::Display for EngineError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}: {}", self.name, self.message)
  }
}

impl std::error::Error for EngineError {}
