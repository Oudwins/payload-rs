//! Port of `packages/payload/src/fields/hooks/beforeDuplicate/{index,traverseFields,promise}.ts`.
//!
//! Same porting rules as `after_change.rs`. Upstream quirks kept on purpose:
//! - Localized `array`/`blocks` fields push their row traversals into an inner `promises` array
//!   that is never awaited: those traversals run detached (their rejections are unhandled).
//! - Localized `blocks` rows with an unknown `blockType` throw the TypeError of `block!.fields`.
//! - `fieldData` is read before the hooks run; the localized traversal uses that value.
//! - Every hook of a field gets the same args object; only the last hook's result is kept.

use std::rc::Rc;

use payload_core_runtime::config::{self, FieldDesc, FieldsDesc, Kind};
use payload_core_runtime::executor::{Tail, await_js, spawn_tail};
use payload_core_runtime::host as rt;
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use crate::common::{
  Paths, Segments, call_hook, find_block, for_each, for_of_list, get_field_paths, is_leaf, or, promise_all,
};
use crate::host;

/// The destructured `beforeDuplicate` args, constant for the whole traversal.
struct Ctx {
  /// `[collection, context, doc, req, id, overrideAccess]` for the host's `beforeDuplicateLeaves`
  /// (indices `BD_*` in packages/engine-rs/src/runtime/afterChange/binding.ts).
  arr: Val,
  collection: Val,
  context: Val,
  doc: Val,
  req: Val,
}

/// Arguments of one `traverseFields` call that differ between calls.
struct Trav {
  block_data: Val,
  fields: Rc<FieldsDesc>,
  /// For `tabs`: the `field.tabs.map((tab) => ({ ...tab, type: 'tab' }))` array (the `field`
  /// objects and `siblingFields`).
  tab_fields: Option<Val>,
  parent_index_path: Rc<str>,
  parent_is_localized: Val,
  parent_path: Rc<str>,
  parent_schema_path: Rc<str>,
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

/// `beforeDuplicate(args)`: the promise of `args.doc` (same identity) after the hooks ran.
pub fn before_duplicate(args: Local) -> JsResult<Local> {
  let args = Val::from_local(args)?;
  spawn_tail(run(args))
}

async fn run(args: Val) -> JsResult<Tail> {
  let a = args.get();
  let g = |name: &str| -> JsResult<Val> { Val::from_local(rt::get_named(a, name)?) };
  // destructuring order: id, collection, context, doc, overrideAccess, req
  let id = g("id")?;
  let collection = g("collection")?;
  let context = g("context")?;
  let doc = g("doc")?;
  let override_access = g("overrideAccess")?;
  let req = g("req")?;
  let arr = js::array();
  for (i, v) in [&collection, &context, &doc, &req, &id, &override_access].into_iter().enumerate() {
    js::set_element(arr, i as u32, v.get())?;
  }
  let ctx = Rc::new(Ctx { arr: Val::from_local(arr)?, collection, context, doc, req });

  // fields: collection!.fields
  let fields = rt::get_named(ctx.collection.get(), "fields")?;
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
      sibling_doc: ctx.doc.clone(),
    },
  )?;
  Ok(Tail::Await(p, ctx.doc.clone()))
}

/// Calls `traverseFields` (an async function) and returns its promise.
fn traverse_fields(ctx: &Rc<Ctx>, trav: Trav) -> JsResult<Local> {
  // Upstream's `traverseFields.ts` body in JS (`beforeDuplicateLeafTraversal`: `fields.forEach`
  // pushing upstream's `promise()`, `await Promise.all`); with the `ported-traversals` feature
  // only for a fields array made of leaf fields, other arrays run the port.
  let all_leaves =
    trav.tab_fields.is_none() && trav.fields.items.as_ref().is_some_and(|items| items.iter().all(|f| is_leaf(f.kind)));
  if all_leaves || (!cfg!(feature = "ported-traversals") && trav.tab_fields.is_none()) {
    return host::call(
      &host::host()?.before_duplicate_leaf_traversal,
      &[
        ctx.arr.get(),
        trav.fields.node.get(),
        trav.block_data.get(),
        js::string(&trav.parent_index_path),
        trav.parent_is_localized.get(),
        js::string(&trav.parent_path),
        js::string(&trav.parent_schema_path),
        trav.sibling_doc.get(),
      ],
    );
  }
  spawn_tail(traverse_fields_body(ctx.clone(), Rc::new(trav)))
}

async fn traverse_fields_body(ctx: Rc<Ctx>, t: Rc<Trav>) -> JsResult<Tail> {
  let Some(items) = &t.fields.items else {
    config::throw_not_array(&t.fields)?;
    return Ok(Tail::Return(Val::Undefined));
  };
  let promises = js::array();
  let mut index = 0;
  while index < items.len() {
    if t.tab_fields.is_none() && is_leaf(items[index].kind) {
      // A run of leaves: upstream's `promise()` of each, pushed in order by the host.
      let start = index;
      while index < items.len() && is_leaf(items[index].kind) {
        index += 1;
      }
      let h = host::host()?;
      host::call(
        &h.before_duplicate_leaves,
        &[
          ctx.arr.get(),
          t.fields.node.get(),
          js::number(start as f64),
          js::number(index as f64),
          promises,
          t.block_data.get(),
          js::string(&t.parent_index_path),
          t.parent_is_localized.get(),
          js::string(&t.parent_path),
          js::string(&t.parent_schema_path),
          t.sibling_doc.get(),
        ],
      )?;
      continue;
    }
    let desc = &items[index];
    let field_js = match &t.tab_fields {
      Some(arr) => Val::from_local(js::get_element(arr.get(), index as u32)?)?,
      None => Val::Ref(desc.node.clone()),
    };
    let p = spawn_tail(field_promise(ctx.clone(), t.clone(), desc.clone(), field_js, index))?;
    js::push(promises, p)?;
    index += 1;
  }
  Ok(Tail::Await(promise_all(promises)?, Val::Undefined))
}

/// `typeof v !== 'undefined'`
fn is_defined(v: &Val) -> bool {
  !v.is_undefined()
}

/// Port of `promise.ts`.
async fn field_promise(
  ctx: Rc<Ctx>,
  t: Rc<Trav>,
  f: Rc<FieldDesc>,
  field_js: Val,
  field_index: usize,
) -> JsResult<Tail> {
  let paths = get_field_paths(&f, field_index, &t.parent_index_path, &t.parent_path, &t.parent_schema_path);
  let Paths { index_path, path, schema_path } = &paths;

  // const { localization } = req.payload.config
  let localization = Val::from_local(rt::get_named(
    rt::get_named(rt::get_named(ctx.req.get(), "payload")?, "config")?,
    "localization",
  )?)?;
  let segments = Segments::new();
  let name = || f.name.get();
  let sib = || t.sibling_doc.get();

  // child traversal args shared by most branches
  let child = |fields: Rc<FieldsDesc>, block_data: Val, parent_path: String, parent_schema_path: String, sibling_doc: Val| Trav {
    block_data,
    fields,
    tab_fields: None,
    parent_index_path: "".into(),
    parent_is_localized: or(&t.parent_is_localized, &f.localized),
    parent_path: parent_path.into(),
    parent_schema_path: parent_schema_path.into(),
    sibling_doc,
  };

  if f.affects_data {
    // 'disableDuplicate' in field && field.disableDuplicate
    let field = field_js.get();
    if js::has_property(field, js::key("disableDuplicate"))? && js::truthy(rt::get_named(field, "disableDuplicate")?) {
      rt::del(sib(), name())?;
      return Ok(Tail::Return(Val::Undefined));
    }

    // let fieldData = siblingDoc?.[field.name!]
    let mut field_data = Val::from_local(rt::get_optional(sib(), name())?)?;
    // localization && fieldShouldBeLocalized({ field, parentIsLocalized })
    let field_is_localized =
      js::truthy(localization.get()) && f.localized_truthy && !js::truthy(t.parent_is_localized.get());

    // Array.isArray('hooks' in field && field.hooks?.beforeDuplicate)
    let has_hooks = |field: Local| -> JsResult<Local> {
      if !js::has_property(field, js::key("hooks"))? {
        return Ok(js::boolean(false));
      }
      rt::get_optional(rt::get_named(field, "hooks")?, js::key("beforeDuplicate"))
    };
    if js::is_array(has_hooks(field_js.get())?) {
      let h = host::host()?;
      let make_args = |value_of: &dyn Fn() -> JsResult<Local>| -> JsResult<Val> {
        let previous_value = value_of()?;
        let value = value_of()?;
        Val::from_local(host::call(
          &h.before_duplicate_hook_args,
          &[
            t.block_data.get(),
            ctx.collection.get(),
            ctx.context.get(),
            ctx.doc.get(),
            field_js.get(),
            segments.index_path(&paths)?,
            segments.path(&paths)?,
            sib(),
            previous_value,
            ctx.req.get(),
            segments.schema_path(&paths)?,
            t.sibling_fields(),
            value,
          ],
        )?)
      };

      if field_is_localized {
        let locale_data = Val::from_local(js::object())?;
        // for (const locale of localization.localeCodes)
        let codes = rt::get_named(localization.get(), "localeCodes")?;
        let codes = for_of_list(codes, || host::call(&h.locale_codes, &[localization.get()]))?;
        let mut i = 0;
        while i < js::array_length(codes.get()) {
          let locale = Val::from_local(js::get_element(codes.get(), i)?)?;
          i += 1;
          // previousValue/value: siblingDoc[field.name!]?.[locale]
          let args = make_args(&|| rt::get_optional(rt::get(sib(), name())?, locale.get()))?;
          let mut hook_result = Val::Undefined;
          let hooks = Val::from_local(has_hooks(field_js.get())?)?;
          if js::truthy(hooks.get()) {
            let list = rt::get_named(rt::get_named(field_js.get(), "hooks")?, "beforeDuplicate")?;
            let hooks = for_of_list(list, || host::call(&h.field_before_duplicate_hooks, &[field_js.get()]))?;
            let mut j = 0;
            while j < js::array_length(hooks.get()) {
              let hook = js::get_element(hooks.get(), j)?;
              j += 1;
              hook_result = await_js(call_hook(hook, args.get())?).await?;
            }
          }
          if is_defined(&hook_result) {
            rt::set(locale_data.get(), locale.get(), hook_result.get())?;
          }
        }
        rt::set(sib(), name(), locale_data.get())?;
      } else {
        // previousValue/value: siblingDoc[field.name!]
        let args = make_args(&|| rt::get(sib(), name()))?;
        let mut hook_result = Val::Undefined;
        let hooks = Val::from_local(has_hooks(field_js.get())?)?;
        if js::truthy(hooks.get()) {
          let list = rt::get_named(rt::get_named(field_js.get(), "hooks")?, "beforeDuplicate")?;
          let hooks = for_of_list(list, || host::call(&h.field_before_duplicate_hooks, &[field_js.get()]))?;
          let mut j = 0;
          while j < js::array_length(hooks.get()) {
            let hook = js::get_element(hooks.get(), j)?;
            j += 1;
            hook_result = await_js(call_hook(hook, args.get())?).await?;
          }
        }
        if is_defined(&hook_result) {
          rt::set(sib(), name(), hook_result.get())?;
        }
      }
    }

    if field_is_localized {
      let fd = field_data.get();
      if !js::type_of(fd).is_typeof_object() || js::type_of(fd) == Type::Null {
        rt::set(sib(), name(), js::object())?;
        field_data = Val::from_local(rt::get(sib(), name())?)?;
      }

      let promises = Val::from_local(js::array())?;
      // localization.localeCodes.forEach((locale) => { ... })
      let codes = rt::get_named(localization.get(), "localeCodes")?;
      if !js::is_array(codes) {
        host::call(&host::host()?.locale_codes_for_each, &[localization.get()])?;
      } else {
        for_each(codes, |locale, _| {
          if !js::truthy(rt::get(field_data.get(), locale)?) {
            return Ok(());
          }
          match f.kind {
            Kind::Array => {
              let rows = rt::get(field_data.get(), locale)?;
              if js::is_array(rows) {
                // pushed into an inner `promises` array that is never awaited
                for_each(rows, |row, row_index| {
                  traverse_fields(
                    &ctx,
                    child(
                      f.children()?,
                      t.block_data.clone(),
                      format!("{path}.{row_index}"),
                      schema_path.clone(),
                      Val::from_local(row)?,
                    ),
                  )?;
                  Ok(())
                })?;
              }
            }
            Kind::Blocks => {
              let rows = rt::get(field_data.get(), locale)?;
              if js::is_array(rows) {
                // pushed into an inner `promises` array that is never awaited
                for_each(rows, |row, row_index| {
                  let block_type = rt::get_named(row, "blockType")?;
                  let block = find_block(ctx.req.get(), &f, block_type)?;
                  // blockData: row, then fields: block!.fields (TypeError when not found)
                  let Some(block) = block else {
                    rt::get_named(js::undefined(), "fields")?;
                    return Ok(());
                  };
                  traverse_fields(
                    &ctx,
                    child(
                      block.fields()?,
                      Val::from_local(row)?,
                      format!("{path}.{row_index}"),
                      format!("{schema_path}.{}", block.slug_str),
                      Val::from_local(row)?,
                    ),
                  )?;
                  Ok(())
                })?;
              }
            }
            Kind::Group | Kind::Tab => {
              let fields = f.children()?;
              let sibling_doc = Val::from_local(rt::get(field_data.get(), locale)?)?;
              let p = traverse_fields(
                &ctx,
                child(fields, t.block_data.clone(), path.clone(), schema_path.clone(), sibling_doc),
              )?;
              js::push(promises.get(), p)?;
            }
            _ => {}
          }
          Ok(())
        })?;
      }

      return Ok(Tail::Await(promise_all(promises.get())?, Val::Undefined));
    } else {
      match f.kind {
        Kind::Array => {
          let rows = rt::get(sib(), name())?;
          if js::is_array(rows) {
            let promises = Val::from_local(js::array())?;
            for_each(rows, |row, row_index| {
              let p = traverse_fields(
                &ctx,
                child(
                  f.children()?,
                  t.block_data.clone(),
                  format!("{path}.{row_index}"),
                  schema_path.clone(),
                  Val::from_local(row)?,
                ),
              )?;
              js::push(promises.get(), p)
            })?;
            return Ok(Tail::Await(promise_all(promises.get())?, Val::Undefined));
          }
        }
        Kind::Blocks => {
          let rows = rt::get(sib(), name())?;
          if js::is_array(rows) {
            let promises = Val::from_local(js::array())?;
            for_each(rows, |row, row_index| {
              let block_type = rt::get_named(row, "blockType")?;
              let Some(block) = find_block(ctx.req.get(), &f, block_type)? else {
                return Ok(());
              };
              // (row as JsonObject).blockType = blockTypeToMatch
              rt::set(row, js::key("blockType"), block_type)?;
              let p = traverse_fields(
                &ctx,
                child(
                  block.fields()?,
                  Val::from_local(row)?,
                  format!("{path}.{row_index}"),
                  format!("{schema_path}.{}", block.slug_str),
                  Val::from_local(row)?,
                ),
              )?;
              js::push(promises.get(), p)
            })?;
            return Ok(Tail::Await(promise_all(promises.get())?, Val::Undefined));
          }
        }
        Kind::Group | Kind::Tab => {
          // if (typeof siblingDoc[field.name] !== 'object') siblingDoc[field.name] = {}
          if !js::type_of(rt::get(sib(), name())?).is_typeof_object() {
            rt::set(sib(), name(), js::object())?;
          }
          let group_doc = Val::from_local(rt::get(sib(), name())?)?;
          let p = traverse_fields(
            &ctx,
            child(f.children()?, t.block_data.clone(), path.clone(), schema_path.clone(), group_doc),
          )?;
          return Ok(Tail::Await(p, Val::Undefined));
        }
        _ => {}
      }
    }
  } else {
    // Fields that do not affect data: collapsibles, rows, unnamed groups, unnamed tabs, tabs
    let same_level = |fields: Rc<FieldsDesc>, tab_fields: Option<Val>, parent_path: Rc<str>| Trav {
      block_data: t.block_data.clone(),
      fields,
      tab_fields,
      parent_index_path: index_path.as_str().into(),
      parent_is_localized: t.parent_is_localized.clone(),
      parent_path,
      parent_schema_path: schema_path.as_str().into(),
      sibling_doc: t.sibling_doc.clone(),
    };
    match f.kind {
      Kind::Collapsible | Kind::Group | Kind::Row | Kind::Tab => {
        let p = traverse_fields(&ctx, same_level(f.children()?, None, t.parent_path.clone()))?;
        return Ok(Tail::Await(p, Val::Undefined));
      }
      Kind::Tabs => {
        let tabs_desc = f.tabs()?;
        let tab_fields = rt::call_host(&rt::host()?.tabs_as_fields, &[rt::get_named(field_js.get(), "tabs")?])?;
        let p = traverse_fields(
          &ctx,
          same_level(tabs_desc, Some(Val::from_local(tab_fields)?), path.as_str().into()),
        )?;
        return Ok(Tail::Await(p, Val::Undefined));
      }
      _ => {}
    }
  }

  Ok(Tail::Return(Val::Undefined))
}
