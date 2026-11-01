//! The synchronous segments of the `async` validators of `validations.ts` (json, richText,
//! validateBlocksFilterOptions, blocks, upload / relationship with validateFilterOptions,
//! select). shell.js holds the async functions with their parameter destructuring and every
//! `await` at the upstream position; each segment here runs the TS between two awaits on the
//! live values and returns `NEXT` where the shell continues.

use std::cell::RefCell;

use payload_core_runtime::js::{JsResult, Local, Type};

use crate::keys::K;
use crate::ops::{Cx, Held, Loop, V};
use crate::validators::{option_matches, validate_array_length};

/// `json` up to `return validateJSONSchema({ jsonSchema, value })` (`NEXT`, made by the shell).
pub fn json(cx: &Cx, args: [V; 5]) -> JsResult<Local> {
  let [value, json_error, json_schema, t, required] = args;

  if required.truthy() && !value.truthy() {
    return cx.t(t, K::Required, None);
  }

  if !json_error.is_undefined() {
    return cx.t(t, K::InvalidInput, None);
  }

  if json_schema.truthy() && is_not_empty(cx, value)? {
    return Ok(cx.next());
  }
  Ok(cx.yes())
}

/// `isNotEmpty(value)` of `json`.
fn is_not_empty(cx: &Cx, value: V) -> JsResult<bool> {
  if value.is_nullish() {
    return Ok(false);
  }
  if cx.is_array(value)? && cx.length_is_zero(value)? {
    return Ok(false);
  }
  if value.is_typeof_object() && cx.eq_num(cx.of(cx.helper(&cx.h_object_keys_length, &[value.v])?), 0.0) {
    return Ok(false);
  }
  Ok(true)
}

/// The whole `richText` body (it has no await of its own).
pub fn rich_text(cx: &Cx, args: [V; 2]) -> JsResult<Local> {
  let [value, options] = args;
  if !cx.get_opt(options, K::Editor)?.truthy() {
    return Err(cx.error("richText field has no editor property."));
  }
  if cx.get_opt(options, K::Editor)?.ty() == Type::Function {
    return Err(cx.error("Attempted to access unsanitized rich text editor."));
  }

  let editor = cx.get_opt(options, K::Editor)?;

  cx.call_method(editor, K::Validate, &[value.v, options.v], "editor")
}

/// `validateBlocksFilterOptions`: `allBlockSlugs`.
pub fn all_block_slugs(cx: &Cx, args: [V; 1]) -> JsResult<Local> {
  let [value] = args;
  if cx.is_array(value)? {
    let mapped = cx.map(value, "value", &|b| cx.get(b, K::BlockType))?;
    return Ok(cx.filter(mapped, "value.map(...)", &|s| Ok(s.truthy()))?.v);
  }
  cx.array_of(&[])
}

/// `validateBlocksFilterOptions` after the `filterOptions` await: the result object.
pub fn blocks_filter_result(cx: &Cx, args: [V; 2]) -> JsResult<Local> {
  let [all_block_slugs, allowed_block_slugs] = args;
  let invalid_block_slugs = cx.of(cx.array_of(&[])?);
  if allowed_block_slugs.truthy() {
    cx.for_of(all_block_slugs, Loop::AllBlockSlugs, &|block_slug| {
      if !cx.includes(allowed_block_slugs, block_slug, "allowedBlockSlugs")?.truthy() {
        cx.push(invalid_block_slugs, block_slug.v, "invalidBlockSlugs")?;
      }
      Ok(None)
    })?;
  }

  cx.object(&[
    (K::AllBlockSlugs, all_block_slugs.v),
    (K::AllowedBlockSlugs, allowed_block_slugs.v),
    (K::InvalidBlockSlugs, invalid_block_slugs.v),
  ])
}

/// `blocks` up to the `validateBlocksFilterOptions` await (`NEXT` when `filterOptions` is set).
pub fn blocks(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  let [value, filter_options, max_rows, min_rows, required, t] = args;
  let length_validation_result = validate_array_length(cx, value, max_rows, min_rows, required, t)?;
  if length_validation_result.is_string() {
    return Ok(length_validation_result.v);
  }

  if filter_options.truthy() {
    return Ok(cx.next());
  }

  Ok(cx.yes())
}

/// `blocks` after the await, with the destructured `invalidBlockSlugs`.
pub fn blocks_invalid(cx: &Cx, args: [V; 2]) -> JsResult<Local> {
  let [invalid_block_slugs, t] = args;
  if cx.length_opt(invalid_block_slugs)?.truthy() {
    let blocks = cx.call_method(invalid_block_slugs, K::Join, &[cx.k(K::CommaSpace)], "invalidBlockSlugs")?;
    return cx.t(t, K::InvalidBlocks, Some(cx.object(&[(K::Blocks, blocks)])?));
  }

  Ok(cx.yes())
}

/// `isValidID(value, type)` (`payload/src/utilities/isValidID.ts`); `id_type` `None` is the
/// literal `'text'`.
fn is_valid_id(cx: &Cx, value: V, id_type: Option<V>) -> JsResult<bool> {
  let is = |literal: &str| match id_type {
    None => literal == "text",
    Some(id_type) => cx.eq_str(id_type, literal),
  };
  if is("text") && value.truthy() {
    if value.is_typeof_object() || value.is_string() {
      let is_object_id = cx.of(cx.helper(&cx.h_object_id_is_valid, &[value.v])?).truthy();
      return Ok(value.is_string() || is_object_id);
    }
    return Ok(false);
  }

  if is("number") && cx.num(value).is_some_and(|n| !n.is_nan()) {
    return Ok(true);
  }

  if is("ObjectID") {
    return Ok(cx.of(cx.helper(&cx.h_object_id_is_valid, &[cx.string(value)?.v])?).truthy());
  }

  Ok(false)
}

/// `upload` / `relationship` (identical bodies) up to `return validateFilterOptions(value,
/// options)` (`NEXT`).
pub fn relationship(cx: &Cx, args: [V; 8]) -> JsResult<Local> {
  let [value, event, relation_to, required, t, payload, max_rows, min_rows] = args;
  let zero = cx.number_v(0.0);

  if ((!value.truthy() && !value.is_number()) || (cx.is_array(value)? && cx.length_is_zero(value)?))
    && required.truthy()
  {
    return cx.t(t, K::Required, None);
  }

  if cx.is_array(value)? && cx.gt(cx.length(value)?, zero)? {
    let (max_rows, min_rows) = (cx.classify(max_rows), cx.classify(min_rows));
    if min_rows.truthy() && cx.lt(cx.length(value)?, min_rows)? {
      let label = cx.t(t, K::GeneralRows, None)?;
      let vars = cx.object(&[(K::Label, label), (K::Min, min_rows.v), (K::Value, cx.length(value)?.v)])?;
      return cx.t(t, K::LessThanMin, Some(vars));
    }

    if max_rows.truthy() && cx.gt(cx.length(value)?, max_rows)? {
      let label = cx.t(t, K::GeneralRows, None)?;
      let vars = cx.object(&[(K::Label, label), (K::Max, max_rows.v), (K::Value, cx.length(value)?.v)])?;
      return cx.t(t, K::GreaterThanMax, Some(vars));
    }
  }

  if !value.is_nullish() {
    let is_invalid = |val: V| -> JsResult<bool> {
      let mut collection_slug = cx.undefined_v();
      let mut requested_id = cx.undefined_v();

      if relation_to.is_string() {
        collection_slug = relation_to;

        // custom id
        if val.truthy() || val.is_number() {
          requested_id = val;
        }
      }

      if cx.is_array(relation_to)? && val.is_typeof_object() && cx.get_opt(val, K::RelationTo)?.truthy() {
        collection_slug = cx.get_v(val, K::RelationTo)?;
        requested_id = cx.get_v(val, K::Value)?;
      }

      if requested_id.is_null() {
        return Ok(false);
      }

      // payload.collections[collectionSlug]?.customIDType || payload?.db?.defaultIDType || 'text'
      let collections = cx.get_v(payload, K::Collections)?;
      let mut id_type = cx.get_opt(cx.of(cx.get_key(collections, collection_slug.v)?), K::CustomIDType)?;
      if !id_type.truthy() {
        id_type = cx.get_opt(cx.get_opt(payload, K::Db)?, K::DefaultIDType)?;
      }

      Ok(!is_valid_id(cx, requested_id, id_type.truthy().then_some(id_type))?)
    };
    // `Array.isArray(value) ? value : [value]`
    let invalid_relationships = if cx.is_array(value)? {
      cx.filter(value, "values", &is_invalid)?
    } else {
      cx.filter_literal(value, "values", &is_invalid)?
    };

    if cx.gt(cx.length(invalid_relationships)?, zero)? {
      return cx.helper(&cx.h_invalid_relationships_message, &[invalid_relationships.v]);
    }
  }

  if cx.eq_str(event, "onChange") {
    return Ok(cx.yes());
  }

  Ok(cx.next())
}

/// `validateFilterOptions`, one collection after the `filterOptions` await (`optionFilter`
/// already mapped from `true` to `null`): collects the value IDs and returns the
/// `req.payloadDataLoader.find` arguments, or `NEXT` when there are none.
pub fn filter_options_find(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  let [values, option_filter, collection, false_collections, override_access, req] = args;
  let value_ids = cx.of(cx.array_of(&[])?);

  cx.for_each(values, "values", &|val| {
    if val.is_typeof_object() {
      if cx.get_opt(val, K::Value)?.truthy() {
        cx.push(value_ids, cx.get(val, K::Value)?, "valueIDs")?;
      } else if cx.of(cx.helper(&cx.h_object_id_is_valid, &[val.v])?).truthy() {
        cx.push(value_ids, cx.helper(&cx.h_object_id_hex, &[val.v])?, "valueIDs")?;
      }
    }

    if val.is_string() || val.is_number() {
      cx.push(value_ids, val.v, "valueIDs")?;
    }
    Ok(())
  })?;

  if cx.array_length(value_ids.v) == 0 {
    return Ok(cx.next());
  }

  let and = cx.of(cx.array_of(&[cx.object(&[(K::Id, cx.object(&[(K::In, value_ids.v)])?)])?])?);
  let find_where = cx.object(&[(K::And, and.v)])?;

  if option_filter.truthy() && !option_filter.is_true() {
    cx.push(and, option_filter.v, "findWhere.and?")?;
  }

  if option_filter.is_false() {
    cx.push(false_collections, collection.v, "falseCollections")?;
  }

  cx.object(&[
    (K::Collection, collection.v),
    (K::Depth, cx.number(0.0)),
    (K::DisableErrors, cx.boolean(true)),
    (K::Limit, cx.number(0.0)),
    (K::OverrideAccess, if override_access.is_nullish() { cx.boolean(false) } else { override_access.v }),
    (K::Pagination, cx.boolean(false)),
    (K::Req, req.v),
    (K::Where, find_where),
  ])
}

/// `result.docs.map((doc) => doc.id)`
pub fn doc_ids(cx: &Cx, args: [V; 1]) -> JsResult<Local> {
  let [result] = args;
  let docs = cx.get_v(result, K::Docs)?;
  Ok(cx.map(docs, "result.docs", &|doc| cx.get(doc, K::Id))?.v)
}

/// `validateFilterOptions` after the collection loop.
pub fn filter_options_result(cx: &Cx, args: [V; 5]) -> JsResult<Local> {
  let [values, relation_to, false_collections, options, t] = args;

  let is_invalid = |val: V| -> JsResult<bool> {
    let mut collection = cx.undefined_v();
    let mut requested_id = cx.undefined_v();

    if relation_to.is_string() {
      collection = relation_to;

      if val.is_string() || val.is_number() {
        requested_id = val;
      }

      if val.is_typeof_object() && cx.of(cx.helper(&cx.h_object_id_is_valid, &[val.v])?).truthy() {
        requested_id = cx.of(cx.helper(&cx.h_object_id_hex, &[val.v])?);
      }
    }

    if cx.is_array(relation_to)? && val.is_typeof_object() && cx.get_opt(val, K::RelationTo)?.truthy() {
      collection = cx.get_v(val, K::RelationTo)?;
      requested_id = cx.get_v(val, K::Value)?;
    }

    if cx.find(false_collections, "falseCollections", &|slug| Ok(cx.strict_eq(relation_to.v, slug.v)))?.truthy() {
      return Ok(true);
    }

    if !cx.of(cx.get_key(options, collection.v)?).truthy() {
      return Ok(true);
    }

    let index = cx.index_of(cx.of(cx.get_key(options, collection.v)?), requested_id, "options[collection]")?;
    Ok(cx.eq_num(index, -1.0))
  };
  let invalid_relationships = cx.filter(values, "values", &is_invalid)?;

  if cx.gt(cx.length(invalid_relationships)?, cx.number_v(0.0))? {
    return cx.helper(&cx.h_invalid_selections_message, &[invalid_relationships.v, t.v]);
  }

  Ok(cx.yes())
}

/// `select` after the `filterOptions` await.
pub fn select(cx: &Cx, args: [V; 5]) -> JsResult<Local> {
  let [value, filtered_options, has_many, t, required] = args;

  if cx.is_array(value)? {
    let input_is_invalid = |input: V| -> JsResult<bool> {
      let matches = |option: V| -> JsResult<bool> {
        Ok(cx.strict_eq(option.v, input.v) || (!option.is_string() && cx.strict_eq(cx.get_opt(option, K::Value)?.v, input.v)))
      };
      Ok(!cx.some(filtered_options, "filteredOptions", &matches)?.truthy())
    };
    if cx.some(value, "value", &input_is_invalid)?.truthy() {
      return cx.t(t, K::InvalidSelection, None);
    }
  }

  // Check for duplicate values when hasMany is true
  if has_many.truthy() && cx.is_array(value)? && cx.gt(cx.length(value)?, cx.number_v(1.0))? {
    // `new Map()` keyed by SameValueZero, insertion ordered (`-0` is stored as `+0`). The loop
    // body runs in a callback, so the keys are held beyond its handle scope.
    let counts: RefCell<Vec<(Held, f64)>> = RefCell::new(Vec::new());

    cx.for_of(value, Loop::Value, &|item| {
      let mut counts = counts.borrow_mut();
      match counts.iter_mut().find(|(key, _)| cx.held_equals(key, item)) {
        Some((_, count)) => *count += 1.0,
        None => counts.push((cx.hold(item)?, 1.0)),
      }
      Ok(None)
    })?;

    let counts = counts.into_inner();
    let duplicates = cx.of(cx.array_of(&[])?);
    let mut entries = Vec::with_capacity(counts.len());
    for (key, count) in &counts {
      let key = match key {
        Held::Num(n) if *n == 0.0 => cx.number(0.0),
        key => cx.held_value(key)?,
      };
      entries.push((key, cx.number(*count)));
    }
    let one = cx.number_v(1.0);
    // for (const [item, count] of counts.entries())
    cx.for_of_pairs(&entries, &|i| counts[i].1 <= 1.0, &|item, count| {
      if cx.gt(count, one)? {
        // Add the item 'count' times to show all occurrences
        let mut i = 0.0;
        while cx.lt(cx.number_v(i), count)? {
          cx.push(duplicates, item.v, "duplicates")?;
          i += 1.0;
        }
      }
      Ok(())
    })?;

    if cx.array_length(duplicates.v) > 0 {
      return cx.helper(&cx.h_duplicates_message, &[duplicates.v, t.v]);
    }
  }

  if value.is_string()
    && !cx.some(filtered_options, "filteredOptions", &|option| option_matches(cx, option, value))?.truthy()
  {
    return cx.t(t, K::InvalidSelection, None);
  }

  if required.truthy()
    && (value.is_nullish() || (has_many.truthy() && cx.is_array(value)? && cx.length_is_zero(value)?))
  {
    return cx.t(t, K::Required, None);
  }

  Ok(cx.yes())
}
