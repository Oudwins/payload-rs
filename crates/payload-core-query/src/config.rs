//! The parts of `payload` (`req.payload`) the query utilities read, built
//! once from the decoded config graph.

use indexmap::IndexMap;
use payload_engine::js::JsVal;

/// `req.payload` as seen by the query utilities.
#[derive(Clone, Debug)]
pub struct QueryConfig {
  /// `payload.config` (sanitized).
  pub config: JsVal,
  /// `payload.collections[slug].config`, in `Object.keys(payload.collections)` order.
  pub collections: IndexMap<String, JsVal>,
  /// `payload.blocks[slug]`
  pub blocks: IndexMap<String, JsVal>,
  /// `payload.db.defaultIDType`
  pub default_id_type: JsVal,
}

/// JS own-key order: array-index keys first (ascending), then insertion order.
fn js_key_order(mut entries: Vec<(String, JsVal)>) -> IndexMap<String, JsVal> {
  let index = |k: &str| -> Option<u64> {
    if k.is_empty() || k.len() > 10 || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
      return None;
    }
    k.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64)
  };
  let mut out = IndexMap::new();
  for (k, v) in entries.drain(..) {
    // later duplicates overwrite in place, like `obj[slug] = value`
    if let Some(slot) = out.get_mut(&k) {
      *slot = v;
    } else {
      out.insert(k, v);
    }
  }
  let mut keys: Vec<(String, JsVal)> = out.into_iter().collect();
  let (mut ints, rest): (Vec<_>, Vec<_>) = keys.drain(..).partition(|(k, _)| index(k).is_some());
  ints.sort_by_key(|(k, _)| index(k));
  ints.into_iter().chain(rest).collect()
}

impl QueryConfig {
  /// `config` is the sanitized `payload.config`; `default_id_type` is `payload.db.defaultIDType`.
  pub fn new(config: JsVal, default_id_type: JsVal) -> Self {
    let by_slug = |list: &JsVal| {
      js_key_order(
        list
          .items()
          .map(|item| (item.get("slug").to_js_string(), item.clone()))
          .collect(),
      )
    };
    let collections = by_slug(config.get("collections"));
    let blocks = by_slug(config.get("blocks"));
    Self { config, collections, blocks, default_id_type }
  }

  /// `payload.collections[slug]?.config`
  pub fn collection(&self, slug: &str) -> Option<&JsVal> {
    self.collections.get(slug)
  }

  /// `payload.config.localization`
  pub fn localization(&self) -> &JsVal {
    self.config.get("localization")
  }
}
