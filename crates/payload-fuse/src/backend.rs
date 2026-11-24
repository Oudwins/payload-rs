//! The database side of a fused read (packages/engine-rs/FUSE_CONTRACT.md section 6).

use payload_engine::js::JsVal;

/// Why a fused call gives up: the operation then runs on the exact lane (which produces
/// upstream's result or error). The reason only feeds the stats.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bail(pub String);

impl Bail {
  pub fn new(reason: impl Into<String>) -> Self {
    Bail(reason.into())
  }
}

pub type FuseResult<T> = Result<T, Bail>;

/// The reads of one fused operation, run in order on one connection.
pub trait ReadSession {
  /// `payload.db.find(args)`: the paginated result exactly as the TS adapter returns it.
  fn find(&mut self, args: &JsVal) -> FuseResult<JsVal>;
  /// `payload.db.findOne(args)`: the document or `null`.
  fn find_one(&mut self, args: &JsVal) -> FuseResult<JsVal>;
  /// `payload.db.count(args)`: `{ totalDocs }`.
  fn count(&mut self, args: &JsVal) -> FuseResult<JsVal>;

  /// Optional: `find` (`one: false`) or `findOne` (`one: true`) together with the operation's
  /// per-document work (auth `collection` key, `afterRead` of `read`), written directly as the
  /// result JSON. `None`: not available for this call (the core then calls `find` / `find_one`
  /// and runs `afterRead` itself). A `findOne` without a document must bail.
  fn find_json(&mut self, _args: &JsVal, _one: bool, _read: &DirectRead<'_>) -> Option<FuseResult<String>> {
    None
  }

  /// A nested `payload.find` of relationship population: `payload.db.find(args)` (unpaginated,
  /// `where: { and: [{ id: { in: ids } }] }`) of the collection `related`, its documents as the
  /// adapter returns them.
  fn populate_find(&mut self, args: &JsVal, _related: &Related, _ids: &[JsVal]) -> FuseResult<Vec<JsVal>> {
    match self.find(args)?.get("docs") {
      JsVal::Arr(docs) => Ok(docs.iter().cloned().collect()),
      _ => Err(Bail::new("populate:docs")),
    }
  }
}

/// What [`ReadSession::find_json`] applies after the database call.
pub struct DirectRead<'a> {
  pub read: &'a crate::after_read::ReadArgs<'a>,
  pub select: Option<&'a JsVal>,
  pub select_mode: Option<crate::after_read::SelectMode>,
  /// auth collection: `{ ...doc, collection: slug }`
  pub auth: bool,
  /// Relationship population (depth >= 1); `None`: a call that would populate bails.
  pub population: Option<&'a Population>,
}

/// What the nested `payload.find` calls of relationship population (`batchAndLoadDocs`) need
/// beyond the operation's own inputs (FUSE_CONTRACT.md section 9). Only with `overrideAccess`,
/// locales the nested finds keep and a fresh request dataloader (the TS side checks).
#[derive(Debug)]
pub struct Population {
  /// the operation's `draft` (nested finds pass it on)
  pub draft: bool,
  /// `payload.db.find` `joins` of the nested finds (`false` for GraphQL, else `{}`)
  pub joins: JsVal,
  /// `payload.db.find` `locale` / `req` of the nested finds
  pub locale: JsVal,
  pub req: JsVal,
  /// the collections population may reach, by slug (absent: a load of it bails)
  pub related: std::collections::HashMap<String, Related>,
}

/// One collection nested finds may read.
#[derive(Debug)]
pub struct Related {
  pub plan: std::sync::Arc<crate::plan::CollectionPlan>,
  /// the nested find's `select` (`populate?.[slug] ?? defaultPopulate`, `deletedAt` added with
  /// trash) and its mode
  pub select: Option<JsVal>,
  pub select_mode: Option<crate::after_read::SelectMode>,
  /// `sanitizeSortQuery` of the collection's `defaultSort`
  pub sort: JsVal,
  pub trash: bool,
  /// `customIDType || payload.db.defaultIDType` is `number`
  pub number_id: bool,
  pub auth: bool,
  /// What the backend needs for this collection's nested finds besides their `payload.db.find`
  /// args (MongoDB: the collection name, transform plan, cast sort and projection).
  pub backend: JsVal,
}

/// A job of one fused operation: everything after the request was decoded, run with the
/// backend's session (on the backend's thread). Returns the result JSON text.
pub type Job = Box<dyn FnOnce(&mut dyn ReadSession) -> FuseResult<String> + Send>;

/// A database backend of the fused lanes. Implementations must not call JS.
pub trait FusedBackend {
  /// `"sqlite"`, `"mongodb"`: stats and bail reasons.
  fn name(&self) -> &'static str;
  /// Runs `job` with a read session on the backend connection `conn` (the id the TS target
  /// lookup returned) and returns its result. Blocks until the job finished.
  fn run(&self, conn: u32, job: Job) -> FuseResult<String>;
}
