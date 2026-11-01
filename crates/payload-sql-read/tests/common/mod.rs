//! Shared helpers of the fixture replays: loading fixtures (JSON text with lone
//! surrogates intact), per-time-zone expectations and outcome comparison.
//!
//! Time zones: a fixture's stored outputs are the TS outputs in its capture
//! zone (`timeZone`). For every other zone, `fixtures/tz/<Zone_Name>.json`
//! (written by test/__rs/read/capture/replay.ts, which runs the real TS
//! transform in that zone) lists the calls whose TS output differs there. The
//! replays set `TZ` explicitly, so the result does not depend on the machine.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use payload_engine::error::EngineError;
use payload_engine::js::{JsVal, decode_graph};
use payload_sql_read::Val;
use payload_sql_read::encoding::{encode, first_difference, to_serde};
use payload_sql_read::props::get;
use serde_json::json;

pub const DEFAULT_ZONES: [&str; 3] = ["UTC", "Europe/Lisbon", "America/New_York"];

pub fn fixtures_dir() -> PathBuf {
  std::env::var("RS_READ_FIXTURES")
    .map(PathBuf::from)
    .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/__rs/read/fixtures"))
}

/// Zones to replay in (`RS_READ_TZS=UTC,Asia/Tokyo` overrides the default three).
pub fn zones() -> Vec<String> {
  match std::env::var("RS_READ_TZS") {
    Ok(list) => list.split(',').map(str::to_string).collect(),
    Err(_) => DEFAULT_ZONES.iter().map(|z| z.to_string()).collect(),
  }
}

/// Sets the process time zone. Each replay binary has a single `#[test]`, so no
/// other thread touches the environment concurrently.
pub fn use_time_zone(zone: &str) {
  // SAFETY: single test per binary (see above).
  unsafe { payload_sql_read::date::set_process_time_zone(Some(zone)) };
}

pub fn json_files(dir: &Path) -> Vec<PathBuf> {
  let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
    .map(|entries| {
      entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect()
    })
    .unwrap_or_default();
  files.sort();
  files
}

pub fn load(path: &Path) -> Val {
  let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
  payload_sql_read::json::parse(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

pub fn at(v: &Val, key: &str) -> Val {
  get(v, key).unwrap_or_default()
}

pub fn items(v: &Val) -> Vec<Val> {
  payload_sql_read::props::array_items(v).unwrap_or_default()
}

pub fn string(v: &Val) -> String {
  v.as_js_str().map(|s| s.to_string()).unwrap_or_default()
}

pub fn index(v: &Val) -> usize {
  match v {
    Val::Num(n) => *n as usize,
    _ => panic!("expected an index, got {v:?}"),
  }
}

/// A `serializeForEngine` graph.
pub fn graph(v: &Val) -> JsVal {
  decode_graph(&to_serde(v).expect("config graphs are well-formed UTF-16")).expect("valid graph")
}

/// An `encodeTree` value as a config value (join query, parentIsLocalized).
pub fn tree(v: &Val) -> JsVal {
  decode_graph(&json!({ "objects": [], "root": to_serde(v).expect("well-formed tree") })).expect("valid encoded tree")
}

/// Per-zone overrides: zone -> fixture name -> (call count, call index -> outcome).
pub struct Overlays {
  zones: HashMap<String, HashMap<String, (usize, HashMap<usize, Val>)>>,
}

impl Overlays {
  pub fn load() -> Self {
    let mut zones = HashMap::new();
    for file in json_files(&fixtures_dir().join("tz")) {
      let overlay = load(&file);
      let mut fixtures = HashMap::new();
      if let Some(o) = at(&overlay, "fixtures").as_obj() {
        for (name, entry) in o.borrow().entries() {
          let overrides = at(&entry, "overrides")
            .as_obj()
            .map(|o| {
              o.borrow()
                .entries()
                .into_iter()
                .map(|(k, v)| (k.to_string().parse::<usize>().expect("call index"), v))
                .collect()
            })
            .unwrap_or_default();
          fixtures.insert(name.to_string(), (index(&at(&entry, "calls")), overrides));
        }
      }
      zones.insert(string(&at(&overlay, "timeZone")), fixtures);
    }
    Overlays { zones }
  }

  /// The expected outcome (`{ output }` or `{ error }`) of call `i` of `fixture` in `zone`.
  pub fn expected(
    &self,
    fixture: &str,
    capture_zone: &str,
    zone: &str,
    call_count: usize,
    i: usize,
    call: &Val,
  ) -> Result<Val, String> {
    if capture_zone == zone {
      return Ok(call.clone());
    }
    let Some((count, overrides)) = self.zones.get(zone).and_then(|z| z.get(fixture)) else {
      return Err(format!(
        "no TS expectations for {fixture} (captured in {capture_zone:?}) in {zone}: \
         run `TZ={zone} pnpm tsx test/__rs/read/capture/replay.ts`"
      ));
    };
    if *count != call_count {
      return Err(format!("stale overlay for {fixture} in {zone} ({count} calls, fixture has {call_count})"));
    }
    Ok(overrides.get(&i).cloned().unwrap_or_else(|| call.clone()))
  }
}

/// Compares a TS outcome (`{ output }` or `{ error: { name } }`) with the Rust result.
pub fn compare(expected: &Val, actual: Result<Val, EngineError>) -> Option<String> {
  let output = at(expected, "output");
  let error = at(expected, "error");
  match (output.is_undefined(), actual) {
    (false, Ok(actual)) => match encode(&actual) {
      Ok(encoded) => first_difference(&output, &encoded),
      Err(e) => Some(format!("cannot encode Rust output: {e}")),
    },
    (true, Err(err)) => {
      let name = string(&at(&error, "name"));
      (name != err.name).then(|| format!("error class {name} != {} ({})", err.name, err.message))
    }
    (true, Ok(actual)) => Some(format!(
      "expected {} {:?} but Rust returned {}",
      string(&at(&error, "name")),
      string(&at(&error, "message")),
      payload_sql_read::encoding::encode_text(&actual).unwrap_or_default()
    )),
    (false, Err(err)) => Some(format!("Rust error: {err}")),
  }
}
