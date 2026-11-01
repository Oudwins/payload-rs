//! The synchronous validators of `validations.ts` (text, slug, password, confirmPassword,
//! email, username, textarea, code, checkbox, date, number, array, radio, point) and
//! `validateArrayLength`, in TS order.

use payload_core_runtime::js::{self, JsResult, Local, Persist, Type};

use crate::ops::{
  arg, array, call_method, concat, eq_num, for_of, get, get_index, get_opt, get_opt_computed, gt, is_array,
  is_nullish, is_true, is_type, lt, object, parse_float, string, strict_eq, t, truthy,
  with_callback,
};
use crate::vhost;

/// Calls the host's destructuring helper of a validator: `(value, options) => [bindings...]`.
pub(crate) fn destructure(helper: &Persist, value: Local, options: Local) -> JsResult<Local> {
  js::call(helper.get(), js::undefined(), &[value, options])
}

fn yes() -> Local {
  js::boolean(true)
}

/// `typeof config?.defaultMaxTextLength === 'number'` then `config.defaultMaxTextLength` (two reads).
fn default_max_text_length(config: Local) -> JsResult<Option<Local>> {
  if is_type(get_opt(config, "defaultMaxTextLength")?, Type::Number) {
    return Ok(Some(get(config, "defaultMaxTextLength")?));
  }
  Ok(None)
}

pub fn text(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.text, value, options)?;
  let [has_many, field_max_length, max_rows, min_length, min_rows, config, t_fn, required] =
    [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?, arg(a, 4)?, arg(a, 5)?, arg(a, 6)?, arg(a, 7)?];
  let mut max_length = js::undefined();

  if !truthy(required) && is_nullish(value) {
    return Ok(yes());
  }

  if is_true(has_many) {
    let length_validation_result = validate_array_length(value, max_rows, min_rows, required, t_fn)?;
    if is_type(length_validation_result, Type::String) {
      return Ok(length_validation_result);
    }
  }

  if let Some(default) = default_max_text_length(config)? {
    max_length = default;
  }
  if is_type(field_max_length, Type::Number) {
    max_length = field_max_length;
  }

  let strings_to_validate = if is_array(value)? { value } else { array(&[value])? };

  let returned = for_of(strings_to_validate, &|string_value| {
    let length = get_opt(string_value, "length")?;
    let length = if truthy(length) { length } else { js::number(0.0) };

    if is_type(max_length, Type::Number) && gt(length, max_length)? {
      let label = t(t_fn, "general:value", None)?;
      let vars = object(&[("label", label), ("maxLength", max_length), ("stringValue", string_value)])?;
      return Ok(Some(t(t_fn, "validation:shorterThanMax", Some(vars))?));
    }

    if is_type(min_length, Type::Number) && lt(length, min_length)? {
      let label = t(t_fn, "general:value", None)?;
      let vars = object(&[("label", label), ("minLength", min_length), ("stringValue", string_value)])?;
      return Ok(Some(t(t_fn, "validation:longerThanMin", Some(vars))?));
    }
    Ok(None)
  })?;
  if let Some(returned) = returned {
    return Ok(returned);
  }

  if truthy(required)
    && (!truthy(value)
      || ((is_type(value, Type::String) || is_array(value)?) && eq_num(get(value, "length")?, 0.0)))
  {
    return t(t_fn, "validation:required", None);
  }

  Ok(yes())
}

pub fn slug() -> JsResult<Local> {
  Ok(yes())
}

/// password / textarea: `maxLength` from the config or the field, then the length checks.
fn max_min_length(
  value: Local,
  field_max_length: Local,
  min_length: Local,
  config: Local,
  t_fn: Local,
  required: Local,
) -> JsResult<Local> {
  let mut max_length = js::undefined();

  if let Some(default) = default_max_text_length(config)? {
    max_length = default;
  }
  if is_type(field_max_length, Type::Number) {
    max_length = field_max_length;
  }

  if truthy(value) && truthy(max_length) && gt(get(value, "length")?, max_length)? {
    return t(t_fn, "validation:shorterThanMax", Some(object(&[("maxLength", max_length)])?));
  }

  if truthy(value) && truthy(min_length) && lt(get(value, "length")?, min_length)? {
    return t(t_fn, "validation:longerThanMin", Some(object(&[("minLength", min_length)])?));
  }

  if truthy(required) && !truthy(value) {
    return t(t_fn, "validation:required", None);
  }

  Ok(yes())
}

pub fn password(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.password, value, options)?;
  max_min_length(value, arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?, arg(a, 4)?)
}

pub fn textarea(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.textarea, value, options)?;
  max_min_length(value, arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?, arg(a, 4)?)
}

pub fn confirm_password(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.confirm_password, value, options)?;
  let [t_fn, required, sibling_data] = [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?];

  if truthy(required) && !truthy(value) {
    return t(t_fn, "validation:required", None);
  }

  if truthy(value) && !strict_eq(value, get(sibling_data, "password")?) {
    return t(t_fn, "fields:passwordsDoNotMatch", None);
  }

  Ok(yes())
}

/// The `if (collectionSlug) { ... }` block of email / username: `Some(result)` when it returns.
/// `other_key` is the sibling field that satisfies `required` (`username` / `email`).
fn login_with_username_required(
  value: Local,
  collection_slug: Local,
  collections: Local,
  config: Local,
  t_fn: Local,
  sibling_data: Local,
  other_key: &str,
) -> JsResult<Option<Local>> {
  if !truthy(collection_slug) {
    return Ok(None);
  }
  // collections?.[collectionSlug]?.config ?? config.collections.find(({ slug }) => slug === collectionSlug)!
  let by_slug = get_opt(get_opt_computed(collections, collection_slug)?, "config")?;
  let collection = if is_nullish(by_slug) {
    js::call(vhost()?.find_collection.get(), js::undefined(), &[config, collection_slug])?
  } else {
    by_slug
  };

  if truthy(get(get(collection, "auth")?, "loginWithUsername")?)
    && !truthy(get_opt(get(get(collection, "auth")?, "loginWithUsername")?, "requireUsername")?)
    && !truthy(get_opt(get(get(collection, "auth")?, "loginWithUsername")?, "requireEmail")?)
    && !truthy(value)
    && !truthy(get_opt(sibling_data, other_key)?)
  {
    return Ok(Some(t(t_fn, "validation:required", None)?));
  }
  Ok(None)
}

pub fn email(value: Local, options: Local) -> JsResult<Local> {
  let h = vhost()?;
  let a = destructure(&h.args.email, value, options)?;
  let [collection_slug, collections, config, t_fn, required, sibling_data] =
    [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?, arg(a, 4)?, arg(a, 5)?];

  if let Some(returned) =
    login_with_username_required(value, collection_slug, collections, config, t_fn, sibling_data, "username")?
  {
    return Ok(returned);
  }

  if !truthy(value) && truthy(required) {
    return t(t_fn, "validation:required", None);
  }

  if truthy(value) && !truthy(js::call(h.email_test.get(), js::undefined(), &[value])?) {
    return t(t_fn, "validation:emailAddress", None);
  }

  Ok(yes())
}

pub fn username(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.username, value, options)?;
  let [collection_slug, collections, config, t_fn, required, sibling_data] =
    [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?, arg(a, 4)?, arg(a, 5)?];
  let mut max_length = js::undefined();

  if let Some(returned) =
    login_with_username_required(value, collection_slug, collections, config, t_fn, sibling_data, "email")?
  {
    return Ok(returned);
  }

  if let Some(default) = default_max_text_length(config)? {
    max_length = default;
  }

  if truthy(value) && truthy(max_length) && gt(get(value, "length")?, max_length)? {
    return t(t_fn, "validation:shorterThanMax", Some(object(&[("maxLength", max_length)])?));
  }

  if !truthy(value) && truthy(required) {
    return t(t_fn, "validation:required", None);
  }

  Ok(yes())
}

pub fn code(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.code, value, options)?;
  let [t_fn, required] = [arg(a, 0)?, arg(a, 1)?];
  if truthy(required)
    && (!truthy(value) || (is_type(value, Type::String) && eq_num(get(value, "length")?, 0.0)))
  {
    return t(t_fn, "validation:required", None);
  }

  Ok(yes())
}

pub fn checkbox(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.checkbox, value, options)?;
  let [t_fn, required] = [arg(a, 0)?, arg(a, 1)?];
  let is_boolean = is_type(value, Type::Boolean);
  if (truthy(value) && !is_boolean) || (truthy(required) && !is_boolean) {
    return t(t_fn, "validation:trueOrFalse", None);
  }

  Ok(yes())
}

pub fn date(value: Local, options: Local) -> JsResult<Local> {
  let h = vhost()?;
  let a = destructure(&h.args.date, value, options)?;
  let [name, t_fn, required, sibling_data, timezone] = [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?, arg(a, 4)?];

  // value && !isNaN(Date.parse(value.toString()))
  let valid_date = truthy(value) && {
    let text = call_method(value, "toString", &[], "value")?;
    !js::get_f64(js::call(h.date_parse.get(), js::undefined(), &[text])?).is_nan()
  };

  let has_required_timezone = if truthy(timezone) { required } else { timezone };
  let selected_timezone = get_opt_computed(sibling_data, concat(name, "_tz")?)?;
  let valid_timezone = if truthy(has_required_timezone) { truthy(selected_timezone) } else { true };

  if valid_date && valid_timezone {
    return Ok(yes());
  }

  if valid_date && !valid_timezone {
    return t(t_fn, "validation:timezoneRequired", None);
  }

  if truthy(value) {
    return t(t_fn, "validation:notValidDate", Some(object(&[("value", string(value)?)])?));
  }

  if truthy(required) {
    return t(t_fn, "validation:required", None);
  }

  Ok(yes())
}

/// `validateArrayLength(value, { maxRows, minRows, required, t })`
pub(crate) fn validate_array_length(
  value: Local,
  max_rows: Local,
  min_rows: Local,
  required: Local,
  t_fn: Local,
) -> JsResult<Local> {
  let array_length = if is_array(value)? {
    get(value, "length")?
  } else if truthy(value) {
    value
  } else {
    js::number(0.0)
  };

  if !truthy(required) && eq_num(array_length, 0.0) {
    return Ok(yes());
  }

  if truthy(min_rows) && lt(array_length, min_rows)? {
    let label = t(t_fn, "general:rows", None)?;
    return t(t_fn, "validation:requiresAtLeast", Some(object(&[("count", min_rows), ("label", label)])?));
  }

  if truthy(max_rows) && gt(array_length, max_rows)? {
    let label = t(t_fn, "general:rows", None)?;
    return t(t_fn, "validation:requiresNoMoreThan", Some(object(&[("count", max_rows), ("label", label)])?));
  }

  if truthy(required) && !truthy(array_length) {
    let label = t(t_fn, "general:row", None)?;
    return t(t_fn, "validation:requiresAtLeast", Some(object(&[("count", js::number(1.0)), ("label", label)])?));
  }

  Ok(yes())
}

/// JS `WhiteSpace` and `LineTerminator` code units (what `String.prototype.trim` removes).
fn is_js_whitespace(unit: u16) -> bool {
  matches!(
    unit,
    0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F
      | 0x3000 | 0xFEFF
  )
}

/// `isNumber(value)` (`payload/src/utilities/isNumber.ts`)
fn is_number(value: Local) -> JsResult<bool> {
  if is_nullish(value) {
    return Ok(false);
  }
  if let Some(units) = js::get_string_utf16(value)
    && units.iter().all(|u| is_js_whitespace(*u))
  {
    return Ok(false);
  }
  Ok(!crate::ops::number(value)?.is_nan())
}

pub fn number(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.number, value, options)?;
  let [has_many, max, max_rows, min, min_rows, t_fn, required] =
    [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?, arg(a, 4)?, arg(a, 5)?, arg(a, 6)?];

  if is_true(has_many) {
    let length_validation_result = validate_array_length(value, max_rows, min_rows, required, t_fn)?;
    if is_type(length_validation_result, Type::String) {
      return Ok(length_validation_result);
    }
  }

  if !truthy(value) && !is_number(value)? {
    if truthy(required) {
      return t(t_fn, "validation:required", None);
    }
    return Ok(yes());
  }

  let numbers_to_validate = if is_array(value)? { value } else { array(&[value])? };

  let returned = for_of(numbers_to_validate, &|number| {
    if !is_number(number)? {
      return Ok(Some(t(t_fn, "validation:enterNumber", None)?));
    }

    let number_value = parse_float(number)?;

    if is_type(max, Type::Number) && gt(number_value, max)? {
      let label = t(t_fn, "general:value", None)?;
      let vars = object(&[("label", label), ("max", max), ("value", number_value)])?;
      return Ok(Some(t(t_fn, "validation:greaterThanMax", Some(vars))?));
    }

    if is_type(min, Type::Number) && lt(number_value, min)? {
      let label = t(t_fn, "general:value", None)?;
      let vars = object(&[("label", label), ("min", min), ("value", number_value)])?;
      return Ok(Some(t(t_fn, "validation:lessThanMin", Some(vars))?));
    }
    Ok(None)
  })?;

  Ok(returned.unwrap_or_else(yes))
}

pub fn array_validator(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.array, value, options)?;
  let [max_rows, min_rows, t_fn, required] = [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?];
  validate_array_length(value, max_rows, min_rows, required, t_fn)
}

/// `option === value || (typeof option !== 'string' && option.value === value)` (`option.value`
/// throws for nullish options, like the TS).
pub(crate) fn option_matches(option: Local, value: Local) -> JsResult<bool> {
  Ok(strict_eq(option, value) || (!is_type(option, Type::String) && strict_eq(get(option, "value")?, value)))
}

pub fn radio(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.radio, value, options)?;
  let [field_options, t_fn, required] = [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?];

  if truthy(value) {
    let matches = |args: &[Local]| Ok(js::boolean(option_matches(args[0], value)?));
    let value_matches_option = with_callback(&matches, |cb| call_method(field_options, "some", &[cb], "options"))?;
    return if truthy(value_matches_option) {
      Ok(value_matches_option)
    } else {
      t(t_fn, "validation:invalidSelection", None)
    };
  }

  if truthy(required) { t(t_fn, "validation:required", None) } else { Ok(yes()) }
}

pub fn point(value: Local, options: Local) -> JsResult<Local> {
  let a = destructure(&vhost()?.args.point, value, options)?;
  // The helper applies the `value = ['', '']` parameter default.
  let [value, t_fn, required] = [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?];

  if is_type(value, Type::Null) {
    if truthy(required) {
      return t(t_fn, "validation:required", None);
    }
    return Ok(yes());
  }

  let lng = js::get_f64(parse_float(string(get_index(value, 0)?)?)?);
  let lat = js::get_f64(parse_float(string(get_index(value, 1)?)?)?);
  if truthy(required) && {
    // (value[0] && value[1] && typeof lng !== 'number' && typeof lat !== 'number'): `lng` is a number
    let _ = truthy(get_index(value, 0)?) && truthy(get_index(value, 1)?);
    lng.is_nan() || lat.is_nan() || (is_array(value)? && !eq_num(get(value, "length")?, 2.0))
  } {
    return t(t_fn, "validation:requiresTwoNumbers", None);
  }

  if (truthy(get_index(value, 1)?) && lng.is_nan()) || (truthy(get_index(value, 0)?) && lat.is_nan()) {
    return t(t_fn, "validation:invalidInput", None);
  }

  if truthy(get_index(value, 0)?) && !lng.is_nan() && (lng < -180.0 || lng > 180.0) {
    return t(t_fn, "validation:longitudeOutOfBounds", None);
  }

  if truthy(get_index(value, 1)?) && !lat.is_nan() && (lat < -90.0 || lat > 90.0) {
    return t(t_fn, "validation:latitudeOutOfBounds", None);
  }

  Ok(yes())
}
