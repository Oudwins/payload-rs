//! Upstream's `afterRead` field traversal (packages/payload/src/fields/hooks/afterRead) on an
//! owned document, for configs without user functions on the read path (FUSE_CONTRACT.md
//! section 2).
//!
//! Upstream mutates the document in place, field by field, inside `async` functions. Everything
//! it does synchronously happens here in the same order (deletes, `{}` / `[]` fills, locale
//! hoisting, point and depth-0 relationship normalization); assignments upstream makes after an
//! `await` (default values) are queued and applied after the traversal in the order their
//! promises started, which is the order they settle in (each takes the same single tick). Key
//! insertion order therefore matches upstream. Branches whose order or result would depend on
//! more than that bail.

use indexmap::IndexMap;
use payload_engine::js::{JsVal, Obj};

use crate::backend::{Bail, FuseResult};
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

/// The per-operation inputs of `afterRead` (its args after destructuring, `depth` resolved).
pub struct ReadArgs<'a> {
  pub plan: &'a CollectionPlan,
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
enum Seg {
  Key(String),
  Index(usize),
}

struct Deferred {
  path: Vec<Seg>,
  key: String,
  value: JsVal,
}

struct Walk<'a, 'r> {
  args: &'r ReadArgs<'a>,
  deferred: Vec<Deferred>,
  path: Vec<Seg>,
}

/// Runs the traversal on `doc` (a document object) with the root `select`.
pub fn after_read(args: &ReadArgs<'_>, doc: &mut JsVal, select: Option<&JsVal>, select_mode: Option<SelectMode>) -> FuseResult<()> {
  if !matches!(doc, JsVal::Obj(_)) {
    return Err(Bail::new("doc:not-object"));
  }
  let mut walk = Walk { args, deferred: Vec::new(), path: Vec::new() };
  let fields = &args.plan.fields;
  walk.traverse(fields, doc, true, false, select, select_mode)?;
  for Deferred { path, key, value } in walk.deferred {
    let target = resolve(doc, &path).ok_or_else(|| Bail::new("default:target"))?;
    obj_mut(target).ok_or_else(|| Bail::new("default:target"))?.insert(key, value);
  }
  Ok(())
}

fn resolve<'v>(mut value: &'v mut JsVal, path: &[Seg]) -> Option<&'v mut JsVal> {
  for seg in path {
    value = match (seg, value) {
      (Seg::Key(key), JsVal::Obj(o)) => std::sync::Arc::make_mut(o).get_mut(key.as_str())?,
      (Seg::Index(i), JsVal::Arr(a)) => std::sync::Arc::make_mut(a).get_mut(*i)?,
      _ => return None,
    };
  }
  Some(value)
}

pub(crate) fn obj_mut(value: &mut JsVal) -> Option<&mut Obj> {
  match value {
    JsVal::Obj(o) => Some(&mut **std::sync::Arc::make_mut(o)),
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

impl Walk<'_, '_> {
  /// `traverseFields(...)`: one `promise()` per field, in order.
  fn traverse(
    &mut self,
    fields: &[Field],
    sibling: &mut JsVal,
    at_root: bool,
    parent_localized: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    for field in fields {
      self.field(field, sibling, at_root, parent_localized, select, select_mode)?;
    }
    Ok(())
  }

  fn with_seg<R>(&mut self, seg: Seg, f: impl FnOnce(&mut Self) -> R) -> R {
    self.path.push(seg);
    let out = f(self);
    self.path.pop();
    out
  }

  /// `promise()` of one field.
  fn field(
    &mut self,
    field: &Field,
    sibling: &mut JsVal,
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
    let doc = obj_mut(sibling).ok_or_else(|| Bail::new("sibling:not-object"))?;
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

    if ad {
      // field hooks: none on a fused path; virtual: none; access.read: only with overrideAccess
      if !removed && is_undefined(doc.get(name)) {
        match &field.default {
          DefaultValue::None => {}
          DefaultValue::Function => return Err(Bail::new("default:function")),
          DefaultValue::Static(value) => {
            if field.kind != Kind::Leaf {
              return Err(Bail::new("default:container"));
            }
            if !matches!(value, JsVal::Undefined) {
              self.deferred.push(Deferred { path: self.path.clone(), key: name.to_string(), value: deep_copy(value) });
            }
          }
        }
      }
      if field.kind == Kind::Relationship {
        self.relationship(field, doc, parent_localized)?;
      } else if field.kind == Kind::Join {
        return Err(Bail::new("join"));
      }
    }

    match field.kind {
      Kind::Array => self.array(field, sibling, parent_localized, hoist, select, select_mode)?,
      Kind::Blocks => self.blocks(field, sibling, parent_localized, hoist, select, select_mode)?,
      Kind::Row => self.traverse(&field.fields, sibling, at_root, parent_localized, select, select_mode)?,
      Kind::Group | Kind::Tab if ad => {
        let doc = obj_mut(sibling).ok_or_else(|| Bail::new("sibling:not-object"))?;
        let nested_select = match select_get(select, name) {
          Some(v @ (JsVal::Obj(_) | JsVal::Arr(_) | JsVal::Null)) => Some(v),
          _ => None,
        };
        let child_localized = parent_localized || field.localized;
        if should_localize && !hoist {
          self.localized_values(field, doc, child_localized, nested_select, select_mode)?;
        } else {
          match doc.get_mut(name) {
            Some(target @ JsVal::Obj(_)) => {
              let target: &mut JsVal = target;
              self.with_seg(Seg::Key(name.to_string()), |w| w.traverse(&field.fields, target, false, child_localized, nested_select, select_mode))?;
            }
            // `typeof value !== 'object' ? {} : value`: a fresh object nobody sees
            Some(JsVal::Bool(_) | JsVal::Num(_) | JsVal::Str(_) | JsVal::Undefined) | None => {}
            // null (TypeError) or an array as the sibling doc
            Some(_) => return Err(Bail::new("group:value")),
          }
        }
      }
      Kind::Group => self.traverse(&field.fields, sibling, at_root, parent_localized, select, select_mode)?,
      Kind::Tab => {
        self.traverse(&field.fields, sibling, at_root, parent_localized || field.localized, select, select_mode)?
      }
      Kind::Tabs => self.traverse(&field.tabs, sibling, at_root, parent_localized, select, select_mode)?,
      Kind::RichText => {
        let doc = obj_mut(sibling).ok_or_else(|| Bail::new("sibling:not-object"))?;
        self.rich_text(field, doc, should_localize, hoist)?
      }
      _ => {}
    }
    Ok(())
  }

  /// `Object.values(siblingDoc[name] || {}).forEach((localizedData) => traverseFields(...))` of
  /// localized groups and named tabs.
  fn localized_values(
    &mut self,
    field: &Field,
    doc: &mut Obj,
    child_localized: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    let name = field.name.as_deref().unwrap_or("");
    let Some(value) = doc.get_mut(name) else { return Ok(()) };
    match value {
      JsVal::Obj(o) => {
        let o = std::sync::Arc::make_mut(o);
        for (key, localized) in o.iter_mut() {
          match localized {
            JsVal::Obj(_) => {
              let key = key.clone();
              self.with_seg(Seg::Key(name.to_string()), |w| {
                w.with_seg(Seg::Key(key), |w| w.traverse(&field.fields, localized, false, child_localized, select, select_mode))
              })?;
            }
            v if !v.truthy() => {}
            _ => return Err(Bail::new("localized:value")),
          }
        }
        Ok(())
      }
      v if !v.truthy() => Ok(()),
      _ => Err(Bail::new("localized:value")),
    }
  }

  fn array(
    &mut self,
    field: &Field,
    sibling: &mut JsVal,
    parent_localized: bool,
    hoist: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    let name = field.name.as_deref().unwrap_or("");
    let doc = obj_mut(sibling).ok_or_else(|| Bail::new("sibling:not-object"))?;
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
    match doc.get_mut(name) {
      Some(JsVal::Arr(rows)) if !rows.is_empty() => {
        let rows = std::sync::Arc::make_mut(rows);
        self.with_seg(Seg::Key(name.to_string()), |w| w.rows(&field.fields, rows, child_localized, row_select, select_mode))
      }
      Some(value @ (JsVal::Obj(_) | JsVal::Arr(_))) if !hoist => {
        // locale-keyed rows: no select, no select mode
        if let JsVal::Obj(o) = value {
          let o = std::sync::Arc::make_mut(o);
          for (key, locale_rows) in o.iter_mut() {
            if let JsVal::Arr(rows) = locale_rows {
              let rows = std::sync::Arc::make_mut(rows);
              let key = key.clone();
              self.with_seg(Seg::Key(name.to_string()), |w| {
                w.with_seg(Seg::Key(key), |w| w.rows(&field.fields, rows, child_localized, None, None))
              })?;
            }
          }
        }
        Ok(())
      }
      rows => {
        let is_empty = match rows.as_deref() {
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

  /// `rows.forEach((row, rowIndex) => traverseFields({ siblingDoc: row || {}, ... }))`
  fn rows(
    &mut self,
    fields: &[Field],
    rows: &mut [JsVal],
    child_localized: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    for (index, row) in rows.iter_mut().enumerate() {
      match row {
        JsVal::Obj(_) => self.with_seg(Seg::Index(index), |w| w.traverse(fields, row, false, child_localized, select, select_mode))?,
        v if !v.truthy() => {}
        _ => return Err(Bail::new("row:not-object")),
      }
    }
    Ok(())
  }

  fn block_fields(&self, field: &Field, block_type: Option<&JsVal>) -> FuseResult<Option<std::sync::Arc<Vec<Field>>>> {
    let slug = match block_type {
      None | Some(JsVal::Undefined) => return Ok(None),
      Some(JsVal::Str(s)) => s,
      Some(_) => return Err(Bail::new("blocks:blockType")),
    };
    if let Some(fields) = self.args.plan.global_blocks.get(&**slug) {
      return Ok(Some(fields.clone()));
    }
    if crate::OBJECT_PROTOTYPE_KEYS.contains(&&**slug) {
      return Err(Bail::new("blocks:blockType"));
    }
    Ok(field.blocks.iter().find(|(s, _)| **s == **slug).map(|(_, f)| f.clone()))
  }

  fn blocks(
    &mut self,
    field: &Field,
    sibling: &mut JsVal,
    parent_localized: bool,
    hoist: bool,
    select: Option<&JsVal>,
    select_mode: Option<SelectMode>,
  ) -> FuseResult<()> {
    let name = field.name.as_deref().unwrap_or("");
    let doc = obj_mut(sibling).ok_or_else(|| Bail::new("sibling:not-object"))?;
    let child_localized = parent_localized || field.localized;
    let field_select = select_get(select, name);
    match doc.get_mut(name) {
      Some(JsVal::Arr(rows)) if !rows.is_empty() => {
        let rows = std::sync::Arc::make_mut(rows);
        for (index, row) in rows.iter_mut().enumerate() {
          let JsVal::Obj(o) = &*row else { return Err(Bail::new("block:not-object")) };
          let block_type = o.get("blockType").cloned();
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
            w.with_seg(Seg::Index(index), |w| w.traverse(&block, row, false, child_localized, row_select, block_mode))
          })?;
        }
        Ok(())
      }
      Some(value @ (JsVal::Obj(_) | JsVal::Arr(_))) if !hoist => {
        if let JsVal::Obj(o) = value {
          let o = std::sync::Arc::make_mut(o);
          for (key, locale_rows) in o.iter_mut() {
            let JsVal::Arr(rows) = locale_rows else { continue };
            let rows = std::sync::Arc::make_mut(rows);
            for (index, row) in rows.iter_mut().enumerate() {
              let JsVal::Obj(r) = &*row else { return Err(Bail::new("block:not-object")) };
              let block_type = r.get("blockType").cloned();
              let Some(block) = self.block_fields(field, block_type.as_ref())? else { continue };
              let key = key.clone();
              self.with_seg(Seg::Key(name.to_string()), |w| {
                w.with_seg(Seg::Key(key), |w| {
                  w.with_seg(Seg::Index(index), |w| w.traverse(&block, row, false, child_localized, None, None))
                })
              })?;
            }
          }
        }
        Ok(())
      }
      rows => {
        let is_empty = match rows.as_deref() {
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
              ctx.populate(&data, row)?;
            }
          }
        }
      } else {
        match doc.get_mut(name) {
          Some(JsVal::Arr(rows)) => {
            let rows = std::sync::Arc::make_mut(rows);
            for row in rows.iter_mut() {
              if !row.truthy() {
                continue;
              }
              let id = match &*row {
                JsVal::Obj(o) => o.get("id").filter(|id| id.truthy()).cloned(),
                _ => None,
              };
              let data = id.unwrap_or_else(|| row.clone());
              ctx.populate(&data, row)?;
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
        ctx.populate(&data, value)?;
      }
    } else if truthy(doc.get(name)) {
      let data = doc.get(name).cloned().unwrap_or_default();
      let slot = doc.get_mut(name).ok_or_else(|| Bail::new("relationship:slot"))?;
      ctx.populate(&data, slot)?;
    }
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
  /// (`dataToUpdate[field.name]...`, or its `.value` for polymorphic relationships).
  fn populate(&self, data: &JsVal, slot: &mut JsVal) -> FuseResult<()> {
    let relation = match (&self.field.relation_to, self.poly) {
      (RelationTo::One(slug), false) => Some(slug.as_str()),
      (_, true) => match get(Some(data), "relationTo") {
        Some(JsVal::Str(s)) => Some(&**s),
        None | Some(JsVal::Undefined) => None,
        Some(_) => return Err(Bail::new("relationship:relationTo")),
      },
      _ => return Err(Bail::new("relationship:relationTo")),
    };
    let Some(relation) = relation else { return Ok(()) };
    if !self.args.plan.collections.contains(relation) {
      if crate::OBJECT_PROTOTYPE_KEYS.contains(&relation) {
        return Err(Bail::new("relationship:relationTo"));
      }
      return Ok(());
    }
    let id = if self.poly { get(Some(data), "value").cloned().unwrap_or_default() } else { data.clone() };
    let should_populate = self.depth != 0.0 && !self.depth.is_nan() && self.args.current_depth <= self.depth;
    if should_populate {
      return Err(Bail::new("populate"));
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
    Ok(())
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
