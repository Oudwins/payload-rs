//! `beforeValidate` (packages/payload/src/fields/hooks/beforeValidate/{index,traverseFields,
//! promise,getFallbackValue}.ts, fields/getDefaultValue.ts) for the modelled field kinds, one task
//! per upstream `async` function, awaiting where upstream awaits (exec.rs).

use std::future::Future;
use std::pin::Pin;

use payload_core_validate::js::{number_to_string, parse_float_str, trim};
use payload_engine::bson::object_id_to_hex;

use super::Bail;
use super::IdUse;
use super::exec::tick;
use super::heap::{Heap, Node, Ref, V};
use super::plan::{DefaultValue, Field, Kind, OwnHook, RelationTo, Tab};
use super::run::S;

pub type Task<'r, T> = Pin<Box<dyn Future<Output = T> + 'r>>;

pub const SUBMITTED_AUTHORSHIP_KEY: &str = "_submittedAuthorshipFields";

/// The `req.context` key lexical's editor hooks keep their node maps under.
pub const INTERNAL_KEY: &str = "internal";

/// `beforeValidate({ data, doc })` (index.ts): `await traverseFields(...)`.
pub fn before_validate<'r, 'e: 'r>(s: S<'r, 'e>, data: Ref, doc: Ref) -> Task<'r, ()> {
  Box::pin(async move {
    let fields = &s.run.plan.fields;
    s.exec.spawn(traverse_fields(s.clone(), fields, V::Ref(data), V::Ref(doc), String::new())).wait().await;
  })
}

/// `unflattenData(siblingData)`: dotted keys are not modelled.
pub fn has_dotted_keys(heap: &Heap, value: &V) -> bool {
  match value {
    V::Ref(r) => heap.obj(*r).is_some_and(|o| o.keys().any(|k| k.contains('.'))),
    _ => false,
  }
}

fn traverse_fields<'r, 'e: 'r>(s: S<'r, 'e>, fields: &'r [Field], sibling_data: V, sibling_doc: V, parent_path: String) -> Task<'r, ()> {
  Box::pin(async move {
    if s.run.failed() {
      return;
    }
    if has_dotted_keys(&s.run.heap.borrow(), &sibling_data) {
      return s.run.fail(Bail::new("beforeValidate:dottedKeys"));
    }
    let promises = fields
      .iter()
      .map(|field| s.exec.spawn(promise(s.clone(), field, sibling_data.clone(), sibling_doc.clone(), parent_path.clone())))
      .collect();
    s.exec.all(promises).wait().await;
  })
}

/// `traverseFields` over `field.tabs.map((tab) => ({ ...tab, type: 'tab' }))`.
fn traverse_tabs<'r, 'e: 'r>(s: S<'r, 'e>, tabs: &'r [Tab], sibling_data: V, sibling_doc: V, parent_path: String) -> Task<'r, ()> {
  Box::pin(async move {
    if has_dotted_keys(&s.run.heap.borrow(), &sibling_data) {
      return s.run.fail(Bail::new("beforeValidate:dottedKeys"));
    }
    let promises = tabs
      .iter()
      .map(|tab| {
        let s2 = s.clone();
        let (sibling_data, sibling_doc, parent_path) = (sibling_data.clone(), sibling_doc.clone(), parent_path.clone());
        s.exec.spawn(async move {
          // an unnamed tab: `await traverseFields({ fields: tab.fields, siblingData, siblingDoc })`
          s2.exec.spawn(traverse_fields(s2.clone(), &tab.fields, sibling_data, sibling_doc, parent_path)).wait().await;
        })
      })
      .collect();
    s.exec.all(promises).wait().await;
  })
}

fn promise<'r, 'e: 'r>(s: S<'r, 'e>, field: &'r Field, sibling_data: V, sibling_doc: V, parent_path: String) -> Task<'r, ()> {
  Box::pin(async move {
    if s.run.failed() {
      return;
    }
    let run = s.run;
    let Some(sd) = sibling_data.as_ref() else {
      return run.fail(Bail::new("beforeValidate:siblingData"));
    };
    let path = match &field.name {
      Some(name) if field.affects_data() => join_path(&parent_path, name),
      _ => parent_path.clone(),
    };
    if field.affects_data() {
      let name = field.name.as_deref().unwrap_or_default();
      if run.check(sanitize_value(&s, field, sd, name)).is_none() {
        return;
      }
      let mut fallback: Option<V> = None;
      if run.get(&sibling_data, name).is_undef() && !run.restoring_version {
        fallback = Some(s.exec.spawn(get_fallback_value(s.clone(), field, sibling_doc.clone())).wait().await);
        if run.failed() {
          return;
        }
      }
      for hook in &field.before_validate {
        match hook {
          OwnHook::AuthorshipBeforeValidate(which) => {
            let key = which.key();
            let supplied = !run.get(&sibling_data, key).is_undef();
            let submitted = match run.submitted.get() {
              Some(r) => r,
              None => run.heap.borrow_mut().new_obj(),
            };
            if run.check(run.set(submitted, key, V::Bool(supplied))).is_none() {
              return;
            }
            run.submitted.set(Some(submitted));
            run.note_context(SUBMITTED_AUTHORSHIP_KEY);
            // `await callUserFunction(hook)`: the hook returns `undefined`
            tick().await;
          }
          _ => return run.fail(Bail::new("beforeValidate:hook")),
        }
      }
      if field.access && !run.override_access {
        return run.fail(Bail::new("beforeValidate:fieldAccess"));
      }
      if run.get(&sibling_data, name).is_undef() && !run.restoring_version {
        let value = match fallback {
          Some(value) => value,
          None => s.exec.spawn(get_fallback_value(s.clone(), field, sibling_doc.clone())).wait().await,
        };
        if run.check(run.set(sd, name, value)).is_none() {
          return;
        }
      }
    }
    match field.kind {
      Kind::Array => {
        let name = field.name.as_deref().unwrap_or_default();
        let rows = run.get(&sibling_data, name);
        let Some(rows) = rows.as_ref().filter(|r| run.heap.borrow().arr(*r).is_some()) else {
          return;
        };
        let items = run.heap.borrow().arr(rows).cloned().unwrap_or_default();
        if !items.iter().all(|row| run.heap.borrow().is_obj(row)) {
          // stripNullRows filters them and logs a warning
          return run.fail(Bail::new("beforeValidate:invalidRows"));
        }
        let existing = run.get(&sibling_doc, name);
        let mut promises = Vec::with_capacity(items.len());
        for row in items {
          let Some(row_doc) = run.check(existing_row_doc(&run.heap, &row, &existing)) else {
            return;
          };
          let row_path = format!("{path}.{}", promises.len());
          promises.push(s.exec.spawn(traverse_fields(s.clone(), &field.fields, row, row_doc, row_path)));
        }
        s.exec.all(promises).wait().await;
      }
      Kind::Blocks => {
        let name = field.name.as_deref().unwrap_or_default();
        let rows = run.get(&sibling_data, name);
        let Some(items) = rows.as_ref().and_then(|r| run.heap.borrow().arr(r).cloned()) else {
          return;
        };
        if !items.iter().all(|row| run.heap.borrow().is_obj(row)) {
          return run.fail(Bail::new("beforeValidate:invalidRows"));
        }
        let existing = run.get(&sibling_doc, name);
        let mut promises = Vec::with_capacity(items.len());
        for (index, row) in items.into_iter().enumerate() {
          let Some(row_doc) = run.check(existing_row_doc(&run.heap, &row, &existing)) else {
            return;
          };
          let Some(block) = run.check(block_to_match(&run.heap.borrow(), field, &row, &row_doc)) else {
            return;
          };
          if let Some((block, block_type)) = block {
            if let Some(r) = row.as_ref() {
              if run.check(run.set(r, "blockType", block_type)).is_none() {
                return;
              }
            }
            promises.push(s.exec.spawn(traverse_fields(s.clone(), &block.fields, row, row_doc, format!("{path}.{index}"))));
          }
        }
        s.exec.all(promises).wait().await;
      }
      Kind::Collapsible | Kind::Row => {
        s.exec.spawn(traverse_fields(s.clone(), &field.fields, sibling_data.clone(), sibling_doc.clone(), parent_path.clone())).wait().await;
      }
      Kind::Group => {
        let name = field.name.as_deref().unwrap_or_default();
        let Some((group_data, group_doc)) = run.check(group_siblings(&s, sd, &sibling_doc, name)) else {
          return;
        };
        s.exec.spawn(traverse_fields(s.clone(), &field.fields, group_data, group_doc, path)).wait().await;
      }
      Kind::Tabs => {
        s.exec.spawn(traverse_tabs(s.clone(), &field.tabs, sibling_data.clone(), sibling_doc.clone(), parent_path.clone())).wait().await;
      }
      Kind::RichText => {
        let name = field.name.as_deref().unwrap_or_default();
        if run.check(lexical_before_validate(&s, field, &sibling_data, &sibling_doc, name, &path)).is_none() {
          return;
        }
        // `await callUserFunction(hook)`: the hook returns `value`
        tick().await;
        let value = run.get(&sibling_data, name);
        if !value.is_undef() && run.check(run.set(sd, name, value)).is_none() {
          return;
        }
      }
      _ => {}
    }
  })
}

/// `row.blockType || rowSiblingDoc.blockType`, and the field's block of that slug
/// (`req.payload.blocks` is empty for eligible configs).
pub fn block_to_match<'f>(heap: &Heap, field: &'f Field, row: &V, row_doc: &V) -> Result<Option<(&'f super::plan::Block, V)>, Bail> {
  let own = heap.get(row, "blockType");
  let block_type = if own.truthy() { own } else { heap.get(row_doc, "blockType") };
  Ok(match &block_type {
    V::Str(slug) => field.block(slug).map(|b| (b, block_type.clone())),
    V::Ref(_) | V::Date(_) | V::Oid(_) => return Err(Bail::new("blocks:blockType")),
    _ => None,
  })
}

pub fn join_path(parent: &str, name: &str) -> String {
  if parent.is_empty() { name.to_string() } else { format!("{parent}.{name}") }
}

/// Whether `recurseNodeTree({ nodeIDMap, nodes: value?.root?.children ?? [] })` puts a node in
/// the map (a node with a truthy `id` or `fields.id`); shapes it would throw on bail.
pub fn has_id_nodes(heap: &Heap, value: &V) -> Result<bool, Bail> {
  fn walk(heap: &Heap, nodes: &V) -> Result<bool, Bail> {
    let Some(items) = nodes.as_ref().and_then(|r| heap.arr(r)) else {
      return Ok(false);
    };
    for node in items {
      if !heap.is_obj(node) {
        return Err(Bail::new("lexical:node"));
      }
      let fields = heap.get(node, "fields");
      if heap.get(node, "id").truthy() || (heap.is_obj(&fields) && heap.get(&fields, "id").truthy()) {
        return Ok(true);
      }
      let children = heap.get(node, "children");
      if heap.is_arr(&children) && walk(heap, &children)? {
        return Ok(true);
      }
    }
    Ok(false)
  }
  let children = heap.get(&heap.get(value, "root"), "children");
  if !children.is_nullish() && !heap.is_arr(&children) {
    return Err(Bail::new("lexical:children"));
  }
  walk(heap, &children)
}

/// lexical's editor `beforeValidate` hook (richtext-lexical hooks.ts) of an editor whose features
/// add no hooks: with node maps, `req.context.internal.richText[path] = { originalNodeIDMap }`
/// from `previousValue`; nodes with ids (whose hooks / sub fields would run) bail.
fn lexical_before_validate(s: &S<'_, '_>, field: &Field, sibling_data: &V, sibling_doc: &V, name: &str, path: &str) -> Result<(), Bail> {
  let run = s.run;
  let lexical = field.lexical.as_ref().ok_or_else(|| Bail::new("lexical:plan"))?;
  if !lexical.maps {
    return Ok(());
  }
  let mut heap = run.heap.borrow_mut();
  let value = heap.get(sibling_data, name);
  let previous = heap.get(sibling_doc, name);
  if has_id_nodes(&heap, &previous)? || has_id_nodes(&heap, &value)? {
    return Err(Bail::new("lexical:nodeIDs"));
  }
  let internal = match run.internal.get() {
    Some(r) => r,
    None => heap.new_obj(),
  };
  if !heap.is_obj(&heap.get(&V::Ref(internal), "richText")) {
    let rich_text = heap.new_obj();
    heap.set(internal, "richText", V::Ref(rich_text))?;
  }
  let rich_text = heap.get(&V::Ref(internal), "richText").as_ref().ok_or_else(|| Bail::new("lexical:internal"))?;
  let map = heap.new_obj();
  let entry = heap.new_obj();
  heap.set(entry, "originalNodeIDMap", V::Ref(map))?;
  heap.set(rich_text, path, V::Ref(entry))?;
  run.internal.set(Some(internal));
  run.note_context(INTERNAL_KEY);
  Ok(())
}

/// The named group's `siblingData[name]` / `siblingDoc[name]`, set to `{}` when not objects.
pub fn group_siblings(s: &S<'_, '_>, sd: Ref, sibling_doc: &V, name: &str) -> Result<(V, V), Bail> {
  let run = s.run;
  let mut heap = run.heap.borrow_mut();
  if !Heap::is_object_like(&heap.get(&V::Ref(sd), name)) {
    let empty = heap.new_obj();
    heap.set(sd, name, V::Ref(empty))?;
  }
  let doc = sibling_doc.as_ref().filter(|r| heap.obj(*r).is_some()).ok_or_else(|| Bail::new("group:siblingDoc"))?;
  if !Heap::is_object_like(&heap.get(sibling_doc, name)) {
    let empty = heap.new_obj();
    heap.set(doc, name, V::Ref(empty))?;
  }
  let group_data = heap.get(&V::Ref(sd), name);
  let group_doc = heap.get(sibling_doc, name);
  // `null`, arrays, dates: upstream reads their properties (TypeError on null)
  if !heap.is_obj(&group_data) || !heap.is_obj(&group_doc) {
    return Err(Bail::new("group:notObject"));
  }
  Ok((group_data, group_doc))
}

/// `getExistingRowDoc(incomingRow, existingRows)`.
pub fn existing_row_doc(heap: &std::cell::RefCell<Heap>, row: &V, existing_rows: &V) -> Result<V, Bail> {
  let mut heap = heap.borrow_mut();
  let id = heap.get(row, "id");
  if id.truthy() {
    if let Some(rows) = existing_rows.as_ref().and_then(|r| heap.arr(r).cloned()) {
      for existing in rows {
        let is_object = Heap::is_object_like(&existing);
        if matches!(existing, V::Null | V::Date(_) | V::Oid(_)) || (is_object && heap.arr(existing.as_ref().unwrap_or_default()).is_some())
        {
          // `'id' in null` throws; other objects: not modelled
          return Err(Bail::new("rows:existing"));
        }
        if is_object && heap.has(&existing, "id") {
          let existing_id = heap.get(&existing, "id");
          match strict_eq(&existing_id, &id) {
            Some(true) => return Ok(existing),
            Some(false) => {}
            None => return Err(Bail::new("rows:idObject")),
          }
        }
      }
    }
  }
  Ok(V::Ref(heap.new_obj()))
}

/// `===` of two primitives; `None` when either is an object (identity is not modelled).
pub fn strict_eq(a: &V, b: &V) -> Option<bool> {
  Some(match (a, b) {
    (V::Ref(_) | V::Date(_) | V::Oid(_), _) | (_, V::Ref(_) | V::Date(_) | V::Oid(_)) => return None,
    (V::Undef, V::Undef) | (V::Null, V::Null) => true,
    (V::Bool(x), V::Bool(y)) => x == y,
    (V::Num(x), V::Num(y)) => x == y,
    (V::Str(x), V::Str(y)) => x == y,
    _ => false,
  })
}

/// `getFallbackValue({ field, req, siblingDoc })`.
fn get_fallback_value<'r, 'e: 'r>(s: S<'r, 'e>, field: &'r Field, sibling_doc: V) -> Task<'r, V> {
  Box::pin(async move {
    let run = s.run;
    let name = field.name.as_deref().unwrap_or_default();
    let doc_value = run.get(&sibling_doc, name);
    if !doc_value.is_undef() {
      return match clone_data_from_original_doc(&mut run.heap.borrow_mut(), &doc_value) {
        Ok(value) => value,
        Err(bail) => {
          run.fail(bail);
          V::Undef
        }
      };
    }
    if matches!(field.default, DefaultValue::None) {
      return V::Undef;
    }
    s.exec.spawn(get_default_value(s.clone(), field)).wait().await
  })
}

/// `getDefaultValue({ defaultValue, ... })` (no `value`).
fn get_default_value<'r, 'e: 'r>(s: S<'r, 'e>, field: &'r Field) -> Task<'r, V> {
  Box::pin(async move {
    let run = s.run;
    match &field.default {
      DefaultValue::None => V::Undef,
      DefaultValue::RowId => {
        let id = match run.object_id(IdUse::Row) {
          Ok(id) => id,
          Err(bail) => {
            run.fail(bail);
            return V::Undef;
          }
        };
        // `return await defaultValue(...)`
        tick().await;
        V::str(&object_id_to_hex(&id))
      }
      DefaultValue::Static(value) => match run.heap.borrow_mut().import(value) {
        Ok(value) => value,
        Err(bail) => {
          run.fail(bail);
          V::Undef
        }
      },
    }
  })
}

/// `cloneDataFromOriginalDoc(value)`: one level copied.
pub fn clone_data_from_original_doc(heap: &mut Heap, value: &V) -> Result<V, Bail> {
  match value {
    V::Date(_) | V::Oid(_) => Err(Bail::new("fallback:typed")),
    V::Ref(r) => match heap.node(*r).clone() {
      Node::Arr(rows) => {
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
          out.push(match row {
            V::Ref(rr) if heap.obj(rr).is_some() => V::Ref(heap.spread(rr)),
            V::Ref(_) | V::Date(_) | V::Oid(_) => return Err(Bail::new("fallback:row")),
            other => other,
          });
        }
        Ok(V::Ref(heap.alloc(Node::Arr(out))))
      }
      Node::Obj(_) => Ok(V::Ref(heap.spread(*r))),
    },
    other => Ok(other.clone()),
  }
}

/// The `id` handling and the per-type `switch` before the fallback (promise.ts).
fn sanitize_value(s: &S<'_, '_>, field: &Field, sd: Ref, name: &str) -> Result<(), Bail> {
  let run = s.run;
  let target = V::Ref(sd);
  let value = run.get(&target, name);
  if name == "id" {
    if field.kind == Kind::Number && value.as_str().is_some() {
      run.set(sd, name, V::Num(parse_float_str(value.as_str().unwrap_or_default())))?;
    }
    if field.kind == Kind::Text && !value.is_nullish() && value.as_str().is_none() {
      let text = match &value {
        V::Num(n) => number_to_string(*n),
        V::Bool(b) => b.to_string(),
        V::Oid(bytes) => object_id_to_hex(bytes),
        V::Ref(r) if run.heap.borrow().obj(*r).is_some() => "[object Object]".to_string(),
        _ => return Err(Bail::new("id:toString")),
      };
      run.set(sd, name, V::str(&text))?;
    }
  }
  let value = run.get(&target, name);
  match field.kind {
    Kind::Array | Kind::Blocks => {
      if matches!(&value, V::Str(s) if &**s == "0") || matches!(value, V::Num(n) if n == 0.0) {
        let empty = run.heap.borrow_mut().alloc(Node::Arr(Vec::new()));
        run.set(sd, name, V::Ref(empty))?;
      }
    }
    Kind::Checkbox => match value.as_str() {
      Some("true") => run.set(sd, name, V::Bool(true))?,
      Some("false") | Some("") => run.set(sd, name, V::Bool(false))?,
      _ => {}
    },
    Kind::Number => {
      if let Some(text) = value.as_str() {
        let trimmed = trim(text);
        let parsed = if trimmed.is_empty() { V::Null } else { V::Num(parse_float_str(trimmed)) };
        run.set(sd, name, parsed)?;
      }
    }
    Kind::Relationship => sanitize_relationship(s, field, sd, name)?,
    // a string is `JSON.parse`d (when it parses)
    Kind::RichText if value.as_str().is_some() => return Err(Bail::new("richText:string")),
    _ => {}
  }
  Ok(())
}

fn number_ids(s: &S<'_, '_>, slug: &str) -> Result<bool, Bail> {
  match s.run.plan.relations.get(slug) {
    Some(custom) => Ok(custom.as_deref() == Some("number")),
    None => Err(Bail::new("relationship:unknownCollection")),
  }
}

/// The `relationship` / `upload` case.
fn sanitize_relationship(s: &S<'_, '_>, field: &Field, sd: Ref, name: &str) -> Result<(), Bail> {
  let run = s.run;
  let target = V::Ref(sd);
  let value = run.get(&target, name);
  if matches!(&value, V::Str(s) if matches!(&**s, "" | "none" | "null")) || matches!(value, V::Null) {
    let replacement = if field.has_many { V::Ref(run.heap.borrow_mut().alloc(Node::Arr(Vec::new()))) } else { V::Null };
    run.set(sd, name, replacement)?;
  }
  let value = run.get(&target, name);
  let mut heap = run.heap.borrow_mut();
  let items = value.as_ref().and_then(|r| heap.arr(r).cloned());
  match &field.relation_to {
    RelationTo::Many(_) => {
      if let Some(items) = items {
        for related in items {
          if related.is_nullish() {
            return Err(Bail::new("relationship:nullItem"));
          }
          let relation_to = heap.get(&related, "relationTo");
          let inner = heap.get(&related, "value");
          unwrap_id(&mut heap, &related, &inner)?;
          if let Some(slug) = relation_to.as_str() {
            if number_ids(s, slug)? {
              return Err(Bail::new("relationship:numberIDs"));
            }
          } else if heap.is_obj(&related) && !relation_to.is_undef() {
            return Err(Bail::new("relationship:relationTo"));
          }
        }
      }
      let is_value_with_relation = heap.is_obj(&value) && heap.has(&value, "relationTo") && heap.has(&value, "value");
      if !field.has_many && is_value_with_relation {
        let inner = heap.get(&value, "value");
        unwrap_id(&mut heap, &value, &inner)?;
        let relation_to = heap.get(&value, "relationTo");
        match relation_to.as_str() {
          Some(slug) if number_ids(s, slug)? => return Err(Bail::new("relationship:numberIDs")),
          Some(_) => {}
          None => return Err(Bail::new("relationship:relationTo")),
        }
      }
    }
    RelationTo::One(slug) => {
      let numbers = number_ids(s, slug)?;
      if let Some(items) = items {
        let r = value.as_ref().unwrap_or_default();
        for (i, related) in items.iter().enumerate() {
          if let V::Date(_) | V::Oid(_) = related {
            return Err(Bail::new("relationship:typedItem"));
          }
          if heap.is_arr(related) {
            continue;
          }
          if heap.is_obj(related) && heap.has(related, "id") {
            let id = heap.get(related, "id");
            if let Some(arr) = heap.arr_mut(r) {
              arr[i] = id;
            }
          }
          if numbers {
            return Err(Bail::new("relationship:numberIDs"));
          }
        }
      }
      if !field.has_many && value.truthy() {
        if let V::Date(_) | V::Oid(_) = value {
          return Err(Bail::new("relationship:typedValue"));
        }
        if heap.is_obj(&value) && heap.has(&value, "id") {
          let id = heap.get(&value, "id");
          heap.set(sd, name, id)?;
        }
        if numbers {
          return Err(Bail::new("relationship:numberIDs"));
        }
      }
    }
    RelationTo::None => return Err(Bail::new("relationship:relationTo")),
  }
  Ok(())
}

/// `if (typeof x.value === 'object' && x.value && 'id' in x.value) x.value = x.value.id`
fn unwrap_id(heap: &mut Heap, holder: &V, inner: &V) -> Result<(), Bail> {
  match inner {
    V::Oid(_) => Err(Bail::new("relationship:objectIdValue")),
    V::Ref(_) if heap.is_obj(inner) && heap.has(inner, "id") => {
      let id = heap.get(inner, "id");
      let r = holder.as_ref().ok_or_else(|| Bail::new("relationship:holder"))?;
      heap.set(r, "value", id)
    }
    _ => Ok(()),
  }
}
