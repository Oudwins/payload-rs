//! `queries/sanitizeQueryValue.ts` on live values: the caller's `val` objects are read, passed
//! through and mutated in place exactly where the TS does (`formattedValue.value = new
//! Types.ObjectId(value)`, `formattedValue[i] = new Types.ObjectId(v)` of `all` on polymorphic
//! `.value` paths), `Types.ObjectId.isValid` / `new Types.ObjectId` are mongoose's own (callee read
//! before the argument), the string / array methods and global built-ins the TS calls are called
//! (`path.includes`, `val.split`, `val.toLowerCase`, `[...].includes`, `parseFloat`,
//! `Number.isNaN`, ...), and `path` is the caller's value (any value the TS accepts on a branch).

use std::cell::Cell;

use payload_core_runtime::js::{self, JsResult, Local, Type};

use crate::host::{
  arg, array, boolean_of, call, call_method, call_with_callback, concat, get, get_k, get_opt, has, host,
  is_array, is_nan, is_string, is_valid_object_id, lit_includes, new_object_id, new_object_id_of, number, object,
  object_id_is_valid, object_named, parse_float, prop_key, push, set, set_k, str_is, string, template, units, val as keep,
};

pub struct SanitizeArgs {
  pub field: Local,
  /// Truthiness only.
  pub has_custom_id: Local,
  pub locale: Local,
  pub operator: Local,
  pub parent_is_localized: Local,
  pub path: Local,
  pub payload: Local,
  pub val: Local,
}

fn field_type(field: Local) -> JsResult<Local> {
  get(field, "type")
}

/// `{ [path]: value }` (the key converted before `value` is evaluated)
fn path_obj(path: Local, value: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  let key = prop_key(path)?;
  let v = value()?;
  object(&[(key, v)])
}

/// `{ operator: formattedOperator, val }`
fn result(operator: Local, val: Local) -> JsResult<Local> {
  object_named(&[("operator", operator), ("val", val)])
}

/// `{ rawQuery }`
fn raw(raw_query: Local) -> JsResult<Local> {
  object_named(&[("rawQuery", raw_query)])
}

/// `buildExistsQuery(formattedValue, path, treatEmptyString)` (the module function, in the host)
fn build_exists_query(formatted_value: Local, path: Local, treat_empty_string: Option<bool>) -> JsResult<Local> {
  let h = host()?;
  match treat_empty_string {
    None => call(&h.build_exists_query, &[formatted_value, path]),
    Some(t) => call(&h.build_exists_query, &[formatted_value, path, js::boolean(t)]),
  }
}

/// `getFieldFromSegments({ field, payload, segments })` (`segments` is the JS array the caller
/// split, shared with the recursive calls and shifted by them, like the TS).
fn get_field_from_segments(field: Local, payload: Local, segments: Local) -> JsResult<Local> {
  if has(field, "blocks")? {
    let found = crate::host::for_of_flow(call(&host()?.for_of_blocks, &[field])?, |block_ref| {
      let block = if is_string(block_ref) { get_k(get(payload, "blocks")?, block_ref)? } else { block_ref };
      if js::truthy(block) {
        let found = get_field_from_segments(block, payload, segments)?;
        if js::truthy(found) {
          return Ok(crate::host::Flow::Return(found));
        }
      }
      Ok(crate::host::Flow::Next)
    })?;
    if let Some(found) = found {
      return Ok(found);
    }
  }

  if has(field, "fields")? {
    // `for (let i = 0; i < segments.length; i++)`: the body always breaks or returns at i = 0
    let index = js::number(0.0);
    if payload_mongo_live::host::gt(get(segments, "length")?, index)? {
      let (segs, i) = (keep(segments)?, keep(index)?);
      let found_field = call_with_callback(get(field, "flattenedFields")?, "find", "field.flattenedFields", 1, &[], move |args| {
        let name = get(arg(args, 0), "name")?;
        Ok(js::boolean(js::strict_equals(name, get_k(segs.get(), i.get())?)))
      })?;

      if js::truthy(found_field) {
        let last = payload_mongo_live::host::sub(get(segments, "length")?, js::number(1.0))?;
        if js::truthy(found_field) && js::strict_equals(last, index) {
          return Ok(found_field);
        }

        call_method(segments, "shift", &[], "segments")?;
        return get_field_from_segments(found_field, payload, segments);
      }
    }
  }
  Ok(js::undefined())
}

/// `typeof v === 'string' && v.split(',').length` compared with `cmp`
fn comma_parts(v: Local) -> JsResult<Local> {
  get(call_method(v, "split", &[js::string(",")], "val")?, "length")
}

/// `sanitizeQueryValue({ field, hasCustomID, locale, operator, parentIsLocalized, path, payload,
/// val })`: the returned object, or `undefined`.
pub fn sanitize_query_value(a: &SanitizeArgs) -> JsResult<Local> {
  let h = host()?;
  let path = a.path;
  let operator = a.operator;
  let val = a.val;
  let payload = a.payload;
  let has_custom_id = js::truthy(a.has_custom_id);
  let mut field = a.field;
  let mut formatted_value = val;
  let mut formatted_operator = operator;
  let op_is = |lit: &str| str_is(operator, lit);

  if lit_includes(&["array", "blocks", "group", "tab"], field_type(field)?)?
    && js::truthy(call_method(path, "includes", &[js::string(".")], "path")?)
  {
    let segments = call_method(path, "split", &[js::string(".")], "path")?;
    call_method(segments, "shift", &[], "segments")?;
    let found_field = get_field_from_segments(field, payload, segments)?;

    if js::truthy(found_field) {
      field = found_field;
    }
  }

  // Disregard invalid _ids
  if str_is(path, "_id") {
    if is_string(val) && js::strict_equals(comma_parts(val)?, js::number(1.0)) {
      if !has_custom_id {
        let is_valid = object_id_is_valid(val)?;

        if !is_valid {
          return result(formatted_operator, js::undefined());
        } else if lit_includes(&["in", "not_in"], operator)? {
          let ids = call(&h.create_array_from_comma_delineated, &[formatted_value])?;
          formatted_value =
            call_with_callback(ids, "map", "createArrayFromCommaDelineated(...)", 1, &[], |args| {
              new_object_id(arg(args, 0))
            })?;
        } else {
          formatted_value = new_object_id(val)?;
        }
      }

      if str_is(field_type(field)?, "number") {
        let parsed_number = parse_float(val)?;

        if is_nan(parsed_number)? {
          return result(formatted_operator, js::undefined());
        }
      }
    } else if is_array(val)? || (is_string(val) && payload_mongo_live::host::gt(comma_parts(val)?, js::number(1.0))?) {
      if is_string(val) {
        formatted_value = call(&h.create_array_from_comma_delineated, &[val])?;
      }

      if is_array(formatted_value)? {
        let initial = js::array();
        let field = keep(field)?;
        formatted_value = call_with_callback(formatted_value, "reduce", "formattedValue", 2, &[initial], move |args| {
          let formatted_values = arg(args, 0);
          let in_val = arg(args, 1);
          if !has_custom_id && object_id_is_valid(in_val)? {
            push(formatted_values, "formattedValues", || new_object_id(in_val))?;
            return Ok(formatted_values);
          }

          if str_is(field_type(field.get())?, "number") {
            let parsed_number = parse_float(in_val)?;
            if !is_nan(parsed_number)? {
              push(formatted_values, "formattedValues", || Ok(parsed_number))?;
            }
          } else {
            push(formatted_values, "formattedValues", || Ok(in_val))?;
          }

          Ok(formatted_values)
        })?;
      }
    }
  }

  // Cast incoming values as proper searchable types
  if str_is(field_type(field)?, "checkbox") && is_string(val) {
    if str_is(call_method(val, "toLowerCase", &[], "val")?, "true") {
      formatted_value = js::boolean(true);
    }
    if str_is(call_method(val, "toLowerCase", &[], "val")?, "false") {
      formatted_value = js::boolean(false);
    }
  }

  if lit_includes(&["all", "in", "not_in"], operator)? && is_string(formatted_value) {
    formatted_value = call(&h.create_array_from_comma_delineated, &[formatted_value])?;

    if str_is(field_type(field)?, "number") && is_array(formatted_value)? {
      formatted_value =
        call_with_callback(formatted_value, "map", "formattedValue", 1, &[], |args| parse_float(arg(args, 0)))?;
    }
  }

  if str_is(field_type(field)?, "number") {
    if is_string(formatted_value) && !op_is("exists") {
      formatted_value = number(val)?;
    }

    if op_is("exists") {
      formatted_value = if str_is(val, "true") {
        js::boolean(true)
      } else if str_is(val, "false") {
        js::boolean(false)
      } else {
        boolean_of(val)?
      };
      return build_exists_query(formatted_value, path, None);
    }
  }

  if str_is(field_type(field)?, "date") && is_string(val) && !op_is("exists") {
    formatted_value = call(&h.new_date, &[val])?;
    if js::truthy(call(&h.is_nan_date_parse, &[formatted_value])?) {
      return Ok(js::undefined());
    }
  }

  if lit_includes(&["relationship", "upload"], field_type(field)?)? {
    if str_is(val, "null") {
      formatted_value = js::null();
    }

    // Object equality requires the value to be the first key in the object that is being queried.
    if op_is("equals")
      && js::truthy(formatted_value)
      && js::type_of(formatted_value).is_typeof_object()
      && js::truthy(get(formatted_value, "value")?)
      && js::truthy(get(formatted_value, "relationTo")?)
    {
      let value = get(formatted_value, "value")?;
      let is_valid = object_id_is_valid(value)?;

      if is_valid {
        set(formatted_value, "value", new_object_id(value)?)?;
      }

      let mut localized_path = path;

      if js::truthy(call(&h.field_should_be_localized, &[field, a.parent_is_localized])?)
        && js::truthy(get(get(payload, "config")?, "localization")?)
        && js::truthy(a.locale)
      {
        localized_path = string(&concat(&[&template(path)?, &units("."), &template(a.locale)?]));
      }

      let fv = formatted_value;
      let first = path_obj(localized_path, || {
        let eq = object_named(&[("value", get(fv, "value")?), ("relationTo", get(fv, "relationTo")?)])?;
        object_named(&[("$eq", eq)])
      })?;
      let second = path_obj(localized_path, || {
        let eq = object_named(&[("relationTo", get(fv, "relationTo")?), ("value", get(fv, "value")?)])?;
        object_named(&[("$eq", eq)])
      })?;
      return raw(object_named(&[("$or", array(&[first, second])?)])?);
    }

    let relation_to = get(field, "relationTo")?;
    let custom_id_type_of = |slug: Local| -> JsResult<Local> { custom_id_type(payload, slug) };
    // owned captures of the callbacks below (they may be kept and called after this call)
    let (relation_to_v, payload_v) = (keep(relation_to)?, keep(payload)?);

    if lit_includes(&["in", "not_in"], operator)? && is_array(formatted_value)? {
      let initial = js::array();
      let (relation_to_v, payload_v) = (relation_to_v.clone(), payload_v.clone());
      formatted_value = call_with_callback(formatted_value, "reduce", "formattedValue", 2, &[initial], move |args| {
        let formatted_values = arg(args, 0);
        let in_val = arg(args, 1);
        let (relation_to, payload) = (relation_to_v.get(), payload_v.get());
        let custom_id_type_of = |slug: Local| -> JsResult<Local> { custom_id_type(payload, slug) };
        if !js::truthy(in_val) {
          return Ok(formatted_values);
        }

        if is_string(relation_to) && js::truthy(custom_id_type_of(relation_to)?) {
          let custom = get(get_k(get(payload, "collections")?, relation_to)?, "customIDType")?;
          if str_is(custom, "number") {
            let parsed_number = parse_float(in_val)?;
            if !is_nan(parsed_number)? {
              push(formatted_values, "formattedValues", || Ok(parsed_number))?;
              return Ok(formatted_values);
            }
          }

          push(formatted_values, "formattedValues", || Ok(in_val))?;
          return Ok(formatted_values);
        }

        if is_array(relation_to)?
          && js::truthy(call_with_callback(relation_to, "some", "relationTo", 1, &[], some_custom_id(payload)?)?)
        {
          if is_valid_object_id(|| call_method(in_val, "toString", &[], "inVal"))? {
            push(formatted_values, "formattedValues", || new_object_id(in_val))?;
          } else {
            push(formatted_values, "formattedValues", || Ok(in_val))?;
          }
          return Ok(formatted_values);
        }

        if is_valid_object_id(|| call_method(in_val, "toString", &[], "inVal"))? {
          push(formatted_values, "formattedValues", || new_object_id(in_val))?;
        }

        Ok(formatted_values)
      })?;
    }

    // Handle hasMany relationships with equals operator and array values
    // For array equality checking
    if lit_includes(&["equals", "not_equals"], operator)?
      && is_array(formatted_value)?
      && has(field, "hasMany")?
      && js::truthy(get(field, "hasMany")?)
    {
      if is_string(relation_to) {
        let custom_id_type = keep(custom_id_type_of(relation_to)?)?;

        // Convert array values to proper types (ObjectId or custom ID type)
        formatted_value = call_with_callback(formatted_value, "map", "formattedValue", 1, &[], move |args| {
          let v = arg(args, 0);
          if str_is(custom_id_type.get(), "number") {
            let parsed = parse_float(v)?;
            return Ok(if is_nan(parsed)? { v } else { parsed });
          }
          if !object_id_is_valid(v)? {
            return Ok(v);
          }
          new_object_id(v)
        })?;
      } else {
        // Polymorphic hasMany - convert array of {relationTo, value} objects
        let payload_v = payload_v.clone();
        formatted_value = call_with_callback(formatted_value, "map", "formattedValue", 1, &[], move |args| {
          let item = arg(args, 0);
          let custom_id_type_of = |slug: Local| -> JsResult<Local> { custom_id_type(payload_v.get(), slug) };
          if js::type_of(item).is_typeof_object() && has(item, "value")? {
            let rel_to = get(item, "relationTo")?;
            let custom_id_type = custom_id_type_of(rel_to)?;
            if str_is(custom_id_type, "number") {
              let parsed = parse_float(get(item, "value")?)?;
              let value = if is_nan(parsed)? { get(item, "value")? } else { parsed };
              return object_named(&[("relationTo", rel_to), ("value", value)]);
            }
            if is_valid_object_id(|| get(item, "value"))? {
              let id = new_object_id_of(|| get(item, "value"))?;
              return object_named(&[("relationTo", rel_to), ("value", id)]);
            }
            return Ok(item);
          }
          // Non-polymorphic format - just IDs
          if object_id_is_valid(item)? {
            return new_object_id(item);
          }
          Ok(item)
        })?;
      }
    } else if lit_includes(&["contains", "equals", "like", "not_equals"], operator)?
      && (!is_array(relation_to)? || !js::truthy(call_method(path, "endsWith", &[js::string(".relationTo")], "path")?))
    {
      if is_string(relation_to) {
        let custom_id_type = custom_id_type_of(relation_to)?;

        if js::truthy(custom_id_type) {
          if str_is(custom_id_type, "number") {
            formatted_value = parse_float(val)?;

            if is_nan(formatted_value)? {
              return result(formatted_operator, js::undefined());
            }
          }
        } else {
          if !object_id_is_valid(formatted_value)? {
            return result(formatted_operator, js::undefined());
          }
          formatted_value = new_object_id(formatted_value)?;
        }
      } else {
        let has_custom_id_type = call_with_callback(relation_to, "some", "relationTo", 1, &[], some_custom_id(payload)?)?;

        if js::truthy(has_custom_id_type) {
          if is_string(val) {
            let formatted_number = number(val)?;
            let first = if object_id_is_valid(val)? { new_object_id(val)? } else { val };
            formatted_value = array(&[first])?;
            formatted_operator = js::string(if op_is("not_equals") { "not_in" } else { "in" });
            if !is_nan(formatted_number)? {
              push(formatted_value, "formattedValue", || Ok(formatted_number))?;
            }
          }
        } else {
          if !object_id_is_valid(formatted_value)? {
            return result(formatted_operator, js::undefined());
          }
          formatted_value = new_object_id(formatted_value)?;
        }
      }
    }

    if op_is("all")
      && is_array(relation_to)?
      && js::truthy(call_method(path, "endsWith", &[js::string(".value")], "path")?)
      && is_array(formatted_value)?
    {
      // `formattedValue[i] = ...` inside the callback: the binding's value at that time (not
      // reassigned while the callback can run)
      let target = keep(formatted_value)?;
      call_with_callback(formatted_value, "forEach", "formattedValue", 2, &[], move |args| {
        let v = arg(args, 0);
        if object_id_is_valid(v)? {
          set_k(target.get(), arg(args, 1), new_object_id(v)?)?;
        }
        Ok(js::undefined())
      })?;
    }
  }

  // Set up specific formatting necessary by operators

  if op_is("near") {
    let parts = Cell::new([js::undefined(); 4]);
    let read_parts = |source: Local| -> JsResult<()> {
      let destructured = call(&h.destructure4, &[source])?;
      let mut p = [js::undefined(); 4];
      for (i, slot) in p.iter_mut().enumerate() {
        *slot = js::get_element(destructured, i as u32)?;
      }
      parts.set(p);
      Ok(())
    };

    if is_array(formatted_value)? {
      read_parts(formatted_value)?;
    }

    if is_string(formatted_value) {
      read_parts(call(&h.create_array_from_comma_delineated, &[formatted_value])?)?;
    }

    let [lng, lat, max_distance, min_distance] = parts.get();
    let nullish = |v: Local| matches!(js::type_of(v), Type::Undefined | Type::Null);

    if nullish(lng) || nullish(lat) || (nullish(max_distance) && nullish(min_distance)) {
      formatted_value = js::undefined();
    } else {
      let coordinates = array(&[parse_float(lng)?, parse_float(lat)?])?;
      let geometry = object_named(&[("type", js::string("Point")), ("coordinates", coordinates)])?;
      formatted_value = object_named(&[("$geometry", geometry)])?;

      if js::truthy(max_distance) && !js::truthy(call(&h.is_nan_number, &[max_distance])?) {
        set(formatted_value, "$maxDistance", parse_float(max_distance)?)?;
      }

      if js::truthy(min_distance) && !js::truthy(call(&h.is_nan_number, &[min_distance])?) {
        set(formatted_value, "$minDistance", parse_float(min_distance)?)?;
      }
    }
  }

  if op_is("within") || op_is("intersects") {
    formatted_value = object_named(&[("$geometry", formatted_value)])?;
  }

  if !str_is(path, "_id") || (str_is(path, "_id") && has_custom_id && str_is(field_type(field)?, "text")) {
    if op_is("contains") && !object_id_is_valid(formatted_value)? {
      let has_many = |field: Local| -> JsResult<bool> { Ok(has(field, "hasMany")? && js::truthy(get(field, "hasMany")?)) };
      if has_many(field)? && str_is(field_type(field)?, "select") {
        // For hasMany select, "contains" means the array includes this exact value
        if is_string(formatted_value) {
          return raw(path_obj(path, || Ok(formatted_value))?);
        } else if is_array(formatted_value)? {
          let path_v = keep(path)?;
          let ors = call_with_callback(formatted_value, "map", "formattedValue", 1, &[], move |args| {
            path_obj(path_v.get(), || Ok(arg(args, 0)))
          })?;
          return raw(object_named(&[("$or", ors)])?);
        }
      } else if has_many(field)? && lit_includes(&["number", "text"], field_type(field)?)? {
        // For hasMany text/number, "contains" means substring matching within array elements
        let elem_match = |path: Local, escaped: Local| -> JsResult<Local> {
          path_obj(path, || {
            let regex = object_named(&[("$options", js::string("i")), ("$regex", escaped)])?;
            object_named(&[("$elemMatch", regex)])
          })
        };
        if is_string(formatted_value) {
          // Search for documents where any array element contains this string
          let escaped = call(&h.escape_reg_exp, &[formatted_value])?;
          return raw(elem_match(path, escaped)?);
        } else if is_array(formatted_value)? {
          // Search for documents where any array element contains any of the search values
          let (hh, path_v) = (h.clone(), keep(path)?);
          let ors = call_with_callback(formatted_value, "map", "formattedValue", 1, &[], move |args| {
            let escaped = call(&hh.escape_reg_exp, &[call(&hh.string_of, &[arg(args, 0)])?])?;
            elem_match(path_v.get(), escaped)
          })?;
          return raw(object_named(&[("$or", ors)])?);
        }
      } else {
        // Regular (non-hasMany) text field
        let regex = call(&h.escape_reg_exp, &[formatted_value])?;
        formatted_value = object_named(&[("$options", js::string("i")), ("$regex", regex)])?;
      }
    }

    if op_is("exists") {
      formatted_value = js::boolean(str_is(formatted_value, "true") || is_true(formatted_value));

      let mut treat_empty_string =
        !lit_includes(&["array", "blocks", "checkbox", "relationship", "upload"], field_type(field)?)?;

      if str_is(field_type(field)?, "text") && js::truthy(get(field, "hasMany")?) {
        treat_empty_string = false;
      } else if str_is(field_type(field)?, "number") && js::truthy(get(field, "hasMany")?) {
        treat_empty_string = false;
      } else if str_is(field_type(field)?, "select") && js::truthy(get(field, "hasMany")?) {
        treat_empty_string = false;
      }

      // _id can't be empty string, will error Cast to ObjectId failed for value ""
      return build_exists_query(formatted_value, path, Some(treat_empty_string));
    }
  }

  if (str_is(path, "_id") || str_is(path, "parent"))
    && op_is("like")
    && js::strict_equals(get(formatted_value, "length")?, js::number(24.0))
    && !has_custom_id
  {
    formatted_operator = js::string("equals");
  }

  if op_is("exists") {
    formatted_value = js::boolean(str_is(formatted_value, "true") || is_true(formatted_value));

    // Clearable fields
    if lit_includes(&["relationship", "select", "upload"], field_type(field)?)? {
      let raw_query = if js::truthy(formatted_value) {
        let a = path_obj(path, || object_named(&[("$exists", js::boolean(true))]))?;
        let b = path_obj(path, || object_named(&[("$ne", js::null())]))?;
        object_named(&[("$and", array(&[a, b])?)])?
      } else {
        let a = path_obj(path, || object_named(&[("$exists", js::boolean(false))]))?;
        let b = path_obj(path, || object_named(&[("$eq", js::null())]))?;
        object_named(&[("$or", array(&[a, b])?)])?
      };
      return raw(raw_query);
    }
  }

  result(formatted_operator, formatted_value)
}

/// `payload.collections[slug]?.customIDType`
fn custom_id_type(payload: Local, slug: Local) -> JsResult<Local> {
  get_opt(get_k(get(payload, "collections")?, slug)?, "customIDType")
}

/// `(relationTo) => !!payload.collections[relationTo]?.customIDType`
fn some_custom_id(payload: Local) -> JsResult<impl Fn(&[Local]) -> JsResult<Local> + 'static> {
  let payload = keep(payload)?;
  Ok(move |args: &[Local]| Ok(js::boolean(js::truthy(custom_id_type(payload.get(), arg(args, 0))?))))
}

fn is_true(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && js::get_bool(v)
}
