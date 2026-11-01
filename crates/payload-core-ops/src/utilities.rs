//! Ports of the small synchronous utilities the read operations call, on live JS values:
//! - `appendNonTrashedFilter` (utilities/appendNonTrashedFilter.ts)
//! - `appendVersionToQueryKey` (versions/drafts/appendVersionToQueryKey.ts)
//! - `getSelectMode` (utilities/getSelectMode.ts)
//! - `getQueryDraftsSelect`, `getQueryDraftsSort` (versions/drafts)
//! - `sanitizeInternalFields` (utilities/sanitizeInternalFields.ts)
//! - the lock-status blocks of find.ts / findByID.ts
//!
//! Object literals and spreads are host helpers (key order, getters, `__proto__` keys); the
//! branches, loops and comparisons are here. Loops over caller values use the JS built-ins
//! (`Array.prototype.map/filter/find`, `for...of`, `for...in`) through the host.

use payload_core_runtime::host as rt;
use payload_core_runtime::js::{self, JsResult, Local, Type, Val};

use crate::host::{
  self, ForIn, ForOf, call, call_val, get, get_key, is_array, is_false, is_string, is_typeof_object, opt, set, val,
  with_callback,
};

const DOT: u16 = b'.' as u16;
const MINUS: u16 = b'-' as u16;

fn units(s: &str) -> Vec<u16> {
  s.encode_utf16().collect()
}

fn units_eq(u: &[u16], lit: &str) -> bool {
  u.iter().copied().eq(lit.encode_utf16())
}

/// `appendNonTrashedFilter({ deletedAtPath, enableTrash, trash, where })`
pub fn append_non_trashed_filter(deleted_at_path: &str, enable_trash: Local, trash: Local, where_: Local) -> JsResult<Local> {
  if !js::truthy(enable_trash) || js::truthy(trash) {
    return Ok(where_);
  }
  // { [deletedAtPath]: { exists: false } }
  let not_trashed_filter = call("notTrashedFilter", &[js::string(deleted_at_path)])?;
  if js::truthy(opt(where_, "and")?) {
    // { ...where, and: [...where.and, notTrashedFilter] }
    return call("appendToAnd", &[where_, not_trashed_filter]);
  }
  // { and: [notTrashedFilter, ...(where ? [where] : [])] }
  call("andWithOptional", &[not_trashed_filter, where_])
}

/// `appendVersionToQueryKey(query = {})` (`idPath` `'parent'`).
pub fn append_version_to_query_key(query: Local) -> JsResult<Local> {
  if js::type_of(query) == Type::Undefined {
    return Ok(js::object());
  }
  append_version_with_id_path(query, Some("parent"))
}

/// `appendVersionToQueryKeyWithIDPath(query, idPath)`: `Object.entries(query).reduce((res, [key,
/// val]) => ({ ...res, [newKey]: newVal }), {})`. The accumulator is internal, so one object with
/// the keys defined in order is the same result (a repeated key keeps its first position).
fn append_version_with_id_path(query: Local, id_path: Option<&str>) -> JsResult<Local> {
  let entries = rt::object_entries(query)?;
  let res = js::object();
  for i in 0..js::array_length(entries) {
    let entry = js::get_element(entries, i)?;
    let key = js::get_element(entry, 0)?;
    let value = js::get_element(entry, 1)?;
    let key_units = js::get_string_utf16(key).unwrap_or_default();
    // ['and', 'or'].includes(key.toLowerCase()) (only ASCII letters lower-case to these)
    let lower: Vec<u16> =
      key_units.iter().map(|u| if (u16::from(b'A')..=u16::from(b'Z')).contains(u) { u + 32 } else { *u }).collect();
    if (units_eq(&lower, "and") || units_eq(&lower, "or")) && is_array(value)? {
      // val.map((subQuery) => appendVersionToQueryKeyWithIDPath(subQuery, idPath))
      let mapped = host::map_array(value, "val", |sub_query| append_version_with_id_path(sub_query, id_path))?;
      js::set_property(res, host::string_utf16(&lower), mapped)?;
    } else {
      let new_key = match id_path {
        Some(id_path) if units_eq(&key_units, "id") => units(id_path),
        _ => {
          let mut k = units("version.");
          k.extend_from_slice(&key_units);
          k
        }
      };
      js::set_property(res, host::string_utf16(&new_key), value)?;
    }
  }
  Ok(res)
}

/// `getSelectMode(select)`: `'include'` or `'exclude'`.
pub fn get_select_mode(select: Local) -> JsResult<&'static str> {
  let keys = ForIn::new(select)?;
  while let Some(key) = keys.next()? {
    let select_value = get_key(select, key)?;
    if is_false(select_value) {
      return Ok("exclude");
    }
    if is_typeof_object(select_value) {
      return get_select_mode(select_value);
    }
  }
  Ok("include")
}

/// `getQueryDraftsSelect({ select })`
pub fn get_query_drafts_select(select: Local) -> JsResult<Local> {
  if !js::truthy(select) {
    return Ok(js::undefined());
  }
  let include = get_select_mode(select)? == "include";
  // { parent: true, version: select } / { version: select }
  call("draftsSelect", &[select, js::boolean(include)])
}

/// `getQueryDraftsSort({ collectionConfig, sort })`
pub fn get_query_drafts_sort(collection_config: Local, sort: Local) -> JsResult<Local> {
  let mut sort = sort;
  if !js::truthy(sort) {
    sort = if js::truthy(get(collection_config, "defaultSort")?) {
      get(collection_config, "defaultSort")?
    } else {
      js::string("-createdAt")
    };
  }
  if is_string(sort) {
    // sort = [sort]
    let arr = js::array();
    js::set_element(arr, 0, sort)?;
    sort = arr;
  }
  host::map_array(sort, "sort", |field| {
    let Some(field_units) = js::get_string_utf16(field) else {
      // the arrow's body on a non-string (`field[0]`, template literal coercions)
      return call("draftsSortField", &[field]);
    };
    let (direction, order_by): (&[u16], &[u16]) =
      if field_units.first() == Some(&MINUS) { (&field_units[..1], &field_units[1..]) } else { (&[], &field_units[..]) };
    let mut out = direction.to_vec();
    if units_eq(order_by, "id") {
      out.extend(units("parent"));
    } else {
      out.extend(units("version."));
      out.extend_from_slice(order_by);
    }
    Ok(host::string_utf16(&out))
  })
}

/// `sanitizeInternalFields(incomingDoc)`: a new object with `_id` renamed to `id` and `__v` left
/// out.
pub fn sanitize_internal_fields(incoming_doc: Local) -> JsResult<Local> {
  let new_doc = js::object();
  let keys = ForIn::new(incoming_doc)?;
  while let Some(key) = keys.next()? {
    let value = get_key(incoming_doc, key)?;
    let key_units = js::get_string_utf16(key).unwrap_or_default();
    if units_eq(&key_units, "_id") {
      js::set_named(new_doc, "id", value)?;
    } else if !units_eq(&key_units, "__v") {
      // `newDoc[key] = val` on a fresh plain object (a `__proto__` key sets the prototype, as in JS)
      js::set_property(new_doc, key, value)?;
    }
  }
  Ok(new_doc)
}

/// `lockDuration * 1000` of find.ts / findByID.ts:
/// `typeof lockDocumentsProp === 'object' ? lockDocumentsProp.duration : lockDurationDefault`.
pub fn lock_duration_ms(collection_config: Local) -> JsResult<Val> {
  let lock_documents_prop = opt(collection_config, "lockDocuments")?;
  let lock_duration =
    if is_typeof_object(lock_documents_prop) { get(lock_documents_prop, "duration")? } else { js::number(300.0) };
  if js::type_of(lock_duration) == Type::Number {
    return val(js::number(js::get_f64(lock_duration) * 1000.0));
  }
  // ToNumeric coercions (and their errors) of `*`
  call_val("times1000", &[lock_duration])
}

/// The lock-status `try` block of find.ts after `payload.find(...)`: drops stale locks and marks
/// every doc of `result.docs`.
pub fn apply_find_lock_status(locked_documents: Local, result: Local, now: f64, lock_ms: f64) -> JsResult<()> {
  // Array.isArray(lockedDocuments?.docs) ? lockedDocuments.docs : []
  let locked_docs =
    if is_array(opt(locked_documents, "docs")?)? { get(locked_documents, "docs")? } else { js::array() };

  // lockedDocs.filter((lock) => new Date(lock?.updatedAt).getTime() + lockDurationInMilliseconds > now)
  let valid_locked_docs = val(with_callback("filterWith", &[locked_docs], |lock| {
    let last_edited_at = call("dateTime", &[opt(lock, "updatedAt")?])?;
    Ok(js::boolean(js::get_f64(last_edited_at) + lock_ms > now))
  })?)?;

  let mut docs = ForOf::of(get(result, "docs")?, "result.docs")?;
  while let Some(doc) = docs.next()? {
    let r = (|| {
      // validLockedDocs.find((lock) => lock?.document?.value === doc.id)
      let locked_doc = with_callback("findWith", &[valid_locked_docs.get()], |lock| {
        let value = opt(opt(lock, "document")?, "value")?;
        Ok(js::boolean(js::strict_equals(value, get(doc, "id")?)))
      })?;
      set(doc, "_isLocked", js::boolean(js::truthy(locked_doc)))?;
      let user_editing =
        if js::truthy(locked_doc) { opt(opt(locked_doc, "user")?, "value")? } else { js::null() };
      set(doc, "_userEditing", user_editing)
    })();
    if r.is_err() {
      docs.close();
      return r;
    }
  }
  Ok(())
}

/// The `catch` block of find.ts' lock status: `for (const doc of result.docs) { doc._isLocked =
/// false; doc._userEditing = null }`.
pub fn reset_find_lock_status(result: Local) -> JsResult<()> {
  let mut docs = ForOf::of(get(result, "docs")?, "result.docs")?;
  while let Some(doc) = docs.next()? {
    let r = set(doc, "_isLocked", js::boolean(false)).and_then(|()| set(doc, "_userEditing", js::null()));
    if r.is_err() {
      docs.close();
      return r;
    }
  }
  Ok(())
}

/// findByID.ts: `if (lockedDocument && lockedDocument.docs.length > 0) { lockStatus =
/// lockedDocument.docs[0]! }` (`null` otherwise).
pub fn lock_status_of(locked_document: Local) -> JsResult<Val> {
  if js::truthy(locked_document) {
    let length = get(get(locked_document, "docs")?, "length")?;
    let has_docs = if js::type_of(length) == Type::Number {
      js::get_f64(length) > 0.0
    } else {
      js::truthy(call("lessThan", &[js::number(0.0), length])?)
    };
    if has_docs {
      return val(get_key(get(locked_document, "docs")?, js::number(0.0))?);
    }
  }
  Ok(Val::Null)
}

/// findByID.ts: `result._isLocked = !!lockStatus; result._userEditing = lockStatus?.user?.value ?? null`
pub fn apply_lock_status(result: Local, lock_status: Local) -> JsResult<()> {
  set(result, "_isLocked", js::boolean(js::truthy(lock_status)))?;
  let user_editing = opt(opt(lock_status, "user")?, "value")?;
  set(result, "_userEditing", if host::is_nullish(user_editing) { js::null() } else { user_editing })
}

/// `sort.split('.')` on code units.
pub fn split_dot(s: &[u16]) -> Vec<&[u16]> {
  s.split(|u| *u == DOT).collect()
}
