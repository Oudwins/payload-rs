//! The schema description: the mongoose calls upstream `init` makes, in order, with their
//! arguments as typed values (no in-band markers).

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use indexmap::IndexMap;
use payload_engine::error::EngineError;
use payload_engine::js::{JsVal, encode_value};
use payload_engine::sql::schema::find_identity_paths;
use serde_json::{Value as Json, json};

/// JS global constructors upstream passes as `type` (`String`, `Number`, `Boolean`, `Date`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlobalCtor {
  String,
  Number,
  Boolean,
  Date,
}

/// `mongoose.Schema.Types.*` upstream passes as `type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaTypeName {
  Mixed,
  ObjectId,
  BigInt,
  Number,
  String,
}

pub type SchemaId = usize;
pub type ModelId = usize;

/// A JS object literal upstream builds (keys in insertion order, values typed).
pub type DObj = IndexMap<String, DVal>;

/// An argument of a mongoose call.
#[derive(Clone, Debug)]
pub enum DVal {
  Global(GlobalCtor),
  SchemaType(SchemaTypeName),
  /// A `mongoose.Schema` created by an earlier [`Op::NewSchema`].
  Schema(SchemaId),
  /// An object literal built by upstream. The same `Rc` twice is the same JS object twice
  /// (e.g. the per-locale options of `localizeSchema`).
  Obj(Rc<DObj>),
  /// An array literal built by upstream (`[Number]`, `[schema]`, `enum` lists).
  Arr(Rc<Vec<DVal>>),
  /// A config value passed through as is: primitives by value, objects (and `Date`s, arrays,
  /// functions) as the very JS value of the input graph.
  Value(JsVal),
}

impl DVal {
  pub fn obj(o: DObj) -> DVal {
    DVal::Obj(Rc::new(o))
  }

  pub fn arr(items: Vec<DVal>) -> DVal {
    DVal::Arr(Rc::new(items))
  }

  pub fn bool(b: bool) -> DVal {
    DVal::Value(JsVal::Bool(b))
  }

  pub fn str(s: impl AsRef<str>) -> DVal {
    DVal::Value(JsVal::str(s.as_ref()))
  }

  pub fn num(n: f64) -> DVal {
    DVal::Value(JsVal::Num(n))
  }
}

/// The argument object of `getBuildQueryPlugin(args)`.
#[derive(Clone, Debug)]
pub struct BuildQueryArgs {
  /// `collectionSlug` key present (with this value).
  pub collection_slug: Option<JsVal>,
  /// `versionsFields: buildVersion{Collection,Global}Fields(config, entity, true)`.
  pub versions_fields: Option<VersionsFields>,
}

/// Which entity's flattened version fields the buildQuery plugin receives (index into
/// `config.collections` / `config.globals`).
#[derive(Clone, Copy, Debug)]
pub enum VersionsFields {
  Collection(usize),
  Global(usize),
}

/// Where a compiled model is stored on the adapter.
#[derive(Clone, Debug)]
pub enum ModelTarget {
  /// `adapter.collections[slug]`
  Collections(JsVal),
  /// `adapter.versions[slug]`
  Versions(JsVal),
}

#[derive(Clone, Debug)]
pub enum Op {
  /// `schemas[id] = new mongoose.Schema(definition, options)`
  NewSchema { id: SchemaId, definition: DVal, options: DVal },
  /// `schema.add(definition)`
  Add { schema: SchemaId, definition: DVal },
  /// `schema.path(path).discriminator(name, schemas[discriminator])`
  Discriminator { schema: SchemaId, path: String, name: JsVal, discriminator: SchemaId },
  /// `schema.index(fields, options)`
  Index { schema: SchemaId, fields: DVal, options: DVal },
  /// `schema.plugin(paginate, options)`
  Paginate { schema: SchemaId, options: DVal },
  /// `schema.plugin(getBuildQueryPlugin(args))` (`None`: called without arguments)
  BuildQuery { schema: SchemaId, args: Option<BuildQueryArgs> },
  /// `models[id] = adapter.connection.model(name, schemas[schema], collection)`, then stored at
  /// `assign`.
  Model { id: ModelId, name: JsVal, schema: SchemaId, collection: JsVal, assign: Option<ModelTarget> },
  /// `models[model].discriminator(name, schemas[schema])`
  ModelDiscriminator { model: ModelId, name: JsVal, schema: SchemaId },
  /// `adapter.globals = models[model] ?? null`
  AssignGlobals { model: Option<ModelId> },
  /// Upstream throws here (after the preceding calls ran).
  Throw(EngineError),
}

/// The full description: replaying `ops` in order performs upstream `init`'s model building.
#[derive(Clone, Debug, Default)]
pub struct Description {
  pub ops: Vec<Op>,
}

impl Description {
  /// JSON for the TS replay (`packages/engine-rs/src/mongo-schema`). Config objects are referenced
  /// by their property path from `root` (the decoded input graph), so TS passes the very same JS
  /// objects (identity, `Date`s, functions) to mongoose like upstream does.
  ///
  /// Value nodes (`k`):
  /// - `global` / `type`: `{ name }`, a global constructor / `mongoose.Schema.Types[name]`;
  /// - `schema`: `{ id }`; `obj`: `{ entries: [key, node][], id? }`; `arr`: `{ items, id? }`;
  ///   `seen`: `{ id }` (an `obj` / `arr` with that `id` again: the same JS object);
  /// - `value`: `{ value }` in the `serializeForEngine` encoding; `input`: `{ path }`.
  pub fn to_json(&self, root: &JsVal) -> Json {
    let mut encoder = Encoder::new(root, &self.ops);
    let ops = self.ops.iter().map(|op| encoder.op(op)).collect();
    json!({ "ops": Json::Array(ops) })
  }
}

struct Encoder {
  /// `Rc` pointers of literals that occur more than once, with their id once assigned.
  shared: HashMap<usize, Option<usize>>,
  next_id: usize,
  paths: HashMap<usize, Vec<String>>,
}

fn rc_ptr<T>(rc: &Rc<T>) -> usize {
  Rc::as_ptr(rc) as *const () as usize
}

impl Encoder {
  fn new(root: &JsVal, ops: &[Op]) -> Encoder {
    let mut counts: HashMap<usize, u32> = HashMap::new();
    let mut identities: HashSet<usize> = HashSet::new();
    let mut values = Vec::new();
    for op in ops {
      for_each_value(op, &mut |v| values.push(v.clone()));
    }
    let mut pending: Vec<&DVal> = values.iter().collect();
    while let Some(v) = pending.pop() {
      match v {
        DVal::Obj(o) => {
          let count = counts.entry(rc_ptr(o)).or_default();
          *count += 1;
          if *count == 1 {
            pending.extend(o.values());
          }
        }
        DVal::Arr(a) => {
          let count = counts.entry(rc_ptr(a)).or_default();
          *count += 1;
          if *count == 1 {
            pending.extend(a.iter());
          }
        }
        DVal::Value(v) => identities.extend(v.identity()),
        DVal::Global(_) | DVal::SchemaType(_) | DVal::Schema(_) => {}
      }
    }
    for op in ops {
      for_each_js(op, &mut |v| identities.extend(v.identity()));
    }
    let ids: HashMap<usize, u32> = identities.iter().enumerate().map(|(i, id)| (*id, i as u32)).collect();
    let order: Vec<usize> = {
      let mut order = vec![0; ids.len()];
      for (id, i) in &ids {
        order[*i as usize] = *id;
      }
      order
    };
    let paths = find_identity_paths(root, &ids).into_iter().map(|(path, i)| (order[i as usize], path)).collect();
    let shared = counts.into_iter().filter(|(_, n)| *n > 1).map(|(ptr, _)| (ptr, None)).collect();
    Encoder { shared, next_id: 0, paths }
  }

  fn js(&self, v: &JsVal) -> Json {
    if let Some(path) = v.identity().and_then(|id| self.paths.get(&id)) {
      return json!({ "k": "input", "path": path });
    }
    json!({ "k": "value", "value": encode_value(v) })
  }

  /// `Some(json)` for a repeated literal, after assigning `id` on first use.
  fn shared_id(&mut self, ptr: usize) -> Result<Option<usize>, usize> {
    match self.shared.get_mut(&ptr) {
      None => Ok(None),
      Some(Some(id)) => Err(*id),
      Some(slot @ None) => {
        let id = self.next_id;
        self.next_id += 1;
        *slot = Some(id);
        Ok(Some(id))
      }
    }
  }

  fn val(&mut self, v: &DVal) -> Json {
    match v {
      DVal::Global(g) => json!({ "k": "global", "name": format!("{g:?}") }),
      DVal::SchemaType(t) => json!({ "k": "type", "name": format!("{t:?}") }),
      DVal::Schema(id) => json!({ "k": "schema", "id": id }),
      DVal::Value(v) => self.js(v),
      DVal::Obj(o) => match self.shared_id(rc_ptr(o)) {
        Err(id) => json!({ "k": "seen", "id": id }),
        Ok(id) => {
          let entries: Vec<Json> = o.iter().map(|(k, item)| json!([k, self.val(item)])).collect();
          let mut out = json!({ "k": "obj", "entries": entries });
          if let Some(id) = id {
            out["id"] = json!(id);
          }
          out
        }
      },
      DVal::Arr(a) => match self.shared_id(rc_ptr(a)) {
        Err(id) => json!({ "k": "seen", "id": id }),
        Ok(id) => {
          let items: Vec<Json> = a.iter().map(|item| self.val(item)).collect();
          let mut out = json!({ "k": "arr", "items": items });
          if let Some(id) = id {
            out["id"] = json!(id);
          }
          out
        }
      },
    }
  }

  fn op(&mut self, op: &Op) -> Json {
    match op {
      Op::NewSchema { id, definition, options } => {
        json!({ "op": "schema", "id": id, "definition": self.val(definition), "options": self.val(options) })
      }
      Op::Add { schema, definition } => json!({ "op": "add", "schema": schema, "definition": self.val(definition) }),
      Op::Discriminator { schema, path, name, discriminator } => json!({
        "op": "discriminator", "schema": schema, "path": path, "name": self.js(name), "discriminator": discriminator,
      }),
      Op::Index { schema, fields, options } => {
        json!({ "op": "index", "schema": schema, "fields": self.val(fields), "options": self.val(options) })
      }
      Op::Paginate { schema, options } => {
        json!({ "op": "plugin", "plugin": "paginate", "schema": schema, "options": self.val(options) })
      }
      Op::BuildQuery { schema, args } => {
        let args = args.as_ref().map(|args| {
          let mut out = serde_json::Map::new();
          if let Some(slug) = &args.collection_slug {
            out.insert("collectionSlug".into(), self.js(slug));
          }
          match args.versions_fields {
            Some(VersionsFields::Collection(i)) => {
              out.insert("versionsFields".into(), json!({ "collection": i }));
            }
            Some(VersionsFields::Global(i)) => {
              out.insert("versionsFields".into(), json!({ "global": i }));
            }
            None => {}
          }
          Json::Object(out)
        });
        json!({ "op": "plugin", "plugin": "buildQuery", "schema": schema, "args": args })
      }
      Op::Model { id, name, schema, collection, assign } => {
        let mut out = json!({
          "op": "model", "id": id, "name": self.js(name), "schema": schema, "collection": self.js(collection),
        });
        match assign {
          Some(ModelTarget::Collections(slug)) => out["assign"] = json!({ "collections": self.js(slug) }),
          Some(ModelTarget::Versions(slug)) => out["assign"] = json!({ "versions": self.js(slug) }),
          None => {}
        }
        out
      }
      Op::ModelDiscriminator { model, name, schema } => {
        json!({ "op": "modelDiscriminator", "model": model, "name": self.js(name), "schema": schema })
      }
      Op::AssignGlobals { model } => json!({ "op": "globals", "model": model }),
      Op::Throw(error) => json!({ "op": "throw", "error": error.to_json() }),
    }
  }
}

fn for_each_value(op: &Op, f: &mut impl FnMut(&DVal)) {
  match op {
    Op::NewSchema { definition, options, .. } => {
      f(definition);
      f(options);
    }
    Op::Add { definition, .. } => f(definition),
    Op::Index { fields, options, .. } => {
      f(fields);
      f(options);
    }
    Op::Paginate { options, .. } => f(options),
    Op::Discriminator { .. }
    | Op::BuildQuery { .. }
    | Op::Model { .. }
    | Op::ModelDiscriminator { .. }
    | Op::AssignGlobals { .. }
    | Op::Throw(_) => {}
  }
}

fn for_each_js(op: &Op, f: &mut impl FnMut(&JsVal)) {
  match op {
    Op::Discriminator { name, .. } | Op::ModelDiscriminator { name, .. } => f(name),
    Op::BuildQuery { args: Some(BuildQueryArgs { collection_slug: Some(slug), .. }), .. } => f(slug),
    Op::Model { name, collection, assign, .. } => {
      f(name);
      f(collection);
      match assign {
        Some(ModelTarget::Collections(slug) | ModelTarget::Versions(slug)) => f(slug),
        None => {}
      }
    }
    _ => {}
  }
}
