//! Guard mode: the real JS function stays the authority. A call that is "verified" runs the JS
//! function and compares its result with the compiled one; a mismatch de-optimises the function
//! permanently. Which calls are verified: the first [`Policy::first`] calls of each function, then
//! one in [`Policy::sample_every`] (0: none). `Policy { first: u64::MAX, .. }` verifies every call.

use std::sync::RwLock;
use std::sync::atomic::Ordering;

use crate::{FnId, registry};

#[derive(Clone, Copy, Debug)]
pub struct Policy {
  pub first: u64,
  pub sample_every: u64,
}

impl Default for Policy {
  fn default() -> Self {
    Policy { first: 32, sample_every: 256 }
  }
}

static POLICY: RwLock<Policy> = RwLock::new(Policy { first: 32, sample_every: 256 });

pub fn set_policy(policy: Policy) {
  *POLICY.write().expect("policy") = policy;
}

pub fn policy() -> Policy {
  *POLICY.read().expect("policy")
}

/// Counts a call of `id` and says whether it must be verified against JS (a fused lane then runs
/// the exact, JS-calling path for this call instead).
pub fn should_verify(id: FnId) -> bool {
  let Some(e) = registry::entry(id) else { return true };
  let n = e.calls.fetch_add(1, Ordering::Relaxed) + 1;
  let p = policy();
  n <= p.first || (p.sample_every > 0 && n % p.sample_every == 0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
  /// Compiled and JS results are equal.
  Match,
  /// They differ: the function is de-optimised.
  Mismatch,
  /// The compiled evaluation bailed (JS's result is used, nothing to compare).
  Bail,
}

pub fn record(id: FnId, outcome: Outcome) {
  let Some(e) = registry::entry(id) else { return };
  match outcome {
    Outcome::Match => {
      e.verified.fetch_add(1, Ordering::Relaxed);
    }
    Outcome::Mismatch => {
      e.mismatches.fetch_add(1, Ordering::Relaxed);
      registry::deoptimize(id);
    }
    Outcome::Bail => {
      e.bails.fetch_add(1, Ordering::Relaxed);
    }
  }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
  pub calls: u64,
  pub verified: u64,
  pub mismatches: u64,
  pub bails: u64,
  pub deoptimized: bool,
}

pub fn stats(id: FnId) -> Stats {
  let Some(e) = registry::entry(id) else { return Stats::default() };
  Stats {
    calls: e.calls.load(Ordering::Relaxed),
    verified: e.verified.load(Ordering::Relaxed),
    mismatches: e.mismatches.load(Ordering::Relaxed),
    bails: e.bails.load(Ordering::Relaxed),
    deoptimized: registry::is_deoptimized(id),
  }
}
