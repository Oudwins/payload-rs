//! Fused MongoDB writes (packages/engine-rs/FUSED_WRITES.md): the statements of one write
//! operation, in upstream's order, in a transaction the Rust client owns; then the operation's
//! `afterRead` (and population, its nested reads in the same transaction) on the document the
//! statements stored or changed, through the fused read core (crates/payload-fuse-mongo
//! `run_document`); then the commit. No JS runs between the statements.
//!
//! The statements arrive as the commands the Node driver would send (BSON as the TS side
//! serialized them, packages/engine-rs/src/fuse-write).

pub mod bulk;
pub mod by_id;
pub mod ops;
pub mod prepare;
pub mod state;
pub mod unique;

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use payload_fuse_mongo::MongoReads;
use payload_mongo_driver::mongodb::bson::{Bson, Document, RawArrayBuf, RawBsonRef, RawDocument, RawDocumentBuf, rawdoc};
use payload_mongo_driver::{command_raw, database_name, txn_command_raw, txn_end};

/// Which document of a statement the operation's result is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultOf {
  None,
  /// `insert`: the inserted document (`documents[0]`, the stored document).
  Inserted,
  /// `findAndModify`: the reply's `value` (after the update, or the removed document).
  Value,
}

pub struct Statement {
  pub database: Option<String>,
  pub command: RawDocumentBuf,
  /// Inside the operation's transaction; `false`: a statement upstream sends without a session.
  pub in_txn: bool,
  pub result: ResultOf,
}

/// The fused read of the operation's result.
pub struct ResultRead {
  pub plan: u32,
  pub reads: MongoReads,
  pub request_json: String,
}

/// Decodes `{ s: [{ c: <command>, t: <in txn>, r: 0 | 1 | 2, d?: <database> }] }`.
pub fn decode_statements(bytes: &[u8]) -> Result<Vec<Statement>, String> {
  let doc = payload_mongo_driver::mongodb::bson::RawDocument::from_bytes(bytes).map_err(|e| e.to_string())?;
  let list = doc.get_array("s").map_err(|e| e.to_string())?;
  let mut out = Vec::new();
  for item in list {
    let RawBsonRef::Document(item) = item.map_err(|e| e.to_string())? else {
      return Err("statement".to_string());
    };
    let command = item.get_document("c").map_err(|e| e.to_string())?.to_raw_document_buf();
    let in_txn = item.get_bool("t").map_err(|e| e.to_string())?;
    let result = match item.get_i32("r").map_err(|e| e.to_string())? {
      1 => ResultOf::Inserted,
      2 => ResultOf::Value,
      _ => ResultOf::None,
    };
    let database = item.get_str("d").ok().map(str::to_string);
    out.push(Statement { command, database, in_txn, result });
  }
  Ok(out)
}

/// Runs `statements` in order (in transaction `txn` where `in_txn`), then `read` on the result
/// document, then commits. Returns the read's result text (`null` without a read); `!<reason>`
/// when the call must run on the exact lane (nothing is committed: the transaction is aborted);
/// `!!<error JSON>` when the commit failed (its outcome is the error upstream throws).
pub async fn exec(client: u32, txn: u32, statements: Vec<Statement>, read: Option<ResultRead>) -> String {
  exec_shadowed(client, txn, statements, read, None).await.text
}

/// What a fused write produced: the result text (see [`exec`]) and, in the write lane-shadow, the
/// state of the touched collections inside the transaction (which is then aborted, not committed).
pub struct Outcome {
  pub text: String,
  pub state: Option<String>,
  /// updateByID: the prepare's `req.context` writes (`[[key, value], ...]` in the boundary's tree
  /// encoding), replayed by JS on success.
  pub context: Option<String>,
}

/// [`exec`]; with `state` (the write lane-shadow, FUSED_WRITES.md section 9) the touched
/// collections are read inside the transaction after the result read, and the transaction is
/// aborted instead of committed.
pub async fn exec_shadowed(
  client: u32,
  txn: u32,
  statements: Vec<Statement>,
  read: Option<ResultRead>,
  state: Option<(Option<String>, Vec<state::StateRead>)>,
) -> Outcome {
  let text = exec_inner(client, txn, statements, read, state.as_ref()).await;
  match text {
    Ok((text, state)) => Outcome { text, state, context: None },
    Err(text) => Outcome { text, state: None, context: None },
  }
}

async fn exec_inner(
  client: u32,
  txn: u32,
  statements: Vec<Statement>,
  read: Option<ResultRead>,
  state: Option<&(Option<String>, Vec<state::StateRead>)>,
) -> Result<(String, Option<String>), String> {
  let mut result_doc: Option<RawDocumentBuf> = None;
  if is_merging() && statements.len() > 1 && statements.iter().all(|s| s.in_txn && s.result != ResultOf::Value) {
    // a create's inserts and latest flip: one `bulkWrite`
    result_doc = statements.iter().rfind(|s| s.result == ResultOf::Inserted).and_then(|s| inserted_document(&s.command));
    let writes = statements.into_iter().map(|s| (s.database, s.command)).collect();
    if let Err(reason) = send_writes(client, txn, writes).await {
      return Err(abort(txn, reason).await);
    }
    return read_and_finish(client, txn, result_doc, read, state).await;
  }
  for statement in statements {
    let Statement { command, database, in_txn, result } = statement;
    let inserted = if result == ResultOf::Inserted { inserted_document(&command) } else { None };
    let reply = match send(client, txn, database, command, in_txn).await {
      Ok(reply) => reply,
      Err(reason) => return Err(abort(txn, reason).await),
    };
    match result {
      ResultOf::None => {}
      ResultOf::Inserted => result_doc = inserted,
      ResultOf::Value => {
        result_doc = match reply.get("value") {
          Some(Bson::Document(value)) => match RawDocumentBuf::from_document(value) {
            Ok(raw) => Some(raw),
            Err(_) => return Err(abort(txn, "!statement:value".to_string()).await),
          },
          _ => None,
        }
      }
    }
  }
  read_and_finish(client, txn, result_doc, read, state).await
}

/// The result read of `result_doc`, then [`finish`].
async fn read_and_finish(
  client: u32,
  txn: u32,
  result_doc: Option<RawDocumentBuf>,
  read: Option<ResultRead>,
  state: Option<&(Option<String>, Vec<state::StateRead>)>,
) -> Result<(String, Option<String>), String> {
  let text = match read {
    Some(ResultRead { plan, reads, request_json }) => {
      let text = payload_fuse_mongo::run_document(client, plan, &reads, result_doc, &request_json, Some(txn), false);
      if text.starts_with('!') {
        return Err(abort(txn, text).await);
      }
      text
    }
    None => "null".to_string(),
  };
  finish(client, txn, text, state).await
}

/// Sends one statement (in transaction `txn` where `in_txn`, else without a session) and checks
/// its reply; `Err` is the bail reason (the caller aborts).
async fn send(client: u32, txn: u32, database: Option<String>, command: RawDocumentBuf, in_txn: bool) -> Result<Document, String> {
  let reply =
    if in_txn { txn_command_raw(txn, database, command).await } else { command_raw(client, database, command).await };
  let reply = reply.map_err(|error| format!("!statement:{error}"))?;
  if let Some(Bson::Array(errors)) = reply.get("writeErrors") {
    if !errors.is_empty() {
      return Err("!statement:writeErrors".to_string());
    }
  }
  Ok(reply)
}

/// Whether independent statements of a fused write share a round trip (FUSED_WRITES.md section
/// 13, "Merged statements"); `PAYLOAD_RS_FUSE_WRITES_MERGE=off` sends one command per statement
/// (a measurement switch).
pub(crate) fn is_merging() -> bool {
  static IS_MERGING: OnceLock<bool> = OnceLock::new();
  let is_on = *IS_MERGING.get_or_init(|| std::env::var("PAYLOAD_RS_FUSE_WRITES_MERGE").ok().is_none_or(|value| value != "off"));
  is_on && !IS_MERGE_UNSUPPORTED.load(Ordering::Relaxed)
}

/// Set once a server refused a merged command (`bulkWrite` before MongoDB 8.0, a stage some
/// compatible servers lack): the write that sent it bails, the later ones send their statements
/// one by one.
static IS_MERGE_UNSUPPORTED: AtomicBool = AtomicBool::new(false);

/// The bail of a merged command's failure (`!statement:<error JSON>`); a refusal of the command or
/// a stage itself turns merging off for the process.
pub(crate) fn merged_command_failed(error: String) -> String {
  const UNSUPPORTED: [&str; 4] = ["CommandNotFound", "CommandNotSupported", "OperationNotSupportedInTransaction", "Location40324"];
  if let Ok(error) = serde_json::from_str::<serde_json::Value>(&error) {
    let code = error.get("code").and_then(serde_json::Value::as_i64);
    let name = error.get("codeName").and_then(serde_json::Value::as_str);
    if matches!(code, Some(59 | 115 | 263 | 40324)) || name.is_some_and(|name| UNSUPPORTED.contains(&name)) {
      IS_MERGE_UNSUPPORTED.store(true, Ordering::Relaxed);
    }
  }
  format!("!statement:{error}")
}

/// Sends write commands (`insert` / `update` / `delete`, as the Node driver builds them) in
/// transaction `txn`, in order: when merging and there are several, as one `bulkWrite` command
/// (MongoDB 8.0: the same writes, ordered, one round trip). Each command's affected count (`n`).
pub(crate) async fn send_writes(client: u32, txn: u32, writes: Vec<(Option<String>, RawDocumentBuf)>) -> Result<Vec<i64>, String> {
  if writes.len() > 1 && is_merging() {
    if let Some((command, owners)) = bulk_write_command(client, &writes)? {
      return send_bulk_write(txn, command, &owners, writes.len()).await;
    }
  }
  let mut counts = Vec::with_capacity(writes.len());
  for (database, command) in writes {
    let reply = send(client, txn, database, command, true).await?;
    counts.push(reply.get("n").and_then(count_of).unwrap_or(0));
  }
  Ok(counts)
}

/// The `bulkWrite` command of `writes` and, per op, the index of the write it came from; `None`
/// when a write has an option `bulkWrite` would not apply the same way (it is then sent alone).
fn bulk_write_command(client: u32, writes: &[(Option<String>, RawDocumentBuf)]) -> Result<Option<(RawDocumentBuf, Vec<usize>)>, String> {
  let mut namespaces: Vec<String> = Vec::new();
  let mut ops = RawArrayBuf::new();
  let mut owners = Vec::new();
  for (owner, (database, command)) in writes.iter().enumerate() {
    let Some((kind, collection)) = command.iter().next().and_then(Result::ok).and_then(|(key, value)| Some((key, value.as_str()?))) else {
      return Ok(None);
    };
    let database = database_name(client, database.as_deref()).map_err(|_| "!mongo:client".to_string())?;
    let namespace = format!("{database}.{collection}");
    let ns = match namespaces.iter().position(|known| *known == namespace) {
      Some(index) => index,
      None => {
        namespaces.push(namespace);
        namespaces.len() - 1
      }
    };
    let Some(command_ops) = bulk_ops(command, kind, ns as i32) else { return Ok(None) };
    for op in command_ops {
      ops.push(op);
      owners.push(owner);
    }
  }
  let mut ns_info = RawArrayBuf::new();
  for namespace in namespaces {
    ns_info.push(rawdoc! { "ns": namespace });
  }
  Ok(Some((rawdoc! { "bulkWrite": 1, "ops": ops, "nsInfo": ns_info, "ordered": true, "errorsOnly": false }, owners)))
}

/// The `bulkWrite` ops of one write command: `insert` (`documents`), `update` (`updates`: `q`, `u`
/// a document, `multi`, `upsert`) or `delete` (`deletes`: `q`, `limit`), with `ordered: true` and
/// no other option.
fn bulk_ops(command: &RawDocument, kind: &str, ns: i32) -> Option<Vec<RawDocumentBuf>> {
  let entries_key = match kind {
    "insert" => "documents",
    "update" => "updates",
    "delete" => "deletes",
    _ => return None,
  };
  for item in command {
    let (key, value) = item.ok()?;
    if key != kind && key != entries_key && !(key == "ordered" && value.as_bool() == Some(true)) {
      return None;
    }
  }
  let mut ops = Vec::new();
  for entry in command.get_array(entries_key).ok()? {
    let entry = entry.ok()?.as_document()?;
    if kind == "insert" {
      ops.push(rawdoc! { "insert": ns, "document": entry.to_raw_document_buf() });
      continue;
    }
    let (mut filter, mut mods, mut is_multi, mut is_upsert, mut limit) = (None, None, false, false, None);
    for item in entry {
      let (key, value) = item.ok()?;
      match (kind, key) {
        (_, "q") => filter = Some(value.as_document()?.to_raw_document_buf()),
        ("update", "u") => mods = Some(value.as_document()?.to_raw_document_buf()),
        ("update", "multi") => is_multi = value.as_bool()?,
        ("update", "upsert") => is_upsert = value.as_bool()?,
        ("delete", "limit") => limit = Some(count_of(&Bson::try_from(value.to_raw_bson()).ok()?)?),
        _ => return None,
      }
    }
    let filter = filter?;
    if kind == "update" {
      let mods = mods?;
      ops.push(rawdoc! { "update": ns, "filter": filter, "updateMods": mods, "multi": is_multi, "upsert": is_upsert });
    } else {
      let is_multi = match limit? {
        0 => true,
        1 => false,
        _ => return None,
      };
      ops.push(rawdoc! { "delete": ns, "filter": filter, "multi": is_multi });
    }
  }
  Some(ops)
}

/// Sends a `bulkWrite` (on `admin`) in transaction `txn`; the summed `n` per write (`owners`: the
/// write of each op). Any op error bails, as a write error of the separate commands does.
async fn send_bulk_write(txn: u32, command: RawDocumentBuf, owners: &[usize], writes: usize) -> Result<Vec<i64>, String> {
  let reply = txn_command_raw(txn, Some("admin".to_string()), command).await.map_err(merged_command_failed)?;
  if reply.get("nErrors").and_then(count_of) != Some(0) {
    return Err("!statement:writeErrors".to_string());
  }
  let cursor = reply.get_document("cursor").map_err(|_| "!bulkWrite:cursor")?;
  let results = cursor.get_array("firstBatch").map_err(|_| "!bulkWrite:cursor")?;
  if cursor.get("id").and_then(count_of) != Some(0) || results.len() != owners.len() {
    return Err("!bulkWrite:cursor".to_string());
  }
  let mut counts = vec![0; writes];
  for result in results {
    let result = result.as_document().ok_or("!bulkWrite:result")?;
    let ok = result.get("ok").and_then(count_of);
    let op = result.get("idx").and_then(count_of).and_then(|idx| usize::try_from(idx).ok());
    let (Some(1), Some(op), Some(n)) = (ok, op, result.get("n").and_then(count_of)) else {
      return Err("!statement:writeErrors".to_string());
    };
    counts[*owners.get(op).ok_or("!bulkWrite:result")?] += n;
  }
  Ok(counts)
}

/// An integral count (int32, int64 or a double holding one).
fn count_of(value: &Bson) -> Option<i64> {
  match value {
    Bson::Int32(n) => Some(i64::from(*n)),
    Bson::Int64(n) => Some(*n),
    Bson::Double(n) if n.fract() == 0.0 => Some(*n as i64),
    _ => None,
  }
}

/// After the result read: with `state` (the write lane-shadow) the touched collections are read
/// inside the transaction, which is then aborted; otherwise the commit.
async fn finish(
  client: u32,
  txn: u32,
  text: String,
  state: Option<&(Option<String>, Vec<state::StateRead>)>,
) -> Result<(String, Option<String>), String> {
  if let Some((database, reads)) = state {
    let state = state::read_state(client, database.as_deref(), Some(txn), reads).await;
    let _ = txn_end(txn, false).await;
    return state.map(|state| (text, Some(state))).map_err(|_| "!shadow:state".to_string());
  }
  match txn_end(txn, true).await {
    Ok(()) => Ok((text, None)),
    Err(error) => Err(format!("!!{error}")),
  }
}

fn inserted_document(command: &RawDocumentBuf) -> Option<RawDocumentBuf> {
  let documents = command.get_array("documents").ok()?;
  match documents.into_iter().next()?.ok()? {
    RawBsonRef::Document(doc) => Some(doc.to_raw_document_buf()),
    _ => None,
  }
}

async fn abort(txn: u32, reason: String) -> String {
  let _ = txn_end(txn, false).await;
  reason
}
