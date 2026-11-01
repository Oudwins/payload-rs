//! `database/queryValidation/*`: `validateQueryPaths`, `validateSearchParam`,
//! `validateSortQuery`. Each TS `async` function is a task on [`Rt`], with
//! awaits, `Promise.all` and host calls at the same points as upstream, so
//! the order of host calls, `errors` pushes and `where` mutations matches.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use payload_engine::fields::field_affects_data;
use payload_engine::js::JsVal;
use payload_sql_read::Val;

use crate::config::QueryConfig;
use crate::host::{EntityPermissionsCall, EntityType, Host};
use crate::js::{
  Errors, JsError, JsResult, delete, for_in_keys, get, get_opt, has_in, for_in_present, is_and_or, is_nested_relationship_query,
  is_object_type, is_safe_field_path, new_obj, set,
};
use crate::paths::{LocalizedPathsArgs, PathToQuery, cfg_get, collection_config, get_localized_paths};
use crate::rt::{Promise, Rt};
use crate::where_query::{HAS_MANY_RELATIONSHIP_OPERATORS, prefix_where_paths};

/// `validOperators`
pub const VALID_OPERATORS: [&str; 16] = [
  "equals",
  "contains",
  "not_equals",
  "in",
  "all",
  "not_in",
  "exists",
  "greater_than",
  "greater_than_equal",
  "less_than",
  "less_than_equal",
  "like",
  "not_like",
  "within",
  "intersects",
  "near",
];

/// Everything an operation shares with the query utilities: the job queue,
/// the host, `req.payload` and `req.locale`.
#[derive(Clone)]
pub struct Ctx {
  pub rt: Rt,
  pub host: Rc<dyn Host>,
  pub payload: Rc<QueryConfig>,
  /// `req.locale`
  pub locale: Val,
  next_object_id: Rc<Cell<u64>>,
}

impl Ctx {
  pub fn new(rt: Rt, host: Rc<dyn Host>, payload: Rc<QueryConfig>, locale: Val) -> Self {
    Self { rt, host, payload, locale, next_object_id: Rc::new(Cell::new(0)) }
  }

  fn new_object_id(&self) -> u64 {
    let id = self.next_object_id.get() + 1;
    self.next_object_id.set(id);
    id
  }
}

fn new_errors() -> Errors {
  Rc::new(RefCell::new(Vec::new()))
}

fn push_error(errors: &Errors, path: impl Into<String>) {
  errors.borrow_mut().push(path.into());
}

fn default_policies() -> Val {
  new_obj([("collections".to_string(), Val::new_obj()), ("globals".to_string(), Val::new_obj())])
}

fn field_type(field: &JsVal) -> JsResult<Option<String>> {
  Ok(cfg_get(field, "type")?.as_str().map(str::to_string))
}

fn is_rel_or_upload_type(t: Option<&str>) -> bool {
  matches!(t, Some("relationship" | "upload"))
}

/// `(globalConfig || collectionConfig)` / `(collectionConfig || globalConfig)`
fn first_truthy<'a>(a: &'a JsVal, b: &'a JsVal) -> &'a JsVal {
  if a.truthy() { a } else { b }
}

#[derive(Clone, Default)]
pub struct ValidateQueryPathsArgs {
  pub collection_config: JsVal,
  pub global_config: JsVal,
  pub errors: Option<Errors>,
  pub override_access: bool,
  pub policies: Option<Val>,
  pub polymorphic_join: bool,
  pub show_hidden_fields: bool,
  pub version_fields: JsVal,
  pub where_: Val,
}

/// `validateQueryPaths(args)`; rejects with a `QueryError` (or the first error thrown).
pub fn validate_query_paths(ctx: &Ctx, args: ValidateQueryPathsArgs) -> Promise {
  let c = ctx.clone();
  ctx.rt.spawn(async move { validate_query_paths_body(c, args).await.map(|_| Val::Undefined) })
}

async fn validate_query_paths_body(ctx: Ctx, args: ValidateQueryPathsArgs) -> JsResult<()> {
  let errors = args.errors.clone().unwrap_or_else(new_errors);
  let policies = args.policies.clone().unwrap_or_else(default_policies);
  let fields = if args.version_fields.truthy() {
    args.version_fields.clone()
  } else {
    cfg_get(first_truthy(&args.global_config, &args.collection_config), "flattenedFields")?.clone()
  };
  let where_ = &args.where_;

  if !is_object_type(where_) {
    return Ok(());
  }

  let mut promises = Vec::new();
  for path in for_in_keys(where_) {
    if !for_in_present(where_, &path) {
      continue;
    }
    let constraint = get(where_, &path)?;

    if is_and_or(&path)
      && let Val::Arr(items) = &constraint
    {
      let items = items.borrow().to_vec();
      for item in items {
        let collection = args.collection_config.truthy();
        promises.push(validate_query_paths(
          &ctx,
          ValidateQueryPathsArgs {
            collection_config: if collection { args.collection_config.clone() } else { JsVal::Undefined },
            global_config: if collection { JsVal::Undefined } else { args.global_config.clone() },
            errors: Some(errors.clone()),
            override_access: args.override_access,
            policies: Some(policies.clone()),
            polymorphic_join: args.polymorphic_join,
            show_hidden_fields: args.show_hidden_fields,
            version_fields: args.version_fields.clone(),
            where_: item,
          },
        ));
      }
    } else if matches!(constraint, Val::Arr(_)) {
      push_error(&errors, path.clone());
    } else {
      for operator in for_in_keys(&constraint) {
        if !for_in_present(&constraint, &operator) {
          continue;
        }
        let val = get(&constraint, &operator)?;
        if VALID_OPERATORS.contains(&operator.as_str()) {
          promises.push(validate_search_param(
            &ctx,
            SearchParamArgs {
              collection_config: args.collection_config.clone(),
              constraint: where_.clone(),
              errors: errors.clone(),
              fields: fields.clone(),
              global_config: args.global_config.clone(),
              operator,
              override_access: args.override_access,
              parent_is_localized: None,
              path: path.clone(),
              policies: policies.clone(),
              polymorphic_join: args.polymorphic_join,
              show_hidden_fields: args.show_hidden_fields,
              val,
              version_fields: args.version_fields.clone(),
            },
          ));
        } else {
          push_error(&errors, format!("{path}.{operator}"));
        }
      }
    }
  }

  ctx.rt.await_promise(&ctx.rt.all(&promises)).await?;
  if !errors.borrow().is_empty() {
    return Err(JsError::query(&errors));
  }
  Ok(())
}

#[derive(Clone)]
pub struct SearchParamArgs {
  pub collection_config: JsVal,
  pub constraint: Val,
  pub errors: Errors,
  pub fields: JsVal,
  pub global_config: JsVal,
  pub operator: String,
  pub override_access: bool,
  pub parent_is_localized: Option<bool>,
  pub path: String,
  pub policies: Val,
  pub polymorphic_join: bool,
  pub show_hidden_fields: bool,
  pub val: Val,
  pub version_fields: JsVal,
}

/// `validateSearchParam(args)`
pub fn validate_search_param(ctx: &Ctx, args: SearchParamArgs) -> Promise {
  let c = ctx.clone();
  ctx.rt.spawn(async move { validate_search_param_body(c, args).await.map(|_| Val::Undefined) })
}

async fn validate_search_param_body(ctx: Ctx, args: SearchParamArgs) -> JsResult<()> {
  let incoming_path = args.path.clone();
  let sanitized_path = if incoming_path == "_id" { "id".to_string() } else { incoming_path.replace("__", ".") };
  let entity = first_truthy(&args.collection_config, &args.global_config).clone();
  if entity.is_nullish() {
    return Err(JsError::type_error(format!(
      "Cannot destructure property 'slug' of '(collectionConfig || globalConfig)' as it is {}.",
      entity.to_js_string()
    )));
  }
  let slug = entity.get("slug").to_js_string();
  let block_references_permissions = ctx.new_object_id();

  if args.global_config.truthy() {
    let globals = get(&args.policies, "globals")?;
    if !get(&globals, &slug)?.truthy() {
      let promise = ctx.host.get_entity_permissions(
        &ctx.rt,
        EntityPermissionsCall {
          entity_type: EntityType::Global,
          entity: args.global_config.clone(),
          block_references_permissions,
          isolated_transaction_id: false,
        },
      );
      let permissions = ctx.rt.await_promise(&promise).await?;
      set(&globals, &slug, permissions)?;
    }
  }

  let mut paths: Vec<PathToQuery> = Vec::new();
  if sanitized_path != "id" {
    paths = get_localized_paths(
      &ctx.payload,
      LocalizedPathsArgs {
        collection_slug: args.collection_config.get("slug").clone(),
        fields: &args.fields,
        global_slug: args.global_config.get("slug").clone(),
        incoming_path: &sanitized_path,
        locale: &ctx.locale,
        override_access: args.override_access,
        parent_is_localized: args.parent_is_localized,
        show_hidden_fields: args.show_hidden_fields,
      },
    )?;
  }

  let promises: Rc<RefCell<Vec<Promise>>> = Rc::new(RefCell::new(Vec::new()));
  let operator = args.operator.as_str();

  let relationship_field = if paths.len() == 1 { paths[0].field.clone() } else { JsVal::Undefined };
  let has_nested_where = is_nested_relationship_query(&args.val);
  let related_collection_slug = match relationship_field.get("relationTo") {
    JsVal::Str(s)
      if relationship_field.truthy()
        && is_rel_or_upload_type(relationship_field.get("type").as_str())
        && relationship_field.get("hasMany").truthy() =>
    {
      Some(s.to_string())
    }
    _ => None,
  };
  let is_nested_has_many_query = HAS_MANY_RELATIONSHIP_OPERATORS.contains(&operator)
    && has_nested_where
    && related_collection_slug.as_ref().is_some_and(|s| !s.is_empty());

  if matches!(operator, "like" | "not_like" | "contains") {
    let is_legitimate_nested_contains = operator == "contains" && is_nested_has_many_query;
    let contains_plain_object = has_nested_where
      || matches!(&args.val, Val::Arr(items) if items.borrow().iter().any(is_nested_relationship_query));
    if contains_plain_object && !is_legitimate_nested_contains {
      push_error(&args.errors, incoming_path.clone());
      return Ok(());
    }
  }

  if is_nested_has_many_query
    && let Some(related) = related_collection_slug.as_deref().filter(|s| !s.is_empty())
  {
    let config = collection_config(&ctx.payload, related)?;
    promises.borrow_mut().push(validate_query_paths(
      &ctx,
      ValidateQueryPathsArgs {
        collection_config: config,
        errors: Some(args.errors.clone()),
        override_access: args.override_access,
        policies: Some(args.policies.clone()),
        show_hidden_fields: args.show_hidden_fields,
        where_: args.val.clone(),
        ..Default::default()
      },
    ));
  }

  if paths.last().is_some_and(|p| p.path == "id") && paths.len() >= 2 {
    let previous_field = &paths[paths.len() - 2].field;
    if previous_field.truthy()
      && is_rel_or_upload_type(previous_field.get("type").as_str())
      && matches!(previous_field.get("relationTo"), JsVal::Str(_))
    {
      paths.pop();
    }
  }

  let paths = Rc::new(paths);
  let args = Rc::new(args);
  let incoming_path: Rc<str> = Rc::from(incoming_path.as_str());
  let mapped: Vec<Promise> = (0..paths.len())
    .map(|i| {
      let (ctx2, paths, args, promises, incoming_path) =
        (ctx.clone(), paths.clone(), args.clone(), promises.clone(), incoming_path.clone());
      ctx.rt.spawn(async move {
        path_callback(ctx2, paths, i, args, promises, is_nested_has_many_query, &incoming_path, block_references_permissions)
          .await
          .map(|_| Val::Undefined)
      })
    })
    .collect();
  promises.borrow_mut().extend(mapped);

  let snapshot = promises.borrow().clone();
  ctx.rt.await_promise(&ctx.rt.all(&snapshot)).await?;
  Ok(())
}

/// The `paths.map(async ({ collectionSlug, field, invalid, path }, i) => ...)` callback.
async fn path_callback(
  ctx: Ctx,
  paths: Rc<Vec<PathToQuery>>,
  i: usize,
  args: Rc<SearchParamArgs>,
  promises: Rc<RefCell<Vec<Promise>>>,
  is_nested_has_many_query: bool,
  incoming_path: &str,
  block_references_permissions: u64,
) -> JsResult<()> {
  let PathToQuery { collection_slug, field, invalid, path, .. } = paths[i].clone();
  let errors = &args.errors;
  let operator = args.operator.as_str();

  if invalid {
    let is_unknown_polymorphic_join_field =
      args.polymorphic_join && !field.truthy() && is_safe_field_path(incoming_path);
    if !is_unknown_polymorphic_join_field {
      push_error(errors, path);
    }
    return Ok(());
  }

  let ftype = field_type(&field)?;
  if ftype.as_deref() == Some("join") && path == incoming_path {
    let moved = get(&args.constraint, &path)?;
    set(&args.constraint, &format!("{path}.id"), moved)?;
    delete(&args.constraint, &path)?;
  }

  if field.has("virtual") && field.get("virtual").truthy() && field.get("virtual").is_true() {
    push_error(errors, path.clone());
  }

  if args.polymorphic_join && path == "relationTo" {
    return Ok(());
  }

  if !args.override_access && field_affects_data(&field) {
    if collection_slug.truthy() {
      let slug = collection_slug.to_js_string();
      let collections = get(&args.policies, "collections")?;
      if !get(&collections, &slug)?.truthy() {
        let entity = collection_config(&ctx.payload, &slug)?;
        let promise = ctx.host.get_entity_permissions(
          &ctx.rt,
          EntityPermissionsCall {
            entity_type: EntityType::Collection,
            entity,
            block_references_permissions,
            isolated_transaction_id: true,
          },
        );
        let permissions = ctx.rt.await_promise(&promise).await?;
        set(&collections, &slug, permissions)?;
      }

      if (incoming_path == "hash" || incoming_path == "salt") && {
        let auth = cfg_get(&args.collection_config, "auth")?;
        auth.truthy() && !auth.get("disableLocalStrategy").truthy()
      } {
        push_error(errors, incoming_path);
      }

      let related_read = get(&get(&get(&args.policies, "collections")?, &slug)?, "read")?;
      let traversed_field = if i > 0 { paths[i - 1].field.clone() } else { JsVal::Undefined };
      let traversed_type = traversed_field.get("type").as_str().map(str::to_string);
      let is_relationship_hop = traversed_field.truthy()
        && matches!(traversed_type.as_deref(), Some("relationship" | "upload" | "join"));

      if is_relationship_hop
        && related_read.truthy()
        && is_object_type(&related_read)
        && get(&related_read, "where")?.truthy()
      {
        let relationship_path = paths[..i].iter().map(|p| p.path.as_str()).collect::<Vec<_>>().join(".");
        let constraint = &args.constraint;
        let existing_and = match get(constraint, "and")? {
          Val::Arr(a) => a.borrow().to_vec(),
          _ => Vec::new(),
        };
        let is_has_many_relationship =
          is_rel_or_upload_type(traversed_type.as_deref()) && traversed_field.get("hasMany").truthy();
        let is_join = traversed_type.as_deref() == Some("join");

        if is_has_many_relationship || is_join {
          let related_field_path = paths.last().map(|p| p.path.clone()).unwrap_or_default();
          if !related_field_path.is_empty() {
            let user_filter =
              new_obj([(related_field_path, new_obj([(operator.to_string(), args.val.clone())]))]);
            let scoped = new_obj([(
              relationship_path,
              new_obj([(
                "contains".to_string(),
                new_obj([("and".to_string(), Val::new_arr(vec![user_filter, get(&related_read, "where")?]))]),
              )]),
            )]);
            let mut and = existing_and;
            and.push(scoped);
            set(constraint, "and", Val::new_arr(and))?;
            delete(constraint, incoming_path)?;
          }
        } else {
          let access_where = prefix_where_paths(&relationship_path, &get(&related_read, "where")?)?;
          let mut and = existing_and;
          and.push(access_where);
          set(constraint, "and", Val::new_arr(and))?;
        }
      }
    }

    let mut field_path = path.clone();
    let locale_suffix = format!(".{}", ctx.locale.to_js_string());
    if path.ends_with(&locale_suffix) {
      if !ctx.locale.is_string() {
        return Err(JsError::type_error(format!(
          "Cannot read properties of {} (reading 'length')",
          ctx.locale.to_js_string()
        )));
      }
      field_path = path[..path.len() - locale_suffix.len()].to_string();
    }
    if is_rel_or_upload_type(ftype.as_deref()) && matches!(field.get("relationTo"), JsVal::Arr(_)) {
      field_path = field_path.replacen(".value", "", 1);
    }

    let entity_type = if args.global_config.truthy() { "globals" } else { "collections" };
    let entity_slug = if collection_slug.truthy() {
      collection_slug.to_js_string()
    } else {
      cfg_get(&args.global_config, "slug")?.to_js_string()
    };
    let mut segments: Vec<&str> = field_path.split('.').collect();

    let mut field_access = get(&get(&get(&args.policies, entity_type)?, &entity_slug)?, "fields")?;
    if args.version_fields.truthy() && matches!(segments[0], "parent" | "version" | "snapshot" | "latest") {
      segments.remove(0);
    }

    if !segments.is_empty() {
      for segment in &segments {
        let entry = get(&field_access, segment)?;
        if entry.truthy() {
          field_access = if has_in(&entry, "fields")? { get(&entry, "fields")? } else { entry };
        }
      }
      if !get_opt(&get_opt(&field_access, "read"), "permission").truthy() {
        push_error(errors, field_path.clone());
      }
    }
  }

  if !is_nested_has_many_query && i > 1 {
    // `paths.slice(1).reverse()`, only index 0 (the deepest path) is used
    if let Some(deepest) = paths.last() {
      let config = collection_config(&ctx.payload, &deepest.collection_slug.to_js_string())?;
      let where_ = new_obj([(deepest.path.clone(), new_obj([(operator.to_string(), args.val.clone())]))]);
      let promise = validate_query_paths(
        &ctx,
        ValidateQueryPathsArgs {
          collection_config: config,
          errors: Some(errors.clone()),
          override_access: args.override_access,
          policies: Some(args.policies.clone()),
          show_hidden_fields: args.show_hidden_fields,
          where_,
          ..Default::default()
        },
      );
      promises.borrow_mut().push(promise);
    }
  }

  Ok(())
}

#[derive(Clone, Default)]
pub struct ValidateSortQueryArgs {
  pub collection_config: JsVal,
  pub global_config: JsVal,
  pub override_access: bool,
  pub sort: Val,
  pub version_fields: JsVal,
}

/// `validateSortQuery(args)`
pub fn validate_sort_query(ctx: &Ctx, args: ValidateSortQueryArgs) -> Promise {
  let c = ctx.clone();
  ctx.rt.spawn(async move { validate_sort_query_body(c, args).await.map(|_| Val::Undefined) })
}

async fn validate_sort_query_body(ctx: Ctx, args: ValidateSortQueryArgs) -> JsResult<()> {
  if args.override_access || !args.sort.truthy() {
    return Ok(());
  }
  let fields = if args.version_fields.truthy() {
    args.version_fields.clone()
  } else {
    cfg_get(first_truthy(&args.global_config, &args.collection_config), "flattenedFields")?.clone()
  };
  let sort_fields = match &args.sort {
    Val::Arr(a) => a.borrow().to_vec(),
    other => vec![other.clone()],
  };
  let where_ = Val::new_obj();

  for sort_field in &sort_fields {
    let path = match sort_field {
      Val::Str(s) => {
        let s = s.to_lossy();
        s.strip_prefix('-').unwrap_or(&s).replace("__", ".")
      }
      Val::Undefined | Val::Null => {
        return Err(JsError::type_error(format!(
          "Cannot read properties of {} (reading 'replace')",
          sort_field.to_js_string()
        )));
      }
      _ => return Err(JsError::type_error("sortField.replace is not a function")),
    };
    let paths = get_localized_paths(
      &ctx.payload,
      LocalizedPathsArgs {
        collection_slug: args.collection_config.get("slug").clone(),
        fields: &fields,
        global_slug: args.global_config.get("slug").clone(),
        incoming_path: &path,
        locale: &ctx.locale,
        override_access: true,
        parent_is_localized: None,
        show_hidden_fields: false,
      },
    )?;
    if path != "id" && path != "_id" && paths.iter().all(|p| !p.invalid) {
      set(&where_, &path, new_obj([("exists".to_string(), Val::Bool(true))]))?;
    }
  }

  if for_in_keys(&where_).is_empty() {
    return Ok(());
  }

  let collection = args.collection_config.truthy();
  let promise = validate_query_paths(
    &ctx,
    ValidateQueryPathsArgs {
      collection_config: if collection { args.collection_config.clone() } else { JsVal::Undefined },
      global_config: if collection { JsVal::Undefined } else { args.global_config.clone() },
      override_access: args.override_access,
      version_fields: args.version_fields.clone(),
      where_,
      ..Default::default()
    },
  );
  ctx.rt.await_promise(&promise).await?;
  Ok(())
}
