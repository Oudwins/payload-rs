//! The direct read path of the SQLite backend: `payload.db.find` / `findOne` followed by the
//! operation's `afterRead`, written straight to the result JSON, for collections whose fields the
//! drizzle read transform maps one to one (no localized fields, blocks, joins, points, hasMany
//! text / number / select fields).
//!
//! The statements are the engine's own (the same `buildQuery`, `buildFindManyArgs` and drizzle
//! relational query, run in the same order: count, then the relational query; prepared statements
//! are cached per connection), so the command stream is the exact lane's. The rows go from the
//! SQLite cells into a light output tree in the shape `transform/read` produces (driven by the
//! engine's `flattenedFields`, key order included), the `afterRead` rules of the collection plan
//! (FUSE_CONTRACT.md section 2) are applied to that tree, and it is written as JSON; json and rich
//! text values are validated and spliced as stored. Anything outside the supported subset returns
//! [`Fast::Unsupported`]: the call then runs the engine's generic method and the core's
//! `afterRead`.

use std::collections::HashMap;
use std::borrow::Cow;
use std::sync::{Arc, OnceLock};

use payload_engine::error::{EngineError, Result};
use payload_engine::host::NoHost;
use payload_engine::js::{JsVal, num_to_js_string, write_json_string};
use payload_engine::strings::to_snake_case;
use payload_fuse::after_read::{ReadArgs, SelectMode};
use payload_fuse::plan::{DefaultValue, Field, Kind};
use payload_sql_engine::{EngineOptions, SqliteEngine};
use payload_sql_find::args::OrderBy;
use payload_sql_find::build_args::{BuildFindManyArgs, build_find_many_args};
use payload_sql_find::context::{BuildQueryArgs, FieldsSource, FindContext, WhereVal};
use payload_sql_find::exec::string_to_number;
use payload_sql_find::query::SqlQueryBuilder;
use payload_sql_find::relational::{Mode, SelectionItem, SelectionKind, build_relational_query};
use payload_sql_find::schema::Decoder;
use payload_sql_find::sql::Sql;
use payload_sql_query::QueryAdapter;
use payload_sql_read::jsops::parse_float;
use payload_sql_read::jsstr::JsStr;
use payload_sqlite::{Cell, Conn};

use crate::scan::{Scan, scan};
use crate::tplan::{TKind, TPlan};

pub enum Fast {
  Unsupported,
  Done(String),
}

/// The `afterRead` side of a fused request.
pub struct Direct<'a> {
  pub read: &'a ReadArgs<'a>,
  pub select: Option<&'a JsVal>,
  pub select_mode: Option<SelectMode>,
  /// auth collection: `{ ...doc, collection: slug }`
  pub auth: bool,
}

/// `PAYLOAD_RS_FUSE_DEBUG=1`: why calls leave the direct path (stderr).
static DEBUG: std::sync::LazyLock<bool> =
  std::sync::LazyLock::new(|| std::env::var("PAYLOAD_RS_FUSE_DEBUG").is_ok_and(|v| v == "1"));

fn unsupported(reason: &str) -> Fast {
  if *DEBUG {
    eprintln!("payload-fuse-sqlite: generic path: {reason}");
  }
  Fast::Unsupported
}

/// Data or config outside the subset: the call runs the generic path.
struct Unsupported(&'static str);

enum Failure {
  Unsupported(&'static str),
  Error(EngineError),
}

impl From<EngineError> for Failure {
  fn from(error: EngineError) -> Self {
    Failure::Error(error)
  }
}

impl From<Unsupported> for Failure {
  fn from(u: Unsupported) -> Self {
    Failure::Unsupported(u.0)
  }
}

type Decoded<T> = std::result::Result<T, Failure>;

/// `payload.db.find(args)` (`one: false`, the paginated result) or `payload.db.findOne(args)`
/// (`one: true`: the document; no document is `Unsupported`, the exact lane decides), with
/// `afterRead`, as result JSON.
pub fn find(
  engine: &Arc<SqliteEngine>,
  options: &EngineOptions,
  conn: &Conn,
  args: &JsVal,
  one: bool,
  direct: &Direct<'_>,
) -> Result<Fast> {
  let root = engine.root();
  let slug = args.get("collection").as_str().unwrap_or("undefined");
  let entry = root.get("collections").get(slug);
  if entry.is_nullish() {
    return Ok(unsupported("collection"));
  }
  let collection = entry.get("config");
  let fields = collection.get("flattenedFields");
  let JsVal::Str(collection_slug) = collection.get("slug") else { return Ok(unsupported("slug")) };
  let Some(table_name) = engine.schema().table_name_map.get(&to_snake_case(collection_slug)).cloned() else {
    return Ok(unsupported("table"));
  };
  let collections = root.get("collections");
  let Some(tplan) = crate::tplan::plan(fields, &table_name, &engine.schema().table_name_map, collections) else {
    return Ok(unsupported("fields"));
  };
  let mut root_level = Level::default();
  level(&direct.read.plan.fields, &mut root_level);
  let reader = Reader { tplan: &tplan, root_level: &root_level, direct };
  payload_sql_query::sql::with_driver_host(&NoHost, || {
    let statements = match statements(engine, options, collection, &table_name, args, one) {
      Ok(statements) => statements,
      Err(Failure::Unsupported(reason)) => return Ok(unsupported(reason)),
      Err(Failure::Error(error)) => return Err(error),
    };
    let spec = Spec::of(collection, &table_name, args, one);
    match run(conn, &spec, &statements, &reader, one) {
      Ok(json) => Ok(Fast::Done(json)),
      Err(Failure::Unsupported(reason)) => Ok(unsupported(reason)),
      Err(Failure::Error(error)) => Err(error),
    }
  })
}

/// The statements of one call: `count` (when paginating), then the relational query.
struct Statements {
  count: Option<Sql>,
  relational: payload_sql_find::relational::BuiltRelationalQuery,
}

/// A template: the statements built from sentinel values and where the values go.
struct Template {
  /// Keeps the engine (and so the address in the key) alive while the template exists.
  _engine: Arc<SqliteEngine>,
  count: Option<(Sql, crate::templates::Slots)>,
  relational: payload_sql_find::relational::BuiltRelationalQuery,
  relational_slots: crate::templates::Slots,
}

static TEMPLATES: OnceLock<crate::templates::Cache<Template>> = OnceLock::new();

/// `PAYLOAD_RS_FUSE_TEMPLATES=off` (read once): build every statement from the call's values.
static TEMPLATES_DISABLED: std::sync::LazyLock<bool> =
  std::sync::LazyLock::new(|| std::env::var("PAYLOAD_RS_FUSE_TEMPLATES").is_ok_and(|v| v == "off"));

fn statements(
  engine: &Arc<SqliteEngine>,
  options: &EngineOptions,
  collection: &JsVal,
  table_name: &str,
  args: &JsVal,
  one: bool,
) -> Decoded<Statements> {
  let build = |args: &JsVal| -> Decoded<Statements> {
    let root = engine.root();
    let config = root.get("config");
    let collections = root.get("collections");
    let blocks = root.get("blocks");
    let qa = QueryAdapter::new(engine.schema(), config, collections, blocks, options.query.clone()).with_drizzle(engine.drizzle_schema());
    let qb = SqlQueryBuilder::new(&qa);
    let ctx = FindContext {
      schema: engine.drizzle_schema(),
      table_name_map: &engine.schema().table_name_map,
      config,
      collections,
      blocks,
      block_table_name_index: &engine.schema().block_table_name_index,
      options: &options.query,
      query: &qb,
    };
    build_statements(&ctx, &Spec::of(collection, table_name, args, one))
  };
  if *TEMPLATES_DISABLED {
    return build(args);
  }
  let prefix = format!(
    "{:p}|{}|{}|{}",
    Arc::as_ptr(engine),
    one,
    options.query.limited_bound_parameters,
    options.query.blocks_as_json
  );
  let Some(shaped) = crate::templates::shape(args, &prefix) else { return build(args) };
  let cache = crate::templates::global(&TEMPLATES);
  let template = match cache.get(&shaped.key) {
    Some(Some(template)) => template,
    Some(None) => return build(args),
    None => {
      let sentinels: Vec<JsVal> = {
        let mut out = Vec::with_capacity(shaped.values.len());
        for (slot, value) in shaped.values.iter().enumerate() {
          out.push(crate::templates::sentinel(crate::templates::class_of(value).ok_or(Unsupported("template"))?, slot));
        }
        out
      };
      let built = build(&shaped.sentinel_args)?;
      let count = match &built.count {
        Some(sql) => match crate::templates::locate(sql, &sentinels) {
          Some(slots) => Some(Some((sql.clone(), slots))),
          None => None,
        },
        None => Some(None),
      };
      let relational_slots = crate::templates::locate(&built.relational.sql, &sentinels);
      // every slot must be bound by the relational query (the count is optional)
      let complete = relational_slots.as_ref().is_some_and(|slots| {
        let mut bound = vec![false; sentinels.len()];
        for &(_, slot) in slots {
          bound[slot] = true;
        }
        bound.iter().all(|b| *b)
      });
      match (count, relational_slots) {
        (Some(count), Some(relational_slots)) if complete => {
          let template = Arc::new(Template { _engine: Arc::clone(engine), count, relational: built.relational, relational_slots });
          cache.insert(shaped.key, Some(Arc::clone(&template)));
          template
        }
        _ => {
          cache.insert(shaped.key, None);
          return build(args);
        }
      }
    }
  };
  Ok(Statements {
    count: template.count.as_ref().map(|(sql, slots)| crate::templates::bind(sql, slots, &shaped.values)),
    relational: payload_sql_find::relational::BuiltRelationalQuery {
      sql: crate::templates::bind(&template.relational.sql, &template.relational_slots, &shaped.values),
      selection: template.relational.selection.clone(),
    },
  })
}

impl<'a> Spec<'a> {
  /// The `FindSpec` of the engine's `find` / `findOne` for `args`.
  fn of(collection: &'a JsVal, table_name: &'a str, args: &'a JsVal, one: bool) -> Self {
    Spec {
      collection_slug: if one { args.get("collection").as_str() } else { collection.get("slug").as_str() },
      drafts_enabled: args.get("draftsEnabled").truthy(),
      fields: collection.get("flattenedFields"),
      joins: args.get("joins"),
      limit: if one { Some(1.0) } else { args.get("limit").as_num() },
      locale: args.get("locale").as_str(),
      page: if one { Some(1.0) } else { args.get("page").as_num() },
      pagination: if one {
        Some(false)
      } else {
        match args.get("pagination") {
          JsVal::Bool(b) => Some(*b),
          _ => None,
        }
      },
      select: args.get("select"),
      sort: if one {
        JsVal::Undefined
      } else if args.get("sort").is_nullish() {
        collection.get("defaultSort").clone()
      } else {
        args.get("sort").clone()
      },
      table_name,
      where_: args.get("where"),
    }
  }
}

struct Spec<'a> {
  collection_slug: Option<&'a str>,
  drafts_enabled: bool,
  fields: &'a JsVal,
  joins: &'a JsVal,
  limit: Option<f64>,
  locale: Option<&'a str>,
  page: Option<f64>,
  pagination: Option<bool>,
  select: &'a JsVal,
  sort: JsVal,
  table_name: &'a str,
  where_: &'a JsVal,
}

/// The statements of `findMany()` (payload-sql-find `find_many_js`) for queries without joins.
fn build_statements(ctx: &FindContext<'_>, spec: &Spec<'_>) -> Decoded<Statements> {
  let page = spec.page.unwrap_or(1.0);
  let mut pagination = spec.pagination;
  let mut limit = spec.limit;
  let offset = (page - 1.0) * limit.unwrap_or(f64::NAN);
  if limit == Some(0.0) {
    pagination = Some(false);
    limit = None;
  }
  let where_ = WhereVal::Js(spec.where_.clone());
  let built = ctx.query.build_query(&BuildQueryArgs {
    table_name: spec.table_name,
    alias_table: None,
    fields: spec.fields,
    fields_source: FieldsSource::Caller,
    locale: spec.locale,
    parent_is_localized: false,
    select_locale: false,
    sort: &spec.sort,
    where_: &where_,
  })?;
  let mut find_many_args = build_find_many_args(
    ctx,
    &BuildFindManyArgs {
      collection_slug: spec.collection_slug,
      depth: Some(0.0),
      drafts_enabled: spec.drafts_enabled,
      fields: spec.fields,
      join_query: spec.joins,
      locale: spec.locale,
      select: spec.select,
      table_name: spec.table_name,
      versions: false,
    },
  )?;
  let main_table = ctx.schema.table(spec.table_name)?;
  if !main_table.columns.contains_key("id") {
    return Err(Unsupported("id column").into());
  }
  if !built.joins.is_empty() {
    // the `selectDistinct` path
    return Err(Unsupported("joins").into());
  }
  let main_from = Sql::ident(&main_table.db_name);
  find_many_args.limit = limit;
  find_many_args.offset = Some(offset);
  find_many_args.order_by =
    Some(built.order_by.iter().map(|o| OrderBy::Sql(o.expr_rqb.clone().unwrap_or_else(|| o.expr.clone()))).collect());
  if let Some(w) = built.where_rqb.as_ref().or(built.where_.as_ref()) {
    find_many_args.where_ = Some(w.clone());
  }
  let relational = build_relational_query(ctx.schema, spec.table_name, &find_many_args, Mode::Many)?;
  // `ordered_ids_len.is_none_or(...)`: no distinct ids on this path
  let count = (pagination != Some(false)).then(|| {
    let mut q = Sql::raw("select count(*) from ");
    q.push(&main_from);
    if let Some(w) = &built.where_ {
      q.push_str(" where ").push(w);
    }
    q
  });
  Ok(Statements { count, relational })
}

/// Runs the statements and writes the result JSON (the rest of `findMany()`, then the operation's
/// per-document work).
fn run(conn: &Conn, spec: &Spec<'_>, statements: &Statements, reader: &Reader<'_>, one: bool) -> Decoded<String> {
  let page = spec.page.unwrap_or(1.0);
  let mut pagination = spec.pagination;
  let mut limit = spec.limit;
  if limit == Some(0.0) {
    pagination = Some(false);
    limit = None;
  }
  let relational = &statements.relational;
  let shape = Shape::top(&relational.selection).ok_or(Unsupported("relations"))?;

  let mut total_docs = f64::NAN;
  let mut total_pages = f64::NAN;
  let mut has_prev_page = false;
  let mut has_next_page = false;
  let mut paging_counter = f64::NAN;
  let mut counted = false;
  if let Some(q) = &statements.count {
    let rows = crate::exec::query(conn, q)?;
    // `Number(countResult?.[0]?.count ?? 0)`
    total_docs = match rows.first().and_then(|r| r.first()) {
      None | Some(Cell::Null) => 0.0,
      Some(Cell::Number(n)) => *n,
      Some(Cell::String(s)) => string_to_number(s),
      Some(_) => return Err(Unsupported("count").into()),
    };
    counted = true;
    total_pages = match limit {
      Some(l) if l != 0.0 => (total_docs / l).ceil(),
      _ => 1.0,
    };
    has_prev_page = page > 1.0;
    has_next_page = total_pages > page;
    paging_counter = (page - 1.0) * limit.unwrap_or(f64::NAN) + 1.0;
  }

  let rows = crate::exec::query(conn, &relational.sql)?;
  if one {
    let Some(row) = rows.into_iter().next() else { return Err(Unsupported("not found").into()) };
    let doc = reader.doc(&shape, row)?;
    let mut out = String::with_capacity(1024);
    write_obj(&doc, &mut out, 0)?;
    return Ok(out);
  }
  let count = rows.len();
  let mut out = String::with_capacity(256 + count * 512);
  out.push_str("{\"docs\":[");
  for (i, row) in rows.into_iter().enumerate() {
    if i > 0 {
      out.push(',');
    }
    let doc = reader.doc(&shape, row)?;
    write_obj(&doc, &mut out, 0)?;
  }
  out.push(']');
  if pagination == Some(false) || !counted || total_docs == 0.0 || total_docs.is_nan() {
    total_docs = count as f64;
    total_pages = 1.0;
    paging_counter = 1.0;
    has_prev_page = false;
    has_next_page = false;
  }
  out.push_str(",\"hasNextPage\":");
  out.push_str(if has_next_page { "true" } else { "false" });
  out.push_str(",\"hasPrevPage\":");
  out.push_str(if has_prev_page { "true" } else { "false" });
  out.push_str(",\"limit\":");
  match spec.limit {
    Some(l) => write_num(l, &mut out)?,
    None => return Err(Unsupported("limit undefined").into()),
  }
  out.push_str(",\"nextPage\":");
  if has_next_page { write_num(page + 1.0, &mut out)? } else { out.push_str("null") }
  out.push_str(",\"page\":");
  write_num(page, &mut out)?;
  out.push_str(",\"pagingCounter\":");
  write_num(paging_counter, &mut out)?;
  out.push_str(",\"prevPage\":");
  if has_prev_page { write_num(page - 1.0, &mut out)? } else { out.push_str("null") }
  out.push_str(",\"totalDocs\":");
  write_num(total_docs, &mut out)?;
  out.push_str(",\"totalPages\":");
  write_num(total_pages, &mut out)?;
  out.push('}');
  Ok(out)
}

// ---------------------------------------------------------------------------
// The output tree

#[derive(Clone, Debug)]
enum Out {
  Undefined,
  Null,
  Bool(bool),
  Num(f64),
  Str(String),
  /// Valid JSON text, written as it is (json and rich text values).
  Raw(String),
  Obj(OutObj),
  Arr(Vec<Out>),
}

impl Out {
  fn truthy(&self) -> bool {
    match self {
      Out::Undefined | Out::Null => false,
      Out::Bool(b) => *b,
      Out::Num(n) => *n != 0.0 && !n.is_nan(),
      Out::Str(s) => !s.is_empty(),
      Out::Raw(text) => !matches!(text.trim(), "null" | "false" | "0" | "-0" | "\"\""),
      Out::Obj(_) | Out::Arr(_) => true,
    }
  }
}

/// A JS object in insertion order (entries with `false` are deleted keys).
#[derive(Clone, Debug, Default)]
struct OutObj {
  entries: Vec<(Arc<str>, Out, bool)>,
}

impl OutObj {
  fn index(&self, key: &str) -> Option<usize> {
    self.entries.iter().position(|(k, _, alive)| *alive && **k == *key)
  }

  fn get(&self, key: &str) -> Option<&Out> {
    self.index(key).map(|i| &self.entries[i].1)
  }

  fn get_mut(&mut self, key: &str) -> Option<&mut Out> {
    self.index(key).map(|i| &mut self.entries[i].1)
  }

  /// `obj[key] = value`
  fn set(&mut self, key: Arc<str>, value: Out) {
    match self.index(&key) {
      Some(i) => self.entries[i].1 = value,
      None => self.entries.push((key, value, true)),
    }
  }

  /// `delete obj[key]`
  fn delete(&mut self, key: &str) {
    if let Some(i) = self.index(key) {
      self.entries[i].2 = false;
    }
  }
}

const MAX_DEPTH: usize = 400;

fn write_num(n: f64, out: &mut String) -> Decoded<()> {
  if !n.is_finite() {
    return Err(Unsupported("value:non-finite").into());
  }
  if n == 0.0 && n.is_sign_negative() {
    out.push_str("-0");
  } else if n.fract() == 0.0 && n.abs() < 1e15 {
    use std::fmt::Write;
    let _ = write!(out, "{}", n as i64);
  } else {
    out.push_str(&num_to_js_string(n));
  }
  Ok(())
}

fn write(value: &Out, out: &mut String, depth: usize) -> Decoded<()> {
  if depth > MAX_DEPTH {
    return Err(Unsupported("value:deep").into());
  }
  match value {
    Out::Undefined => return Err(Unsupported("value:undefined").into()),
    Out::Null => out.push_str("null"),
    Out::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
    Out::Num(n) => write_num(*n, out)?,
    Out::Str(s) => write_json_string(s, out),
    Out::Raw(text) => out.push_str(text),
    Out::Obj(obj) => write_obj(obj, out, depth)?,
    Out::Arr(items) => {
      out.push('[');
      for (i, item) in items.iter().enumerate() {
        if i > 0 {
          out.push(',');
        }
        write(item, out, depth + 1)?;
      }
      out.push(']');
    }
  }
  Ok(())
}

fn write_obj(obj: &OutObj, out: &mut String, depth: usize) -> Decoded<()> {
  out.push('{');
  let mut first = true;
  for (key, value, alive) in &obj.entries {
    if !*alive {
      continue;
    }
    if &**key == "__proto__" {
      return Err(Unsupported("value:__proto__").into());
    }
    if !first {
      out.push(',');
    }
    first = false;
    write_json_string(key, out);
    out.push(':');
    write(value, out, depth + 1)?;
  }
  out.push('}');
  Ok(())
}

/// A config default value (`deepCopyObjectSimple` of objects).
fn out_of_js(value: &JsVal) -> Decoded<Out> {
  Ok(match value {
    JsVal::Undefined => Out::Undefined,
    JsVal::Null => Out::Null,
    JsVal::Bool(b) => Out::Bool(*b),
    JsVal::Num(n) => Out::Num(*n),
    JsVal::Str(s) => Out::Str(s.to_string()),
    JsVal::Arr(items) => Out::Arr(items.iter().map(out_of_js).collect::<Decoded<_>>()?),
    JsVal::Obj(props) => {
      if props.is_empty() && value.typed().is_some() {
        return Err(Unsupported("default:typed").into());
      }
      let mut obj = OutObj::default();
      for (k, v) in props.iter() {
        obj.set(Arc::from(k.as_str()), out_of_js(v)?);
      }
      Out::Obj(obj)
    }
    JsVal::Fn(_) => return Err(Unsupported("default:function").into()),
  })
}

// ---------------------------------------------------------------------------
// JSON of the relational subqueries (`json_group_array(json_array(...))`)

/// A parsed JSON value (`JSON.parse` semantics; lone surrogates become U+FFFD like the engine's).
enum J {
  Null,
  Bool(bool),
  Num(f64),
  Str(String),
  Arr(Vec<J>),
  Obj(Vec<(String, J)>),
}

struct Parser<'a> {
  b: &'a [u8],
  s: &'a str,
  i: usize,
}

fn parse_json(text: &str) -> Option<J> {
  let mut p = Parser { b: text.as_bytes(), s: text, i: 0 };
  p.ws();
  let value = p.value(0)?;
  p.ws();
  (p.i == p.b.len()).then_some(value)
}

impl Parser<'_> {
  fn ws(&mut self) {
    while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
      self.i += 1;
    }
  }

  fn value(&mut self, depth: usize) -> Option<J> {
    if depth > MAX_DEPTH {
      return None;
    }
    match *self.b.get(self.i)? {
      b'n' => self.word("null", J::Null),
      b't' => self.word("true", J::Bool(true)),
      b'f' => self.word("false", J::Bool(false)),
      b'"' => self.string().map(J::Str),
      b'[' => {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
          self.i += 1;
          return Some(J::Arr(items));
        }
        loop {
          self.ws();
          items.push(self.value(depth + 1)?);
          self.ws();
          match self.b.get(self.i)? {
            b',' => self.i += 1,
            b']' => {
              self.i += 1;
              return Some(J::Arr(items));
            }
            _ => return None,
          }
        }
      }
      b'{' => {
        self.i += 1;
        let mut members: Vec<(String, J)> = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
          self.i += 1;
          return Some(J::Obj(members));
        }
        loop {
          self.ws();
          let key = self.string()?;
          self.ws();
          if self.b.get(self.i) != Some(&b':') {
            return None;
          }
          self.i += 1;
          self.ws();
          let value = self.value(depth + 1)?;
          // a repeated key keeps its first position and takes the last value
          match members.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => members.push((key, value)),
          }
          self.ws();
          match self.b.get(self.i)? {
            b',' => self.i += 1,
            b'}' => {
              self.i += 1;
              return Some(J::Obj(members));
            }
            _ => return None,
          }
        }
      }
      _ => self.number(),
    }
  }

  fn word(&mut self, word: &str, value: J) -> Option<J> {
    if self.s[self.i..].starts_with(word) {
      self.i += word.len();
      Some(value)
    } else {
      None
    }
  }

  fn number(&mut self) -> Option<J> {
    let start = self.i;
    if self.b.get(self.i) == Some(&b'-') {
      self.i += 1;
    }
    match self.b.get(self.i)? {
      b'0' => self.i += 1,
      b'1'..=b'9' => {
        while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
          self.i += 1;
        }
      }
      _ => return None,
    }
    if self.b.get(self.i) == Some(&b'.') {
      self.i += 1;
      if !self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
        return None;
      }
      while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
        self.i += 1;
      }
    }
    if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
      self.i += 1;
      if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
        self.i += 1;
      }
      if !self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
        return None;
      }
      while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
        self.i += 1;
      }
    }
    self.s[start..self.i].parse::<f64>().ok().map(J::Num)
  }

  fn hex4(&mut self) -> Option<u32> {
    let digits = self.s.get(self.i..self.i + 4)?;
    if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
      return None;
    }
    let value = u32::from_str_radix(digits, 16).ok()?;
    self.i += 4;
    Some(value)
  }

  fn string(&mut self) -> Option<String> {
    if self.b.get(self.i) != Some(&b'"') {
      return None;
    }
    self.i += 1;
    let mut out = String::new();
    let mut start = self.i;
    loop {
      let c = *self.b.get(self.i)?;
      match c {
        b'"' => {
          out.push_str(&self.s[start..self.i]);
          self.i += 1;
          return Some(out);
        }
        b'\\' => {
          out.push_str(&self.s[start..self.i]);
          self.i += 1;
          let e = *self.b.get(self.i)?;
          self.i += 1;
          match e {
            b'"' => out.push('"'),
            b'\\' => out.push('\\'),
            b'/' => out.push('/'),
            b'b' => out.push('\u{8}'),
            b'f' => out.push('\u{c}'),
            b'n' => out.push('\n'),
            b'r' => out.push('\r'),
            b't' => out.push('\t'),
            b'u' => {
              let unit = self.hex4()?;
              if (0xd800..0xdc00).contains(&unit) && self.s[self.i..].starts_with("\\u") {
                let save = self.i;
                self.i += 2;
                match self.hex4() {
                  Some(low) if (0xdc00..0xe000).contains(&low) => {
                    out.push(char::from_u32(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)).unwrap_or('\u{fffd}'));
                  }
                  _ => {
                    self.i = save;
                    out.push('\u{fffd}');
                  }
                }
              } else {
                out.push(char::from_u32(unit).unwrap_or('\u{fffd}'));
              }
            }
            _ => return None,
          }
          start = self.i;
        }
        0..=0x1f => return None,
        _ => self.i += 1,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Decoding (transform/read)

/// A relational selection with its key positions.
struct Shape<'s> {
  items: &'s [SelectionItem],
  keys: Vec<Arc<str>>,
  index: HashMap<&'s str, usize>,
  subs: Vec<Option<Shape<'s>>>,
}

impl<'s> Shape<'s> {
  fn new(items: &'s [SelectionItem]) -> Self {
    let index = items.iter().enumerate().map(|(i, item)| (item.ts_key.as_str(), i)).collect();
    let keys = items.iter().map(|item| Arc::from(item.ts_key.as_str())).collect();
    let subs = items
      .iter()
      .map(|item| match &item.kind {
        SelectionKind::Relation { selection, .. } => Some(Shape::new(selection)),
        _ => None,
      })
      .collect();
    Self { items, keys, index, subs }
  }

  /// The top-level shape, `None` with relations the subset does not decode.
  fn top(items: &'s [SelectionItem]) -> Option<Self> {
    let unsupported = items.iter().any(|item| {
      item.ts_key == "_locales" || item.ts_key == "_texts" || item.ts_key == "_numbers" || item.ts_key.starts_with("_blocks_")
    });
    if unsupported { None } else { Some(Shape::new(items)) }
  }
}

/// A driver value of a relational selection (a SQLite cell or a value of a subquery's JSON).
enum Raw {
  Cell(Cell),
  Json(J),
  Undefined,
}

/// `JSON.parse` of a json column: validated, kept as text.
fn json_text(text: String) -> Decoded<Out> {
  match scan(&text, None) {
    Scan::Invalid => Err(Unsupported("json:invalid").into()),
    _ => Ok(Out::Raw(text)),
  }
}

fn out_of_j(value: J) -> Out {
  match value {
    J::Null => Out::Null,
    J::Bool(b) => Out::Bool(b),
    J::Num(n) => Out::Num(n),
    J::Str(s) => Out::Str(s),
    J::Arr(items) => Out::Arr(items.into_iter().map(out_of_j).collect()),
    J::Obj(members) => {
      let mut obj = OutObj::default();
      for (k, v) in members {
        obj.set(Arc::from(k.as_str()), out_of_j(v));
      }
      Out::Obj(obj)
    }
  }
}

/// `column.mapFromDriverValue(value)` (non-null values) for the decoders the subset sees.
fn decode_column(decoder: Decoder, raw: Raw) -> Decoded<Out> {
  Ok(match (decoder, raw) {
    (_, Raw::Undefined) => Out::Undefined,
    (_, Raw::Cell(Cell::Null) | Raw::Json(J::Null)) => Out::Null,
    (Decoder::Identity | Decoder::Custom(None), Raw::Cell(cell)) => match cell {
      Cell::Number(n) => Out::Num(n),
      Cell::String(s) => Out::Str(s),
      _ => return Err(Unsupported("decode:identity").into()),
    },
    (Decoder::Identity | Decoder::Custom(None), Raw::Json(value)) => out_of_j(value),
    (Decoder::Boolean, raw) => Out::Bool(match raw {
      Raw::Cell(Cell::Number(n)) | Raw::Json(J::Num(n)) => n == 1.0,
      Raw::Cell(Cell::String(s)) | Raw::Json(J::Str(s)) => string_to_number(&s) == 1.0,
      Raw::Json(J::Bool(b)) => b,
      _ => return Err(Unsupported("decode:boolean").into()),
    }),
    (Decoder::Json, raw) => match raw {
      Raw::Cell(Cell::String(s)) | Raw::Json(J::Str(s)) => json_text(s)?,
      Raw::Cell(Cell::Number(n)) | Raw::Json(J::Num(n)) => Out::Raw(num_to_js_string(n)),
      _ => return Err(Unsupported("decode:json").into()),
    },
    (Decoder::Number, raw) => match raw {
      Raw::Cell(Cell::Number(n)) | Raw::Json(J::Num(n)) => Out::Num(n),
      Raw::Cell(Cell::String(s)) | Raw::Json(J::Str(s)) => Out::Num(string_to_number(&s)),
      _ => return Err(Unsupported("decode:number").into()),
    },
    (Decoder::NumericString, raw) => match raw {
      Raw::Cell(Cell::String(s)) | Raw::Json(J::Str(s)) => Out::Str(s),
      Raw::Cell(Cell::Number(n)) | Raw::Json(J::Num(n)) => Out::Str(num_to_js_string(n)),
      _ => return Err(Unsupported("decode:numeric").into()),
    },
    _ => return Err(Unsupported("decode:other").into()),
  })
}

/// The raw drizzle value of a selection item (`mapRelationalRow`).
fn decode_item(item: &SelectionItem, sub: Option<&Shape<'_>>, raw: Raw) -> Decoded<Out> {
  match &item.kind {
    SelectionKind::Column { decoder, .. } => decode_column(*decoder, raw),
    SelectionKind::Extra { .. } => Ok(match raw {
      Raw::Undefined => Out::Undefined,
      Raw::Cell(Cell::Null) => Out::Null,
      Raw::Cell(Cell::Number(n)) => Out::Num(n),
      Raw::Cell(Cell::String(s)) => Out::Str(s),
      Raw::Json(value) => out_of_j(value),
      Raw::Cell(_) => return Err(Unsupported("decode:extra").into()),
    }),
    SelectionKind::Relation { is_one, .. } => {
      let sub = sub.ok_or(Unsupported("relation shape"))?;
      let sub_rows = match raw {
        Raw::Cell(Cell::String(s)) | Raw::Json(J::Str(s)) => parse_json(&s).ok_or(Unsupported("relation json"))?,
        Raw::Json(value) => value,
        _ => return Err(Unsupported("relation value").into()),
      };
      let row = |value: J| -> Decoded<Out> {
        let J::Arr(values) = value else { return Err(Unsupported("relation row").into()) };
        let mut out = OutObj { entries: Vec::with_capacity(sub.items.len()) };
        let mut values = values.into_iter();
        for (i, item) in sub.items.iter().enumerate() {
          let raw = values.next().map(Raw::Json).unwrap_or(Raw::Undefined);
          out.entries.push((sub.keys[i].clone(), decode_item(item, sub.subs[i].as_ref(), raw)?, true));
        }
        Ok(Out::Obj(out))
      };
      if *is_one {
        match sub_rows {
          J::Null | J::Bool(false) => Ok(out_of_j(sub_rows)),
          value => row(value),
        }
      } else {
        match sub_rows {
          J::Arr(items) => Ok(Out::Arr(items.into_iter().map(row).collect::<Decoded<_>>()?)),
          _ => Err(Unsupported("relation rows").into()),
        }
      }
    }
  }
}

/// Where a traversal reads the drizzle row from (`table`).
enum Table<'t> {
  /// The top-level row: decoded cells, moved out when read (`None` once read; only `id` is read
  /// twice, by `dataRef` and an `id` field).
  Cells(&'t std::cell::RefCell<Vec<Option<Out>>>),
  /// A nested row (array rows), as decoded. Upstream reads it while filling the same object;
  /// reads only touch keys no earlier field of the row wrote, so a snapshot reads the same.
  Row(&'t OutObj),
}

struct Reader<'a> {
  tplan: &'a TPlan,
  root_level: &'a Level<'a>,
  direct: &'a Direct<'a>,
}

/// `createPathMap(data._rels)`
type PathMap = HashMap<String, Vec<OutObj>>;

fn key(s: &str) -> Arc<str> {
  Arc::from(s)
}

impl Reader<'_> {
  /// One document: `transform`, the auth `collection` key, `afterRead`.
  fn doc(&self, shape: &Shape<'_>, row: Vec<Cell>) -> Decoded<OutObj> {
    let mut values: Vec<Option<Out>> = Vec::with_capacity(shape.items.len());
    for (i, cell) in row.into_iter().enumerate() {
      let Some(item) = shape.items.get(i) else { break };
      values.push(Some(decode_item(item, shape.subs[i].as_ref(), Raw::Cell(cell))?));
    }
    while values.len() < shape.items.len() {
      values.push(Some(Out::Undefined));
    }
    let mut relationships = PathMap::new();
    if let Some(&index) = shape.index.get("_rels") {
      let Some(Out::Arr(rels)) = values[index].take() else {
        return Err(Unsupported("_rels").into());
      };
      for rel in rels {
        let Out::Obj(rel) = rel else { return Err(Unsupported("_rels row").into()) };
        let path = match rel.get("path") {
          Some(Out::Str(s)) => s.clone(),
          _ => return Err(Unsupported("_rels path").into()),
        };
        if payload_fuse::OBJECT_PROTOTYPE_KEYS.contains(&path.as_str()) {
          return Err(Unsupported("_rels path").into());
        }
        relationships.entry(path).or_default().push(rel);
      }
    }
    let values = std::cell::RefCell::new(values);
    let table = Table::Cells(&values);
    let mut result = OutObj { entries: Vec::with_capacity(shape.items.len() + 4) };
    // `dataRef: { id: data.id }`
    let id = match shape.index.get("id") {
      Some(&index) => values.borrow()[index].clone().unwrap_or(Out::Undefined),
      None => Out::Undefined,
    };
    result.set(key("id"), id);
    let mut deletions = Vec::new();
    self.transform(&relationships, self.tplan, &table, shape, &mut result, None, &mut deletions)?;
    if self.direct.auth {
      result.set(key("collection"), Out::Str(self.direct.read.plan.slug.clone()));
    }
    let select = Sel { tree: self.direct.select, with_id: false };
    self.after_read(self.root_level, &mut result, true, select, self.direct.select_mode)?;
    Ok(result)
  }

  /// `table[key]`
  fn get(&self, table: &Table<'_>, shape: &Shape<'_>, key: &str) -> Decoded<Out> {
    match table {
      Table::Cells(values) => match shape.index.get(key) {
        Some(&index) => values.borrow_mut()[index].take().ok_or_else(|| Unsupported("cell read twice").into()),
        None => Ok(Out::Undefined),
      },
      Table::Row(row) => Ok(row.get(key).cloned().unwrap_or(Out::Undefined)),
    }
  }

  /// `traverseFields` of transform/read for non-localized fields (compiled: [`TPlan`]): assigns the
  /// fields to `result` (`dataRef`), reading the drizzle row `table`. `row_path`: the path of the
  /// enclosing array row (`tags.0`), `None` at the document root.
  fn transform(
    &self,
    relationships: &PathMap,
    plan: &TPlan,
    table: &Table<'_>,
    shape: &Shape<'_>,
    result: &mut OutObj,
    row_path: Option<&str>,
    deletions: &mut Vec<Arc<str>>,
  ) -> Decoded<()> {
    for field in &plan.fields {
      if matches!(field.kind, TKind::Virtual) {
        continue;
      }
      if field.prefixed {
        deletions.push(field.field_name.clone());
      }
      match &field.kind {
        TKind::Virtual => {}
        TKind::Array { path, fields, needs_path } => {
          if let Out::Arr(rows) = self.get(table, shape, &field.field_name)? {
            let mut out = Vec::with_capacity(rows.len());
            for (i, row) in rows.into_iter().enumerate() {
              let Out::Obj(mut row) = row else { return Err(Unsupported("array row").into()) };
              if row.get("_uuid").is_some_and(Out::truthy) {
                let uuid = row.get("_uuid").cloned().unwrap_or(Out::Undefined);
                row.set(key("id"), uuid);
                row.delete("_uuid");
              }
              row.delete("_order");
              if row.get("_locale").is_some_and(Out::truthy) {
                row.delete("_locale");
              }
              let snapshot = row.clone();
              let mut row_deletions = Vec::new();
              let nested_path = if *needs_path { Some(format!("{}.{i}", full_path(row_path, path))) } else { None };
              self.transform(relationships, fields, &Table::Row(&snapshot), shape, &mut row, nested_path.as_deref(), &mut row_deletions)?;
              for k in &row_deletions {
                row.delete(k);
              }
              out.push(Out::Obj(row));
            }
            result.set(field.name.clone(), Out::Arr(out));
          }
        }
        TKind::HasMany { path, key: id_key } => {
          let value = match relationships.get(&*full_path(row_path, path)) {
            None => Out::Arr(Vec::new()),
            Some(rows) => Out::Arr(rows.iter().filter_map(|row| row.get(id_key).filter(|v| v.truthy()).cloned()).collect()),
          };
          result.set(field.name.clone(), value);
        }
        TKind::Polymorphic { path, has_many } => {
          let Some(rows) = relationships.get(&*full_path(row_path, path)) else {
            if *has_many {
              result.set(field.name.clone(), Out::Arr(Vec::new()));
            }
            continue;
          };
          let value = if *has_many {
            Out::Arr(rows.iter().filter_map(polymorphic_value).collect())
          } else {
            rows.first().and_then(polymorphic_value).unwrap_or(Out::Undefined)
          };
          result.set(field.name.clone(), value);
        }
        TKind::Group { fields } => {
          let mut group = OutObj { entries: Vec::with_capacity(fields.fields.len()) };
          self.transform(relationships, fields, table, shape, &mut group, row_path, deletions)?;
          result.set(field.name.clone(), Out::Obj(group));
        }
        kind => {
          let value = match (kind, self.get(table, shape, &field.field_name)?) {
            (TKind::Date, Out::Str(s)) => {
              if crate::tplan::is_canonical_iso(&s) {
                Out::Str(s)
              } else {
                Out::Str(payload_sql_read::date::iso_from_string(&JsStr::from(s.as_str())).map_err(Failure::Error)?)
              }
            }
            (TKind::Number, Out::Str(s)) => Out::Num(parse_float(&s)),
            (TKind::Relationship { number_id: true }, value) if value.truthy() => match value {
              Out::Num(n) => Out::Num(n),
              Out::Str(s) => Out::Num(string_to_number(&s)),
              _ => return Err(Unsupported("relationship id").into()),
            },
            (_, value) => value,
          };
          result.set(field.name.clone(), value);
        }
      }
    }
    Ok(())
  }

  /// `afterRead` (`traverseFields` / `promise()`) of the collection plan on one object level, for
  /// the subset: hidden and unselected fields, group / array fills, static default values (after
  /// every synchronous change, in field order), the lexical hook check, arrays and groups.
  /// Relationships at depth 0 leave transformed values unchanged; population bails.
  fn after_read(&self, level: &Level<'_>, obj: &mut OutObj, at_root: bool, select: Sel<'_>, mode: Option<SelectMode>) -> Decoded<()> {
    let args = self.direct.read;
    let mut deferred: Vec<(Arc<str>, Out)> = Vec::new();
    for item in &level.items {
      let (field, children) = match item {
        Item::FillTabs(tabs) => {
          for tab in &tabs.tabs {
            if let Some(name) = tab.name.as_deref() {
              match obj.get(name) {
                None | Some(Out::Undefined | Out::Null) => obj.set(key(name), Out::Obj(OutObj::default())),
                Some(_) => {}
              }
            }
          }
          continue;
        }
        Item::Field(field, children) => (*field, children.as_deref()),
      };
      let name = field.name.as_deref().unwrap_or("");
      let is_top_level_id = name == "id" && at_root;
      let mut removed = false;
      if field.hidden && !matches!(obj.get(name), None | Some(Out::Undefined)) && !args.show_hidden && !is_top_level_id {
        removed = true;
        obj.delete(name);
      }
      if !is_top_level_id && !name.is_empty() && select.is_truthy() {
        match mode {
          Some(SelectMode::Include) if !select.get(name).is_some_and(JsVal::truthy) => {
            obj.delete(name);
            continue;
          }
          Some(SelectMode::Exclude) if matches!(select.get(name), Some(JsVal::Bool(false))) => {
            obj.delete(name);
            continue;
          }
          _ => {}
        }
      }
      if field.localized {
        return Err(Unsupported("localized").into());
      }
      match field.kind {
        Kind::Group => {
          if matches!(obj.get(name), None | Some(Out::Undefined)) {
            obj.set(key(name), Out::Obj(OutObj::default()));
          }
        }
        Kind::Point | Kind::Join | Kind::Blocks => return Err(Unsupported("field kind").into()),
        _ => {}
      }
      if !removed && matches!(obj.get(name), None | Some(Out::Undefined)) {
        match &field.default {
          DefaultValue::None => {}
          DefaultValue::Function => return Err(Unsupported("default:function").into()),
          DefaultValue::Static(value) => {
            if field.kind != Kind::Leaf {
              return Err(Unsupported("default:container").into());
            }
            if !matches!(value, JsVal::Undefined) {
              let value = out_of_js(value)?;
              match obj.get_mut(name) {
                // an own `undefined`: assigned in place after the tick
                Some(slot) => *slot = value,
                None => deferred.push((key(name), value)),
              }
            }
          }
        }
      }
      match field.kind {
        Kind::Relationship => {
          let depth = match field.max_depth {
            Some(max) if max < args.depth => max,
            _ => args.depth,
          };
          let would_populate = depth != 0.0 && !depth.is_nan() && args.current_depth <= depth;
          if would_populate && obj.get(name).is_some_and(|v| v.truthy() && !matches!(v, Out::Arr(a) if a.is_empty())) {
            return Err(Unsupported("populate").into());
          }
        }
        Kind::Array => {
          let row_select = match select.get(name) {
            Some(tree @ JsVal::Obj(_)) => Sel { tree: Some(tree), with_id: mode == Some(SelectMode::Include) },
            _ => Sel { tree: None, with_id: false },
          };
          let row_level = children.ok_or(Unsupported("array level"))?;
          match obj.get_mut(name) {
            Some(Out::Arr(rows)) if !rows.is_empty() => {
              for row in rows.iter_mut() {
                match row {
                  Out::Obj(row) => self.after_read(row_level, row, false, row_select, mode)?,
                  v if !v.truthy() => {}
                  _ => return Err(Unsupported("array row").into()),
                }
              }
            }
            Some(Out::Arr(_)) => {}
            Some(Out::Obj(_)) => return Err(Unsupported("array value").into()),
            _ => {
              if !field.hidden_true || args.show_hidden {
                obj.set(key(name), Out::Arr(Vec::new()));
              }
            }
          }
        }
        Kind::Group | Kind::Tab => {
          let nested = match select.get(name) {
            Some(tree @ JsVal::Obj(_)) => Sel { tree: Some(tree), with_id: false },
            _ => Sel { tree: None, with_id: false },
          };
          let child_level = children.ok_or(Unsupported("group level"))?;
          match obj.get_mut(name) {
            Some(Out::Obj(child)) => self.after_read(child_level, child, false, nested, mode)?,
            Some(Out::Null | Out::Arr(_) | Out::Raw(_)) => return Err(Unsupported("group value").into()),
            _ => {}
          }
        }
        Kind::RichText => {
          let Some(active) = &field.lexical_active else { return Err(Unsupported("richText editor").into()) };
          if !active.is_empty() {
            match obj.get(name) {
              Some(Out::Raw(text)) => {
                if scan(text, Some(active)) != Scan::Inert {
                  return Err(Unsupported("lexical node").into());
                }
              }
              None | Some(Out::Undefined | Out::Null | Out::Bool(_) | Out::Num(_)) => {}
              Some(_) => return Err(Unsupported("richText value").into()),
            }
          }
        }
        _ => {}
      }
    }
    for (k, value) in deferred {
      obj.set(k, value);
    }
    Ok(())
  }
}

/// `{ relationTo, value }` of a polymorphic relationship row: its first non-null value outside
/// `id`, `locale`, `order`, `parent`, `path` (`Object.entries(relation).find(...)`), `relationTo`
/// being that key with its first `ID` removed.
fn polymorphic_value(row: &OutObj) -> Option<Out> {
  let (k, value, _) = row.entries.iter().find(|(k, value, alive)| {
    *alive && !matches!(value, Out::Null) && !matches!(&**k, "id" | "locale" | "order" | "parent" | "path")
  })?;
  let mut obj = OutObj::default();
  obj.set(key("relationTo"), Out::Str(k.replacen("ID", "", 1)));
  obj.set(key("value"), value.clone());
  Some(Out::Obj(obj))
}

/// A select tree of one level (`{ ...arraySelect, id: true }` for array rows in include mode).
#[derive(Clone, Copy)]
struct Sel<'s> {
  tree: Option<&'s JsVal>,
  with_id: bool,
}

static TRUE: JsVal = JsVal::Bool(true);

impl<'s> Sel<'s> {
  fn is_truthy(&self) -> bool {
    self.tree.is_some()
  }

  fn get(&self, name: &str) -> Option<&'s JsVal> {
    if self.with_id && name == "id" {
      return Some(&TRUE);
    }
    match self.tree? {
      JsVal::Obj(o) => o.get(name),
      _ => None,
    }
  }
}

/// The data fields of one object level in traversal order: unnamed containers (rows,
/// collapsibles, unnamed groups and tabs) are traversed on the same object. Built once per call.
#[derive(Default)]
struct Level<'p> {
  items: Vec<Item<'p>>,
}

enum Item<'p> {
  /// A data field and, for arrays (their rows), groups and named tabs, the level of its object.
  Field(&'p Field, Option<Box<Level<'p>>>),
  /// A `tabs` field: `{}` for its named tabs that are `undefined` / `null`, before its tabs run.
  FillTabs(&'p Field),
}

fn child_level(field: &Field) -> Option<Box<Level<'_>>> {
  match field.kind {
    Kind::Array | Kind::Group | Kind::Tab => {
      let mut child = Level::default();
      level(&field.fields, &mut child);
      Some(Box::new(child))
    }
    _ => None,
  }
}

fn level<'p>(fields: &'p [Field], out: &mut Level<'p>) {
  for field in fields {
    match field.kind {
      Kind::Row => level(&field.fields, out),
      Kind::Group if !field.affects_data => level(&field.fields, out),
      Kind::Tabs => {
        out.items.push(Item::FillTabs(field));
        for tab in &field.tabs {
          if tab.affects_data {
            out.items.push(Item::Field(tab, child_level(tab)));
          } else {
            level(&tab.fields, out);
          }
        }
      }
      Kind::Ui => {}
      _ if !field.affects_data => {}
      _ => out.items.push(Item::Field(field, child_level(field))),
    }
  }
}

/// A relationship path: `path` under the enclosing array row `row_path` (`tags.0.path`).
fn full_path<'p>(row_path: Option<&str>, path: &'p str) -> Cow<'p, str> {
  match row_path {
    Some(prefix) => Cow::Owned(format!("{prefix}.{path}")),
    None => Cow::Borrowed(path),
  }
}
