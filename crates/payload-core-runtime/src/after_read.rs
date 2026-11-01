//! Port of `packages/payload/src/fields/hooks/afterRead/{index,traverseFields,promise}.ts`.
//!
//! The code mirrors the TS line by line: every JS-observable read/write/delete/call happens in
//! the same order, every `await` is a real JS await ([`await_js`]), every `async` function call
//! is a spawned task with its own native promise ([`spawn`]), and `fieldPromises` /
//! `populationPromises` are the same kind of JS arrays (user hooks such as the lexical editor's
//! push into them). Relationship and virtual-field population are delegated to the TS
//! implementations through the host, called at the same point.
//!
//! Locals (`js::Local`) are re-read from `Val`s after every await; none crosses an await.

use std::cell::OnceCell;
use std::rc::Rc;

use crate::config::{self, BlockCandidate, FieldDesc, FieldsDesc, Kind, Segment, format_number};
use crate::executor::{await_call, await_js, spawn};
use crate::host::{self, call_host, host};
use crate::js::{self, JsResult, Local, Thrown, Type, Val};

/// Per-`afterRead` call state (the destructured `AfterReadArgs` plus derived values).
struct Ctx {
  /// The JS array the host's `afterReadArgs` returned (indices in [`arg`]), with the derived
  /// `depth`/`currentDepth` and the two promise arrays filled in. Passed whole to host helpers
  /// that build hook args, so they read the values in JS instead of one napi handle each.
  arr: Val,
  collection: Val,
  context: Val,
  current_depth: Val,
  depth: Val,
  doc: Val,
  draft: Val,
  fallback_locale: Val,
  find_many: Val,
  flatten_locales: Val,
  global: Val,
  locale: Val,
  override_access: Val,
  populate: Val,
  req: Val,
  show_hidden_fields: Val,
  /// `overrideAccess` is truthy (destructured once, like upstream).
  override_access_truthy: bool,
  /// `locale === 'all'`
  locale_is_all: bool,
  /// `showHiddenFields` is truthy
  show_hidden_truthy: bool,
  /// `flattenLocales` (after its `= true` default) is truthy
  flatten_truthy: bool,
  field_promises: Val,
  population_promises: Val,
}

/// Indices of the `afterReadArgs` array (mirrored in `packages/engine-rs/src/runtime/index.ts`).
mod arg {
  pub const COLLECTION: u32 = 0;
  pub const CONTEXT: u32 = 1;
  pub const CURRENT_DEPTH: u32 = 2;
  pub const DEPTH: u32 = 3;
  pub const DOC: u32 = 4;
  pub const DRAFT: u32 = 5;
  pub const FALLBACK_LOCALE: u32 = 6;
  pub const FIND_MANY: u32 = 7;
  pub const FLATTEN_LOCALES: u32 = 8;
  pub const GLOBAL: u32 = 9;
  pub const LOCALE: u32 = 10;
  pub const OVERRIDE_ACCESS: u32 = 11;
  pub const POPULATE: u32 = 12;
  pub const REQ: u32 = 13;
  pub const SELECT: u32 = 14;
  pub const SHOW_HIDDEN_FIELDS: u32 = 15;
  pub const FIELD_PROMISES: u32 = 16;
  pub const POPULATION_PROMISES: u32 = 17;
}

impl Ctx {
  fn show_hidden(&self) -> bool {
    self.show_hidden_truthy
  }
}

/// Arguments of one `traverseFields` call that differ between calls.
struct Trav {
  block_data: Val,
  field_depth: f64,
  fields: Rc<FieldsDesc>,
  /// For `tabs`: the `field.tabs.map((tab) => ({ ...tab, type: 'tab' }))` array. Its items are
  /// the `field` objects and the array is `siblingFields`.
  tab_fields: Option<Val>,
  parent_index_path: Rc<str>,
  parent_is_localized: Val,
  parent_path: Rc<str>,
  parent_schema_path: Rc<str>,
  select: Val,
  select_mode: Val,
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

/// `afterRead(args)`: returns the promise of the (mutated, same identity) `args.doc`. Like the
/// TS `async function`, everything (including the args destructuring) runs inside the task, so
/// a throw there rejects the returned promise.
pub fn after_read(args: Local) -> JsResult<Local> {
  let args = Val::from_local(args)?;
  spawn(async move {
    let (ctx, select) = prologue(args.get())?;
    run(ctx, select).await
  })
}

/// The `afterRead` prologue: destructuring (by the host, with the TS pattern and its
/// `flattenLocales = true` default), promise arrays, `depth` and `currentDepth`.
fn prologue(args: Local) -> JsResult<(Rc<Ctx>, Val)> {
  let h = host()?;
  let arr = call_host(&h.after_read_args, &[args])?;
  let el = |i: u32| js::get_element(arr, i);
  let val = |i: u32| -> JsResult<Val> { Val::from_local(el(i)?) };
  let incoming_current_depth = el(arg::CURRENT_DEPTH)?;
  let incoming_depth = el(arg::DEPTH)?;
  let req = val(arg::REQ)?;

  // let depth = incomingDepth || incomingDepth === 0 ? parseInt(String(incomingDepth), 10) : req.payload.config.defaultDepth
  let is_zero = js::type_of(incoming_depth) == Type::Number && js::get_f64(incoming_depth) == 0.0;
  let mut depth = if js::truthy(incoming_depth) || is_zero {
    call_host(&h.parse_depth, &[incoming_depth])?
  } else {
    host::get_named(host::get_named(host::get_named(req.get(), "payload")?, "config")?, "defaultDepth")?
  };
  // if (depth > req.payload.config.maxDepth) depth = req.payload.config.maxDepth
  let max_depth = host::get_named(host::get_named(host::get_named(req.get(), "payload")?, "config")?, "maxDepth")?;
  if greater_than(depth, max_depth)? {
    depth = host::get_named(host::get_named(host::get_named(req.get(), "payload")?, "config")?, "maxDepth")?;
  }
  let current_depth =
    if js::truthy(incoming_current_depth) { incoming_current_depth } else { js::number(1.0) };
  js::set_element(arr, arg::CURRENT_DEPTH, current_depth)?;
  js::set_element(arr, arg::DEPTH, depth)?;

  let override_access = val(arg::OVERRIDE_ACCESS)?;
  let locale = val(arg::LOCALE)?;
  let show_hidden_fields = val(arg::SHOW_HIDDEN_FIELDS)?;
  let flatten_locales = val(arg::FLATTEN_LOCALES)?;
  let ctx = Rc::new(Ctx {
    collection: val(arg::COLLECTION)?,
    context: val(arg::CONTEXT)?,
    current_depth: Val::from_local(current_depth)?,
    depth: Val::from_local(depth)?,
    doc: val(arg::DOC)?,
    draft: val(arg::DRAFT)?,
    fallback_locale: val(arg::FALLBACK_LOCALE)?,
    find_many: val(arg::FIND_MANY)?,
    flatten_truthy: js::truthy(flatten_locales.get()),
    flatten_locales,
    locale_is_all: js::str_equals(locale.get(), "all"),
    show_hidden_truthy: js::truthy(show_hidden_fields.get()),
    global: val(arg::GLOBAL)?,
    locale,
    override_access_truthy: js::truthy(override_access.get()),
    override_access,
    populate: val(arg::POPULATE)?,
    req,
    show_hidden_fields,
    field_promises: val(arg::FIELD_PROMISES)?,
    population_promises: val(arg::POPULATION_PROMISES)?,
    arr: Val::from_local(arr)?,
  });
  Ok((ctx, val(arg::SELECT)?))
}

async fn run(ctx: Rc<Ctx>, select: Val) -> JsResult<Val> {
  let h = host()?;
  // (collection?.fields || global?.fields)!
  let collection_fields = host::get_optional(ctx.collection.get(), js::key("fields"))?;
  let fields = if js::truthy(collection_fields) {
    collection_fields
  } else {
    host::get_optional(ctx.global.get(), js::key("fields"))?
  };
  let select_mode = if js::truthy(select.get()) {
    Val::from_local(call_host(&h.get_select_mode, &[select.get()])?)?
  } else {
    Val::Undefined
  };

  traverse_fields(
    &ctx,
    Rc::new(Trav {
      block_data: Val::Undefined,
      field_depth: 0.0,
      fields: config::fields_desc(fields)?,
      tab_fields: None,
      parent_index_path: "".into(),
      parent_is_localized: Val::Bool(false),
      parent_path: "".into(),
      parent_schema_path: "".into(),
      select,
      select_mode,
      sibling_doc: ctx.doc.clone(),
    }),
  )?;

  let mut iterations = 0;
  loop {
    let field_promises = ctx.field_promises.get();
    let population_promises = ctx.population_promises.get();
    if js::array_length(field_promises) == 0 && js::array_length(population_promises) == 0 {
      break;
    }
    let current_field_promises = splice_all(field_promises)?;
    let current_population_promises = Val::from_local(splice_all(population_promises)?)?;

    let all = call_host(&h.promise_all, &[current_field_promises])?;
    await_js(all).await?;
    let all = call_host(&h.promise_all, &[current_population_promises.get()])?;
    await_js(all).await?;

    iterations += 1;
    if iterations >= 100 {
      return Err(host::new_error(
        "Infinite afterRead promise loop detected. A hook is likely adding field promises in an infinitely recursive way.",
      )?);
    }
  }
  Ok(ctx.doc.clone())
}

/// `arr.splice(0, arr.length)`
fn splice_all(arr: Local) -> JsResult<Local> {
  let splice = js::get_named(arr, "splice")?;
  let len = js::array_length(arr);
  js::call(splice, arr, &[js::number(0.0), js::number(len as f64)])
}

/// `a > b` (numbers compared directly, anything else by the host with JS semantics).
fn greater_than(a: Local, b: Local) -> JsResult<bool> {
  if js::type_of(a) == Type::Number && js::type_of(b) == Type::Number {
    return Ok(js::get_f64(a) > js::get_f64(b));
  }
  Ok(js::truthy(call_host(&host()?.greater_than, &[a, b])?))
}

fn traverse_fields(ctx: &Rc<Ctx>, trav: Rc<Trav>) -> JsResult<()> {
  let Some(items) = &trav.fields.items else {
    return config::throw_not_array(&trav.fields);
  };
  if let Some(arr) = &trav.tab_fields {
    for (index, desc) in items.iter().enumerate() {
      let field_js = Val::from_local(js::get_element(arr.get(), index as u32)?)?;
      let promise = spawn(field_promise(ctx.clone(), trav.clone(), desc.clone(), field_js, index))?;
      js::push(ctx.field_promises.get(), promise)?;
    }
    return Ok(());
  }
  let parent_localized = js::truthy(trav.parent_is_localized.get());
  let plan = trav.fields.plan(ctx.override_access_truthy, parent_localized);
  for segment in plan.iter() {
    match *segment {
      Segment::Run(start, end, hooked) => leaf_run(ctx, &trav, start, end, hooked)?,
      Segment::Field(index) => {
        let desc = &items[index as usize];
        if matches!(desc.kind, Kind::Row | Kind::Collapsible | Kind::Group) && !desc.has_name {
          // An unnamed row/collapsible/group: `promise()` touches no data and only runs the
          // nested `traverseFields`, so it completes synchronously (rejected if that throws).
          let result = unnamed_container(ctx, &trav, desc, index as usize);
          push_settled(ctx, result)?;
          continue;
        }
        let field_js = Val::Ref(desc.node.clone());
        let promise = spawn(field_promise(ctx.clone(), trav.clone(), desc.clone(), field_js, index as usize))?;
        js::push(ctx.field_promises.get(), promise)?;
      }
    }
  }
  Ok(())
}

/// `promise()` of an unnamed row/collapsible/group: `traverseFields` with the passthrough args.
fn unnamed_container(ctx: &Rc<Ctx>, t: &Trav, f: &FieldDesc, index: usize) -> JsResult<()> {
  let paths = get_field_paths(f, index, &t.parent_index_path, &t.parent_path, &t.parent_schema_path);
  traverse_fields(
    ctx,
    Rc::new(Trav {
      block_data: t.block_data.clone(),
      field_depth: t.field_depth,
      fields: f.children()?,
      tab_fields: None,
      parent_index_path: Rc::from(paths.index_path.as_str()),
      parent_is_localized: t.parent_is_localized.clone(),
      parent_path: t.parent_path.clone(),
      parent_schema_path: Rc::from(paths.schema_path.as_str()),
      select: t.select.clone(),
      select_mode: t.select_mode.clone(),
      sibling_doc: t.sibling_doc.clone(),
    }),
  )
}

/// `fieldPromises.push(<promise of a field that completed synchronously>)`
fn push_settled(ctx: &Ctx, result: JsResult<()>) -> JsResult<()> {
  let h = host()?;
  match result {
    Ok(()) => call_host(&h.push_settled, &[ctx.field_promises.get(), js::boolean(true), js::undefined()])?,
    Err(Thrown(e)) => call_host(&h.push_settled, &[ctx.field_promises.get(), js::boolean(false), e.get()])?,
  };
  Ok(())
}

/// `ctx` bits of the host's `leafRun` (mirrored in `packages/engine-rs/src/runtime/index.ts`).
mod leaf_run_bits {
  pub const FLATTEN_LOCALES: u32 = 1;
  pub const SHOW_HIDDEN_FIELDS: u32 = 2;
  /// `fieldDepth === 0`
  pub const FIELD_DEPTH_ZERO: u32 = 4;
  /// A field named `id` gets the path `'id'` here (so `stripUnselectedFields` is skipped).
  pub const ID_PATH: u32 = 8;
  pub const SELECT_INCLUDE: u32 = 16;
  pub const SELECT_EXCLUDE: u32 = 32;
}

/// `traverseFields` for the plain leaves `start..end` (see [`config::Leaf`]): one host call
/// performs, per field and in order, exactly the sibling doc reads/deletes `promise()` does for
/// such a field and pushes the same kind of promise (fulfilled, or rejected with what a read
/// threw) onto `fieldPromises`. No plain leaf awaits, so `promise()` would also complete
/// synchronously, and the promise count and states, hence the microtask schedule, are unchanged.
/// A hooked leaf in the run (`hooked`) is a call of the host's `hookedLeaf`, a JS `async`
/// function with the body `promise()` has for such a field, whose promise is pushed in place.
fn leaf_run(ctx: &Rc<Ctx>, t: &Rc<Trav>, start: u32, end: u32, hooked: bool) -> JsResult<()> {
  let h = host()?;
  let table = t.fields.leaf_table()?;
  let bits = leaf_bits(ctx, t);
  let select = t.select.get();
  let mut from = start;
  while from < end {
    let mut args = [js::undefined(); 14];
    args[..8].copy_from_slice(&[
      t.sibling_doc.get(),
      table.keys.get(),
      table.flags.get(),
      js::number(f64::from(from)),
      js::number(f64::from(end)),
      js::number(f64::from(bits)),
      select,
      ctx.field_promises.get(),
    ]);
    let argc = if hooked {
      args[8..].copy_from_slice(&[
        ctx.arr.get(),
        t.block_data.get(),
        t.sibling_fields(),
        js::string(&t.parent_index_path),
        js::string(&t.parent_path),
        js::string(&t.parent_schema_path),
      ]);
      14
    } else {
      8
    };
    let stopped = call_host(&h.leaf_run, &args[..argc])?;
    // -1: done. Otherwise the index of a field whose default value applies: the host did its
    // reads up to `typeof siblingDoc[field.name] === 'undefined'`; the rest of its `promise()`
    // (from `await getDefaultValue(...)` on) runs as the field's task.
    let index = js::get_f64(stopped);
    if index < 0.0 {
      break;
    }
    let index = index as u32;
    let Some(items) = &t.fields.items else { break };
    let f = items[index as usize].clone();
    let promise = spawn(default_value_tail(ctx.clone(), t.clone(), f))?;
    js::push(ctx.field_promises.get(), promise)?;
    from = index + 1;
  }
  Ok(())
}

/// The rest of a plain leaf's `promise()` once its default value applies.
async fn default_value_tail(ctx: Rc<Ctx>, t: Rc<Trav>, f: Rc<FieldDesc>) -> JsResult<Val> {
  apply_default_value(&ctx, &t.sibling_doc, &f, &Val::Ref(f.node.clone())).await?;
  Ok(Val::Undefined)
}

/// `siblingDoc[field.name] = await getDefaultValue({ defaultValue: field.defaultValue, locale,
/// req, user: req.user, value: siblingDoc[field.name] })`
async fn apply_default_value(ctx: &Ctx, sib: &Val, f: &FieldDesc, field_js: &Val) -> JsResult<()> {
  let req = ctx.req.get();
  let args = GetDefaultValueArgs {
    default_value: Val::from_local(host::get_named(field_js.get(), "defaultValue")?)?,
    locale: ctx.locale.clone(),
    req: ctx.req.clone(),
    user: Val::from_local(host::get_named(req, "user")?)?,
    value: Val::from_local(host::get(sib.get(), f.name_key())?)?,
  };
  let p = spawn(get_default_value(args))?;
  let v = await_js(p).await?;
  host::set(sib.get(), f.name_key(), v.get())
}

/// The `ctx` bits of `leafRun`/`leafRows` for a traversal.
fn leaf_bits(ctx: &Ctx, t: &Trav) -> u32 {
  use leaf_run_bits::*;
  let mut bits = 0;
  if ctx.flatten_truthy {
    bits |= FLATTEN_LOCALES;
  }
  if ctx.show_hidden() {
    bits |= SHOW_HIDDEN_FIELDS;
  }
  if t.field_depth == 0.0 {
    bits |= FIELD_DEPTH_ZERO;
  }
  if parent_path_to_use_is_empty(&t.parent_path) {
    bits |= ID_PATH;
  }
  let select = t.select.get();
  let select_mode = t.select_mode.get();
  if js::truthy(select) && js::truthy(select_mode) {
    if js::str_equals(select_mode, "include") {
      bits |= SELECT_INCLUDE;
    } else if js::str_equals(select_mode, "exclude") {
      bits |= SELECT_EXCLUDE;
    }
  }
  bits
}

/// Whether `getFieldPaths`' `parentPathToUse` (the parent path without a trailing unnamed
/// `_index-` segment) is empty.
fn parent_path_to_use_is_empty(parent_path: &str) -> bool {
  parent_path.is_empty() || (!parent_path.contains('.') && parent_path.starts_with("_index-"))
}

struct Paths {
  index_path: String,
  path: String,
  schema_path: String,
}

/// Port of `getFieldPaths`.
fn get_field_paths(field: &FieldDesc, index: usize, parent_index_path: &str, parent_path: &str, parent_schema_path: &str) -> Paths {
  // parentPath.split('.') without its last segment when that one is an unnamed `_index-` segment
  let last_dot = parent_path.rfind('.');
  let last_segment = last_dot.map_or(parent_path, |i| &parent_path[i + 1..]);
  let parent_path_to_use = if last_segment.starts_with("_index-") {
    last_dot.map_or("", |i| &parent_path[..i])
  } else {
    parent_path
  };
  let join = |prefix: &str, name: &str| {
    let mut out = String::with_capacity(prefix.len() + 1 + name.len());
    if !prefix.is_empty() {
      out.push_str(prefix);
      out.push('.');
    }
    out.push_str(name);
    out
  };

  if field.has_name {
    return Paths {
      index_path: String::new(),
      path: join(parent_path_to_use, &field.name_str),
      schema_path: join(parent_schema_path, &field.name_str),
    };
  }
  let index_path = if parent_index_path.is_empty() {
    index.to_string()
  } else {
    format!("{parent_index_path}-{index}")
  };
  let index_suffix = format!("_index-{index_path}");
  let parent_schema_is_unnamed =
    parent_schema_path.rsplit('.').next().is_some_and(|s| s.starts_with("_index-"));
  Paths {
    path: join(parent_path_to_use, &index_suffix),
    schema_path: if parent_schema_is_unnamed {
      format!("{parent_schema_path}-{index}")
    } else {
      join(parent_schema_path, &index_suffix)
    },
    index_path,
  }
}

/// The `[pathSegments, schemaPathSegments, indexPathSegments]` arrays, created by the host with
/// the TS expressions. Created once per field promise (when first needed) and shared by all hook
/// calls of that field, like upstream.
struct Segments {
  triple: OnceCell<Val>,
}

impl Segments {
  fn triple(&self, paths: &Paths) -> JsResult<Local> {
    if let Some(v) = self.triple.get() {
      return Ok(v.get());
    }
    let v = call_host(
      &host()?.path_segments,
      &[js::string(&paths.path), js::string(&paths.schema_path), js::string(&paths.index_path)],
    )?;
    let _ = self.triple.set(Val::from_local(v)?);
    Ok(v)
  }

  /// One of the arrays: 0 path, 1 schemaPath, 2 indexPath.
  fn get(&self, paths: &Paths, which: u32) -> JsResult<Local> {
    js::get_element(self.triple(paths)?, which)
  }
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

fn is_empty_string(v: Local) -> bool {
  js::type_of(v) == Type::String && js::get_string(v).is_some_and(|s| s.is_empty())
}

fn str_eq(v: &Val, s: &str) -> bool {
  js::str_equals(v.get(), s)
}

/// `a || b` on JS values.
fn or(a: &Val, b: &Val) -> Val {
  if js::truthy(a.get()) { a.clone() } else { b.clone() }
}

/// `typeof v === 'object' ? v : undefined`
fn object_or_undefined(v: Local) -> JsResult<Val> {
  if js::type_of(v).is_typeof_object() { Val::from_local(v) } else { Ok(Val::Undefined) }
}

/// `v || {}`
fn or_empty_object(v: Local) -> JsResult<Val> {
  Val::from_local(if js::truthy(v) { v } else { js::object() })
}

/// Port of `promise.ts`.
async fn field_promise(ctx: Rc<Ctx>, t: Rc<Trav>, f: Rc<FieldDesc>, field_js: Val, field_index: usize) -> JsResult<Val> {
  let h = host()?;
  let paths = get_field_paths(&f, field_index, &t.parent_index_path, &t.parent_path, &t.parent_schema_path);
  let Paths { index_path, path, schema_path } = &paths;
  let (index_path, path, schema_path) = (index_path.as_str(), path.as_str(), schema_path.as_str());
  let segments = Segments { triple: OnceCell::new() };

  let affects_data = f.affects_data;
  let mut removed_field_value = false;
  let is_top_level_id_field = affects_data && f.name_is_id && t.field_depth == 0.0;
  let name = || f.name_key();
  let sib = || t.sibling_doc.get();

  if affects_data
    && f.hidden_truthy
    && js::type_of(host::get(sib(), name())?) != Type::Undefined
    && !ctx.show_hidden()
    && !is_top_level_id_field
  {
    removed_field_value = true;
    host::del(sib(), name())?;
  }

  if path != "id" {
    // stripUnselectedFields
    let select = t.select.get();
    let select_mode = t.select_mode.get();
    let mut should_continue = true;
    if affects_data && js::truthy(select) && js::truthy(select_mode) && js::truthy(name()) {
      if js::str_equals(select_mode, "include") && !js::truthy(host::get(select, name())?) {
        host::del(sib(), name())?;
        should_continue = false;
      }
      if js::str_equals(select_mode, "exclude") {
        let v = host::get(select, name())?;
        if js::type_of(v) == Type::Boolean && !js::get_bool(v) {
          host::del(sib(), name())?;
          should_continue = false;
        }
      }
    }
    if !should_continue {
      return Ok(Val::Undefined);
    }
  }

  let parent_is_localized = js::truthy(t.parent_is_localized.get());
  let should_localize_field = f.localized_truthy && !parent_is_localized;

  let should_hoist_localized_value = ctx.flatten_truthy
    && affects_data
    && js::type_of(host::get(sib(), name())?).is_typeof_object()
    && js::type_of(host::get(sib(), name())?) != Type::Null
    && should_localize_field
    && !ctx.locale_is_all
    && js::truthy(host::get_named(
      host::get_named(host::get_named(ctx.req.get(), "payload")?, "config")?,
      "localization",
    )?);

  if affects_data && should_hoist_localized_value {
    let value = host::get(host::get(sib(), name())?, ctx.locale.get())?;
    let mut hoisted_value = value;
    let fallback_locale = ctx.fallback_locale.get();
    if js::truthy(fallback_locale) && !js::strict_equals(fallback_locale, ctx.locale.get()) {
      let mut fallback_value = js::undefined();
      let is_null_or_undefined = is_nullish(value);
      if js::is_array(fallback_locale) {
        let len = js::array_length(fallback_locale);
        for i in 0..len {
          let locale = js::get_element(fallback_locale, i)?;
          let val = host::get_optional(host::get(sib(), name())?, locale)?;
          if !is_nullish(val) && !is_empty_string(val) {
            fallback_value = val;
            break;
          }
        }
      } else {
        fallback_value = host::get(host::get(sib(), name())?, fallback_locale)?;
      }
      if js::truthy(fallback_value) {
        match f.kind {
          Kind::Slug | Kind::Text | Kind::Textarea => {
            if is_empty_string(value) || is_null_or_undefined {
              hoisted_value = fallback_value;
            }
          }
          _ => {
            if is_null_or_undefined {
              hoisted_value = fallback_value;
            }
          }
        }
      }
    }
    host::set(sib(), name(), hoisted_value)?;
  }

  // Sanitize outgoing field value
  match f.kind {
    Kind::Group => {
      if affects_data && js::type_of(host::get(sib(), name())?) == Type::Undefined {
        host::set(sib(), name(), js::object())?;
      }
    }
    Kind::Point => {
      let point_doc = host::get(sib(), name())?;
      let coordinates = host::get_optional(point_doc, js::key("coordinates"))?;
      let is_pair = js::is_array(coordinates) && {
        let len = host::get_named(host::get_named(point_doc, "coordinates")?, "length")?;
        js::type_of(len) == Type::Number && js::get_f64(len) == 2.0
      };
      if is_pair {
        host::set(sib(), name(), host::get_named(point_doc, "coordinates")?)?;
      } else {
        host::set(sib(), name(), js::undefined())?;
      }
    }
    Kind::RichText => check_editor(&field_js)?,
    Kind::Tabs => {
      let tabs = f.tabs()?;
      if let Some(items) = &tabs.items {
        for tab in items {
          if tab.has_name {
            let v = host::get(sib(), tab.name.get())?;
            if js::type_of(v) == Type::Undefined || js::type_of(host::get(sib(), tab.name.get())?) == Type::Null {
              host::set(sib(), tab.name.get(), js::object())?;
            }
          }
        }
      }
    }
    _ => {}
  }

  let should_run_hook_on_all_locales = ctx.locale_is_all
    && f.has_name
    && js::type_of(name()) == Type::String
    && !should_hoist_localized_value
    && should_localize_field
    && js::type_of(host::get(sib(), name())?).is_typeof_object();

  if affects_data {
    if f.has_after_read_hooks {
      // for (const hook of field.hooks.afterRead)
      let hooks = Val::from_local(host::get_named(host::get_named(field_js.get(), "hooks")?, "afterRead")?)?;
      let mut i = 0;
      while i < js::array_length(hooks.get()) {
        // Only used before this iteration's first await.
        let hook = js::get_element(hooks.get(), i)?;
        i += 1;
        // One call into a JS helper returning the same object literal (key order, shape) as
        // upstream; much cheaper than 21 napi property definitions.
        let make_args = |value: Local| -> JsResult<Local> {
          call_host(
            &h.hook_args,
            &[
              t.block_data.get(),
              ctx.collection.get(),
              ctx.context.get(),
              ctx.current_depth.get(),
              ctx.doc.get(),
              ctx.depth.get(),
              ctx.draft.get(),
              field_js.get(),
              ctx.find_many.get(),
              ctx.global.get(),
              segments.get(&paths, 2)?,
              segments.get(&paths, 0)?,
              ctx.override_access.get(),
              ctx.req.get(),
              segments.get(&paths, 1)?,
              ctx.show_hidden_fields.get(),
              t.sibling_doc.get(),
              t.sibling_fields(),
              value,
            ],
          )
        };
        if should_run_hook_on_all_locales {
          let entries = host::object_entries(host::get(sib(), name())?)?;
          let tasks = js::array();
          for e in 0..js::array_length(entries) {
            let entry = js::get_element(entries, e)?;
            let locale_key = Val::from_local(js::get_element(entry, 0)?)?;
            let value = js::get_element(entry, 1)?;
            let args = make_args(value)?;
            let hook_result = js::call(hook, js::undefined(), &[args]);
            let (t2, f2) = (t.clone(), f.clone());
            let task = spawn(async move {
              let hooked_value = await_js(hook_result?).await?;
              if !hooked_value.is_undefined() {
                host::set(host::get(t2.sibling_doc.get(), f2.name.get())?, locale_key.get(), hooked_value.get())?;
              }
              Ok(Val::Undefined)
            })?;
            js::set_element(tasks, e, task)?;
          }
          let all = call_host(&h.promise_all, &[tasks])?;
          await_js(all).await?;
        } else {
          // `await hook({ ...args, value: siblingDoc[field.name] })` in one host call.
          let value = host::get(sib(), name())?;
          let hooked_value = await_call(
            h.call_field_hook.get(),
            &[
              hook,
              ctx.arr.get(),
              t.block_data.get(),
              field_js.get(),
              segments.triple(&paths)?,
              t.sibling_doc.get(),
              t.sibling_fields(),
              value,
            ],
          )
          .await?;
          if !hooked_value.is_undefined() {
            host::set(sib(), name(), hooked_value.get())?;
          }
        }
      }
    }

    if let Some(virtual_path) = &f.virtual_path {
      if !f.hidden_truthy || ctx.show_hidden() {
        let owner = or(&ctx.collection, &ctx.global);
        let fields = host::get_named(owner.get(), "flattenedFields")?;
        call_host(
          &h.push_virtual_field_population,
          &[ctx.arr.get(), name(), fields, js::string_array(virtual_path.split('.'))?, t.sibling_doc.get()],
        )?;
      }
    }

    // Execute access control
    let mut allow_default_value = true;
    if f.has_read_access {
      let can_read_field = if ctx.override_access_truthy {
        true
      } else {
        let access = host::get_named(field_js.get(), "access")?;
        let read = host::get_named(access, "read")?;
        // `await field.access.read(collection ? {...} : {...})`, `id: doc.id` read by the host.
        let result = await_call(
          h.call_read_access.get(),
          &[access, read, ctx.arr.get(), t.block_data.get(), t.sibling_doc.get()],
        )
        .await?;
        js::truthy(result.get())
      };
      if !can_read_field {
        allow_default_value = false;
        host::del(sib(), name())?;
      }
    }

    if !removed_field_value
      && allow_default_value
      && js::type_of(host::get(sib(), name())?) == Type::Undefined
      && f.has_default_value
    {
      apply_default_value(&ctx, &t.sibling_doc, &f, &field_js).await?;
    }

    if matches!(f.kind, Kind::Relationship | Kind::Upload | Kind::Join) {
      call_host(
        &h.push_relationship_population,
        &[ctx.arr.get(), field_js.get(), t.parent_is_localized.get(), t.sibling_doc.get()],
      )?;
    }
  }

  let child = |fields: Rc<FieldsDesc>| Trav {
    block_data: t.block_data.clone(),
    field_depth: t.field_depth + 1.0,
    fields,
    tab_fields: None,
    parent_index_path: "".into(),
    parent_is_localized: or(&t.parent_is_localized, &f.localized),
    parent_path: Rc::from(path),
    parent_schema_path: Rc::from(schema_path),
    select: Val::Undefined,
    select_mode: Val::Undefined,
    sibling_doc: Val::Undefined,
  };
  let passthrough = |fields: Rc<FieldsDesc>| Trav {
    block_data: t.block_data.clone(),
    field_depth: t.field_depth,
    fields,
    tab_fields: None,
    parent_index_path: Rc::from(index_path),
    parent_is_localized: t.parent_is_localized.clone(),
    parent_path: t.parent_path.clone(),
    parent_schema_path: Rc::from(schema_path),
    select: t.select.clone(),
    select_mode: t.select_mode.clone(),
    sibling_doc: t.sibling_doc.clone(),
  };

  match f.kind {
    Kind::Array => {
      let rows = host::get(sib(), name())?;
      let mut array_select = host::get_optional(t.select.get(), name())?;
      if str_eq(&t.select_mode, "include") && js::type_of(array_select).is_typeof_object() {
        array_select = call_host(&h.spread_with_id, &[array_select])?;
      }
      let array_select = object_or_undefined(array_select)?;

      let children = f.children()?;
      let children_localized = or(&t.parent_is_localized, &f.localized);
      let all_plain = if js::is_array(rows) && js::array_length(rows) > 0 {
        children.all_plain(ctx.override_access_truthy, js::truthy(children_localized.get()))
      } else {
        None
      };
      if let Some((end, hooked)) = all_plain {
        // `rows.forEach((row) => traverseFields({ siblingDoc: row || {}, ... }))` where every
        // field is a plain leaf: the host runs `leafRun` per row and stops where a default value
        // applies; the engine runs that field's default value step, finishes the row and lets
        // the host continue with the next row (same `length` snapshot as `forEach`).
        let table = children.leaf_table()?;
        let row_trav = Trav { select: array_select.clone(), select_mode: t.select_mode.clone(), ..child(children.clone()) };
        let bits = js::number(f64::from(leaf_bits(&ctx, &row_trav)));
        let rows = Val::from_local(rows)?;
        let mut start_row = js::number(0.0);
        let mut len = js::number(-1.0);
        // Rows with hooked leaves also need what `hookedLeaf` reads: the `afterReadArgs` array,
        // `blockData`, `field.fields` and the paths rows are traversed with.
        let hooked_args = if hooked {
          Some([ctx.arr.get(), row_trav.block_data.get(), children.node.get(), js::string(path), js::string(schema_path)])
        } else {
          None
        };
        loop {
          let mut args = [js::undefined(); 14];
          args[..9].copy_from_slice(&[
            rows.get(),
            start_row,
            len,
            table.keys.get(),
            table.flags.get(),
            js::number(f64::from(end)),
            bits,
            array_select.get(),
            ctx.field_promises.get(),
          ]);
          let argc = match &hooked_args {
            Some(extra) => {
              args[9..].copy_from_slice(extra);
              14
            }
            None => 9,
          };
          let stopped = call_host(&h.leaf_rows, &args[..argc])?;
          if js::type_of(stopped) == Type::Number {
            break;
          }
          // [rowIndex, fieldIndex, siblingDoc, length]
          let row_index = js::get_f64(js::get_element(stopped, 0)?);
          let field_index = js::get_f64(js::get_element(stopped, 1)?) as u32;
          let row = Rc::new(Trav {
            parent_path: format!("{path}.{}", row_index as u32).into(),
            select: array_select.clone(),
            select_mode: t.select_mode.clone(),
            sibling_doc: Val::from_local(js::get_element(stopped, 2)?)?,
            ..child(children.clone())
          });
          let Some(items) = &children.items else { break };
          let promise = spawn(default_value_tail(ctx.clone(), row.clone(), items[field_index as usize].clone()))?;
          js::push(ctx.field_promises.get(), promise)?;
          leaf_run(&ctx, &row, field_index + 1, end, hooked)?;
          start_row = js::number(row_index + 1.0);
          len = js::get_element(stopped, 3)?;
        }
      } else if js::is_array(rows) && js::array_length(rows) > 0 {
        let rows = Val::from_local(rows)?;
        for_each(rows.get(), |row, row_index| {
          traverse_fields(
            &ctx,
            Rc::new(Trav {
              parent_path: format!("{path}.{row_index}").into(),
              select: array_select.clone(),
              select_mode: t.select_mode.clone(),
              sibling_doc: or_empty_object(row)?,
              ..child(f.children()?)
            }),
          )
        })?;
      } else if !should_hoist_localized_value && is_object_non_null(rows) {
        let values = host::object_values(rows)?;
        for_each(values, |locale_rows, _| {
          if js::is_array(locale_rows) {
            for_each(locale_rows, |row, row_index| {
              traverse_fields(
                &ctx,
                Rc::new(Trav {
                  parent_path: format!("{path}.{row_index}").into(),
                  sibling_doc: or_empty_object(row)?,
                  ..child(f.children()?)
                }),
              )
            })?;
          }
          Ok(())
        })?;
      } else if should_hoist_localized_value && (!js::truthy(rows) || is_zero_length(rows)?) {
        host::set(sib(), name(), js::null())?;
      } else if !f.hidden_is_true || is_true(&ctx.show_hidden_fields) {
        host::set(sib(), name(), js::array())?;
      }
    }

    Kind::Blocks => {
      let rows = host::get(sib(), name())?;
      if js::is_array(rows) && js::array_length(rows) > 0 {
        for_each(rows, |row, row_index| {
          let block_type = host::get_named(row, "blockType")?;
          let block = find_block(&ctx, &f, block_type)?;
          let field_select = host::get_optional(t.select.get(), name())?;
          let block_select = call_host(
            &h.get_block_select,
            &[object(&[
              ("block", block.as_ref().map(|b| b.node.get()).unwrap_or_else(js::undefined)),
              ("select", field_select),
              ("selectMode", t.select_mode.get()),
            ])?],
          )?;
          let block_select_value = host::get_named(block_select, "blockSelect")?;
          let block_select_mode = host::get_named(block_select, "blockSelectMode")?;
          if let Some(block) = block {
            traverse_fields(
              &ctx,
              Rc::new(Trav {
                block_data: Val::from_local(row)?,
                parent_path: format!("{path}.{row_index}").into(),
                parent_schema_path: format!("{schema_path}.{}", block.slug_str).into(),
                select: object_or_undefined(block_select_value)?,
                select_mode: Val::from_local(block_select_mode)?,
                sibling_doc: or_empty_object(row)?,
                ..child(block.fields()?)
              }),
            )?;
          }
          Ok(())
        })?;
      } else if !should_hoist_localized_value && is_object_non_null(rows) {
        let values = host::object_values(rows)?;
        for_each(values, |locale_rows, _| {
          if js::is_array(locale_rows) {
            for_each(locale_rows, |row, row_index| {
              let block_type = host::get_named(row, "blockType")?;
              if let Some(block) = find_block(&ctx, &f, block_type)? {
                traverse_fields(
                  &ctx,
                  Rc::new(Trav {
                    block_data: Val::from_local(row)?,
                    parent_path: format!("{path}.{row_index}").into(),
                    parent_schema_path: format!("{schema_path}.{}", block.slug_str).into(),
                    sibling_doc: or_empty_object(row)?,
                    ..child(block.fields()?)
                  }),
                )?;
              }
              Ok(())
            })?;
          }
          Ok(())
        })?;
      } else if should_hoist_localized_value && (!js::truthy(rows) || is_zero_length(rows)?) {
        host::set(sib(), name(), js::null())?;
      } else if !f.hidden_is_true || is_true(&ctx.show_hidden_fields) {
        host::set(sib(), name(), js::array())?;
      }
    }

    Kind::Collapsible | Kind::Row => {
      traverse_fields(&ctx, Rc::new(passthrough(f.children()?)))?;
    }

    Kind::Group | Kind::Tab if f.kind == Kind::Tab || affects_data => {
      // A tab is "named" when `'name' in field`; a group "affects data" likewise.
      if f.kind == Kind::Tab && !f.has_name {
        traverse_fields(
          &ctx,
          Rc::new(Trav {
            parent_is_localized: or(&t.parent_is_localized, &f.localized),
            ..passthrough(f.children()?)
          }),
        )?;
      } else {
        let field_select = host::get_optional(t.select.get(), name())?;
        let sub_select = if js::type_of(field_select).is_typeof_object() {
          Val::from_local(host::get_optional(t.select.get(), name())?)?
        } else {
          Val::Undefined
        };
        if should_localize_field && !should_hoist_localized_value {
          let data = host::get(sib(), name())?;
          let values = host::object_values(if js::truthy(data) { data } else { js::object() })?;
          for_each(values, |localized_data, _| {
            traverse_fields(
              &ctx,
              Rc::new(Trav {
                select: sub_select.clone(),
                select_mode: t.select_mode.clone(),
                sibling_doc: or_empty_object(localized_data)?,
                ..child(f.children()?)
              }),
            )
          })?;
        } else {
          let sibling_doc = if !js::type_of(host::get(sib(), name())?).is_typeof_object() {
            Val::from_local(js::object())?
          } else {
            Val::from_local(host::get(sib(), name())?)?
          };
          traverse_fields(
            &ctx,
            Rc::new(Trav {
              select: sub_select,
              select_mode: t.select_mode.clone(),
              sibling_doc,
              ..child(f.children()?)
            }),
          )?;
        }
      }
    }

    Kind::Group => {
      // unnamed group
      traverse_fields(&ctx, Rc::new(passthrough(f.children()?)))?;
    }

    Kind::RichText => {
      check_editor(&field_js)?;
      let editor = Val::from_local(host::get_optional(field_js.get(), js::key("editor"))?)?;
      let hooks_obj = host::get_optional(editor.get(), js::key("hooks"))?;
      let after_read = host::get_optional(hooks_obj, js::key("afterRead"))?;
      let length = host::get_optional(after_read, js::key("length"))?;
      if js::truthy(length) {
        let hooks = Val::from_local(host::get_named(host::get_named(editor.get(), "hooks")?, "afterRead")?)?;
        let mut i = 0;
        while i < js::array_length(hooks.get()) {
          let hook = Val::from_local(js::get_element(hooks.get(), i)?)?;
          i += 1;
          let make_args = |locale: Local, value: Local| -> JsResult<Local> {
            object(&[
              ("collection", ctx.collection.get()),
              ("context", ctx.context.get()),
              ("currentDepth", ctx.current_depth.get()),
              ("data", ctx.doc.get()),
              ("depth", ctx.depth.get()),
              ("draft", ctx.draft.get()),
              ("fallbackLocale", ctx.fallback_locale.get()),
              ("field", field_js.get()),
              ("fieldPromises", ctx.field_promises.get()),
              ("findMany", ctx.find_many.get()),
              ("flattenLocales", ctx.flatten_locales.get()),
              ("global", ctx.global.get()),
              ("indexPath", segments.get(&paths, 2)?),
              ("locale", locale),
              ("operation", js::string("read")),
              ("originalDoc", ctx.doc.get()),
              ("overrideAccess", ctx.override_access.get()),
              ("parentIsLocalized", t.parent_is_localized.get()),
              ("path", segments.get(&paths, 0)?),
              ("populate", ctx.populate.get()),
              ("populationPromises", ctx.population_promises.get()),
              ("req", ctx.req.get()),
              ("schemaPath", segments.get(&paths, 1)?),
              ("showHiddenFields", ctx.show_hidden_fields.get()),
              ("siblingData", t.sibling_doc.get()),
              ("triggerAccessControl", js::boolean(true)),
              ("triggerHooks", js::boolean(true)),
              ("value", value),
            ])
          };
          if should_run_hook_on_all_locales {
            let entries = host::object_entries(host::get(sib(), name())?)?;
            let tasks = js::array();
            for e in 0..js::array_length(entries) {
              let entry = js::get_element(entries, e)?;
              let locale_key = Val::from_local(js::get_element(entry, 0)?)?;
              let args = make_args(locale_key.get(), js::get_element(entry, 1)?)?;
              let hook_result = js::call(hook.get(), js::undefined(), &[args]);
              let (t2, f2) = (t.clone(), f.clone());
              let task = spawn(async move {
                let hooked_value = await_js(hook_result?).await?;
                if !hooked_value.is_undefined() {
                  host::set(host::get(t2.sibling_doc.get(), f2.name.get())?, locale_key.get(), hooked_value.get())?;
                }
                Ok(Val::Undefined)
              })?;
              js::set_element(tasks, e, task)?;
            }
            let all = call_host(&h.promise_all, &[tasks])?;
            await_js(all).await?;
          } else {
            let value = host::get(sib(), name())?;
            let hooked_value = await_call(
              h.call_editor_hook.get(),
              &[
                hook.get(),
                ctx.arr.get(),
                field_js.get(),
                segments.triple(&paths)?,
                t.parent_is_localized.get(),
                t.sibling_doc.get(),
                value,
              ],
            )
            .await?;
            if !hooked_value.is_undefined() {
              host::set(sib(), name(), hooked_value.get())?;
            }
          }
        }
      }
    }

    Kind::Tabs => {
      let tabs_desc = f.tabs()?;
      let tabs = host::get_named(field_js.get(), "tabs")?;
      let tab_fields = call_host(&h.tabs_as_fields, &[tabs])?;
      traverse_fields(
        &ctx,
        Rc::new(Trav {
          tab_fields: Some(Val::from_local(tab_fields)?),
          parent_path: Rc::from(path),
          ..passthrough(tabs_desc)
        }),
      )?;
    }

    _ => {}
  }

  Ok(Val::Undefined)
}

/// `field?.editor` checks shared by the sanitize step and the richText traversal.
fn check_editor(field_js: &Val) -> JsResult<()> {
  let editor = host::get_optional(field_js.get(), js::key("editor"))?;
  if !js::truthy(editor) {
    let e = call_host(&host()?.missing_editor_prop, &[field_js.get()])?;
    return Err(Thrown(Val::from_local(e)?));
  }
  if js::type_of(editor) == Type::Function {
    return Err(host::new_error("Attempted to access unsanitized rich text editor.")?);
  }
  Ok(())
}

/// `req.payload.blocks[blockType] ?? field.blocks.find((b) => typeof b !== 'string' && b.slug === blockType)`
fn find_block(ctx: &Ctx, f: &FieldDesc, block_type: Local) -> JsResult<Option<Rc<config::BlockDesc>>> {
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
fn for_each(arr: Local, mut f: impl FnMut(Local, String) -> JsResult<()>) -> JsResult<()> {
  let arr = Val::from_local(arr)?;
  let len = js::array_length(arr.get());
  for i in 0..len {
    let a = arr.get();
    let mut has = false;
    js::check(unsafe { napi::sys::napi_has_element(js::env(), a.0, i, &mut has) })?;
    if has {
      let item = js::get_element(a, i)?;
      f(item, format_number(i as f64))?;
    }
  }
  Ok(())
}

/// `typeof v === 'object' && v !== null`
fn is_object_non_null(v: Local) -> bool {
  let t = js::type_of(v);
  t.is_typeof_object() && t != Type::Null
}

/// `rows.length === 0`
fn is_zero_length(rows: Local) -> JsResult<bool> {
  let len = host::get_named(rows, "length")?;
  Ok(js::type_of(len) == Type::Number && js::get_f64(len) == 0.0)
}

/// `v === true`
fn is_true(v: &Val) -> bool {
  matches!(v, Val::Bool(true))
}

struct GetDefaultValueArgs {
  default_value: Val,
  locale: Val,
  req: Val,
  user: Val,
  value: Val,
}

/// Port of `getDefaultValue` (an async function: awaited through its own promise).
async fn get_default_value(args: GetDefaultValueArgs) -> JsResult<Val> {
  if !args.value.is_undefined() {
    return Ok(args.value);
  }
  let default_value = args.default_value.get();
  if js::truthy(default_value) && js::type_of(default_value) == Type::Function {
    let a = object(&[("locale", args.locale.get()), ("req", args.req.get()), ("user", args.user.get())])?;
    let result = js::call(default_value, js::undefined(), &[a])?;
    return await_js(result).await;
  }
  if js::type_of(default_value).is_typeof_object() {
    let copy = call_host(&host()?.deep_copy, &[default_value])?;
    return Val::from_local(copy);
  }
  Ok(args.default_value)
}
