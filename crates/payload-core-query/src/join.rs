//! `database/sanitizeJoinQuery.ts`

use std::cell::RefCell;
use std::rc::Rc;

use payload_engine::js::JsVal;
use payload_sql_read::Val;

use crate::host::ExecuteAccessCall;
use crate::js::{Errors, JsError, JsResult, deep_copy_simple, from_config, get, is_object_type, set};
use crate::paths::{cfg_get, collection_config};
use crate::rt::Promise;
use crate::validate::{Ctx, ValidateQueryPathsArgs, ValidateSortQueryArgs, validate_query_paths, validate_sort_query};
use crate::where_query::{combine_queries, sanitize_where_query};

/// `sanitizeJoinQuery({ collectionConfig, joins, overrideAccess, req })`;
/// resolves with the (mutated) joins query or `false`.
pub fn sanitize_join_query(ctx: &Ctx, collection_config: JsVal, joins: Val, override_access: bool) -> Promise {
  let c = ctx.clone();
  ctx.rt.spawn(async move { sanitize_join_query_body(c, collection_config, joins, override_access).await })
}

async fn sanitize_join_query_body(ctx: Ctx, config: JsVal, joins: Val, override_access: bool) -> JsResult<Val> {
  if matches!(joins, Val::Bool(false)) {
    return Ok(Val::Bool(false));
  }
  let joins_query = if joins.truthy() { joins } else { Val::new_obj() };
  let errors: Errors = Rc::new(RefCell::new(Vec::new()));
  let promises: Rc<RefCell<Vec<Promise>>> = Rc::new(RefCell::new(Vec::new()));

  let config_joins = config.get("joins");
  if let JsVal::Obj(map) = config_joins {
    for (collection_slug, list) in map.iter() {
      for join in iterate(list, "collectionConfig.joins[collectionSlug]")? {
        let p = sanitize_join_field_query(&ctx, collection_slug, &errors, &join, &joins_query, override_access, &promises);
        ctx.rt.await_promise(&p).await?;
      }
    }
  }

  for join in iterate(config.get("polymorphicJoins"), "collectionConfig.polymorphicJoins")? {
    let collections = cfg_get(&join, "field")?.get("collection").clone();
    for collection_slug in iterate(&collections, "join.field.collection")? {
      let slug = collection_slug.to_js_string();
      let p = sanitize_join_field_query(&ctx, &slug, &errors, &join, &joins_query, override_access, &promises);
      ctx.rt.await_promise(&p).await?;
    }
  }

  let snapshot = promises.borrow().clone();
  ctx.rt.await_promise(&ctx.rt.all(&snapshot)).await?;
  if !errors.borrow().is_empty() {
    return Err(JsError::query(&errors));
  }
  Ok(joins_query)
}

/// `for (const x of value)` over a config value.
fn iterate(value: &JsVal, source: &str) -> JsResult<Vec<JsVal>> {
  match value {
    JsVal::Arr(a) => Ok(a.iter().cloned().collect()),
    JsVal::Str(s) => Ok(s.chars().map(|c| JsVal::str(c.to_string())).collect()),
    _ => Err(JsError::type_error(format!("{source} is not iterable"))),
  }
}

fn sanitize_join_field_query(
  ctx: &Ctx,
  collection_slug: &str,
  errors: &Errors,
  join: &JsVal,
  joins_query: &Val,
  override_access: bool,
  promises: &Rc<RefCell<Vec<Promise>>>,
) -> Promise {
  let (c, slug, errors, join, joins_query, promises) =
    (ctx.clone(), collection_slug.to_string(), errors.clone(), join.clone(), joins_query.clone(), promises.clone());
  ctx.rt.spawn(async move {
    let ctx = c;
    let join_path = join.get("joinPath").to_js_string();

    if matches!(get(&joins_query, &join_path)?, Val::Bool(false)) {
      return Ok(Val::Undefined);
    }

    let join_collection_config = collection_config(&ctx.payload, &slug)?;

    let access_result = if !override_access {
      let access = cfg_get(join_collection_config.get("access"), "read")?.clone();
      let promise = ctx.host.execute_access(
        &ctx.rt,
        ExecuteAccessCall { slug: join_collection_config.get("slug").to_js_string(), access },
      );
      ctx.rt.await_promise(&promise).await?
    } else {
      Val::Bool(true)
    };

    if matches!(access_result, Val::Bool(false)) {
      set(&joins_query, &join_path, Val::Bool(false))?;
      return Ok(Val::Undefined);
    }

    if !get(&joins_query, &join_path)?.truthy() {
      set(&joins_query, &join_path, Val::new_obj())?;
    }
    let join_query = get(&joins_query, &join_path)?;

    if !get(&join_query, "where")?.truthy() {
      set(&join_query, "where", Val::new_obj())?;
    }

    let field = join.get("field");
    if field.get("where").truthy() {
      let combined = combine_queries(&get(&join_query, "where")?, &deep_copy_simple(field.get("where")));
      set(&join_query, "where", combined)?;
    }

    let validate_where = validate_query_paths(
      &ctx,
      ValidateQueryPathsArgs {
        collection_config: join_collection_config.clone(),
        errors: Some(errors.clone()),
        override_access,
        polymorphic_join: matches!(field.get("collection"), JsVal::Arr(_)),
        where_: get(&join_query, "where")?,
        ..Default::default()
      },
    );
    let mut sort = get(&join_query, "sort")?;
    if !sort.truthy() {
      sort = from_config(field.get("defaultSort"));
    }
    if !sort.truthy() {
      sort = from_config(join_collection_config.get("defaultSort"));
    }
    let validate_sort = validate_sort_query(
      &ctx,
      ValidateSortQueryArgs { collection_config: join_collection_config.clone(), override_access, sort, ..Default::default() },
    );
    promises.borrow_mut().extend([validate_where, validate_sort]);

    if is_object_type(&access_result) {
      sanitize_where_query(&ctx.payload, join_collection_config.get("flattenedFields"), &access_result)?;
      let combined = combine_queries(&get(&join_query, "where")?, &access_result);
      set(&join_query, "where", combined)?;
    }
    Ok(Val::Undefined)
  })
}
