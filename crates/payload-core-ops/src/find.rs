//! Port of `packages/payload/src/collections/operations/find.ts` (`findOperation`).

use std::rc::Rc;

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  AccessArgs, HookTarget, ReadHooks, at, build_after_operation, build_before_operation, db_call, execute_access,
  has_drafts_enabled, has_hooks, nullish_or, or, sanitize_sort_query,
};
use crate::host::{self, call, call_fn, call_val, get, get_val, is_false, opt, val};

pub const LOCKED_DOCUMENTS_SLUG: &str = "payload-locked-documents";

/// `findOperation(incomingArgs)`: returns its promise.
pub fn find(incoming_args: Local) -> JsResult<Local> {
  let incoming_args = val(incoming_args)?;
  spawn(run(incoming_args))
}

async fn run(incoming_args: Val) -> JsResult<Val> {
  let mut args = incoming_args;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access = get_val(args.get(), "overrideAccess")?;
  args = await_js(build_before_operation(args, collection, "read", override_access)?).await?;

  let d = call("findArgs", &[args.get()])?;
  let collection_config = at(d, 0)?;
  let collection = at(d, 1)?;
  let current_depth = at(d, 2)?;
  let depth = at(d, 3)?;
  let disable_errors = at(d, 4)?;
  let drafts_enabled = at(d, 5)?;
  let include_lock_status_from_args = at(d, 6)?;
  let joins = at(d, 7)?;
  let limit = at(d, 8)?;
  let override_access = at(d, 9)?;
  let page = at(d, 10)?;
  let pagination = at(d, 11)?;
  let populate = at(d, 12)?;
  let incoming_select = at(d, 13)?;
  let show_hidden_fields = at(d, 14)?;
  let incoming_sort = at(d, 15)?;
  let trash = at(d, 16)?;
  let where_ = at(d, 17)?;

  let req = get_val(args.get(), "req")?;
  let cc = collection_config.get();

  // includeLockStatusFromArgs && req.payload.collections?.[lockedDocumentsCollectionSlug]
  let include_lock_status = js::truthy(include_lock_status_from_args.get())
    && js::truthy(opt(get(get(req.get(), "payload")?, "collections")?, LOCKED_DOCUMENTS_SLUG)?);

  let fallback_locale = get_val(req.get(), "fallbackLocale")?;
  let locale = get_val(req.get(), "locale")?;
  let payload = get_val(req.get(), "payload")?;

  let select = call_val("selectRead", &[cc, req.get(), incoming_select.get()])?;

  // Access
  let mut access_result = Val::Undefined;
  if !js::truthy(override_access.get()) {
    let slug = get_val(cc, "slug")?;
    let read = get_val(get(cc, "access")?, "read")?;
    let access_args = AccessArgs::new(slug, disable_errors.clone(), req.clone());
    access_result = if host::mutant(4) {
      crate::common::execute_access_body(access_args, read).await?
    } else {
      await_js(execute_access(access_args, read)?).await?
    };
    if is_false(access_result.get()) {
      return call_val("emptyFindResult", &[limit.get()]);
    }
  }

  // Find
  let cc = collection_config.get();
  let use_pagination = if js::truthy(pagination.get()) {
    Val::Bool(!js::strict_equals(limit.get(), js::number(0.0)))
  } else {
    pagination.clone()
  };
  let sanitized_limit =
    nullish_or(limit.clone(), || Ok(Val::Num(if js::truthy(use_pagination.get()) { 10.0 } else { 0.0 })))?;
  let sanitized_page = or(page.clone(), || Ok(Val::Num(1.0)))?;

  let mut full_where = call_val("combineQueries", &[where_.get(), access_result.get()])?;
  let flattened_fields = get(cc, "flattenedFields")?;
  call("sanitizeWhereQuery", &[flattened_fields, payload.get(), full_where.get()])?;

  let enable_trash = get(cc, "trash")?;
  full_where = call_val("appendNonTrashedFilter", &[enable_trash, trash.get(), full_where.get()])?;

  let sort_fields = get(get(collection.get(), "config")?, "flattenedFields")?;
  let sort_value = or(incoming_sort.clone(), || get_val(collection_config.get(), "defaultSort"))?;
  let sort = val(sanitize_sort_query(sort_fields, sort_value.get())?)?;

  let p = call("validateSortQuery", &[cc, override_access.get(), req.get(), sort.get()])?;
  await_js(p).await?;

  let p = call("sanitizeJoinQuery", &[collection_config.get(), joins.get(), override_access.get(), req.get()])?;
  let sanitized_joins = await_js(p).await?;

  let mut result;
  if has_drafts_enabled(collection_config.get())? && js::truthy(drafts_enabled.get()) {
    full_where = call_val("appendVersionToQueryKey", &[full_where.get()])?;

    let p = call(
      "validateQueryPathsCollectionDrafts",
      &[collection.get(), override_access.get(), req.get(), payload.get(), where_.get()],
    )?;
    await_js(p).await?;

    let p = db_call(payload.get(), "queryDrafts", || {
      call(
        "findQueryDraftsArgs",
        &[
          collection_config.get(),
          req.get(),
          sanitized_joins.get(),
          sanitized_limit.get(),
          locale.get(),
          sanitized_page.get(),
          use_pagination.get(),
          select.get(),
          sort.get(),
          full_where.get(),
        ],
      )
    })?;
    result = await_js(p).await?;
  } else {
    let p = call("validateQueryPaths", &[collection_config.get(), override_access.get(), req.get(), where_.get()])?;
    await_js(p).await?;

    let p = db_call(payload.get(), "find", || {
      call(
        "findDbArgs",
        &[
          collection_config.get(),
          drafts_enabled.get(),
          req.get(),
          sanitized_joins.get(),
          sanitized_limit.get(),
          locale.get(),
          sanitized_page.get(),
          pagination.get(),
          select.get(),
          sort.get(),
          full_where.get(),
        ],
      )
    })?;
    result = await_js(p).await?;
  }

  // Add collection property for auth collections
  if js::truthy(get(collection_config.get(), "auth")?) {
    call("authDocs", &[result.get(), collection_config.get()])?;
  }

  if include_lock_status {
    let locked: JsResult<()> = async {
      let lock_ms = call_val("lockDurationMs", &[collection_config.get()])?;
      let now = call_val("now", &[])?;
      let find = get(payload.get(), "find")?;
      let find_args = call(
        "findLockArgs",
        &[collection_config.get(), sanitized_limit.get(), req.get(), result.get(), now.get(), lock_ms.get()],
      )?;
      let p = call_fn(find, payload.get(), &[find_args], "payload.find")?;
      let locked_documents = await_js(p).await?;
      call("findLockApply", &[locked_documents.get(), result.get(), now.get(), lock_ms.get()])?;
      Ok(())
    }
    .await;
    if locked.is_err() {
      call("findLockReset", &[result.get()])?;
    }
  }

  let ctx = Rc::new(DocCtx {
    collection_config: collection_config.clone(),
    current_depth,
    depth,
    drafts_enabled,
    fallback_locale,
    full_where: full_where.clone(),
    locale,
    override_access: override_access.clone(),
    populate,
    req: req.clone(),
    select,
    show_hidden_fields,
  });

  // beforeRead - Collection
  if has_hooks(collection_config.get(), "beforeRead")? {
    let docs = get(result.get(), "docs")?;
    let promises = host::map_array(docs, "result.docs", |doc| {
      let ctx = ctx.clone();
      let doc = val(doc)?;
      spawn(async move { ctx.hooks("beforeRead").run(HookTarget::Doc(doc)).await })
    })?;
    let docs = await_js(host::promise_all(promises)?).await?;
    host::set(result.get(), "docs", docs.get())?;
  }

  // afterRead - Fields
  if host::mutant(2) {
    let docs = get(result.get(), "docs")?;
    let out = js::array();
    let out_val = val(out)?;
    let docs = val(docs)?;
    let mut i = 0;
    while i < js::array_length(docs.get()) {
      let doc = js::get_element(docs.get(), i)?;
      let after_read_args = call(
        "findAfterReadArgs",
        &[
          ctx.collection_config.get(),
          ctx.req.get(),
          ctx.current_depth.get(),
          ctx.depth.get(),
          doc,
          ctx.drafts_enabled.get(),
          ctx.fallback_locale.get(),
          ctx.locale.get(),
          ctx.override_access.get(),
          ctx.populate.get(),
          ctx.select.get(),
          ctx.show_hidden_fields.get(),
        ],
      )?;
      let doc = await_js(host::after_read(after_read_args)?).await?;
      js::set_element(out_val.get(), i, doc.get())?;
      i += 1;
    }
    host::set(result.get(), "docs", out_val.get())?;
  }
  let docs = get(result.get(), "docs")?;
  let promises = host::map_array(docs, "result.docs", |doc| {
    let ctx = ctx.clone();
    let doc = val(doc)?;
    spawn(async move {
      let after_read_args = call(
        "findAfterReadArgs",
        &[
          ctx.collection_config.get(),
          ctx.req.get(),
          ctx.current_depth.get(),
          ctx.depth.get(),
          doc.get(),
          ctx.drafts_enabled.get(),
          ctx.fallback_locale.get(),
          ctx.locale.get(),
          ctx.override_access.get(),
          ctx.populate.get(),
          ctx.select.get(),
          ctx.show_hidden_fields.get(),
        ],
      )?;
      val(host::after_read(after_read_args)?)
    })
  })?;
  if !host::mutant(2) {
    let docs = await_js(host::promise_all(promises)?).await?;
    host::set(result.get(), "docs", docs.get())?;
  }

  // afterRead - Collection
  if has_hooks(collection_config.get(), "afterRead")? {
    let docs = get(result.get(), "docs")?;
    let promises = host::map_array(docs, "result.docs", |doc| {
      let ctx = ctx.clone();
      let doc = val(doc)?;
      spawn(async move {
        let mut hooks = ctx.hooks("afterRead");
        hooks.find_many = true;
        hooks.run(HookTarget::Doc(doc)).await
      })
    })?;
    let docs = await_js(host::promise_all(promises)?).await?;
    host::set(result.get(), "docs", docs.get())?;
  }

  // afterOperation - Collection
  let p = build_after_operation(args, collection_config, "find", override_access, result)?;
  result = await_js(p).await?;

  Ok(result)
}

/// The values the per-doc async arrows close over.
struct DocCtx {
  collection_config: Val,
  current_depth: Val,
  depth: Val,
  drafts_enabled: Val,
  fallback_locale: Val,
  full_where: Val,
  locale: Val,
  override_access: Val,
  populate: Val,
  req: Val,
  select: Val,
  show_hidden_fields: Val,
}

impl DocCtx {
  fn hooks(&self, hook_name: &'static str) -> ReadHooks {
    ReadHooks {
      collection_config: self.collection_config.clone(),
      hook_name,
      find_many: false,
      override_access: self.override_access.clone(),
      query: self.full_where.clone(),
      req: self.req.clone(),
    }
  }
}
