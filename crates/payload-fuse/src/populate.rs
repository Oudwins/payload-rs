//! Relationship population (depth >= 1) of a fused operation: upstream's dataloader
//! (`packages/payload/src/collections/dataloader.ts`, `relationshipPopulationPromise.ts`)
//! reproduced for one operation that starts with an empty dataloader.
//!
//! Upstream: the `afterRead` of every document of a find runs synchronously up to its loads, so
//! the loads of one level form one batch (keys in load order, a repeated key served from the
//! cache, i.e. the same object). `batchAndLoadDocs` groups the batch by everything in the key but
//! the id, in first-appearance order, and runs one `payload.find({ where: { id: { in: ids } } })`
//! per group, one after the other; each nested find's own `afterRead` loads the next level (its
//! own batch, served before the nested find returns). Documents are matched to keys by id;
//! keys without a document resolve to `null` (the relationship keeps its id), a trashed document
//! resolves to the document (cached) but the relationship becomes `null`; hasMany values drop
//! their `null`s.
//!
//! Here: [`PopRun`] is the dataloader of the call (keys in cache insertion order, the documents),
//! [`resolve_level`] runs the batches depth first like upstream and fills the slots, and
//! [`write_result`] writes the result with its shared documents (one object per key, as upstream
//! returns them) and what the TS side needs to reproduce the observable state: the dataloader
//! cache entries (to prime, in order) and the nested finds (their `req` mutations).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use payload_engine::js::{JsVal, Obj, write_json_string};

use crate::after_read::{FieldAccess, ReadArgs, Seg, after_read_docs, lane_call, obj_mut, resolve};
use crate::backend::{Bail, FuseResult, Population, ReadSession};
use crate::write;

/// The loads one document recorded: slots `(path, key, polymorphic)` and the hasMany arrays to
/// filter `(path, polymorphic)`, paths from the document root.
#[derive(Default)]
pub(crate) struct DocLoads {
  pub slots: Vec<(Vec<Seg>, usize, bool)>,
  pub filters: Vec<(Vec<Seg>, bool)>,
}

/// A dataloader key of the call: the parts of upstream's key that vary within one call.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
  slug: String,
  depth: u64,
  current_depth: u64,
  id: IdKey,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum IdKey {
  Num(u64),
  Str(String),
}

enum Loaded {
  Pending,
  /// no document (`null`)
  Missing,
  Doc(JsVal),
}

/// The dataloader of one fused call.
pub(crate) struct PopRun<'p> {
  request: &'p Population,
  /// the compiled functions the operation used (`after_read::lane_call`)
  checked: &'p std::sync::Mutex<Vec<payload_fn_ir::FnId>>,
  keys: Vec<Key>,
  ids: Vec<JsVal>,
  index: HashMap<Key, usize>,
  values: Vec<Loaded>,
  pending: Vec<usize>,
  /// the populate depth of each nested find, in the order they start
  nested: Vec<f64>,
}

fn number_key(n: f64) -> u64 {
  // `JSON.stringify(-0)` is `0`
  if n == 0.0 { 0.0f64.to_bits() } else { n.to_bits() }
}

impl<'p> PopRun<'p> {
  pub fn new(request: &'p Population, checked: &'p std::sync::Mutex<Vec<payload_fn_ir::FnId>>) -> Self {
    Self {
      request,
      checked,
      keys: Vec::new(),
      ids: Vec::new(),
      index: HashMap::new(),
      values: Vec::new(),
      pending: Vec::new(),
      nested: Vec::new(),
    }
  }

  pub fn is_empty(&self) -> bool {
    self.keys.is_empty()
  }

  /// `load(createDataloaderCacheKey({ collectionSlug, currentDepth, depth, docID, ... }))`: the
  /// key's index (a key seen before is the cached entry).
  pub fn load(&mut self, slug: &str, id: JsVal, depth: f64, current_depth: f64) -> FuseResult<usize> {
    let related = self.request.related.get(slug).ok_or_else(|| Bail::new("populate:related"))?;
    // the id types the nested finds can query and match back (`parseFloat` of a number, a string
    // for text ids); anything else stays on the exact lane
    let id_key = match (&id, related.number_id) {
      (JsVal::Num(n), true) if n.is_finite() => IdKey::Num(number_key(*n)),
      (JsVal::Str(s), false) => IdKey::Str(s.to_string()),
      _ => return Err(Bail::new("populate:id")),
    };
    let key = Key { slug: slug.to_string(), depth: number_key(depth), current_depth: number_key(current_depth), id: id_key };
    if let Some(&index) = self.index.get(&key) {
      return Ok(index);
    }
    let index = self.keys.len();
    self.index.insert(key.clone(), index);
    self.keys.push(key);
    self.ids.push(id);
    self.values.push(Loaded::Pending);
    self.pending.push(index);
    Ok(index)
  }
}

/// Resolves the pending loads (the batch of this level and, depth first, every level below) and
/// fills the slots of `docs` (`loads[i]` of `docs[i]`).
pub(crate) fn resolve_level(
  run: &mut PopRun<'_>,
  session: &mut dyn ReadSession,
  args: &ReadArgs<'_>,
  docs: &mut [JsVal],
  loads: Vec<DocLoads>,
) -> FuseResult<()> {
  dispatch(run, session, args)?;
  for (doc, loads) in docs.iter_mut().zip(loads) {
    for (path, key, poly) in loads.slots {
      let value = match &run.values[key] {
        Loaded::Pending => return Err(Bail::new("populate:pending")),
        Loaded::Missing => run.ids[key].clone(),
        Loaded::Doc(found) => {
          let related = run.request.related.get(&run.keys[key].slug).ok_or_else(|| Bail::new("populate:related"))?;
          if related.trash && found.get("deletedAt").truthy() { JsVal::Null } else { found.clone() }
        }
      };
      let target = resolve(doc, &path).ok_or_else(|| Bail::new("populate:slot"))?;
      if poly {
        obj_mut(target).ok_or_else(|| Bail::new("populate:slot"))?.insert("value".to_string(), value);
      } else {
        *target = value;
      }
    }
    // `resultingDoc[field.name] = resultingDoc[field.name].filter(notNull)`
    for (path, poly) in loads.filters {
      let target = resolve(doc, &path).ok_or_else(|| Bail::new("populate:filter"))?;
      if let JsVal::Arr(items) = target {
        let kept: Vec<JsVal> = items
          .iter()
          .filter(|v| !matches!(v, JsVal::Null) && !(poly && matches!(v.get("value"), JsVal::Null)))
          .cloned()
          .collect();
        if kept.len() != items.len() {
          *target = JsVal::arr(kept);
        }
      }
    }
  }
  Ok(())
}

/// `batchAndLoadDocs` of the pending batch.
fn dispatch(run: &mut PopRun<'_>, session: &mut dyn ReadSession, args: &ReadArgs<'_>) -> FuseResult<()> {
  let batch = std::mem::take(&mut run.pending);
  if batch.is_empty() {
    return Ok(());
  }
  // groups (everything but the id) in first-appearance order; invalid ids (`isValidID`) query
  // nothing
  let mut groups: Vec<Vec<usize>> = Vec::new();
  for &k in &batch {
    let key = &run.keys[k];
    if matches!(&key.id, IdKey::Str(s) if s.is_empty()) {
      continue;
    }
    match groups.iter_mut().find(|group| {
      let first = &run.keys[group[0]];
      first.slug == key.slug && first.depth == key.depth && first.current_depth == key.current_depth
    }) {
      Some(group) => group.push(k),
      None => groups.push(vec![k]),
    }
  }
  for group in groups {
    nested_find(run, session, args, &group)?;
  }
  for k in batch {
    if matches!(run.values[k], Loaded::Pending) {
      run.values[k] = Loaded::Missing;
    }
  }
  Ok(())
}

/// One `payload.find({ collection, currentDepth, depth, pagination: false, where: { id: { in } } })`
/// of a batch group: the documents with their own `afterRead` (and population), matched to the
/// group's keys.
fn nested_find(run: &mut PopRun<'_>, session: &mut dyn ReadSession, args: &ReadArgs<'_>, group: &[usize]) -> FuseResult<()> {
  let request = run.request;
  let first = run.keys[group[0]].clone();
  let related = request.related.get(&first.slug).ok_or_else(|| Bail::new("populate:related"))?;
  let depth = f64::from_bits(first.depth);
  let current_depth = f64::from_bits(first.current_depth);
  run.nested.push(depth);
  let ids: Vec<JsVal> = group.iter().map(|&k| run.ids[k].clone()).collect();
  let db_args = nested_args(request, &first.slug, related, &ids);
  let req = match (&related.access, &related.field_access, related.join_access.is_empty()) {
    (None, None, true) => None,
    _ => Some(nested_request(request.access_req.as_ref().ok_or_else(|| Bail::new("request:accessReq"))?, depth)?),
  };
  let can_read = match (related.access, &req) {
    (Some(id), Some(req)) => nested_access(run.checked, id, &first.slug, related.access_result.as_deref(), req)?,
    _ => true,
  };
  if can_read {
    if let Some(req) = &req {
      // `sanitizeJoinQuery` (after the find's own access, which returns early on `false`)
      for join in &related.join_access {
        nested_join_access(run.checked, join, req)?;
      }
    }
  }
  // `find` with read access `false` and `disableErrors`: empty results, no database call
  let mut docs = if can_read { session.populate_find(&db_args, related, &ids)? } else { Vec::new() };
  let field_access = match (&related.field_access, req) {
    (Some(functions), Some(req)) => Some(FieldAccess { functions, req, checked: run.checked }),
    _ => None,
  };
  let nested_args = ReadArgs {
    plan: &related.plan,
    field_access,
    locale: args.locale.clone(),
    fallback: args.fallback.clone(),
    localization: args.localization,
    flatten_locales: true,
    show_hidden: args.show_hidden,
    depth,
    current_depth,
  };
  if related.auth {
    for doc in docs.iter_mut() {
      crate::add_collection(doc, &related.plan.slug)?;
    }
  }
  let loads = after_read_docs(&nested_args, &mut docs, related.select.as_ref(), related.select_mode, Some(&mut *run))?;
  resolve_level(run, session, &nested_args, &mut docs, loads)?;
  for doc in docs {
    let id = match (doc.get("id"), related.number_id) {
      (JsVal::Num(n), true) => IdKey::Num(number_key(*n)),
      (JsVal::Str(s), false) => IdKey::Str(s.to_string()),
      _ => return Err(Bail::new("populate:doc-id")),
    };
    let key = Key { id, ..first.clone() };
    if let Some(&k) = run.index.get(&key) {
      if group.contains(&k) {
        run.values[k] = Loaded::Doc(doc);
      }
    }
  }
  Ok(())
}

/// The `payload.db.find` args of a nested find (findOperation with `limit` undefined,
/// `pagination: false`, the related collection's `defaultSort`, `overrideAccess`).
fn nested_args(request: &Population, slug: &str, related: &crate::backend::Related, ids: &[JsVal]) -> JsVal {
  let mut id = Obj::new();
  id.insert("in".to_string(), JsVal::arr(ids.to_vec()));
  let mut condition = Obj::new();
  condition.insert("id".to_string(), JsVal::obj(id));
  let mut where_ = Obj::new();
  where_.insert("and".to_string(), JsVal::arr(vec![JsVal::obj(condition)]));
  let mut out = Obj::new();
  out.insert("collection".to_string(), JsVal::str(slug));
  out.insert("draftsEnabled".to_string(), JsVal::Bool(request.draft));
  out.insert("joins".to_string(), request.joins.clone());
  out.insert("limit".to_string(), JsVal::Num(0.0));
  out.insert("locale".to_string(), request.locale.clone());
  out.insert("page".to_string(), JsVal::Num(1.0));
  out.insert("pagination".to_string(), JsVal::Bool(false));
  out.insert("req".to_string(), request.req.clone());
  out.insert("select".to_string(), related.select.clone().unwrap_or(JsVal::Undefined));
  out.insert("sort".to_string(), related.sort.clone());
  out.insert("where".to_string(), JsVal::obj(where_));
  JsVal::obj(out)
}

// ---------------------------------------------------------------------------------------------
// The result with shared documents

/// The result JSON: plain when nothing was loaded, else `#` and the envelope
/// `{ r: result, x: [documents only the dataloader holds], p: [[path, source path]...],
/// k: [[slug, id, depth, currentDepth, path | null]...], n: [depth...] }`: a repeated document is
/// written once (`0` at its other paths, patched to the first object), `k` lists the dataloader
/// entries in cache insertion order (`null`: no document), `n` the nested finds in start order.
pub(crate) fn write_result(result: &JsVal, run: Option<&PopRun<'_>>) -> FuseResult<String> {
  let Some(run) = run.filter(|run| !run.is_empty()) else { return write::to_json(result) };
  if write::canonical() {
    return Err(Bail::new("populate:text"));
  }
  let mut shared = HashSet::new();
  for value in &run.values {
    if let Loaded::Doc(JsVal::Obj(props)) = value {
      shared.insert(Arc::as_ptr(props) as *const ());
    }
  }
  let mut writer = SharedWriter { shared, first: HashMap::new(), patches: Vec::new(), path: Vec::new() };
  let mut out = String::with_capacity(1024);
  out.push_str("#{\"r\":");
  writer.path.push(PathSeg::Key("r".to_string()));
  writer.write(result, &mut out, 0)?;
  writer.path.clear();
  out.push_str(",\"x\":[");
  let mut extra = 0usize;
  for value in &run.values {
    if let Loaded::Doc(doc @ JsVal::Obj(props)) = value {
      if !writer.first.contains_key(&(Arc::as_ptr(props) as *const ())) {
        if extra > 0 {
          out.push(',');
        }
        writer.path = vec![PathSeg::Key("x".to_string()), PathSeg::Index(extra)];
        writer.write(doc, &mut out, 0)?;
        extra += 1;
      }
    }
  }
  out.push_str("],\"p\":[");
  for (i, (at, from)) in writer.patches.iter().enumerate() {
    if i > 0 {
      out.push(',');
    }
    out.push('[');
    write_path(at, &mut out);
    out.push(',');
    write_path(from, &mut out);
    out.push(']');
  }
  out.push_str("],\"k\":[");
  for (k, key) in run.keys.iter().enumerate() {
    if k > 0 {
      out.push(',');
    }
    out.push('[');
    write_json_string(&key.slug, &mut out);
    out.push(',');
    write::write(&run.ids[k], &mut out, 0)?;
    out.push(',');
    write::write(&JsVal::Num(f64::from_bits(key.depth)), &mut out, 0)?;
    out.push(',');
    write::write(&JsVal::Num(f64::from_bits(key.current_depth)), &mut out, 0)?;
    out.push(',');
    match &run.values[k] {
      Loaded::Doc(JsVal::Obj(props)) => {
        let path = writer.first.get(&(Arc::as_ptr(props) as *const ())).ok_or_else(|| Bail::new("populate:unwritten"))?;
        write_path(path, &mut out);
      }
      Loaded::Missing => out.push_str("null"),
      _ => return Err(Bail::new("populate:pending")),
    }
    out.push(']');
  }
  out.push_str("],\"n\":[");
  for (i, depth) in run.nested.iter().enumerate() {
    if i > 0 {
      out.push(',');
    }
    write::write(&JsVal::Num(*depth), &mut out, 0)?;
  }
  out.push_str("]}");
  Ok(out)
}

#[derive(Clone)]
enum PathSeg {
  Key(String),
  Index(usize),
}

fn write_path(path: &[PathSeg], out: &mut String) {
  out.push('[');
  for (i, seg) in path.iter().enumerate() {
    if i > 0 {
      out.push(',');
    }
    match seg {
      PathSeg::Key(key) => write_json_string(key, out),
      PathSeg::Index(index) => out.push_str(&index.to_string()),
    }
  }
  out.push(']');
}

/// `write::write` that writes each shared document once and records the paths.
struct SharedWriter {
  shared: HashSet<*const ()>,
  first: HashMap<*const (), Vec<PathSeg>>,
  patches: Vec<(Vec<PathSeg>, Vec<PathSeg>)>,
  path: Vec<PathSeg>,
}

impl SharedWriter {
  fn write(&mut self, value: &JsVal, out: &mut String, depth: usize) -> FuseResult<()> {
    if depth > 400 {
      return Err(Bail::new("value:deep"));
    }
    match value {
      JsVal::Arr(items) => {
        out.push('[');
        for (i, item) in items.iter().enumerate() {
          if i > 0 {
            out.push(',');
          }
          self.path.push(PathSeg::Index(i));
          self.write(item, out, depth + 1)?;
          self.path.pop();
        }
        out.push(']');
        Ok(())
      }
      JsVal::Obj(props) if write::raw_text(props, |_| ()).is_some() => write::write(value, out, depth),
      JsVal::Obj(props) if !(props.is_empty() && (value.typed().is_some() || value.bson().is_some() || value.as_host_object().is_some())) => {
        let ptr = Arc::as_ptr(props) as *const ();
        if self.shared.contains(&ptr) {
          if let Some(first) = self.first.get(&ptr) {
            self.patches.push((self.path.clone(), first.clone()));
            out.push('0');
            return Ok(());
          }
          self.first.insert(ptr, self.path.clone());
        }
        out.push('{');
        for (i, (key, item)) in props.iter().enumerate() {
          if key == "__proto__" {
            return Err(Bail::new("value:__proto__"));
          }
          if i > 0 {
            out.push(',');
          }
          write_json_string(key, out);
          out.push(':');
          self.path.push(PathSeg::Key(key.clone()));
          self.write(item, out, depth + 1)?;
          self.path.pop();
        }
        out.push('}');
        Ok(())
      }
      other => write::write(other, out, depth),
    }
  }
}

/// `req` as the field access of a nested find sees it: its `createPayloadRequest({ depth, req,
/// ... })` (local `payload.find`) ran `req.query = req.query || {}; req.query.depth = depth`. The
/// other properties it sets keep their values on the fused lanes (src/fuse/populate.ts).
fn nested_request(req: &payload_fn_ir::Value, depth: f64) -> FuseResult<payload_fn_ir::Value> {
  use payload_fn_ir::Value;
  let Value::Object(props) = req else { return Err(Bail::new("populate:req")) };
  let query = match props.get("query") {
    // not captured: reading it bails
    None | Some(Value::Opaque(_)) => return Ok(req.clone()),
    Some(Value::Object(query)) => {
      let mut query = (**query).clone();
      query.set(Arc::from("depth"), Value::Number(depth));
      Value::Object(Arc::new(query))
    }
    Some(value) if matches!(value.truthy(), Ok(false)) => Value::object(vec![("depth", Value::Number(depth))]),
    Some(_) => return Err(Bail::new("populate:req-query")),
  };
  let mut props = (**props).clone();
  props.set(Arc::from("query"), query);
  Ok(Value::Object(Arc::new(props)))
}

/// `executeAccess({ slug, disableErrors: true, req }, collection.access.read)` of a nested find:
/// `true` reads (no constraint), `false` returns no documents; with `expected` (the where
/// constraint the backend's nested reads hold, predicted by the TS side) the result must be that
/// constraint, which reads; anything else (another where, another falsy value, a bail, a call
/// guard mode wants to see) bails.
fn nested_access(
  checked: &std::sync::Mutex<Vec<payload_fn_ir::FnId>>,
  id: payload_fn_ir::FnId,
  slug: &str,
  expected: Option<&str>,
  req: &payload_fn_ir::Value,
) -> FuseResult<bool> {
  use payload_fn_ir::Value;
  lane_call(checked, id, "populate:access:verify")?;
  let args = payload_fn_ir::lanes::collection_access_args(Value::Undefined, slug, Value::Undefined, req.clone());
  match (payload_fn_ir::evaluate(id, &[args]), expected) {
    (Ok(Value::Bool(can_read)), None) => Ok(can_read),
    (Ok(value @ Value::Object(_)), Some(expected)) => {
      let value = value.to_js_val().ok_or_else(|| Bail::new("populate:access:result"))?;
      if write::to_json(&value)? != expected {
        return Err(Bail::new("populate:access:changed"));
      }
      Ok(true)
    }
    // a where the TS side did not predict: it predicts this collection's from now on
    (Ok(Value::Object(_)), None) => Err(Bail::new(format!("populate:access:where:{slug}"))),
    (Ok(_), _) => Err(Bail::new("populate:access:result")),
    (Err(bail), _) => Err(Bail::new(format!("populate:access:bail:{}", bail.reason()))),
  }
}

/// `sanitizeJoinQuery`'s `executeAccess({ slug, disableErrors: true, req }, joinedCollection.access
/// .read)` of a nested find: the join stages of the request were built from the result the TS
/// side predicted with the operation's `req`; the nested find's `req` (its `query.depth`) must
/// give the same result, else the call bails.
fn nested_join_access(
  checked: &std::sync::Mutex<Vec<payload_fn_ir::FnId>>,
  join: &crate::backend::JoinAccess,
  req: &payload_fn_ir::Value,
) -> FuseResult<()> {
  use payload_fn_ir::Value;
  lane_call(checked, join.id, "populate:joins:access:verify")?;
  let args = payload_fn_ir::lanes::collection_access_args(Value::Undefined, &join.slug, Value::Undefined, req.clone());
  let result = payload_fn_ir::evaluate(join.id, &[args])
    .map_err(|bail| Bail::new(format!("populate:joins:access:bail:{}", bail.reason())))?;
  let value = result.to_js_val().ok_or_else(|| Bail::new("populate:joins:access:result"))?;
  if write::to_json(&value)? != join.expected {
    return Err(Bail::new("populate:joins:access:changed"));
  }
  Ok(())
}
