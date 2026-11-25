//! The function compiler (RUST_PERF_PLAN.md S6, work package D): users' JS functions (access
//! control, simple hooks, validators) compiled to a small IR interpreted in Rust, so an operation
//! whose only user JS is such functions can run without calling into JS.
//!
//! Pipeline (driven by `packages/engine-rs/src/compile/`):
//!
//! 1. [`compile::analyze`] parses `Function.prototype.toString()` with oxc and lists the free
//!    identifiers with the static member paths read through them.
//! 2. The JS side resolves them in the function's real scopes (in-process inspector,
//!    `[[Scopes]]`): captured primitives and plain data become snapshots, captured functions are
//!    compiled recursively (helpers), module namespaces (`__vi_import_0__.checkRole`,
//!    webpack's `_utils__WEBPACK_IMPORTED_MODULE_0__.checkRole`) are followed through their
//!    members, globals must be the pristine intrinsics.
//! 3. [`compile::compile`] builds the IR, [`registry::install`] makes it callable by [`FnId`].
//! 4. [`evaluate`] runs it on Rust-side inputs. It returns the exact JS result or a [`Bail`]: the
//!    caller then calls the real function (a bail is never wrong, only slower).
//!
//! Assumptions (owner decision D5): captured bindings are not reassigned after the function was
//! compiled, captured objects are not mutated, the function is deterministic for its inputs,
//! intrinsics are unpatched (checked when compiling). [`guard`] verifies compiled results against
//! the real function and de-optimises on any mismatch.
//!
//! Opt-out: a function whose source mentions `skipCompilation` (the no-op function Payload passes
//! in the arguments of access functions, hooks and validators: `args.skipCompilation?.()`) is
//! never compiled.

pub mod builtins;
pub mod compile;
pub mod guard;
pub(crate) mod interp;
pub mod ir;
pub mod lanes;
pub mod registry;
pub mod value;

pub use compile::{Analysis, PathTrie, Reject, Resolution};
pub use value::{Object, OpaqueKind, Value};

/// A compiled function's id in the process-wide [`registry`].
pub type FnId = u32;

/// Why an evaluation handed the call back to JS. None of these is an error of the user's
/// function: the real function decides (and may throw).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bail {
  /// The JS function throws here (TypeError of a nullish read, `throw` statement, ...).
  Throw,
  /// An opaque value (function, class instance, `Date`, ...) had to be looked into.
  Opaque,
  /// A property of a partial snapshot (`req`) that was not captured.
  Unknown,
  /// Semantics the interpreter does not model for these inputs.
  Unsupported(&'static str),
  /// Recursion or size limit.
  Limit,
  /// The id is not compiled, or it was de-optimised.
  NotCompiled,
  /// Internal: an optional chain short-circuited (never escapes [`evaluate`]).
  ShortCircuit,
}

impl Bail {
  pub fn reason(&self) -> &'static str {
    match self {
      Bail::Throw => "throws",
      Bail::Opaque => "opaque value",
      Bail::Unknown => "value not in the snapshot",
      Bail::Unsupported(what) => what,
      Bail::Limit => "limit",
      Bail::NotCompiled => "not compiled",
      Bail::ShortCircuit => "short circuit",
    }
  }
}

/// Evaluates compiled function `id` with `args` (its JS arguments, e.g. `[accessArgs]` or
/// `[value, validateOptions]`). For an async function, or a promise returned by a helper, the
/// value is the resolution (Payload awaits every such call).
///
/// Inputs are snapshots: build documents and `req.user` with [`Value::from_json`], and `req` as a
/// partial object ([`Value::partial_object`]) holding only what was captured (`user`, `locale`,
/// `fallbackLocale`, `context`, `query`): reading any other `req` property bails.
pub fn evaluate(id: FnId, args: &[Value]) -> Result<Value, Bail> {
  evaluate_ticks(id, args).map(|(value, _)| value)
}

/// [`evaluate`], also saying whether `await fn(...args)` in JS resumes after exactly one microtask
/// tick: no `await` ran and no async function returned a promise, so every promise involved was
/// already settled when awaited. Lanes that order work by ticks (the fused `afterRead`) bail on
/// `false`.
pub fn evaluate_ticks(id: FnId, args: &[Value]) -> Result<(Value, bool), Bail> {
  let installed = registry::installed(id).ok_or(Bail::NotCompiled)?;
  // One interpreter per thread, reused (its frame and slot stacks keep their capacity).
  // Evaluation never re-enters itself (no JS runs), so the borrow cannot conflict.
  INTERP.with(|cell| {
    let mut fresh;
    let mut borrowed = cell.try_borrow_mut();
    let interp = match &mut borrowed {
      Ok(i) => &mut **i,
      Err(_) => {
        fresh = interp::Interp::new();
        &mut fresh
      }
    };
    let result = interp.call_top(installed, args);
    let one_tick = interp.extra_ticks == 0;
    interp.reset();
    match result {
      Err(Bail::ShortCircuit) => Err(Bail::Unsupported("short circuit outside a chain")),
      other => other.map(|value| (value, one_tick)),
    }
  })
}

thread_local! {
  static INTERP: std::cell::RefCell<interp::Interp> = std::cell::RefCell::new(interp::Interp::new());
}

/// Analyse + compile + install in one step, for Rust callers and tests whose functions have no
/// free identifiers other than intrinsics (resolved here as pristine).
pub fn compile_standalone(source: &str) -> Result<FnId, Reject> {
  let analysis = compile::analyze(source)?;
  let mut resolutions = std::collections::HashMap::new();
  for (name, trie) in &analysis.free {
    resolutions.insert(name.clone(), standalone_resolution(name, trie)?);
  }
  let def = compile::compile(source, &resolutions)?;
  let id = registry::reserve();
  registry::install(
    id,
    def,
    registry::FnMeta { is_async: analysis.is_async, arg_keys: analysis.arg_keys, label: String::new() },
  );
  Ok(id)
}

fn standalone_resolution(path: &str, trie: &PathTrie) -> Result<Resolution, Reject> {
  if let Some(v) = ir::global_constant(path) {
    return Ok(Resolution::Value(v));
  }
  if trie.used_as_value || trie.members.is_empty() {
    return ir::Builtin::from_path(path)
      .map(Resolution::Builtin)
      .ok_or_else(|| Reject(format!("unresolved identifier {path}")));
  }
  let mut members = std::collections::HashMap::new();
  for (k, t) in &trie.members {
    members.insert(k.clone(), standalone_resolution(&format!("{path}.{k}"), t)?);
  }
  Ok(Resolution::Namespace(members))
}

#[cfg(test)]
mod tests;
