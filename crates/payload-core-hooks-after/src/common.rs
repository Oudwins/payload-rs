//! Pieces shared by the afterChange and beforeDuplicate ports: `getFieldPaths`, the per-field
//! path segment arrays, `forEach`/`for...of` iteration with JS semantics, block lookup and small
//! JS operators.

use std::cell::OnceCell;
use std::rc::Rc;

use napi::sys;
use payload_core_runtime::config::{self, BlockCandidate, BlockDesc, FieldDesc, Kind};
use payload_core_runtime::host as rt;
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use crate::host;

pub struct Paths {
  pub index_path: String,
  pub path: String,
  pub schema_path: String,
}

/// Port of `getFieldPaths` (packages/payload/src/fields/getFieldPaths.ts).
pub fn get_field_paths(
  field: &FieldDesc,
  index: usize,
  parent_index_path: &str,
  parent_path: &str,
  parent_schema_path: &str,
) -> Paths {
  let parent_segments: Vec<&str> = parent_path.split('.').collect();
  let parent_path_is_unnamed = parent_segments.last().is_some_and(|s| s.starts_with("_index-"));
  let parent_path_to_use = if parent_path_is_unnamed {
    parent_segments[..parent_segments.len() - 1].join(".")
  } else {
    parent_path.to_string()
  };
  let prefix = |p: &str| if p.is_empty() { String::new() } else { format!("{p}.") };

  if field.has_name {
    return Paths {
      index_path: String::new(),
      path: format!("{}{}", prefix(&parent_path_to_use), field.name_str),
      schema_path: format!("{}{}", prefix(parent_schema_path), field.name_str),
    };
  }
  let index_path = if parent_index_path.is_empty() {
    index.to_string()
  } else {
    format!("{parent_index_path}-{index}")
  };
  let index_suffix = format!("_index-{index_path}");
  let parent_schema_is_unnamed =
    parent_schema_path.split('.').next_back().is_some_and(|s| s.starts_with("_index-"));
  Paths {
    path: format!("{}{}", prefix(&parent_path_to_use), index_suffix),
    schema_path: if parent_schema_is_unnamed {
      format!("{parent_schema_path}-{index}")
    } else {
      format!("{}{}", prefix(parent_schema_path), index_suffix)
    },
    index_path,
  }
}

/// `pathSegments` / `schemaPathSegments` / `indexPathSegments`: one JS array each per field
/// promise, shared by every hook call of that field (upstream creates them eagerly at the top of
/// `promise()`; creation is not observable, so they are created on first use).
pub struct Segments {
  path: OnceCell<Val>,
  schema_path: OnceCell<Val>,
  index_path: OnceCell<Val>,
}

impl Segments {
  pub fn new() -> Segments {
    Segments { path: OnceCell::new(), schema_path: OnceCell::new(), index_path: OnceCell::new() }
  }

  fn get(cell: &OnceCell<Val>, make: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
    if let Some(v) = cell.get() {
      return Ok(v.get());
    }
    let v = make()?;
    let _ = cell.set(Val::from_local(v)?);
    Ok(v)
  }

  /// `path ? path.split('.') : []`
  pub fn path(&self, paths: &Paths) -> JsResult<Local> {
    Self::get(&self.path, || split_array(&paths.path, '.'))
  }

  /// `schemaPath ? schemaPath.split('.') : []`
  pub fn schema_path(&self, paths: &Paths) -> JsResult<Local> {
    Self::get(&self.schema_path, || split_array(&paths.schema_path, '.'))
  }

  /// `indexPath ? indexPath.split('-').filter(Boolean)?.map(Number) : []`
  pub fn index_path(&self, paths: &Paths) -> JsResult<Local> {
    Self::get(&self.index_path, || {
      let arr = js::array();
      for (i, part) in paths.index_path.split('-').filter(|p| !p.is_empty()).enumerate() {
        js::set_element(arr, i as u32, js::number(part.parse::<f64>().unwrap_or(f64::NAN)))?;
      }
      Ok(arr)
    })
  }
}

fn split_array(s: &str, sep: char) -> JsResult<Local> {
  if s.is_empty() { Ok(js::array()) } else { js::string_array(s.split(sep)) }
}

/// `arr.forEach((item, index) => ...)` on a JS array: length read once, holes skipped, items read
/// live (callbacks may mutate the array).
pub fn for_each(arr: Local, mut f: impl FnMut(Local, u32) -> JsResult<()>) -> JsResult<()> {
  let arr = Val::from_local(arr)?;
  let len = js::array_length(arr.get());
  for i in 0..len {
    let a = arr.get();
    let mut has = false;
    js::check(unsafe { sys::napi_has_element(js::env(), a.0, i, &mut has) })?;
    if has {
      let item = js::get_element(a, i)?;
      f(item, i)?;
    }
  }
  Ok(())
}

/// The list a `for...of` iterates. Arrays are iterated live by index (what the array iterator
/// does: length re-read every step); anything else goes through `fallback`, a host helper that
/// runs the same `for...of` (V8's exact "... is not iterable" TypeError, or the collected items).
pub fn for_of_list(value: Local, fallback: impl FnOnce() -> JsResult<Local>) -> JsResult<Val> {
  if js::is_array(value) { Val::from_local(value) } else { Val::from_local(fallback()?) }
}

/// `hook(args)` with `this === undefined`. A non-callable hook raises V8's TypeError
/// (`hook is not a function`) through the host.
pub fn call_hook(hook: Local, args: Local) -> JsResult<Local> {
  if js::type_of(hook) == Type::Function {
    js::call(hook, js::undefined(), &[args])
  } else {
    host::call(&host::host()?.call_hook, &[hook, args])
  }
}

/// `Promise.all(promises)`
pub fn promise_all(promises: Local) -> JsResult<Local> {
  rt::call_host(&rt::host()?.promise_all, &[promises])
}

/// `{ ...v }`
pub fn spread(v: Local) -> JsResult<Val> {
  Val::from_local(host::call(&host::host()?.spread, &[v])?)
}

/// `Object.keys(v).length`
pub fn keys_length(v: Local) -> JsResult<f64> {
  Ok(js::get_f64(host::call(&host::host()?.keys_length, &[v])?))
}

pub fn is_nullish(v: Local) -> bool {
  matches!(js::type_of(v), Type::Undefined | Type::Null)
}

/// `a || b`
pub fn or(a: &Val, b: &Val) -> Val {
  if js::truthy(a.get()) { a.clone() } else { b.clone() }
}

/// `v || {}`
pub fn or_empty_object(v: Local) -> JsResult<Val> {
  Val::from_local(if js::truthy(v) { v } else { js::object() })
}

/// `v ?? {}`
pub fn nullish_or_empty_object(v: Local) -> JsResult<Val> {
  Val::from_local(if is_nullish(v) { js::object() } else { v })
}

/// `a ?? b()`
pub fn nullish_or(a: Local, b: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  if is_nullish(a) { b() } else { Ok(a) }
}

/// `getNestedValue(data, path)` from afterChange/promise.ts:
/// `path.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), data)`.
/// `path` is the live `pathSegments` array the hooks also receive.
pub fn get_nested_value(data: Local, path: Local) -> JsResult<Local> {
  let path = Val::from_local(path)?;
  let mut acc = data;
  let len = js::array_length(path.get());
  for i in 0..len {
    let p = path.get();
    let mut has = false;
    js::check(unsafe { sys::napi_has_element(js::env(), p.0, i, &mut has) })?;
    if !has {
      continue;
    }
    let key = js::get_element(p, i)?;
    acc = if js::truthy(acc) && js::type_of(rt::get(acc, key)?) != Type::Undefined {
      rt::get(acc, key)?
    } else {
      js::undefined()
    };
  }
  Ok(acc)
}

/// `req.payload.blocks[blockType] ?? field.blocks.find((b) => typeof b !== 'string' && b.slug === blockType)`.
/// `None` stands for a falsy result (see RUST_CORE_DESIGN.md, known gaps: a falsy non-nullish
/// `payload.blocks` entry is treated as "no block").
pub fn find_block(req: Local, f: &FieldDesc, block_type: Local) -> JsResult<Option<Rc<BlockDesc>>> {
  let blocks = rt::get_named(rt::get_named(req, "payload")?, "blocks")?;
  let found = rt::get(blocks, block_type)?;
  if !is_nullish(found) {
    return Ok(if js::truthy(found) { Some(config::block_desc(found)?) } else { None });
  }
  for candidate in f.blocks()?.iter() {
    if let BlockCandidate::Block(b) = candidate {
      if js::strict_equals(b.slug.get(), block_type) {
        return Ok(Some(b.clone()));
      }
    }
  }
  Ok(None)
}

/// A field whose afterChange / beforeDuplicate `promise()` traverses no subfields and calls no
/// editor hooks: the host runs its whole `promise()` (`afterChangeLeaves` /
/// `beforeDuplicateLeaves`).
pub fn is_leaf(kind: Kind) -> bool {
  !matches!(
    kind,
    Kind::Array | Kind::Blocks | Kind::Collapsible | Kind::Group | Kind::RichText | Kind::Row | Kind::Tab | Kind::Tabs
  )
}
