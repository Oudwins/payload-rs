//! Port of `packages/payload/src/fields/hooks/beforeChange/{index,traverseFields,promise,
//! getExistingRowDoc}.ts`.
//!
//! Mirrors the TS line by line (RUST_CORE_DESIGN.md porting rules): every TS `async` function
//! (`beforeChange`, `traverseFields`, `promise`) is a spawned task with its own native promise,
//! every `await` is a real JS await, concurrency is only composed with JS `Promise.all`, and the
//! arrays user code can see (`errors`, `mergeLocaleActions`, path segments) are real JS arrays
//! created at the same points. No `Local` is kept across an await.

use std::ffi::c_void;
use std::ptr;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::config::{self, BlockCandidate, FieldDesc, FieldsDesc, Kind, format_number};
use payload_core_runtime::executor::{Tail, await_js, spawn, spawn_tail};
use payload_core_runtime::host::{self as rt, call_host};
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Type, Val};

use crate::host::{call_fn, change_host, in_op, type_error};

/// The destructured `beforeChange` args shared by the whole traversal.
struct Ctx {
  /// `[id, collection, context, data, doc, docWithLocales, errors, global, isValidationOperation,
  /// mergeLocaleActions, operation, overrideAccess, req, skipHooks, submittedTopLevelFieldNames]`
  /// for the host's `beforeChangeLeaves` (indices `C_*` in
  /// packages/engine-rs/src/runtime/beforeChange/index.ts).
  arr: Val,
  id: Val,
  collection: Val,
  context: Val,
  /// The deep copy of the incoming data (`data` of every traversal and hook).
  data: Val,
  doc: Val,
  doc_with_locales: Val,
  errors: Val,
  global: Val,
  is_validation_operation: Val,
  merge_locale_actions: Val,
  operation: Val,
  override_access: Val,
  req: Val,
  skip_hooks: Val,
  submitted_top_level_field_names: Val,
}

/// Arguments of one `traverseFields` call that differ between calls.
struct Trav {
  block_data: Val,
  block_fields: Val,
  field_label_path: Val,
  fields: Rc<FieldsDesc>,
  /// For `tabs`: the `field.tabs.map((tab) => ({ ...tab, type: 'tab' }))` array (its items are the
  /// `field` objects and it is `siblingFields`).
  tab_fields: Option<Val>,
  parent_index_path: Rc<str>,
  parent_is_localized: Val,
  parent_path: Rc<str>,
  parent_schema_path: Rc<str>,
  sibling_data: Val,
  sibling_doc: Val,
  sibling_doc_with_locales: Val,
  skip_validation: Val,
}

impl Trav {
  fn sibling_fields(&self) -> Local {
    match &self.tab_fields {
      Some(v) => v.get(),
      None => self.fields.node.get(),
    }
  }
}

/// `beforeChange(args)`: returns the promise of the processed (deep-copied) data.
pub fn before_change(args: Local) -> JsResult<Local> {
  let args = Val::from_local(args)?;
  spawn(run(args))
}

impl Ctx {
  #[allow(clippy::too_many_arguments)]
  fn new(
    id: Val,
    collection: Val,
    context: Val,
    data: Val,
    doc: Val,
    doc_with_locales: Val,
    errors: Val,
    global: Val,
    is_validation_operation: Val,
    merge_locale_actions: Val,
    operation: Val,
    override_access: Val,
    req: Val,
    skip_hooks: Val,
    submitted_top_level_field_names: Val,
  ) -> JsResult<Rc<Ctx>> {
    let arr = js::array();
    let values = [
      &id,
      &collection,
      &context,
      &data,
      &doc,
      &doc_with_locales,
      &errors,
      &global,
      &is_validation_operation,
      &merge_locale_actions,
      &operation,
      &override_access,
      &req,
      &skip_hooks,
      &submitted_top_level_field_names,
    ];
    for (i, v) in values.into_iter().enumerate() {
      js::set_element(arr, i as u32, v.get())?;
    }
    Ok(Rc::new(Ctx {
      arr: Val::from_local(arr)?,
      id,
      collection,
      context,
      data,
      doc,
      doc_with_locales,
      errors,
      global,
      is_validation_operation,
      merge_locale_actions,
      operation,
      override_access,
      req,
      skip_hooks,
      submitted_top_level_field_names,
    }))
  }
}

/// `traverseFields(args)` (beforeChange/traverseFields.ts, exported by payload as
/// `beforeChangeTraverseFields`): `a` is its destructured parameter, in the pattern's order (`id,
/// blockData, blockFields, collection, context, data, doc, docWithLocales, errors, fieldLabelPath,
/// fields, global, isValidationOperation, mergeLocaleActions, operation, overrideAccess,
/// parentIndexPath, parentIsLocalized, parentPath, parentSchemaPath, req, siblingData, siblingDoc,
/// siblingDocWithLocales, skipHooks, skipValidation, submittedTopLevelFieldNames`; the TS glue
/// destructures with upstream's pattern and only calls this with string paths). Returns the
/// traversal's promise.
pub fn traverse_fields_entry(a: Local) -> JsResult<Local> {
  let a = Val::from_local(a)?;
  spawn_tail(async move {
    let a = a.get();
    let e = |i: u32| -> JsResult<Val> { Val::from_local(js::get_element(a, i)?) };
    let s = |i: u32| -> JsResult<Rc<str>> { Ok(js::get_string(js::get_element(a, i)?).unwrap_or_default().into()) };
    let (id, block_data, block_fields, collection, context) = (e(0)?, e(1)?, e(2)?, e(3)?, e(4)?);
    let (data, doc, doc_with_locales, errors, field_label_path) = (e(5)?, e(6)?, e(7)?, e(8)?, e(9)?);
    let fields = config::fields_desc(js::get_element(a, 10)?)?;
    let (global, is_validation_operation, merge_locale_actions, operation, override_access) =
      (e(11)?, e(12)?, e(13)?, e(14)?, e(15)?);
    let (parent_index_path, parent_is_localized, parent_path, parent_schema_path) = (s(16)?, e(17)?, s(18)?, s(19)?);
    let (req, sibling_data, sibling_doc, sibling_doc_with_locales) = (e(20)?, e(21)?, e(22)?, e(23)?);
    let (skip_hooks, skip_validation, submitted_top_level_field_names) = (e(24)?, e(25)?, e(26)?);
    let ctx = Ctx::new(
      id,
      collection,
      context,
      data,
      doc,
      doc_with_locales,
      errors,
      global,
      is_validation_operation,
      merge_locale_actions,
      operation,
      override_access,
      req,
      skip_hooks,
      submitted_top_level_field_names,
    )?;
    let trav = Trav {
      block_data,
      block_fields,
      field_label_path,
      fields,
      tab_fields: None,
      parent_index_path,
      parent_is_localized,
      parent_path,
      parent_schema_path,
      sibling_data,
      sibling_doc,
      sibling_doc_with_locales,
      skip_validation,
    };
    traverse_fields(ctx, Rc::new(trav)).await
  })
}

/// Port of `index.ts`.
async fn run(args: Val) -> JsResult<Val> {
  let rh = rt::host()?;
  let ch = change_host()?;
  // Parameter destructuring, in source order.
  let a = args.get();
  let g = |name: &str| -> JsResult<Val> { Val::from_local(rt::get_named(a, name)?) };
  let id = g("id")?;
  let collection = g("collection")?;
  let context = g("context")?;
  let incoming_data = g("data")?;
  let doc = g("doc")?;
  let doc_with_locales = g("docWithLocales")?;
  let submitted_top_level_field_names = g("fieldsToValidate")?;
  let global = g("global")?;
  let is_validation_operation = g("isValidationOperation")?;
  let on_data_processed = g("onDataProcessed")?;
  let operation = g("operation")?;
  let override_access = g("overrideAccess")?;
  let req = g("req")?;
  let skip_hooks = g("skipHooks")?;
  let skip_validation = g("skipValidation")?;

  let data = Val::from_local(call_host(&rh.deep_copy, &[incoming_data.get()])?)?;
  let merge_locale_actions = Val::from_local(js::array())?;
  let errors = Val::from_local(js::array())?;

  call_host(&ch.record_new_doc, &[context.get(), doc_with_locales.get()])?;

  let ctx = Ctx::new(
    id,
    collection,
    context,
    data,
    doc,
    doc_with_locales,
    errors,
    global,
    is_validation_operation,
    merge_locale_actions,
    operation,
    override_access,
    req,
    skip_hooks,
    submitted_top_level_field_names,
  )?;

  let fields = Val::from_local(entity_fields(&ctx)?)?;
  let traversal = traverse(
    &ctx,
    Trav {
      block_data: Val::Undefined,
      block_fields: Val::Undefined,
      field_label_path: Val::from_local(js::string(""))?,
      fields: config::fields_desc(fields.get())?,
      tab_fields: None,
      parent_index_path: "".into(),
      parent_is_localized: Val::Bool(false),
      parent_path: "".into(),
      parent_schema_path: "".into(),
      sibling_data: ctx.data.clone(),
      sibling_doc: ctx.doc.clone(),
      sibling_doc_with_locales: ctx.doc_with_locales.clone(),
      skip_validation,
    },
  )?;
  await_js(traversal).await?;

  if cfg!(feature = "mutant-merge-before-errors") {
    run_merge_locale_actions(&ctx).await?;
  }

  if js::array_length(ctx.errors.get()) > 0 {
    let error = call_host(
      &ch.validation_error,
      &[ctx.id.get(), ctx.collection.get(), ctx.errors.get(), ctx.global.get(), ctx.req.get()],
    )?;
    return Err(Thrown(Val::from_local(error)?));
  }

  // onDataProcessed?.(data)
  let callback = on_data_processed.get();
  if !is_nullish(callback) {
    call_fn("onDataProcessed", callback, js::undefined(), &[ctx.data.get()])?;
  }

  if !cfg!(feature = "mutant-merge-before-errors") {
    run_merge_locale_actions(&ctx).await?;
  }

  Ok(ctx.data.clone())
}

/// `for (const action of mergeLocaleActions) { await action() }`
async fn run_merge_locale_actions(ctx: &Rc<Ctx>) -> JsResult<()> {
  let mut i = 0;
  while i < js::array_length(ctx.merge_locale_actions.get()) {
    let action = js::get_element(ctx.merge_locale_actions.get(), i)?;
    i += 1;
    let result = call_fn("action", action, js::undefined(), &[])?;
    await_js(result).await?;
  }
  Ok(())
}

/// `(collection?.fields || global?.fields)!`
fn entity_fields(ctx: &Ctx) -> JsResult<Local> {
  let collection_fields = rt::get_optional(ctx.collection.get(), js::key("fields"))?;
  if js::truthy(collection_fields) {
    return Ok(collection_fields);
  }
  rt::get_optional(ctx.global.get(), js::key("fields"))
}

/// Calls the async `traverseFields` (runs synchronously to its first await) and returns its
/// promise. A fields array made only of leaf fields ([`is_leaf`]) runs upstream's
/// `traverseFields.ts` body in JS (`beforeChangeLeafTraversal`: `fields.forEach` pushing the leaf
/// `promise()`, `await Promise.all`); other arrays run the port.
fn traverse(ctx: &Rc<Ctx>, trav: Trav) -> JsResult<Local> {
  let all_leaves =
    trav.tab_fields.is_none() && trav.fields.items.as_ref().is_some_and(|items| items.iter().all(|f| is_leaf(f.kind)));
  if all_leaves && !cfg!(feature = "mutant-reverse-fields") {
    return call_host(
      &change_host()?.before_change_leaf_traversal,
      &[
        ctx.arr.get(),
        trav.fields.node.get(),
        trav.block_data.get(),
        trav.block_fields.get(),
        trav.field_label_path.get(),
        js::string(&trav.parent_index_path),
        trav.parent_is_localized.get(),
        js::string(&trav.parent_path),
        js::string(&trav.parent_schema_path),
        trav.sibling_data.get(),
        trav.sibling_doc.get(),
        trav.sibling_doc_with_locales.get(),
        trav.skip_validation.get(),
      ],
    );
  }
  spawn_tail(traverse_fields(ctx.clone(), Rc::new(trav)))
}

/// Port of `traverseFields.ts`.
async fn traverse_fields(ctx: Rc<Ctx>, t: Rc<Trav>) -> JsResult<Tail> {
  let Some(items) = &t.fields.items else {
    config::throw_not_array(&t.fields)?;
    return Ok(Tail::Return(Val::Undefined));
  };
  let promises = js::array();
  if !cfg!(feature = "mutant-reverse-fields") && t.tab_fields.is_none() {
    // Runs of leaves go to the host in one call each (upstream's `promise()` per field, pushed
    // in order); other fields are ported tasks.
    let mut index = 0;
    while index < items.len() {
      if !is_leaf(items[index].kind) {
        let desc = &items[index];
        let promise = spawn_tail(field_promise(ctx.clone(), t.clone(), desc.clone(), Val::Ref(desc.node.clone()), index))?;
        js::push(promises, promise)?;
        index += 1;
        continue;
      }
      let start = index;
      while index < items.len() && is_leaf(items[index].kind) {
        index += 1;
      }
      call_host(
        &change_host()?.before_change_leaves,
        &[
          ctx.arr.get(),
          t.fields.node.get(),
          js::number(start as f64),
          js::number(index as f64),
          promises,
          t.block_data.get(),
          t.block_fields.get(),
          t.field_label_path.get(),
          js::string(&t.parent_index_path),
          t.parent_is_localized.get(),
          js::string(&t.parent_path),
          js::string(&t.parent_schema_path),
          t.sibling_data.get(),
          t.sibling_doc.get(),
          t.sibling_doc_with_locales.get(),
          t.skip_validation.get(),
        ],
      )?;
    }
    let all = call_host(&rt::host()?.promise_all, &[promises])?;
    return Ok(Tail::Await(all, Val::Undefined));
  }
  let order: Box<dyn Iterator<Item = (usize, &Rc<FieldDesc>)>> = if cfg!(feature = "mutant-reverse-fields") {
    Box::new(items.iter().enumerate().rev())
  } else {
    Box::new(items.iter().enumerate())
  };
  for (index, desc) in order {
    let field_js = match &t.tab_fields {
      Some(arr) => Val::from_local(js::get_element(arr.get(), index as u32)?)?,
      None => Val::Ref(desc.node.clone()),
    };
    let promise = spawn_tail(field_promise(ctx.clone(), t.clone(), desc.clone(), field_js, index))?;
    js::push(promises, promise)?;
  }
  let all = call_host(&rt::host()?.promise_all, &[promises])?;
  Ok(Tail::Await(all, Val::Undefined))
}

/// A field whose `promise()` traverses no subfields and calls no editor hooks: the host runs it
/// (`beforeChangeLeaves`, upstream's `promise.ts` body for such a field).
fn is_leaf(kind: Kind) -> bool {
  !matches!(
    kind,
    Kind::Array | Kind::Blocks | Kind::Collapsible | Kind::Group | Kind::RichText | Kind::Row | Kind::Tab | Kind::Tabs
  )
}

struct Paths {
  index_path: String,
  path: String,
  schema_path: String,
}

/// Port of `getFieldPaths`.
fn get_field_paths(
  field: &FieldDesc,
  index: usize,
  parent_index_path: &str,
  parent_path: &str,
  parent_schema_path: &str,
) -> Paths {
  let parent_segments: Vec<&str> = parent_path.split('.').collect();
  let parent_path_is_unnamed = parent_segments.last().is_some_and(|s| s.starts_with("_index-"));
  let parent_path_to_use = if parent_path_is_unnamed {
    parent_segments[..parent_segments.len() - 1].join(".")
  } else {
    parent_path.to_string()
  };
  let prefix = |p: &str| if p.is_empty() { String::new() } else { format!("{p}.") };

  if field.has_name {
    return Paths {
      index_path: String::new(),
      path: format!("{}{}", prefix(&parent_path_to_use), field.name_str),
      schema_path: format!("{}{}", prefix(parent_schema_path), field.name_str),
    };
  }
  let index_path = if parent_index_path.is_empty() {
    index.to_string()
  } else {
    format!("{parent_index_path}-{index}")
  };
  let index_suffix = format!("_index-{index_path}");
  let parent_schema_is_unnamed =
    parent_schema_path.split('.').next_back().is_some_and(|s| s.starts_with("_index-"));
  Paths {
    path: format!("{}{}", prefix(&parent_path_to_use), index_suffix),
    schema_path: if parent_schema_is_unnamed {
      format!("{parent_schema_path}-{index}")
    } else {
      format!("{}{}", prefix(parent_schema_path), index_suffix)
    },
    index_path,
  }
}

/// `s ? s.split(sep) : []`
fn split_array(s: &str, sep: char) -> JsResult<Local> {
  if s.is_empty() { Ok(js::array()) } else { js::string_array(s.split(sep)) }
}

/// `indexPath ? indexPath.split('-').filter(Boolean)?.map(Number) : []`
fn index_segments(s: &str) -> JsResult<Local> {
  let arr = js::array();
  for (i, part) in s.split('-').filter(|p| !p.is_empty()).enumerate() {
    js::set_element(arr, i as u32, js::number(part.parse::<f64>().unwrap_or(f64::NAN)))?;
  }
  Ok(arr)
}

/// Creates `{ k1: v1, k2: v2, ... }` with the given key order.
fn object(pairs: &[(&str, Local)]) -> JsResult<Local> {
  let o = js::object();
  for (k, v) in pairs {
    js::set_named(o, k, *v)?;
  }
  Ok(o)
}

fn is_nullish(v: Local) -> bool {
  matches!(js::type_of(v), Type::Undefined | Type::Null)
}

/// `a || b` on JS values.
fn or(a: &Val, b: &Val) -> Val {
  if js::truthy(a.get()) { a.clone() } else { b.clone() }
}

/// `typeof v === 'object'` (true for null).
fn is_typeof_object(v: Local) -> bool {
  js::type_of(v).is_typeof_object()
}

/// Port of `promise.ts`.
async fn field_promise(
  ctx: Rc<Ctx>,
  t: Rc<Trav>,
  f: Rc<FieldDesc>,
  field_js: Val,
  field_index: usize,
) -> JsResult<Tail> {
  let rh = rt::host()?;
  let ch = change_host()?;
  let Paths { index_path, path, schema_path } =
    get_field_paths(&f, field_index, &t.parent_index_path, &t.parent_path, &t.parent_schema_path);
  let req = || ctx.req.get();
  let name = || f.name.get();
  let sd = || t.sibling_data.get();

  // const { localization } = req.payload.config
  let localization =
    Val::from_local(rt::get_named(rt::get_named(rt::get_named(req(), "payload")?, "config")?, "localization")?)?;
  let default_locale = if js::truthy(localization.get()) {
    Val::from_local(rt::get_optional(localization.get(), js::key("defaultLocale"))?)?
  } else {
    Val::from_local(js::string("en"))?
  };
  let req_locale = rt::get_named(req(), "locale")?;
  let operation_locale = if js::truthy(req_locale) { Val::from_local(req_locale)? } else { default_locale.clone() };

  let path_segments = Val::from_local(split_array(&path, '.')?)?;
  let schema_path_segments = Val::from_local(split_array(&schema_path, '.')?)?;
  let index_path_segments = Val::from_local(index_segments(&index_path)?)?;

  // field.admin?.condition ? Boolean(field.admin.condition(data, siblingData, {...})) : true
  let admin = rt::get_named(field_js.get(), "admin")?;
  let passes_condition = if js::truthy(rt::get_optional(admin, js::key("condition"))?) {
    let admin = rt::get_named(field_js.get(), "admin")?;
    let condition = rt::get_named(admin, "condition")?;
    let options = object(&[
      ("blockData", t.block_data.get()),
      ("operation", ctx.operation.get()),
      ("path", path_segments.get()),
      ("user", rt::get_named(req(), "user")?),
    ])?;
    js::truthy(call_fn(
      "field.admin.condition",
      condition,
      admin,
      &[ctx.data.get(), sd(), options],
    )?)
  } else {
    true
  };

  // submittedTopLevelFieldNames !== undefined && fieldAffectsData(field) && !submitted.has(pathSegments[0]!)
  let submitted = ctx.submitted_top_level_field_names.get();
  let is_outside_submitted_field_scope = js::type_of(submitted) != Type::Undefined && f.affects_data && {
    let has = rt::get_named(submitted, "has")?;
    let first_segment = rt::get(path_segments.get(), js::number(0.0))?;
    !js::truthy(call_fn("submittedTopLevelFieldNames.has", has, submitted, &[first_segment])?)
  };

  // skipValidation || isOutsideSubmittedFieldScope || !passesCondition
  let mut skip_validation_from_here = if js::truthy(t.skip_validation.get()) {
    t.skip_validation.clone()
  } else if is_outside_submitted_field_scope {
    Val::Bool(true)
  } else {
    Val::Bool(!passes_condition)
  };

  let should_be_localized = f.localized_truthy && !js::truthy(t.parent_is_localized.get());

  if f.affects_data {
    let should_skip_validation_for_localized_fallback = !js::truthy(ctx.is_validation_operation.get())
      && !js::str_equals(ctx.operation.get(), "validate")
      && should_be_localized
      && !js::strict_equals(operation_locale.get(), default_locale.get())
      && matches!(f.kind, Kind::Array | Kind::Blocks)
      && js::type_of(rt::get(sd(), name())?) == Type::Null;

    if should_skip_validation_for_localized_fallback {
      skip_validation_from_here = Val::Bool(true);
    }

    // Execute hooks
    if !js::truthy(ctx.skip_hooks.get())
      && in_op(js::key("hooks"), field_js.get())?
      && js::truthy(rt::get_optional(rt::get_named(field_js.get(), "hooks")?, js::key("beforeChange"))?)
    {
      let hooks = Val::from_local(rt::get_named(rt::get_named(field_js.get(), "hooks")?, "beforeChange")?)?;
      if !js::is_array(hooks.get()) {
        return Err(type_error("field.hooks.beforeChange is not iterable"));
      }
      let mut i = 0;
      while i < js::array_length(hooks.get()) {
        let hook = js::get_element(hooks.get(), i)?;
        i += 1;
        let previous_value = rt::get(t.sibling_doc.get(), name())?;
        let value = rt::get(sd(), name())?;
        let args = call_host(
          &ch.hook_args,
          &[
            t.block_data.get(),
            ctx.collection.get(),
            ctx.context.get(),
            ctx.data.get(),
            field_js.get(),
            ctx.global.get(),
            index_path_segments.get(),
            ctx.operation.get(),
            ctx.doc.get(),
            ctx.override_access.get(),
            path_segments.get(),
            t.sibling_doc.get(),
            previous_value,
            req(),
            schema_path_segments.get(),
            sd(),
            t.sibling_doc_with_locales.get(),
            t.sibling_fields(),
            value,
          ],
        )?;
        let result = call_fn("hook", hook, js::undefined(), &[args])?;
        let hooked_value = await_maybe(result).await?;
        if !hooked_value.is_undefined() {
          rt::set(sd(), name(), hooked_value.get())?;
        }
      }
    }

    if has_invalid_field_value_shape(field_js.get(), &f, rt::get(sd(), name())?)? {
      let label = call_host(&ch.label_field, &[t.field_label_path.get(), field_js.get(), req()])?;
      let message = req_t(req(), "validation:invalidInput")?;
      let error = object(&[("label", label), ("message", message), ("path", js::string(&path))])?;
      js::push(ctx.errors.get(), error)?;
      return Ok(Tail::Return(Val::Undefined));
    }

    // Validate
    if !js::truthy(skip_validation_from_here.get())
      && in_op(js::key("validate"), field_js.get())?
      && js::truthy(rt::get_named(field_js.get(), "validate")?)
    {
      let value_to_validate = rt::get(sd(), name())?;

      let is_locale_keyed_value = js::str_equals(operation_locale.get(), "all")
        && js::truthy(localization.get())
        && should_be_localized
        && f.kind != Kind::Group
        && js::type_of(value_to_validate) != Type::Null
        && is_typeof_object(value_to_validate)
        && !js::is_array(value_to_validate);

      // [{ locale?, value }]
      let mut localized_values_to_validate: Vec<(Val, Val)> = Vec::new();
      if is_locale_keyed_value {
        let value_to_validate = Val::from_local(value_to_validate)?;
        let locales = call_host(&ch.locales_in, &[localization.get(), value_to_validate.get()])?;
        let locales = Val::from_local(locales)?;
        for i in 0..js::array_length(locales.get()) {
          let locale = js::get_element(locales.get(), i)?;
          let value = rt::get(value_to_validate.get(), locale)?;
          localized_values_to_validate.push((Val::from_local(locale)?, Val::from_local(value)?));
        }
      } else {
        localized_values_to_validate.push((Val::Undefined, Val::from_local(value_to_validate)?));
      }
      if localized_values_to_validate.is_empty() {
        localized_values_to_validate.push((Val::Undefined, Val::Undefined));
      }

      let mut json_error = Val::Undefined;
      if js::str_equals(rt::get_named(field_js.get(), "type")?, "json")
        && js::type_of(rt::get(sd(), name())?) == Type::String
      {
        json_error = Val::from_local(call_host(&ch.try_json_parse, &[sd(), name()])?)?;
      }

      let validate_fn = Val::from_local(rt::get_named(field_js.get(), "validate")?)?;

      let mut validation_result = Val::Bool(true);
      let mut failed_locale = Val::Undefined;

      let validation_data = Val::from_local(call_host(&ch.deep_merge, &[ctx.doc.get(), ctx.data.get()])?)?;
      let validation_sibling_data =
        Val::from_local(call_host(&ch.deep_merge, &[t.sibling_doc.get(), sd()])?)?;

      for (locale, value) in localized_values_to_validate {
        let has_locale = js::truthy(locale.get());
        let validation_req = if has_locale {
          call_host(&ch.isolate_locale, &[req(), locale.get()])?
        } else {
          req()
        };
        let (block_data, data, sibling_data) = if has_locale {
          let locale_context = call_host(
            &ch.locale_context,
            &[
              req(),
              t.block_data.get(),
              t.block_fields.get(),
              validation_data.get(),
              ctx.collection.get(),
              ctx.global.get(),
              validation_sibling_data.get(),
              t.sibling_fields(),
              locale.get(),
              t.parent_is_localized.get(),
            ],
          )?;
          (
            js::get_named(locale_context, "blockData")?,
            js::get_named(locale_context, "data")?,
            js::get_named(locale_context, "siblingData")?,
          )
        } else {
          (t.block_data.get(), validation_data.get(), validation_sibling_data.get())
        };
        let options = call_host(
          &ch.validate_options,
          &[
            field_js.get(),
            ctx.id.get(),
            block_data,
            ctx.collection.get(),
            data,
            json_error.get(),
            ctx.operation.get(),
            ctx.override_access.get(),
            path_segments.get(),
            t.sibling_doc.get(),
            locale.get(),
            validation_req,
            sibling_data,
          ],
        )?;
        let result = call_fn("validateFn", validate_fn.get(), js::undefined(), &[value.get(), options])?;
        validation_result = await_maybe(result).await?;

        if js::type_of(validation_result.get()) == Type::String {
          failed_locale = locale;
          break;
        }
      }

      if js::type_of(validation_result.get()) == Type::String {
        let mut filter_options_error = false;

        if f.kind == Kind::Blocks && js::truthy(rt::get_named(field_js.get(), "filterOptions")?) {
          let args = object(&[
            ("id", ctx.id.get()),
            ("data", ctx.data.get()),
            ("filterOptions", rt::get_named(field_js.get(), "filterOptions")?),
            ("req", req()),
            ("siblingData", sd()),
            ("value", rt::get(sd(), name())?),
          ])?;
          let pending = call_host(&ch.validate_blocks_filter_options, &[args])?;
          let filter_result = await_js(pending).await?;
          filter_options_error = js::truthy(call_host(
            &ch.blocks_filter_options_errors,
            &[
              filter_result.get(),
              field_js.get(),
              sd(),
              t.field_label_path.get(),
              js::string(&path),
              req(),
              ctx.errors.get(),
            ],
          )?);
        }

        if !filter_options_error {
          let label = call_host(
            &ch.label_field_error,
            &[t.field_label_path.get(), field_js.get(), req(), failed_locale.get()],
          )?;
          let error = object(&[
            ("label", label),
            ("message", validation_result.get()),
            ("path", js::string(&path)),
          ])?;
          js::push(ctx.errors.get(), error)?;
        }
      }
    }

    // Push merge locale action if applicable
    if js::truthy(localization.get()) && should_be_localized {
      let action = merge_locale_action(MergeLocaleState {
        sibling_data: t.sibling_data.clone(),
        name: f.name.clone(),
        sibling_doc_with_locales: t.sibling_doc_with_locales.clone(),
        req: ctx.req.clone(),
        localization: localization.clone(),
      })?;
      js::push(ctx.merge_locale_actions.get(), action)?;
    }
  }

  let parent_is_localized_or_field = || or(&t.parent_is_localized, &f.localized);

  match f.kind {
    Kind::Array => {
      let rows = rt::get(sd(), name())?;
      if js::is_array(rows) {
        let promises = Val::from_local(js::array())?;
        let children = f.children()?;
        for_each(rows, |row, row_index| {
          let field_label_path = call_host(
            &ch.label_array_row,
            &[t.field_label_path.get(), field_js.get(), req(), js::number(row_index as f64)],
          )?;
          let sibling_doc = get_existing_row_doc(row, rt::get(t.sibling_doc.get(), name())?)?;
          let sibling_doc_with_locales =
            get_existing_row_doc(row, rt::get_optional(t.sibling_doc_with_locales.get(), name())?)?;
          let p = traverse_or_inline(
            &ctx,
            Trav {
              block_data: t.block_data.clone(),
              block_fields: t.block_fields.clone(),
              field_label_path: Val::from_local(field_label_path)?,
              fields: children.clone(),
              tab_fields: None,
              parent_index_path: "".into(),
              parent_is_localized: parent_is_localized_or_field(),
              parent_path: format!("{path}.{}", format_number(row_index as f64)).into(),
              parent_schema_path: Rc::from(schema_path.as_str()),
              sibling_data: Val::from_local(row)?,
              sibling_doc: Val::from_local(sibling_doc)?,
              sibling_doc_with_locales: Val::from_local(sibling_doc_with_locales)?,
              skip_validation: skip_validation_from_here.clone(),
            },
          )?;
          js::push(promises.get(), p)
        })?;
        let all = call_host(&rh.promise_all, &[promises.get()])?;
        return Ok(Tail::Await(all, Val::Undefined));
      }
    }

    Kind::Blocks => {
      let rows = rt::get(sd(), name())?;
      if js::is_array(rows) {
        let promises = Val::from_local(js::array())?;
        for_each(rows, |row, row_index| {
          let row_sibling_doc = get_existing_row_doc(row, rt::get(t.sibling_doc.get(), name())?)?;
          let sibling_doc_with_locales = t.sibling_doc_with_locales.get();
          let existing_rows = if js::truthy(sibling_doc_with_locales) {
            rt::get(sibling_doc_with_locales, name())?
          } else {
            js::object()
          };
          let row_sibling_doc_with_locales = get_existing_row_doc(row, existing_rows)?;

          let row_block_type = rt::get_named(row, "blockType")?;
          let block_type_to_match = if js::truthy(row_block_type) {
            row_block_type
          } else {
            rt::get_named(row_sibling_doc, "blockType")?
          };

          let block = find_block(&ctx, &f, block_type_to_match)?;

          let block_label_path = call_host(
            &ch.label_block_row,
            &[
              t.field_label_path.get(),
              field_js.get(),
              req(),
              js::number(row_index as f64),
              block.as_ref().map(|b| b.node.get()).unwrap_or_else(js::undefined),
              block_type_to_match,
            ],
          )?;

          if let Some(block) = block.filter(|b| js::truthy(b.node.get())) {
            let block_fields = rt::get_named(block.node.get(), "fields")?;
            let fields = match &block.desc {
              Some(desc) => desc.fields()?,
              None => config::fields_desc(block_fields)?,
            };
            let p = traverse_or_inline(
              &ctx,
              Trav {
                block_data: Val::from_local(row)?,
                block_fields: Val::from_local(block_fields)?,
                field_label_path: Val::from_local(block_label_path)?,
                fields,
                tab_fields: None,
                parent_index_path: "".into(),
                parent_is_localized: parent_is_localized_or_field(),
                parent_path: format!("{path}.{}", format_number(row_index as f64)).into(),
                parent_schema_path: format!("{schema_path}.{}", block.slug_str()?).into(),
                sibling_data: Val::from_local(row)?,
                sibling_doc: Val::from_local(row_sibling_doc)?,
                sibling_doc_with_locales: Val::from_local(row_sibling_doc_with_locales)?,
                skip_validation: skip_validation_from_here.clone(),
              },
            )?;
            js::push(promises.get(), p)?;
          }
          Ok(())
        })?;
        let all = call_host(&rh.promise_all, &[promises.get()])?;
        return Ok(Tail::Await(all, Val::Undefined));
      }
    }

    Kind::Collapsible | Kind::Row => {
      let field_label_path =
        call_host(&ch.label_collapsible, &[t.field_label_path.get(), field_js.get(), req()])?;
      let p = traverse_or_inline(
        &ctx,
        Trav {
          block_data: t.block_data.clone(),
          block_fields: t.block_fields.clone(),
          field_label_path: Val::from_local(field_label_path)?,
          fields: f.children()?,
          tab_fields: None,
          parent_index_path: Rc::from(index_path.as_str()),
          parent_is_localized: t.parent_is_localized.clone(),
          parent_path: t.parent_path.clone(),
          parent_schema_path: Rc::from(schema_path.as_str()),
          sibling_data: t.sibling_data.clone(),
          sibling_doc: t.sibling_doc.clone(),
          sibling_doc_with_locales: t.sibling_doc_with_locales.clone(),
          skip_validation: skip_validation_from_here.clone(),
        },
      )?;
      return Ok(Tail::Await(p, Val::Undefined));
    }

    Kind::Group => {
      let is_named_group = f.affects_data;
      let (sibling_data, sibling_doc, sibling_doc_with_locales) = if is_named_group {
        // Upstream runs the three checks twice.
        for _ in 0..2 {
          ensure_object(t.sibling_data.get(), name())?;
          ensure_object(t.sibling_doc.get(), name())?;
          ensure_object(t.sibling_doc_with_locales.get(), name())?;
        }
        (
          Val::from_local(rt::get(t.sibling_data.get(), name())?)?,
          Val::from_local(rt::get(t.sibling_doc.get(), name())?)?,
          Val::from_local(rt::get(t.sibling_doc_with_locales.get(), name())?)?,
        )
      } else {
        (t.sibling_data.clone(), t.sibling_doc.clone(), t.sibling_doc_with_locales.clone())
      };
      let field_label_path = call_host(
        &ch.label_group,
        &[t.field_label_path.get(), field_js.get(), req(), js::boolean(is_named_group)],
      )?;
      let p = traverse_or_inline(
        &ctx,
        Trav {
          block_data: t.block_data.clone(),
          block_fields: t.block_fields.clone(),
          field_label_path: Val::from_local(field_label_path)?,
          fields: f.children()?,
          tab_fields: None,
          parent_index_path: if is_named_group { "".into() } else { Rc::from(index_path.as_str()) },
          parent_is_localized: parent_is_localized_or_field(),
          parent_path: if is_named_group { Rc::from(path.as_str()) } else { t.parent_path.clone() },
          parent_schema_path: Rc::from(schema_path.as_str()),
          sibling_data,
          sibling_doc,
          sibling_doc_with_locales,
          skip_validation: skip_validation_from_here.clone(),
        },
      )?;
      return Ok(Tail::Await(p, Val::Undefined));
    }

    Kind::Point => {
      let value = rt::get(sd(), name())?;
      if js::is_array(value)
        && js::type_of(rt::get(rt::get(sd(), name())?, js::number(0.0))?) != Type::Null
        && js::type_of(rt::get(rt::get(sd(), name())?, js::number(1.0))?) != Type::Null
      {
        let parse_float = ch.parse_float.get();
        let x = rt::get(rt::get(sd(), name())?, js::number(0.0))?;
        let x = js::call(parse_float, js::undefined(), &[x])?;
        let y = rt::get(rt::get(sd(), name())?, js::number(1.0))?;
        let y = js::call(parse_float, js::undefined(), &[y])?;
        let coordinates = js::array();
        js::set_element(coordinates, 0, x)?;
        js::set_element(coordinates, 1, y)?;
        let point = object(&[("type", js::string("Point")), ("coordinates", coordinates)])?;
        rt::set(sd(), name(), point)?;
      }
    }

    Kind::RichText => {
      let editor = rt::get_optional(field_js.get(), js::key("editor"))?;
      if !js::truthy(editor) {
        let e = call_host(&rh.missing_editor_prop, &[field_js.get()])?;
        return Err(Thrown(Val::from_local(e)?));
      }
      if js::type_of(rt::get_optional(field_js.get(), js::key("editor"))?) == Type::Function {
        return Err(rt::new_error("Attempted to access unsanitized rich text editor.")?);
      }
      let editor = Val::from_local(rt::get_optional(field_js.get(), js::key("editor"))?)?;
      let hooks_obj = rt::get_optional(editor.get(), js::key("hooks"))?;
      let before_change = rt::get_optional(hooks_obj, js::key("beforeChange"))?;
      if !js::truthy(ctx.skip_hooks.get())
        && js::truthy(rt::get_optional(before_change, js::key("length"))?)
      {
        let hooks = Val::from_local(rt::get_named(rt::get_named(editor.get(), "hooks")?, "beforeChange")?)?;
        if !js::is_array(hooks.get()) {
          return Err(type_error("editor.hooks.beforeChange is not iterable"));
        }
        let mut i = 0;
        while i < js::array_length(hooks.get()) {
          let hook = js::get_element(hooks.get(), i)?;
          i += 1;
          let field_label_path =
            call_host(&ch.label_editor, &[t.field_label_path.get(), field_js.get(), req()])?;
          let previous_value = rt::get(t.sibling_doc.get(), name())?;
          let value = rt::get(sd(), name())?;
          let args = call_host(
            &ch.editor_hook_args,
            &[
              ctx.collection.get(),
              ctx.context.get(),
              ctx.data.get(),
              ctx.doc_with_locales.get(),
              ctx.errors.get(),
              field_js.get(),
              field_label_path,
              ctx.global.get(),
              index_path_segments.get(),
              ctx.merge_locale_actions.get(),
              ctx.operation.get(),
              ctx.doc.get(),
              ctx.override_access.get(),
              t.parent_is_localized.get(),
              path_segments.get(),
              t.sibling_doc.get(),
              previous_value,
              req(),
              schema_path_segments.get(),
              sd(),
              t.sibling_doc_with_locales.get(),
              skip_validation_from_here.get(),
              value,
            ],
          )?;
          let result = call_fn("hook", hook, js::undefined(), &[args])?;
          let hooked_value = await_maybe(result).await?;
          if !hooked_value.is_undefined() {
            rt::set(sd(), name(), hooked_value.get())?;
          }
        }
      }
    }

    Kind::Tab => {
      let is_named_tab = f.has_name;
      let (sibling_data, sibling_doc, sibling_doc_with_locales) = if is_named_tab {
        ensure_object(t.sibling_data.get(), name())?;
        ensure_object(t.sibling_doc.get(), name())?;
        ensure_object(t.sibling_doc_with_locales.get(), name())?;
        (
          Val::from_local(rt::get(t.sibling_data.get(), name())?)?,
          Val::from_local(rt::get(t.sibling_doc.get(), name())?)?,
          Val::from_local(rt::get(t.sibling_doc_with_locales.get(), name())?)?,
        )
      } else {
        (t.sibling_data.clone(), t.sibling_doc.clone(), t.sibling_doc_with_locales.clone())
      };
      let field_label_path = call_host(&ch.label_tab, &[t.field_label_path.get(), field_js.get(), req()])?;
      let p = traverse_or_inline(
        &ctx,
        Trav {
          block_data: t.block_data.clone(),
          block_fields: t.block_fields.clone(),
          field_label_path: Val::from_local(field_label_path)?,
          fields: f.children()?,
          tab_fields: None,
          parent_index_path: if is_named_tab { "".into() } else { Rc::from(index_path.as_str()) },
          parent_is_localized: parent_is_localized_or_field(),
          parent_path: if is_named_tab { Rc::from(path.as_str()) } else { t.parent_path.clone() },
          parent_schema_path: Rc::from(schema_path.as_str()),
          sibling_data,
          sibling_doc,
          sibling_doc_with_locales,
          skip_validation: skip_validation_from_here.clone(),
        },
      )?;
      return Ok(Tail::Await(p, Val::Undefined));
    }

    Kind::Tabs => {
      let field_label_path = call_host(&ch.label_tabs, &[t.field_label_path.get(), field_js.get(), req()])?;
      let tabs = rt::get_named(field_js.get(), "tabs")?;
      let tab_fields = call_host(&rh.tabs_as_fields, &[tabs])?;
      let p = traverse_or_inline(
        &ctx,
        Trav {
          block_data: t.block_data.clone(),
          block_fields: t.block_fields.clone(),
          field_label_path: Val::from_local(field_label_path)?,
          fields: f.tabs()?,
          tab_fields: Some(Val::from_local(tab_fields)?),
          parent_index_path: Rc::from(index_path.as_str()),
          parent_is_localized: t.parent_is_localized.clone(),
          parent_path: Rc::from(path.as_str()),
          parent_schema_path: Rc::from(schema_path.as_str()),
          sibling_data: t.sibling_data.clone(),
          sibling_doc: t.sibling_doc.clone(),
          sibling_doc_with_locales: t.sibling_doc_with_locales.clone(),
          skip_validation: skip_validation_from_here.clone(),
        },
      )?;
      return Ok(Tail::Await(p, Val::Undefined));
    }

    _ => {}
  }

  Ok(Tail::Return(Val::Undefined))
}

/// `traverseFields(...)` called from `promise`. The `mutant-inline-traverse` build runs the
/// traversal's synchronous part inline and returns `Promise.all` of its field promises, which
/// drops the traversal's own async boundary (a deliberately wrong port for the mutation tests).
fn traverse_or_inline(ctx: &Rc<Ctx>, trav: Trav) -> JsResult<Local> {
  if cfg!(feature = "mutant-inline-traverse") && trav.fields.items.is_some() {
    let trav = Rc::new(trav);
    let promises = js::array();
    for (index, desc) in trav.fields.items.iter().flatten().enumerate() {
      let field_js = match &trav.tab_fields {
        Some(arr) => Val::from_local(js::get_element(arr.get(), index as u32)?)?,
        None => Val::Ref(desc.node.clone()),
      };
      js::push(promises, spawn_tail(field_promise(ctx.clone(), trav.clone(), desc.clone(), field_js, index))?)?;
    }
    return call_host(&rt::host()?.promise_all, &[promises]);
  }
  traverse(ctx, trav)
}

/// `await value`. The `mutant-skip-sync-await` build skips the await for non-thenables (one
/// microtask less per sync hook/validator, a deliberately wrong port).
async fn await_maybe(value: Local) -> JsResult<Val> {
  if cfg!(feature = "mutant-skip-sync-await") && !is_typeof_object(value) && js::type_of(value) != Type::Function {
    return Val::from_local(value);
  }
  await_js(value).await
}

/// `if (typeof o[name] !== 'object') o[name] = {}`
fn ensure_object(o: Local, name: Local) -> JsResult<()> {
  if !is_typeof_object(rt::get(o, name)?) {
    rt::set(o, name, js::object())?;
  }
  Ok(())
}

/// `req.t(key)` (a method call: `this === req`).
fn req_t(req: Local, key: &str) -> JsResult<Local> {
  let t = rt::get_named(req, "t")?;
  call_fn("req.t", t, req, &[js::string(key)])
}

/// The block a row resolves to. `desc` is the cached descriptor when the block is an object.
struct FoundBlock {
  node: Val,
  desc: Option<Rc<config::BlockDesc>>,
}

impl FoundBlock {
  /// `` `${block.slug}` ``
  fn slug_str(&self) -> JsResult<String> {
    if let Some(desc) = &self.desc {
      return Ok(desc.slug_str.clone());
    }
    let slug = rt::get_named(self.node.get(), "slug")?;
    Ok(match js::type_of(slug) {
      Type::String => js::get_string(slug).unwrap_or_default(),
      Type::Undefined => "undefined".into(),
      Type::Null => "null".into(),
      Type::Boolean => js::get_bool(slug).to_string(),
      Type::Number => format_number(js::get_f64(slug)),
      _ => String::new(),
    })
  }
}

/// `req.payload.blocks[blockTypeToMatch] ?? field.blocks.find((b) => typeof b !== 'string' && b.slug === blockTypeToMatch)`
fn find_block(ctx: &Ctx, f: &FieldDesc, block_type: Local) -> JsResult<Option<FoundBlock>> {
  let blocks = rt::get_named(rt::get_named(ctx.req.get(), "payload")?, "blocks")?;
  let found = rt::get(blocks, block_type)?;
  if !is_nullish(found) {
    let desc = if js::type_of(found).is_object_like() { Some(config::block_desc(found)?) } else { None };
    return Ok(Some(FoundBlock { node: Val::from_local(found)?, desc }));
  }
  for candidate in f.blocks()?.iter() {
    if let BlockCandidate::Block(b) = candidate {
      if js::strict_equals(b.slug.get(), block_type) {
        return Ok(Some(FoundBlock { node: Val::from_local(b.node.get())?, desc: Some(b.clone()) }));
      }
    }
  }
  Ok(None)
}

/// Port of `getExistingRowDoc(incomingRow, existingRows)`.
fn get_existing_row_doc(incoming_row: Local, existing_rows: Local) -> JsResult<Local> {
  if js::truthy(rt::get_named(incoming_row, "id")?) && js::is_array(existing_rows) {
    // existingRows.find(...): length read once, holes visited as undefined.
    let len = js::array_length(existing_rows);
    for k in 0..len {
      let existing_row = js::get_element(existing_rows, k)?;
      if is_typeof_object(existing_row) && in_op(js::key("id"), existing_row)? {
        let existing_id = rt::get_named(existing_row, "id")?;
        let incoming_id = rt::get_named(incoming_row, "id")?;
        if js::strict_equals(existing_id, incoming_id) {
          // the callback returns `existingRow` (an object, so `find` stops here)
          return Ok(existing_row);
        }
      }
    }
  }
  Ok(js::object())
}

/// Port of `hasInvalidFieldValueShape({ field, value })`.
fn has_invalid_field_value_shape(field: Local, f: &FieldDesc, value: Local) -> JsResult<bool> {
  let value_type = js::type_of(value);
  if matches!(value_type, Type::Undefined | Type::Null) || !f.affects_data {
    return Ok(false);
  }
  let is_type = |name: &str| -> JsResult<bool> { Ok(js::str_equals(rt::get_named(field, "type")?, name)) };

  if is_type("array")? || is_type("blocks")? {
    return Ok(!(js::is_array(value) || value_type == Type::Number));
  }

  if is_type("number")? {
    return Ok(value_type.is_typeof_object()
      && !(js::truthy(rt::get_named(field, "hasMany")?) && js::is_array(value)));
  }

  if (is_type("relationship")? || is_type("upload")?) && js::truthy(rt::get_named(field, "hasMany")?) {
    if !value_type.is_typeof_object() || js::is_array(value) {
      return Ok(false);
    }
    let is_single_polymorphic_relationship_value = js::is_array(rt::get_named(field, "relationTo")?)
      && {
        let proto = get_prototype(value)?;
        js::type_of(proto) == Type::Null || js::strict_equals(proto, change_host()?.object_prototype.get())
      }
      && has_own(value, "relationTo")?
      && has_own(value, "value")?
      && own_keys_count(value)? == 2
      && js::type_of(rt::get_named(value, "relationTo")?) == Type::String
      && {
        // field.relationTo.includes(relationshipValue.relationTo)
        let relation_to = rt::get_named(field, "relationTo")?;
        let needle = rt::get_named(value, "relationTo")?;
        let len = js::array_length(relation_to);
        let mut found = false;
        for i in 0..len {
          if js::strict_equals(js::get_element(relation_to, i)?, needle) {
            found = true;
            break;
          }
        }
        found
      }
      && matches!(js::type_of(rt::get_named(value, "value")?), Type::String | Type::Number);
    return Ok(!is_single_polymorphic_relationship_value);
  }

  Ok(false)
}

/// `Object.getPrototypeOf(o)` (objects only).
fn get_prototype(o: Local) -> JsResult<Local> {
  let mut out = ptr::null_mut();
  js::check(unsafe { sys::napi_get_prototype(js::env(), o.0, &mut out) })?;
  Ok(Local(out))
}

/// `Object.hasOwn(o, key)` (objects only).
fn has_own(o: Local, key: &str) -> JsResult<bool> {
  let mut r = false;
  js::check(unsafe { sys::napi_has_own_property(js::env(), o.0, js::key(key).0, &mut r) })?;
  Ok(r)
}

/// `Reflect.ownKeys(o).length` (objects only).
fn own_keys_count(o: Local) -> JsResult<u32> {
  let mut keys = ptr::null_mut();
  js::check(unsafe {
    sys::napi_get_all_property_names(
      js::env(),
      o.0,
      sys::KeyCollectionMode::own_only,
      sys::KeyFilter::all_properties,
      sys::KeyConversion::keep_numbers,
      &mut keys,
    )
  })?;
  Ok(js::array_length(Local(keys)))
}

/// `arr.forEach((item, index) => ...)` on a JS array: length fixed up front, holes skipped.
fn for_each(arr: Local, mut f: impl FnMut(Local, u32) -> JsResult<()>) -> JsResult<()> {
  let arr = Val::from_local(arr)?;
  let len = js::array_length(arr.get());
  for i in 0..len {
    let a = arr.get();
    let mut has = false;
    js::check(unsafe { sys::napi_has_element(js::env(), a.0, i, &mut has) })?;
    if has {
      let item = js::get_element(a, i)?;
      f(item, i)?;
    }
  }
  Ok(())
}

/// State of one `mergeLocaleActions` closure of `promise.ts`.
pub struct MergeLocaleState {
  sibling_data: Val,
  name: Val,
  sibling_doc_with_locales: Val,
  req: Val,
  localization: Val,
}

unsafe extern "C" fn finalize_state(env: sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
  js::set_env(env);
  drop(unsafe { Box::from_raw(data as *mut MergeLocaleState) });
}

/// Creates the `() => { ... }` merge-locale closure: a JS arrow (host) over an External that owns
/// the captured state; calling it runs [`run_merge_locale_action`].
fn merge_locale_action(state: MergeLocaleState) -> JsResult<Local> {
  let data = Box::into_raw(Box::new(state)) as *mut c_void;
  let mut external = ptr::null_mut();
  let status =
    unsafe { sys::napi_create_external(js::env(), data, Some(finalize_state), ptr::null_mut(), &mut external) };
  if status != sys::Status::napi_ok {
    drop(unsafe { Box::from_raw(data as *mut MergeLocaleState) });
    js::check(status)?;
  }
  call_host(&change_host()?.merge_locale_action, &[Local(external)])
}

/// Body of the merge-locale closure (called through the binding with the External).
pub fn run_merge_locale_action(external: Local) -> JsResult<()> {
  if js::type_of(external) != Type::External {
    return Err(type_error("invalid merge locale action state"));
  }
  let mut data: *mut c_void = ptr::null_mut();
  js::check(unsafe { sys::napi_get_value_external(js::env(), external.0, &mut data) })?;
  let state = unsafe { &*(data as *const MergeLocaleState) };

  let local_data = js::object();
  let sibling_data = state.sibling_data.get();
  let name = state.name.get();
  let req = state.req.get();

  let submitted_value = Val::from_local(rt::get(sibling_data, name)?)?;
  let is_all_locales = js::str_equals(rt::get_named(req, "locale")?, "all") && {
    let v = submitted_value.get();
    js::type_of(v) != Type::Null && is_typeof_object(v) && !js::is_array(v)
  };

  let locale_codes = Val::from_local(rt::get_named(state.localization.get(), "localeCodes")?)?;
  if !js::is_array(locale_codes.get()) {
    return Err(type_error("localization.localeCodes is not iterable"));
  }
  let mut i = 0;
  while i < js::array_length(locale_codes.get()) {
    let locale = js::get_element(locale_codes.get(), i)?;
    i += 1;
    let existing_value = rt::get_optional(
      rt::get_optional(state.sibling_doc_with_locales.get(), name)?,
      locale,
    )?;
    let field_value = if is_all_locales {
      if in_op(locale, submitted_value.get())? { rt::get(submitted_value.get(), locale)? } else { existing_value }
    } else if js::strict_equals(locale, rt::get_named(req, "locale")?) {
      submitted_value.get()
    } else {
      existing_value
    };
    if js::type_of(field_value) != Type::Undefined {
      rt::set(local_data, locale, field_value)?;
    }
  }

  if js::array_length(js::own_keys(local_data)?) > 0 {
    rt::set(sibling_data, name, local_data)?;
  }
  Ok(())
}
