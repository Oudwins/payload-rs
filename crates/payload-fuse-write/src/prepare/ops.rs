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
use super::plan::{Field, Kind, WritePlan};
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
    validation_pass: false,
  })
}

/// `config.localization && hasDraftsEnabled && publishAllLocales` (`publishAllLocales = !draft &&
/// !(localizeStatus && locale !== 'all')`; no `publishAllLocales` argument: the dispatch guards
/// it; `locale: 'all'` bailed in `new_run`): the operation validates every locale with
/// `validateLocalWithLocaleKeyedData` after its beforeChange (create.ts, utilities/update.ts; with
/// `localizeStatus` only for an authorized all-locales status, which needs `locale: 'all'`).
fn publishes_all_locales(plan: &WritePlan, draft: bool) -> bool {
  plan.localization.is_some() && plan.drafts.as_ref().is_some_and(|d| !d.localize_status) && !draft
}

/// The readings a validation pass would take (none: it skips the field hooks).
struct NoReadings;

impl super::Entropy for NoReadings {
  fn now(&mut self) -> Result<f64, Bail> {
    Err(Bail::new("drafts:localizedPublish:clock"))
  }

  fn object_id(&mut self, _used_for: IdUse) -> Result<[u8; 12], Bail> {
    Err(Bail::new("drafts:localizedPublish:objectId"))
  }
}

/// `validateLocalWithLocaleKeyedData({ data: dataWithLocales, locale: 'all' })`
/// (collections/operations/local/validate.ts, utilities/runLocaleScopedValidation.ts,
/// operations/validate.ts, utilities/runValidationLifecycle.ts with `skipAccessControl` and
/// `skipMutationHooks`): per locale code (`resolveValidationLocales`), on independent copies, the
/// data flattened to that locale (`flattenDataByLocale`) goes through beforeChange with
/// `skipHooks` and `isValidationOperation` on a request of that locale, then
/// `validateUniqueConstraints`. A pass without errors has no observable effect (the request,
/// its context and the data are clones; no hook runs, no reading is taken); any error bails, the
/// exact lane throws the aggregated `ValidationError`. Unique fields bail (their check reads the
/// database).
///
/// create: no id and no source data (`docWithLocales` and `originalDoc` are one `{}`); update:
/// `sourceData` is the operation's `docWithLocales` and `publicationHookDoc` (its `originalDoc`
/// here) as beforeChange left them, `originalDoc` of a pass being the latter for the request's
/// locale, else `docWithLocales` flattened to the pass's locale.
fn validate_all_locales(run: &Run<'_>, result: Ref, source: Option<(Ref, Ref)>) -> Result<(), Bail> {
  let plan = run.plan;
  let Some(localization) = &plan.localization else {
    return Ok(());
  };
  if plan.fields.iter().any(Field::has_unique) {
    return Err(Bail::new("drafts:localizedPublish:unique"));
  }
  let (data, source) = {
    let heap = run.heap.borrow();
    let source = source.map(|(doc_with_locales, original_doc)| (heap.export(&V::Ref(doc_with_locales)), heap.export(&V::Ref(original_doc))));
    (heap.export(&V::Ref(result)), source)
  };
  let mut seen: Vec<&str> = Vec::new();
  for locale in &localization.locale_codes {
    if seen.contains(&locale.as_str()) {
      continue;
    }
    seen.push(locale);
    let mut readings = NoReadings;
    let pass = Run {
      locale: Some(locale.clone()),
      merge_locale_actions: RefCell::new(Vec::new()),
      bail: RefCell::new(None),
      context_order: RefCell::new(Vec::new()),
      entropy: RefCell::new(&mut readings),
      errors: RefCell::new(Vec::new()),
      fallback_language: run.fallback_language,
      heap: RefCell::new(Heap::default()),
      id: run.id.clone(),
      internal: Cell::new(None),
      is_new_doc: Cell::new(None),
      language: run.language,
      operation: run.operation,
      override_access: run.override_access,
      field_access: run.field_access,
      plan,
      restoring_version: false,
      root_data: Cell::new(None),
      submitted: Cell::new(None),
      t: run.t,
      user: run.user.clone(),
      status_field_access: Cell::new(false),
      saving_draft: false,
      autosave: false,
      validation_pass: true,
    };
    let data = import_obj(&pass, &data, "data")?;
    flatten_by_locale(plan, &mut pass.heap.borrow_mut(), &plan.fields, data, locale, false)?;
    let (doc, doc_with_locales) = match &source {
      None => {
        let doc = pass.heap.borrow_mut().new_obj();
        (doc, doc)
      }
      Some((doc_with_locales, original_doc)) => {
        let original = if run.locale.as_deref() == Some(locale.as_str()) {
          import_obj(&pass, original_doc, "originalDoc")?
        } else {
          let copy = import_obj(&pass, doc_with_locales, "docWithLocales")?;
          flatten_by_locale(plan, &mut pass.heap.borrow_mut(), &plan.fields, copy, locale, false)?;
          copy
        };
        (original, import_obj(&pass, doc_with_locales, "docWithLocales")?)
      }
    };
    // `beforeChange({ data: id === undefined ? data : { ...data, id } })`, then its deep copy
    let data = match &run.id {
      Some(id) => {
        let mut heap = pass.heap.borrow_mut();
        let spread = heap.spread(data);
        let id = heap.import(id)?;
        heap.set(spread, "id", id)?;
        spread
      }
      None => data,
    };
    pass.root_data.set(Some(data));
    drive(&pass, |s| before_change(s, data, V::Ref(doc), V::Ref(doc_with_locales)))?;
    if !pass.errors.borrow().is_empty() {
      return Err(Bail::new("drafts:localizedPublish:invalid"));
    }
  }
  Ok(())
}

/// A value `flattenFields` descends into (`value && typeof value === 'object' &&
/// !Array.isArray(value)`): plain objects; typed values (dates, ObjectIds) bail.
fn flatten_object(heap: &Heap, value: &V) -> Result<Option<Ref>, Bail> {
  match value {
    V::Date(_) | V::Oid(_) => Err(Bail::new("flatten:typed")),
    V::Ref(r) if heap.obj(*r).is_some() => Ok(Some(*r)),
    _ => Ok(None),
  }
}

/// `getLocaleValue({ locale, value })`.
fn locale_value(heap: &Heap, value: &V, locale: &str) -> Result<V, Bail> {
  Ok(match flatten_object(heap, value)? {
    Some(r) => heap.get(&V::Ref(r), locale),
    None => value.clone(),
  })
}

/// The rows `flattenFields` descends into (`row && typeof row === 'object'`).
fn flatten_rows(heap: &Heap, value: &V) -> Result<Vec<Ref>, Bail> {
  let Some(rows) = value.as_ref().and_then(|r| heap.arr(r)) else {
    return Ok(Vec::new());
  };
  let mut out = Vec::with_capacity(rows.len());
  for row in rows {
    match flatten_object(heap, row)? {
      Some(r) => out.push(r),
      None if Heap::is_object_like(row) => return Err(Bail::new("flatten:row")),
      None => {}
    }
  }
  Ok(out)
}

/// `flattenDataByLocale`'s `flattenFields` (utilities/flattenDataByLocale.ts) on `data` in place
/// (the caller passes a copy).
fn flatten_by_locale(plan: &WritePlan, heap: &mut Heap, fields: &[Field], data: Ref, locale: &str, parent_localized: bool) -> Result<(), Bail> {
  let target = V::Ref(data);
  for field in fields {
    if field.affects_data() && field.kind != Kind::Tab {
      let name = field.name.as_deref().unwrap_or_default();
      if plan.localized_here(field, parent_localized) {
        let value = locale_value(heap, &heap.get(&target, name), locale)?;
        heap.set(data, name, value)?;
      }
      // `data[field.name] = transformStoredFieldValue(...)`: the identity for the modelled types
      // (the assignment still makes the key an own property)
      let value = heap.get(&target, name);
      heap.set(data, name, value.clone())?;
      let nested = parent_localized || field.localized;
      match field.kind {
        Kind::Array => {
          for r in flatten_rows(heap, &value)? {
            flatten_by_locale(plan, heap, &field.fields, r, locale, nested)?;
          }
        }
        Kind::Blocks => {
          for r in flatten_rows(heap, &value)? {
            if let Some(block) = super::transform::block_of_row_loose(heap, field, r)? {
              flatten_by_locale(plan, heap, &block.fields, r, locale, nested)?;
            }
          }
        }
        Kind::Group => {
          if let Some(r) = flatten_object(heap, &value)? {
            flatten_by_locale(plan, heap, &field.fields, r, locale, nested)?;
          }
        }
        _ => {}
      }
      continue;
    }
    match field.kind {
      Kind::Collapsible | Kind::Row => flatten_by_locale(plan, heap, &field.fields, data, locale, parent_localized)?,
      Kind::Tabs => {
        for tab in &field.tabs {
          match tab.name.as_deref() {
            Some(name) => {
              if plan.localized_here(tab, parent_localized) {
                let value = locale_value(heap, &heap.get(&target, name), locale)?;
                heap.set(data, name, value)?;
              }
              if let Some(r) = flatten_object(heap, &heap.get(&target, name))? {
                flatten_by_locale(plan, heap, &tab.fields, r, locale, parent_localized || tab.localized)?;
              }
            }
            None => flatten_by_locale(plan, heap, &tab.fields, data, locale, parent_localized)?,
          }
        }
      }
      _ => {}
    }
  }
  Ok(())
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
  let publish_all_locales = publishes_all_locales(plan, ctx.draft);
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
  if publish_all_locales {
    validate_all_locales(&run, copy, None)?;
  }
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
  let publish_all_locales = publishes_all_locales(plan, ctx.draft);
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
  if publish_all_locales {
    validate_all_locales(&run, copy, Some((doc_with_locales, original_doc)))?;
  }
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
