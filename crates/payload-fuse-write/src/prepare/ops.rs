//! The operations' own steps around the field traversals (collections/operations/create.ts,
//! updateByID.ts + utilities/update.ts, db-mongodb create.ts / updateOne.ts / createVersion.ts,
//! versions/saveVersion.ts), in upstream's order.

use std::cell::{Cell, RefCell};

use payload_engine::js::JsVal;
use payload_mongo_driver::mongodb::bson::{Bson, DateTime, Document, doc};

use super::before_change::{NEW_DOC_KEY, before_change};
use super::before_validate::{INTERNAL_KEY, SUBMITTED_AUTHORSHIP_KEY, before_validate};
use super::exec::Exec;
use super::heap::{Heap, Ref, V};
use super::mongoose::{apply_set, build_insert, cast_set_update};
use super::plan::WritePlan;
use super::read::read_document;
use super::run::{Operation, Run, S};
use super::transform::{iso, transform_write};
use super::{Bail, IdUse, Invalid, Prepared, PreparedWrite, UpdateInput, VersionWrite, WriteCtx};

fn new_run<'e>(
  plan: &'e WritePlan,
  ctx: &'e mut WriteCtx<'_>,
  operation: Operation,
  id: Option<JsVal>,
  saving_draft: bool,
) -> Result<Run<'e>, Bail> {
  if !ctx.context.is_nullish() && !matches!(ctx.context, JsVal::Obj(_)) {
    return Err(Bail::new("context:shape"));
  }
  if ctx.context.has(SUBMITTED_AUTHORSHIP_KEY) || ctx.context.has(INTERNAL_KEY) {
    // upstream mutates the object a previous operation left there
    return Err(Bail::new("context:submittedAuthorship"));
  }
  if matches!(ctx.locale, Some("all" | "*")) {
    return Err(Bail::new("locale:all"));
  }
  if plan.localization.is_some() != ctx.locale.is_some() {
    return Err(Bail::new("locale:missing"));
  }
  if let Some(drafts) = &plan.drafts {
    // `config.localization && hasDraftsEnabled && publishAllLocales`: the operation then runs
    // `validateLocalWithLocaleKeyedData` (a second validation lifecycle, not modelled).
    // `publishAllLocales = !draft && !(localizeStatus && locale !== 'all')` (no
    // `publishAllLocales` argument: the dispatch guards it; `locale: 'all'` bailed above)
    if plan.localization.is_some() && !ctx.draft && !drafts.localize_status {
      return Err(Bail::new("drafts:localizedPublish"));
    }
  }
  Ok(Run {
    locale: ctx.locale.map(str::to_string),
    merge_locale_actions: RefCell::new(Vec::new()),
    bail: RefCell::new(None),
    context_order: RefCell::new(Vec::new()),
    entropy: RefCell::new(&mut *ctx.entropy),
    errors: RefCell::new(Vec::new()),
    fallback_language: ctx.fallback_language,
    heap: RefCell::new(Heap::default()),
    id,
    internal: Cell::new(None),
    is_new_doc: Cell::new(None),
    language: ctx.language,
    operation,
    override_access: ctx.override_access,
    field_access: ctx.field_access,
    plan,
    restoring_version: ctx.context.get("isRestoringVersion").truthy(),
    root_data: Cell::new(None),
    submitted: Cell::new(None),
    t: ctx.t,
    user: ctx.user.clone(),
    status_field_access: Cell::new(false),
    saving_draft,
    autosave: ctx.autosave,
  })
}

/// `isSavingDraft`'s data write (create.ts / utilities/update.ts: `data._status = 'draft'`, before
/// beforeValidate).
fn mark_draft(run: &Run<'_>, data: Ref) -> Result<(), Bail> {
  if run.saving_draft { run.heap.borrow_mut().set(data, "_status", V::str("draft")) } else { Ok(()) }
}

/// With `localizeStatus` (a localized `_status`): what create.ts / update.ts do with
/// beforeChange's `_status` for one locale and no all-locales publication. A string (beforeChange
/// did not localize it) is expanded by upstream, not modelled; an update that is not a draft save
/// and publishes this locale reads the main document and writes `buildLocalizedPublishData`'s
/// merge (not modelled).
fn check_localized_status(run: &Run<'_>, result: Ref) -> Result<(), Bail> {
  if !run.plan.drafts.as_ref().is_some_and(|d| d.localize_status) || run.plan.localization.is_none() {
    return Ok(());
  }
  let heap = run.heap.borrow();
  let status = heap.get(&V::Ref(result), "_status");
  if status.as_str().is_some() {
    return Err(Bail::new("drafts:statusString"));
  }
  if run.operation == Operation::Update && !run.saving_draft && heap.is_obj(&status) {
    if let Some(locale) = run.locale.as_deref() {
      if heap.get(&status, locale).as_str() == Some("published") {
        return Err(Bail::new("drafts:localePublish"));
      }
    }
  }
  Ok(())
}

/// Runs one traversal to completion on a fresh executor.
fn drive<'r, 'e: 'r>(run: &'r Run<'e>, start: impl FnOnce(S<'r, 'e>) -> super::before_validate::Task<'r, ()>) -> Result<(), Bail> {
  let exec = Exec::new();
  let s = S { exec: exec.clone(), run };
  exec.spawn(start(s));
  exec.run();
  exec.clear();
  match run.bail.borrow_mut().take() {
    Some(bail) => Err(bail),
    None => Ok(()),
  }
}

fn context_writes(run: &Run<'_>) -> Vec<(String, JsVal)> {
  let heap = run.heap.borrow();
  run
    .context_order
    .borrow()
    .iter()
    .filter_map(|key| match *key {
      SUBMITTED_AUTHORSHIP_KEY => run.submitted.get().map(|r| (key.to_string(), heap.export(&V::Ref(r)))),
      NEW_DOC_KEY => run.is_new_doc.get().map(|b| (key.to_string(), JsVal::Bool(b))),
      INTERNAL_KEY => run.internal.get().map(|r| (key.to_string(), heap.export(&V::Ref(r)))),
      _ => None,
    })
    .collect()
}

fn invalid(run: &Run<'_>) -> Option<Invalid> {
  let errors = run.errors.borrow();
  if errors.is_empty() {
    return None;
  }
  Some(Invalid { collection: run.plan.slug.clone(), errors: errors.clone(), id: run.id.clone() })
}

fn import_obj(run: &Run<'_>, value: &JsVal, what: &str) -> Result<Ref, Bail> {
  let mut heap = run.heap.borrow_mut();
  let value = heap.import(value)?;
  value.as_ref().filter(|r| heap.obj(*r).is_some()).ok_or_else(|| Bail::new(format!("{what}:notObject")))
}

/// `payload.create` (collections/operations/create.ts) of an eligible collection.
pub fn prepare_create(plan: &WritePlan, data: &JsVal, ctx: &mut WriteCtx<'_>) -> Result<Prepared, Bail> {
  // `isSavingDraft = draft && hasDraftsEnabled && !publishAllLocales` (`draft` makes
  // `publishAllLocales` false)
  let saving_draft = ctx.draft && plan.drafts.is_some();
  let run = new_run(plan, ctx, Operation::Create, None, saving_draft)?;
  let data = import_obj(&run, data, "data")?;
  if run.heap.borrow().has(&V::Ref(data), "id") {
    return Err(Bail::new("create:id"));
  }
  mark_draft(&run, data)?;
  // `duplicatedFromDoc` (not duplicating) is the `doc` of both traversals
  let doc = run.heap.borrow_mut().new_obj();
  drive(&run, |s| before_validate(s, data, doc))?;
  let caller_data = run.heap.borrow().export(&V::Ref(data));
  // `docWithLocalesForFields`: `!statusFieldAccess ? { ...duplicatedFromDocWithLocales, _status:
  // {} } : duplicatedFromDocWithLocales` (`{}`: not duplicating)
  let doc_with_locales = {
    let mut heap = run.heap.borrow_mut();
    let r = heap.new_obj();
    if !run.status_field_access.get() {
      let status = heap.new_obj();
      heap.set(r, "_status", V::Ref(status))?;
    }
    r
  };
  let copy = {
    let mut heap = run.heap.borrow_mut();
    heap.deep_copy(&V::Ref(data)).as_ref().ok_or_else(|| Bail::new("data:copy"))?
  };
  run.root_data.set(Some(copy));
  drive(&run, |s| before_change(s, copy, V::Ref(doc), V::Ref(doc_with_locales)))?;
  let context_writes = context_writes(&run);
  if let Some(invalid) = invalid(&run) {
    return Ok(Prepared { caller_data: Some(caller_data), context_writes, outcome: Err(invalid) });
  }
  check_localized_status(&run, copy)?;
  let write = create_statements(&run, copy)?;
  Ok(Prepared { caller_data: Some(caller_data), context_writes, outcome: Ok(write) })
}

fn create_statements(run: &Run<'_>, data: Ref) -> Result<PreparedWrite, Bail> {
  let plan = run.plan;
  let mut heap = run.heap.borrow_mut();
  let target = V::Ref(data);
  // db-mongodb create.ts
  if !heap.get(&target, "createdAt").truthy() {
    let now = iso(run.now()?)?;
    heap.set(data, "createdAt", V::str(&now))?;
  }
  transform_write(plan, &mut heap, &plan.fields, data, &mut || run.now())?;
  if plan.allow_id_on_create && heap.get(&target, "id").truthy() {
    return Err(Bail::new("create:allowIDOnCreate"));
  }
  let doc = build_insert(&heap, &plan.schema, &target, &mut || run.object_id(IdUse::Document))?;
  let version = match &plan.versions {
    Some(_) => {
      let stored = read_document(plan, &mut heap, &doc)?;
      Some(version_statements(run, &mut heap, stored)?)
    }
    None => None,
  };
  Ok(PreparedWrite { doc, stored_after: None, draft: false, version })
}

/// `saveVersion` + db-mongodb `createVersion` (a new version; `updateLatestVersion` is not
/// modelled): the version insert and the latest-flip `updateMany` (none when mongoose's cast
/// leaves its update empty). `result` is saveVersion's `docWithLocales`: the stored document
/// after the write, or for a draft save beforeChange's result (then `versionData.updatedAt =
/// now` with timestamps).
fn version_statements(run: &Run<'_>, heap: &mut Heap, result: Ref) -> Result<VersionWrite, Bail> {
  let plan = run.plan;
  let versions = plan.versions.as_ref().ok_or_else(|| Bail::new("versions"))?;
  let now = iso(run.now()?)?;
  let version_data = heap.deep_copy(&V::Ref(result));
  let version_ref = version_data.as_ref().ok_or_else(|| Bail::new("version:data"))?;
  if plan.timestamps && run.saving_draft && run.operation == Operation::Update {
    // saveVersion's `draft` is `isSavingDraft` for updates (create passes none)
    heap.set(version_ref, "updatedAt", V::str(&now))?;
  }
  heap.delete(version_ref, "_id");
  let parent = heap.get(&V::Ref(result), "id");
  let data = heap.new_obj();
  for (key, value) in [
    ("autosave", V::Bool(run.autosave)),
    ("createdAt", V::str(&now)),
    ("latest", V::Bool(true)),
    ("parent", parent),
    ("publishedLocale", V::Undef),
    ("snapshot", V::Undef),
    ("updatedAt", V::str(&now)),
    ("version", version_data),
  ] {
    heap.set(data, key, value)?;
  }
  transform_write(plan, heap, &versions.fields, data, &mut || Err(Bail::new("version:clock")))?;
  let doc = build_insert(heap, &versions.schema, &V::Ref(data), &mut || run.object_id(IdUse::Version))?;
  let id = doc.get("_id").cloned().ok_or_else(|| Bail::new("version:_id"))?;
  let updated_at = match doc.get("updatedAt") {
    Some(Bson::DateTime(dt)) => *dt,
    _ => return Err(Bail::new("version:updatedAt")),
  };
  let parent = match doc.get("parent") {
    Some(parent) => parent.clone(),
    None => Bson::Null,
  };
  let flip_filter = doc! {
    "$and": [
      { "_id": { "$ne": id } },
      { "$or": [{ "parent": { "$eq": parent } }] },
      { "latest": { "$eq": true } },
      { "updatedAt": { "$lt": Bson::DateTime(DateTime::from_millis(updated_at.timestamp_millis())) } },
    ]
  };
  let flip_update = if versions.schema.paths.contains_key("latest") { doc! { "$unset": { "latest": 1 } } } else { Document::new() };
  Ok(VersionWrite { doc, flip_filter, flip_update })
}

/// `payload.update({ id })` / `updateByID` (collections/operations/updateByID.ts,
/// utilities/update.ts) of an eligible collection, after the lock check, on the stored document.
pub fn prepare_update(plan: &WritePlan, id: &JsVal, data: &JsVal, input: &UpdateInput, ctx: &mut WriteCtx<'_>) -> Result<Prepared, Bail> {
  // `isSavingDraft = draft && hasDraftsEnabled && data._status !== 'published' &&
  // !publishAllLocales` (`draft` makes `publishAllLocales` false)
  let saving_draft = ctx.draft && plan.drafts.is_some() && data.get("_status").as_str() != Some("published");
  let run = new_run(plan, ctx, Operation::Update, Some(id.clone()), saving_draft)?;
  // updateByID: `deepCopyObjectSimple(data)`; the caller's object is not touched
  let data = import_obj(&run, data, "data")?;
  mark_draft(&run, data)?;
  let original_doc = import_obj(&run, &input.original_doc, "originalDoc")?;
  let doc_with_locales = import_obj(&run, &input.doc_with_locales, "docWithLocales")?;
  drive(&run, |s| before_validate(s, data, original_doc))?;
  // `beforeChange({ data: { ...data, id } })`, then its `deepCopyObjectSimple`
  let copy = {
    let mut heap = run.heap.borrow_mut();
    let spread = heap.spread(data);
    let id = heap.import(id)?;
    heap.set(spread, "id", id)?;
    heap.deep_copy(&V::Ref(spread)).as_ref().ok_or_else(|| Bail::new("data:copy"))?
  };
  run.root_data.set(Some(copy));
  drive(&run, |s| before_change(s, copy, V::Ref(original_doc), V::Ref(doc_with_locales)))?;
  let context_writes = context_writes(&run);
  if let Some(invalid) = invalid(&run) {
    return Ok(Prepared { caller_data: None, context_writes, outcome: Err(invalid) });
  }
  check_localized_status(&run, copy)?;
  let write = if run.saving_draft { draft_statements(&run, copy)? } else { update_statements(&run, copy, &input.stored)? };
  Ok(Prepared { caller_data: None, context_writes, outcome: Ok(write) })
}

fn update_statements(run: &Run<'_>, result: Ref, stored: &Document) -> Result<PreparedWrite, Bail> {
  let plan = run.plan;
  let mut heap = run.heap.borrow_mut();
  // writeDocument: `{ ...result }`, `updatedAt = new Date().toISOString()`
  let data = heap.spread(result);
  let now = iso(run.now()?)?;
  heap.set(data, "updatedAt", V::str(&now))?;
  transform_write(plan, &mut heap, &plan.fields, data, &mut || run.now())?;
  let update = cast_set_update(&heap, &plan.schema, &V::Ref(data))?;
  let after = apply_set(stored, &update)?;
  let version = match &plan.versions {
    Some(_) => {
      let stored = read_document(plan, &mut heap, &after)?;
      Some(version_statements(run, &mut heap, stored)?)
    }
    None => None,
  };
  Ok(PreparedWrite { doc: update, stored_after: Some(after), draft: false, version })
}

/// utilities/update.ts `writeDocument` of a draft save: no `updateOne`, saveVersion on
/// beforeChange's `result`.
fn draft_statements(run: &Run<'_>, result: Ref) -> Result<PreparedWrite, Bail> {
  let mut heap = run.heap.borrow_mut();
  let version = match &run.plan.versions {
    Some(_) => Some(version_statements(run, &mut heap, result)?),
    None => return Err(Bail::new("drafts:versions")),
  };
  Ok(PreparedWrite { doc: Document::new(), stored_after: None, draft: true, version })
}
