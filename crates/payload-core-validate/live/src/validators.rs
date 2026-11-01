//! The synchronous validators of `validations.ts` (text, password, confirmPassword, email,
//! username, textarea, code, checkbox, date, number, array, radio, point) and
//! `validateArrayLength`, in TS order. Each takes the bindings of its parameter destructuring
//! (done by shell.js with the upstream pattern) and runs the rest of the TS body.

use payload_core_runtime::js::{self, JsResult, Local, Type};

use crate::ops::{
  Cx, Js, V, concat, eq_num, is_nullish, is_number_type, is_string, is_true, strict_eq, truthy, ty, yes,
};

/// `typeof config?.defaultMaxTextLength === 'number'` then `config.defaultMaxTextLength` (two reads).
fn default_max_text_length(cx: &Cx, config: V) -> JsResult<Option<Local>> {
  if is_number_type(cx.get_opt(config, "defaultMaxTextLength")?) {
    return Ok(Some(cx.get(config, "defaultMaxTextLength")?));
  }
  Ok(None)
}

pub fn text(cx: &Cx, args: [V; 9]) -> JsResult<Local> {
  let [value, has_many, field_max_length, max_rows, min_length, min_rows, config, t, required] = args;
  let mut max_length = js::undefined();

  if !truthy(required) && is_nullish(value) {
    return Ok(yes());
  }

  if is_true(has_many) {
    let length_validation_result = validate_array_length(cx, value, max_rows, min_rows, required, t)?;
    if is_string(length_validation_result) {
      return Ok(length_validation_result);
    }
  }

  if let Some(default) = default_max_text_length(cx, config)? {
    max_length = default;
  }
  if is_number_type(field_max_length) {
    max_length = field_max_length.v;
  }

  let body = |string_value: Local| -> JsResult<Option<Local>> {
    let length = cx.length_opt(string_value)?;
    let length = if truthy(length) { length } else { js::number(0.0) };

    if is_number_type(max_length) && cx.gt(length, max_length)? {
      let label = cx.t(t, "general:value", None)?;
      let vars = cx.object(&[("label", label), ("maxLength", max_length), ("stringValue", string_value)])?;
      return Ok(Some(cx.t(t, "validation:shorterThanMax", Some(vars))?));
    }

    if is_number_type(min_length) && cx.lt(length, min_length)? {
      let label = cx.t(t, "general:value", None)?;
      let vars = cx.object(&[("label", label), ("minLength", min_length.v), ("stringValue", string_value)])?;
      return Ok(Some(cx.t(t, "validation:longerThanMin", Some(vars))?));
    }
    Ok(None)
  };
  let returned = if cx.is_array(value)? {
    cx.for_of(value, "stringsToValidate", &body)?
  } else {
    cx.for_of_literal(value, "stringsToValidate", &body)?
  };
  if let Some(returned) = returned {
    return Ok(returned);
  }

  if truthy(required)
    && (!truthy(value) || ((is_string(value) || cx.is_array(value)?) && eq_num(cx.length(value)?, 0.0)))
  {
    return cx.t(t, "validation:required", None);
  }

  Ok(yes())
}

/// password / textarea: `maxLength` from the config or the field, then the length checks.
fn max_min_length(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  let [value, field_max_length, min_length, config, t, required] = args;
  let mut max_length = js::undefined();

  if let Some(default) = default_max_text_length(cx, config)? {
    max_length = default;
  }
  if is_number_type(field_max_length) {
    max_length = field_max_length.v;
  }

  if truthy(value) && truthy(max_length) && cx.gt(cx.length(value)?, max_length)? {
    return cx.t(t, "validation:shorterThanMax", Some(cx.object(&[("maxLength", max_length)])?));
  }

  if truthy(value) && truthy(min_length) && cx.lt(cx.length(value)?, min_length)? {
    return cx.t(t, "validation:longerThanMin", Some(cx.object(&[("minLength", min_length.v)])?));
  }

  if truthy(required) && !truthy(value) {
    return cx.t(t, "validation:required", None);
  }

  Ok(yes())
}

pub fn password(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  max_min_length(cx, args)
}

pub fn textarea(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  max_min_length(cx, args)
}

pub fn confirm_password(cx: &Cx, args: [V; 4]) -> JsResult<Local> {
  let [value, t, required, sibling_data] = args;

  if truthy(required) && !truthy(value) {
    return cx.t(t, "validation:required", None);
  }

  if truthy(value) && !strict_eq(value, cx.get(sibling_data, "password")?) {
    return cx.t(t, "fields:passwordsDoNotMatch", None);
  }

  Ok(yes())
}

/// The `if (collectionSlug) { ... }` block of email / username: `Some(result)` when it returns.
/// `other_key` is the sibling field that satisfies `required` (`username` / `email`).
fn login_with_username_required(
  cx: &Cx,
  value: V,
  collection_slug: V,
  collections: V,
  config: V,
  t: V,
  sibling_data: V,
  other_key: &str,
) -> JsResult<Option<Local>> {
  if !truthy(collection_slug) {
    return Ok(None);
  }
  // collections?.[collectionSlug]?.config ?? config.collections.find(({ slug }) => slug === collectionSlug)!
  let by_slug = cx.get_opt(cx.get_opt_key(collections, collection_slug.v)?, "config")?;
  let collection =
    if is_nullish(by_slug) { cx.helper(&cx.h_find_collection, &[config.v, collection_slug.v])? } else { by_slug };

  if truthy(cx.get(cx.get(collection, "auth")?, "loginWithUsername")?)
    && !truthy(cx.get_opt(cx.get(cx.get(collection, "auth")?, "loginWithUsername")?, "requireUsername")?)
    && !truthy(cx.get_opt(cx.get(cx.get(collection, "auth")?, "loginWithUsername")?, "requireEmail")?)
    && !truthy(value)
    && !truthy(cx.get_opt(sibling_data, other_key)?)
  {
    return Ok(Some(cx.t(t, "validation:required", None)?));
  }
  Ok(None)
}

pub fn email(cx: &Cx, args: [V; 7]) -> JsResult<Local> {
  let [value, collection_slug, collections, config, t, required, sibling_data] = args;

  if let Some(returned) =
    login_with_username_required(cx, value, collection_slug, collections, config, t, sibling_data, "username")?
  {
    return Ok(returned);
  }

  if !truthy(value) && truthy(required) {
    return cx.t(t, "validation:required", None);
  }

  if truthy(value) && !truthy(cx.helper(&cx.h_email_test, &[value.v])?) {
    return cx.t(t, "validation:emailAddress", None);
  }

  Ok(yes())
}

pub fn username(cx: &Cx, args: [V; 7]) -> JsResult<Local> {
  let [value, collection_slug, collections, config, t, required, sibling_data] = args;
  let mut max_length = js::undefined();

  if let Some(returned) =
    login_with_username_required(cx, value, collection_slug, collections, config, t, sibling_data, "email")?
  {
    return Ok(returned);
  }

  if let Some(default) = default_max_text_length(cx, config)? {
    max_length = default;
  }

  if truthy(value) && truthy(max_length) && cx.gt(cx.length(value)?, max_length)? {
    return cx.t(t, "validation:shorterThanMax", Some(cx.object(&[("maxLength", max_length)])?));
  }

  if !truthy(value) && truthy(required) {
    return cx.t(t, "validation:required", None);
  }

  Ok(yes())
}

pub fn code(cx: &Cx, args: [V; 3]) -> JsResult<Local> {
  let [value, t, required] = args;
  if truthy(required) && (!truthy(value) || (is_string(value) && eq_num(cx.length(value)?, 0.0))) {
    return cx.t(t, "validation:required", None);
  }

  Ok(yes())
}

pub fn checkbox(cx: &Cx, args: [V; 3]) -> JsResult<Local> {
  let [value, t, required] = args;
  let is_boolean = ty(value) == Type::Boolean;
  if (truthy(value) && !is_boolean) || (truthy(required) && !is_boolean) {
    return cx.t(t, "validation:trueOrFalse", None);
  }

  Ok(yes())
}

pub fn date(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  let [value, name, t, required, sibling_data, timezone] = args;

  // value && !isNaN(Date.parse(value.toString()))
  let valid_date = truthy(value) && {
    let text = cx.call_method(value, "toString", &[], "value")?;
    !js::get_f64(cx.helper(&cx.h_date_parse, &[text])?).is_nan()
  };

  let has_required_timezone = if truthy(timezone) { required } else { timezone };
  // siblingData?.[`${name}_tz`]: the template is only evaluated when siblingData is not nullish.
  let selected_timezone =
    if is_nullish(sibling_data) { js::undefined() } else { cx.get_key(sibling_data, concat(name.v, "_tz")?)? };
  let valid_timezone = if truthy(has_required_timezone) { truthy(selected_timezone) } else { true };

  if valid_date && valid_timezone {
    return Ok(yes());
  }

  if valid_date && !valid_timezone {
    return cx.t(t, "validation:timezoneRequired", None);
  }

  if truthy(value) {
    return cx.t(t, "validation:notValidDate", Some(cx.object(&[("value", cx.string(value)?)])?));
  }

  if truthy(required) {
    return cx.t(t, "validation:required", None);
  }

  Ok(yes())
}

/// `validateArrayLength(value, { maxRows, minRows, required, t })`
pub(crate) fn validate_array_length(
  cx: &Cx,
  value: V,
  max_rows: V,
  min_rows: V,
  required: V,
  t: V,
) -> JsResult<Local> {
  let array_length = if cx.is_array(value)? {
    cx.length(value)?
  } else if truthy(value) {
    value.v
  } else {
    js::number(0.0)
  };

  if !truthy(required) && eq_num(array_length, 0.0) {
    return Ok(yes());
  }

  if truthy(min_rows) && cx.lt(array_length, min_rows)? {
    let label = cx.t(t, "general:rows", None)?;
    return cx.t(t, "validation:requiresAtLeast", Some(cx.object(&[("count", min_rows.v), ("label", label)])?));
  }

  if truthy(max_rows) && cx.gt(array_length, max_rows)? {
    let label = cx.t(t, "general:rows", None)?;
    return cx.t(t, "validation:requiresNoMoreThan", Some(cx.object(&[("count", max_rows.v), ("label", label)])?));
  }

  if truthy(required) && !truthy(array_length) {
    let label = cx.t(t, "general:row", None)?;
    return cx.t(t, "validation:requiresAtLeast", Some(cx.object(&[("count", js::number(1.0)), ("label", label)])?));
  }

  Ok(yes())
}

pub fn number(cx: &Cx, args: [V; 8]) -> JsResult<Local> {
  let [value, has_many, max, max_rows, min, min_rows, t, required] = args;

  if is_true(has_many) {
    let length_validation_result = validate_array_length(cx, value, max_rows, min_rows, required, t)?;
    if is_string(length_validation_result) {
      return Ok(length_validation_result);
    }
  }

  if !truthy(value) && !cx.is_number(value)? {
    if truthy(required) {
      return cx.t(t, "validation:required", None);
    }
    return Ok(yes());
  }

  let body = |number: Local| -> JsResult<Option<Local>> {
    if !cx.is_number(number)? {
      return Ok(Some(cx.t(t, "validation:enterNumber", None)?));
    }

    let number_value = cx.parse_float(number)?;

    if let Some(max_value) = crate::ops::number_value(max)
      && number_value > max_value
    {
      let label = cx.t(t, "general:value", None)?;
      let vars = cx.object(&[("label", label), ("max", max.v), ("value", js::number(number_value))])?;
      return Ok(Some(cx.t(t, "validation:greaterThanMax", Some(vars))?));
    }

    if let Some(min_value) = crate::ops::number_value(min)
      && number_value < min_value
    {
      let label = cx.t(t, "general:value", None)?;
      let vars = cx.object(&[("label", label), ("min", min.v), ("value", js::number(number_value))])?;
      return Ok(Some(cx.t(t, "validation:lessThanMin", Some(vars))?));
    }
    Ok(None)
  };
  let returned = if cx.is_array(value)? {
    cx.for_of(value, "numbersToValidate", &body)?
  } else {
    cx.for_of_literal(value, "numbersToValidate", &body)?
  };

  Ok(returned.unwrap_or_else(yes))
}

pub fn array(cx: &Cx, args: [V; 5]) -> JsResult<Local> {
  let [value, max_rows, min_rows, t, required] = args;
  validate_array_length(cx, value, max_rows, min_rows, required, t)
}

/// `option === value || (typeof option !== 'string' && option.value === value)` (`option.value`
/// throws for nullish options, like the TS).
pub(crate) fn option_matches(cx: &Cx, option: Local, value: impl Js) -> JsResult<bool> {
  Ok(strict_eq(option, value) || (!is_string(option) && strict_eq(cx.get(option, "value")?, value)))
}

pub fn radio(cx: &Cx, args: [V; 4]) -> JsResult<Local> {
  let [value, options, t, required] = args;

  if truthy(value) {
    let value_matches_option = cx.some(options, "options", &|option| option_matches(cx, option, value))?;
    return if truthy(value_matches_option) {
      Ok(value_matches_option)
    } else {
      cx.t(t, "validation:invalidSelection", None)
    };
  }

  if truthy(required) { cx.t(t, "validation:required", None) } else { Ok(yes()) }
}

pub fn point(cx: &Cx, args: [V; 3]) -> JsResult<Local> {
  // The shell applies the `value = ['', '']` parameter default.
  let [value, t, required] = args;

  if ty(value) == Type::Null {
    if truthy(required) {
      return cx.t(t, "validation:required", None);
    }
    return Ok(yes());
  }

  let lng = cx.parse_float_of_string(cx.get_index(value, 0)?)?;
  let lat = cx.parse_float_of_string(cx.get_index(value, 1)?)?;
  if truthy(required) && {
    // (value[0] && value[1] && typeof lng !== 'number' && typeof lat !== 'number'): `lng` is a number
    let _ = truthy(cx.get_index(value, 0)?) && truthy(cx.get_index(value, 1)?);
    lng.is_nan() || lat.is_nan() || (cx.is_array(value)? && !eq_num(cx.length(value)?, 2.0))
  } {
    return cx.t(t, "validation:requiresTwoNumbers", None);
  }

  if (truthy(cx.get_index(value, 1)?) && lng.is_nan()) || (truthy(cx.get_index(value, 0)?) && lat.is_nan()) {
    return cx.t(t, "validation:invalidInput", None);
  }

  if truthy(cx.get_index(value, 0)?) && !lng.is_nan() && (lng < -180.0 || lng > 180.0) {
    return cx.t(t, "validation:longitudeOutOfBounds", None);
  }

  if truthy(cx.get_index(value, 1)?) && !lat.is_nan() && (lat < -90.0 || lat > 90.0) {
    return cx.t(t, "validation:latitudeOutOfBounds", None);
  }

  Ok(yes())
}
