//! The synchronous segments of the `async` validators of `validations.ts` (json, richText,
//! validateBlocksFilterOptions, blocks, upload / relationship with validateFilterOptions,
//! select). shell.js holds the async functions with their parameter destructuring and every
//! `await` at the upstream position; each segment here runs the TS between two awaits on the
//! live values and returns `NEXT` where the shell continues.

use std::cell::RefCell;

use payload_core_runtime::js::{self, JsResult, Local};

use crate::ops::{
  Cx, V, eq_num, eq_str, is_false, is_nullish, is_string, is_true, is_typeof_object, number_value, same_value_zero,
  strict_eq, truthy, ty, yes,
};
use crate::validators::{option_matches, validate_array_length};

/// `json` up to `return validateJSONSchema({ jsonSchema, value })` (`NEXT`, made by the shell).
pub fn json(cx: &Cx, args: [V; 5]) -> JsResult<Local> {
  let [value, json_error, json_schema, t, required] = args;

  if truthy(required) && !truthy(value) {
    return cx.t(t, "validation:required", None);
  }

  if ty(json_error) != js::Type::Undefined {
    return cx.t(t, "validation:invalidInput", None);
  }

  if truthy(json_schema) && is_not_empty(cx, value)? {
    return Ok(cx.next.get());
  }
  Ok(yes())
}

/// `isNotEmpty(value)` of `json`.
fn is_not_empty(cx: &Cx, value: V) -> JsResult<bool> {
  if is_nullish(value) {
    return Ok(false);
  }
  if cx.is_array(value)? && eq_num(cx.length(value)?, 0.0) {
    return Ok(false);
  }
  if is_typeof_object(value) && eq_num(cx.helper(&cx.h_object_keys_length, &[value.v])?, 0.0) {
    return Ok(false);
  }
  Ok(true)
}

/// The whole `richText` body (it has no await of its own).
pub fn rich_text(cx: &Cx, args: [V; 2]) -> JsResult<Local> {
  let [value, options] = args;
  if !truthy(cx.get_opt(options, "editor")?) {
    return Err(cx.error("richText field has no editor property."));
  }
  if ty(cx.get_opt(options, "editor")?) == js::Type::Function {
    return Err(cx.error("Attempted to access unsanitized rich text editor."));
  }

  let editor = cx.get_opt(options, "editor")?;

  cx.call_method(editor, "validate", &[value.v, options.v], "editor")
}

/// `validateBlocksFilterOptions`: `allBlockSlugs`.
pub fn all_block_slugs(cx: &Cx, args: [V; 1]) -> JsResult<Local> {
  let [value] = args;
  if cx.is_array(value)? {
    let mapped = cx.map(value, "value", &|b| cx.get(b, "blockType"))?;
    return cx.filter(mapped, "value.map(...)", &|s| Ok(truthy(s)));
  }
  cx.array_of(&[])
}

/// `validateBlocksFilterOptions` after the `filterOptions` await: the result object.
pub fn blocks_filter_result(cx: &Cx, args: [V; 2]) -> JsResult<Local> {
  let [all_block_slugs, allowed_block_slugs] = args;
  let invalid_block_slugs = cx.array_of(&[])?;
  if truthy(allowed_block_slugs) {
    cx.for_of(all_block_slugs, "allBlockSlugs", &|block_slug| {
      if !truthy(cx.includes(allowed_block_slugs, block_slug, "allowedBlockSlugs")?) {
        cx.push(invalid_block_slugs, block_slug, "invalidBlockSlugs")?;
      }
      Ok(None)
    })?;
  }

  cx.object(&[
    ("allBlockSlugs", all_block_slugs.v),
    ("allowedBlockSlugs", allowed_block_slugs.v),
    ("invalidBlockSlugs", invalid_block_slugs),
  ])
}

/// `blocks` up to the `validateBlocksFilterOptions` await (`NEXT` when `filterOptions` is set).
pub fn blocks(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  let [value, filter_options, max_rows, min_rows, required, t] = args;
  let length_validation_result = validate_array_length(cx, value, max_rows, min_rows, required, t)?;
  if is_string(length_validation_result) {
    return Ok(length_validation_result);
  }

  if truthy(filter_options) {
    return Ok(cx.next.get());
  }

  Ok(yes())
}

/// `blocks` after the await, with the destructured `invalidBlockSlugs`.
pub fn blocks_invalid(cx: &Cx, args: [V; 2]) -> JsResult<Local> {
  let [invalid_block_slugs, t] = args;
  if truthy(cx.length_opt(invalid_block_slugs)?) {
    let blocks = cx.call_method(invalid_block_slugs, "join", &[js::string(", ")], "invalidBlockSlugs")?;
    return cx.t(t, "validation:invalidBlocks", Some(cx.object(&[("blocks", blocks)])?));
  }

  Ok(yes())
}

/// `isValidID(value, type)` (`payload/src/utilities/isValidID.ts`)
fn is_valid_id(cx: &Cx, value: Local, id_type: Local) -> JsResult<bool> {
  if eq_str(id_type, "text") && truthy(value) {
    if is_typeof_object(value) || is_string(value) {
      let is_object_id = truthy(cx.helper(&cx.h_object_id_is_valid, &[value])?);
      return Ok(is_string(value) || is_object_id);
    }
    return Ok(false);
  }

  if eq_str(id_type, "number") && number_value(value).is_some_and(|n| !n.is_nan()) {
    return Ok(true);
  }

  if eq_str(id_type, "ObjectID") {
    return Ok(truthy(cx.helper(&cx.h_object_id_is_valid, &[cx.string(value)?])?));
  }

  Ok(false)
}

/// `upload` / `relationship` (identical bodies) up to `return validateFilterOptions(value,
/// options)` (`NEXT`).
pub fn relationship(cx: &Cx, args: [V; 8]) -> JsResult<Local> {
  let [value, event, max_rows, min_rows, relation_to, payload, t, required] = args;

  if ((!truthy(value) && ty(value) != js::Type::Number) || (cx.is_array(value)? && eq_num(cx.length(value)?, 0.0)))
    && truthy(required)
  {
    return cx.t(t, "validation:required", None);
  }

  if cx.is_array(value)? && cx.gt(cx.length(value)?, js::number(0.0))? {
    if truthy(min_rows) && cx.lt(cx.length(value)?, min_rows)? {
      let label = cx.t(t, "general:rows", None)?;
      let vars = cx.object(&[("label", label), ("min", min_rows.v), ("value", cx.length(value)?)])?;
      return cx.t(t, "validation:lessThanMin", Some(vars));
    }

    if truthy(max_rows) && cx.gt(cx.length(value)?, max_rows)? {
      let label = cx.t(t, "general:rows", None)?;
      let vars = cx.object(&[("label", label), ("max", max_rows.v), ("value", cx.length(value)?)])?;
      return cx.t(t, "validation:greaterThanMax", Some(vars));
    }
  }

  if !is_nullish(value) {
    let values = if cx.is_array(value)? { value.v } else { cx.array_of(&[value.v])? };

    let is_invalid = |val: Local| -> JsResult<bool> {
      let mut collection_slug = js::undefined();
      let mut requested_id = js::undefined();

      if is_string(relation_to) {
        collection_slug = relation_to.v;

        // custom id
        if truthy(val) || ty(val) == js::Type::Number {
          requested_id = val;
        }
      }

      if cx.is_array(relation_to)? && is_typeof_object(val) && truthy(cx.get_opt(val, "relationTo")?) {
        collection_slug = cx.get(val, "relationTo")?;
        requested_id = cx.get(val, "value")?;
      }

      if ty(requested_id) == js::Type::Null {
        return Ok(false);
      }

      let mut id_type = cx.get_opt(cx.get_key(cx.get(payload, "collections")?, collection_slug)?, "customIDType")?;
      if !truthy(id_type) {
        id_type = cx.get_opt(cx.get_opt(payload, "db")?, "defaultIDType")?;
      }
      if !truthy(id_type) {
        id_type = js::string("text");
      }

      Ok(!is_valid_id(cx, requested_id, id_type)?)
    };
    let invalid_relationships = cx.filter(values, "values", &is_invalid)?;

    if cx.gt(cx.length(invalid_relationships)?, js::number(0.0))? {
      return cx.helper(&cx.h_invalid_relationships_message, &[invalid_relationships]);
    }
  }

  if eq_str(event, "onChange") {
    return Ok(yes());
  }

  Ok(cx.next.get())
}

/// `validateFilterOptions`, one collection after the `filterOptions` await (`optionFilter`
/// already mapped from `true` to `null`): collects the value IDs and returns the
/// `req.payloadDataLoader.find` arguments, or `NEXT` when there are none.
pub fn filter_options_find(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  let [values, option_filter, collection, false_collections, override_access, req] = args;
  let value_ids = cx.array_of(&[])?;

  cx.for_each(values, "values", &|val| {
    if is_typeof_object(val) {
      if truthy(cx.get_opt(val, "value")?) {
        cx.push(value_ids, cx.get(val, "value")?, "valueIDs")?;
      } else if truthy(cx.helper(&cx.h_object_id_is_valid, &[val])?) {
        cx.push(value_ids, cx.helper(&cx.h_object_id_hex, &[val])?, "valueIDs")?;
      }
    }

    if is_string(val) || ty(val) == js::Type::Number {
      cx.push(value_ids, val, "valueIDs")?;
    }
    Ok(())
  })?;

  if js::array_length(value_ids) == 0 {
    return Ok(cx.next.get());
  }

  let and = cx.array_of(&[cx.object(&[("id", cx.object(&[("in", value_ids)])?)])?])?;
  let find_where = cx.object(&[("and", and)])?;

  if truthy(option_filter) && !is_true(option_filter) {
    cx.push(and, option_filter, "findWhere.and")?;
  }

  if is_false(option_filter) {
    cx.push(false_collections, collection, "falseCollections")?;
  }

  cx.object(&[
    ("collection", collection.v),
    ("depth", js::number(0.0)),
    ("disableErrors", js::boolean(true)),
    ("limit", js::number(0.0)),
    ("overrideAccess", if is_nullish(override_access) { js::boolean(false) } else { override_access.v }),
    ("pagination", js::boolean(false)),
    ("req", req.v),
    ("where", find_where),
  ])
}

/// `result.docs.map((doc) => doc.id)`
pub fn doc_ids(cx: &Cx, args: [V; 1]) -> JsResult<Local> {
  let [result] = args;
  let docs = cx.get(result, "docs")?;
  cx.map(docs, "result.docs", &|doc| cx.get(doc, "id"))
}

/// `validateFilterOptions` after the collection loop.
pub fn filter_options_result(cx: &Cx, args: [V; 5]) -> JsResult<Local> {
  let [values, relation_to, false_collections, options, t] = args;

  let is_invalid = |val: Local| -> JsResult<bool> {
    let mut collection = js::undefined();
    let mut requested_id = js::undefined();

    if is_string(relation_to) {
      collection = relation_to.v;

      if is_string(val) || ty(val) == js::Type::Number {
        requested_id = val;
      }

      if is_typeof_object(val) && truthy(cx.helper(&cx.h_object_id_is_valid, &[val])?) {
        requested_id = cx.helper(&cx.h_object_id_hex, &[val])?;
      }
    }

    if cx.is_array(relation_to)? && is_typeof_object(val) && truthy(cx.get_opt(val, "relationTo")?) {
      collection = cx.get(val, "relationTo")?;
      requested_id = cx.get(val, "value")?;
    }

    if truthy(cx.find(false_collections, "falseCollections", &|slug| Ok(strict_eq(relation_to, slug)))?) {
      return Ok(true);
    }

    if !truthy(cx.get_key(options, collection)?) {
      return Ok(true);
    }

    let index = cx.index_of(cx.get_key(options, collection)?, requested_id, "options[collection]")?;
    Ok(eq_num(index, -1.0))
  };
  let invalid_relationships = cx.filter(values, "values", &is_invalid)?;

  if cx.gt(cx.length(invalid_relationships)?, js::number(0.0))? {
    return cx.helper(&cx.h_invalid_selections_message, &[invalid_relationships, t.v]);
  }

  Ok(yes())
}

/// `select` after the `filterOptions` await.
pub fn select(cx: &Cx, args: [V; 5]) -> JsResult<Local> {
  let [value, filtered_options, has_many, t, required] = args;

  if cx.is_array(value)? {
    let input_is_invalid = |input: Local| -> JsResult<bool> {
      let matches = |option: Local| -> JsResult<bool> {
        Ok(strict_eq(option, input) || (!is_string(option) && strict_eq(cx.get_opt(option, "value")?, input)))
      };
      Ok(!truthy(cx.some(filtered_options, "filteredOptions", &matches)?))
    };
    if truthy(cx.some(value, "value", &input_is_invalid)?) {
      return cx.t(t, "validation:invalidSelection", None);
    }
  }

  // Check for duplicate values when hasMany is true
  if truthy(has_many) && cx.is_array(value)? && cx.gt(cx.length(value)?, js::number(1.0))? {
    // `new Map()` keyed by SameValueZero, insertion ordered (`-0` is stored as `+0`).
    let counts: RefCell<Vec<(Local, f64)>> = RefCell::new(Vec::new());

    cx.for_of(value, "value", &|item| {
      let mut counts = counts.borrow_mut();
      match counts.iter_mut().find(|(key, _)| same_value_zero(*key, item)) {
        Some((_, count)) => *count += 1.0,
        None => counts.push((if eq_num(item, 0.0) { js::number(0.0) } else { item }, 1.0)),
      }
      Ok(None)
    })?;

    let duplicates = cx.array_of(&[])?;
    // for (const [item, count] of counts.entries())
    for (key, count) in counts.into_inner() {
      let (item, count) = cx.destructure_pair(key, js::number(count))?;
      if cx.gt(count, js::number(1.0))? {
        // Add the item 'count' times to show all occurrences
        let mut i = 0.0;
        while cx.lt(js::number(i), count)? {
          cx.push(duplicates, item, "duplicates")?;
          i += 1.0;
        }
      }
    }

    if js::array_length(duplicates) > 0 {
      return cx.helper(&cx.h_duplicates_message, &[duplicates, t.v]);
    }
  }

  if is_string(value) {
    if !truthy(cx.some(filtered_options, "filteredOptions", &|option| option_matches(cx, option, value))?) {
      return cx.t(t, "validation:invalidSelection", None);
    }
  }

  if truthy(required)
    && (is_nullish(value) || (truthy(has_many) && cx.is_array(value)? && eq_num(cx.length_opt(value)?, 0.0)))
  {
    return cx.t(t, "validation:required", None);
  }

  Ok(yes())
}
