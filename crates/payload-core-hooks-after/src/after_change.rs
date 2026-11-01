//! Port of `packages/payload/src/fields/hooks/afterChange/{index,traverseFields,promise}.ts`.
//!
//! Mirrors the TS line by line (RUST_CORE_DESIGN.md porting rules): `afterChange`,
//! `traverseFields` and `promise` are each a spawned task with its own native promise, every
//! `await` is [`await_js`], concurrency is `Promise.all` over the task promises in iteration
//! order, and every value handed to user code is the real JS object (rows and passthrough
//! containers are the same `{ ...row }` / `{ ...siblingDoc }` copies upstream creates).
//!
//! Upstream quirks kept on purpose:
//! - `traverseFields` does not forward `siblingFields`, so hooks get `siblingFields: undefined`.
//! - Array rows, rows/collapsibles/unnamed groups and tabs traverse spread copies of
//!   `siblingDoc`, so hook return values written there do not reach the returned doc.
//! - Array rows and named groups take `previousSiblingDoc` from the root `previousDoc`.
//! - `value`/`previousValue` first look up the full path from the sibling object
//!   (`getNestedValue`) before falling back to `siblingDoc[field.name]`.

use std::rc::Rc;

use payload_core_runtime::config::{self, FieldDesc, FieldsDesc, Kind};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::host as rt;
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Type, Val};

use crate::common::{
  Paths, Segments, call_hook, find_block, for_each, for_of_list, get_field_paths, get_nested_value, keys_length,
  nullish_or, nullish_or_empty_object, or, or_empty_object, promise_all, spread,
};
use crate::host;

/// The destructured `afterChange` args, constant for the whole traversal.
struct Ctx {
  collection: Val,
  context: Val,
  data: Val,
  doc: Val,
  global: Val,
  operation: Val,
  previous_doc: Val,
  req: Val,
}

/// Arguments of one `traverseFields` call that differ between calls.
struct Trav {
  block_data: Val,
  fields: Rc<FieldsDesc>,
  /// For `tabs`: the `field.tabs.map((tab) => ({ ...tab, type: 'tab' }))` array whose items are
  /// the `field` objects.
  tab_fields: Option<Val>,
  parent_index_path: Rc<str>,
  parent_is_localized: Val,
  parent_path: Rc<str>,
  parent_schema_path: Rc<str>,
  previous_sibling_doc: Val,
  sibling_data: Val,
  sibling_doc: Val,
}

/// `afterChange(args)`: the promise of `args.doc` (same identity) after the field hooks ran.
pub fn after_change(args: Local) -> JsResult<Local> {
  let args = Val::from_local(args)?;
  spawn(run(args))
}

async fn run(args: Val) -> JsResult<Val> {
  let a = args.get();
  let g = |name: &str| -> JsResult<Val> { Val::from_local(rt::get_named(a, name)?) };
  let ctx = Rc::new(Ctx {
    collection: g("collection")?,
    context: g("context")?,
    data: g("data")?,
    doc: g("doc")?,
    global: g("global")?,
    operation: g("operation")?,
    previous_doc: g("previousDoc")?,
    req: g("req")?,
  });

  // fields: (collection?.fields || global?.fields)!
  let collection_fields = rt::get_optional(ctx.collection.get(), js::key("fields"))?;
  let fields = if js::truthy(collection_fields) {
    collection_fields
  } else {
    rt::get_optional(ctx.global.get(), js::key("fields"))?
  };

  let p = traverse_fields(
    &ctx,
    Trav {
      block_data: Val::Undefined,
      fields: config::fields_desc(fields)?,
      tab_fields: None,
      parent_index_path: "".into(),
      parent_is_localized: Val::Bool(false),
      parent_path: "".into(),
      parent_schema_path: "".into(),
      previous_sibling_doc: ctx.previous_doc.clone(),
      sibling_data: ctx.data.clone(),
      sibling_doc: ctx.doc.clone(),
    },
  )?;
  await_js(p).await?;
  Ok(ctx.doc.clone())
}

/// Calls `traverseFields` (an async function) and returns its promise.
fn traverse_fields(ctx: &Rc<Ctx>, trav: Trav) -> JsResult<Local> {
  spawn(traverse_fields_body(ctx.clone(), Rc::new(trav)))
}

async fn traverse_fields_body(ctx: Rc<Ctx>, t: Rc<Trav>) -> JsResult<Val> {
  let Some(items) = &t.fields.items else {
    config::throw_not_array(&t.fields)?;
    return Ok(Val::Undefined);
  };
  let promises = js::array();
  for (index, desc) in items.iter().enumerate() {
    let field_js = match &t.tab_fields {
      Some(arr) => Val::from_local(js::get_element(arr.get(), index as u32)?)?,
      None => Val::Ref(desc.node.clone()),
    };
    let p = spawn(field_promise(ctx.clone(), t.clone(), desc.clone(), field_js, index))?;
    js::push(promises, p)?;
  }
  await_js(promise_all(promises)?).await?;
  Ok(Val::Undefined)
}

/// Port of `promise.ts`.
async fn field_promise(
  ctx: Rc<Ctx>,
  t: Rc<Trav>,
  f: Rc<FieldDesc>,
  field_js: Val,
  field_index: usize,
) -> JsResult<Val> {
  let paths = get_field_paths(&f, field_index, &t.parent_index_path, &t.parent_path, &t.parent_schema_path);
  let Paths { index_path, path, schema_path } = &paths;
  let segments = Segments::new();
  let name = || f.name.get();

  // previousSiblingDoc && Object.keys(previousSiblingDoc).length > 0 ? previousSiblingDoc : previousDoc
  let previous_sibling_doc = t.previous_sibling_doc.get();
  let previous_val_data = if js::truthy(previous_sibling_doc) && keys_length(previous_sibling_doc)? > 0.0 {
    t.previous_sibling_doc.clone()
  } else {
    ctx.previous_doc.clone()
  };
  // getNestedValue(previousValData, pathSegments) ?? previousValData?.[field.name]
  let previous_value = |path_segments: Local| -> JsResult<Local> {
    let data = previous_val_data.get();
    nullish_or(get_nested_value(data, path_segments)?, || rt::get_optional(data, name()))
  };

  if f.affects_data {
    // 'hooks' in field && field.hooks?.afterChange
    let field = field_js.get();
    let has_hooks = js::has_property(field, js::key("hooks"))?
      && js::truthy(rt::get_optional(rt::get_named(field, "hooks")?, js::key("afterChange"))?);
    if has_hooks {
      let h = host::host()?;
      let list = rt::get_named(rt::get_named(field_js.get(), "hooks")?, "afterChange")?;
      let hooks = for_of_list(list, || host::call(&h.field_after_change_hooks, &[field_js.get()]))?;
      let mut i = 0;
      while i < js::array_length(hooks.get()) {
        let hook = js::get_element(hooks.get(), i)?;
        i += 1;
        let path_segments = segments.path(&paths)?;
        let previous_value = previous_value(path_segments)?;
        // getNestedValue(siblingDoc, pathSegments) ?? siblingDoc?.[field.name]
        let sibling_doc = t.sibling_doc.get();
        let value = nullish_or(get_nested_value(sibling_doc, path_segments)?, || {
          rt::get_optional(sibling_doc, name())
        })?;
        let args = host::call(
          &h.after_change_hook_args,
          &[
            t.block_data.get(),
            ctx.collection.get(),
            ctx.context.get(),
            ctx.data.get(),
            field_js.get(),
            ctx.global.get(),
            segments.index_path(&paths)?,
            ctx.operation.get(),
            ctx.doc.get(),
            path_segments,
            ctx.previous_doc.get(),
            t.previous_sibling_doc.get(),
            previous_value,
            ctx.req.get(),
            segments.schema_path(&paths)?,
            t.sibling_data.get(),
            js::undefined(),
            value,
          ],
        )?;
        let hooked_value = await_js(call_hook(hook, args)?).await?;
        if !hooked_value.is_undefined() {
          rt::set(t.sibling_doc.get(), name(), hooked_value.get())?;
        }
      }
    }
  }

  // Traverse subfields
  match f.kind {
    Kind::Array => {
      let rows = rt::get(t.sibling_doc.get(), name())?;
      if js::is_array(rows) {
        let promises = Val::from_local(js::array())?;
        for_each(rows, |row, row_index| {
          let index = js::number(row_index as f64);
          let fields = f.children()?;
          let parent_is_localized = or(&t.parent_is_localized, &f.localized);
          // previousDoc?.[field.name]?.[rowIndex] || {}
          let previous_sibling_doc = or_empty_object(rt::get_optional(
            rt::get_optional(ctx.previous_doc.get(), name())?,
            index,
          )?)?;
          // siblingData?.[field.name]?.[rowIndex] || {}
          let sibling_data =
            or_empty_object(rt::get_optional(rt::get_optional(t.sibling_data.get(), name())?, index)?)?;
          // row ? { ...row } : {}
          let sibling_doc = if js::truthy(row) { spread(row)? } else { Val::from_local(js::object())? };
          let p = traverse_fields(
            &ctx,
            Trav {
              block_data: t.block_data.clone(),
              fields,
              tab_fields: None,
              parent_index_path: "".into(),
              parent_is_localized,
              parent_path: format!("{path}.{row_index}").into(),
              parent_schema_path: schema_path.as_str().into(),
              previous_sibling_doc,
              sibling_data,
              sibling_doc,
            },
          )?;
          js::push(promises.get(), p)
        })?;
        await_js(promise_all(promises.get())?).await?;
      }
    }

    Kind::Blocks => {
      let rows = rt::get(t.sibling_doc.get(), name())?;
      if js::is_array(rows) {
        let promises = Val::from_local(js::array())?;
        for_each(rows, |row, row_index| {
          let index = js::number(row_index as f64);
          let block_type = rt::get_named(row, "blockType")?;
          let Some(block) = find_block(ctx.req.get(), &f, block_type)? else {
            return Ok(());
          };
          // blockData: siblingData?.[field.name]?.[rowIndex]
          let block_data =
            Val::from_local(rt::get_optional(rt::get_optional(t.sibling_data.get(), name())?, index)?)?;
          let fields = block.fields()?;
          let parent_is_localized = or(&t.parent_is_localized, &f.localized);
          // previousValData?.[field.name]?.[rowIndex] || {}
          let previous_sibling_doc = or_empty_object(rt::get_optional(
            rt::get_optional(previous_val_data.get(), name())?,
            index,
          )?)?;
          let sibling_data =
            or_empty_object(rt::get_optional(rt::get_optional(t.sibling_data.get(), name())?, index)?)?;
          let sibling_doc = if js::truthy(row) { spread(row)? } else { Val::from_local(js::object())? };
          let p = traverse_fields(
            &ctx,
            Trav {
              block_data,
              fields,
              tab_fields: None,
              parent_index_path: "".into(),
              parent_is_localized,
              parent_path: format!("{path}.{row_index}").into(),
              parent_schema_path: format!("{schema_path}.{}", block.slug_str).into(),
              previous_sibling_doc,
              sibling_data,
              sibling_doc,
            },
          )?;
          js::push(promises.get(), p)
        })?;
        await_js(promise_all(promises.get())?).await?;
      }
    }

    Kind::Collapsible | Kind::Row => {
      let p = traverse_fields(&ctx, passthrough(&t, f.children()?, index_path, schema_path)?)?;
      await_js(p).await?;
    }

    Kind::Group => {
      let p = if f.affects_data {
        let fields = f.children()?;
        let parent_is_localized = or(&t.parent_is_localized, &f.localized);
        // (previousDoc?.[field.name] as JsonObject) || {}
        let previous_sibling_doc = or_empty_object(rt::get_optional(ctx.previous_doc.get(), name())?)?;
        let sibling_data = or_empty_object(rt::get_optional(t.sibling_data.get(), name())?)?;
        let sibling_doc = or_empty_object(rt::get_optional(t.sibling_doc.get(), name())?)?;
        traverse_fields(
          &ctx,
          Trav {
            block_data: t.block_data.clone(),
            fields,
            tab_fields: None,
            parent_index_path: "".into(),
            parent_is_localized,
            parent_path: path.as_str().into(),
            parent_schema_path: schema_path.as_str().into(),
            previous_sibling_doc,
            sibling_data,
            sibling_doc,
          },
        )?
      } else {
        traverse_fields(&ctx, passthrough(&t, f.children()?, index_path, schema_path)?)?
      };
      await_js(p).await?;
    }

    Kind::RichText => {
      let field = field_js.get();
      if !js::truthy(rt::get_optional(field, js::key("editor"))?) {
        let e = rt::call_host(&rt::host()?.missing_editor_prop, &[field])?;
        return Err(Thrown(Val::from_local(e)?));
      }
      if js::type_of(rt::get_named(field, "editor")?) == Type::Function {
        return Err(rt::new_error("Attempted to access unsanitized rich text editor.")?);
      }
      let editor = Val::from_local(rt::get_named(field, "editor")?)?;

      // editor?.hooks?.afterChange?.length
      let hooks_obj = rt::get_optional(editor.get(), js::key("hooks"))?;
      let after_change = rt::get_optional(hooks_obj, js::key("afterChange"))?;
      if js::truthy(rt::get_optional(after_change, js::key("length"))?) {
        let h = host::host()?;
        let list = rt::get_named(rt::get_named(editor.get(), "hooks")?, "afterChange")?;
        let hooks = for_of_list(list, || host::call(&h.editor_after_change_hooks, &[editor.get()]))?;
        let mut i = 0;
        while i < js::array_length(hooks.get()) {
          let hook = js::get_element(hooks.get(), i)?;
          i += 1;
          let path_segments = segments.path(&paths)?;
          let previous_value = previous_value(path_segments)?;
          // value: siblingDoc?.[field.name]
          let value = rt::get_optional(t.sibling_doc.get(), name())?;
          let args = host::call(
            &h.editor_after_change_hook_args,
            &[
              ctx.collection.get(),
              ctx.context.get(),
              ctx.data.get(),
              field_js.get(),
              ctx.global.get(),
              segments.index_path(&paths)?,
              ctx.operation.get(),
              ctx.doc.get(),
              t.parent_is_localized.get(),
              path_segments,
              ctx.previous_doc.get(),
              t.previous_sibling_doc.get(),
              previous_value,
              ctx.req.get(),
              segments.schema_path(&paths)?,
              t.sibling_data.get(),
              value,
            ],
          )?;
          let hooked_value = await_js(call_hook(hook, args)?).await?;
          if !hooked_value.is_undefined() {
            rt::set(t.sibling_doc.get(), name(), hooked_value.get())?;
          }
        }
      }
    }

    Kind::Tab => {
      // let tabPreviousSiblingDoc = { ...previousDoc }
      let tab_previous_sibling_doc = spread(ctx.previous_doc.get())?;
      // tabHasName(field)
      let is_named_tab = f.has_name;
      let (sibling_data, sibling_doc, previous_sibling_doc) = if is_named_tab {
        (
          nullish_or_empty_object(rt::get_optional(t.sibling_data.get(), name())?)?,
          nullish_or_empty_object(rt::get_optional(t.sibling_doc.get(), name())?)?,
          nullish_or_empty_object(rt::get_optional(t.previous_sibling_doc.get(), name())?)?,
        )
      } else {
        (t.sibling_data.clone(), t.sibling_doc.clone(), tab_previous_sibling_doc)
      };
      let p = traverse_fields(
        &ctx,
        Trav {
          block_data: t.block_data.clone(),
          fields: f.children()?,
          tab_fields: None,
          parent_index_path: if is_named_tab { "".into() } else { index_path.as_str().into() },
          parent_is_localized: or(&t.parent_is_localized, &f.localized),
          parent_path: if is_named_tab { path.as_str().into() } else { t.parent_path.clone() },
          parent_schema_path: schema_path.as_str().into(),
          previous_sibling_doc,
          sibling_data,
          sibling_doc,
        },
      )?;
      await_js(p).await?;
    }

    Kind::Tabs => {
      let tabs_desc = f.tabs()?;
      // field.tabs.map((tab) => ({ ...tab, type: 'tab' }))
      let tab_fields = rt::call_host(&rt::host()?.tabs_as_fields, &[rt::get_named(field_js.get(), "tabs")?])?;
      let tab_fields = Val::from_local(tab_fields)?;
      let previous_sibling_doc = spread(t.previous_sibling_doc.get())?;
      let sibling_data = or_empty_object(t.sibling_data.get())?;
      let sibling_doc = spread(t.sibling_doc.get())?;
      let p = traverse_fields(
        &ctx,
        Trav {
          block_data: t.block_data.clone(),
          fields: tabs_desc,
          tab_fields: Some(tab_fields),
          parent_index_path: index_path.as_str().into(),
          parent_is_localized: t.parent_is_localized.clone(),
          parent_path: path.as_str().into(),
          parent_schema_path: schema_path.as_str().into(),
          previous_sibling_doc,
          sibling_data,
          sibling_doc,
        },
      )?;
      await_js(p).await?;
    }

    _ => {}
  }

  Ok(Val::Undefined)
}

/// Args of the row/collapsible/unnamed-group traversal: same data level, spread copies of
/// `previousSiblingDoc` and `siblingDoc` (evaluated in the literal's order).
fn passthrough(t: &Trav, fields: Rc<FieldsDesc>, index_path: &str, schema_path: &str) -> JsResult<Trav> {
  let previous_sibling_doc = spread(t.previous_sibling_doc.get())?;
  let sibling_data = or_empty_object(t.sibling_data.get())?;
  let sibling_doc = spread(t.sibling_doc.get())?;
  Ok(Trav {
    block_data: t.block_data.clone(),
    fields,
    tab_fields: None,
    parent_index_path: index_path.into(),
    parent_is_localized: t.parent_is_localized.clone(),
    parent_path: t.parent_path.clone(),
    parent_schema_path: schema_path.into(),
    previous_sibling_doc,
    sibling_data,
    sibling_doc,
  })
}
