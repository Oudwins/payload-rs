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

/// Whether `id` still lacks [`Policy::first`] verified (or bailed) calls, or is not active: every
/// lane call bails then ([`lane_should_verify`]'s first branch), so a lane can skip its work
/// before using it. Counts nothing.
pub fn lane_in_warmup(id: FnId) -> bool {
  let Some(e) = registry::entry(id) else { return true };
  !registry::is_active(id) || e.verified.load(Ordering::Relaxed) + e.bails.load(Ordering::Relaxed) < policy().first
}

/// For fused lanes: whether this call of `id` must run on the exact (JS-calling) lane so the JS
/// side can verify it (the guard wrapper compares there). True until the function has
/// [`Policy::first`] verified (or bailed) calls, then once [`Policy::sample_every`] lane calls
/// have passed since its last verification: that call is marked due, so the call-site guard
/// verifies the exact lane's call ([`take_verify`]), and so is every other function halfway due
/// ([`mark_halfway_due`]). Counts lane calls separately from the JS wrapper's calls.
pub fn lane_should_verify(id: FnId) -> bool {
  let Some(e) = registry::entry(id) else { return true };
  let p = policy();
  let checked = e.verified.load(Ordering::Relaxed) + e.bails.load(Ordering::Relaxed);
  if checked < p.first {
    return true;
  }
  let n = e.lane_calls.fetch_add(1, Ordering::Relaxed) + 1;
  if p.sample_every == 0 || n < p.sample_every {
    return false;
  }
  e.lane_calls.store(0, Ordering::Relaxed);
  e.verify_due.store(true, Ordering::Relaxed);
  mark_halfway_due(p);
  true
}

/// At a lane's sample: every active function halfway due (half of [`Policy::sample_every`] lane
/// calls since its last verification) is marked due and its lane count restarted. The sampled
/// operation's exact lane verifies the functions it calls ([`take_verify`]); without the mark,
/// the operations running concurrently with it would each send the operation's other functions,
/// which reach their own sample in those operations, to the exact lane before it calls them. A
/// marked function the exact lane does not call is verified at its next JS call, or samples
/// again after `sample_every` more lane calls.
fn mark_halfway_due(p: Policy) {
  let half = p.sample_every.div_ceil(2);
  for id in 0..registry::len() as FnId {
    if let Some(e) = registry::entry(id)
      && e.lane_calls.load(Ordering::Relaxed) >= half
      && registry::is_active(id)
    {
      e.lane_calls.store(0, Ordering::Relaxed);
      e.verify_due.store(true, Ordering::Relaxed);
    }
  }
}

/// For the call-site guard, on a call of `id` in JS (the exact lane): whether to verify it besides
/// the calls its own policy selects. True for the call a lane left to the exact lane
/// ([`lane_should_verify`]), and for any call once half of [`Policy::sample_every`] lane calls
/// have passed since the last verification: an operation that runs on the exact lane for one
/// function's sample then verifies its other functions that are halfway due, so the samples of
/// functions one operation uses together fall into the same operations instead of each sending
/// its own operations to the exact lane. A verification restarts the function's lane count.
pub fn take_verify(id: FnId) -> bool {
  let Some(e) = registry::entry(id) else { return false };
  let p = policy();
  let is_due = e.verify_due.swap(false, Ordering::Relaxed)
    || (p.sample_every > 0 && e.lane_calls.load(Ordering::Relaxed) >= p.sample_every.div_ceil(2));
  if is_due {
    e.lane_calls.store(0, Ordering::Relaxed);
  }
  is_due
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
