//! The JSON entry of the write-side library (`fuseWritePrepare`, used by the differential
//! corpus test/__rs/fuse-writes and available to the shadow): one request in, one result out.
//!
//! Request: `{ op: 'create' | 'update', data, id?, originalDoc?, docWithLocales?, user?:
//! [collection, id], overrideAccess, context, language, fallbackLanguage, translations?, clock:
//! [ms], ids: [['row' | 'document' | 'version', hex]] }`, values in the boundary's tree
//! encoding (`decode_value_bson`); `stored` (update) is the stored document's BSON.
//!
//! Result: `{ bail }` or `{ callerData, contextWrites: [[key, value]], invalid?: { collection,
//! errors }, doc?, storedAfter?, version?: { doc, flipFilter, flipUpdate }, clockLeft, idsLeft }`
//! with BSON documents as hex.

use serde_json::{Value as Json, json};

use payload_core_validate::I18n;
use payload_engine::bson::object_id_bytes_from_hex;
use payload_engine::js::{JsVal, decode_value_bson, encode_value_text};
use payload_mongo_driver::mongodb::bson::Document;

use super::plan::decode;
use super::{Bail, IdUse, RecordedEntropy, UpdateInput, WriteCtx, prepare_create, prepare_update};

fn hex(doc: &Document) -> Result<String, Bail> {
  let mut bytes = Vec::new();
  doc.to_writer(&mut bytes).map_err(|e| Bail::new(format!("bson:{e}")))?;
  Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn value(request: &Json, key: &str) -> Result<JsVal, Bail> {
  match request.get(key) {
    None => Ok(JsVal::Undefined),
    Some(tree) => decode_value_bson(tree).map_err(|e| Bail::new(format!("request:{key}:{e}"))),
  }
}

pub fn prepare_json(plan_json: &str, request_json: &str, stored: Option<&[u8]>) -> String {
  match run(plan_json, request_json, stored) {
    Ok(out) => out,
    Err(Bail(reason)) => json!({ "bail": reason }).to_string(),
  }
}

fn run(plan_json: &str, request_json: &str, stored: Option<&[u8]>) -> Result<String, Bail> {
  let plan = decode(plan_json).map_err(Bail::new)?;
  let request: Json = serde_json::from_str(request_json).map_err(|e| Bail::new(format!("request:{e}")))?;
  let mut entropy = RecordedEntropy::default();
  for ms in request.get("clock").and_then(Json::as_array).into_iter().flatten() {
    entropy.clock.push_back(ms.as_f64().ok_or_else(|| Bail::new("request:clock"))?);
  }
  for entry in request.get("ids").and_then(Json::as_array).into_iter().flatten() {
    let kind = match entry.get(0).and_then(Json::as_str) {
      Some("row") => IdUse::Row,
      Some("document") => IdUse::Document,
      Some("version") => IdUse::Version,
      _ => return Err(Bail::new("request:ids")),
    };
    let bytes = entry.get(1).and_then(Json::as_str).and_then(object_id_bytes_from_hex).ok_or_else(|| Bail::new("request:ids"))?;
    entropy.ids.push_back((kind, bytes));
  }
  let user = match request.get("user") {
    Some(Json::Array(parts)) if parts.len() == 2 => Some((
      parts[0].as_str().ok_or_else(|| Bail::new("request:user"))?.to_string(),
      decode_value_bson(&parts[1]).map_err(|_| Bail::new("request:user"))?,
    )),
    _ => None,
  };
  let i18n = request.get("translations").filter(|t| t.is_object()).map(|t| I18n { translations: JsVal::from_json(t) });
  let context = value(&request, "context")?;
  let language = request.get("language").and_then(Json::as_str).unwrap_or("en").to_string();
  let fallback_language: Vec<String> = match request.get("fallbackLanguage") {
    Some(Json::String(s)) => vec![s.clone()],
    Some(Json::Array(items)) => items.iter().filter_map(|s| s.as_str().map(str::to_string)).collect(),
    _ => Vec::new(),
  };
  let data = value(&request, "data")?;
  let locale = request.get("locale").and_then(Json::as_str).map(str::to_string);
  let mut ctx = WriteCtx {
    locale: locale.as_deref(),
    context: &context,
    entropy: &mut entropy,
    fallback_language: &fallback_language,
    language: &language,
    override_access: request.get("overrideAccess").and_then(Json::as_bool).unwrap_or(false),
    t: i18n.as_ref().map(|i| i as &dyn payload_core_validate::Translate),
    user,
  };
  let prepared = match request.get("op").and_then(Json::as_str) {
    Some("create") => prepare_create(&plan, &data, &mut ctx)?,
    Some("update") => {
      let stored = stored.ok_or_else(|| Bail::new("request:stored"))?;
      let stored = Document::from_reader(stored).map_err(|e| Bail::new(format!("request:stored:{e}")))?;
      let input = UpdateInput { doc_with_locales: value(&request, "docWithLocales")?, original_doc: value(&request, "originalDoc")?, stored };
      prepare_update(&plan, &value(&request, "id")?, &data, &input, &mut ctx)?
    }
    _ => return Err(Bail::new("request:op")),
  };
  drop(ctx);
  let mut out = serde_json::Map::new();
  // values as `encode_value_text` writes them (`-0` kept), spliced below
  let caller_data = prepared.caller_data.as_ref().map(encode_value_text);
  let context_writes: Vec<String> = prepared
    .context_writes
    .iter()
    .map(|(k, v)| format!("[{},{}]", Json::String(k.clone()), encode_value_text(v)))
    .collect();
  match &prepared.outcome {
    Err(invalid) => {
      let errors: Vec<Json> =
        invalid.errors.iter().map(|e| json!({ "label": e.label, "message": e.message, "path": e.path })).collect();
      out.insert("invalid".to_string(), json!({ "collection": invalid.collection, "errors": errors }));
    }
    Ok(write) => {
      out.insert("doc".to_string(), Json::String(hex(&write.doc)?));
      if let Some(after) = &write.stored_after {
        out.insert("storedAfter".to_string(), Json::String(hex(after)?));
      }
      if let Some(version) = &write.version {
        out.insert(
          "version".to_string(),
          json!({ "doc": hex(&version.doc)?, "flipFilter": hex(&version.flip_filter)?, "flipUpdate": hex(&version.flip_update)? }),
        );
      }
    }
  }
  out.insert("clockLeft".to_string(), json!(entropy.clock.len()));
  out.insert("idsLeft".to_string(), json!(entropy.ids.len()));
  let rest = Json::Object(out).to_string();
  let mut text = format!("{{\"contextWrites\":[{}]", context_writes.join(","));
  if let Some(caller_data) = caller_data {
    text.push_str(",\"callerData\":");
    text.push_str(&caller_data);
  }
  if rest.len() > 2 {
    text.push(',');
    text.push_str(&rest[1..]);
  } else {
    text.push('}');
  }
  Ok(text)
}
