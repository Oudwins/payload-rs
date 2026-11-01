//! Port of `packages/payload/src/globals/operations/findVersions.ts` (`findVersionsOperation`).

use payload_core_ops::common::{AccessArgs, has_versions_enabled};
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::common::{access, db, has_hooks, hooks_of, throw_t};
use crate::host::{call, call_fn, call_val, g, get, gv, loop_body, map_array, path, promise_all, set, truthy, unpack, val};

/// `findVersionsOperation(args)`: returns its promise.
pub fn find_versions(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(run(args))
}

#[derive(Clone)]
struct Ctx {
  depth: Val,
  global_config: Val,
  override_access: Val,
  populate: Val,
  select: Val,
  show_hidden_fields: Val,
  req: Val,
  fallback_locale: Val,
  locale: Val,
  full_where: Val,
}

async fn run(args: Val) -> JsResult<Val> {
  let [
    depth,
    global_config,
    limit,
    override_access,
    page,
    pagination,
    populate,
    incoming_select,
    show_hidden_fields,
    sort,
    where_,
    req,
    fallback_locale,
    locale,
    payload,
  ] = unpack::<15>(call("globalFindVersionsArgs", &[args.get()])?)?;

  if !has_versions_enabled(global_config.get())? {
    return Err(throw_t("notFound", &req));
  }

  let version_fields = call_val("globalVersionFields", &[payload.get(), global_config.get()])?;

  // Access
  let access_results = if !truthy(&override_access) {
    let slug = gv(&global_config, "slug")?;
    let read_versions = path(&global_config, &["access", "readVersions"])?;
    access(AccessArgs::new(slug, Val::Undefined, req.clone()), read_versions).await?
  } else {
    Val::Bool(true)
  };

  let p = call(
    "validateQueryPathsGlobal",
    &[global_config.get(), override_access.get(), req.get(), version_fields.get(), where_.get()],
  )?;
  await_js(p).await?;

  let p = call(
    "validateSortQueryGlobal",
    &[global_config.get(), override_access.get(), req.get(), sort.get(), version_fields.get()],
  )?;
  await_js(p).await?;

  let full_where = call_val("combineQueries", &[where_.get(), access_results.get()])?;

  call("sanitizeWhereQuery", &[version_fields.get(), payload.get(), full_where.get()])?;

  let select = call_val("globalSelectVersionsFresh", &[payload.get(), global_config.get(), req.get(), incoming_select.get()])?;

  // Find
  let paginated_docs = db(&payload, "findGlobalVersions", || {
    call(
      "globalFindVersionsDbArgs",
      &[global_config.get(), limit.get(), locale.get(), page.get(), pagination.get(), req.get(), select.get(), sort.get(), full_where.get()],
    )
  })
  .await?;

  let ctx = Ctx {
    depth,
    global_config: global_config.clone(),
    override_access,
    populate,
    select,
    show_hidden_fields,
    req,
    fallback_locale,
    locale,
    full_where,
  };

  // afterRead - Fields
  let result = call_val("spread", &[paginated_docs.get()])?;
  let docs = g(&paginated_docs, "docs")?;
  let promises = map_array(docs, "paginatedDocs.docs", |data| {
    let data = val(data)?;
    spawn(read_version(data, ctx.clone()))
  })?;
  let docs = await_js(promise_all(promises)?).await?;
  set(result.get(), "docs", docs.get())?;

  // afterRead - Global
  if has_hooks(global_config.get(), "afterRead")? {
    let docs = g(&result, "docs")?;
    let promises = map_array(docs, "result.docs", |doc| {
      let doc = val(doc)?;
      spawn(after_read_hooks(doc, ctx.clone()))
    })?;
    let docs = await_js(promise_all(promises)?).await?;
    set(result.get(), "docs", docs.get())?;
  }

  // Return results
  call_val("sanitizeVersionDocs", &[result.get()])
}

/// `async (data) => { if (!data.version) data.version = {}; return { ...data, version: await
/// afterRead({ ... }) } }`
async fn read_version(data: Val, ctx: Ctx) -> JsResult<Val> {
  if !js::truthy(g(&data, "version")?) {
    // Fallback if not selected
    set(data.get(), "version", js::object())?;
  }
  let out = call_val("spread", &[data.get()])?;
  let p = call(
    "globalFindVersionsAfterRead",
    &[
      data.get(),
      ctx.req.get(),
      ctx.depth.get(),
      ctx.fallback_locale.get(),
      ctx.global_config.get(),
      ctx.locale.get(),
      ctx.override_access.get(),
      ctx.populate.get(),
      ctx.select.get(),
      ctx.show_hidden_fields.get(),
    ],
  )?;
  let version = await_js(p).await?;
  set(out.get(), "version", version.get())?;
  Ok(out)
}

/// `async (doc) => { const docRef = doc; for (const hook of globalConfig.hooks.afterRead) {
/// docRef.version = (await hook({ ... doc: doc.version ... })) || doc.version } return docRef }`
async fn after_read_hooks(doc: Val, ctx: Ctx) -> JsResult<Val> {
  let mut hooks = hooks_of(ctx.global_config.get(), "afterRead")?;
  while let Some(hook) = hooks.next()? {
    let hook = val(hook)?;
    let body = async {
      let context = g(&ctx.req, "context")?;
      let version = g(&doc, "version")?;
      let hook_args = call(
        "globalVersionsHookArgs",
        &[context, version, ctx.global_config.get(), ctx.override_access.get(), ctx.full_where.get(), ctx.req.get()],
      )?;
      let p = call_fn(hook.get(), js::undefined(), &[hook_args], "hook")?;
      let hook_result = await_js(p).await?;
      let value = if js::truthy(hook_result.get()) { hook_result.get() } else { get(doc.get(), "version")? };
      set(doc.get(), "version", value)?;
      Ok(())
    };
    loop_body(&hooks, body).await?;
  }
  Ok(doc)
}
