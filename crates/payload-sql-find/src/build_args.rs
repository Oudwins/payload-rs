//! Port of `find/buildFindManyArgs.ts` and `find/traverseFields.ts`.
//!
//! The TS code mutates a tree of plain objects that alias each other
//! (`currentArgs`, `_locales`, `topLevelArgs`). The port keeps the nodes in an
//! arena so the exact same mutation sequence (and therefore the same key
//! order) can be reproduced, then materializes the [`QueryConfig`] tree.

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::fields::{field_is_virtual, field_should_be_localized};
use payload_engine::js::JsVal;
use payload_engine::strings::{js_len, to_snake_case};

use crate::args::{Extra, Order, OrderBy, QueryConfig, With};
use crate::context::FindContext;
use crate::join::{JoinFieldArgs, build_join_field};
use crate::polymorphic::{PolymorphicJoinArgs, build_polymorphic_join_query};
use crate::utils::{SelectMode, get_select_mode, is_typeof_object};

type NodeId = usize;

#[derive(Clone, Debug)]
enum WithRef {
  Bool(bool),
  Node(NodeId),
}

#[derive(Clone, Debug, Default)]
struct Node {
  columns: Option<IndexMap<String, Option<bool>>>,
  with: Option<IndexMap<String, WithRef>>,
  extras: Option<IndexMap<String, Extra>>,
  order_by: Option<Vec<OrderBy>>,
}

impl Node {
  /// `Object.keys(node).length`
  fn key_count(&self) -> usize {
    usize::from(self.columns.is_some())
      + usize::from(self.with.is_some())
      + usize::from(self.extras.is_some())
      + usize::from(self.order_by.is_some())
  }
}

fn columns(entries: &[(&str, bool)]) -> Option<IndexMap<String, Option<bool>>> {
  Some(entries.iter().map(|(k, v)| (k.to_string(), Some(*v))).collect())
}

fn order_asc(key: &str) -> Option<Vec<OrderBy>> {
  Some(vec![OrderBy::Column { key: key.into(), order: Order::Asc }])
}

fn type_error(message: impl Into<String>) -> EngineError {
  EngineError::new("TypeError", message)
}

#[derive(Clone, Copy, Debug, Default)]
struct WithTabledFields {
  numbers: bool,
  rels: bool,
  texts: bool,
}

/// Arguments of `buildFindManyArgs`.
#[derive(Clone, Debug)]
pub struct BuildFindManyArgs<'a> {
  pub collection_slug: Option<&'a str>,
  /// `undefined` = `None`
  pub depth: Option<f64>,
  pub drafts_enabled: bool,
  /// `FlattenedField[]`
  pub fields: &'a JsVal,
  /// `JoinQuery` (`undefined`, `false` or an object)
  pub join_query: &'a JsVal,
  pub locale: Option<&'a str>,
  /// `SelectType` or `undefined`
  pub select: &'a JsVal,
  pub table_name: &'a str,
  pub versions: bool,
}

struct Traverser<'c, 'a> {
  ctx: &'c FindContext<'a>,
  nodes: Vec<Node>,
  with_tabled: WithTabledFields,
}

#[derive(Clone)]
struct TraverseArgs<'s> {
  locales: Option<NodeId>,
  collection_slug: Option<&'s str>,
  current: NodeId,
  current_table_name: String,
  depth: Option<f64>,
  drafts_enabled: bool,
  fields: JsVal,
  force_with_fields: bool,
  join_query: JsVal,
  locale: Option<&'s str>,
  parent_is_localized: bool,
  path: String,
  select: JsVal,
  select_all_on_current_level: bool,
  select_mode: Option<SelectMode>,
  table_path: String,
  top: NodeId,
  top_level_table_name: &'s str,
  versions: bool,
}

/// `buildFindManyArgs()`
pub fn build_find_many_args(ctx: &FindContext<'_>, args: &BuildFindManyArgs<'_>) -> Result<QueryConfig> {
  let mut t = Traverser { ctx, nodes: Vec::new(), with_tabled: WithTabledFields::default() };
  let select_truthy = args.select.truthy();

  let result = t.add(Node {
    columns: if select_truthy { columns(&[("id", true)]) } else { None },
    extras: Some(IndexMap::new()),
    with: Some(IndexMap::new()),
    order_by: None,
  });
  // Note: in TS `result.columns` is assigned after `extras`/`with`; the key
  // order of the result object is irrelevant to drizzle.
  let locales = t.add(Node {
    columns: if select_truthy { columns(&[("_locale", true)]) } else { columns(&[("id", false), ("_parentID", false)]) },
    extras: Some(IndexMap::new()),
    with: Some(IndexMap::new()),
    order_by: None,
  });

  if !select_truthy {
    t.with_tabled = WithTabledFields { numbers: true, rels: true, texts: true };
  }

  t.traverse(TraverseArgs {
    locales: Some(locales),
    collection_slug: args.collection_slug,
    current: result,
    current_table_name: args.table_name.to_string(),
    depth: args.depth,
    drafts_enabled: args.drafts_enabled,
    fields: args.fields.clone(),
    force_with_fields: false,
    join_query: args.join_query.clone(),
    locale: args.locale,
    parent_is_localized: false,
    path: String::new(),
    select: args.select.clone(),
    select_all_on_current_level: false,
    select_mode: if select_truthy { Some(get_select_mode(args.select)) } else { None },
    table_path: String::new(),
    top: result,
    top_level_table_name: args.table_name,
    versions: args.versions,
  })?;

  let schema = ctx.schema;
  let tabled_columns = || columns(&[("id", false), ("parent", false)]);
  let table_name = args.table_name;
  if schema.has_table(&format!("{table_name}_texts")) && t.with_tabled.texts {
    let n = t.add(Node { columns: tabled_columns(), order_by: order_asc("order"), ..Default::default() });
    t.set_with(result, "_texts", WithRef::Node(n))?;
  }
  if schema.has_table(&format!("{table_name}_numbers")) && t.with_tabled.numbers {
    let n = t.add(Node { columns: tabled_columns(), order_by: order_asc("order"), ..Default::default() });
    t.set_with(result, "_numbers", WithRef::Node(n))?;
  }
  if schema.has_table(&format!("{table_name}{}", ctx.options.relationships_suffix)) && t.with_tabled.rels {
    let n = t.add(Node { columns: tabled_columns(), order_by: order_asc("order"), ..Default::default() });
    t.set_with(result, "_rels", WithRef::Node(n))?;
  }
  let locales_column_count = t.nodes[locales].columns.as_ref().map_or(0, |c| c.len());
  if schema.has_table(&format!("{table_name}{}", ctx.options.locales_suffix)) && (!select_truthy || locales_column_count > 1)
  {
    t.set_with(result, "_locales", WithRef::Node(locales))?;
  }

  // Delete properties that are empty
  let node = &mut t.nodes[result];
  if node.columns.as_ref().is_some_and(|c| c.is_empty()) {
    node.columns = None;
  }
  if node.extras.as_ref().is_some_and(|c| c.is_empty()) {
    node.extras = None;
  }
  if node.with.as_ref().is_some_and(|c| c.is_empty()) {
    node.with = None;
  }

  Ok(t.materialize(result))
}

impl Traverser<'_, '_> {
  fn add(&mut self, node: Node) -> NodeId {
    self.nodes.push(node);
    self.nodes.len() - 1
  }

  fn set_with(&mut self, node: NodeId, key: &str, value: WithRef) -> Result<()> {
    let with = self.nodes[node].with.as_mut().ok_or_else(|| type_error(format!("Cannot set properties of undefined (setting '{key}')")))?;
    with.insert(key.to_string(), value);
    Ok(())
  }

  fn set_column(&mut self, node: NodeId, key: &str) -> Result<()> {
    let columns =
      self.nodes[node].columns.as_mut().ok_or_else(|| type_error(format!("Cannot set properties of undefined (setting '{key}')")))?;
    columns.insert(key.to_string(), Some(true));
    Ok(())
  }

  fn set_extra(&mut self, node: NodeId, key: &str, extra: Extra) -> Result<()> {
    let extras =
      self.nodes[node].extras.as_mut().ok_or_else(|| type_error(format!("Cannot set properties of undefined (setting '{key}')")))?;
    extras.insert(key.to_string(), extra);
    Ok(())
  }

  fn with_get(&self, node: NodeId, key: &str) -> Option<NodeId> {
    match self.nodes[node].with.as_ref()?.get(key)? {
      WithRef::Node(id) => Some(*id),
      WithRef::Bool(_) => None,
    }
  }

  fn materialize(&self, id: NodeId) -> QueryConfig {
    let node = &self.nodes[id];
    QueryConfig {
      columns: node.columns.clone(),
      with: node.with.as_ref().map(|w| {
        w.iter()
          .map(|(k, v)| {
            (
              k.clone(),
              match v {
                WithRef::Bool(b) => With::Bool(*b),
                WithRef::Node(n) => With::Config(Box::new(self.materialize(*n))),
              },
            )
          })
          .collect()
      }),
      extras: node.extras.clone(),
      order_by: node.order_by.clone(),
      where_: None,
      limit: None,
      offset: None,
    }
  }

  /// Sets `columns[fieldPath] = true` on `_locales` or the current args.
  fn select_column(&mut self, a: &TraverseArgs<'_>, is_field_localized: bool, field_path: &str) -> Result<()> {
    if let (true, Some(locales)) = (is_field_localized || a.parent_is_localized, a.locales) {
      self.set_column(locales, field_path)?;
    } else if self.ctx.schema.has_column(&a.current_table_name, field_path) {
      self.set_column(a.current, field_path)?;
    }
    Ok(())
  }

  /// `adapter.tableNameMap.get(key)`; a missing entry is JS `undefined`,
  /// which TS interpolates as the string `"undefined"`.
  fn table_name(&self, key: &str) -> String {
    self.ctx.table_name_map.get(key).cloned().unwrap_or_else(|| "undefined".into())
  }

  fn traverse(&mut self, a: TraverseArgs<'_>) -> Result<()> {
    let ctx = self.ctx;
    let select_truthy = a.select.truthy();
    let join_query = if a.join_query.is_undefined() { JsVal::obj(Default::default()) } else { a.join_query.clone() };

    for field in a.fields.items() {
      if field_is_virtual(field) {
        continue;
      }
      let name = field.get("name").to_js_string();
      let field_type = field.get("type").as_str().unwrap_or("");
      let is_field_localized = field_should_be_localized(field, a.parent_is_localized);

      if a.depth.is_some_and(|d| d > 0.0)
        && matches!(field_type, "upload" | "relationship")
        && !field.get("hasMany").truthy()
        && field.get("relationTo").as_str().is_some()
      {
        let key = format!("{}{name}", a.path);
        if is_field_localized {
          let locales = a.locales.ok_or_else(|| type_error("Cannot read properties of undefined (reading 'with')"))?;
          self.set_with(locales, &key, WithRef::Bool(true))?;
        } else {
          self.set_with(a.current, &key, WithRef::Bool(true))?;
        }
      }

      let select_get = |key: &str| a.select.get(key).clone();

      match field_type {
        "array" => {
          let array_select = if a.select_all_on_current_level { JsVal::Bool(true) } else { select_get(&name) };
          if select_truthy
            && ((a.select_mode == Some(SelectMode::Include) && array_select.is_undefined())
              || (a.select_mode == Some(SelectMode::Exclude) && matches!(array_select, JsVal::Bool(false))))
          {
            continue;
          }
          let select_is_object = is_typeof_object(&array_select);
          let array_table_name =
            self.table_name(&format!("{}_{}{}", a.current_table_name, a.table_path, to_snake_case(&name)));
          let mut with_array = Node {
            columns: if select_is_object { columns(&[("id", true), ("_order", true)]) } else { columns(&[("_parentID", false)]) },
            order_by: order_asc("_order"),
            with: Some(IndexMap::new()),
            extras: None,
          };
          if select_is_object {
            if !ctx.schema.has_table(&array_table_name) {
              return Err(type_error("Cannot read properties of undefined (reading '_locale')"));
            }
            if ctx.schema.has_column(&array_table_name, "_locale") {
              with_array.columns.get_or_insert_default().insert("_locale".into(), Some(true));
            }
            if ctx.schema.has_column(&array_table_name, "_uuid") {
              with_array.columns.get_or_insert_default().insert("_uuid".into(), Some(true));
            }
          }
          let with_array = self.add(with_array);
          let mut array_locales = None;
          if ctx.schema.has_table(&format!("{array_table_name}{}", ctx.options.locales_suffix)) {
            let locales = self.add(Node {
              columns: if select_is_object { columns(&[("_locale", true)]) } else { columns(&[("id", false), ("_parentID", false)]) },
              with: Some(IndexMap::new()),
              ..Default::default()
            });
            self.set_with(with_array, "_locales", WithRef::Node(locales))?;
            array_locales = Some(locales);
          }

          // getArrayRelationName
          let field_path = format!("{}{name}", a.path);
          let relation_name = if field.get("dbName").truthy() && js_len(&field_path) > 63 {
            format!("_{array_table_name}")
          } else {
            field_path
          };
          self.set_with(a.current, &relation_name, WithRef::Node(with_array))?;

          self.traverse(TraverseArgs {
            locales: array_locales,
            collection_slug: None,
            current: with_array,
            current_table_name: array_table_name,
            depth: a.depth,
            drafts_enabled: a.drafts_enabled,
            fields: field.get("flattenedFields").clone(),
            force_with_fields: a.force_with_fields,
            join_query: join_query.clone(),
            locale: a.locale,
            parent_is_localized: a.parent_is_localized || field.get("localized").truthy(),
            path: String::new(),
            select: if select_is_object { array_select.clone() } else { JsVal::Undefined },
            select_all_on_current_level: false,
            select_mode: a.select_mode,
            table_path: String::new(),
            top: a.top,
            top_level_table_name: a.top_level_table_name,
            versions: false,
          })?;

          if select_is_object
            && let Some(locales) = self.with_get(with_array, "_locales")
            && self.nodes[locales].key_count() == 1
          {
            self.nodes[with_array].with.as_mut().map(|w| w.shift_remove("_locales"));
          }
        }

        "blocks" => {
          let blocks_select = if a.select_all_on_current_level { JsVal::Bool(true) } else { select_get(&name) };
          if select_truthy
            && ((a.select_mode == Some(SelectMode::Include) && !blocks_select.truthy())
              || (a.select_mode == Some(SelectMode::Exclude) && matches!(blocks_select, JsVal::Bool(false))))
          {
            continue;
          }

          if ctx.options.blocks_as_json {
            if select_truthy || a.select_all_on_current_level {
              self.select_column(&a, is_field_localized, &format!("{}{name}", a.path))?;
            }
            continue;
          }

          for block_ref in field.get("blocks").items() {
            let block = match block_ref {
              JsVal::Str(slug) => ctx.blocks.get(slug).clone(),
              other => other.clone(),
            };
            let slug = block.get("slug").to_js_string();
            let table_index = block.identity().and_then(|id| ctx.block_table_name_index.get(&id)).copied().filter(|i| *i != 0);
            let block_key = match table_index {
              Some(i) => format!("_blocks_{slug}_{i}"),
              None => format!("_blocks_{slug}"),
            };

            let mut block_select = JsVal::Undefined;
            let mut block_select_mode = a.select_mode;
            if a.select_mode == Some(SelectMode::Include) && blocks_select.is_true() {
              block_select = JsVal::Bool(true);
            }
            if is_typeof_object(&blocks_select) {
              let bs = blocks_select.get(&slug);
              if is_typeof_object(bs) {
                block_select = bs.clone();
              } else if (a.select_mode == Some(SelectMode::Include) && bs.is_undefined())
                || (a.select_mode == Some(SelectMode::Exclude) && matches!(bs, JsVal::Bool(false)))
              {
                block_select = JsVal::obj(Default::default());
                block_select_mode = Some(SelectMode::Include);
              } else if a.select_mode == Some(SelectMode::Include) && bs.truthy() {
                block_select = JsVal::Bool(true);
              }
            }

            // `if (!topLevelArgs[blockKey])` reads the args object itself (not
            // `.with`), so it is always true.
            let select_is_object = is_typeof_object(&block_select);
            let original = self.table_name(&format!("{}_blocks_{}", a.top_level_table_name, to_snake_case(&slug)));
            let table_name = match table_index {
              Some(i) => format!("{original}_{i}"),
              None => original,
            };
            let mut with_block = Node {
              columns: if select_is_object {
                columns(&[("id", true), ("_order", true), ("_path", true)])
              } else {
                columns(&[("_parentID", false)])
              },
              order_by: order_asc("_order"),
              with: Some(IndexMap::new()),
              extras: None,
            };
            if select_is_object {
              if !ctx.schema.has_table(&table_name) {
                return Err(type_error("Cannot read properties of undefined (reading '_locale')"));
              }
              if ctx.schema.has_column(&table_name, "_locale") {
                with_block.columns.get_or_insert_default().insert("_locale".into(), Some(true));
              }
              if ctx.schema.has_column(&table_name, "_uuid") {
                with_block.columns.get_or_insert_default().insert("_uuid".into(), Some(true));
              }
            }
            let with_block = self.add(with_block);
            let mut block_locales = None;
            if ctx.schema.has_table(&format!("{table_name}{}", ctx.options.locales_suffix)) {
              let locales = self.add(Node {
                with: Some(IndexMap::new()),
                columns: if select_is_object { columns(&[("_locale", true)]) } else { None },
                ..Default::default()
              });
              self.set_with(with_block, "_locales", WithRef::Node(locales))?;
              block_locales = Some(locales);
            }
            self.set_with(a.top, &block_key, WithRef::Node(with_block))?;

            self.traverse(TraverseArgs {
              locales: block_locales,
              collection_slug: None,
              current: with_block,
              current_table_name: table_name,
              depth: a.depth,
              drafts_enabled: a.drafts_enabled,
              fields: block.get("flattenedFields").clone(),
              force_with_fields: block_select.is_true(),
              join_query: join_query.clone(),
              locale: a.locale,
              parent_is_localized: a.parent_is_localized || field.get("localized").truthy(),
              path: String::new(),
              select: if select_is_object { block_select.clone() } else { JsVal::Undefined },
              select_all_on_current_level: false,
              select_mode: block_select_mode,
              table_path: String::new(),
              top: a.top,
              top_level_table_name: a.top_level_table_name,
              versions: false,
            })?;

            if select_is_object && let Some(locales) = self.with_get(with_block, "_locales") {
              let count = self.nodes[locales]
                .columns
                .as_ref()
                .ok_or_else(|| type_error("Cannot convert undefined or null to object"))?
                .len();
              if count == 1 {
                self.nodes[with_block].with.as_mut().map(|w| w.shift_remove("_locales"));
              }
            }
          }
        }

        "group" | "tab" => {
          let field_select = select_get(&name);
          if matches!(field_select, JsVal::Bool(false)) {
            continue;
          }
          self.traverse(TraverseArgs {
            locales: a.locales,
            collection_slug: a.collection_slug,
            current: a.current,
            current_table_name: a.current_table_name.clone(),
            depth: a.depth,
            drafts_enabled: a.drafts_enabled,
            fields: field.get("flattenedFields").clone(),
            force_with_fields: a.force_with_fields,
            join_query: join_query.clone(),
            locale: a.locale,
            parent_is_localized: a.parent_is_localized || field.get("localized").truthy(),
            path: format!("{}{name}_", a.path),
            select: if is_typeof_object(&field_select) { field_select.clone() } else { JsVal::Undefined },
            select_all_on_current_level: a.select_all_on_current_level
              || field_select.is_true()
              || (a.select_mode == Some(SelectMode::Exclude) && field_select.is_undefined()),
            select_mode: a.select_mode,
            table_path: format!("{}{}_", a.table_path, to_snake_case(&name)),
            top: a.top,
            top_level_table_name: a.top_level_table_name,
            versions: a.versions,
          })?;
        }

        "join" => {
          if matches!(join_query, JsVal::Bool(false)) {
            continue;
          }
          if select_truthy && a.select_mode == Some(SelectMode::Include) && !select_get(&name).truthy() {
            continue;
          }
          if a.select_mode == Some(SelectMode::Exclude) {
            if !a.select.is_object_like() || a.select.is_null() {
              return Err(type_error(format!("Cannot read properties of undefined (reading '{name}')")));
            }
            if matches!(select_get(&name), JsVal::Bool(false)) {
              continue;
            }
          }
          let join_schema_path = format!("{}{name}", a.path.replace('_', "."));
          let jq = join_query.get(&join_schema_path);
          if matches!(jq, JsVal::Bool(false)) {
            continue;
          }
          let jq = if jq.truthy() { jq.clone() } else { JsVal::obj(Default::default()) };
          let should_count = match jq.get("count") {
            JsVal::Undefined => false,
            v => v.truthy(),
          };
          let limit_arg = match jq.get("limit") {
            JsVal::Undefined => match field.get("defaultLimit") {
              JsVal::Undefined | JsVal::Null => 10.0,
              v => v.as_num().unwrap_or(f64::NAN),
            },
            v => v.as_num().unwrap_or(f64::NAN),
          };
          let page = jq.get("page").clone();
          let sort = match jq.get("sort") {
            JsVal::Undefined => field.get("defaultSort").clone(),
            v => v.clone(),
          };
          let where_ = jq.get("where").clone();
          let limit = if limit_arg != 0.0 { limit_arg + 1.0 } else { limit_arg };

          let extras: Vec<(String, Extra)> = if field.get("collection").as_arr().is_some() {
            build_polymorphic_join_query(
              ctx,
              &PolymorphicJoinArgs {
                current_table_name: &a.current_table_name,
                field,
                limit,
                locale: a.locale,
                page: &page,
                page_size: Some(limit_arg),
                path: &a.path,
                should_count,
                sort: &sort,
                where_: &where_,
              },
            )?
          } else {
            build_join_field(
              ctx,
              &JoinFieldArgs {
                collection_slug: a.collection_slug,
                current_table_name: &a.current_table_name,
                drafts_enabled: a.drafts_enabled,
                field,
                limit,
                locale: a.locale,
                page: &page,
                parent_is_localized: a.parent_is_localized,
                path: &a.path,
                should_count,
                sort: &sort,
                versions: a.versions,
                where_: &where_,
              },
            )?
          };
          for (key, extra) in extras {
            self.set_extra(a.current, &key, extra)?;
          }
        }

        // `adapter.name === 'sqlite'`
        "point" => {}

        "select" => {
          if select_truthy && !a.select_all_on_current_level {
            let v = select_get(&name);
            if (a.select_mode == Some(SelectMode::Include) && !v.truthy())
              || (a.select_mode == Some(SelectMode::Exclude) && matches!(v, JsVal::Bool(false)))
            {
              continue;
            }
          }
          if field.get("hasMany").truthy() {
            let node = self.add(Node {
              columns: columns(&[("id", false), ("order", false), ("parent", false)]),
              order_by: order_asc("order"),
              ..Default::default()
            });
            self.set_with(a.current, &format!("{}{name}", a.path), WithRef::Node(node))?;
            continue;
          }
          if select_truthy || a.select_all_on_current_level {
            self.select_column(&a, is_field_localized, &format!("{}{name}", a.path))?;
          }
        }

        _ => {
          let is_rel = matches!(field_type, "relationship" | "upload")
            && (field.get("hasMany").truthy() || field.get("relationTo").as_arr().is_some());
          let has_many = field.get("hasMany").truthy();
          if a.force_with_fields {
            if is_rel {
              self.with_tabled.rels = true;
            }
            if field_type == "number" && has_many {
              self.with_tabled.numbers = true;
            }
            if field_type == "text" && has_many {
              self.with_tabled.texts = true;
            }
          }
          if !select_truthy && !a.select_all_on_current_level {
            continue;
          }
          if a.select_all_on_current_level
            || (a.select_mode == Some(SelectMode::Include) && select_get(&name).truthy())
            || (a.select_mode == Some(SelectMode::Exclude) && select_get(&name).is_undefined())
          {
            self.select_column(&a, is_field_localized, &format!("{}{name}", a.path))?;
            if !self.with_tabled.rels && is_rel {
              self.with_tabled.rels = true;
            }
            if !self.with_tabled.numbers && field_type == "number" && has_many {
              self.with_tabled.numbers = true;
            }
            if !self.with_tabled.texts && field_type == "text" && has_many {
              self.with_tabled.texts = true;
            }
          }
        }
      }
    }
    Ok(())
  }
}
