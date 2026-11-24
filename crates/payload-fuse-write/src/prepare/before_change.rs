//! `beforeChange` (packages/payload/src/fields/hooks/beforeChange/{index,traverseFields,promise}.ts)
//! for the modelled field kinds: Payload's own hooks, `hasInvalidFieldValueShape`, the default
//! validators (payload-core-validate), the validation errors with their labels.

use payload_core_validate::{FilterOptionsCall, FindArgs, Req, Translate, ValidateHost, ValidationResult, Validator};
use payload_engine::bson::object_id_to_hex;
use payload_engine::error::{EngineError, Result as EngineResult};
use payload_engine::js::{JsVal, Obj as JsObj};

use super::before_validate::{Task, block_to_match, existing_row_doc};
use super::exec::{tick, ticks};
use super::heap::{Heap, Ref, V};
use super::plan::{Authorship, Field, Kind, Label, Lexical, NodeValidation, OwnHook, RelationTo, Tab, Validate};
use super::run::{Operation, S};
use super::{Bail, FieldError, IdUse};

pub const NEW_DOC_KEY: &str = "_isNewDoc";

/// One `traverseFields` call's arguments that differ between calls.
#[derive(Clone)]
struct Level {
  data: V,
  doc: V,
  doc_with_locales: V,
  /// Upstream's `parentPath` for the named fields of this level.
  parent_path: String,
  /// `fieldLabelPath`; `None` when a label on the way is a function (an error here bails).
  label_path: Option<String>,
  skip_validation: bool,
  parent_is_localized: bool,
}

/// `beforeChange({ data, doc, docWithLocales })` after its `deepCopyObjectSimple(data)` (the
/// caller passes the copy): `recordNewDoc`, then `await traverseFields(...)`.
pub fn before_change<'r, 'e: 'r>(s: S<'r, 'e>, data: Ref, doc: V, doc_with_locales: V) -> Task<'r, ()> {
  Box::pin(async move {
    let run = s.run;
    let is_new = match &doc_with_locales {
      V::Ref(r) => run.heap.borrow().obj(*r).is_some_and(|o| o.is_empty()),
      _ => true,
    };
    run.is_new_doc.set(Some(is_new));
    run.note_context(NEW_DOC_KEY);
    let level = Level {
      data: V::Ref(data),
      doc,
      doc_with_locales,
      label_path: Some(String::new()),
      parent_is_localized: false,
      parent_path: String::new(),
      skip_validation: false,
    };
    s.exec.spawn(traverse_fields(s.clone(), &run.plan.fields, level)).wait().await;
    if run.failed() || !run.errors.borrow().is_empty() {
      return;
    }
    // `for (const action of mergeLocaleActions) await action()`
    let actions = std::mem::take(&mut *run.merge_locale_actions.borrow_mut());
    for (sibling_data, doc_with_locales, name) in actions {
      if let Err(bail) = merge_locale(&s, sibling_data, &doc_with_locales, &name) {
        return run.fail(bail);
      }
      tick().await;
    }
  })
}

/// One of `mergeLocaleActions`: the field's value becomes `{ [locale]: value }` of the stored
/// locales with the submitted one for `req.locale`.
fn merge_locale(s: &S<'_, '_>, sibling_data: Ref, doc_with_locales: &V, name: &str) -> Result<(), Bail> {
  let run = s.run;
  let localization = run.plan.localization.as_ref().ok_or_else(|| Bail::new("localization"))?;
  let mut heap = run.heap.borrow_mut();
  let submitted = heap.get(&V::Ref(sibling_data), name);
  let existing = heap.get(doc_with_locales, name);
  let locale_data = heap.new_obj();
  let mut any = false;
  for code in &localization.locale_codes {
    let value = if run.locale.as_deref() == Some(code.as_str()) { submitted.clone() } else { heap.get(&existing, code) };
    if !value.is_undef() {
      heap.set(locale_data, code, value)?;
      any = true;
    }
  }
  if any {
    heap.set(sibling_data, name, V::Ref(locale_data))?;
  }
  Ok(())
}

fn traverse_fields<'r, 'e: 'r>(s: S<'r, 'e>, fields: &'r [Field], level: Level) -> Task<'r, ()> {
  Box::pin(async move {
    if s.run.failed() {
      return;
    }
    let promises = fields.iter().map(|field| s.exec.spawn(promise(s.clone(), field, level.clone()))).collect();
    s.exec.all(promises).wait().await;
  })
}

fn traverse_tabs<'r, 'e: 'r>(s: S<'r, 'e>, tabs: &'r [Tab], level: Level) -> Task<'r, ()> {
  Box::pin(async move {
    let promises = tabs
      .iter()
      .map(|tab| {
        let s2 = s.clone();
        let mut inner = level.clone();
        s.exec.spawn(async move {
          // an unnamed tab: `getTranslatedLabel(field?.label || field.name)`
          inner.label_path = match tab_label(&s2, &tab.label) {
            LabelText::False => inner.label_path,
            LabelText::Text(text) => inner.label_path.map(|parent| build_field_label(&parent, text.as_deref())),
            LabelText::Unknown => None,
          };
          s2.exec.spawn(traverse_fields(s2.clone(), &tab.fields, inner)).wait().await;
        })
      })
      .collect();
    s.exec.all(promises).wait().await;
  })
}

fn join_path(parent: &str, name: &str) -> String {
  if parent.is_empty() { name.to_string() } else { format!("{parent}.{name}") }
}

fn promise<'r, 'e: 'r>(s: S<'r, 'e>, field: &'r Field, level: Level) -> Task<'r, ()> {
  Box::pin(async move {
    if s.run.failed() {
      return;
    }
    let run = s.run;
    let Some(sd) = level.data.as_ref().filter(|r| run.heap.borrow().obj(*r).is_some()) else {
      return run.fail(Bail::new("beforeChange:siblingData"));
    };
    let name = field.name.as_deref().unwrap_or_default();
    let path = if field.affects_data() { join_path(&level.parent_path, name) } else { level.parent_path.clone() };
    let localized_here = run.plan.localized_here(field, level.parent_is_localized);
    let mut skip_validation = level.skip_validation;
    if field.affects_data() {
      if let Some(localization) = &run.plan.localization {
        let operation_locale = run.locale.as_deref().unwrap_or(&localization.default_locale);
        if localized_here
          && operation_locale != localization.default_locale
          && matches!(field.kind, Kind::Array | Kind::Blocks)
          && matches!(run.get(&level.data, name), V::Null)
        {
          skip_validation = true;
        }
      }
      for hook in &field.before_change {
        let hooked = match hook {
          OwnHook::RowIdBeforeChange => {
            let value = run.get(&level.data, name);
            if value.truthy() {
              value
            } else {
              match run.object_id(IdUse::Row) {
                Ok(id) => V::str(&object_id_to_hex(&id)),
                Err(bail) => return run.fail(bail),
              }
            }
          }
          OwnHook::AuthorshipBeforeChange(which) => match authorship_before_change(&s, *which, &level) {
            Ok(value) => value,
            Err(bail) => return run.fail(bail),
          },
          OwnHook::AuthorshipBeforeValidate(_) => return run.fail(Bail::new("beforeChange:hook")),
        };
        // `await callUserFunction(hook)` of a synchronous hook
        tick().await;
        if !hooked.is_undef() && run.check(run.set(sd, name, hooked)).is_none() {
          return;
        }
      }
      let value = run.get(&level.data, name);
      if has_invalid_field_value_shape(&run.heap.borrow(), field, &value) {
        let message = match translate(&s, "validation:invalidInput") {
          Ok(message) => message,
          Err(bail) => return run.fail(bail),
        };
        return push_error(&s, field, &level, message, &path);
      }
      if !skip_validation {
        if let Some(result) = validate(&s, field, &value, &path).await {
          if let Some(message) = result {
            push_error(&s, field, &level, message, &path);
          }
        } else {
          return;
        }
      }
      if localized_here {
        run.merge_locale_actions.borrow_mut().push((sd, level.doc_with_locales.clone(), name.to_string()));
      }
    }
    let mut level = level;
    level.skip_validation = skip_validation;
    let child_localized = level.parent_is_localized || field.localized;
    match field.kind {
      Kind::Array => {
        let rows = run.get(&level.data, name);
        let Some(rows) = rows.as_ref().and_then(|r| run.heap.borrow().arr(r).cloned()) else {
          return;
        };
        let existing = run.get(&level.doc, name);
        let existing_with_locales = run.get(&level.doc_with_locales, name);
        let label = translated_label(&s, &field.label, name);
        let mut promises = Vec::with_capacity(rows.len());
        for (index, row) in rows.into_iter().enumerate() {
          if !run.heap.borrow().is_obj(&row) {
            return run.fail(Bail::new("beforeChange:row"));
          }
          let Some(doc) = run.check(existing_row_doc(&run.heap, &row, &existing)) else {
            return;
          };
          let Some(doc_with_locales) = run.check(existing_row_doc(&run.heap, &row, &existing_with_locales)) else {
            return;
          };
          let label_path = match (&field.label, &label) {
            (Label::False, _) => level.label_path.clone(),
            (_, LabelText::Text(text)) => level
              .label_path
              .as_ref()
              .map(|parent| build_field_label(parent, Some(&format!("{} {}", text.as_deref().unwrap_or("undefined"), index + 1)))),
            _ => None,
          };
          let inner = Level {
            data: row,
            doc,
            doc_with_locales,
            label_path,
            parent_is_localized: child_localized,
            parent_path: format!("{path}.{index}"),
            skip_validation: level.skip_validation,
          };
          promises.push(s.exec.spawn(traverse_fields(s.clone(), &field.fields, inner)));
        }
        s.exec.all(promises).wait().await;
      }
      Kind::Blocks => {
        let rows = run.get(&level.data, name);
        let Some(rows) = rows.as_ref().and_then(|r| run.heap.borrow().arr(r).cloned()) else {
          return;
        };
        let existing = run.get(&level.doc, name);
        let existing_with_locales = run.get(&level.doc_with_locales, name);
        let mut promises = Vec::with_capacity(rows.len());
        for (index, row) in rows.into_iter().enumerate() {
          if !run.heap.borrow().is_obj(&row) {
            return run.fail(Bail::new("beforeChange:row"));
          }
          let Some(doc) = run.check(existing_row_doc(&run.heap, &row, &existing)) else {
            return;
          };
          let Some(doc_with_locales) = run.check(existing_row_doc(&run.heap, &row, &existing_with_locales)) else {
            return;
          };
          let Some(block) = run.check(block_to_match(&run.heap.borrow(), field, &row, &doc)) else {
            return;
          };
          let Some((block, block_type)) = block else {
            continue;
          };
          let label_path = match &field.label {
            Label::False => level.label_path.clone(),
            label => block_label_path(&s, label, name, &block.label, &block_type, index, level.label_path.as_deref()),
          };
          let inner = Level {
            data: row,
            doc,
            doc_with_locales,
            label_path,
            parent_is_localized: child_localized,
            parent_path: format!("{path}.{index}"),
            skip_validation: level.skip_validation,
          };
          promises.push(s.exec.spawn(traverse_fields(s.clone(), &block.fields, inner)));
        }
        s.exec.all(promises).wait().await;
      }
      Kind::Collapsible | Kind::Row => {
        let mut inner = level.clone();
        if field.kind == Kind::Collapsible && !matches!(field.label, Label::False) {
          inner.label_path = match translated_label(&s, &field.label, field.kind.name()) {
            LabelText::Text(text) => level.label_path.as_ref().map(|parent| build_field_label(parent, text.as_deref())),
            _ => None,
          };
        }
        s.exec.spawn(traverse_fields(s.clone(), &field.fields, inner)).wait().await;
      }
      Kind::Group => {
        let Some(mut inner) = run.check(group_level(&s, field, sd, &level, &path)) else {
          return;
        };
        inner.parent_is_localized = child_localized;
        s.exec.spawn(traverse_fields(s.clone(), &field.fields, inner)).wait().await;
      }
      Kind::Tabs => {
        // `getTranslatedLabel(field?.label || '')`: tabs carry no label in the modelled configs
        s.exec.spawn(traverse_tabs(s.clone(), &field.tabs, level.clone())).wait().await;
      }
      Kind::RichText => {
        // lexical's editor `beforeChange` hook: without node ids (beforeValidate bailed on them)
        // its `originalNodeIDMap` is empty and it returns `value`
        tick().await;
        let value = run.get(&level.data, name);
        if !value.is_undef() && run.check(run.set(sd, name, value)).is_none() {
          return;
        }
      }
      _ => {}
    }
  })
}

fn group_level(s: &S<'_, '_>, field: &Field, sd: Ref, level: &Level, path: &str) -> Result<Level, Bail> {
  let name = field.name.as_deref().unwrap_or_default();
  let run = s.run;
  let mut heap = run.heap.borrow_mut();
  for holder in [&V::Ref(sd), &level.doc, &level.doc_with_locales] {
    if !Heap::is_object_like(&heap.get(holder, name)) {
      let r = holder.as_ref().filter(|r| heap.obj(*r).is_some()).ok_or_else(|| Bail::new("group:holder"))?;
      let empty = heap.new_obj();
      heap.set(r, name, V::Ref(empty))?;
    }
  }
  let data = heap.get(&V::Ref(sd), name);
  let doc = heap.get(&level.doc, name);
  let doc_with_locales = heap.get(&level.doc_with_locales, name);
  if !heap.is_obj(&data) || !heap.is_obj(&doc) || !heap.is_obj(&doc_with_locales) {
    return Err(Bail::new("group:notObject"));
  }
  drop(heap);
  let label_path = match &field.label {
    Label::False => level.label_path.clone(),
    label => match translated_label(s, label, name) {
      LabelText::Text(text) => level.label_path.as_ref().map(|parent| build_field_label(parent, text.as_deref())),
      _ => None,
    },
  };
  Ok(Level {
    data,
    doc,
    doc_with_locales,
    label_path,
    parent_is_localized: level.parent_is_localized,
    parent_path: path.to_string(),
    skip_validation: level.skip_validation,
  })
}

/// `${getTranslatedLabel(field?.label || field?.name)} > ${req.t('fields:block')} ${rowIndex + 1}
/// (${getTranslatedLabel(block?.labels?.singular || blockTypeToMatch)})`, under the parent's.
fn block_label_path(
  s: &S<'_, '_>,
  label: &Label,
  name: &str,
  block_label: &Label,
  block_type: &V,
  index: usize,
  parent: Option<&str>,
) -> Option<String> {
  let field_label = match translated_label(s, label, name) {
    LabelText::Text(text) => text.unwrap_or_else(|| "undefined".to_string()),
    _ => return None,
  };
  let block_text = match block_label {
    Label::Absent | Label::False => block_type.as_str().map(str::to_string)?,
    Label::Str(text) if text.is_empty() => block_type.as_str().map(str::to_string)?,
    other => match translated_label(s, other, "") {
      LabelText::Text(text) => text.unwrap_or_else(|| "undefined".to_string()),
      _ => return None,
    },
  };
  let block_word = translate(s, "fields:block").ok()?;
  Some(build_field_label(parent?, Some(&format!("{field_label} > {block_word} {} ({block_text})", index + 1))))
}

/// `setCreatedBy` / `setUpdatedBy` (fields/baseFields/authorship).
fn authorship_before_change(s: &S<'_, '_>, which: Authorship, level: &Level) -> Result<V, Bail> {
  let run = s.run;
  let key = which.key();
  let previous = run.get(&level.doc, key);
  if which == Authorship::CreatedBy && run.operation != Operation::Create {
    // not a first write (collections: `operation === 'create'`)
    return Ok(previous);
  }
  let submitted = run.submitted.get().is_some_and(|r| matches!(run.get(&V::Ref(r), key), V::Bool(true)));
  if run.override_access && submitted {
    // `data?.updatedBy` / `data?.createdBy`: the top-level data of beforeChange
    return Ok(run.get(&level_root(s), key));
  }
  match &run.user {
    Some((collection, id)) if !id.is_nullish() && !collection.is_empty() => {
      let mut heap = run.heap.borrow_mut();
      let relation = heap.new_obj();
      let value = heap.import(id)?;
      heap.set(relation, "relationTo", V::str(collection))?;
      heap.set(relation, "value", value)?;
      Ok(V::Ref(relation))
    }
    _ => Ok(previous),
  }
}

/// The authorship fields are top-level (sanitization appends them to `collection.fields`).
fn level_root(s: &S<'_, '_>) -> V {
  V::Ref(s.run.root_data.get().unwrap_or_default())
}

/// `hasInvalidFieldValueShape({ field, value })`.
fn has_invalid_field_value_shape(heap: &Heap, field: &Field, value: &V) -> bool {
  if value.is_nullish() || !field.affects_data() {
    return false;
  }
  let is_object = Heap::is_object_like(value);
  match field.kind {
    Kind::Array | Kind::Blocks => !(heap.is_arr(value) || matches!(value, V::Num(_))),
    Kind::Number => is_object && !(field.has_many && heap.is_arr(value)),
    Kind::Relationship if field.has_many => {
      if !is_object || heap.is_arr(value) {
        return false;
      }
      let RelationTo::Many(slugs) = &field.relation_to else {
        return true;
      };
      let Some(obj) = value.as_ref().and_then(|r| heap.obj(r)) else {
        return true;
      };
      let single = obj.len() == 2
        && matches!(obj.get("relationTo"), Some(V::Str(slug)) if slugs.iter().any(|s| s == &**slug))
        && matches!(obj.get("value"), Some(V::Str(_) | V::Num(_)));
      !single
    }
    _ => false,
  }
}

/// Runs `field.validate`; `None` when the run bailed, `Some(Some(message))` for an error.
async fn validate(s: &S<'_, '_>, field: &Field, value: &V, path: &str) -> Option<Option<String>> {
  let run = s.run;
  match &field.validate {
    Validate::None => Some(None),
    Validate::True => {
      tick().await;
      Some(None)
    }
    Validate::Default(validator, field_options) => {
      let outcome = if *validator == Validator::RichText {
        lexical_validate(s, field, field_options, value)
      } else {
        run_validator(s, *validator, field_options, value, path)
      };
      let (result, job_ticks) = match outcome {
        Ok(result) => result,
        Err(bail) => {
          run.fail(bail);
          return None;
        }
      };
      ticks(job_ticks).await;
      if run.failed() {
        return None;
      }
      match result {
        ValidationResult::Valid => Some(None),
        ValidationResult::Invalid(message) => Some(Some(message)),
      }
    }
  }
}

/// The validator's result and how many jobs `await validate(...)` takes: synchronous validators
/// and async ones returning a value resume after one job; `relationship` returning
/// `validateFilterOptions(...)` (a promise from an async function) after three.
fn run_validator(
  s: &S<'_, '_>,
  validator: Validator,
  field_options: &JsVal,
  value: &V,
  path: &str,
) -> Result<(ValidationResult, usize), Bail> {
  let run = s.run;
  let value = run.heap.borrow().export(value);
  let mut options = field_options.as_obj().cloned().unwrap_or_default();
  let extras: [(&str, JsVal); 7] = [
    ("id", run.id.clone().unwrap_or_default()),
    ("collectionSlug", JsVal::str(&*run.plan.slug)),
    ("event", JsVal::str("submit")),
    ("operation", JsVal::str(run.operation.name())),
    ("overrideAccess", JsVal::Bool(run.override_access)),
    ("path", JsVal::arr(path.split('.').filter(|p| !p.is_empty()).map(JsVal::str).collect())),
    ("preferences", JsVal::obj(JsObj::from_iter([("fields".to_string(), JsVal::obj(JsObj::new()))]))),
  ];
  for (key, extra) in extras {
    options.insert(key.to_string(), extra);
  }
  let options = JsVal::obj(options);
  let translate = MaybeTranslate(run.t);
  let req = Req {
    collections: &run.plan.validate_collections,
    config: &run.plan.validate_config,
    default_id_type: &run.plan.default_id_type,
    host: &NoHost,
    t: &translate,
  };
  let result = payload_core_validate::validate(validator, &value, &options, &req).map_err(|e| Bail::new(format!("validate:{e}")))?;
  let jobs = if validator == Validator::Relationship {
    match payload_core_validate::relationship_prefix(&value, &options, &req).map_err(|e| Bail::new(format!("validate:{e}")))? {
      Some(_) => 1,
      None => 3,
    }
  } else {
    1
  };
  Ok((result, jobs))
}

/// lexical's `richTextValidate` (richtext-lexical validate/) behind payload's `validations.richText`:
/// the result and the jobs `await validate(...)` takes. `validations.richText` returns the editor's
/// promise from an async function (resolved one job after `max(R, 1)`, R being when the editor's
/// promise settles), and `validateNodes` awaits itself once per node with `children`.
fn lexical_validate(s: &S<'_, '_>, field: &Field, field_options: &JsVal, value: &V) -> Result<(ValidationResult, usize), Bail> {
  let run = s.run;
  let lexical = field.lexical.as_ref().ok_or_else(|| Bail::new("lexical:plan"))?;
  let heap = run.heap.borrow();
  if !value.is_nullish() && !heap.is_obj(value) {
    return Err(Bail::new("lexical:value"));
  }
  let root = heap.get(value, "root");
  if !root.is_nullish() && !heap.is_obj(&root) {
    return Err(Bail::new("lexical:root"));
  }
  let children = heap.get(&root, "children");
  if !children.is_nullish() && !heap.is_arr(&children) {
    return Err(Bail::new("lexical:children"));
  }
  if field_options.get("required").truthy() && !has_text(&heap, &children)? {
    let message = translate(s, "validation:required")?;
    return Ok((ValidationResult::Invalid(message), 3));
  }
  let (settled, result) = match children.as_ref().and_then(|r| heap.arr(r)) {
    Some(nodes) if !nodes.is_empty() => {
      let (jobs, failure) = validate_nodes(s, &heap, nodes, lexical)?;
      (jobs + 1, failure.map_or(ValidationResult::Valid, ValidationResult::Invalid))
    }
    _ => (0, ValidationResult::Valid),
  };
  Ok((result, settled.max(1) + 2))
}

/// `hasText(value)` of the root's `children` (an array or nullish).
fn has_text(heap: &Heap, children: &V) -> Result<bool, Bail> {
  let Some(nodes) = children.as_ref().and_then(|r| heap.arr(r)) else {
    return Ok(false);
  };
  if nodes.is_empty() {
    return Ok(false);
  }
  if nodes.len() == 1 && matches!(heap.get(&nodes[0], "type"), V::Str(t) if &*t == "paragraph") {
    let paragraph_children = heap.get(&nodes[0], "children");
    match paragraph_children.as_ref().and_then(|r| heap.arr(r)) {
      None if paragraph_children.is_nullish() => return Ok(false),
      None => return Err(Bail::new("lexical:paragraph")),
      Some(items) if items.is_empty() => return Ok(false),
      Some(items) if items.len() == 1 && matches!(heap.get(&items[0], "type"), V::Str(t) if &*t == "text") => {
        let text = heap.get(&items[0], "text");
        return match text {
          V::Str(t) => Ok(!t.is_empty()),
          V::Undef | V::Null => Ok(false),
          _ => Err(Bail::new("lexical:text")),
        };
      }
      Some(_) => {}
    }
  }
  Ok(true)
}

/// `validateNodes({ nodes, nodeValidations })`: when it settles (jobs after its call) and its
/// failure message; a node type whose validations are not ported bails.
fn validate_nodes(s: &S<'_, '_>, heap: &Heap, nodes: &[V], lexical: &Lexical) -> Result<(usize, Option<String>), Bail> {
  let mut jobs = 0;
  for node in nodes {
    if !heap.is_obj(node) {
      return Err(Bail::new("lexical:node"));
    }
    let node_type = match heap.get(node, "type") {
      V::Str(t) if lexical.validated.iter().any(|v| v == &*t) => return Err(Bail::new("lexical:validatedNode")),
      V::Str(t) => Some(t),
      V::Undef => None,
      _ => return Err(Bail::new("lexical:nodeType")),
    };
    for validation in node_type.as_ref().and_then(|t| lexical.node_validations.get(&**t)).into_iter().flatten() {
      // `await validation({ node, ... })` of a synchronous validation
      jobs += 1;
      if let Some(message) = node_validation(s, heap, node, validation)? {
        let node_type = node_type.as_deref().unwrap_or_default();
        return Ok((jobs, Some(format!("{node_type} node failed to validate: {message}"))));
      }
    }
    let children = heap.get(node, "children");
    if heap.has(node, "children") && children.truthy() {
      let Some(items) = children.as_ref().and_then(|r| heap.arr(r)) else {
        return Err(Bail::new("lexical:children"));
      };
      let (child_jobs, failure) = validate_nodes(s, heap, items, lexical)?;
      jobs += child_jobs + 1;
      if failure.is_some() {
        return Ok((jobs, failure));
      }
    }
  }
  Ok((jobs, None))
}

/// richtext-lexical's `headingValidation` / `listValidation` / `listItemValidation`: `None` when
/// valid.
fn node_validation(s: &S<'_, '_>, heap: &Heap, node: &V, validation: &NodeValidation) -> Result<Option<String>, Bail> {
  let enabled = |allowed: &[String]| matches!(heap.get(node, "relationTo"), V::Str(slug) if allowed.iter().any(|a| a == &*slug));
  Ok(match validation {
    NodeValidation::Relationship(allowed) => {
      if enabled(allowed) {
        None
      } else {
        Some(translate(s, "validation:invalidSelection")?)
      }
    }
    NodeValidation::Upload(allowed, form_state) => {
      if !enabled(allowed) {
        return Ok(Some(translate(s, "validation:invalidSelection")?));
      }
      let slug = heap.get(node, "relationTo");
      let slug = slug.as_str().unwrap_or_default();
      // `payload.collections[relationTo]?.customIDType || payload.db.defaultIDType`
      let id_type = match s.run.plan.relations.get(slug) {
        Some(Some(custom)) => custom.clone(),
        Some(None) => s.run.plan.default_id_type.as_str().unwrap_or_default().to_string(),
        None => return Err(Bail::new("lexical:uploadCollection")),
      };
      let value = heap.get(node, "value");
      let inner = heap.get(&value, "id");
      let id = if inner.truthy() { inner } else { value };
      let valid = match (id_type.as_str(), &id) {
        ("text", V::Str(s)) => !s.is_empty(),
        ("text", V::Ref(_) | V::Date(_) | V::Oid(_)) => return Err(Bail::new("lexical:uploadID")),
        ("text", _) => false,
        ("number", V::Num(n)) => !n.is_nan(),
        ("number", _) => false,
        _ => return Err(Bail::new("lexical:uploadIDType")),
      };
      if !valid {
        return Ok(Some(translate(s, "validation:validUploadID")?));
      }
      if form_state.iter().any(|f| f == slug) {
        return Err(Bail::new("lexical:uploadFields"));
      }
      None
    }
    NodeValidation::Heading(allowed) => {
      let tag = heap.get(node, "tag");
      if tag.as_str().is_some_and(|t| allowed.iter().any(|a| a == t)) {
        None
      } else if allowed.is_empty() {
        Some("Headings are not enabled.".to_string())
      } else {
        Some(format!("Heading tag must be one of {}.", allowed.join(", ")))
      }
    }
    NodeValidation::List => match heap.get(node, "tag") {
      V::Str(t) if matches!(&*t, "ol" | "ul") => None,
      _ => Some("List tag must be one of ol, ul.".to_string()),
    },
    NodeValidation::ListItem => match heap.get(node, "value") {
      V::Num(n) if n.is_finite() => None,
      _ => Some("List item value must be a finite number.".to_string()),
    },
  })
}

/// `req.t`, or an error when the caller gave none (the failure then bails).
struct MaybeTranslate<'a>(Option<&'a dyn Translate>);

impl Translate for MaybeTranslate<'_> {
  fn t(&self, key: &str, vars: Option<&JsObj>) -> EngineResult<String> {
    match self.0 {
      Some(t) => t.t(key, vars),
      None => Err(EngineError::internal("no translations")),
    }
  }
}

/// The validators of the modelled fields call no JS.
struct NoHost;

impl ValidateHost for NoHost {
  fn filter_options(&self, _func: u32, _call: FilterOptionsCall<'_>) -> EngineResult<JsVal> {
    Err(EngineError::internal("filterOptions"))
  }

  fn find(&self, _args: FindArgs<'_>) -> EngineResult<JsVal> {
    Err(EngineError::internal("find"))
  }

  fn log_error(&self, _msg: &str, _err: &EngineError) -> EngineResult<()> {
    Err(EngineError::internal("logger"))
  }

  fn validate_json_schema(&self, _json_schema: &JsVal, _value: &JsVal) -> EngineResult<ValidationResult> {
    Err(EngineError::internal("jsonSchema"))
  }

  fn rich_text_validate(&self, _editor: &JsVal, _value: &JsVal, _options: &JsVal) -> EngineResult<ValidationResult> {
    Err(EngineError::internal("richText"))
  }
}

fn translate(s: &S<'_, '_>, key: &str) -> Result<String, Bail> {
  MaybeTranslate(s.run.t).t(key, None).map_err(|_| Bail::new("validation:translations"))
}

enum LabelText {
  False,
  /// `getTranslatedLabel(...)`: a string, or `undefined`.
  Text(Option<String>),
  /// A function label.
  Unknown,
}

/// `getTranslatedLabel(field?.label || fallback, req.i18n)`.
fn translated_label(s: &S<'_, '_>, label: &Label, fallback: &str) -> LabelText {
  match label {
    Label::Absent | Label::False => LabelText::Text(Some(fallback.to_string())),
    Label::Str(text) if text.is_empty() => LabelText::Text(Some(fallback.to_string())),
    Label::Str(text) => LabelText::Text(Some(text.clone())),
    Label::Map(map) => get_translation(s, map),
    Label::Function => LabelText::Unknown,
  }
}

/// An unnamed tab's label (`field?.label || field.name`, the name being `undefined`).
fn tab_label(s: &S<'_, '_>, label: &Label) -> LabelText {
  match label {
    Label::False => LabelText::False,
    Label::Absent => LabelText::Text(None),
    Label::Str(text) if text.is_empty() => LabelText::Text(None),
    other => translated_label(s, other, ""),
  }
}

/// `getTranslation(label, i18n)` of a language map.
fn get_translation(s: &S<'_, '_>, map: &JsVal) -> LabelText {
  let run = s.run;
  let text = |value: &JsVal| match value {
    JsVal::Str(text) => Some(LabelText::Text(Some(text.to_string()))),
    JsVal::Undefined => Some(LabelText::Text(None)),
    _ => None,
  };
  let own = map.get(run.language);
  if own.truthy() {
    return text(own).unwrap_or(LabelText::Unknown);
  }
  if let Some(fallback) = run.fallback_language.iter().find(|language| map.get(language).truthy()) {
    return text(map.get(fallback)).unwrap_or(LabelText::Unknown);
  }
  let first = map.as_obj().and_then(|o| o.values().next().cloned()).unwrap_or_default();
  text(&first).unwrap_or(LabelText::Unknown)
}

/// `buildFieldLabel(parentLabel, label)`.
fn build_field_label(parent: &str, label: Option<&str>) -> String {
  let Some(label) = label.filter(|l| !l.is_empty()) else {
    return parent.to_string();
  };
  let mut chars = label.chars();
  let first = chars.next().unwrap_or_default();
  // `charAt(0).toUpperCase()`: one UTF-16 unit; astral characters are left as they are
  let capitalized = if (first as u32) > 0xFFFF { label.to_string() } else { format!("{}{}", js_upper(first), chars.as_str()) };
  if parent.is_empty() { capitalized } else { format!("{parent} > {capitalized}") }
}

/// `String.prototype.toUpperCase` of one BMP character.
fn js_upper(c: char) -> String {
  c.to_uppercase().collect()
}

fn push_error(s: &S<'_, '_>, field: &Field, level: &Level, message: String, path: &str) {
  let run = s.run;
  let name = field.name.as_deref().unwrap_or_default();
  let Some(parent) = &level.label_path else {
    return run.fail(Bail::new("validation:label"));
  };
  let label = match translated_label(s, &field.label, name) {
    LabelText::Text(text) => build_field_label(parent, text.as_deref()),
    _ => return run.fail(Bail::new("validation:label")),
  };
  run.errors.borrow_mut().push(FieldError { label, message, path: path.to_string() });
}
