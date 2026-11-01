//! Port of `packages/payload/src/fields/hooks/beforeValidate/{index,traverseFields,promise,getFallbackValue}.ts`
//! and `fields/getDefaultValue.ts`.
//!
//! Porting rules (RUST_CORE_DESIGN.md): one Rust `async fn` per TS `async` function, called
//! through [`spawn`] where TS calls it and awaited with [`await_js`] exactly where TS awaits;
//! concurrency only through JS `Promise.all` over task promises in the same order; every
//! JS-observable read/write/delete/call in the TS order; no `Local` across an await.

use std::cell::OnceCell;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::config::{self, BlockCandidate, BlockDesc, FieldDesc, FieldsDesc, Kind, format_number};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::host::{self, call_host, host};
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Type, Val};

use crate::bv_host;

/// Mutation-testing switch (feature `mutants`, env `PAYLOAD_BV_MUTANT`); always false otherwise.
#[cfg(feature = "mutants")]
fn mutant(id: &str) -> bool {
  thread_local! {
    static SELECTED: String = std::env::var("PAYLOAD_BV_MUTANT").unwrap_or_default();
  }
  SELECTED.with(|s| s == id)
}

#[cfg(not(feature = "mutants"))]
#[inline(always)]
fn mutant(_id: &str) -> bool {
  false
}

/// The arguments that are the same for every `traverseFields`/`promise` call of one run.
struct Ctx {
  /// `[id, collection, context, data, doc, global, onFieldAccess, operation, overrideAccess, req]`
  /// for the host's `beforeValidateLeaves` (indices `C_*` in
  /// packages/engine-rs/src/runtime/beforeValidate/index.ts).
  arr: Val,
  id: Val,
  collection: Val,
  context: Val,
  data: Val,
  doc: Val,
  global: Val,
  on_field_access: Val,
  operation: Val,
  override_access: Val,
  req: Val,
}

/// Arguments of one `traverseFields` call that differ between calls.
struct Trav {
  block_data: Val,
  /// Only the top-level call receives `docForHooks`; nested calls pass `undefined`.
  doc_for_hooks: Val,
  fields: Rc<FieldsDesc>,
  /// For `tabs`: the `field.tabs.map((tab) => ({ ...tab, type: 'tab' }))` array (the `field`
  /// objects and `siblingFields`).
  tab_fields: Option<Val>,
  parent_index_path: Rc<str>,
  parent_is_localized: Val,
  parent_path: Rc<str>,
  parent_schema_path: Rc<str>,
  sibling_data: Val,
  sibling_doc: Val,
}

impl Trav {
  fn sibling_fields(&self) -> Local {
    match &self.tab_fields {
      Some(v) => v.get(),
      None => self.fields.node.get(),
    }
  }
}

impl Ctx {
  #[allow(clippy::too_many_arguments)]
  fn new(
    id: Val,
    collection: Val,
    context: Val,
    data: Val,
    doc: Val,
    global: Val,
    on_field_access: Val,
    operation: Val,
    override_access: Val,
    req: Val,
  ) -> JsResult<Ctx> {
    let arr = js::array();
    let values = [&id, &collection, &context, &data, &doc, &global, &on_field_access, &operation, &override_access, &req];
    for (i, v) in values.into_iter().enumerate() {
      js::set_element(arr, i as u32, v.get())?;
    }
    Ok(Ctx {
      arr: Val::from_local(arr)?,
      id,
      collection,
      context,
      data,
      doc,
      global,
      on_field_access,
      operation,
      override_access,
      req,
    })
  }
}

/// A field whose `promise()` traverses no subfields and calls no editor hooks: the host runs it
/// (`beforeValidateLeaves`, upstream's `promise.ts` body for such a field).
fn is_leaf(kind: Kind) -> bool {
  !matches!(
    kind,
    Kind::Array | Kind::Blocks | Kind::Collapsible | Kind::Group | Kind::RichText | Kind::Row | Kind::Tab | Kind::Tabs
  )
}

/// `beforeValidate(args)` (index.ts): returns the promise of `args.data` (same identity).
pub fn before_validate(args: Local) -> JsResult<Local> {
  let args = Val::from_local(args)?;
  spawn(async move {
    // Destructuring of the async function's parameter (a throw here is a rejection).
    let a = args.get();
    let g = |name: &str| -> JsResult<Val> { Val::from_local(host::get_named(a, name)?) };
    let id = g("id")?;
    let collection = g("collection")?;
    let context = g("context")?;
    let data = g("data")?;
    let doc = g("doc")?;
    let doc_for_hooks = g("docForHooks")?;
    let global = g("global")?;
    let on_field_access = g("onFieldAccess")?;
    let operation = g("operation")?;
    let override_access = g("overrideAccess")?;
    let req = g("req")?;

    // (collection?.fields || global?.fields)!
    let collection_fields = host::get_optional(collection.get(), js::key("fields"))?;
    let fields = if js::truthy(collection_fields) {
      collection_fields
    } else {
      host::get_optional(global.get(), js::key("fields"))?
    };
    let ctx = Rc::new(Ctx::new(
      id,
      collection,
      context,
      data.clone(),
      doc.clone(),
      global,
      on_field_access,
      operation,
      override_access,
      req,
    )?);
    let trav = Rc::new(Trav {
      block_data: Val::Undefined,
      doc_for_hooks,
      fields: config::fields_desc(fields)?,
      tab_fields: None,
      parent_index_path: "".into(),
      parent_is_localized: Val::Bool(false),
      parent_path: "".into(),
      parent_schema_path: "".into(),
      sibling_data: data.clone(),
      sibling_doc: doc,
    });
    let p = spawn(traverse_fields(ctx, trav))?;
    await_js(p).await?;
    Ok(data)
  })
}

/// `traverseFields(args)` (traverseFields.ts, exported by payload as `beforeValidateTraverseFields`).
pub fn traverse_fields_entry(args: Local) -> JsResult<Local> {
  let args = Val::from_local(args)?;
  spawn(async move {
    let a = args.get();
    let g = |name: &str| -> JsResult<Val> { Val::from_local(host::get_named(a, name)?) };
    let s = |name: &str| -> JsResult<Rc<str>> { Ok(js_string_arg(host::get_named(a, name)?).into()) };
    let id = g("id")?;
    let block_data = g("blockData")?;
    let collection = g("collection")?;
    let context = g("context")?;
    let data = g("data")?;
    let doc = g("doc")?;
    let doc_for_hooks = g("docForHooks")?;
    let fields = host::get_named(a, "fields")?;
    let fields = config::fields_desc(fields)?;
    let global = g("global")?;
    let on_field_access = g("onFieldAccess")?;
    let operation = g("operation")?;
    let override_access = g("overrideAccess")?;
    let parent_index_path = s("parentIndexPath")?;
    let parent_is_localized = g("parentIsLocalized")?;
    let parent_path = s("parentPath")?;
    let parent_schema_path = s("parentSchemaPath")?;
    let req = g("req")?;
    let sibling_data = g("siblingData")?;
    let sibling_doc = g("siblingDoc")?;
    let ctx = Rc::new(Ctx::new(
      id,
      collection,
      context,
      data,
      doc,
      global,
      on_field_access,
      operation,
      override_access,
      req,
    )?);
    let trav = Rc::new(Trav {
      block_data,
      doc_for_hooks,
      fields,
      tab_fields: None,
      parent_index_path,
      parent_is_localized,
      parent_path,
      parent_schema_path,
      sibling_data,
      sibling_doc,
    });
    traverse_fields(ctx, trav).await
  })
}

/// `String(v)` for the string path arguments of the `traverseFields` entry.
fn js_string_arg(v: Local) -> String {
  match js::type_of(v) {
    Type::String => js::get_string(v).unwrap_or_default(),
    Type::Undefined => "undefined".into(),
    Type::Null => "null".into(),
    Type::Number => format_number(js::get_f64(v)),
    Type::Boolean => js::get_bool(v).to_string(),
    _ => String::new(),
  }
}

/// Port of `traverseFields.ts` (an async function).
async fn traverse_fields(ctx: Rc<Ctx>, t: Rc<Trav>) -> JsResult<Val> {
  let h = host()?;
  let bh = bv_host()?;
  call_host(&bh.unflatten_data, &[t.sibling_data.get()])?;

  let Some(items) = &t.fields.items else {
    config::throw_not_array(&t.fields)?;
    return Ok(Val::Undefined);
  };
  let promises = js::array();
  let mut order: Vec<(usize, &Rc<FieldDesc>)> = items.iter().enumerate().collect();
  if mutant("M3") {
    order.reverse();
  } else if t.tab_fields.is_none() && items.iter().any(|f| is_leaf(f.kind)) {
    // Runs of leaves go to the host in one call each (upstream's `promise()` per field, pushed
    // in order); other fields are ported tasks.
    let mut index = 0;
    while index < items.len() {
      if !is_leaf(items[index].kind) {
        let desc = &items[index];
        let promise = spawn(field_promise(ctx.clone(), t.clone(), desc.clone(), Val::Ref(desc.node.clone()), index))?;
        js::push(promises, promise)?;
        index += 1;
        continue;
      }
      let start = index;
      while index < items.len() && is_leaf(items[index].kind) {
        index += 1;
      }
      call_host(
        &bh.before_validate_leaves,
        &[
          ctx.arr.get(),
          t.fields.node.get(),
          js::number(start as f64),
          js::number(index as f64),
          promises,
          t.block_data.get(),
          t.doc_for_hooks.get(),
          js::string(&t.parent_index_path),
          js::string(&t.parent_path),
          js::string(&t.parent_schema_path),
          t.sibling_data.get(),
          t.sibling_doc.get(),
        ],
      )?;
    }
    order.clear();
  }
  for (index, desc) in order {
    let field_js = match &t.tab_fields {
      Some(arr) => Val::from_local(js::get_element(arr.get(), index as u32)?)?,
      None => Val::Ref(desc.node.clone()),
    };
    let promise = spawn(field_promise(ctx.clone(), t.clone(), desc.clone(), field_js, index))?;
    js::push(promises, promise)?;
  }
  let all = call_host(&h.promise_all, &[promises])?;
  await_js(all).await?;
  Ok(Val::Undefined)
}

struct Paths {
  index_path: String,
  path: String,
  schema_path: String,
}

/// Port of `getFieldPaths`.
fn get_field_paths(field: &FieldDesc, index: usize, parent_index_path: &str, parent_path: &str, parent_schema_path: &str) -> Paths {
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

/// `pathSegments` / `schemaPathSegments` / `indexPathSegments`: one array each per `promise()`
/// call, shared by every hook call of that field (field hooks and rich text editor hooks).
struct Segments {
  path: OnceCell<Val>,
  schema_path: OnceCell<Val>,
  index_path: OnceCell<Val>,
}

fn segment(cell: &OnceCell<Val>, make: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  if let Some(v) = cell.get() {
    return Ok(v.get());
  }
  let v = make()?;
  let _ = cell.set(Val::from_local(v)?);
  Ok(v)
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

fn is_undefined(v: Local) -> bool {
  js::type_of(v) == Type::Undefined
}

/// `v === true`
fn is_true(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && js::get_bool(v)
}

/// `a || b` on JS values.
fn or(a: &Val, b: &Val) -> Val {
  if js::truthy(a.get()) { a.clone() } else { b.clone() }
}

/// `typeof v === 'object' && v && key in v` (the `'id' in value` / `'relationTo' in value` guards).
fn is_object_with(v: Local, key: &str) -> JsResult<bool> {
  if js::type_of(v) != Type::Object {
    return Ok(false);
  }
  js::has_property(v, js::key(key))
}

/// `'key' in o` for config objects (fields).
fn has_key(o: Local, key: &str) -> JsResult<bool> {
  if js::type_of(o).is_object_like() { js::has_property(o, js::key(key)) } else { Ok(false) }
}

/// `req.context?.isRestoringVersion` (truthiness).
fn is_restoring_version(req: &Val) -> JsResult<bool> {
  let context = host::get_named(req.get(), "context")?;
  Ok(js::truthy(host::get_optional(context, js::key("isRestoringVersion"))?))
}

/// Port of `promise.ts`.
async fn field_promise(ctx: Rc<Ctx>, t: Rc<Trav>, f: Rc<FieldDesc>, field_js: Val, field_index: usize) -> JsResult<Val> {
  let h = host()?;
  let bh = bv_host()?;
  let Paths { index_path, path, schema_path } =
    get_field_paths(&f, field_index, &t.parent_index_path, &t.parent_path, &t.parent_schema_path);
  let segments = Segments { path: OnceCell::new(), schema_path: OnceCell::new(), index_path: OnceCell::new() };

  let is_status_policy = path == "_status" && js::truthy(t.doc_for_hooks.get());
  let policy_doc = if is_status_policy { t.doc_for_hooks.clone() } else { ctx.doc.clone() };
  let policy_sibling_doc = if is_status_policy { t.doc_for_hooks.clone() } else { t.sibling_doc.clone() };

  let field_type = js::get_string(host::get_named(field_js.get(), "type")?).unwrap_or_default();
  let name = || f.name.get();
  let sd = || t.sibling_data.get();
  // `siblingData[field.name]`, re-read at every place the TS reads it.
  let read = || host::get(t.sibling_data.get(), f.name.get());
  let write = |v: Local| host::set(t.sibling_data.get(), f.name.get(), v);

  if f.affects_data {
    if js::str_equals(name(), "id") {
      if field_type == "number" && js::type_of(read()?) == Type::String {
        let value = read()?;
        write(call_host(&bh.parse_float, &[value])?)?;
      }

      if field_type == "text"
        && js::type_of(host::get_optional(read()?, js::key("toString"))?) == Type::Function
        && js::type_of(read()?) != Type::String
      {
        let value = read()?;
        let to_string = host::get(value, js::key("toString"))?;
        write(js::call(to_string, value, &[])?)?;
      }
    }

    // Sanitize incoming data
    match field_type.as_str() {
      "array" | "blocks" => {
        if js::str_equals(read()?, "0") || js::strict_equals(read()?, js::number(0.0)) {
          write(js::array())?;
        }
      }
      "checkbox" => {
        if js::str_equals(read()?, "true") {
          write(js::boolean(true))?;
        }
        if js::str_equals(read()?, "false") {
          write(js::boolean(false))?;
        }
        if js::str_equals(read()?, "") {
          write(js::boolean(false))?;
        }
      }
      "number" => {
        if js::type_of(read()?) == Type::String {
          let value = read()?;
          let trimmed = if mutant("M6") {
            js::string(js::get_string(value).unwrap_or_default().trim())
          } else {
            call_host(&bh.trim, &[value])?
          };
          let empty = if mutant("M9") { js::undefined() } else { js::null() };
          write(if string_is_empty(trimmed)? { empty } else { call_host(&bh.parse_float, &[trimmed])? })?;
        }
      }
      "point" => {
        if js::is_array(read()?) {
          let source = read()?;
          let mapped = map_array(source, |coordinate, i| {
            if js::type_of(coordinate) == Type::String {
              let value = host::get(read()?, js::number(i as f64))?;
              let trimmed = call_host(&bh.trim, &[value])?;
              return if string_is_empty(trimmed)? { Ok(js::null()) } else { call_host(&bh.parse_float, &[trimmed]) };
            }
            Ok(coordinate)
          })?;
          write(mapped)?;
        }
      }
      "relationship" | "upload" => sanitize_relationship(&ctx, &t, &f, &field_js)?,
      "richText" => {
        if js::type_of(read()?) == Type::String {
          // try { siblingData[field.name] = JSON.parse(siblingData[field.name]) } catch {}
          let attempt = (|| -> JsResult<()> {
            let rich_text_json = call_host(&bh.json_parse, &[read()?])?;
            write(rich_text_json)
          })();
          drop(attempt);
        }
      }
      _ => {}
    }

    // ensure the fallback value is only computed one time
    let mut fallback_executed = false;
    let mut fallback_value = Val::Undefined;
    if is_undefined(read()?) && !is_restoring_version(&ctx.req)? {
      fallback_value = if mutant("M2") {
        get_fallback_value(field_js.clone(), Val::Undefined, ctx.req.clone(), t.sibling_doc.clone()).await?
      } else {
        let p = spawn(get_fallback_value(field_js.clone(), Val::Undefined, ctx.req.clone(), t.sibling_doc.clone()))?;
        await_js(p).await?
      };
      fallback_executed = true;
    }

    // Execute hooks
    if has_key(field_js.get(), "hooks")?
      && js::truthy(host::get_optional(host::get_named(field_js.get(), "hooks")?, js::key("beforeValidate"))?)
    {
      let hooks = Val::from_local(host::get_named(host::get_named(field_js.get(), "hooks")?, "beforeValidate")?)?;
      let mut i = 0;
      while i < js::array_length(hooks.get()) {
        let hook = js::get_element(hooks.get(), i)?;
        i += 1;
        let previous_value =
          host::get(if mutant("M12") { t.sibling_doc.get() } else { policy_sibling_doc.get() }, name())?;
        let value = if is_undefined(read()?) { fallback_value.get() } else { read()? };
        let args = call_host(
          &bh.hook_args,
          &[
            t.block_data.get(),
            ctx.collection.get(),
            ctx.context.get(),
            ctx.data.get(),
            field_js.get(),
            ctx.global.get(),
            segment(&segments.index_path, || index_segments(&index_path))?,
            ctx.operation.get(),
            policy_doc.get(),
            ctx.override_access.get(),
            segment(&segments.path, || split_array(&path, '.'))?,
            policy_sibling_doc.get(),
            previous_value,
            ctx.req.get(),
            segment(&segments.schema_path, || split_array(&schema_path, '.'))?,
            sd(),
            t.sibling_fields(),
            value,
          ],
        )?;
        let result = js::call(hook, js::undefined(), &[args])?;
        let hooked_value = if mutant("M1") && js::type_of(result) != Type::Object {
          Val::from_local(result)?
        } else {
          await_js(result).await?
        };
        if !hooked_value.is_undefined() {
          write(hooked_value.get())?;
        }
      }
    }

    let mut access_result = Val::Bool(true);

    // Execute access control
    let access = host::get_named(field_js.get(), "access")?;
    if js::truthy(access) && js::truthy(host::get(access, ctx.operation.get())?) {
      access_result = if js::truthy(ctx.override_access.get()) {
        Val::Bool(true)
      } else {
        let access = host::get_named(field_js.get(), "access")?;
        let access_fn = host::get(access, ctx.operation.get())?;
        let args = if js::truthy(ctx.collection.get()) {
          object(&[
            ("id", ctx.id.get()),
            ("blockData", t.block_data.get()),
            ("collection", ctx.collection.get()),
            ("data", ctx.data.get()),
            ("doc", policy_doc.get()),
            ("req", ctx.req.get()),
            ("siblingData", sd()),
          ])?
        } else {
          object(&[
            ("id", ctx.id.get()),
            ("blockData", t.block_data.get()),
            ("data", ctx.data.get()),
            ("doc", policy_doc.get()),
            ("global", ctx.global.get()),
            ("req", ctx.req.get()),
            ("siblingData", sd()),
          ])?
        };
        let this = if mutant("M5") { js::undefined() } else { access };
        let result = js::call(access_fn, this, &[args])?;
        await_js(result).await?
      };

      if !js::truthy(access_result.get()) {
        host::del(sd(), name())?;
      }
    }

    // onFieldAccess?.({ accessResult, path })
    let on_field_access = ctx.on_field_access.get();
    if !is_nullish(on_field_access) {
      let access_result = if mutant("M11") { js::boolean(js::truthy(access_result.get())) } else { access_result.get() };
      let args = object(&[("accessResult", access_result), ("path", js::string(&path))])?;
      js::call(on_field_access, js::undefined(), &[args])?;
    }

    if is_undefined(read()?) && !is_restoring_version(&ctx.req)? {
      // operation === 'update' || operation === 'validate' || accessResult
      let is_document_value_allowed =
        if js::str_equals(ctx.operation.get(), "update") || js::str_equals(ctx.operation.get(), "validate") {
          Val::Bool(true)
        } else {
          access_result.clone()
        };
      let value = if !fallback_executed || !js::truthy(is_document_value_allowed.get()) {
        let p = spawn(get_fallback_value(
          field_js.clone(),
          is_document_value_allowed,
          ctx.req.clone(),
          t.sibling_doc.clone(),
        ))?;
        await_js(p).await?
      } else {
        fallback_value.clone()
      };
      write(value.get())?;
    }
  }

  // Traverse subfields
  match field_type.as_str() {
    "array" => {
      let rows = read()?;
      if js::is_array(rows) {
        let logger = host::get_named(host::get_named(ctx.req.get(), "payload")?, "logger")?;
        let filtered_rows =
          call_host(&bh.strip_null_rows, &[rows, js::string("array"), name(), logger, sd()])?;
        let promises = js::array();
        for_each(filtered_rows, |row, row_index| {
          let fields = f.children()?;
          let sibling_doc = call_host(&bh.get_existing_row_doc, &[row, host::get(t.sibling_doc.get(), name())?])?;
          let promise = spawn(traverse_fields(
            ctx.clone(),
            Rc::new(Trav {
              block_data: t.block_data.clone(),
              doc_for_hooks: Val::Undefined,
              fields,
              tab_fields: None,
              parent_index_path: "".into(),
              parent_is_localized: or(&t.parent_is_localized, &f.localized),
              parent_path: format!("{path}.{row_index}").into(),
              parent_schema_path: Rc::from(schema_path.as_str()),
              sibling_data: Val::from_local(row)?,
              sibling_doc: Val::from_local(sibling_doc)?,
            }),
          ))?;
          js::push(promises, promise)
        })?;
        let all = call_host(&h.promise_all, &[promises])?;
        await_js(all).await?;
      }
    }

    "blocks" => {
      let rows = read()?;
      if js::is_array(rows) {
        let logger = host::get_named(host::get_named(ctx.req.get(), "payload")?, "logger")?;
        let filtered_rows =
          call_host(&bh.strip_null_rows, &[rows, js::string("blocks"), name(), logger, sd()])?;
        let promises = js::array();
        for_each(filtered_rows, |row, row_index| {
          let row_sibling_doc =
            call_host(&bh.get_existing_row_doc, &[row, host::get(t.sibling_doc.get(), name())?])?;
          let row_block_type = host::get_named(row, "blockType")?;
          let block_type_to_match = if js::truthy(row_block_type) {
            row_block_type
          } else {
            host::get_named(row_sibling_doc, "blockType")?
          };
          if let Some(block) = find_block(&ctx, &f, block_type_to_match)? {
            if !mutant("M10") {
              host::set(row, js::key("blockType"), block_type_to_match)?;
            }
            let promise = spawn(traverse_fields(
              ctx.clone(),
              Rc::new(Trav {
                block_data: Val::from_local(row)?,
                doc_for_hooks: Val::Undefined,
                fields: block.fields()?,
                tab_fields: None,
                parent_index_path: "".into(),
                parent_is_localized: or(&t.parent_is_localized, &f.localized),
                parent_path: format!("{path}.{row_index}").into(),
                parent_schema_path: format!("{schema_path}.{}", block.slug_str).into(),
                sibling_data: Val::from_local(row)?,
                sibling_doc: Val::from_local(row_sibling_doc)?,
              }),
            ))?;
            js::push(promises, promise)?;
          }
          Ok(())
        })?;
        let all = call_host(&h.promise_all, &[promises])?;
        await_js(all).await?;
      }
    }

    "collapsible" | "row" => {
      let promise = spawn(traverse_fields(
        ctx.clone(),
        Rc::new(Trav {
          block_data: t.block_data.clone(),
          doc_for_hooks: Val::Undefined,
          fields: f.children()?,
          tab_fields: None,
          parent_index_path: Rc::from(index_path.as_str()),
          parent_is_localized: t.parent_is_localized.clone(),
          parent_path: t.parent_path.clone(),
          parent_schema_path: Rc::from(schema_path.as_str()),
          sibling_data: t.sibling_data.clone(),
          sibling_doc: t.sibling_doc.clone(),
        }),
      ))?;
      await_js(promise).await?;
    }

    // `group` is named when it affects data; a `tab` is named when `'name' in field`.
    "group" | "tab" => {
      let is_named = if field_type == "group" { f.affects_data } else { f.has_name };
      let (sibling_data, sibling_doc) = if is_named {
        if !js::type_of(read()?).is_typeof_object() {
          write(js::object())?;
        }
        if !js::type_of(host::get(t.sibling_doc.get(), name())?).is_typeof_object() {
          if mutant("M8") {
            return finish_group_mutant(ctx.clone(), t.clone(), f.clone(), &path, &schema_path).await;
          }
          host::set(t.sibling_doc.get(), name(), js::object())?;
        }
        (Val::from_local(read()?)?, Val::from_local(host::get(t.sibling_doc.get(), name())?)?)
      } else {
        (t.sibling_data.clone(), t.sibling_doc.clone())
      };
      let promise = spawn(traverse_fields(
        ctx.clone(),
        Rc::new(Trav {
          block_data: t.block_data.clone(),
          doc_for_hooks: Val::Undefined,
          fields: f.children()?,
          tab_fields: None,
          parent_index_path: if is_named { "".into() } else { Rc::from(index_path.as_str()) },
          parent_is_localized: or(&t.parent_is_localized, &f.localized),
          parent_path: if is_named { Rc::from(path.as_str()) } else { t.parent_path.clone() },
          parent_schema_path: Rc::from(schema_path.as_str()),
          sibling_data,
          sibling_doc,
        }),
      ))?;
      await_js(promise).await?;
    }

    "richText" => {
      check_editor(&field_js)?;
      let editor = Val::from_local(host::get_optional(field_js.get(), js::key("editor"))?)?;
      let hooks_obj = host::get_optional(editor.get(), js::key("hooks"))?;
      let before_validate = host::get_optional(hooks_obj, js::key("beforeValidate"))?;
      let length = host::get_optional(before_validate, js::key("length"))?;
      if js::truthy(length) {
        let hooks = Val::from_local(host::get_named(host::get_named(editor.get(), "hooks")?, "beforeValidate")?)?;
        let mut i = 0;
        while i < js::array_length(hooks.get()) {
          let hook = js::get_element(hooks.get(), i)?;
          i += 1;
          let previous_value = read()?;
          let value = read()?;
          let args = call_host(
            &bh.editor_hook_args,
            &[
              ctx.collection.get(),
              ctx.context.get(),
              ctx.data.get(),
              field_js.get(),
              ctx.global.get(),
              segment(&segments.index_path, || index_segments(&index_path))?,
              ctx.operation.get(),
              ctx.doc.get(),
              ctx.override_access.get(),
              t.parent_is_localized.get(),
              segment(&segments.path, || split_array(&path, '.'))?,
              t.sibling_doc.get(),
              previous_value,
              ctx.req.get(),
              segment(&segments.schema_path, || split_array(&schema_path, '.'))?,
              sd(),
              value,
            ],
          )?;
          let result = js::call(hook, js::undefined(), &[args])?;
          let hooked_value = await_js(result).await?;
          if !hooked_value.is_undefined() {
            write(hooked_value.get())?;
          }
        }
      }
    }

    "tabs" => {
      let tabs = host::get_named(field_js.get(), "tabs")?;
      let tab_fields = call_host(&h.tabs_as_fields, &[tabs])?;
      let promise = spawn(traverse_fields(
        ctx.clone(),
        Rc::new(Trav {
          block_data: t.block_data.clone(),
          doc_for_hooks: Val::Undefined,
          fields: f.tabs()?,
          tab_fields: Some(Val::from_local(tab_fields)?),
          parent_index_path: Rc::from(index_path.as_str()),
          parent_is_localized: t.parent_is_localized.clone(),
          parent_path: Rc::from(path.as_str()),
          parent_schema_path: Rc::from(schema_path.as_str()),
          sibling_data: t.sibling_data.clone(),
          sibling_doc: t.sibling_doc.clone(),
        }),
      ))?;
      await_js(promise).await?;
    }

    _ => {}
  }

  Ok(Val::Undefined)
}

/// The `relationship` / `upload` case of the sanitize switch.
fn sanitize_relationship(ctx: &Ctx, t: &Trav, f: &FieldDesc, field_js: &Val) -> JsResult<()> {
  let bh = bv_host()?;
  let read = || host::get(t.sibling_data.get(), f.name.get());
  let write = |v: Local| host::set(t.sibling_data.get(), f.name.get(), v);
  let has_many = || host::get_named(field_js.get(), "hasMany");
  let relation_to = || host::get_named(field_js.get(), "relationTo");

  if js::str_equals(read()?, "")
    || js::str_equals(read()?, "none")
    || js::str_equals(read()?, "null")
    || js::type_of(read()?) == Type::Null
  {
    if is_true(has_many()?) {
      write(js::array())?;
    } else {
      write(js::null())?;
    }
  }

  let value = read()?;

  if js::is_array(relation_to()?) {
    if js::is_array(value) {
      for_each(value, |related_doc, i| {
        let related_collection = collection_config(ctx, || host::get(related_doc, js::key("relationTo")))?;

        if is_object_with(host::get_named(related_doc, "value")?, "id")? {
          let id = host::get_named(host::get_named(related_doc, "value")?, "id")?;
          host::set(related_doc, js::key("value"), id)?;
        }

        if id_field_is_number(related_collection)? {
          let target = read()?;
          let replacement = call_host(&bh.spread_parse_value, &[related_doc])?;
          host::set(target, js::number(i as f64), replacement)?;
        }
        Ok(())
      })?;
    }
    if !is_true(has_many()?) && value_is_value_with_relation(value)? {
      let related_collection = collection_config(ctx, || host::get_named(value, "relationTo"))?;

      if is_object_with(host::get_named(value, "value")?, "id")? {
        let id = host::get_named(host::get_named(value, "value")?, "id")?;
        host::set(value, js::key("value"), id)?;
      }

      if id_field_is_number(related_collection)? {
        write(call_host(&bh.spread_parse_value, &[value])?)?;
      }
    }
  } else {
    if js::is_array(value) {
      for_each(value, |related_doc, i| {
        let rt = relation_to()?;
        let related_collection = if js::is_array(rt) { js::undefined() } else { collection_config(ctx, relation_to)? };

        if is_object_with(related_doc, "id")? {
          host::set(value, js::number(i as f64), host::get_named(related_doc, "id")?)?;
        }

        if id_field_is_number(related_collection)? {
          let target = read()?;
          host::set(target, js::number(i as f64), call_host(&bh.parse_float, &[related_doc])?)?;
        }
        Ok(())
      })?;
    }
    if !is_true(has_many()?) && js::truthy(value) {
      let related_collection = collection_config(ctx, relation_to)?;

      if is_object_with(value, "id")? {
        write(host::get_named(value, "id")?)?;
      }

      if id_field_is_number(related_collection)? {
        write(call_host(&bh.parse_float, &[value])?)?;
      }
    }
  }
  Ok(())
}

/// `req.payload.collections?.[key]?.config` (the key expression is skipped when `collections`
/// is nullish, like optional chaining).
fn collection_config(ctx: &Ctx, key: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  let collections = host::get_named(host::get_named(ctx.req.get(), "payload")?, "collections")?;
  if is_nullish(collections) {
    return Ok(js::undefined());
  }
  let collection = host::get(collections, key()?)?;
  host::get_optional(collection, js::key("config"))
}

/// `relatedCollection?.fields` and then
/// `relatedCollection.fields.find((f) => fieldAffectsData(f) && f.name === 'id')?.type === 'number'`.
fn id_field_is_number(related_collection: Local) -> JsResult<bool> {
  if mutant("M4") {
    return Ok(false);
  }
  let fields = host::get_optional(related_collection, js::key("fields"))?;
  if !js::truthy(fields) {
    return Ok(false);
  }
  let fields = host::get_named(related_collection, "fields")?;
  let len = js::array_length(fields);
  for i in 0..len {
    let field = js::get_element(fields, i)?;
    let affects_data = has_key(field, "name")? && !js::str_equals(host::get_named(field, "type")?, "ui");
    if affects_data && js::str_equals(host::get_named(field, "name")?, "id") {
      return Ok(js::str_equals(host::get_named(field, "type")?, "number"));
    }
  }
  Ok(false)
}

/// `valueIsValueWithRelation(value)`
fn value_is_value_with_relation(v: Local) -> JsResult<bool> {
  if js::type_of(v) != Type::Object {
    return Ok(false);
  }
  Ok(js::has_property(v, js::key("relationTo"))? && js::has_property(v, js::key("value"))?)
}

/// `trimmed.length === 0` for a string.
fn string_is_empty(s: Local) -> JsResult<bool> {
  let len = host::get_named(s, "length")?;
  Ok(js::type_of(len) == Type::Number && js::get_f64(len) == 0.0)
}

/// `field?.editor` checks of the richText traversal.
fn check_editor(field_js: &Val) -> JsResult<()> {
  let editor = host::get_optional(field_js.get(), js::key("editor"))?;
  if !js::truthy(editor) {
    let e = call_host(&host()?.missing_editor_prop, &[field_js.get()])?;
    return Err(Thrown(Val::from_local(e)?));
  }
  if js::type_of(host::get_optional(field_js.get(), js::key("editor"))?) == Type::Function {
    return Err(host::new_error("Attempted to access unsanitized rich text editor.")?);
  }
  Ok(())
}

/// `req.payload.blocks[blockType] ?? field.blocks.find((b) => typeof b !== 'string' && b.slug === blockType)`,
/// then `if (block)`.
fn find_block(ctx: &Ctx, f: &FieldDesc, block_type: Local) -> JsResult<Option<Rc<BlockDesc>>> {
  let blocks = host::get_named(host::get_named(ctx.req.get(), "payload")?, "blocks")?;
  let found = host::get(blocks, block_type)?;
  if !is_nullish(found) {
    return Ok(if js::truthy(found) { Some(config::block_desc(found)?) } else { None });
  }
  for candidate in f.blocks()?.iter() {
    if let BlockCandidate::Block(b) = candidate {
      if js::strict_equals(b.slug.get(), block_type) {
        return Ok(Some(b.clone()));
      }
    }
  }
  Ok(None)
}

/// `arr.forEach((item, index) => ...)` on a JS array: length fixed up front, holes skipped.
fn for_each(arr: Local, mut f: impl FnMut(Local, u32) -> JsResult<()>) -> JsResult<()> {
  let len = js::array_length(arr);
  for i in 0..len {
    if has_element(arr, i)? {
      let item = js::get_element(arr, i)?;
      f(item, i)?;
    }
  }
  Ok(())
}

/// `arr.map((item, index) => ...)` on a JS array: a new array of the same length, holes kept.
fn map_array(arr: Local, mut f: impl FnMut(Local, u32) -> JsResult<Local>) -> JsResult<Local> {
  let len = js::array_length(arr);
  let mut out = std::ptr::null_mut();
  js::check(unsafe { sys::napi_create_array_with_length(js::env(), len as usize, &mut out) })?;
  let out = Local(out);
  for i in 0..len {
    if has_element(arr, i)? {
      let item = js::get_element(arr, i)?;
      let mapped = f(item, i)?;
      js::set_element(out, i, mapped)?;
    }
  }
  Ok(out)
}

fn has_element(arr: Local, i: u32) -> JsResult<bool> {
  let mut has = false;
  js::check(unsafe { sys::napi_has_element(js::env(), arr.0, i, &mut has) })?;
  Ok(has)
}

/// Port of `getFallbackValue.ts` (an async function). `is_document_value_allowed` is the raw
/// argument: `undefined` takes the parameter default (`true`).
async fn get_fallback_value(field: Val, is_document_value_allowed: Val, req: Val, sibling_doc: Val) -> JsResult<Val> {
  let is_document_value_allowed =
    if is_document_value_allowed.is_undefined() { !mutant("M7") } else { js::truthy(is_document_value_allowed.get()) };
  let mut fallback_value = Val::Undefined;
  let fl = field.get();
  if has_key(fl, "name")? && js::truthy(host::get_named(fl, "name")?) {
    let name = host::get_named(fl, "name")?;
    if is_document_value_allowed && !is_undefined(host::get(sibling_doc.get(), name)?) {
      let value = host::get(sibling_doc.get(), name)?;
      fallback_value = Val::from_local(call_host(&bv_host()?.clone_data_from_original_doc, &[value])?)?;
    } else if has_key(fl, "defaultValue")? && !is_undefined(host::get_named(fl, "defaultValue")?) {
      let default_value = Val::from_local(host::get_named(fl, "defaultValue")?)?;
      let r = req.get();
      let locale = host::get_named(r, "locale")?;
      let locale = Val::from_local(if js::truthy(locale) { locale } else { js::string("") })?;
      let user = Val::from_local(host::get_named(r, "user")?)?;
      let p = spawn(get_default_value(default_value, locale, req.clone(), user))?;
      fallback_value = await_js(p).await?;
    }
  }
  Ok(fallback_value)
}

/// Port of `getDefaultValue` (async) as called by `getFallbackValue` (`value` is undefined).
async fn get_default_value(default_value: Val, locale: Val, req: Val, user: Val) -> JsResult<Val> {
  let dv = default_value.get();
  if js::truthy(dv) && js::type_of(dv) == Type::Function {
    let args = object(&[("locale", locale.get()), ("req", req.get()), ("user", user.get())])?;
    let result = js::call(dv, js::undefined(), &[args])?;
    return await_js(result).await;
  }
  if js::type_of(dv).is_typeof_object() {
    return Val::from_local(call_host(&host()?.deep_copy, &[dv])?);
  }
  Ok(default_value)
}

/// Mutant M8: traverses a named group/tab with a fresh `siblingDoc` instead of writing `{}` into
/// the original doc.
async fn finish_group_mutant(ctx: Rc<Ctx>, t: Rc<Trav>, f: Rc<FieldDesc>, path: &str, schema_path: &str) -> JsResult<Val> {
  let sibling_data = Val::from_local(host::get(t.sibling_data.get(), f.name.get())?)?;
  let promise = spawn(traverse_fields(
    ctx.clone(),
    Rc::new(Trav {
      block_data: t.block_data.clone(),
      doc_for_hooks: Val::Undefined,
      fields: f.children()?,
      tab_fields: None,
      parent_index_path: "".into(),
      parent_is_localized: or(&t.parent_is_localized, &f.localized),
      parent_path: Rc::from(path),
      parent_schema_path: Rc::from(schema_path),
      sibling_data,
      sibling_doc: Val::from_local(js::object())?,
    }),
  ))?;
  await_js(promise).await?;
  Ok(Val::Undefined)
}
