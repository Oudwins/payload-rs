//! `transform` (packages/db-mongodb/src/utilities/transform.ts) on the live objects, with payload's
//! `traverseFields` (packages/payload/src/utilities/traverseFields.ts) as `transform` runs it:
//! `fillEmpty: false`, `leavesFirst: false`, a callback that never returns truthy and never calls
//! `next()` (so the dotted-key fallback runs after every traversal of an object).
//!
//! Every read / write / delete / `in` check on the data, the operator objects, the adapter AND the
//! config (fields, tabs, blocks, collections, localization) happens in the TS order, in place,
//! including the partial mutations made before a throw: nothing is cached or read ahead, every
//! `field.type` / `field.name` / `config.localization` read is made at the point the TS makes it,
//! and the built-ins the TS calls (`some` / `find` / `map` / `forEach` / iterators / `Array.isArray`
//! / `Object.hasOwn` / string methods) are the ones the live values have at that moment (helpers.js).
//!
//! The callbacks the TS passes to `some` / `find` / `map` / `forEach` are JS closures (helpers.js)
//! over the transform's state object ([`Cx`]); their bodies are the stateless natives in [`NATIVES`],
//! so a callback kept by user code can be called later or re-entered like upstream's.

use std::panic::{AssertUnwindSafe, catch_unwind};

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Type};

use crate::live::{
  self, Helpers, call, for_in, for_of, get, get_named, is_array, is_nullish, is_object, is_str, is_typeof_object, test,
};

/// `operation` of `transform` (`'read'`, `'write'`, or anything else, which makes neither of the
/// `operation === ...` checks true).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
  Read,
  Write,
  Other,
}

impl Operation {
  pub fn from_local(v: Local) -> Operation {
    if is_str(v, "read") {
      Operation::Read
    } else if is_str(v, "write") {
      Operation::Write
    } else {
      Operation::Other
    }
  }
}

/// The TS `Args` of `transform`. Omitted arguments are `undefined`; the TS defaults
/// (`parentIsLocalized = false`, `validateRelationships = true`) apply to `undefined` like
/// destructuring defaults.
#[derive(Clone, Copy)]
pub struct TransformArgs {
  pub add_to_set: Local,
  pub inc: Local,
  pub pull: Local,
  pub push: Local,
  pub adapter: Local,
  pub data: Local,
  pub fields: Local,
  pub global_slug: Local,
  /// The `operation` value as passed (compared with `===` like the TS).
  pub operation: Local,
  pub parent_is_localized: Local,
  pub validate_relationships: Local,
}

impl TransformArgs {
  /// `{ adapter, data, fields, operation }` (everything else omitted).
  pub fn new(adapter: Local, data: Local, fields: Local, operation: Local) -> TransformArgs {
    let u = js::undefined();
    TransformArgs {
      add_to_set: u,
      inc: u,
      pull: u,
      push: u,
      adapter,
      data,
      fields,
      global_slug: u,
      operation,
      parent_is_localized: u,
      validate_relationships: u,
    }
  }

  /// Destructures a JS args object exactly like the TS parameter pattern (same reads in the same
  /// order, same TypeErrors for `undefined` / `null`, defaults applied).
  pub fn from_object(args: Local) -> JsResult<TransformArgs> {
    let h = live::helpers()?;
    let [add_to_set, inc, pull, push, adapter, data, fields, global_slug, operation, parent_is_localized, validate_relationships] =
      live::elements::<11>(call(&h.destructure_transform_args, &[args])?)?;
    Ok(TransformArgs {
      add_to_set,
      inc,
      pull,
      push,
      adapter,
      data,
      fields,
      global_slug,
      operation,
      parent_is_localized,
      validate_relationships,
    })
  }
}

/// `transform(args)`: mutates `data` and the operator objects in place; returns what the TS
/// returns (`null` for falsy `data`, otherwise `undefined`).
pub fn transform(args: &TransformArgs) -> JsResult<Local> {
  let h = live::helpers()?;
  let validate_relationships =
    if js::type_of(args.validate_relationships) == Type::Undefined { js::boolean(true) } else { args.validate_relationships };
  // `parentIsLocalized = false`: only its truthiness is ever used
  transform_one(&h, args, args.data, js::truthy(args.parent_is_localized), validate_relationships)
}

/// The per-document state the TS closures (`sanitize`, the `map` / `forEach` callbacks) close over:
/// `{ $addToSet, $inc, $pull, $push, adapter, config, operation, validateRelationships }`, a plain
/// engine-made object (reading it is not observable). Rebuilt from that object in every native.
struct Cx {
  h: std::rc::Rc<Helpers>,
  state: Local,
  add_to_set: Local,
  inc: Local,
  pull: Local,
  push: Local,
  adapter: Local,
  config: Local,
  operation: Local,
  op: Operation,
  validate_relationships: Local,
}

impl Cx {
  fn from_state(state: Local) -> JsResult<Cx> {
    let h = live::helpers()?;
    let g = |name: &str| js::get_named(state, name);
    let operation = g("operation")?;
    Ok(Cx {
      h,
      state,
      add_to_set: g("$addToSet")?,
      inc: g("$inc")?,
      pull: g("$pull")?,
      push: g("$push")?,
      adapter: g("adapter")?,
      config: g("config")?,
      operation,
      op: Operation::from_local(operation),
      validate_relationships: g("validateRelationships")?,
    })
  }
}

fn transform_one(h: &Helpers, a: &TransformArgs, data: Local, parent_is_localized: bool, validate_relationships: Local) -> JsResult<Local> {
  if !js::truthy(data) {
    return Ok(js::null());
  }
  if is_array(h, data)? {
    // the recursive call passes everything but `parentIsLocalized`
    for_of(h, data, |item| transform_one(h, a, item, false, validate_relationships).map(|_| ()))?;
    return Ok(js::undefined());
  }

  let config = call(&h.config_of, &[a.adapter])?;
  let state = call(
    &h.doc_state,
    &[a.add_to_set, a.inc, a.pull, a.push, a.adapter, config, a.operation, validate_relationships],
  )?;
  let cx = Cx::from_state(state)?;

  if cx.op == Operation::Read {
    live::del_named(h, data, "__v")?;
    let id = get_named(h, data, "_id")?;
    let id = if js::truthy(id) { id } else { get_named(h, data, "id")? };
    live::set_named(h, data, "id", id)?;
    live::del_named(h, data, "_id")?;
    if live::is_object_id(get_named(h, data, "id")?)? {
      let id = get_named(h, data, "id")?;
      let hex = live::call_method(h, id, "toHexString", "data.id.toHexString", &[])?;
      live::set_named(h, data, "id", hex)?;
    }
    if js::truthy(get_named(h, a.adapter, "useBigIntForNumberIDs")?) && js::type_of(get_named(h, data, "id")?) == Type::BigInt {
      let n = call(&h.to_number, &[get_named(h, data, "id")?])?;
      live::set_named(h, data, "id", n)?;
    }
    if !js::truthy(get_named(h, a.adapter, "allowAdditionalKeys")?) {
      let flattened = call(&h.flatten_all_fields, &[a.fields])?;
      let reserved_keys = call(&h.top_reserved_keys, &[])?;
      strip_fields(&cx, data, flattened, false, reserved_keys)?;
    }
  }

  if cx.op == Operation::Write && js::truthy(a.global_slug) {
    live::set_named(h, data, "globalType", a.global_slug)?;
  }

  // `parentRef = {}` (destructuring default of the top-level call)
  let parent_ref = call(&h.object, &[])?;
  traverse_fields(&cx, a.fields, parent_is_localized, js::string(""), parent_ref, data, true)?;

  if cx.op == Operation::Write {
    if js::type_of(get_named(h, data, "updatedAt")?) == Type::Undefined {
      let now = call(&h.now_iso_string, &[])?;
      live::set_named(h, data, "updatedAt", now)?;
    } else if js::type_of(get_named(h, data, "updatedAt")?) == Type::Null {
      live::del_named(h, data, "updatedAt")?;
    }
  }
  Ok(js::undefined())
}

// -------------------------------------------------------------------------------------------------
// stripFields

fn strip_fields(cx: &Cx, data: Local, fields: Local, parent_is_localized: bool, reserved_keys: Local) -> JsResult<()> {
  let h = &*cx.h;
  let pil = js::boolean(parent_is_localized);
  for_in(h, data, |k| {
    if test(&h.strip_key_condition, &[fields, k, reserved_keys])? {
      live::del(h, data, k)?;
    }
    Ok(())
  })?;

  for_of(h, fields, |field| {
    let reserved_keys = call(&h.new_reserved_keys, &[])?;
    let field_data = call(&h.field_value, &[data, field])?;
    if !js::truthy(field_data) || !is_typeof_object(field_data) {
      return Ok(());
    }
    let should_localize_field = test(&h.should_be_localized, &[field, pil])?;
    call(&h.push_block_type, &[field, reserved_keys])?;
    if !test(&h.has_nested_fields, &[field])? {
      return Ok(());
    }

    if should_localize_field && js::truthy(get_named(h, cx.config, "localization")?) {
      return for_in(h, field_data, |locale_key| {
        if test(&h.locale_code_missing, &[cx.config, locale_key])? {
          return live::del(h, field_data, locale_key);
        }
        let locale_data = get(h, field_data, locale_key)?;
        if !js::truthy(locale_data) || !is_typeof_object(locale_data) {
          return Ok(());
        }
        if test(&h.is_rows_field, &[field])? {
          if !is_array(h, locale_data)? {
            return Ok(());
          }
          if strip_rows(cx, locale_data, field, parent_is_localized, reserved_keys)? {
            let filtered = call(&h.filter_boolean, &[locale_data])?;
            live::set(h, field_data, locale_key, filtered)?;
          }
          return Ok(());
        }
        let flattened = get_named(h, field, "flattenedFields")?;
        let nested_localized = test(&h.localized_or, &[pil, field])?;
        strip_fields(cx, locale_data, flattened, nested_localized, reserved_keys)
      });
    }

    if test(&h.is_rows_field, &[field])? {
      if !is_array(h, field_data)? {
        return Ok(());
      }
      if strip_rows(cx, field_data, field, parent_is_localized, reserved_keys)? {
        call(&h.assign_filtered, &[data, field, field_data])?;
      }
      return Ok(());
    }
    let flattened = get_named(h, field, "flattenedFields")?;
    let nested_localized = test(&h.localized_or, &[pil, field])?;
    strip_fields(cx, field_data, flattened, nested_localized, reserved_keys)
  })
}

/// The row loop of `stripFields` (`for (let i = 0; i < rows.length; i++)`); returns `hasNull`.
fn strip_rows(cx: &Cx, rows: Local, field: Local, parent_is_localized: bool, reserved_keys: Local) -> JsResult<bool> {
  let h = &*cx.h;
  let mut has_null = false;
  let mut i = 0u32;
  while live::less_than(h, i, get_named(h, rows, "length")?)? {
    let index = js::number(f64::from(i));
    i += 1;
    let row = get(h, rows, index)?;
    if !js::truthy(row) || !is_typeof_object(row) {
      live::set(h, rows, index, js::null())?;
      has_null = true;
      continue;
    }
    let mut fields = js::null();
    if test(&h.is_array_field, &[field])? {
      fields = get_named(h, field, "flattenedFields")?;
    } else {
      let maybe_block = call(&h.find_strip_block, &[cx.config, field, row])?;
      if js::truthy(maybe_block) {
        fields = get_named(h, maybe_block, "flattenedFields")?;
      } else {
        live::set(h, rows, index, js::null())?;
        has_null = true;
      }
    }
    if !js::truthy(fields) {
      continue;
    }
    let nested_localized = test(&h.localized_or, &[js::boolean(parent_is_localized), field])?;
    strip_fields(cx, row, fields, nested_localized, reserved_keys)?;
  }
  Ok(has_null)
}

// -------------------------------------------------------------------------------------------------
// traverseFields

fn traverse_fields(
  cx: &Cx,
  fields: Local,
  parent_is_localized: bool,
  parent_path: Local,
  parent_ref: Local,
  r: Local,
  is_top_level: bool,
) -> JsResult<()> {
  // helpers.js `traverseFields`: `fields.some(...)` over [`traverse_field`], then the dotted-key
  // fallback (`expandOwnDottedKey` and its recursion); `parentRef = {}` / `ref = {}` defaults there
  let h = &*cx.h;
  let args = [fields, cx.state, js::boolean(parent_is_localized), parent_path, parent_ref, r, js::boolean(is_top_level)];
  call(&h.traverse_fields, &args).map(|_| ())
}

/// The `fields.some((field) => ...)` callback of `traverseFields`; returns its return value.
fn traverse_field(
  cx: &Cx,
  field: Local,
  parent_is_localized: bool,
  parent_path: Local,
  parent_ref: Local,
  r: Local,
  is_top_level: bool,
) -> JsResult<Local> {
  let h = &*cx.h;
  let pil = js::boolean(parent_is_localized);
  if !js::truthy(r) || !is_typeof_object(r) {
    return Ok(js::undefined());
  }
  sanitize(cx, field, parent_is_localized, parent_path, parent_ref, r)?;

  let mut current_ref = r;
  let mut current_parent_ref = parent_ref;

  if test(&h.is_tabs_field, &[field])? {
    let tabs = get_named(h, field, "tabs")?;
    for_of(h, tabs, |tab| {
      let tab_is_localized = test(&h.should_be_localized, &[tab, pil])?;
      let mut tab_ref = r;
      if test(&h.named_tab, &[tab])? {
        if test(&h.tab_ref_missing, &[r, tab])? {
          return Ok(());
        }
        // `callback({ field: { ...tab, type: 'tab' }, ... })`: `sanitize` does nothing for a tab
        call(&h.spread_tab, &[tab])?;
        tab_ref = get(h, tab_ref, get_named(h, tab, "name")?)?;
        if tab_is_localized {
          for_in(h, tab_ref, |key| {
            if js::truthy(get(h, tab_ref, key)?) && is_typeof_object(get(h, tab_ref, key)?) {
              let fields = get_named(h, tab, "fields")?;
              let path = call(&h.child_path, &[parent_path, tab])?;
              let child = get(h, tab_ref, key)?;
              traverse_fields(cx, fields, true, path, current_parent_ref, child, false)?;
            }
            Ok(())
          })?;
        }
      } else {
        call(&h.spread_tab, &[tab])?;
      }
      if !tab_is_localized {
        let fields = get_named(h, tab, "fields")?;
        let path = call(&h.tab_path, &[parent_path, tab])?;
        traverse_fields(cx, fields, parent_is_localized, path, current_parent_ref, tab_ref, false)?;
      }
      Ok(())
    })?;
    return Ok(js::undefined());
  }

  if test(&h.has_sub_fields_or_blocks, &[field])? {
    if test(&h.named_field, &[field])? {
      current_parent_ref = current_ref;
      if !js::truthy(call(&h.field_value, &[r, field])?) {
        return Ok(js::undefined());
      }
      current_ref = call(&h.field_value, &[r, field])?;
    }

    if test(&h.localized_group_condition, &[field, pil, current_ref])? {
      if test(&h.affects_data, &[field])? {
        for_in(h, current_ref, |key| {
          if js::truthy(get(h, current_ref, key)?) {
            let fields = get_named(h, field, "fields")?;
            let path = call(&h.optional_name_path, &[parent_path, field])?;
            let child = get(h, current_ref, key)?;
            traverse_fields(cx, fields, true, path, current_parent_ref, child, false)?;
          }
          Ok(())
        })?;
      } else {
        let fields = get_named(h, field, "fields")?;
        // upstream passes no `parentPath` here (it defaults to '')
        traverse_fields(cx, fields, parent_is_localized, js::string(""), current_parent_ref, current_ref, false)?;
      }
      return Ok(js::undefined());
    }

    if test(&h.rows_condition, &[field, current_ref])? {
      if test(&h.should_be_localized, &[field, pil])? {
        if is_array(h, current_ref)? {
          traverse_rows(cx, current_ref, field, true, parent_path, current_parent_ref)?;
        } else {
          for_in(h, current_ref, |key| {
            let locale_data = get(h, current_ref, key)?;
            if !is_array(h, locale_data)? {
              return Ok(());
            }
            traverse_rows(cx, locale_data, field, true, parent_path, current_parent_ref)
          })?;
        }
      } else if is_array(h, current_ref)? {
        traverse_rows(cx, current_ref, field, parent_is_localized, parent_path, current_parent_ref)?;
      }
    } else if test(&h.fields_condition, &[field, current_ref])? {
      let fields = get_named(h, field, "fields")?;
      let path = call(&h.named_path, &[parent_path, field])?;
      traverse_fields(cx, fields, parent_is_localized, path, current_parent_ref, current_ref, false)?;
    }
  }

  if is_top_level {
    call(&h.run_callback_stack, &[])?;
  }
  Ok(js::undefined())
}

/// `traverseArrayOrBlocksField` with `fillEmpty: false`.
fn traverse_rows(cx: &Cx, data: Local, field: Local, parent_is_localized: bool, parent_path: Local, parent_ref: Local) -> JsResult<()> {
  let h = &*cx.h;
  for_of(h, data, |row| {
    let mut fields = js::undefined();
    if test(&h.is_block_row, &[field, row])? {
      let block = call(&h.find_row_block, &[cx.config, field, row])?;
      fields = call(&h.optional_fields, &[block])?;
    } else if test(&h.is_array_field, &[field])? {
      fields = get_named(h, field, "fields")?;
    }
    if js::truthy(fields) {
      let nested_localized = test(&h.localized_or, &[js::boolean(parent_is_localized), field])?;
      let path = call(&h.child_path, &[parent_path, field])?;
      traverse_fields(cx, fields, nested_localized, path, parent_ref, row, false)?;
    }
    Ok(())
  })
}

// -------------------------------------------------------------------------------------------------
// the `sanitize` callback

/// The relationship operators of `sanitize`: `(operator object, operand key, kind)`.
const PUSH: u32 = 0;
const ADD_TO_SET: u32 = 1;
const PULL: u32 = 2;

fn sanitize(cx: &Cx, field: Local, parent_is_localized: bool, parent_path: Local, incoming_parent_ref: Local, r: Local) -> JsResult<()> {
  let h = &*cx.h;
  let pil = js::boolean(parent_is_localized);
  // `const parentRef = incomingParentRef || {}`
  let parent_ref = if js::truthy(incoming_parent_ref) { incoming_parent_ref } else { call(&h.object, &[])? };
  let clear_empty_container = || call(&h.clear_empty_container, &[parent_ref, r]).map(|_| ());

  if test(&h.inc_condition, &[cx.inc, field, cx.operation, r])? {
    let value = call(&h.field_value, &[r, field])?;
    if test(&h.is_inc_value, &[value])? {
      let key = call(&h.path_key, &[parent_path, field])?;
      let inc = get_named(h, value, "$inc")?;
      live::set(h, cx.inc, key, inc)?;
      call(&h.delete_field_of, &[r, field])?;
      clear_empty_container()?;
    }
  }

  if test(&h.push_condition, &[cx.push, field, cx.operation, r])? {
    let value = call(&h.field_value, &[r, field])?;
    let operand = js::string("$push");
    if test(&h.operation_value_condition, &[cx.config, field, pil, value, operand])? {
      if test(&h.localized_condition, &[cx.config, field, pil])? {
        if test(&h.locale_operations, &[value, cx.state, field, parent_path, js::number(f64::from(PUSH))])? {
          call(&h.delete_field_of, &[r, field])?;
          clear_empty_container()?;
        }
      } else if test(&h.has_operand, &[value, operand])? {
        let push = get_named(h, value, "$push")?;
        if is_array(h, push)? {
          let key = call(&h.path_key, &[parent_path, field])?;
          let each = call(&h.each, &[push])?;
          live::set(h, cx.push, key, each)?;
        } else if is_typeof_object(push) {
          let key = call(&h.path_key, &[parent_path, field])?;
          live::set(h, cx.push, key, push)?;
        }
        call(&h.delete_field_of, &[r, field])?;
        clear_empty_container()?;
      }
    }
  }

  for (target, operand, kind) in [(cx.add_to_set, "$push", ADD_TO_SET), (cx.pull, "$remove", PULL)] {
    if !test(&h.relationship_operation_condition, &[target, field, cx.operation, r])? {
      continue;
    }
    let value = call(&h.field_value, &[r, field])?;
    let operand = js::string(operand);
    if !test(&h.operation_value_condition, &[cx.config, field, pil, value, operand])? {
      continue;
    }
    if test(&h.localized_condition, &[cx.config, field, pil])? {
      if test(&h.locale_operations, &[value, cx.state, field, parent_path, js::number(f64::from(kind))])? {
        call(&h.delete_field_of, &[r, field])?;
        clear_empty_container()?;
      }
    } else if test(&h.has_operand, &[value, operand])? {
      let items = call(&h.operand_items, &[value, operand])?;
      let processed = call(&h.process_relationship_values, &[items, cx.state, field])?;
      let key = call(&h.path_key, &[parent_path, field])?;
      let wrapped = call(if kind == PULL { &h.in_operator } else { &h.each }, &[processed])?;
      live::set(h, target, key, wrapped)?;
      call(&h.delete_field_of, &[r, field])?;
      clear_empty_container()?;
    }
  }

  if test(&h.date_condition, &[field, cx.operation, r])? {
    if test(&h.localized_condition, &[cx.config, field, pil])? {
      let field_ref = call(&h.field_value, &[r, field])?;
      if !js::truthy(field_ref) || !is_typeof_object(field_ref) {
        return Ok(());
      }
      let codes = get_named(h, get_named(h, cx.config, "localization")?, "localeCodes")?;
      for_of(h, codes, |locale| {
        let value = get(h, field_ref, locale)?;
        sanitize_date(h, field, locale, field_ref, value)
      })?;
    } else {
      let value = call(&h.field_value, &[r, field])?;
      sanitize_date(h, field, js::undefined(), r, value)?;
    }
  }

  if test(&h.relationship_type_condition, &[field, cx.operation])? {
    if !js::truthy(call(&h.field_value, &[r, field])?) {
      return Ok(());
    }
    if test(&h.localized_condition, &[cx.config, field, pil])? {
      let locales = get_named(h, get_named(h, cx.config, "localization")?, "locales")?;
      let field_ref = call(&h.field_value, &[r, field])?;
      if !is_typeof_object(field_ref) {
        return Ok(());
      }
      live::run_loop(&h.for_of_codes, locales, |code| {
        let value = get(h, field_ref, code)?;
        if js::truthy(value) {
          sanitize_relationship(cx, field, code, field_ref, value)?;
        }
        Ok(())
      })?;
    } else {
      let value = call(&h.field_value, &[r, field])?;
      sanitize_relationship(cx, field, js::undefined(), r, value)?;
    }
  }
  Ok(())
}

/// The `Object.entries(value).forEach(([localeKey, localeValue]) => ...)` callback of the localized
/// `$push` / `$addToSet` / `$pull` branches; returns whether it set `hasLocaleOperations`.
fn locale_operation(cx: &Cx, field: Local, parent_path: Local, kind: u32, locale_key: Local, locale_value: Local) -> JsResult<Local> {
  let h = &*cx.h;
  let operand = js::string(if kind == PULL { "$remove" } else { "$push" });
  if !test(&h.has_operand, &[locale_value, operand])? {
    return Ok(js::boolean(false));
  }
  if kind == PUSH {
    let push = get_named(h, locale_value, "$push")?;
    if is_array(h, push)? {
      let key = call(&h.locale_path_key, &[parent_path, field, locale_key])?;
      let each = call(&h.each, &[push])?;
      live::set(h, cx.push, key, each)?;
    } else if is_typeof_object(push) {
      let key = call(&h.locale_path_key, &[parent_path, field, locale_key])?;
      live::set(h, cx.push, key, push)?;
    }
    return Ok(js::boolean(true));
  }
  let operand_value = get(h, locale_value, operand)?;
  let locale_items = call(&h.items_of, &[operand_value])?;
  let processed = call(&h.process_relationship_values, &[locale_items, cx.state, field])?;
  let key = call(&h.locale_path_key, &[parent_path, field, locale_key])?;
  let (target, wrapper) = if kind == PULL { (cx.pull, &h.in_operator) } else { (cx.add_to_set, &h.each) };
  let wrapped = call(wrapper, &[processed])?;
  live::set(h, target, key, wrapped)?;
  Ok(js::boolean(true))
}

/// `sanitizeDate({ field, locale, ref, value })`
fn sanitize_date(h: &Helpers, field: Local, locale: Local, r: Local, value: Local) -> JsResult<()> {
  if !js::truthy(value) {
    return Ok(());
  }
  let mut value = value;
  if test(&h.is_date, &[value])? {
    value = call(&h.to_iso_string, &[value])?;
  }
  if js::truthy(locale) {
    live::set(h, r, locale, value)
  } else {
    call(&h.set_field_of, &[r, field, value]).map(|_| ())
  }
}

/// `isValidRelationObject(value)`
fn is_valid_relation_object(v: Local) -> JsResult<bool> {
  Ok(is_object(v) && js::has_property(v, js::key("relationTo"))? && js::has_property(v, js::key("value"))?)
}

/// `{ relationTo: item.relationTo, value: convertRelationshipValue({ ..., value: item.value }) }`
fn relation_object(cx: &Cx, item: Local, related: Local) -> JsResult<Local> {
  let h = &*cx.h;
  let relation_to = get_named(h, item, "relationTo")?;
  let value = get_named(h, item, "value")?;
  let value = convert_relationship_value(cx, related, value)?;
  call(&h.relation_object, &[relation_to, value])
}

/// The `items.map((item) => ...)` callback of `processRelationshipValues`.
fn process_relationship_item(cx: &Cx, field: Local, item: Local) -> JsResult<Local> {
  let h = &*cx.h;
  if is_array(h, get_named(h, field, "relationTo")?)? && is_valid_relation_object(item)? {
    let related = call(&h.find_collection, &[cx.config, item])?;
    if js::truthy(related) {
      return relation_object(cx, item, related);
    }
    return Ok(item);
  }
  if js::type_of(get_named(h, field, "relationTo")?) == Type::String {
    let related = call(&h.find_collection, &[cx.config, field])?;
    if js::truthy(related) {
      return convert_relationship_value(cx, related, item);
    }
  }
  Ok(item)
}

/// `convertRelationshipValue({ adapter, operation, relatedCollection, validateRelationships, value })`
fn convert_relationship_value(cx: &Cx, related: Local, value: Local) -> JsResult<Local> {
  let h = &*cx.h;
  let custom_id_field = call(&h.custom_id_field, &[related])?;

  if cx.op == Operation::Read {
    if live::is_object_id(value)? {
      return live::call_method(h, value, "toHexString", "value.toHexString", &[]);
    }
    if test(&h.custom_id_is_number, &[custom_id_field])?
      && js::type_of(value) == Type::BigInt
      && js::truthy(get_named(h, cx.adapter, "useBigIntForNumberIDs")?)
    {
      return call(&h.to_number, &[value]);
    }
    return Ok(value);
  }

  if js::truthy(custom_id_field) {
    return Ok(value);
  }
  if js::type_of(value) == Type::String {
    return match call(&h.new_object_id, &[value]) {
      Ok(id) => Ok(id),
      Err(e) if js::truthy(cx.validate_relationships) => Err(e),
      Err(_) => Ok(value),
    };
  }
  Ok(value)
}

fn sanitize_relationship(cx: &Cx, field: Local, locale: Local, r: Local, value: Local) -> JsResult<()> {
  let h = &*cx.h;
  if test(&h.is_join_field, &[field])? {
    if test(&h.join_docs_condition, &[cx.operation, value])? {
      let mut i = 0u32;
      while live::less_than(h, i, get_named(h, get_named(h, value, "docs")?, "length")?)? {
        let index = js::number(f64::from(i));
        let item = get(h, get_named(h, value, "docs")?, index)?;
        if live::is_object_id(item)? {
          let docs = get_named(h, value, "docs")?;
          let hex = live::call_method(h, item, "toHexString", "item.toHexString", &[])?;
          live::set(h, docs, index, hex)?;
        } else if test(&h.polymorphic_join_item, &[field, item])? {
          let docs = get_named(h, value, "docs")?;
          let current = get(h, get_named(h, value, "docs")?, index)?;
          let parsed = call(&h.json_round_trip, &[current])?;
          live::set(h, docs, index, parsed)?;
        }
        i += 1;
      }
    }
    return Ok(());
  }

  let has_many_relations = js::type_of(get_named(h, field, "relationTo")?) != Type::String;
  let mut related = js::undefined();
  if !has_many_relations {
    related = call(&h.find_collection, &[cx.config, field])?;
  }

  let mut result = value;
  if is_array(h, value)? {
    result = call(&h.map_relationship_values, &[value, cx.state, field, related])?;
  } else if is_valid_relation_object(value)? {
    related = call(&h.find_collection, &[cx.config, value])?;
    if js::truthy(related) {
      result = relation_object(cx, value, related)?;
    }
  } else if js::truthy(related) {
    result = convert_relationship_value(cx, related, value)?;
  }

  if js::truthy(locale) {
    live::set(h, r, locale, result)
  } else {
    call(&h.set_field_of, &[r, field, result]).map(|_| ())
  }
}

/// The `value.map((val) => ...)` callback of `sanitizeRelationship`.
fn map_relationship_value(cx: &Cx, field: Local, related: Local, val: Local) -> JsResult<Local> {
  let _ = field;
  if is_nullish(val) {
    return Ok(val);
  }
  if is_valid_relation_object(val)? {
    let single = call(&cx.h.find_collection, &[cx.config, val])?;
    if js::truthy(single) {
      return relation_object(cx, val, single);
    }
  }
  if js::truthy(related) {
    return convert_relationship_value(cx, related, val);
  }
  Ok(val)
}

// -------------------------------------------------------------------------------------------------
// natives behind the JS callbacks of helpers.js

type Native = unsafe extern "C" fn(sys::napi_env, sys::napi_callback_info) -> sys::napi_value;

macro_rules! native {
  ($name:ident, $n:literal, |$args:ident| $body:expr) => {
    unsafe extern "C" fn $name(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
      // not an engine entry of its own: the env is the one the closure was made in
      js::set_env_uncounted(env);
      let ($args, _) = js::callback_args::<$n>(env, info);
      live::finish(catch_unwind(AssertUnwindSafe(|| -> JsResult<Local> { $body })))
    }
  };
}

native!(native_traverse_field, 7, |a| {
  let cx = Cx::from_state(a[0])?;
  traverse_field(&cx, a[1], js::truthy(a[2]), a[3], a[4], a[5], js::truthy(a[6]))
});

native!(native_locale_operation, 6, |a| {
  let cx = Cx::from_state(a[0])?;
  locale_operation(&cx, a[1], a[2], js::get_f64(a[3]) as u32, a[4], a[5])
});

native!(native_process_relationship_item, 3, |a| {
  let cx = Cx::from_state(a[0])?;
  process_relationship_item(&cx, a[1], a[2])
});

native!(native_map_relationship_value, 4, |a| {
  let cx = Cx::from_state(a[0])?;
  map_relationship_value(&cx, a[1], a[2], a[3])
});

/// The `native` object helpers.js calls (`native.<name>(...)`).
pub(crate) const NATIVES: &[(&str, Native)] = &[
  ("traverseField", native_traverse_field),
  ("localeOperation", native_locale_operation),
  ("processRelationshipItem", native_process_relationship_item),
  ("mapRelationshipValue", native_map_relationship_value),
];
