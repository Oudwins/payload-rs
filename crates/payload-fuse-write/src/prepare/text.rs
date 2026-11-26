//! The JSON entry of the write-side library (`fuseWritePrepare`, used by the differential
//! corpus test/__rs/fuse-writes and available to the shadow): one request in, one result out.
//!
//! Request: `{ op: 'create' | 'update', data, id?, originalDoc?, docWithLocales?, user?:
//! [collection, id], overrideAccess, context, language, fallbackLanguage, translations?, clock:
//! [ms], ids: [['row' | 'document' | 'version', hex]], draft?, autosave?, req? }` (`req`: the
//! `encodeSnapshot(snapshotRequest(req))` compiled user functions read), values in the boundary's tree
//! encoding (`decode_value_bson`); `stored` (update) is the stored document's BSON.
//!
//! Result: `{ bail }` or `{ callerData, contextWrites: [[key, value]], invalid?: { collection,
//! errors }, doc?, storedAfter?, draft?: true (a draft save: no `doc`), version?: { doc,
//! flipFilter, flipUpdate }, clockLeft, idsLeft }` with BSON documents as hex.

use serde_json::{Value as Json, json};

use payload_core_validate::I18n;
use payload_engine::bson::object_id_bytes_from_hex;
use payload_engine::js::{JsVal, decode_value_bson, encode_value_text};
use payload_mongo_driver::mongodb::bson::Document;

use super::plan::decode;
use super::plan::WritePlan;
use super::{Bail, IdUse, Prepared, RecordedEntropy, UpdateInput, WriteCtx, prepare_create, prepare_update};

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

/// The request-derived inputs of one prepare call.
struct Request {
  json: Json,
  entropy: RecordedEntropy,
  user: Option<(String, JsVal)>,
  i18n: Option<I18n>,
  context: JsVal,
  language: String,
  fallback_language: Vec<String>,
  data: JsVal,
  locale: Option<String>,
  override_access: bool,
  field_access: Vec<Option<bool>>,
  draft: bool,
  autosave: bool,
  req: Option<payload_fn_ir::Value>,
}

fn parse(request_json: &str) -> Result<Request, Bail> {
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
  let override_access = request.get("overrideAccess").and_then(Json::as_bool).unwrap_or(false);
  let field_access = match request.get("fieldAccess") {
    None | Some(Json::Null) => Vec::new(),
    Some(Json::Array(items)) => items
      .iter()
      .map(|item| match item {
        Json::Null => Ok(None),
        Json::Bool(result) => Ok(Some(*result)),
        _ => Err(Bail::new("request:fieldAccess")),
      })
      .collect::<Result<_, _>>()?,
    Some(_) => return Err(Bail::new("request:fieldAccess")),
  };
  let draft = request.get("draft").and_then(Json::as_bool).unwrap_or(false);
  let autosave = request.get("autosave").and_then(Json::as_bool).unwrap_or(false);
  let req = match request.get("req") {
    None | Some(Json::Null) => None,
    Some(snapshot) => Some(super::user_fn::request_value(snapshot)?),
  };
  Ok(Request { json: request, entropy, user, i18n, context, language, fallback_language, data, locale, override_access, field_access, draft, autosave, req })
}

impl Request {
  fn ctx(&mut self) -> WriteCtx<'_> {
    WriteCtx {
      locale: self.locale.as_deref(),
      context: &self.context,
      entropy: &mut self.entropy,
      fallback_language: &self.fallback_language,
      language: &self.language,
      override_access: self.override_access,
      field_access: &self.field_access,
      t: self.i18n.as_ref().map(|i| i as &dyn payload_core_validate::Translate),
      user: self.user.clone(),
      draft: self.draft,
      autosave: self.autosave,
      req: self.req.clone(),
    }
  }

  /// Readings the call did not take (clock, ids).
  fn left(&self) -> (usize, usize) {
    (self.entropy.clock.len(), self.entropy.ids.len())
  }
}

/// What a driver-run prepare produced: the outcome, the readings it did not take (clock, ids)
/// and `contextWrites` as the JSON text `[[key, value], ...]` (values in the boundary's tree
/// encoding).
pub struct DriverPrepared {
  pub prepared: Prepared,
  pub left: (usize, usize),
  pub context_writes: String,
}

/// `prepare_update` with the request `request_json` (this module's format; `stored`,
/// `docWithLocales`, `originalDoc` come from `input`, the operation driver's stored-document read).
pub fn prepare_update_request(plan: &WritePlan, request_json: &str, input: &UpdateInput) -> Result<DriverPrepared, Bail> {
  let mut request = parse(request_json)?;
  let id = value(&request.json, "id")?;
  let data = request.data.clone();
  let prepared = prepare_update(plan, &id, &data, input, &mut request.ctx())?;
  let left = request.left();
  let context_writes = format!("[{}]", context_writes_text(&prepared).join(","));
  Ok(DriverPrepared { prepared, left, context_writes })
}

fn context_writes_text(prepared: &Prepared) -> Vec<String> {
  prepared
    .context_writes
    .iter()
    .map(|(k, v)| format!("[{},{}]", Json::String(k.clone()), encode_value_text(v)))
    .collect()
}

fn run(plan_json: &str, request_json: &str, stored: Option<&[u8]>) -> Result<String, Bail> {
  let plan = decode(plan_json).map_err(Bail::new)?;
  let mut request = parse(request_json)?;
  let data = request.data.clone();
  let prepared = match request.json.get("op").and_then(Json::as_str) {
    Some("create") => prepare_create(&plan, &data, &mut request.ctx())?,
    Some("update") => {
      let stored = stored.ok_or_else(|| Bail::new("request:stored"))?;
      let stored = Document::from_reader(stored).map_err(|e| Bail::new(format!("request:stored:{e}")))?;
      let input = UpdateInput {
        doc_with_locales: value(&request.json, "docWithLocales")?,
        original_doc: value(&request.json, "originalDoc")?,
        stored,
      };
      let id = value(&request.json, "id")?;
      prepare_update(&plan, &id, &data, &input, &mut request.ctx())?
    }
    _ => return Err(Bail::new("request:op")),
  };
  let mut out = serde_json::Map::new();
  // values as `encode_value_text` writes them (`-0` kept), spliced below
  let caller_data = prepared.caller_data.as_ref().map(encode_value_text);
  let context_writes = context_writes_text(&prepared);
  match &prepared.outcome {
    Err(invalid) => {
      let errors: Vec<Json> =
        invalid.errors.iter().map(|e| json!({ "label": e.label, "message": e.message, "path": e.path })).collect();
      out.insert("invalid".to_string(), json!({ "collection": invalid.collection, "errors": errors }));
    }
    Ok(write) if write.draft => {
      out.insert("draft".to_string(), Json::Bool(true));
      if let Some(version) = &write.version {
        out.insert(
          "version".to_string(),
          json!({ "doc": hex(&version.doc)?, "flipFilter": hex(&version.flip_filter)?, "flipUpdate": hex(&version.flip_update)? }),
        );
      }
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
  let (clock_left, ids_left) = request.left();
  out.insert("clockLeft".to_string(), json!(clock_left));
  out.insert("idsLeft".to_string(), json!(ids_left));
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
