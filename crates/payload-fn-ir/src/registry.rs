//! Process-wide table of compiled functions, addressed by [`FnId`]. Ids are reserved before a
//! function is compiled (so mutually recursive helpers can reference each other) and installed
//! once. A reserved id that never gets installed (its compilation failed) evaluates to
//! [`Bail::NotCompiled`].

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use crate::ir::FnDef;
use crate::{Bail, FnId};

/// What callers need to know about a compiled function without looking at its IR.
#[derive(Clone, Debug, Default)]
pub struct FnMeta {
  /// JS returns a promise (an `async` function): the compiled result is its resolution value.
  pub is_async: bool,
  /// Per parameter: the top-level keys of its object pattern (without a rest element the
  /// argument object is never bound, so these are the only properties of it the function can
  /// read), or `None` when it may read any.
  pub arg_keys: Vec<Option<Vec<String>>>,
  /// A readable name (the JS function's name or its config path) for logs.
  pub label: String,
}

pub struct Installed {
  pub def: FnDef,
  pub meta: FnMeta,
}

#[derive(Default)]
pub struct Entry {
  installed: OnceLock<Arc<Installed>>,
  deoptimized: AtomicBool,
  /// Guard-mode counters (see [`crate::guard`]).
  pub(crate) calls: AtomicU64,
  pub(crate) verified: AtomicU64,
  pub(crate) mismatches: AtomicU64,
  pub(crate) bails: AtomicU64,
}

static ENTRIES: RwLock<Vec<Arc<Entry>>> = RwLock::new(Vec::new());

/// Reserves an id for a function about to be compiled.
pub fn reserve() -> FnId {
  let mut entries = ENTRIES.write().expect("registry");
  entries.push(Arc::new(Entry::default()));
  (entries.len() - 1) as FnId
}

pub(crate) fn entry(id: FnId) -> Option<Arc<Entry>> {
  ENTRIES.read().expect("registry").get(id as usize).cloned()
}

/// Installs the compiled function of a reserved id (once).
pub fn install(id: FnId, def: FnDef, meta: FnMeta) -> bool {
  match entry(id) {
    Some(e) => e.installed.set(Arc::new(Installed { def, meta })).is_ok(),
    None => false,
  }
}

/// The compiled function, if it is installed and not de-optimised.
pub(crate) fn installed(id: FnId) -> Option<Arc<Installed>> {
  let e = entry(id)?;
  if e.deoptimized.load(Ordering::Relaxed) {
    return None;
  }
  e.installed.get().cloned()
}

/// `true` when `id` is compiled and has not been de-optimised: a fused lane may evaluate it.
pub fn is_active(id: FnId) -> bool {
  installed(id).is_some()
}

pub fn meta(id: FnId) -> Option<FnMeta> {
  entry(id)?.installed.get().map(|i| i.meta.clone())
}

/// Permanently stops evaluating `id` in Rust (its result differed from the real function's).
pub fn deoptimize(id: FnId) {
  if let Some(e) = entry(id) {
    e.deoptimized.store(true, Ordering::Relaxed);
  }
}

pub fn is_deoptimized(id: FnId) -> bool {
  entry(id).is_some_and(|e| e.deoptimized.load(Ordering::Relaxed))
}

/// Debug rendering of the IR (tests, the compile-rate report).
pub fn describe(id: FnId) -> Option<String> {
  entry(id)?.installed.get().map(|i| format!("{:#?}", i.def))
}

pub fn len() -> usize {
  ENTRIES.read().expect("registry").len()
}

pub(crate) fn check(id: FnId) -> Result<(), Bail> {
  if installed(id).is_some() { Ok(()) } else { Err(Bail::NotCompiled) }
}
