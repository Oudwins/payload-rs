//! Process-wide table of compiled functions, addressed by [`FnId`]. Ids are reserved before a
//! function is compiled (so mutually recursive helpers can reference each other) and installed
//! once. A reserved id that never gets installed (its compilation failed) evaluates to
//! [`Bail::NotCompiled`].

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use crate::ir::FnDef;
use crate::FnId;

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
  installed: OnceLock<Installed>,
  deoptimized: AtomicBool,
  /// Guard-mode counters (see [`crate::guard`]).
  pub(crate) calls: AtomicU64,
  pub(crate) verified: AtomicU64,
  pub(crate) mismatches: AtomicU64,
  pub(crate) bails: AtomicU64,
  pub(crate) lane_calls: AtomicU64,
}

/// Lock-free append-only table: segment `k` holds ids `2^k - 1 .. 2^(k+1) - 1`, allocated on first
/// use. Entries are never freed (compiled functions live as long as the process), so lookups
/// return `&'static` references without reference counting.
const SEGMENTS: usize = 32;
static TABLE: [OnceLock<Box<[OnceLock<&'static Entry>]>>; SEGMENTS] = [const { OnceLock::new() }; SEGMENTS];
static NEXT: AtomicU32 = AtomicU32::new(0);

fn locate(id: FnId) -> (usize, usize) {
  let n = id as u64 + 1;
  let segment = 63 - n.leading_zeros() as usize;
  (segment, (n - (1u64 << segment)) as usize)
}

/// Reserves an id for a function about to be compiled.
pub fn reserve() -> FnId {
  let id = NEXT.fetch_add(1, Ordering::Relaxed);
  let (segment, offset) = locate(id);
  let slots = TABLE[segment].get_or_init(|| (0..1usize << segment).map(|_| OnceLock::new()).collect());
  let entry: &'static Entry = Box::leak(Box::default());
  let _ = slots[offset].set(entry);
  id
}

#[inline]
pub(crate) fn entry(id: FnId) -> Option<&'static Entry> {
  let (segment, offset) = locate(id);
  TABLE.get(segment)?.get()?.get(offset)?.get().copied()
}

/// Installs the compiled function of a reserved id (once).
pub fn install(id: FnId, def: FnDef, meta: FnMeta) -> bool {
  match entry(id) {
    Some(e) => e.installed.set(Installed { def, meta }).is_ok(),
    None => false,
  }
}

/// The compiled function, if it is installed and not de-optimised.
#[inline]
pub(crate) fn installed(id: FnId) -> Option<&'static Installed> {
  let e = entry(id)?;
  if e.deoptimized.load(Ordering::Relaxed) {
    return None;
  }
  e.installed.get()
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
  NEXT.load(Ordering::Relaxed) as usize
}

