//! The unique-value lookups of the all-locales publish validation (prepare/unique.rs) as the
//! drivers run them: upstream's `fieldValueExists` is a `payload.find({ where: { [path]: { equals:
//! value } }, locale, limit: 2, depth: 0, overrideAccess: true, pagination: false })` outside the
//! operation's transaction, a conflict (`docs.some((doc) => doc.id !== id)`) a `ValidationError`.
//! Run without a session before any statement; a conflict bails (the exact lane throws).
//!
//! The finds arrive as templates (`ut`, src/fuse-write/mongo.ts `uniqueLookupTemplates`):
//! db-mongodb's `buildQuery` of the where with a sentinel value, cast by mongoose, per unique path
//! and locale; the value of a lookup replaces the sentinel here.

use payload_mongo_driver::mongodb::bson::{Bson, Document, RawDocument, oid::ObjectId};
use payload_mongo_driver::{FindSpec, find_raw, find_spec};

/// What a lookup's value is cast as (the template's sentinel).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
  /// A String path: the value is a string.
  Str,
  /// A Number path: a number.
  Num,
  /// A relationship to ObjectId ids: a 24-character lowercase hex string (mongoose casts the
  /// ObjectId; db-mongodb may also keep the string).
  Oid,
}

struct Template {
  path: String,
  locale: String,
  kind: Kind,
  find: FindSpec,
}

pub struct UniqueTemplates {
  collection: String,
  sentinel_str: String,
  sentinel_num: f64,
  sentinel_oid: ObjectId,
  templates: Vec<Template>,
}

/// Decodes `{ c, s: { str, num, oid }, t: [{ p, l, k: 'str' | 'num' | 'oid', f: <find spec> }] }`.
pub fn decode(doc: &RawDocument) -> Result<UniqueTemplates, String> {
  let doc = Document::try_from(doc).map_err(|e| e.to_string())?;
  let sentinels = doc.get_document("s").map_err(|_| "unique:s")?;
  let mut templates = Vec::new();
  for item in doc.get_array("t").map_err(|_| "unique:t")? {
    let Bson::Document(item) = item else { return Err("unique:t".to_string()) };
    let kind = match item.get_str("k").map_err(|_| "unique:k")? {
      "str" => Kind::Str,
      "num" => Kind::Num,
      "oid" => Kind::Oid,
      _ => return Err("unique:k".to_string()),
    };
    templates.push(Template {
      path: item.get_str("p").map_err(|_| "unique:p")?.to_string(),
      locale: item.get_str("l").map_err(|_| "unique:l")?.to_string(),
      kind,
      find: find_spec(item.get_document("f").map_err(|_| "unique:f")?).map_err(|e| e.to_string())?,
    });
  }
  Ok(UniqueTemplates {
    collection: doc.get_str("c").map_err(|_| "unique:c")?.to_string(),
    sentinel_str: sentinels.get_str("str").map_err(|_| "unique:s")?.to_string(),
    sentinel_num: sentinels.get_f64("num").map_err(|_| "unique:s")?,
    sentinel_oid: sentinels.get_object_id("oid").map_err(|_| "unique:s")?,
    templates,
  })
}

/// Runs the lookups `(path, locale, value)` in order, without a session; `id`: the document an
/// update writes (its own value is no conflict). `Err`: the bail reason (`!`-prefixed).
pub async fn run(
  client: u32,
  database: Option<&str>,
  templates: Option<&UniqueTemplates>,
  lookups: &[(String, String, Bson)],
  id: Option<&str>,
) -> Result<(), String> {
  if lookups.is_empty() {
    return Ok(());
  }
  let templates = templates.ok_or("!unique:templates")?;
  for (path, locale, value) in lookups {
    let template = templates
      .templates
      .iter()
      .find(|t| &t.path == path && &t.locale == locale)
      .ok_or("!drafts:localizedPublish:unique:template")?;
    let mut filter = template.find.filter.clone();
    if substitute(templates, template.kind, &mut filter, value)? == 0 {
      return Err("!drafts:localizedPublish:unique:sentinel".to_string());
    }
    let find = FindSpec {
      filter,
      sort: template.find.sort.clone(),
      projection: template.find.projection.clone(),
      skip: template.find.skip,
      limit: template.find.limit,
      collation: template.find.collation.clone(),
      hint: template.find.hint.clone(),
    };
    let docs = find_raw(client, database, &templates.collection, find, None).await.map_err(|_| "!drafts:localizedPublish:unique:find")?;
    for doc in docs {
      let other = match doc.get("_id") {
        Ok(Some(payload_mongo_driver::mongodb::bson::RawBsonRef::ObjectId(oid))) => id != Some(oid.to_hex().as_str()),
        _ => return Err("!drafts:localizedPublish:unique:id".to_string()),
      };
      if other {
        return Err("!drafts:localizedPublish:unique:conflict".to_string());
      }
    }
  }
  Ok(())
}

/// Replaces the template's sentinel with `value` in `filter`; the number of replacements.
fn substitute(templates: &UniqueTemplates, kind: Kind, filter: &mut Document, value: &Bson) -> Result<usize, String> {
  let bad = || "!drafts:localizedPublish:unique:value".to_string();
  let (from, to): (Vec<Bson>, Vec<Bson>) = match kind {
    Kind::Str => match value {
      Bson::String(_) => (vec![Bson::String(templates.sentinel_str.clone())], vec![value.clone()]),
      _ => return Err(bad()),
    },
    Kind::Num => match value {
      Bson::Int32(_) | Bson::Int64(_) | Bson::Double(_) => (vec![Bson::Double(templates.sentinel_num)], vec![js_number(value)]),
      _ => return Err(bad()),
    },
    Kind::Oid => match value {
      Bson::String(hex) if hex.len() == 24 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {
        let oid = ObjectId::parse_str(hex).map_err(|_| bad())?;
        (
          vec![Bson::ObjectId(templates.sentinel_oid), Bson::String(templates.sentinel_oid.to_hex())],
          vec![Bson::ObjectId(oid), value.clone()],
        )
      }
      _ => return Err(bad()),
    },
  };
  fn walk(value: &mut Bson, from: &[Bson], to: &[Bson]) -> usize {
    if let Some(at) = from.iter().position(|f| f == value) {
      *value = to[at].clone();
      return 1;
    }
    match value {
      Bson::Document(doc) => doc.iter_mut().map(|(_, v)| walk(v, from, to)).sum(),
      Bson::Array(items) => items.iter_mut().map(|v| walk(v, from, to)).sum(),
      _ => 0,
    }
  }
  Ok(filter.iter_mut().map(|(_, v)| walk(v, &from, &to)).sum())
}

/// A number as js-bson serializes it: an integer in the Int32 range as Int32, else a Double.
fn js_number(value: &Bson) -> Bson {
  let n = match value {
    Bson::Int32(n) => return Bson::Int32(*n),
    Bson::Int64(n) => *n as f64,
    Bson::Double(n) => *n,
    _ => return value.clone(),
  };
  if n.fract() == 0.0 && n >= i32::MIN as f64 && n <= i32::MAX as f64 && !(n == 0.0 && n.is_sign_negative()) {
    Bson::Int32(n as i32)
  } else {
    Bson::Double(n)
  }
}
