//! Port of `packages/payload/src/collections/operations/findVersions.ts`
//! (`findVersionsOperation`).

use std::rc::Rc;

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{
  AccessArgs, HookTarget, ReadHooks, at, build_after_operation, build_before_operation, db_call, execute_access,
  has_hooks, has_hooks_strict, has_versions_enabled, nullish_or, or,
};
use crate::host::{self, ForOf, call, call_val, get, get_val, loop_body, val};
use crate::query;
use crate::utilities::{append_non_trashed_filter, sanitize_internal_fields};

/// `findVersionsOperation(args)`: returns its promise.
pub fn find_versions(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

struct DocCtx {
  collection_config: Val,
  depth: Val,
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
  fn hooks(&self, hook_name: &'static str, find_many: bool) -> ReadHooks {
    ReadHooks {
      collection_config: self.collection_config.clone(),
      hook_name,
      find_many,
      override_access: self.override_access.clone(),
      query: self.full_where.clone(),
      req: self.req.clone(),
    }
  }
}

async fn run(args: Val) -> JsResult<Val> {
  let mut args = args;

  // beforeOperation - Collection
  let collection = get_val(get(args.get(), "collection")?, "config")?;
  let override_access = get_val(args.get(), "overrideAccess")?;
  args = await_js(build_before_operation(args, collection, "findVersions", override_access)?).await?;

  let d = call("findVersionsArgs", &[args.get()])?;
  let collection_config = at(d, 0)?;
  let depth = at(d, 1)?;
  let limit = at(d, 2)?;
  let override_access = at(d, 3)?;
  let page = at(d, 4)?;
  let pagination = at(d, 5)?;
  let populate = at(d, 6)?;
  let incoming_select = at(d, 7)?;
  let show_hidden_fields = at(d, 8)?;
  let sort = at(d, 9)?;
  let trash = at(d, 10)?;
  let where_ = at(d, 11)?;

  let req = get_val(args.get(), "req")?;
  let fallback_locale = get_val(req.get(), "fallbackLocale")?;
  let locale = get_val(req.get(), "locale")?;
  let payload = get_val(req.get(), "payload")?;

  if !has_versions_enabled(collection_config.get())? {
    let t = get(req.get(), "t")?;
    return Err(host::throw_from("notFound", &[t]));
  }

  // Access
  let mut access_results = Val::Undefined;
  if !js::truthy(override_access.get()) {
    let slug = get_val(collection_config.get(), "slug")?;
    let read_versions = get_val(get(collection_config.get(), "access")?, "readVersions")?;
    let p = execute_access(AccessArgs::new(slug, Val::Undefined, req.clone()), read_versions)?;
    access_results = await_js(p).await?;
  }

  let version_fields = call_val("buildVersionFields", &[get(payload.get(), "config")?, collection_config.get()])?;

  let p = query::validate_query_paths(query::QueryPaths {
    collection_config: collection_config.clone(),
    override_access: override_access.clone(),
    req: req.clone(),
    show_hidden_fields: Val::Undefined,
    version_fields: version_fields.clone(),
    where_: where_.clone(),
  })?;
  await_js(p).await?;

  let p = query::validate_sort_query(
    collection_config.clone(),
    override_access.clone(),
    req.clone(),
    sort.clone(),
    version_fields.clone(),
  )?;
  await_js(p).await?;

  let mut full_where = query::combine_queries(where_.get(), access_results.get())?;

  // Exclude trashed documents when trash: false
  let enable_trash = get(collection_config.get(), "trash")?;
  full_where = val(append_non_trashed_filter("version.deletedAt", enable_trash, trash.get(), full_where.get())?)?;

  query::sanitize_where_query(version_fields.get(), payload.get(), full_where.get())?;

  let select =
    call_val("selectVersions", &[version_fields.get(), collection_config.get(), req.get(), incoming_select.get()])?;

  // Find
  let use_pagination = if js::truthy(pagination.get()) {
    Val::Bool(!js::strict_equals(limit.get(), js::number(0.0)))
  } else {
    pagination.clone()
  };
  let sanitized_limit =
    nullish_or(limit.clone(), || Ok(Val::Num(if js::truthy(use_pagination.get()) { 10.0 } else { 0.0 })))?;
  let sanitized_page = or(page.clone(), || Ok(Val::Num(1.0)))?;

  let p = db_call(payload.get(), "findVersions", || {
    call(
      "findVersionsDbArgs",
      &[
        collection_config.get(),
        sanitized_limit.get(),
        locale.get(),
        sanitized_page.get(),
        pagination.get(),
        req.get(),
        select.get(),
        sort.get(),
        full_where.get(),
      ],
    )
  })?;
  let paginated_docs = await_js(p).await?;

  if js::truthy(get(collection_config.get(), "upload")?) && !js::truthy(override_access.get()) {
    let mut rows = ForOf::of(get(paginated_docs.get(), "docs")?, "paginatedDocs.docs")?;
    while let Some(row) = rows.next()? {
      let row = val(row)?;
      let body = async {
        let p = call("checkFileAccessVersion", &[args.get(), row.get(), req.get()])?;
        await_js(p).await?;
        Ok(())
      };
      loop_body(&rows, body).await?;
    }
  }

  let ctx = Rc::new(DocCtx {
    collection_config: collection_config.clone(),
    depth,
    fallback_locale,
    full_where: full_where.clone(),
    locale,
    override_access: override_access.clone(),
    populate,
    req: req.clone(),
    select: select.clone(),
    show_hidden_fields,
  });

  // beforeRead - Collection
  let result = paginated_docs.clone();
  let docs = get(paginated_docs.get(), "docs")?;
  let promises = host::map_array(docs, "paginatedDocs.docs", |doc| {
    let ctx = ctx.clone();
    let doc_ref = val(doc)?;
    spawn(async move {
      // Fallback if not selected
      if !js::truthy(get(doc_ref.get(), "version")?) {
        host::set(doc_ref.get(), "version", js::object())?;
      }
      if has_hooks(ctx.collection_config.get(), "beforeRead")? {
        ctx.hooks("beforeRead", false).run(HookTarget::Version(doc_ref.clone())).await?;
      }
      Ok(doc_ref)
    })
  })?;
  let docs = await_js(host::promise_all(promises)?).await?;
  host::set(result.get(), "docs", docs.get())?;

  // afterRead - Fields
  let docs = get(result.get(), "docs")?;
  let promises = host::map_array(docs, "result.docs", |data| {
    let ctx = ctx.clone();
    let data = val(data)?;
    spawn(async move {
      let after_read_args = call(
        "findVersionsAfterReadArgs",
        &[
          ctx.collection_config.get(),
          ctx.req.get(),
          ctx.depth.get(),
          data.get(),
          ctx.fallback_locale.get(),
          ctx.locale.get(),
          ctx.override_access.get(),
          ctx.populate.get(),
          ctx.select.get(),
          ctx.show_hidden_fields.get(),
        ],
      )?;
      let version = await_js(host::after_read(after_read_args)?).await?;
      host::set(data.get(), "version", version.get())?;
      Ok(data)
    })
  })?;
  let docs = await_js(host::promise_all(promises)?).await?;
  host::set(result.get(), "docs", docs.get())?;

  // afterRead - Collection
  if has_hooks_strict(collection_config.get(), "afterRead")? {
    let docs = get(result.get(), "docs")?;
    let promises = host::map_array(docs, "result.docs", |doc| {
      let ctx = ctx.clone();
      let doc_ref = val(doc)?;
      spawn(async move {
        ctx.hooks("afterRead", true).run(HookTarget::Version(doc_ref.clone())).await?;
        Ok(doc_ref)
      })
    })?;
    let docs = await_js(host::promise_all(promises)?).await?;
    host::set(result.get(), "docs", docs.get())?;
  }

  if js::truthy(get(collection_config.get(), "upload")?) {
    // result.docs = result.docs.map((row) => ({ ...row, version: markHistoricalFileURLs({...}) }))
    let docs = get(result.get(), "docs")?;
    let docs = host::map_array(docs, "result.docs", |row| {
      call("markHistoricalRow", &[row, collection_config.get(), req.get()])
    })?;
    host::set(result.get(), "docs", docs)?;
  }

  // Return results
  // result.docs = result.docs.map((doc) => sanitizeInternalFields(doc))
  let docs = get(result.get(), "docs")?;
  let docs = host::map_array(docs, "result.docs", sanitize_internal_fields)?;
  host::set(result.get(), "docs", docs)?;

  // afterOperation - Collection
  let p = build_after_operation(args, collection_config, "findVersions", override_access, result)?;
  let result = await_js(p).await?;

  Ok(result)
}
