//! `queries/buildSortParam.ts` (with `relationshipSort`) and `queries/getLocalizedSortProperty.ts`
//! on live objects: the caller's `sort` array gets the fallback sort pushed in place
//! (`sort.push(fallbackSort)`) and the caller's `sortAggregation` array gets the `$lookup` stages,
//! exactly where the TS does it. Sort items, paths and segments are the caller's values: the
//! string methods the TS calls on them (`indexOf`, `substring`, `split`, `slice`, `join`) are
//! called, so primitives, boxed strings and objects with such methods behave like upstream.

use payload_core_runtime::js::{self, JsResult, Local, Type};

use payload_mongo_live::entity::get_collection;
use crate::host::{
  arg, call, call_method, call_method_with, call_with_callback, concat, get, get_k, has, host, is_string, val,
  object_named, push, replace_locale, set_k, str_is, string, template, units,
};

pub struct SortArgs {
  pub adapter: Local,
  pub config: Local,
  pub fields: Local,
  pub locale: Local,
  /// `parentIsLocalized = false` (the default already applied)
  pub parent_is_localized: Local,
  pub sort: Local,
  pub sort_aggregation: Local,
  pub timestamps: Local,
  pub versions: Local,
}

/// `buildSortParam(args)` export: destructures like the TS (`parentIsLocalized = false`).
pub fn build_sort_param_entry(args: Local) -> JsResult<Local> {
  let d = call(&host()?.build_sort_param_args, &[args])?;
  let e = |i| js::get_element(d, i);
  build_sort_param(&SortArgs {
    adapter: e(0)?,
    config: e(1)?,
    fields: e(2)?,
    locale: e(3)?,
    parent_is_localized: e(4)?,
    sort: e(5)?,
    sort_aggregation: e(6)?,
    timestamps: e(7)?,
    versions: e(8)?,
  })
}

fn nullish(v: Local) -> bool {
  matches!(js::type_of(v), Type::Undefined | Type::Null)
}

/// `buildSortParam({ adapter, config, fields, locale, parentIsLocalized, sort, sortAggregation,
/// timestamps, versions })`
pub fn build_sort_param(a: &SortArgs) -> JsResult<Local> {
  let h = host()?;
  let mut sort = a.sort;
  let timestamps = js::truthy(a.timestamps);
  if !js::truthy(sort) {
    sort = js::string(if timestamps { "-createdAt" } else { "-id" });
  }

  if is_string(sort) {
    sort = crate::host::array(&[sort])?;
  }

  // We use this flag to determine if the sort is unique or not to decide whether to add a fallback sort.
  let fields = val(a.fields)?;
  let hh = h.clone();
  let is_unique_sort = call_with_callback(sort, "some", "sort", 1, &[], move |args| {
    let field = call(&hh.get_field_by_path, &[fields.get(), arg(args, 0)])?;
    if nullish(field) {
      return Ok(js::undefined());
    }
    let inner = get(field, "field")?;
    if nullish(inner) {
      return Ok(js::undefined());
    }
    get(inner, "unique")
  })?;

  // In the case of Mongo, when sorting by a field that is not unique, the results are not
  // guaranteed to be in the same order each time. So we add a fallback sort.
  let fallback_sort = js::string(if timestamps { "-createdAt" } else { "-id" });

  let include_fallback_sort = !js::truthy(get(a.adapter, "disableFallbackSort")?)
    && !js::truthy(is_unique_sort)
    && !(js::truthy(call_method(sort, "includes", &[fallback_sort], "sort")?)
      || js::truthy(call_method_with(sort, "includes", "sort", || {
        Ok(vec![call_method(fallback_sort, "replace", &[js::string("-"), js::string("")], "fallbackSort")?])
      })?));

  if include_fallback_sort {
    call_method(sort, "push", &[fallback_sort], "sort")?;
  }

  let initial = js::object();
  // the callback owns its captures (`Val`s): it may be kept and called after this call
  let (adapter, config, fields, locale, parent_is_localized, sort_aggregation) = (
    val(a.adapter)?,
    val(a.config)?,
    val(a.fields)?,
    val(a.locale)?,
    val(a.parent_is_localized)?,
    val(a.sort_aggregation)?,
  );
  call_with_callback(sort, "reduce", "sort", 2, &[initial], move |args| {
    let acc = arg(args, 0);
    let item = arg(args, 1);
    let index = call_method(item, "indexOf", &[js::string("-")], "item")?;
    let (sort_property, sort_direction) = if js::strict_equals(index, js::number(0.0)) {
      (call_method(item, "substring", &[js::number(1.0)], "item")?, "desc")
    } else {
      (item, "asc")
    };
    let direction = js::string(sort_direction);

    if str_is(sort_property, "id") {
      set_k(acc, js::string("_id"), direction)?;
      return Ok(acc);
    }

    if js::truthy(sort_aggregation.get()) {
      let sort_rel_property = relationship_sort(
        adapter.get(),
        fields.get(),
        locale.get(),
        sort_property,
        js::string(""),
        sort_aggregation.get(),
      )?;

      if js::truthy(sort_rel_property) {
        set_k(acc, sort_rel_property, direction)?;
        return Ok(acc);
      }
    }

    let localized_property = {
      let (config, fields, locale, parent_is_localized) =
        (config.get(), fields.get(), locale.get(), parent_is_localized.get());
      let segments = call_method(sort_property, "split", &[js::string(".")], "sortProperty")?;
      get_localized_sort_property(&LocalizedSortArgs {
        config,
        fields,
        locale,
        parent_is_localized,
        result: js::undefined(),
        segments,
      })?
    };
    set_k(acc, localized_property, direction)?;

    Ok(acc)
  })
}

/// `currentFields.find((each) => each.name === segment)`
fn find_by_name(fields: Local, expr: &str, name: Local) -> JsResult<Local> {
  let name = val(name)?;
  call_with_callback(fields, "find", expr, 1, &[], move |args| {
    Ok(js::boolean(js::strict_equals(get(arg(args, 0), "name")?, name.get())))
  })
}

/// `${a}${b}...` (template-literal `ToString` of each part)
fn template_of(parts: &[Local]) -> JsResult<Local> {
  let mut units_all = Vec::new();
  for p in parts {
    units_all.push(template(*p)?);
  }
  let refs: Vec<&[u16]> = units_all.iter().map(Vec::as_slice).collect();
  Ok(string(&concat(&refs)))
}

/// `relationshipSort({ adapter, fields, locale, path, previousField = '', sortAggregation, versions })`
fn relationship_sort(
  adapter: Local,
  fields: Local,
  locale: Local,
  path: Local,
  previous_field: Local,
  sort_aggregation: Local,
) -> JsResult<Local> {
  let h = host()?;
  let mut current_fields = fields;
  let segments = call_method(path, "split", &[js::string(".")], "path")?;
  // `segments.length < 2`
  if payload_mongo_live::host::gt(js::number(2.0), get(segments, "length")?)? {
    return Ok(js::null());
  }

  let mut i = 0.0;
  while payload_mongo_live::host::gt(get(segments, "length")?, js::number(i))? {
    let segment = get_k(segments, js::number(i))?;
    let field = find_by_name(current_fields, "currentFields", segment)?;

    if !js::truthy(field) {
      return Ok(js::null());
    }

    if has(field, "fields")? {
      current_fields = get(field, "flattenedFields")?;
    } else if (str_is(get(field, "type")?, "relationship") || str_is(get(field, "type")?, "upload"))
      && !js::strict_equals(js::number(i), payload_mongo_live::host::sub(get(segments, "length")?, js::number(1.0))?)
    {
      let relationship_path = call_method(
        call_method(segments, "slice", &[js::number(0.0), js::number(i + 1.0)], "segments")?,
        "join",
        &[js::string(".")],
        "segments.slice(...)",
      )?;
      let next_path = call_method_with(segments, "slice", "segments", || {
        Ok(vec![js::number(i + 1.0), get(segments, "length")?])
      })?;
      let relationship_field_result = call(&h.get_field_by_path, &[fields, relationship_path])?;

      if !js::truthy(relationship_field_result)
        || !has(get(relationship_field_result, "field")?, "relationTo")?
        || !is_string(get(get(relationship_field_result, "field")?, "relationTo")?)
      {
        return Ok(js::null());
      }

      let collection =
        get_collection(adapter, get(get(relationship_field_result, "field")?, "relationTo")?, false)?;

      let mut localized_relationship_path = get(relationship_field_result, "localizedPath")?;

      if js::truthy(locale) && js::truthy(get(relationship_field_result, "pathHasLocalized")?) {
        localized_relationship_path = replace_locale(get(relationship_field_result, "localizedPath")?, locale)?;
      }

      if str_is(call_method(next_path, "join", &[js::string(".")], "nextPath")?, "id") {
        return template_of(&[previous_field, localized_relationship_path]);
      }

      let as_ = string(&concat(&[&units("__"), &template(previous_field)?, &template(localized_relationship_path)?]));

      // `sortAggregation.push` is read before the argument literal is evaluated, and checked
      // callable after it
      push(sort_aggregation, "sortAggregation", || {
        let lookup_as = string(&concat(&[&units("__"), &template(previous_field)?, &template(localized_relationship_path)?]));
        let from = get(get(collection.model.get(), "collection")?, "name")?;
        let local_field = template_of(&[previous_field, localized_relationship_path])?;
        let lookup = object_named(&[
          ("as", lookup_as),
          ("foreignField", js::string("_id")),
          ("from", from),
          ("localField", local_field),
        ])?;
        object_named(&[("$lookup", lookup)])
      })?;

      if payload_mongo_live::host::gt(get(next_path, "length")?, js::number(1.0))? {
        let next_fields = get(collection.collection_config.get(), "flattenedFields")?;
        let next_path_joined = call_method(next_path, "join", &[js::string(".")], "nextPath")?;
        let previous = string(&concat(&[&template(as_)?, &units(".")]));
        let next_res = relationship_sort(adapter, next_fields, locale, next_path_joined, previous, sort_aggregation)?;

        if js::truthy(next_res) {
          return Ok(next_res);
        }

        let joined = call_method(next_path, "join", &[js::string(".")], "nextPath")?;
        return Ok(string(&concat(&[&template(as_)?, &units("."), &template(joined)?])));
      }

      let next_field = call(
        &h.get_field_by_path,
        &[get(collection.collection_config.get(), "flattenedFields")?, get_k(next_path, js::number(0.0))?],
      )?;

      if js::truthy(next_field) && js::truthy(get(next_field, "pathHasLocalized")?) && js::truthy(locale) {
        let replaced = replace_locale(get(next_field, "localizedPath")?, locale)?;
        return Ok(string(&concat(&[&template(as_)?, &units("."), &template(replaced)?])));
      }

      return Ok(string(&concat(&[&template(as_)?, &units("."), &template(get_k(next_path, js::number(0.0))?)?])));
    }
    i += 1.0;
  }

  Ok(js::null())
}

pub struct LocalizedSortArgs {
  pub config: Local,
  pub fields: Local,
  pub locale: Local,
  pub parent_is_localized: Local,
  pub result: Local,
  /// The caller's `segments` array.
  pub segments: Local,
}

/// `getLocalizedSortProperty(args)` export.
pub fn get_localized_sort_property_entry(args: Local) -> JsResult<Local> {
  let d = call(&host()?.localized_sort_property_args, &[args])?;
  let e = |i| js::get_element(d, i);
  get_localized_sort_property(&LocalizedSortArgs {
    config: e(0)?,
    fields: e(1)?,
    locale: e(2)?,
    parent_is_localized: e(3)?,
    result: e(4)?,
    segments: e(5)?,
  })
}

/// `getLocalizedSortProperty({ config, fields, locale, parentIsLocalized, result, segments })`
pub fn get_localized_sort_property(a: &LocalizedSortArgs) -> JsResult<Local> {
  let h = host()?;
  let incoming_segments = a.segments;
  // If localization is not enabled, accept exactly what is sent in
  if !js::truthy(get(a.config, "localization")?) {
    return call_method(incoming_segments, "join", &[js::string(".")], "incomingSegments");
  }

  let segments = call(&h.spread, &[incoming_segments])?;

  // Retrieve first segment, and remove from segments
  let first_segment = call_method(segments, "shift", &[], "segments")?;

  // Attempt to find a matched field
  let (hh, first) = (h.clone(), val(first_segment)?);
  let matched_field = call_with_callback(a.fields, "find", "fields", 1, &[], move |args| {
    let field = arg(args, 0);
    Ok(js::boolean(
      js::truthy(call(&hh.field_affects_data, &[field])?) && js::strict_equals(get(field, "name")?, first.get()),
    ))
  })?;

  if js::truthy(matched_field) && !js::truthy(call(&h.field_is_presentational_only, &[matched_field])?) {
    let mut next_fields = js::null();
    let mut next_parent_is_localized = a.parent_is_localized;
    let remaining_segments = call(&h.spread, &[segments])?;
    let mut localized_segment = get(matched_field, "name")?;

    let parent_is_localized = if nullish(a.parent_is_localized) { js::boolean(false) } else { a.parent_is_localized };
    if js::truthy(call(&h.field_should_be_localized, &[matched_field, parent_is_localized])?) {
      // Check to see if next segment is a locale
      if payload_mongo_live::host::gt(get(segments, "length")?, js::number(0.0))?
        && js::truthy(get_k(remaining_segments, js::number(0.0))?)
      {
        let locale_codes = get(get(a.config, "localization")?, "localeCodes")?;
        let next_segment_is_locale = call_method_with(locale_codes, "includes", "config.localization.localeCodes", || {
          Ok(vec![get_k(remaining_segments, js::number(0.0))?])
        })?;

        // If next segment is locale, remove it from remaining segments
        // and use it to localize the current segment
        if js::truthy(next_segment_is_locale) {
          let next_segment = call_method(remaining_segments, "shift", &[], "remainingSegments")?;
          let name = template(get(matched_field, "name")?)?;
          localized_segment = string(&concat(&[&name, &units("."), &template(next_segment)?]));
        }
      } else {
        // If no more segments, but field is localized, use default locale
        let name = template(get(matched_field, "name")?)?;
        localized_segment = string(&concat(&[&name, &units("."), &template(a.locale)?]));
      }
    }

    // If there are subfields, pass them through
    if str_is(get(matched_field, "type")?, "tab")
      || str_is(get(matched_field, "type")?, "group")
      || str_is(get(matched_field, "type")?, "array")
    {
      next_fields = get(matched_field, "flattenedFields")?;
      if !js::truthy(next_parent_is_localized) {
        let localized = get(matched_field, "localized")?;
        next_parent_is_localized = if nullish(localized) { js::boolean(false) } else { localized };
      }
    }

    if str_is(get(matched_field, "type")?, "blocks") {
      let blocks = get(matched_field, "blocks")?;
      let initial = js::array();
      let (hh, config) = (h.clone(), val(a.config)?);
      next_fields = call_with_callback(blocks, "reduce", "matchedField.blocks", 2, &[initial], move |args| {
        let flattened_block_fields = arg(args, 0);
        let block_ref = arg(args, 1);
        let block = if is_string(block_ref) {
          let blocks = get(config.get(), "blocks")?;
          if nullish(blocks) {
            js::undefined()
          } else {
            let slug = val(block_ref)?;
            call_with_callback(blocks, "find", "config.blocks", 1, &[], move |args| {
              Ok(js::boolean(js::strict_equals(get(arg(args, 0), "slug")?, slug.get())))
            })?
          }
        } else {
          block_ref
        };

        if !js::truthy(block) {
          return call(&hh.spread, &[flattened_block_fields]);
        }

        // [...flattenedBlockFields, ...block.flattenedFields.filter((blockField) => ...)]
        let hf = hh.clone();
        let filter = crate::host::arrow(1, move |args| {
          let block_field = arg(args, 0);
          let keep = (js::truthy(call(&hf.field_affects_data, &[block_field])?)
            && !str_is(get(block_field, "name")?, "blockType")
            && !str_is(get(block_field, "name")?, "blockName"))
            || !js::truthy(call(&hf.field_affects_data, &[block_field])?);
          Ok(js::boolean(keep))
        })?;
        call(&hh.spread_filtered, &[flattened_block_fields, block, filter])
      })?;
    }

    let result = if js::truthy(a.result) {
      string(&concat(&[&template(a.result)?, &units("."), &template(localized_segment)?]))
    } else {
      localized_segment
    };

    if js::type_of(next_fields) != Type::Null {
      return get_localized_sort_property(&LocalizedSortArgs {
        config: a.config,
        fields: next_fields,
        locale: a.locale,
        parent_is_localized: next_parent_is_localized,
        result,
        segments: remaining_segments,
      });
    }

    return Ok(result);
  }

  call_method(incoming_segments, "join", &[js::string(".")], "incomingSegments")
}
