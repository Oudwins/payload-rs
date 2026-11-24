//! Unit tests of the write-side steps on small hand-written plans (the differential corpus in
//! test/__rs/fuse-writes compares them with upstream on real configs).

use payload_core_validate::I18n;
use payload_engine::js::JsVal;
use payload_mongo_driver::mongodb::bson::{Bson, doc};
use serde_json::json;

use super::plan::decode;
use super::{IdUse, RecordedEntropy, UpdateInput, WriteCtx, prepare_create, prepare_update};

fn schema_paths(paths: serde_json::Value, tree: &[&str]) -> serde_json::Value {
  json!({ "minimize": false, "nested": [], "paths": paths, "tree": tree, "versionKey": "__v" })
}

/// A `minimal`-like collection without versions: title (required), views (default 0), author.
fn plan_json() -> String {
  json!({
    "v": 1,
    "slug": "posts",
    "allowAdditionalKeys": false,
    "allowIDOnCreate": false,
    "defaultIDType": "text",
    "defaultMaxTextLength": null,
    "fields": [
      { "t": "text", "n": "title", "label": "Title", "hooks": {}, "val": "text", "vo": { "name": "title", "required": true }, "req": 1 },
      { "t": "number", "n": "views", "label": "Views", "hooks": {}, "d": 0, "val": "number", "vo": { "name": "views" } },
      { "t": "relationship", "n": "author", "label": "Author", "hooks": {}, "val": "relationship", "vo": { "name": "author", "relationTo": "authors" }, "r": "authors" },
      { "t": "date", "n": "updatedAt", "label": null },
      { "t": "date", "n": "createdAt", "label": null },
    ],
    "relations": { "authors": { "customIDType": null } },
    "schema": schema_paths(
      json!([
        { "i": "ObjectId", "p": "_id", "d": "auto" },
        { "i": "Date", "p": "createdAt" },
        { "i": "Date", "p": "updatedAt" },
        { "i": "String", "p": "title" },
        { "i": "Number", "p": "views", "d": { "s": 0 } },
        { "i": "ObjectId", "p": "author" },
        { "i": "Number", "p": "__v" },
      ]),
      &["_id", "createdAt", "updatedAt", "title", "views", "author", "__v", "id"],
    ),
    "timestamps": true,
    "versions": null,
  })
  .to_string()
}

fn translations() -> I18n {
  I18n { translations: JsVal::from_json(&json!({ "validation": { "required": "This field is required." } })) }
}

fn data(value: serde_json::Value) -> JsVal {
  JsVal::from_json(&value)
}

const AUTHOR: &str = "6b05f748126aab3069798703";

#[test]
fn create_builds_the_insert_in_mongoose_order() {
  let plan = decode(&plan_json()).unwrap();
  let mut entropy = RecordedEntropy::default();
  entropy.clock.extend([1_000.0, 2_000.0]);
  entropy.ids.push_back((IdUse::Document, [7; 12]));
  let context = JsVal::Undefined;
  let t = translations();
  let mut ctx = WriteCtx {
    context: &context,
    entropy: &mut entropy,
    fallback_language: &[],
    language: "en",
    override_access: true,
    t: Some(&t),
    user: None,
  };
  let prepared = prepare_create(&plan, &data(json!({ "views": "  12 ", "title": 7, "author": AUTHOR })), &mut ctx).unwrap();
  let write = prepared.outcome.unwrap();
  let keys: Vec<&str> = write.doc.keys().map(String::as_str).collect();
  assert_eq!(keys, ["_id", "createdAt", "updatedAt", "title", "views", "author", "__v"]);
  assert_eq!(write.doc.get("title"), Some(&Bson::String("7".into())));
  assert_eq!(write.doc.get("views"), Some(&Bson::Int32(12)));
  assert!(matches!(write.doc.get("author"), Some(Bson::ObjectId(_))));
  assert!(matches!(write.doc.get("createdAt"), Some(Bson::DateTime(dt)) if dt.timestamp_millis() == 1_000));
  assert!(matches!(write.doc.get("updatedAt"), Some(Bson::DateTime(dt)) if dt.timestamp_millis() == 2_000));
  // the operation's data after beforeValidate: the given keys, then the fallbacks as they settle
  let caller = prepared.caller_data.unwrap();
  let keys: Vec<&str> = caller.as_obj().unwrap().keys().map(String::as_str).collect();
  assert_eq!(keys, ["views", "title", "author", "updatedAt", "createdAt"]);
  assert_eq!(entropy.clock.len(), 0);
  assert_eq!(entropy.ids.len(), 0);
}

#[test]
fn create_reports_upstreams_validation_error() {
  let plan = decode(&plan_json()).unwrap();
  let mut entropy = RecordedEntropy::default();
  let context = JsVal::Undefined;
  let t = translations();
  let mut ctx = WriteCtx {
    context: &context,
    entropy: &mut entropy,
    fallback_language: &[],
    language: "en",
    override_access: true,
    t: Some(&t),
    user: None,
  };
  let prepared = prepare_create(&plan, &data(json!({ "views": 1 })), &mut ctx).unwrap();
  let invalid = prepared.outcome.unwrap_err();
  assert_eq!(invalid.errors.len(), 1);
  assert_eq!(invalid.errors[0].label, "Title");
  assert_eq!(invalid.errors[0].message, "This field is required.");
  assert_eq!(invalid.errors[0].path, "title");
  // `recordNewDoc` ran before the traversal (`{ _status: {} }` is not empty)
  assert!(prepared.context_writes.iter().any(|(k, v)| k == "_isNewDoc" && matches!(v, JsVal::Bool(false))));
}

#[test]
fn a_validation_failure_without_translations_bails() {
  let plan = decode(&plan_json()).unwrap();
  let mut entropy = RecordedEntropy::default();
  let context = JsVal::Undefined;
  let mut ctx =
    WriteCtx { context: &context, entropy: &mut entropy, fallback_language: &[], language: "en", override_access: true, t: None, user: None };
  assert!(prepare_create(&plan, &data(json!({})), &mut ctx).is_err());
}

#[test]
fn a_missing_reading_bails() {
  let plan = decode(&plan_json()).unwrap();
  let mut entropy = RecordedEntropy::default();
  let context = JsVal::Undefined;
  let t = translations();
  let mut ctx = WriteCtx {
    context: &context,
    entropy: &mut entropy,
    fallback_language: &[],
    language: "en",
    override_access: true,
    t: Some(&t),
    user: None,
  };
  let bail = prepare_create(&plan, &data(json!({ "title": "x" })), &mut ctx).unwrap_err();
  assert_eq!(bail.0, "entropy:clock");
}

#[test]
fn update_casts_the_set_in_reverse_key_order_and_applies_it() {
  let plan = decode(&plan_json()).unwrap();
  let mut entropy = RecordedEntropy::default();
  entropy.clock.push_back(5_000.0);
  let stored = doc! { "_id": Bson::ObjectId([1; 12].into()), "title": "a", "views": 3.0, "legacy": true, "__v": 0 };
  let read = data(json!({ "title": "a", "views": 3, "id": "010101010101010101010101" }));
  let input = UpdateInput { doc_with_locales: read.clone(), original_doc: read, stored };
  let context = JsVal::Undefined;
  let t = translations();
  let mut ctx = WriteCtx {
    context: &context,
    entropy: &mut entropy,
    fallback_language: &[],
    language: "en",
    override_access: true,
    t: Some(&t),
    user: None,
  };
  let id = JsVal::str("010101010101010101010101");
  let prepared = prepare_update(&plan, &id, &data(json!({ "views": -0.0 })), &input, &mut ctx).unwrap();
  let write = prepared.outcome.unwrap();
  let set = write.doc.get_document("$set").unwrap();
  let keys: Vec<&str> = set.keys().map(String::as_str).collect();
  // `{ ...data, id }` after beforeValidate, `updatedAt` stamped, reversed; `id` (virtual) and the
  // `undefined` fallbacks dropped
  assert_eq!(keys, ["updatedAt", "title", "views"]);
  assert!(matches!(set.get("views"), Some(Bson::Double(n)) if *n == 0.0 && n.is_sign_negative()));
  let after = write.stored_after.unwrap();
  let keys: Vec<&str> = after.keys().map(String::as_str).collect();
  assert_eq!(keys, ["_id", "title", "views", "legacy", "__v", "updatedAt"]);
}
