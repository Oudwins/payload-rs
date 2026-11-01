//! The non-polymorphic `join` field branch of `find/traverseFields.ts`:
//! builds the `extras` projections (`<column>` documents and the optional
//! `<column>_count`) as drizzle renders them.

use payload_engine::error::{EngineError, Result};
use payload_engine::fields::has_drafts_enabled;
use payload_engine::js::{JsVal, Obj, num_to_json};
use payload_engine::strings::to_snake_case;

use crate::args::Extra;
use crate::context::{BuildQueryArgs, ColumnRef, FieldsSource, FindContext, QueryJoin, SelectField, raw_constraint};
use payload_sql_query::WhereVal;
use crate::schema::{Decoder, DrizzleSchema};
use crate::sql::{Sql, escape_name};
use crate::utils::{append_version_to_query_key, build_version_collection_fields, combine_queries, get_query_drafts_sort};

pub(crate) struct JoinFieldArgs<'a> {
  pub collection_slug: Option<&'a str>,
  pub current_table_name: &'a str,
  pub drafts_enabled: bool,
  pub field: &'a JsVal,
  /// The look-ahead limit (`limitArg + 1`, or `0`).
  pub limit: f64,
  pub locale: Option<&'a str>,
  pub page: &'a JsVal,
  pub parent_is_localized: bool,
  pub path: &'a str,
  pub should_count: bool,
  pub sort: &'a JsVal,
  pub versions: bool,
  pub where_: &'a JsVal,
}

fn obj(entries: Vec<(String, JsVal)>) -> JsVal {
  JsVal::obj(entries.into_iter().collect::<Obj>())
}

/// Renders `db.select(fields)` selection (sqlite `buildSelection`): bare column names when the
/// query has no joins (`isSingleTable`), qualified otherwise; `SQLiteNumericBigInt` columns are
/// selected as `cast(<column> as text)`.
pub(crate) fn render_selection<'s>(
  schema: &DrizzleSchema,
  fields: impl Iterator<Item = &'s SelectField>,
  single_table: bool,
) -> Sql {
  let parts: Vec<Sql> = fields
    .map(|f| match f {
      SelectField::Column(c) => {
        let column = if single_table { Sql::ident(&c.name) } else { c.qualified() };
        let decoder = schema.column_by_db_name(&c.table_name, &c.name).map(|column| column.decoder);
        if decoder == Some(Decoder::NumericBigInt) {
          let mut cast = Sql::raw("cast(");
          cast.push(&column).push_str(" as text)");
          cast
        } else {
          column
        }
      }
      SelectField::Sql(s) => s.clone(),
    })
    .collect();
  Sql::join(parts.iter(), ", ")
}

/// ` left join <table> on <condition>` for every join (`buildJoins`).
pub(crate) fn render_joins(joins: &[QueryJoin]) -> Sql {
  let mut out = Sql::new();
  for join in joins {
    out.push_str(" ").push_str(join.join_type.as_str()).push_str(" join ").push(&join.table);
    out.push_str(" on ").push(&join.condition);
  }
  out
}

fn num_param(n: f64) -> Sql {
  Sql::param(num_to_json(n))
}

/// Returns the extras to assign, in TS assignment order.
pub(crate) fn build_join_field(ctx: &FindContext<'_>, a: &JoinFieldArgs<'_>) -> Result<Vec<(String, Extra)>> {
  let field = a.field;
  let collection = field.get("collection").to_js_string();
  let collection_config = ctx.collections.get(&collection).get("config");
  if collection_config.is_undefined() {
    return Err(EngineError::new("TypeError", "Cannot read properties of undefined (reading 'config')"));
  }
  let use_drafts = (a.versions || a.drafts_enabled) && has_drafts_enabled(collection_config);
  let (fields, fields_source) = if use_drafts {
    (build_version_collection_fields(ctx.config, collection_config), FieldsSource::CollectionVersions(collection.clone()))
  } else {
    (collection_config.get("flattenedFields").clone(), FieldsSource::Collection(collection.clone()))
  };
  let join_table_key = if use_drafts {
    format!("_{}{}", to_snake_case(&collection), ctx.options.versions_suffix)
  } else {
    to_snake_case(&collection)
  };
  let join_collection_table_name =
    ctx.table_name_map.get(&join_table_key).cloned().unwrap_or_else(|| "undefined".to_string());

  let current_table = ctx.schema.table(a.current_table_name)?;
  let id_key = if a.versions { "parent" } else { "id" };
  let current_id_column = current_table
    .columns
    .get(id_key)
    .ok_or_else(|| EngineError::new("TypeError", "Cannot read properties of undefined (reading 'table')"))?;
  let current_id_raw = format!("\"{}\".\"{}\"", current_table.db_name, current_id_column.name);

  let on = field.get("on").to_js_string();
  let mut join_query_where = if field.get("targetField").get("relationTo").as_arr().is_some() {
    let relation_to = WhereVal::Js(a.collection_slug.map(JsVal::str).unwrap_or(JsVal::Undefined));
    let equals = WhereVal::obj(vec![("relationTo", relation_to), ("value", raw_constraint(&current_id_raw))]);
    WhereVal::obj(vec![(on, WhereVal::obj(vec![("equals", equals)]))])
  } else {
    WhereVal::obj(vec![(on, WhereVal::obj(vec![("equals", raw_constraint(&current_id_raw))]))])
  };
  if a.where_.truthy() && crate::utils::js_object_keys_len(a.where_) > 0 {
    join_query_where = WhereVal::obj(vec![("and", WhereVal::Arr(vec![join_query_where, WhereVal::Js(a.where_.clone())]))]);
  }
  if use_drafts {
    let latest = obj(vec![("latest".into(), obj(vec![("equals".into(), JsVal::Bool(true))]))]);
    join_query_where = combine_queries(&append_version_to_query_key(&join_query_where)?, &latest);
  }

  let column_name = format!("{}{}", a.path.replace('.', "_"), field.get("name").to_js_string());
  let sub_query_alias = format!("{column_name}_alias");
  let alias = ctx.query.table_alias(&join_collection_table_name)?;

  let sort = if use_drafts { get_query_drafts_sort(collection_config, a.sort) } else { a.sort.clone() };
  let built = ctx.query.build_query(&BuildQueryArgs {
    table_name: &join_collection_table_name,
    alias_table: Some(&alias),
    fields: &fields,
    fields_source,
    locale: a.locale,
    parent_is_localized: a.parent_is_localized,
    select_locale: true,
    sort: &sort,
    where_: &join_query_where,
  })?;

  let join_table = ctx.schema.table(&join_collection_table_name)?;
  let alias_column = |key: &str| -> Result<SelectField> {
    let column = join_table
      .columns
      .get(key)
      .ok_or_else(|| EngineError::new("TypeError", format!("Cannot convert undefined or null to object ({key})")))?;
    Ok(SelectField::Column(ColumnRef {
      table: alias.clone(),
      table_name: join_table.db_name.clone(),
      name: column.name.clone(),
      primary: key == "id",
    }))
  };

  let mut select_fields = built.select_fields.clone();
  let snapshot: Vec<String> = select_fields.keys().cloned().collect();
  for key in snapshot {
    let Some(SelectField::Column(column)) = select_fields.get(&key) else { continue };
    if column.table == join_table.db_name {
      select_fields.shift_remove(&key);
      let new_key = key.rsplit('.').next().unwrap_or(&key).to_string();
      let value = alias_column(&new_key)?;
      select_fields.insert(new_key, value);
    }
  }
  if use_drafts {
    let value = alias_column("parent")?;
    select_fields.insert("parent".into(), value);
  }

  let single_table = built.joins.is_empty();
  let from = {
    let mut s = Sql::ident(&join_table.db_name);
    s.push_str(" ").push(&Sql::ident(&alias));
    s
  };
  let base_query = |order: bool, limit_offset: bool| -> Sql {
    let mut q = Sql::raw("select ");
    q.push(&render_selection(ctx.schema, select_fields.values(), single_table)).push_str(" from ").push(&from);
    q.push(&render_joins(&built.joins));
    if let Some(w) = &built.where_ {
      q.push_str(" where ").push(w);
    }
    if order && !built.order_by.is_empty() {
      let exprs: Vec<Sql> = built.order_by.iter().map(|o| o.expr.clone()).collect();
      q.push_str(" order by ").push(&Sql::join(exprs.iter(), ", "));
    }
    if limit_offset {
      let mut offset = None;
      if a.page.truthy() && a.limit != 0.0 {
        let page = a.page.as_num().unwrap_or(f64::NAN);
        let o = (page - 1.0) * a.limit - 1.0;
        if o > 0.0 {
          offset = Some(o);
        }
      }
      if a.limit != 0.0 && a.limit >= 0.0 {
        q.push_str(" limit ").push(&num_param(a.limit));
      }
      if let Some(o) = offset {
        q.push_str(" offset ").push(&num_param(o));
      }
    }
    q
  };

  let mut out = Vec::new();
  if a.should_count {
    let mut count = Sql::raw("(select count(*) from (");
    count.push(&base_query(false, false)).push_str(") ");
    count.push(&Sql::ident(&format!("{sub_query_alias}_count_subquery"))).push_str(")");
    out.push((format!("{column_name}_count"), Extra { sql: count, alias: format!("{sub_query_alias}_count") }));
  }

  let quoted_alias = escape_name(&sub_query_alias);
  let mut object = format!("'id',{quoted_alias}.{}", if use_drafts { "parent_id" } else { "id" });
  if let Some(SelectField::Column(locale)) = select_fields.get("_locale") {
    object.push_str(&format!(",'locale',{quoted_alias}.{}", locale.name));
  }
  let mut docs = Sql::raw(format!("(select coalesce(json_group_array(json_object({object})), '[]') from ("));
  docs.push(&base_query(true, true)).push_str(") ").push_str(&quoted_alias).push_str(")");
  out.push((column_name, Extra { sql: docs, alias: sub_query_alias }));
  Ok(out)
}
