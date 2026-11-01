//! The decoded config graph (kept for the engine's lifetime) and the per-call context.

use std::collections::HashMap;

use payload_engine::error::Result;
use payload_engine::js::JsVal;
use serde_json::Value as Json;

use crate::host::{ModelRef, MongoHost};
use crate::util::{build_version_collection_fields, build_version_global_fields};

/// `serializeForEngine({ config: payload.config, collections: { [slug]: { config, customIDType } } })`,
/// decoded once.
pub struct Graph {
  pub root: JsVal,
  /// `buildVersionCollectionFields` / `buildVersionGlobalFields` per slug: `(fields, flattened)`.
  collection_versions: HashMap<String, (JsVal, JsVal)>,
  global_versions: HashMap<String, (JsVal, JsVal)>,
}

impl Graph {
  pub fn new(root: JsVal) -> Self {
    let config = root.get("config").clone();
    let mut collection_versions = HashMap::new();
    for (slug, collection) in root.get("collections").as_obj().into_iter().flatten() {
      let collection_config = collection.get("config");
      collection_versions.insert(
        slug.clone(),
        (
          build_version_collection_fields(&config, collection_config, false),
          build_version_collection_fields(&config, collection_config, true),
        ),
      );
    }
    let mut global_versions = HashMap::new();
    for global in config.get("globals").items() {
      if let Some(slug) = global.get("slug").as_str() {
        global_versions.entry(slug.to_string()).or_insert_with(|| {
          (build_version_global_fields(&config, global, false), build_version_global_fields(&config, global, true))
        });
      }
    }
    Self { root, collection_versions, global_versions }
  }

  pub fn config(&self) -> &JsVal {
    self.root.get("config")
  }

  /// `payload.collections[slug]` (`{ config, customIDType }`).
  pub fn collection(&self, slug: &str) -> Option<&JsVal> {
    self.root.get("collections").as_obj().and_then(|c| c.get(slug)).filter(|c| c.truthy())
  }

  /// `payload.config.globals.find((each) => each.slug === slug)`
  pub fn global(&self, slug: &str) -> Option<&JsVal> {
    self.config().get("globals").items().find(|g| g.get("slug").as_str() == Some(slug))
  }

  /// `buildVersionCollectionFields(config, collection, flatten)` of a collection in the graph.
  pub fn collection_version_fields(&self, slug: &str, flatten: bool) -> JsVal {
    match self.collection_versions.get(slug) {
      Some((fields, flattened)) => if flatten { flattened.clone() } else { fields.clone() },
      None => JsVal::arr(Vec::new()),
    }
  }

  /// `buildVersionGlobalFields(config, global, flatten)` of a global in the graph.
  pub fn global_version_fields(&self, slug: &str, flatten: bool) -> JsVal {
    match self.global_versions.get(slug) {
      Some((fields, flattened)) => if flatten { flattened.clone() } else { fields.clone() },
      None => JsVal::arr(Vec::new()),
    }
  }

  /// `payload.config.localization`
  pub fn localization(&self) -> &JsVal {
    self.config().get("localization")
  }

  /// `(typeof localization === 'object' && localization?.defaultLocale) || 'en'`
  pub fn default_locale(&self) -> JsVal {
    let localization = self.localization();
    let value = if localization.type_of() == "object" && !localization.is_null() {
      localization.get("defaultLocale").clone()
    } else {
      JsVal::Bool(false)
    };
    if value.truthy() { value } else { JsVal::str("en") }
  }
}

/// `contextJson` of one call: `{ adapter: { allowAdditionalKeys, allowIDOnCreate, collation,
/// disableFallbackSort, disableIndexHints, useBigIntForNumberIDs, useJoinAggregations,
/// usePipelineInSortLookup }, hasReq, models: { collections: { [slug]: collectionName }, versions:
/// { [slug]: collectionName } }, now, withMutations }`, read live per call by the glue.
pub struct CallContext {
  /// The adapter properties (read by name).
  pub adapter: JsVal,
  /// `None` when the context has no `models` (every collection of the graph is assumed to have
  /// its models; collection names are then unknown).
  collections: Option<HashMap<String, String>>,
  versions: Option<HashMap<String, String>>,
  /// The caller's `Date.now()` (the system clock when the context has none).
  pub now: f64,
  /// Whether the call has a `req` (`getSession` resolves `undefined` without an op otherwise, and
  /// `handleError` reads `req.payload.config.localization`, the engine's config).
  pub has_req: bool,
}

impl CallContext {
  pub fn parse(json: &Json) -> Result<Self> {
    let adapter = payload_engine::js::decode_value_bson(json.get("adapter").unwrap_or(&Json::Null))?;
    let names = |key: &str| -> Option<HashMap<String, String>> {
      json.get("models").and_then(|m| m.get(key)).and_then(Json::as_object).map(|m| {
        m.iter().filter_map(|(slug, name)| Some((slug.clone(), name.as_str()?.to_string()))).collect()
      })
    };
    Ok(Self {
      adapter,
      collections: names("collections"),
      versions: names("versions"),
      now: json.get("now").and_then(Json::as_f64).unwrap_or_else(crate::util::system_now),
      has_req: json.get("hasReq").and_then(Json::as_bool).unwrap_or(false),
    })
  }

  /// `adapter[name]`
  pub fn flag(&self, name: &str) -> &JsVal {
    self.adapter.get(name)
  }

  /// `adapter.collation`
  pub fn collation(&self) -> &JsVal {
    self.flag("collation")
  }

  /// `adapter.disableIndexHints !== true`
  pub fn index_hints_enabled(&self) -> bool {
    !self.flag("disableIndexHints").is_true()
  }

  /// `adapter.useJoinAggregations`
  pub fn use_join_aggregations(&self) -> bool {
    self.flag("useJoinAggregations").truthy()
  }

  /// Whether the model exists (`adapter.collections[slug]` / `adapter.versions[slug]` truthy).
  pub fn has_model(&self, model: &ModelRef) -> bool {
    match model {
      ModelRef::Collections(slug) => self.collections.as_ref().is_none_or(|m| m.contains_key(slug)),
      ModelRef::Versions(slug) => self.versions.as_ref().is_none_or(|m| m.contains_key(slug)),
      ModelRef::Globals => true,
    }
  }

  /// `Model.collection.name` (`None` when the context has no `models`).
  pub fn collection_name(&self, model: &ModelRef) -> Option<&str> {
    match model {
      ModelRef::Collections(slug) => self.collections.as_ref()?.get(slug).map(String::as_str),
      ModelRef::Versions(slug) => self.versions.as_ref()?.get(slug).map(String::as_str),
      ModelRef::Globals => None,
    }
  }
}

/// Everything one method call works with.
pub struct Call<'a> {
  pub graph: &'a Graph,
  pub ctx: &'a CallContext,
  /// Host ops (database I/O, sessions, logging).
  pub host: &'a dyn MongoHost,
  /// Config functions (`callFunction`), called synchronously.
  pub functions: &'a dyn payload_engine::host::Host,
  /// `Date.now()` for the `new Date()` stamps of the methods (`createdAt`) and of the write
  /// transform (`updatedAt`): the caller's clock (`now` of the context, so faked JS clocks apply).
  pub now: &'a dyn Fn() -> f64,
}
