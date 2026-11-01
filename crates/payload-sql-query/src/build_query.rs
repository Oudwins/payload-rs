//! Ports of `queries/buildQuery.ts` and `queries/buildOrderBy.ts`.

use payload_engine::error::Result;
use payload_engine::js::JsVal;

use crate::adapter::QueryAdapter;
use crate::columns::{ColumnArgs, SelectFields, get_table_column_from_path};
use crate::js_ops::replace_double_underscore;
use crate::parse_params::{ParseArgs, QueryContext, parse_params};
use crate::sql::{Column, Expr, Join, Sql, TableRef};
use crate::where_val::WhereVal;

#[derive(Clone, Debug)]
pub enum Order {
  Asc,
  Desc,
  /// `() => rawSort`
  Raw(Sql),
}

#[derive(Clone, Debug)]
pub struct OrderBy {
  pub column: Column,
  pub order: Order,
}

impl OrderBy {
  /// `order(column)`
  pub fn to_sql(&self) -> Sql {
    let e = Expr::Col(self.column.clone());
    match &self.order {
      Order::Asc => crate::sql::asc(&e),
      Order::Desc => crate::sql::desc(&e),
      Order::Raw(s) => s.clone(),
    }
  }
}

/// `BuildQueryResult`
#[derive(Clone, Debug)]
pub struct BuildQueryResult {
  pub joins: Vec<Join>,
  pub order_by: Vec<OrderBy>,
  pub select_fields: SelectFields,
  pub where_: Option<Sql>,
}

/// Arguments of `buildQuery`.
#[derive(Clone, Debug, Default)]
pub struct BuildQueryArgs {
  pub alias_table: Option<TableRef>,
  /// `FlattenedField[]`
  pub fields: JsVal,
  pub joins: Vec<Join>,
  pub locale: Option<String>,
  pub parent_is_localized: bool,
  pub select_locale: bool,
  /// `Sort`: a string, an array of strings or `undefined`.
  pub sort: JsVal,
  pub table_name: String,
  pub where_: WhereVal,
}

pub struct OrderByArgs<'a> {
  pub alias_table: Option<&'a TableRef>,
  pub fields: &'a JsVal,
  pub locale: Option<String>,
  pub parent_is_localized: bool,
  pub raw_sort: Option<Sql>,
  pub sort: JsVal,
  pub table_name: &'a str,
}

/// `buildOrderBy(args)`
pub fn build_order_by(
  adapter: &QueryAdapter,
  args: OrderByArgs,
  joins: &mut Vec<Join>,
  select_fields: &mut SelectFields,
) -> Result<Vec<OrderBy>> {
  let mut order_by = Vec::new();
  let created_at = adapter.table(Some(args.table_name)).and_then(|t| adapter.column(&t, "createdAt"));

  let mut sort = args.sort;
  if !sort.truthy() {
    sort = JsVal::str(if created_at.is_some() { "-createdAt" } else { "-id" });
  }
  let mut items: Vec<JsVal> = match &sort {
    JsVal::Str(_) => vec![sort.clone()],
    JsVal::Arr(a) => a.to_vec(),
    _ => return Err(crate::adapter::type_error("sort.includes is not a function")),
  };

  let fallback = if created_at.is_some() { "-createdAt" } else { "-id" };
  let has = |s: &str| items.iter().any(|v| v.as_str() == Some(s));
  if !(has(fallback) || has(&fallback.replacen('-', "", 1))) {
    items.push(JsVal::str(fallback));
  }

  for sort_item in items {
    // `sortItem[0] === '-'` throws for nullish items (outside the try block); other non-string
    // items throw inside the try block and are skipped.
    let Some(item) = sort_item.as_str() else {
      match sort_item {
        JsVal::Null => return Err(crate::adapter::type_error("Cannot read properties of null (reading '0')")),
        JsVal::Undefined => return Err(crate::adapter::read_undefined("0")),
        _ => continue,
      }
    };
    let (property, desc) = match item.strip_prefix('-') {
      Some(rest) => (rest.to_string(), true),
      None => (item.to_string(), false),
    };
    let mut column_args = ColumnArgs::new(
      &property,
      args.fields.clone(),
      args.table_name,
      replace_double_underscore(&property).split('.').map(str::to_string).collect(),
      JsVal::str(property.as_str()).into(),
    );
    column_args.locale = args.locale.clone();
    column_args.parent_is_localized = args.parent_is_localized;
    let Ok(tc) = get_table_column_from_path(adapter, column_args, joins, select_fields) else {
      continue;
    };
    let (Some(sort_table), Some(column_name)) = (tc.table.as_ref(), tc.column_name.as_deref()) else { continue };
    let Some(column_to_add) = adapter.column(sort_table, column_name) else { continue };

    let order = match &args.raw_sort {
      Some(raw) => Order::Raw(raw.clone()),
      None if desc => Order::Desc,
      None => Order::Asc,
    };
    let column = match args.alias_table {
      Some(alias) if args.table_name == sort_table.ref_name() => match adapter.column(alias, column_name) {
        Some(c) => c,
        None => continue,
      },
      _ => column_to_add.clone(),
    };
    order_by.push(OrderBy { column, order });

    let already_exists = select_fields.values().any(|v| matches!(v, Some(Expr::Col(c)) if c.same(&column_to_add)));
    if !already_exists {
      select_fields.insert(column_name.to_string(), Some(Expr::Col(column_to_add)));
    }
  }

  Ok(order_by)
}

/// `buildQuery(args)`
pub fn build_query(adapter: &QueryAdapter, args: BuildQueryArgs) -> Result<BuildQueryResult> {
  let mut select_fields = SelectFields::new();
  let main = adapter.table_req(Some(&args.table_name), "id")?;
  select_fields.insert("id".into(), adapter.col(&main, "id"));

  let mut joins = args.joins;
  let mut where_ = None;
  let mut context = QueryContext { raw_sort: None, sort: args.sort.clone() };

  if args.where_.has_keys() {
    where_ = parse_params(
      adapter,
      ParseArgs {
        alias_table: args.alias_table.clone(),
        fields: args.fields.clone(),
        locale: args.locale.clone(),
        parent_is_localized: args.parent_is_localized,
        select_locale: args.select_locale,
        table_name: args.table_name.clone(),
        where_: &args.where_,
      },
      &mut context,
      &mut joins,
      &mut select_fields,
    )?;
  }

  let order_by = build_order_by(
    adapter,
    OrderByArgs {
      alias_table: args.alias_table.as_ref(),
      fields: &args.fields,
      locale: args.locale.clone(),
      parent_is_localized: args.parent_is_localized,
      raw_sort: context.raw_sort.clone(),
      sort: context.sort.clone(),
      table_name: &args.table_name,
    },
    &mut joins,
    &mut select_fields,
  )?;

  Ok(BuildQueryResult { joins, order_by, select_fields, where_ })
}
