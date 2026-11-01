//! Field descriptors decoded once from the live sanitized config objects.
//!
//! Each descriptor keeps a persistent reference to the JS object it was decoded from, so values
//! handed to user code (`field`, `siblingFields`, blocks, default values, hook arrays) are the
//! real config objects. Decoding is lazy and cached per JS object in a JS `WeakMap` (the host's
//! `descCache`), so shared field arrays/blocks map to one shared descriptor.
//!
//! Only properties the traversal *branches on* are snapshotted (type, name presence, hidden,
//! localized, virtual, presence of hooks/access/defaultValue). Like the rest of the engine, the
//! config is treated as immutable after sanitization.

use std::cell::OnceCell;
use std::ffi::c_void;
use std::ptr;
use std::rc::Rc;

use napi::sys;

use crate::host::{self, call_host, host};
use crate::js::{self, JsResult, Local, Persist, Type, Val};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
  Array,
  Blocks,
  Collapsible,
  Group,
  Join,
  Point,
  Relationship,
  RichText,
  Row,
  Slug,
  Tab,
  Tabs,
  Text,
  Textarea,
  Ui,
  Upload,
  Other,
}

impl Kind {
  fn parse(s: Option<&str>) -> Kind {
    match s {
      Some("array") => Kind::Array,
      Some("blocks") => Kind::Blocks,
      Some("collapsible") => Kind::Collapsible,
      Some("group") => Kind::Group,
      Some("join") => Kind::Join,
      Some("point") => Kind::Point,
      Some("relationship") => Kind::Relationship,
      Some("richText") => Kind::RichText,
      Some("row") => Kind::Row,
      Some("slug") => Kind::Slug,
      Some("tab") => Kind::Tab,
      Some("tabs") => Kind::Tabs,
      Some("text") => Kind::Text,
      Some("textarea") => Kind::Textarea,
      Some("ui") => Kind::Ui,
      Some("upload") => Kind::Upload,
      _ => Kind::Other,
    }
  }
}

pub struct FieldDesc {
  /// The JS field object (for a tab: the original tab object; the `{...tab, type: 'tab'}` copy
  /// passed to hooks is created per traversal, as upstream does).
  pub node: Rc<Persist>,
  pub kind: Kind,
  /// `'name' in field`
  pub has_name: bool,
  /// `field.name` (property key)
  pub name: Val,
  /// UTF-16 copy of `field.name` when it is a string ([`FieldDesc::name_key`]).
  name_utf16: Option<Box<[u16]>>,
  /// `` `${field.name}` `` (for paths)
  pub name_str: String,
  /// `fieldAffectsData(field)`
  pub affects_data: bool,
  pub hidden_truthy: bool,
  /// `field.hidden === true`
  pub hidden_is_true: bool,
  /// `'localized' in field && Boolean(field.localized)`
  pub localized_truthy: bool,
  /// `field.localized` (for `parentIsLocalized || field.localized`)
  pub localized: Val,
  /// `'virtual' in field && typeof field.virtual === 'string'`
  pub virtual_path: Option<String>,
  /// `'hooks' in field && field.hooks?.afterRead` is truthy
  pub has_after_read_hooks: bool,
  /// `field.access && field.access.read` is truthy
  pub has_read_access: bool,
  /// `typeof field.defaultValue !== 'undefined'`
  pub has_default_value: bool,
  /// `field.name` is truthy (`stripUnselectedFields` condition)
  pub name_truthy: bool,
  /// `field.name === 'id'` (and so `${field.name}` is `'id'`)
  pub name_is_id: bool,
  /// Whether the field's `promise()` body can run as a plain leaf (see [`Leaf`]).
  pub leaf: Leaf,
  /// Whether it would be a plain leaf if it had no `afterRead` hooks (`Leaf::No` when it has
  /// none): such fields run through the engine's hooked-leaf path.
  pub hooked_leaf: Leaf,
  children: OnceCell<Rc<FieldsDesc>>,
  tabs: OnceCell<Rc<FieldsDesc>>,
  blocks: OnceCell<Rc<Vec<BlockCandidate>>>,
}

/// Static classification of a field for the afterRead leaf fast path.
///
/// A plain leaf is a field whose `promise()` body never recurses and, up to the default value
/// step, never awaits or calls user code: its JS-observable effects are a fixed pattern of
/// reads/deletes on the sibling doc (hidden check, `stripUnselectedFields`, the hoisting check,
/// the default value check) and the fulfilled (or, if a read throws, rejected) promise pushed to
/// `fieldPromises`. Runs of such fields are executed by one host call that performs exactly
/// those operations. When a field's default value applies, the host stops there and the engine
/// runs the rest of that field's `promise()` (the `getDefaultValue` step) as its own task.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Leaf {
  /// Container, hooks, virtual, default value, relationship-like, richText, point, ...
  No,
  /// A plain leaf when the dynamic conditions hold: with `needs_override_access` (the field has
  /// `access.read`) only for a truthy `overrideAccess`; with `needs_localized_parent` (the field
  /// is localized) only when the parent is localized (`fieldShouldBeLocalized` is false).
  Yes { needs_override_access: bool, needs_localized_parent: bool },
}

/// A decoded fields array. `items` is `None` when the value is not an array (upstream throws
/// from `fields.forEach`).
pub struct FieldsDesc {
  pub node: Val,
  pub items: Option<Vec<Rc<FieldDesc>>>,
  leaf_table: OnceCell<LeafTable>,
  /// Segmentations, indexed by `override_access_truthy | parent_localized_truthy << 1`.
  plans: [OnceCell<Rc<[Segment]>>; 4],
}

/// JS arrays handed to the host's `leafRun`: `keys[i]` is `field.name`, `flags[i]` the
/// [`leaf_flags`] of field `i`.
pub struct LeafTable {
  pub keys: Persist,
  pub flags: Persist,
}

/// Bits of the per-field `flags` array (mirrored in `packages/engine-rs/src/runtime/index.ts`).
pub mod leaf_flags {
  /// `fieldAffectsData(field)`
  pub const AFFECTS_DATA: u32 = 1;
  /// `field.hidden` is truthy
  pub const HIDDEN: u32 = 2;
  /// `field.name === 'id'`
  pub const NAME_IS_ID: u32 = 4;
  /// `field.name` is truthy
  pub const NAME_TRUTHY: u32 = 8;
  /// `typeof field.defaultValue !== 'undefined'`: `leafRun` stops at the field when the default
  /// value applies and the engine continues with the `getDefaultValue` step.
  pub const HAS_DEFAULT_VALUE: u32 = 16;
  /// The field has `afterRead` hooks to run (a hooked leaf, see `FieldDesc::hooked_leaf`):
  /// `leafRun` runs its whole `promise()` as the host's `hookedLeaf` and pushes its promise.
  pub const HOOKED: u32 = 32;
}

/// One step of `traverseFields` over a fields array: a run of consecutive plain or hooked leaves
/// (`start..end`, `true` when it contains a hooked leaf) or a single field going through the full
/// `promise()` port.
#[derive(Clone, Copy, Debug)]
pub enum Segment {
  Run(u32, u32, bool),
  Field(u32),
}

impl FieldsDesc {
  fn new(node: Val, items: Option<Vec<Rc<FieldDesc>>>) -> FieldsDesc {
    FieldsDesc {
      node,
      items,
      leaf_table: OnceCell::new(),
      plans: [OnceCell::new(), OnceCell::new(), OnceCell::new(), OnceCell::new()],
    }
  }

  /// The traversal plan for the given dynamic conditions. Without items (not an array) the
  /// plan is empty; callers handle that case first.
  pub fn plan(&self, override_access: bool, parent_localized: bool) -> Rc<[Segment]> {
    let cell = &self.plans[usize::from(override_access) | usize::from(parent_localized) << 1];
    cell
      .get_or_init(|| {
        let mut out = Vec::new();
        let Some(items) = &self.items else { return out.into() };
        let mut run_start: Option<u32> = None;
        let mut run_hooked = false;
        for (i, f) in items.iter().enumerate() {
          let i = i as u32;
          let hooked = f.hooked_leaf.holds(override_access, parent_localized);
          if hooked || f.leaf.holds(override_access, parent_localized) {
            run_start.get_or_insert(i);
            run_hooked |= hooked;
          } else {
            if let Some(start) = run_start.take() {
              out.push(Segment::Run(start, i, std::mem::take(&mut run_hooked)));
            }
            out.push(Segment::Field(i));
          }
        }
        if let Some(start) = run_start {
          out.push(Segment::Run(start, items.len() as u32, run_hooked));
        }
        out.into()
      })
      .clone()
  }

  /// `Some((len, hooked))` when, under these conditions, every field is a plain or hooked leaf
  /// (`hooked`: at least one is), so whole rows can be handed to the host's `leafRows`.
  pub fn all_plain(&self, override_access: bool, parent_localized: bool) -> Option<(u32, bool)> {
    let items = self.items.as_ref()?;
    match *self.plan(override_access, parent_localized) {
      [Segment::Run(0, end, hooked)] if end as usize == items.len() => Some((end, hooked)),
      _ => None,
    }
  }

  /// The `keys`/`flags` arrays for `leafRun` (created once per fields array).
  pub fn leaf_table(&self) -> JsResult<&LeafTable> {
    if let Some(t) = self.leaf_table.get() {
      return Ok(t);
    }
    let keys = js::array();
    let flags = js::array();
    if let Some(items) = &self.items {
      for (i, f) in items.iter().enumerate() {
        js::set_element(keys, i as u32, f.name_key())?;
        js::set_element(flags, i as u32, js::number(f64::from(f.leaf_flags())))?;
      }
    }
    let table = LeafTable { keys: Persist::new(keys)?, flags: Persist::new(flags)? };
    Ok(self.leaf_table.get_or_init(|| table))
  }
}

pub struct BlockDesc {
  pub node: Persist,
  /// `block.slug` as a Rust string (for schema paths) and as a JS value.
  pub slug_str: String,
  pub slug: Val,
  fields: OnceCell<Rc<FieldsDesc>>,
}

/// Entry of `field.blocks`: block references are strings, `find` skips them.
pub enum BlockCandidate {
  Reference,
  Block(Rc<BlockDesc>),
}

enum Cached {
  Fields(Rc<FieldsDesc>),
  Block(Rc<BlockDesc>),
  Tab(Rc<FieldDesc>),
}

impl Leaf {
  /// Whether the field is a plain leaf under these dynamic conditions.
  pub fn holds(self, override_access: bool, parent_localized: bool) -> bool {
    match self {
      Leaf::No => false,
      Leaf::Yes { needs_override_access, needs_localized_parent } => {
        (!needs_override_access || override_access) && (!needs_localized_parent || parent_localized)
      }
    }
  }
}

impl FieldDesc {
  /// `field.name` as a JS value. A string name is recreated as an internalized property key
  /// from its UTF-16 copy (strings have no identity), which is cheaper than the slot table.
  pub fn name_key(&self) -> Local {
    match &self.name_utf16 {
      Some(units) => js::property_key_utf16(units),
      None => self.name.get(),
    }
  }

  /// The [`leaf_flags`] bits of this field.
  pub fn leaf_flags(&self) -> u32 {
    let mut bits = 0;
    if self.affects_data {
      bits |= leaf_flags::AFFECTS_DATA;
    }
    if self.hidden_truthy {
      bits |= leaf_flags::HIDDEN;
    }
    if self.name_is_id {
      bits |= leaf_flags::NAME_IS_ID;
    }
    if self.name_truthy {
      bits |= leaf_flags::NAME_TRUTHY;
    }
    if self.has_default_value {
      bits |= leaf_flags::HAS_DEFAULT_VALUE;
    }
    if matches!(self.hooked_leaf, Leaf::Yes { .. }) {
      bits |= leaf_flags::HOOKED;
    }
    bits
  }

  /// `field.fields` (array/row/collapsible/group/tab)
  pub fn children(&self) -> JsResult<Rc<FieldsDesc>> {
    if let Some(c) = self.children.get() {
      return Ok(c.clone());
    }
    let fields = host::get_named(self.node.get(), "fields")?;
    let desc = fields_desc(fields)?;
    let _ = self.children.set(desc.clone());
    Ok(desc)
  }

  /// Descriptors of `field.tabs`, each decoded as a `tab` field. `node` is the `tabs` array.
  pub fn tabs(&self) -> JsResult<Rc<FieldsDesc>> {
    if let Some(c) = self.tabs.get() {
      return Ok(c.clone());
    }
    let tabs = host::get_named(self.node.get(), "tabs")?;
    let items = if js::is_array(tabs) {
      let len = js::array_length(tabs);
      let mut items = Vec::with_capacity(len as usize);
      for i in 0..len {
        items.push(tab_desc(js::get_element(tabs, i)?)?);
      }
      Some(items)
    } else {
      None
    };
    let desc = Rc::new(FieldsDesc::new(Val::from_local(tabs)?, items));
    let _ = self.tabs.set(desc.clone());
    Ok(desc)
  }

  /// `field.blocks`, for `field.blocks.find(...)`.
  pub fn blocks(&self) -> JsResult<Rc<Vec<BlockCandidate>>> {
    if let Some(c) = self.blocks.get() {
      return Ok(c.clone());
    }
    let blocks = host::get_named(self.node.get(), "blocks")?;
    let mut out = Vec::new();
    if js::is_array(blocks) {
      for i in 0..js::array_length(blocks) {
        let b = js::get_element(blocks, i)?;
        out.push(if js::type_of(b) == Type::String {
          BlockCandidate::Reference
        } else {
          BlockCandidate::Block(block_desc(b)?)
        });
      }
    }
    let out = Rc::new(out);
    let _ = self.blocks.set(out.clone());
    Ok(out)
  }
}

impl BlockDesc {
  pub fn fields(&self) -> JsResult<Rc<FieldsDesc>> {
    if let Some(c) = self.fields.get() {
      return Ok(c.clone());
    }
    let fields = host::get_named(self.node.get(), "fields")?;
    let desc = fields_desc(fields)?;
    let _ = self.fields.set(desc.clone());
    Ok(desc)
  }
}

pub fn fields_desc(fields: Local) -> JsResult<Rc<FieldsDesc>> {
  if js::type_of(fields).is_object_like() {
    if let Some(Cached::Fields(d)) = cache_get(fields)? {
      return Ok(d);
    }
  }
  let items = if js::is_array(fields) {
    let len = js::array_length(fields);
    let mut items = Vec::with_capacity(len as usize);
    for i in 0..len {
      items.push(Rc::new(decode_field(js::get_element(fields, i)?, None)?));
    }
    Some(items)
  } else {
    None
  };
  let desc = Rc::new(FieldsDesc::new(Val::from_local(fields)?, items));
  if js::type_of(fields).is_object_like() {
    cache_set(fields, Cached::Fields(desc.clone()))?;
  }
  Ok(desc)
}

pub fn block_desc(block: Local) -> JsResult<Rc<BlockDesc>> {
  if let Some(Cached::Block(d)) = cache_get(block)? {
    return Ok(d);
  }
  let slug = host::get_named(block, "slug")?;
  let desc = Rc::new(BlockDesc {
    node: Persist::new(block)?,
    slug_str: to_display_string(slug),
    slug: Val::from_local(slug)?,
    fields: OnceCell::new(),
  });
  cache_set(block, Cached::Block(desc.clone()))?;
  Ok(desc)
}

fn tab_desc(tab: Local) -> JsResult<Rc<FieldDesc>> {
  if js::type_of(tab).is_object_like() {
    if let Some(Cached::Tab(d)) = cache_get(tab)? {
      return Ok(d);
    }
  }
  let desc = Rc::new(decode_field(tab, Some(Kind::Tab))?);
  if js::type_of(tab).is_object_like() {
    cache_set(tab, Cached::Tab(desc.clone()))?;
  }
  Ok(desc)
}

fn decode_field(field: Local, forced: Option<Kind>) -> JsResult<FieldDesc> {
  let has = |name: &str| -> JsResult<bool> {
    if js::type_of(field).is_object_like() {
      js::has_property(field, js::key(name))
    } else {
      Ok(false)
    }
  };
  let get = |name: &str| host::get_named(field, name);

  let kind = forced.unwrap_or_else(|| {
    get("type").ok().map(|t| Kind::parse(js::get_string(t).as_deref())).unwrap_or(Kind::Other)
  });
  let has_name = has("name")?;
  let name = get("name")?;
  let hidden = get("hidden")?;
  let localized = get("localized")?;
  let virtual_value = get("virtual")?;
  let hooks = get("hooks")?;
  let after_read_hooks = host::get_optional(hooks, js::key("afterRead"))?;
  let access = get("access")?;
  let has_read_access =
    js::truthy(access) && js::truthy(host::get_named(access, "read")?);

  let name_str = to_display_string(name);
  let name_is_id = js::type_of(name) == Type::String && name_str == "id";
  let affects_data = has_name && kind != Kind::Ui;
  let hidden_truthy = js::truthy(hidden);
  let localized_truthy = has("localized")? && js::truthy(localized);
  let virtual_path = if has("virtual")? { js::get_string(virtual_value) } else { None };
  let has_after_read_hooks = has("hooks")? && js::truthy(after_read_hooks);
  let has_default_value = js::type_of(get("defaultValue")?) != Type::Undefined;
  let is_leaf_kind = !matches!(
    kind,
    Kind::Array
      | Kind::Blocks
      | Kind::Collapsible
      | Kind::Group
      | Kind::Join
      | Kind::Point
      | Kind::Relationship
      | Kind::RichText
      | Kind::Row
      | Kind::Tab
      | Kind::Tabs
      | Kind::Upload
  );
  // Everything `promise()` does for a data field beyond the leaf reads is gated on these.
  let leaf_ignoring_hooks = if !is_leaf_kind {
    Leaf::No
  } else if !affects_data {
    // Only the `locale === 'all'` check can read the doc here, and only when the field
    // should be localized.
    Leaf::Yes { needs_override_access: false, needs_localized_parent: localized_truthy }
  } else if virtual_path.is_some() {
    Leaf::No
  } else {
    Leaf::Yes { needs_override_access: has_read_access, needs_localized_parent: localized_truthy }
  };
  // Hooks only run for data fields.
  let has_hooks_to_run = affects_data && has_after_read_hooks;
  let (leaf, hooked_leaf) =
    if has_hooks_to_run { (Leaf::No, leaf_ignoring_hooks) } else { (leaf_ignoring_hooks, Leaf::No) };

  Ok(FieldDesc {
    node: Rc::new(Persist::new(field)?),
    kind,
    has_name,
    name_truthy: js::truthy(name),
    name_is_id,
    name_str,
    name_utf16: js::get_string_utf16(name).map(Vec::into_boxed_slice),
    name: Val::from_local(name)?,
    affects_data,
    hidden_truthy,
    hidden_is_true: js::type_of(hidden) == Type::Boolean && js::get_bool(hidden),
    localized_truthy,
    localized: Val::from_local(localized)?,
    virtual_path,
    has_after_read_hooks,
    has_read_access,
    has_default_value,
    leaf,
    hooked_leaf,
    children: OnceCell::new(),
    tabs: OnceCell::new(),
    blocks: OnceCell::new(),
  })
}

/// `String(v)` for strings/numbers/booleans/undefined/null (config names and slugs).
fn to_display_string(v: Local) -> String {
  match js::type_of(v) {
    Type::String => js::get_string(v).unwrap_or_default(),
    Type::Undefined => "undefined".into(),
    Type::Null => "null".into(),
    Type::Boolean => js::get_bool(v).to_string(),
    Type::Number => format_number(js::get_f64(v)),
    _ => String::new(),
  }
}

/// `String(n)` for numbers.
pub fn format_number(n: f64) -> String {
  if n.is_nan() {
    "NaN".into()
  } else if n.is_infinite() {
    if n > 0.0 { "Infinity".into() } else { "-Infinity".into() }
  } else if n == n.trunc() && n.abs() < 1e21 {
    format!("{}", n as i128)
  } else {
    format!("{n}")
  }
}

fn cache_get(key: Local) -> JsResult<Option<Cached>> {
  let h = host()?;
  let cache = h.desc_cache.get();
  let get = js::get_named(cache, "get")?;
  let v = js::call(get, cache, &[key])?;
  if js::type_of(v) != Type::External {
    return Ok(None);
  }
  let mut data: *mut c_void = ptr::null_mut();
  js::check(unsafe { sys::napi_get_value_external(js::env(), v.0, &mut data) })?;
  let cached = unsafe { &*(data as *const Cached) };
  Ok(Some(match cached {
    Cached::Fields(d) => Cached::Fields(d.clone()),
    Cached::Block(d) => Cached::Block(d.clone()),
    Cached::Tab(d) => Cached::Tab(d.clone()),
  }))
}

unsafe extern "C" fn finalize_cached(env: sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
  js::set_env(env);
  drop(unsafe { Box::from_raw(data as *mut Cached) });
}

fn cache_set(key: Local, value: Cached) -> JsResult<()> {
  let h = host()?;
  let data = Box::into_raw(Box::new(value)) as *mut c_void;
  let mut external = ptr::null_mut();
  js::check(unsafe {
    sys::napi_create_external(js::env(), data, Some(finalize_cached), ptr::null_mut(), &mut external)
  })?;
  let cache = h.desc_cache.get();
  let set = js::get_named(cache, "set")?;
  js::call(set, cache, &[key, Local(external)])?;
  Ok(())
}

/// `fields.forEach(...)` on a non-array: lets JS raise the exact TypeError.
pub fn throw_not_array(fields: &FieldsDesc) -> JsResult<()> {
  let h = host()?;
  let f = host::get_named(h.obj.get(), "forEachFields")?;
  js::call(f, js::undefined(), &[fields.node.get()])?;
  let _ = call_host;
  Ok(())
}
