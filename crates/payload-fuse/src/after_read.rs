//! Upstream's `afterRead` field traversal (packages/payload/src/fields/hooks/afterRead) on an
//! owned document, for configs whose only user functions on the read path are compiled field
//! read access functions (FUSE_CONTRACT.md section 2).
//!
//! Upstream mutates the document in place, field by field, inside `async` functions. The
//! traversal reproduces their microtask order: what a field's `promise()` does synchronously
//! happens in the same order (deletes, `{}` / `[]` fills, locale hoisting, point and depth-0
//! relationship normalization, the field's `access.read` call), and the work upstream does after
//! an `await` is a job queued for the tick it resumes in (FIFO within a tick, like the microtask
//! queue): a default value's assignment one tick after its `getDefaultValue` call, and the rest of
//! a field with read access (the removal of a denied value, its default, its relationship and its
//! sub fields) one tick after the access call. `find` runs each tick for every document in
//! order, like its concurrent per-document `afterRead`s. Key insertion order, population load
//! order and the arguments the access functions see therefore match upstream. Branches whose
//! order or result would depend on more than that bail.

use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use payload_engine::js::{JsVal, Obj};
use payload_fn_ir::{FnId, Value as FnValue, guard, lanes};

use crate::backend::{Bail, FuseResult};
use crate::populate::{DocLoads, PopRun};
use crate::plan::{CollectionPlan, DefaultValue, Field, Kind, RelationTo};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectMode {
  Include,
  Exclude,
}

#[derive(Clone, Debug)]
pub enum Fallback {
  /// falsy
  None,
  One(String),
  Many(Vec<String>),
}

/// A compiled `field.access.read` function of a call without `overrideAccess`.
#[derive(Clone, Copy, Debug)]
pub struct AccessFn {
  pub id: FnId,
  /// It reads nothing but `req` (`argKeys`): one result for every call of one `afterRead`.
  pub request_only: bool,
}

/// The field read access of an `afterRead` without `overrideAccess` (FUSE_CONTRACT.md "Compiled
/// user functions"): evaluated where upstream calls it, with upstream's arguments
/// (`{ id, blockData, collection, data, doc, req, siblingData, skipCompilation }`).
#[derive(Clone)]
pub struct FieldAccess<'a> {
  /// `[i]`: the function of the plan's `Field::read_access == Some(i)`
  pub functions: &'a [AccessFn],
  /// `req` as compiled functions see it during this `afterRead` (`lanes::request` shape)
  pub req: FnValue,
  /// the compiled functions this operation already used ([`lane_call`])
  pub checked: &'a Mutex<Vec<FnId>>,
}

/// The first use of compiled function `id` in an operation is one lane call
/// (FN_COMPILE_CONTRACT.md "Lanes"): when guard mode wants to see it, the operation bails (its
/// exact lane calls the JS function, where the call-site guard verifies it). Only functions the
/// operation actually calls count, so a related collection nothing loads never holds calls back.
pub fn lane_call(checked: &Mutex<Vec<FnId>>, id: FnId, reason: &str) -> FuseResult<()> {
  let mut checked = checked.lock().unwrap_or_else(|e| e.into_inner());
  if checked.contains(&id) {
    return Ok(());
  }
  checked.push(id);
  if guard::lane_should_verify(id) {
    return Err(Bail::new(reason));
  }
  Ok(())
}

/// The per-operation inputs of `afterRead` (its args after destructuring, `depth` resolved).
pub struct ReadArgs<'a> {
  pub plan: &'a CollectionPlan,
  /// `field.access.read` of the call; `None`: `overrideAccess` (access is not called).
  pub field_access: Option<FieldAccess<'a>>,
  /// `req.locale` when it is a string
  pub locale: Option<String>,
  pub fallback: Fallback,
  /// `req.payload.config.localization` truthy
  pub localization: bool,
  pub flatten_locales: bool,
  pub show_hidden: bool,
  pub depth: f64,
  pub current_depth: f64,
}

#[derive(Clone, Debug)]
pub(crate) enum Seg {
  Key(String),
  Index(usize),
}

/// Work upstream does after an `await`, queued for the tick it resumes in.
enum Job<'a> {
  /// `siblingDoc[key] = await getDefaultValue(...)`
  Default { path: Vec<Seg>, key: String, value: JsVal },
  /// a field's `promise()` after `await field.access.read(...)`
  Rest(Rest<'a>),
}

struct Rest<'a> {
  /// the sibling document
  path: Vec<Seg>,
  block: Option<Vec<Seg>>,
  field: &'a Field,
  at_root: bool,
  parent_localized: bool,
  select: Option<JsVal>,
  select_mode: Option<SelectMode>,
  state: FieldState,
}

/// What a field's `promise()` decided before its access call.
#[derive(Clone, Copy)]
struct FieldState {
  removed: bool,
  hoist: bool,
  should_localize: bool,
  can_read: bool,
}

/// The jobs of one document by tick (`[t]` in FIFO order) and its population loads.
#[derive(Default)]
struct DocState<'a> {
  queue: Vec<Vec<Job<'a>>>,
  loads: DocLoads,
}

struct Walk<'a, 'r, 'w, 'p> {
  args: &'r ReadArgs<'a>,
  /// the sibling document of the field being visited, from the document root
  path: Vec<Seg>,
  /// the nearest block row above it (`blockData`), from the document root
  block: Option<Vec<Seg>>,
  tick: usize,
  doc: DocState<'a>,
  /// Relationship population: the loads of the call (`None`: a population bails).
  pop: Option<&'w mut PopRun<'p>>,
  /// results of the request-only access functions (by `Field::read_access`)
  request_only: Vec<Option<bool>>,
  /// `collection` of the access arguments: what the lane knows of the config (`{ slug }`)
  collection: Option<FnValue>,
}

/// Runs the traversal on `doc` (a document object) with the root `select`.
pub fn after_read(args: &ReadArgs<'_>, doc: &mut JsVal, select: Option<&JsVal>, select_mode: Option<SelectMode>) -> FuseResult<()> {
  after_read_docs(args, std::slice::from_mut(doc), select, select_mode, None).map(|_| ())
}

/// [`after_read`] of each of `docs`, interleaved by tick like upstream's concurrent
/// `docs.map((doc) => afterRead(...))`, recording the relationships it would populate in `pop`
/// (dataloader loads, in upstream's load order) instead of bailing; the returned slots (per
/// document) are filled once the loads resolved ([`crate::populate`]).
pub(crate) fn after_read_docs<'a>(
  args: &ReadArgs<'a>,
  docs: &mut [JsVal],
  select: Option<&JsVal>,
  select_mode: Option<SelectMode>,
  pop: Option<&mut PopRun<'_>>,
) -> FuseResult<Vec<DocLoads>> {
  let mut walk = Walk {
    args,
    path: Vec::new(),
    block: None,
    tick: 0,
    doc: DocState::default(),
    pop,
    request_only: Vec::new(),
    collection: None,
  };
  let fields: &'a [Field] = &args.plan.fields;
  let mut states = Vec::with_capacity(docs.len());
  for doc in docs.iter_mut() {
    if !matches!(doc, JsVal::Obj(_)) {
      return Err(Bail::new("doc:not-object"));
    }
    walk.traverse(fields, doc, true, false, select, select_mode)?;
    states.push(std::mem::take(&mut walk.doc));
  }
  let mut tick = 1;
  while states.iter().any(|state| state.queue.len() > tick) {
    for (doc, state) in docs.iter_mut().zip(states.iter_mut()) {
      let Some(jobs) = state.queue.get_mut(tick).map(std::mem::take) else { continue };
      std::mem::swap(&mut walk.doc, state);
      walk.tick = tick;
      for job in jobs {
        walk.run(job, doc)?;
      }
      std::mem::swap(&mut walk.doc, state);
    }
    tick += 1;
  }
  Ok(states.into_iter().map(|state| state.loads).collect())
}

pub(crate) fn resolve<'v>(mut value: &'v mut JsVal, path: &[Seg]) -> Option<&'v mut JsVal> {
  for seg in path {
    value = match (seg, value) {
      (Seg::Key(key), JsVal::Obj(o)) => Arc::make_mut(o).get_mut(key.as_str())?,
      (Seg::Index(i), JsVal::Arr(a)) => Arc::make_mut(a).get_mut(*i)?,
      _ => return None,
    };
  }
  Some(value)
}

fn resolve_ref<'v>(mut value: &'v JsVal, path: &[Seg]) -> Option<&'v JsVal> {
  for seg in path {
    value = match (seg, value) {
      (Seg::Key(key), JsVal::Obj(o)) => o.get(key.as_str())?,
      (Seg::Index(i), JsVal::Arr(a)) => a.get(*i)?,
      _ => return None,
    };
  }
  Some(value)
}

pub(crate) fn obj_mut(value: &mut JsVal) -> Option<&mut Obj> {
  match value {
    JsVal::Obj(o) => Some(&mut **Arc::make_mut(o)),
    _ => None,
  }
}

fn is_undefined(value: Option<&JsVal>) -> bool {
  matches!(value, None | Some(JsVal::Undefined))
}

/// `typeof v === 'object' && v !== null` (arrays included; typed values are objects too)
fn is_object(value: Option<&JsVal>) -> bool {
  matches!(value, Some(JsVal::Obj(_) | JsVal::Arr(_)))
}

/// `typeof v === 'object'` (null included)
fn typeof_object(value: Option<&JsVal>) -> bool {
  matches!(value, Some(JsVal::Obj(_) | JsVal::Arr(_) | JsVal::Null))
}

fn truthy(value: Option<&JsVal>) -> bool {
  value.is_some_and(JsVal::truthy)
}

/// `value[key]` for a property read on a document value (own keys only: plans exclude names that
/// are `Object.prototype` keys).
fn get<'v>(value: Option<&'v JsVal>, key: &str) -> Option<&'v JsVal> {
  match value? {
    JsVal::Obj(o) => o.get(key),
    _ => None,
  }
}

/// A select value: `select[name]` of a select tree (plain objects of booleans and objects).
fn select_get<'s>(select: Option<&'s JsVal>, name: &str) -> Option<&'s JsVal> {
  get(select, name)
}

fn deep_copy(value: &JsVal) -> JsVal {
  match value {
    JsVal::Obj(o) => JsVal::obj(o.iter().map(|(k, v)| (k.clone(), deep_copy(v))).collect()),
    JsVal::Arr(a) => JsVal::arr(a.iter().map(deep_copy).collect()),
    other => other.clone(),
  }
}

/// A raw leaf ([`crate::RawLeaves`]): its value is not in the document, so compiled functions see
/// it as opaque (reading it bails).
fn is_raw_leaf(value: &JsVal) -> bool {
  match value {
    JsVal::Obj(o) => crate::write::raw_text(o, |_| ()).is_some(),
    _ => false,
  }
}

fn sibling_at<'v>(root: &'v mut JsVal, path: &[Seg]) -> FuseResult<&'v mut Obj> {
  resolve(root, path).and_then(obj_mut).ok_or_else(|| Bail::new("sibling:not-object"))
}

impl<'a> Walk<'a, '_, '_, '_> {
  /// `traverseFields(...)`: one `promise()` per field, in order, on the sibling document at
  /// `self.path`.
  fn traverse(
    &mut self,
    fields: &'a [Field],
    root: &mut JsVal,
    at_root: bool,
    parent_localized: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    for field in fields {
      self.field(field, root, at_root, parent_localized, select, select_mode)?;
    }
    Ok(())
  }

  fn with_seg<R>(&mut self, seg: Seg, f: impl FnOnce(&mut Self) -> R) -> R {
    self.path.push(seg);
    let out = f(self);
    self.path.pop();
    out
  }

  /// Queues `job` for `delay` ticks after the current one.
  fn enqueue(&mut self, delay: usize, job: Job<'a>) {
    let tick = self.tick + delay;
    if self.doc.queue.len() <= tick {
      self.doc.queue.resize_with(tick + 1, Vec::new);
    }
    self.doc.queue[tick].push(job);
  }

  fn run(&mut self, job: Job<'a>, root: &mut JsVal) -> FuseResult<()> {
    match job {
      Job::Default { path, key, value } => {
        let target = resolve(root, &path).ok_or_else(|| Bail::new("default:target"))?;
        obj_mut(target).ok_or_else(|| Bail::new("default:target"))?.insert(key, value);
        Ok(())
      }
      Job::Rest(rest) => {
        self.path = rest.path;
        self.block = rest.block;
        self.rest(rest.field, root, rest.at_root, rest.parent_localized, rest.select.as_ref(), rest.select_mode, rest.state)
      }
    }
  }

  /// `promise()` of one field up to its access call (the rest: [`Walk::rest`]).
  fn field(
    &mut self,
    field: &'a Field,
    root: &mut JsVal,
    at_root: bool,
    parent_localized: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    let args = self.args;
    let ad = field.affects_data;
    let name = field.name.as_deref().unwrap_or("");
    let is_top_level_id = ad && name == "id" && at_root;
    let path_is_id = field.name.is_some() && name == "id" && at_root;
    let doc = sibling_at(root, &self.path)?;
    let mut removed = false;

    if ad && field.hidden && !is_undefined(doc.get(name)) && !args.show_hidden && !is_top_level_id {
      removed = true;
      doc.shift_remove(name);
    }

    // stripUnselectedFields
    if !path_is_id && ad && !name.is_empty() && truthy(select) {
      match select_mode {
        Some(SelectMode::Include) if !truthy(select_get(select, name)) => {
          doc.shift_remove(name);
          return Ok(());
        }
        Some(SelectMode::Exclude) if matches!(select_get(select, name), Some(JsVal::Bool(false))) => {
          doc.shift_remove(name);
          return Ok(());
        }
        _ => {}
      }
    }

    let should_localize = field.localized && !parent_localized;
    let locale_all = args.locale.as_deref() == Some("all");
    let hoist = args.flatten_locales && ad && is_object(doc.get(name)) && should_localize && !locale_all && args.localization;

    if ad && hoist {
      let localized = doc.get(name);
      let value = match args.locale.as_deref() {
        Some(locale) => get(localized, locale).cloned(),
        None => get(localized, "undefined").cloned(),
      };
      let mut hoisted = value.clone();
      let fallback_differs = match (&args.fallback, args.locale.as_deref()) {
        (Fallback::None, _) => false,
        (Fallback::One(f), Some(locale)) => f != locale,
        _ => true,
      };
      if fallback_differs {
        let is_null_or_undefined = matches!(value, None | Some(JsVal::Undefined | JsVal::Null));
        let fallback_value = match &args.fallback {
          Fallback::Many(locales) => locales
            .iter()
            .filter_map(|l| get(localized, l))
            .find(|v| !matches!(v, JsVal::Undefined | JsVal::Null) && v.as_str() != Some(""))
            .cloned(),
          Fallback::One(f) => get(localized, f).cloned(),
          Fallback::None => None,
        };
        if fallback_value.as_ref().is_some_and(JsVal::truthy) {
          let is_text = matches!(field.type_name.as_str(), "slug" | "text" | "textarea");
          let empty_string = value.as_ref().and_then(JsVal::as_str) == Some("");
          if (is_text && (empty_string || is_null_or_undefined)) || (!is_text && is_null_or_undefined) {
            hoisted = fallback_value;
          }
        }
      }
      doc.insert(name.to_string(), hoisted.unwrap_or(JsVal::Undefined));
    }

    // Sanitize outgoing field value
    match field.kind {
      Kind::Group => {
        if ad && is_undefined(doc.get(name)) {
          doc.insert(name.to_string(), JsVal::obj(Obj::new()));
        }
      }
      Kind::Point => {
        let coordinates = get(doc.get(name), "coordinates");
        let value = match coordinates {
          Some(JsVal::Arr(c)) if c.len() == 2 => JsVal::Arr(c.clone()),
          _ => JsVal::Undefined,
        };
        doc.insert(name.to_string(), value);
      }
      Kind::Tabs => {
        for tab in &field.tabs {
          if let Some(tab_name) = tab.name.as_deref() {
            if matches!(doc.get(tab_name), None | Some(JsVal::Undefined | JsVal::Null)) {
              doc.insert(tab_name.to_string(), JsVal::obj(Obj::new()));
            }
          }
        }
      }
      _ => {}
    }

    // field hooks: none on a fused path; virtual: none
    let mut state = FieldState { removed, hoist, should_localize, can_read: true };
    if let (true, Some(index), Some(_)) = (ad, field.read_access, &args.field_access) {
      // `overrideAccess ? true : await field.access.read(...)`: called now, the rest of the field
      // resumes one tick later
      state.can_read = self.can_read(root, index)?;
      let rest = Rest {
        path: self.path.clone(),
        block: self.block.clone(),
        field,
        at_root,
        parent_localized,
        select: select.cloned(),
        select_mode,
        state,
      };
      self.enqueue(1, Job::Rest(rest));
      return Ok(());
    }
    self.rest(field, root, at_root, parent_localized, select, select_mode, state)
  }

  /// `promise()` of one field from its access result on.
  #[allow(clippy::too_many_arguments)]
  fn rest(
    &mut self,
    field: &'a Field,
    root: &mut JsVal,
    at_root: bool,
    parent_localized: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
    state: FieldState,
  ) -> FuseResult<()> {
    let FieldState { removed, hoist, should_localize, can_read } = state;
    let ad = field.affects_data;
    let name = field.name.as_deref().unwrap_or("");
    if ad {
      let doc = sibling_at(root, &self.path)?;
      let mut allow_default = true;
      if !can_read {
        allow_default = false;
        doc.shift_remove(name);
      }
      if !removed && allow_default && is_undefined(doc.get(name)) {
        match &field.default {
          DefaultValue::None => {}
          DefaultValue::Function => return Err(Bail::new("default:function")),
          DefaultValue::Static(value) => {
            if field.kind != Kind::Leaf {
              return Err(Bail::new("default:container"));
            }
            if !matches!(value, JsVal::Undefined) {
              let job = Job::Default { path: self.path.clone(), key: name.to_string(), value: deep_copy(value) };
              self.enqueue(1, job);
            }
          }
        }
      }
      if field.kind == Kind::Relationship {
        let doc = sibling_at(root, &self.path)?;
        self.relationship(field, doc, parent_localized)?;
      } else if field.kind == Kind::Join {
        return Err(Bail::new("join"));
      }
    }

    match field.kind {
      Kind::Array => self.array(field, root, parent_localized, hoist, select, select_mode)?,
      Kind::Blocks => self.blocks(field, root, parent_localized, hoist, select, select_mode)?,
      Kind::Row => self.traverse(&field.fields, root, at_root, parent_localized, select, select_mode)?,
      Kind::Group | Kind::Tab if ad => {
        let nested_select = match select_get(select, name) {
          Some(v @ (JsVal::Obj(_) | JsVal::Arr(_) | JsVal::Null)) => Some(v),
          _ => None,
        };
        let child_localized = parent_localized || field.localized;
        if should_localize && !hoist {
          self.localized_values(field, root, child_localized, nested_select, select_mode)?;
        } else {
          match sibling_at(root, &self.path)?.get(name) {
            Some(JsVal::Obj(_)) => {
              self.with_seg(Seg::Key(name.to_string()), |w| {
                w.traverse(&field.fields, root, false, child_localized, nested_select, select_mode)
              })?;
            }
            // `typeof value !== 'object' ? {} : value`: a fresh object nobody sees
            Some(JsVal::Bool(_) | JsVal::Num(_) | JsVal::Str(_) | JsVal::Undefined) | None => {}
            // null (TypeError) or an array as the sibling doc
            Some(_) => return Err(Bail::new("group:value")),
          }
        }
      }
      Kind::Group => self.traverse(&field.fields, root, at_root, parent_localized, select, select_mode)?,
      Kind::Tab => self.traverse(&field.fields, root, at_root, parent_localized || field.localized, select, select_mode)?,
      Kind::Tabs => self.traverse(&field.tabs, root, at_root, parent_localized, select, select_mode)?,
      Kind::RichText => {
        let doc = sibling_at(root, &self.path)?;
        self.rich_text(field, doc, should_localize, hoist)?
      }
      _ => {}
    }
    Ok(())
  }

  /// `await field.access.read({ id: doc.id, blockData, collection, data: doc, doc, req,
  /// siblingData: siblingDoc, skipCompilation })` (truthy: the field stays), evaluated on the
  /// document as it is now. A function reading nothing but `req` is evaluated once per
  /// `afterRead`. Bails when the compiled function does, or when JS would resume after more than
  /// one tick (an `await` inside it).
  fn can_read(&mut self, root: &JsVal, index: usize) -> FuseResult<bool> {
    let args = self.args;
    let Some(access) = &args.field_access else { return Ok(true) };
    let function = *access.functions.get(index).ok_or_else(|| Bail::new("access:field"))?;
    if function.request_only {
      if let Some(Some(cached)) = self.request_only.get(index) {
        return Ok(*cached);
      }
    }
    let collection = self
      .collection
      .get_or_insert_with(|| FnValue::partial_object(vec![("slug", FnValue::str(&args.plan.slug))]))
      .clone();
    lane_call(access.checked, function.id, "access:field:verify")?;
    let call_args = if function.request_only {
      lanes::field_read_access_args(FnValue::Undefined, FnValue::Undefined, collection, FnValue::Undefined, access.req.clone(), FnValue::Undefined)
    } else {
      let sibling = resolve_ref(root, &self.path).ok_or_else(|| Bail::new("access:field:sibling"))?;
      let block = match &self.block {
        Some(path) => resolve_ref(root, path).ok_or_else(|| Bail::new("access:field:block"))?.clone(),
        None => JsVal::Undefined,
      };
      // one conversion: `doc`, `siblingData` and `blockData` share their objects like in JS
      let values = FnValue::from_js_val_with(&JsVal::arr(vec![root.clone(), sibling.clone(), block]), &is_raw_leaf);
      let FnValue::Array(values) = values else { return Err(Bail::new("access:field:args")) };
      let [doc, sibling, block] = values.as_slice() else { return Err(Bail::new("access:field:args")) };
      let id = match doc {
        FnValue::Object(o) => o.get("id").cloned().unwrap_or(FnValue::Undefined),
        _ => return Err(Bail::new("access:field:args")),
      };
      lanes::field_read_access_args(id, block.clone(), collection, doc.clone(), access.req.clone(), sibling.clone())
    };
    let (result, one_tick) = payload_fn_ir::evaluate_ticks(function.id, &[call_args])
      .map_err(|bail| Bail::new(format!("access:field:bail:{}", bail.reason())))?;
    if !one_tick {
      return Err(Bail::new("access:field:ticks"));
    }
    let can_read = result.truthy().map_err(|_| Bail::new("access:field:result"))?;
    if function.request_only {
      if self.request_only.len() <= index {
        self.request_only.resize(index + 1, None);
      }
      self.request_only[index] = Some(can_read);
    }
    Ok(can_read)
  }

  /// `Object.values(siblingDoc[name] || {}).forEach((localizedData) => traverseFields(...))` of
  /// localized groups and named tabs.
  fn localized_values(
    &mut self,
    field: &'a Field,
    root: &mut JsVal,
    child_localized: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    let name = field.name.as_deref().unwrap_or("");
    let keys: Vec<String> = match sibling_at(root, &self.path)?.get(name) {
      None => return Ok(()),
      Some(JsVal::Obj(o)) => {
        let mut keys = Vec::with_capacity(o.len());
        for (key, localized) in o.iter() {
          match localized {
            JsVal::Obj(_) => keys.push(key.clone()),
            v if !v.truthy() => {}
            _ => return Err(Bail::new("localized:value")),
          }
        }
        keys
      }
      Some(v) if !v.truthy() => return Ok(()),
      Some(_) => return Err(Bail::new("localized:value")),
    };
    for key in keys {
      self.with_seg(Seg::Key(name.to_string()), |w| {
        w.with_seg(Seg::Key(key), |w| w.traverse(&field.fields, root, false, child_localized, select, select_mode))
      })?;
    }
    Ok(())
  }

  fn array(
    &mut self,
    field: &'a Field,
    root: &mut JsVal,
    parent_localized: bool,
    hoist: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    let name = field.name.as_deref().unwrap_or("");
    let child_localized = parent_localized || field.localized;
    // `{ ...arraySelect, id: true }` in include mode
    let array_select_owned;
    let mut array_select = select_get(select, name);
    if select_mode == Some(SelectMode::Include) && typeof_object(array_select) {
      let mut copy = match array_select {
        Some(JsVal::Obj(o)) => (***o).clone(),
        Some(JsVal::Null) => Obj::new(),
        _ => return Err(Bail::new("select:array")),
      };
      copy.insert("id".to_string(), JsVal::Bool(true));
      array_select_owned = JsVal::obj(copy);
      array_select = Some(&array_select_owned);
    }
    let row_select = match array_select {
      Some(v @ (JsVal::Obj(_) | JsVal::Arr(_) | JsVal::Null)) => Some(v),
      _ => None,
    };
    let doc = sibling_at(root, &self.path)?;
    match doc.get(name) {
      Some(JsVal::Arr(rows)) if !rows.is_empty() => {
        let count = rows.len();
        self.with_seg(Seg::Key(name.to_string()), |w| w.rows(&field.fields, root, count, child_localized, row_select, select_mode))
      }
      Some(value @ (JsVal::Obj(_) | JsVal::Arr(_))) if !hoist => {
        // locale-keyed rows: no select, no select mode
        let locales: Vec<(String, usize)> = match value {
          JsVal::Obj(o) => o
            .iter()
            .filter_map(|(key, rows)| match rows {
              JsVal::Arr(rows) => Some((key.clone(), rows.len())),
              _ => None,
            })
            .collect(),
          _ => Vec::new(),
        };
        for (key, count) in locales {
          self.with_seg(Seg::Key(name.to_string()), |w| {
            w.with_seg(Seg::Key(key), |w| w.rows(&field.fields, root, count, child_localized, None, None))
          })?;
        }
        Ok(())
      }
      rows => {
        let is_empty = match rows {
          None => true,
          Some(v) if !v.truthy() => true,
          Some(JsVal::Arr(a)) => a.is_empty(),
          Some(JsVal::Obj(o)) => matches!(o.get("length"), Some(JsVal::Num(n)) if *n == 0.0),
          _ => false,
        };
        if hoist && is_empty {
          doc.insert(name.to_string(), JsVal::Null);
        } else if !field.hidden_true || self.args.show_hidden {
          doc.insert(name.to_string(), JsVal::arr(Vec::new()));
        }
        Ok(())
      }
    }
  }

  /// `rows.forEach((row, rowIndex) => traverseFields({ siblingDoc: row || {}, ... }))` of the
  /// `count` rows at `self.path`.
  fn rows(
    &mut self,
    fields: &'a [Field],
    root: &mut JsVal,
    count: usize,
    child_localized: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    for index in 0..count {
      self.path.push(Seg::Index(index));
      let row = resolve(root, &self.path).ok_or_else(|| Bail::new("row:path"));
      let outcome = match row {
        Ok(JsVal::Obj(_)) => self.traverse(fields, root, false, child_localized, select, select_mode),
        Ok(v) if !v.truthy() => Ok(()),
        Ok(_) => Err(Bail::new("row:not-object")),
        Err(bail) => Err(bail),
      };
      self.path.pop();
      outcome?;
    }
    Ok(())
  }

  fn block_fields(&self, field: &'a Field, block_type: Option<&JsVal>) -> FuseResult<Option<&'a [Field]>> {
    let slug = match block_type {
      None | Some(JsVal::Undefined) => return Ok(None),
      Some(JsVal::Str(s)) => s,
      Some(_) => return Err(Bail::new("blocks:blockType")),
    };
    let plan: &'a CollectionPlan = self.args.plan;
    if let Some(fields) = plan.global_blocks.get(&**slug) {
      return Ok(Some(fields.as_slice()));
    }
    if crate::OBJECT_PROTOTYPE_KEYS.contains(&&**slug) {
      return Err(Bail::new("blocks:blockType"));
    }
    Ok(field.blocks.iter().find(|(s, _)| **s == **slug).map(|(_, f)| f.as_slice()))
  }

  /// `traverseFields({ blockData: row, siblingDoc: row, ... })` of the block row at `self.path`.
  fn block_row(
    &mut self,
    fields: &'a [Field],
    root: &mut JsVal,
    child_localized: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    let outer = self.block.replace(self.path.clone());
    let outcome = self.traverse(fields, root, false, child_localized, select, select_mode);
    self.block = outer;
    outcome
  }

  fn blocks(
    &mut self,
    field: &'a Field,
    root: &mut JsVal,
    parent_localized: bool,
    hoist: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    let name = field.name.as_deref().unwrap_or("");
    let child_localized = parent_localized || field.localized;
    let field_select = select_get(select, name);
    let doc = sibling_at(root, &self.path)?;
    match doc.get(name) {
      Some(JsVal::Arr(rows)) if !rows.is_empty() => {
        let block_types: Vec<Option<JsVal>> = rows
          .iter()
          .map(|row| match row {
            JsVal::Obj(o) => Ok(o.get("blockType").cloned()),
            _ => Err(Bail::new("block:not-object")),
          })
          .collect::<FuseResult<_>>()?;
        for (index, block_type) in block_types.into_iter().enumerate() {
          let block = self.block_fields(field, block_type.as_ref())?;
          // getBlockSelect
          let (block_select, block_mode) = match field_select {
            Some(JsVal::Obj(s)) => {
              let Some(slug) = block_type.as_ref().and_then(JsVal::as_str).filter(|_| block.is_some()) else {
                // `block.slug` of an unknown block throws in upstream
                return Err(Bail::new("blocks:select"));
              };
              let mut mode = select_mode;
              let mut block_select = s.get(slug).cloned();
              if select_mode == Some(SelectMode::Exclude) && matches!(block_select, Some(JsVal::Bool(false))) {
                mode = Some(SelectMode::Include);
                block_select = Some(JsVal::obj(IndexMap::from_iter([
                  ("id".to_string(), JsVal::Bool(true)),
                  ("blockType".to_string(), JsVal::Bool(true)),
                ])));
              } else if select_mode == Some(SelectMode::Include) {
                if !block_select.as_ref().is_some_and(JsVal::truthy) {
                  block_select = Some(JsVal::obj(Obj::new()));
                }
                match block_select {
                  Some(JsVal::Obj(ref b)) => {
                    let mut copy = (***b).clone();
                    copy.insert("id".to_string(), JsVal::Bool(true));
                    copy.insert("blockType".to_string(), JsVal::Bool(true));
                    block_select = Some(JsVal::obj(copy));
                  }
                  Some(JsVal::Arr(_)) => return Err(Bail::new("blocks:select")),
                  _ => {}
                }
              }
              (block_select, mode)
            }
            Some(JsVal::Arr(_) | JsVal::Null) => return Err(Bail::new("blocks:select")),
            other => (other.cloned(), select_mode),
          };
          let Some(block) = block else { continue };
          let row_select = match &block_select {
            Some(v @ (JsVal::Obj(_) | JsVal::Arr(_) | JsVal::Null)) => Some(v),
            _ => None,
          };
          self.with_seg(Seg::Key(name.to_string()), |w| {
            w.with_seg(Seg::Index(index), |w| w.block_row(block, root, child_localized, row_select, block_mode))
          })?;
        }
        Ok(())
      }
      Some(value @ (JsVal::Obj(_) | JsVal::Arr(_))) if !hoist => {
        let mut rows: Vec<(String, usize, Option<JsVal>)> = Vec::new();
        if let JsVal::Obj(o) = value {
          for (key, locale_rows) in o.iter() {
            let JsVal::Arr(items) = locale_rows else { continue };
            for (index, row) in items.iter().enumerate() {
              let JsVal::Obj(r) = row else { return Err(Bail::new("block:not-object")) };
              rows.push((key.clone(), index, r.get("blockType").cloned()));
            }
          }
        }
        for (key, index, block_type) in rows {
          let Some(block) = self.block_fields(field, block_type.as_ref())? else { continue };
          self.with_seg(Seg::Key(name.to_string()), |w| {
            w.with_seg(Seg::Key(key), |w| w.with_seg(Seg::Index(index), |w| w.block_row(block, root, child_localized, None, None)))
          })?;
        }
        Ok(())
      }
      rows => {
        let is_empty = match rows {
          None => true,
          Some(v) if !v.truthy() => true,
          Some(JsVal::Arr(a)) => a.is_empty(),
          Some(JsVal::Obj(o)) => matches!(o.get("length"), Some(JsVal::Num(n)) if *n == 0.0),
          _ => false,
        };
        if hoist && is_empty {
          doc.insert(name.to_string(), JsVal::Null);
        } else if !field.hidden_true || self.args.show_hidden {
          doc.insert(name.to_string(), JsVal::arr(Vec::new()));
        }
        Ok(())
      }
    }
  }

  /// The lexical editor's `afterRead` hook, recognised by its marker: a no-op unless the value
  /// holds a node type with node hooks or sub fields (then the call bails).
  fn rich_text(&mut self, field: &Field, doc: &mut Obj, should_localize: bool, hoist: bool) -> FuseResult<()> {
    let Some(active) = &field.lexical_active else { return Err(Bail::new("richText:editor")) };
    if active.is_empty() {
      return Ok(());
    }
    let name = field.name.as_deref().unwrap_or("");
    let locale_all = self.args.locale.as_deref() == Some("all");
    let all_locales = locale_all && field.name.is_some() && !hoist && should_localize && typeof_object(doc.get(name));
    let check = |value: Option<&JsVal>| -> FuseResult<()> {
      let children = get(get(value, "root"), "children");
      lexical_nodes(children, active)
    };
    if all_locales {
      match doc.get(name) {
        Some(JsVal::Obj(o)) => {
          for value in o.values() {
            check(Some(value))?;
          }
          Ok(())
        }
        _ => Err(Bail::new("richText:locales")),
      }
    } else {
      check(doc.get(name))
    }
  }

  /// `relationshipPopulationPromise` without population (`depth && currentDepth <= depth` false
  /// for this field, else the call bails): ids are normalized like upstream's `populate()`.
  fn relationship(&mut self, field: &Field, doc: &mut Obj, parent_localized: bool) -> FuseResult<()> {
    let args = self.args;
    let name = field.name.as_deref().unwrap_or("");
    let depth = match field.max_depth {
      Some(max) if max < args.depth => max,
      _ => args.depth,
    };
    let should_localize = field.localized && !parent_localized;
    let locale_all = args.locale.as_deref() == Some("all");
    let poly = matches!(field.relation_to, RelationTo::Many(_));
    let ctx = Populate { field, depth, args, poly };

    if field.has_many {
      if should_localize && locale_all && is_object(doc.get(name)) {
        let Some(JsVal::Obj(o)) = doc.get_mut(name) else { return Err(Bail::new("relationship:locales")) };
        let o = std::sync::Arc::make_mut(o);
        for (_key, rows) in o.iter_mut() {
          if let JsVal::Arr(rows) = rows {
            let rows = std::sync::Arc::make_mut(rows);
            for row in rows.iter_mut() {
              let data = row.clone();
              if ctx.populate(&data, row)?.is_some() {
                return Err(Bail::new("populate:locales"));
              }
            }
          }
        }
      } else {
        match doc.get_mut(name) {
          Some(JsVal::Arr(rows)) => {
            let rows = std::sync::Arc::make_mut(rows);
            let mut loaded = false;
            for (index, row) in rows.iter_mut().enumerate() {
              if !row.truthy() {
                continue;
              }
              let id = match &*row {
                JsVal::Obj(o) => o.get("id").filter(|id| id.truthy()).cloned(),
                _ => None,
              };
              let data = id.unwrap_or_else(|| row.clone());
              if let Some((relation, id)) = ctx.populate(&data, row)? {
                let mut path = self.path.clone();
                path.push(Seg::Key(name.to_string()));
                path.push(Seg::Index(index));
                self.load(relation, id, depth, path, poly)?;
                loaded = true;
              }
            }
            if loaded {
              let mut path = self.path.clone();
              path.push(Seg::Key(name.to_string()));
              self.doc.loads.filters.push((path, poly));
            }
          }
          Some(JsVal::Obj(o)) if matches!(o.get("docs"), Some(JsVal::Arr(_))) => return Err(Bail::new("relationship:docs")),
          _ => {}
        }
      }
      // `.filter(notNull)`
      let not_null = |v: &JsVal| -> bool {
        if poly {
          !matches!(v, JsVal::Null) && !matches!(get(Some(v), "value"), Some(JsVal::Null))
        } else {
          !matches!(v, JsVal::Null)
        }
      };
      if should_localize && locale_all && is_object(doc.get(name)) {
        if let Some(JsVal::Obj(o)) = doc.get_mut(name) {
          let o = std::sync::Arc::make_mut(o);
          for (_key, rows) in o.iter_mut() {
            if let JsVal::Arr(items) = rows {
              let filtered: Vec<JsVal> = items.iter().filter(|v| not_null(v)).cloned().collect();
              *rows = JsVal::arr(filtered);
            }
          }
        }
      } else if let Some(JsVal::Arr(items)) = doc.get(name) {
        let filtered: Vec<JsVal> = items.iter().filter(|v| not_null(v)).cloned().collect();
        doc.insert(name.to_string(), JsVal::arr(filtered));
      }
    } else if field.localized && locale_all && is_object(doc.get(name)) {
      let Some(JsVal::Obj(o)) = doc.get_mut(name) else { return Err(Bail::new("relationship:locales")) };
      let o = std::sync::Arc::make_mut(o);
      for (_key, value) in o.iter_mut() {
        let data = value.clone();
        if ctx.populate(&data, value)?.is_some() {
          return Err(Bail::new("populate:locales"));
        }
      }
    } else if truthy(doc.get(name)) {
      let data = doc.get(name).cloned().unwrap_or_default();
      let slot = doc.get_mut(name).ok_or_else(|| Bail::new("relationship:slot"))?;
      if let Some((relation, id)) = ctx.populate(&data, slot)? {
        let mut path = self.path.clone();
        path.push(Seg::Key(name.to_string()));
        self.load(relation, id, depth, path, poly)?;
      }
    }
    Ok(())
  }

  /// `req.payloadDataLoader.load(key)` of `populate()`: the slot at `path` (its `.value` for a
  /// polymorphic relationship) takes the result once the loads resolved.
  fn load(&mut self, relation: String, id: JsVal, depth: f64, path: Vec<Seg>, poly: bool) -> FuseResult<()> {
    let current_depth = self.args.current_depth + 1.0;
    let Some(pop) = self.pop.as_deref_mut() else { return Err(Bail::new("populate")) };
    let key = pop.load(&relation, id, depth, current_depth)?;
    self.doc.loads.slots.push((path, key, poly));
    Ok(())
  }
}

struct Populate<'f, 'a, 'r> {
  field: &'f Field,
  depth: f64,
  args: &'r ReadArgs<'a>,
  poly: bool,
}

impl Populate<'_, '_, '_> {
  /// `populate({ data, ... })` where `slot` is the value upstream assigns to
  /// (`dataToUpdate[field.name]...`, or its `.value` for polymorphic relationships). A relationship
  /// to populate is returned (the related slug and the id) and `slot` is left as it is.
  fn populate(&self, data: &JsVal, slot: &mut JsVal) -> FuseResult<Option<(String, JsVal)>> {
    let relation = match (&self.field.relation_to, self.poly) {
      (RelationTo::One(slug), false) => Some(slug.as_str()),
      (_, true) => match get(Some(data), "relationTo") {
        Some(JsVal::Str(s)) => Some(&**s),
        None | Some(JsVal::Undefined) => None,
        Some(_) => return Err(Bail::new("relationship:relationTo")),
      },
      _ => return Err(Bail::new("relationship:relationTo")),
    };
    let Some(relation) = relation else { return Ok(None) };
    if !self.args.plan.collections.contains(relation) {
      if crate::OBJECT_PROTOTYPE_KEYS.contains(&relation) {
        return Err(Bail::new("relationship:relationTo"));
      }
      return Ok(None);
    }
    let id = if self.poly { get(Some(data), "value").cloned().unwrap_or_default() } else { data.clone() };
    let should_populate = self.depth != 0.0 && !self.depth.is_nan() && self.args.current_depth <= self.depth;
    if should_populate {
      return Ok(Some((relation.to_string(), id)));
    }
    let id = match id {
      JsVal::Bool(b) => JsVal::str(if b { "true" } else { "false" }),
      JsVal::Fn(_) => return Err(Bail::new("relationship:id")),
      other => other,
    };
    if self.poly {
      // `dataToUpdate[...].value = relationshipValue` (a primitive or null target throws upstream)
      let target = obj_mut(slot).ok_or_else(|| Bail::new("relationship:value-target"))?;
      target.insert("value".to_string(), id);
    } else {
      *slot = id;
    }
    Ok(None)
  }
}

/// lexical's `recurseNodeTree` over `root.children`, bailing on a node type in `active`.
fn lexical_nodes(children: Option<&JsVal>, active: &std::collections::HashSet<String>) -> FuseResult<()> {
  let mut stack: Vec<&JsVal> = Vec::new();
  match children {
    None | Some(JsVal::Undefined | JsVal::Null) => return Ok(()),
    Some(JsVal::Arr(items)) => stack.extend(items.iter().rev()),
    Some(_) => return Err(Bail::new("lexical:children")),
  }
  while let Some(node) = stack.pop() {
    let JsVal::Obj(o) = node else { return Err(Bail::new("lexical:node")) };
    if let Some(JsVal::Str(t)) = o.get("type") {
      if active.contains(&**t) {
        return Err(Bail::new("lexical:node-type"));
      }
    } else if !matches!(o.get("type"), None | Some(JsVal::Undefined | JsVal::Null | JsVal::Num(_) | JsVal::Bool(_))) {
      return Err(Bail::new("lexical:node-type"));
    }
    if let Some(JsVal::Arr(children)) = o.get("children") {
      stack.extend(children.iter().rev());
    }
  }
  Ok(())
}
