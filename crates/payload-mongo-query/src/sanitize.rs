//! `sanitizeQueryValue` (queries/sanitizeQueryValue.ts).

use std::collections::VecDeque;

use payload_engine::error::Result;
use payload_engine::fields::field_should_be_localized;
use payload_engine::js::JsVal;

use crate::QueryCx;
use crate::js::{
  JsObj, create_array_from_comma_delineated, date_parse, escape_reg_exp, get, is_object, js_in, js_number, js_string,
  new_date_from_string, new_object_id, obj1, object_id_is_valid, parse_float, template, to_string_method, type_error,
};
use crate::paths::find_field;

/// What `sanitizeQueryValue` returns (when not `undefined`): `{ operator, val }` or
/// `{ rawQuery }`.
#[derive(Clone, Debug)]
pub struct Sanitized {
  pub operator: Option<String>,
  pub raw_query: Option<JsVal>,
  pub val: JsVal,
}

impl Sanitized {
  fn value(operator: &str, val: JsVal) -> Option<Sanitized> {
    Some(Sanitized { operator: Some(operator.to_owned()), raw_query: None, val })
  }

  fn raw(raw_query: JsVal) -> Option<Sanitized> {
    Some(Sanitized { operator: None, raw_query: Some(raw_query), val: JsVal::Undefined })
  }
}

pub struct SanitizeArgs<'a> {
  pub field: &'a JsVal,
  pub has_custom_id: bool,
  pub locale: &'a JsVal,
  pub operator: &'a str,
  pub parent_is_localized: bool,
  pub path: &'a str,
  pub val: &'a JsVal,
}

fn build_exists_query(formatted_value: &JsVal, path: &str, treat_empty_string: bool) -> JsVal {
  let cond = |op: &str, v: JsVal| obj1(path, obj1(op, v));
  if formatted_value.truthy() {
    let mut items = vec![cond("$exists", JsVal::Bool(true)), cond("$ne", JsVal::Null)];
    if treat_empty_string {
      items.push(cond("$ne", JsVal::str("")));
    }
    obj1("$and", JsVal::arr(items))
  } else {
    let mut items = vec![cond("$exists", JsVal::Bool(false)), cond("$eq", JsVal::Null)];
    if treat_empty_string {
      items.push(cond("$eq", JsVal::str("")));
    }
    obj1("$or", JsVal::arr(items))
  }
}

/// `getFieldFromSegments`: `segments` is shared (and shifted) across the recursion, like the TS.
fn get_field_from_segments(cx: &QueryCx, field: &JsVal, segments: &mut VecDeque<String>) -> Result<JsVal> {
  if js_in("blocks", field)? {
    for block in get(field, "blocks")?.items() {
      let block = match block {
        JsVal::Str(slug) => cx.env.blocks.get(slug).clone(),
        other => other.clone(),
      };
      if block.truthy() {
        let found = get_field_from_segments(cx, &block, segments)?;
        if found.truthy() {
          return Ok(found);
        }
      }
    }
  }

  if js_in("fields", field)? && !segments.is_empty() {
    let found = find_field(&get(field, "flattenedFields")?, &segments[0])?;
    if !found.truthy() {
      return Ok(JsVal::Undefined);
    }
    if segments.len() == 1 {
      return Ok(found);
    }
    segments.pop_front();
    return get_field_from_segments(cx, &found, segments);
  }

  Ok(JsVal::Undefined)
}

fn type_is(field: &JsVal, types: &[&str]) -> Result<bool> {
  Ok(get(field, "type")?.as_str().is_some_and(|t| types.contains(&t)))
}

fn has_many(field: &JsVal) -> Result<bool> {
  Ok(js_in("hasMany", field)? && get(field, "hasMany")?.truthy())
}

/// `sanitizeQueryValue`: `None` where the TS returns `undefined`.
pub fn sanitize_query_value(cx: &QueryCx, args: &SanitizeArgs) -> Result<Option<Sanitized>> {
  let path = args.path;
  let operator = args.operator;
  let val = args.val;
  let has_custom_id = args.has_custom_id;
  let mut formatted_value = val.clone();
  let mut formatted_operator = operator.to_owned();
  let mut field = args.field.clone();

  if type_is(&field, &["array", "blocks", "group", "tab"])? && path.contains('.') {
    let mut segments: VecDeque<String> = path.split('.').skip(1).map(str::to_owned).collect();
    let found = get_field_from_segments(cx, &field, &mut segments)?;
    if found.truthy() {
      field = found;
    }
  }

  // Disregard invalid _ids
  if path == "_id" {
    let comma_count = val.as_str().map(|s| s.split(',').count());
    if comma_count == Some(1) {
      if !has_custom_id {
        if !object_id_is_valid(val)? {
          return Ok(Sanitized::value(&formatted_operator, JsVal::Undefined));
        } else if matches!(operator, "in" | "not_in") {
          let items = create_array_from_comma_delineated(&formatted_value)?;
          formatted_value = JsVal::arr(items.items().map(new_object_id).collect::<Result<_>>()?);
        } else {
          formatted_value = new_object_id(val)?;
        }
      }

      if type_is(&field, &["number"])? && parse_float(val)?.is_nan() {
        return Ok(Sanitized::value(&formatted_operator, JsVal::Undefined));
      }
    } else if matches!(val, JsVal::Arr(_)) || comma_count.is_some_and(|n| n > 1) {
      if val.as_str().is_some() {
        formatted_value = create_array_from_comma_delineated(val)?;
      }

      if let JsVal::Arr(items) = &formatted_value {
        let is_number = type_is(&field, &["number"])?;
        let mut out = Vec::new();
        for in_val in items.iter() {
          if !has_custom_id && object_id_is_valid(in_val)? {
            out.push(new_object_id(in_val)?);
            continue;
          }
          if is_number {
            let parsed = parse_float(in_val)?;
            if !parsed.is_nan() {
              out.push(JsVal::Num(parsed));
            }
          } else {
            out.push(in_val.clone());
          }
        }
        formatted_value = JsVal::arr(out);
      }
    }
  }

  // Cast incoming values as proper searchable types
  if type_is(&field, &["checkbox"])?
    && let Some(s) = val.as_str()
  {
    let lower = s.to_lowercase();
    if lower == "true" {
      formatted_value = JsVal::Bool(true);
    }
    if lower == "false" {
      formatted_value = JsVal::Bool(false);
    }
  }

  if matches!(operator, "all" | "in" | "not_in") && formatted_value.as_str().is_some() {
    formatted_value = create_array_from_comma_delineated(&formatted_value)?;
    if type_is(&field, &["number"])?
      && let JsVal::Arr(items) = &formatted_value
    {
      formatted_value = JsVal::arr(items.iter().map(|v| parse_float(v).map(JsVal::Num)).collect::<Result<_>>()?);
    }
  }

  if type_is(&field, &["number"])? {
    if formatted_value.as_str().is_some() && operator != "exists" {
      formatted_value = JsVal::Num(js_number(val)?);
    }

    if operator == "exists" {
      formatted_value = match val.as_str() {
        Some("true") => JsVal::Bool(true),
        Some("false") => JsVal::Bool(false),
        _ => JsVal::Bool(val.truthy()),
      };
      return Ok(Sanitized::raw(build_exists_query(&formatted_value, path, true)));
    }
  }

  if type_is(&field, &["date"])?
    && let Some(s) = val.as_str()
    && operator != "exists"
  {
    formatted_value = new_date_from_string(s);
    if date_parse(&formatted_value)?.is_nan() {
      return Ok(None);
    }
  }

  if type_is(&field, &["relationship", "upload"])? {
    if val.as_str() == Some("null") {
      formatted_value = JsVal::Null;
    }

    // Object equality requires the value to be the first key in the object that is being queried.
    if operator == "equals"
      && formatted_value.truthy()
      && is_object(&formatted_value)
      && get(&formatted_value, "value")?.truthy()
      && get(&formatted_value, "relationTo")?.truthy()
    {
      let mut value = get(&formatted_value, "value")?;
      if object_id_is_valid(&value)? {
        value = new_object_id(&value)?;
        cx.mutated(&formatted_value, "value", value.clone());
      }

      let mut localized_path = path.to_owned();
      if field_should_be_localized(&field, args.parent_is_localized)
        && cx.localization().truthy()
        && args.locale.truthy()
      {
        localized_path = format!("{path}.{}", template(args.locale));
      }

      let relation_to = get(&formatted_value, "relationTo")?;
      let value_first = JsObj::new().with("value", value.clone()).with("relationTo", relation_to.clone()).into_val();
      let relation_to_first = JsObj::new().with("relationTo", relation_to).with("value", value).into_val();
      return Ok(Sanitized::raw(obj1(
        "$or",
        JsVal::arr(vec![
          obj1(localized_path.as_str(), obj1("$eq", value_first)),
          obj1(localized_path.as_str(), obj1("$eq", relation_to_first)),
        ]),
      )));
    }

    let relation_to = get(&field, "relationTo")?;
    let custom_id_type_of = |slug: &JsVal| cx.custom_id_type(&template(slug)).clone();

    if matches!(operator, "in" | "not_in")
      && let JsVal::Arr(items) = &formatted_value
    {
      let mut out = Vec::new();
      for in_val in items.iter() {
        if !in_val.truthy() {
          continue;
        }

        if relation_to.as_str().is_some() && custom_id_type_of(&relation_to).truthy() {
          if custom_id_type_of(&relation_to).as_str() == Some("number") {
            let parsed = parse_float(in_val)?;
            if !parsed.is_nan() {
              out.push(JsVal::Num(parsed));
              continue;
            }
          }
          out.push(in_val.clone());
          continue;
        }

        if matches!(relation_to, JsVal::Arr(_)) && relation_to.items().any(|r| custom_id_type_of(r).truthy()) {
          if object_id_is_valid(&JsVal::str(to_string_method(in_val, "inVal")?))? {
            out.push(new_object_id(in_val)?);
          } else {
            out.push(in_val.clone());
          }
          continue;
        }

        if object_id_is_valid(&JsVal::str(to_string_method(in_val, "inVal")?))? {
          out.push(new_object_id(in_val)?);
        }
      }
      formatted_value = JsVal::arr(out);
    }

    // Handle hasMany relationships with equals operator and array values
    if matches!(operator, "equals" | "not_equals") && matches!(formatted_value, JsVal::Arr(_)) && has_many(&field)? {
      let items: Vec<JsVal> = formatted_value.items().cloned().collect();
      let mut out = Vec::with_capacity(items.len());
      if relation_to.as_str().is_some() {
        let custom_id_type = custom_id_type_of(&relation_to);
        for v in items {
          if custom_id_type.as_str() == Some("number") {
            let parsed = parse_float(&v)?;
            out.push(if parsed.is_nan() { v } else { JsVal::Num(parsed) });
          } else if !object_id_is_valid(&v)? {
            out.push(v);
          } else {
            out.push(new_object_id(&v)?);
          }
        }
      } else {
        // Polymorphic hasMany - convert array of {relationTo, value} objects
        for item in items {
          if matches!(item.type_of(), "object") && js_in("value", &item)? {
            let rel_to = get(&item, "relationTo")?;
            let item_value = get(&item, "value")?;
            if custom_id_type_of(&rel_to).as_str() == Some("number") {
              let parsed = parse_float(&item_value)?;
              let value = if parsed.is_nan() { item_value } else { JsVal::Num(parsed) };
              out.push(JsObj::new().with("relationTo", rel_to).with("value", value).into_val());
              continue;
            }
            if object_id_is_valid(&item_value)? {
              out.push(JsObj::new().with("relationTo", rel_to).with("value", new_object_id(&item_value)?).into_val());
              continue;
            }
            out.push(item);
            continue;
          }
          // Non-polymorphic format - just IDs
          if object_id_is_valid(&item)? {
            out.push(new_object_id(&item)?);
          } else {
            out.push(item);
          }
        }
      }
      formatted_value = JsVal::arr(out);
    } else if matches!(operator, "contains" | "equals" | "like" | "not_equals")
      && (!matches!(relation_to, JsVal::Arr(_)) || !path.ends_with(".relationTo"))
    {
      if relation_to.as_str().is_some() {
        let custom_id_type = custom_id_type_of(&relation_to);
        if custom_id_type.truthy() {
          if custom_id_type.as_str() == Some("number") {
            let parsed = parse_float(val)?;
            formatted_value = JsVal::Num(parsed);
            if parsed.is_nan() {
              return Ok(Sanitized::value(&formatted_operator, JsVal::Undefined));
            }
          }
        } else {
          if !object_id_is_valid(&formatted_value)? {
            return Ok(Sanitized::value(&formatted_operator, JsVal::Undefined));
          }
          formatted_value = new_object_id(&formatted_value)?;
        }
      } else {
        let relation_tos = match &relation_to {
          JsVal::Arr(a) => a.to_vec(),
          JsVal::Undefined | JsVal::Null => {
            return Err(type_error(format!(
              "Cannot read properties of {} (reading 'some')",
              relation_to.to_js_string()
            )));
          }
          _ => return Err(type_error("relationTo.some is not a function")),
        };
        let has_custom_id_type = relation_tos.iter().any(|r| custom_id_type_of(r).truthy());

        if has_custom_id_type {
          if let Some(s) = val.as_str() {
            let formatted_number = js_number(val)?;
            let first = if object_id_is_valid(val)? { new_object_id(val)? } else { JsVal::str(s) };
            let mut items = vec![first];
            formatted_operator = if operator == "not_equals" { "not_in" } else { "in" }.to_owned();
            if !formatted_number.is_nan() {
              items.push(JsVal::Num(formatted_number));
            }
            formatted_value = JsVal::arr(items);
          }
        } else {
          if !object_id_is_valid(&formatted_value)? {
            return Ok(Sanitized::value(&formatted_operator, JsVal::Undefined));
          }
          formatted_value = new_object_id(&formatted_value)?;
        }
      }
    }

    if operator == "all"
      && matches!(relation_to, JsVal::Arr(_))
      && path.ends_with(".value")
      && let JsVal::Arr(items) = &formatted_value
    {
      let is_argument = formatted_value.strict_eq(val);
      let mut out = Vec::with_capacity(items.len());
      for (i, v) in items.iter().enumerate() {
        if object_id_is_valid(v)? {
          let id = new_object_id(v)?;
          if is_argument {
            cx.mutated(val, i.to_string(), id.clone());
          }
          out.push(id);
        } else {
          out.push(v.clone());
        }
      }
      formatted_value = JsVal::arr(out);
    }
  }

  // Set up specific formatting necessary by operators

  if operator == "near" {
    let mut parts = [JsVal::Undefined, JsVal::Undefined, JsVal::Undefined, JsVal::Undefined];
    if let JsVal::Arr(items) = &formatted_value {
      for (slot, item) in parts.iter_mut().zip(items.iter()) {
        *slot = item.clone();
      }
    }
    if formatted_value.as_str().is_some() {
      let items = create_array_from_comma_delineated(&formatted_value)?;
      for (slot, item) in parts.iter_mut().zip(items.items()) {
        *slot = item.clone();
      }
    }
    let [lng, lat, max_distance, min_distance] = parts;

    if lng.is_nullish() || lat.is_nullish() || (max_distance.is_nullish() && min_distance.is_nullish()) {
      formatted_value = JsVal::Undefined;
    } else {
      let geometry = JsObj::new()
        .with("type", JsVal::str("Point"))
        .with("coordinates", JsVal::arr(vec![JsVal::Num(parse_float(&lng)?), JsVal::Num(parse_float(&lat)?)]));
      let mut near = JsObj::new().with("$geometry", geometry.into_val());
      if max_distance.truthy() && !js_number(&max_distance)?.is_nan() {
        near.set("$maxDistance", JsVal::Num(parse_float(&max_distance)?));
      }
      if min_distance.truthy() && !js_number(&min_distance)?.is_nan() {
        near.set("$minDistance", JsVal::Num(parse_float(&min_distance)?));
      }
      formatted_value = near.into_val();
    }
  }

  if operator == "within" || operator == "intersects" {
    formatted_value = obj1("$geometry", formatted_value);
  }

  if path != "_id" || (has_custom_id && type_is(&field, &["text"])?) {
    if operator == "contains" && !object_id_is_valid(&formatted_value)? {
      if has_many(&field)? && type_is(&field, &["select"])? {
        // For hasMany select, "contains" means the array includes this exact value
        if formatted_value.as_str().is_some() {
          return Ok(Sanitized::raw(obj1(path, formatted_value)));
        } else if let JsVal::Arr(items) = &formatted_value {
          let ors = items.iter().map(|v| obj1(path, v.clone())).collect();
          return Ok(Sanitized::raw(obj1("$or", JsVal::arr(ors))));
        }
      } else if has_many(&field)? && type_is(&field, &["number", "text"])? {
        // For hasMany text/number, "contains" means substring matching within array elements
        let elem_match = |pattern: String| {
          obj1(
            path,
            obj1("$elemMatch", JsObj::new().with("$options", JsVal::str("i")).with("$regex", JsVal::str(pattern)).into_val()),
          )
        };
        if formatted_value.as_str().is_some() {
          return Ok(Sanitized::raw(elem_match(escape_reg_exp(&formatted_value)?)));
        } else if let JsVal::Arr(items) = &formatted_value {
          let ors = items
            .iter()
            .map(|v| Ok(elem_match(escape_reg_exp(&JsVal::str(js_string(v)?))?)))
            .collect::<Result<Vec<_>>>()?;
          return Ok(Sanitized::raw(obj1("$or", JsVal::arr(ors))));
        }
      } else {
        // Regular (non-hasMany) text field
        let pattern = escape_reg_exp(&formatted_value)?;
        formatted_value = JsObj::new().with("$options", JsVal::str("i")).with("$regex", JsVal::str(pattern)).into_val();
      }
    }

    if operator == "exists" {
      formatted_value = JsVal::Bool(formatted_value.as_str() == Some("true") || formatted_value.is_true());

      let mut treat_empty_string = !type_is(&field, &["array", "blocks", "checkbox", "relationship", "upload"])?;
      let field_has_many = get(&field, "hasMany")?.truthy();
      if type_is(&field, &["text"])? && field_has_many {
        treat_empty_string = false;
      } else if type_is(&field, &["number"])? && field_has_many {
        treat_empty_string = false;
      } else if type_is(&field, &["select"])? && field_has_many {
        treat_empty_string = false;
      }

      // _id can't be empty string, will error Cast to ObjectId failed for value ""
      return Ok(Sanitized::raw(build_exists_query(&formatted_value, path, treat_empty_string)));
    }
  }

  if (path == "_id" || path == "parent")
    && operator == "like"
    && get(&formatted_value, "length")?.as_num() == Some(24.0)
    && !has_custom_id
  {
    formatted_operator = "equals".to_owned();
  }

  if operator == "exists" {
    formatted_value = JsVal::Bool(formatted_value.as_str() == Some("true") || formatted_value.is_true());

    // Clearable fields
    if type_is(&field, &["relationship", "select", "upload"])? {
      let cond = |op: &str, v: JsVal| obj1(path, obj1(op, v));
      let raw = if formatted_value.truthy() {
        obj1("$and", JsVal::arr(vec![cond("$exists", JsVal::Bool(true)), cond("$ne", JsVal::Null)]))
      } else {
        obj1("$or", JsVal::arr(vec![cond("$exists", JsVal::Bool(false)), cond("$eq", JsVal::Null)]))
      };
      return Ok(Sanitized::raw(raw));
    }
  }

  Ok(Sanitized::value(&formatted_operator, formatted_value))
}
