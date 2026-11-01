//! The synchronous validators of `validations.ts` (text, password, confirmPassword, email,
//! username, textarea, code, checkbox, date, number, array, radio, point) and
//! `validateArrayLength`, in TS order. Each takes the bindings of its parameter destructuring
//! (done by shell.js with the upstream pattern) and runs the rest of the TS body.

use payload_core_runtime::js::{JsResult, Local, Type};

use crate::keys::K;
use crate::ops::{Cx, Loop, V};

/// `typeof config?.defaultMaxTextLength === 'number'` then `config.defaultMaxTextLength` (two reads).
fn default_max_text_length(cx: &Cx, config: V) -> JsResult<Option<V>> {
  if cx.get_opt(config, K::DefaultMaxTextLength)?.is_number() {
    return Ok(Some(cx.get_v(config, K::DefaultMaxTextLength)?));
  }
  Ok(None)
}

pub fn text(cx: &Cx, args: [V; 9]) -> JsResult<Local> {
  let [value, has_many, field_max_length, min_length, required, config, t, max_rows, min_rows] = args;
  let mut max_length = cx.undefined_v();

  if !required.truthy() && value.is_nullish() {
    return Ok(cx.yes());
  }

  if has_many.is_true() {
    let (max_rows, min_rows) = (cx.classify(max_rows), cx.classify(min_rows));
    let length_validation_result = validate_array_length(cx, value, max_rows, min_rows, required, t)?;
    if length_validation_result.is_string() {
      return Ok(length_validation_result.v);
    }
  }

  if let Some(default) = default_max_text_length(cx, config)? {
    max_length = default;
  }
  if field_max_length.is_number() {
    max_length = field_max_length;
  }

  // A primitive string's `length` is only computed when a comparison needs it.
  let is_length_compared = max_length.is_number() || min_length.is_number();
  let body = |string_value: V| -> JsResult<Option<Local>> {
    if string_value.is_string() && !is_length_compared {
      return Ok(None);
    }
    let length = cx.length_opt(string_value)?;
    let length = if length.truthy() { length } else { cx.number_v(0.0) };

    if max_length.is_number() && cx.gt(length, max_length)? {
      let label = cx.t(t, K::GeneralValue, None)?;
      let vars = cx.object(&[(K::Label, label), (K::MaxLength, max_length.v), (K::StringValue, string_value.v)])?;
      return Ok(Some(cx.t(t, K::ShorterThanMax, Some(vars))?));
    }

    if min_length.is_number() && cx.lt(length, min_length)? {
      let label = cx.t(t, K::GeneralValue, None)?;
      let vars = cx.object(&[(K::Label, label), (K::MinLength, min_length.v), (K::StringValue, string_value.v)])?;
      return Ok(Some(cx.t(t, K::LongerThanMin, Some(vars))?));
    }
    Ok(None)
  };
  let returned = if cx.is_array(value)? {
    cx.for_of(value, Loop::StringsToValidate, &body)?
  } else {
    cx.for_of_literal(value, "stringsToValidate", &body)?
  };
  if let Some(returned) = returned {
    return Ok(returned);
  }

  if required.truthy()
    && (!value.truthy() || ((value.is_string() || cx.is_array(value)?) && cx.length_is_zero(value)?))
  {
    return cx.t(t, K::Required, None);
  }

  Ok(cx.yes())
}

/// password / textarea: `maxLength` from the config or the field, then the length checks.
fn max_min_length(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  let [value, field_max_length, min_length, config, t, required] = args;
  let mut max_length = cx.undefined_v();

  if let Some(default) = default_max_text_length(cx, config)? {
    max_length = default;
  }
  if field_max_length.is_number() {
    max_length = field_max_length;
  }

  if value.truthy() && max_length.truthy() && cx.gt(cx.length(value)?, max_length)? {
    return cx.t(t, K::ShorterThanMax, Some(cx.object(&[(K::MaxLength, max_length.v)])?));
  }

  if value.truthy() && min_length.truthy() && cx.lt(cx.length(value)?, min_length)? {
    return cx.t(t, K::LongerThanMin, Some(cx.object(&[(K::MinLength, min_length.v)])?));
  }

  if required.truthy() && !value.truthy() {
    return cx.t(t, K::Required, None);
  }

  Ok(cx.yes())
}

pub fn password(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  max_min_length(cx, args)
}

pub fn textarea(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  max_min_length(cx, args)
}

pub fn confirm_password(cx: &Cx, args: [V; 4]) -> JsResult<Local> {
  let [value, t, required, sibling_data] = args;

  if required.truthy() && !value.truthy() {
    return cx.t(t, K::Required, None);
  }

  if value.truthy() && !cx.strict_eq(value.v, cx.get(sibling_data, K::Password)?) {
    return cx.t(t, K::PasswordsDoNotMatch, None);
  }

  Ok(cx.yes())
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
  other_key: K,
) -> JsResult<Option<Local>> {
  if !collection_slug.truthy() {
    return Ok(None);
  }
  // collections?.[collectionSlug]?.config ?? config.collections.find(({ slug }) => slug === collectionSlug)!
  let by_slug = cx.get_opt(cx.get_opt_key(collections, collection_slug.v)?, K::Config)?;
  let collection =
    if by_slug.is_nullish() { cx.of(cx.helper(&cx.h_find_collection, &[config.v, collection_slug.v])?) } else { by_slug };

  let login_with_username = || cx.get_v(cx.get_v(collection, K::Auth)?, K::LoginWithUsername);
  if login_with_username()?.truthy()
    && !cx.get_opt(login_with_username()?, K::RequireUsername)?.truthy()
    && !cx.get_opt(login_with_username()?, K::RequireEmail)?.truthy()
    && !value.truthy()
    && !cx.get_opt(sibling_data, other_key)?.truthy()
  {
    return Ok(Some(cx.t(t, K::Required, None)?));
  }
  Ok(None)
}

pub fn email(cx: &Cx, args: [V; 7]) -> JsResult<Local> {
  let [value, collection_slug, collections, config, t, required, sibling_data] = args;

  if let Some(returned) =
    login_with_username_required(cx, value, collection_slug, collections, config, t, sibling_data, K::Username)?
  {
    return Ok(returned);
  }

  if !value.truthy() && required.truthy() {
    return cx.t(t, K::Required, None);
  }

  if value.truthy() && !cx.of(cx.helper(&cx.h_email_test, &[value.v])?).truthy() {
    return cx.t(t, K::EmailAddress, None);
  }

  Ok(cx.yes())
}

pub fn username(cx: &Cx, args: [V; 7]) -> JsResult<Local> {
  let [value, collection_slug, collections, config, t, required, sibling_data] = args;
  let mut max_length = cx.undefined_v();

  if let Some(returned) =
    login_with_username_required(cx, value, collection_slug, collections, config, t, sibling_data, K::Email)?
  {
    return Ok(returned);
  }

  if let Some(default) = default_max_text_length(cx, config)? {
    max_length = default;
  }

  if value.truthy() && max_length.truthy() && cx.gt(cx.length(value)?, max_length)? {
    return cx.t(t, K::ShorterThanMax, Some(cx.object(&[(K::MaxLength, max_length.v)])?));
  }

  if !value.truthy() && required.truthy() {
    return cx.t(t, K::Required, None);
  }

  Ok(cx.yes())
}

pub fn code(cx: &Cx, args: [V; 3]) -> JsResult<Local> {
  let [value, t, required] = args;
  if required.truthy() && (!value.truthy() || (value.is_string() && cx.length_is_zero(value)?)) {
    return cx.t(t, K::Required, None);
  }

  Ok(cx.yes())
}

pub fn checkbox(cx: &Cx, args: [V; 3]) -> JsResult<Local> {
  let [value, t, required] = args;
  if (value.truthy() && !value.is_boolean()) || (required.truthy() && !value.is_boolean()) {
    return cx.t(t, K::TrueOrFalse, None);
  }

  Ok(cx.yes())
}

pub fn date(cx: &Cx, args: [V; 6]) -> JsResult<Local> {
  let [value, name, t, required, sibling_data, timezone] = args;

  // value && !isNaN(Date.parse(value.toString()))
  let valid_date = value.truthy() && {
    let text = cx.call_method(value, K::ToString, &[], "value")?;
    !cx.to_number(cx.of(cx.helper(&cx.h_date_parse, &[text])?))?.is_nan()
  };

  let has_required_timezone = if timezone.truthy() { required } else { timezone };
  // siblingData?.[`${name}_tz`]: the template is only evaluated when siblingData is not nullish.
  let selected_timezone =
    if sibling_data.is_nullish() { cx.undefined_v() } else { cx.of(cx.get_key(sibling_data, cx.concat(name, "_tz")?)?) };
  let valid_timezone = if has_required_timezone.truthy() { selected_timezone.truthy() } else { true };

  if valid_date && valid_timezone {
    return Ok(cx.yes());
  }

  if valid_date && !valid_timezone {
    return cx.t(t, K::TimezoneRequired, None);
  }

  if value.truthy() {
    return cx.t(t, K::NotValidDate, Some(cx.object(&[(K::Value, cx.string(value)?.v)])?));
  }

  if required.truthy() {
    return cx.t(t, K::Required, None);
  }

  Ok(cx.yes())
}

/// `validateArrayLength(value, { maxRows, minRows, required, t })`
pub(crate) fn validate_array_length(cx: &Cx, value: V, max_rows: V, min_rows: V, required: V, t: V) -> JsResult<V> {
  let array_length = if cx.is_array(value)? {
    cx.length(value)?
  } else if value.truthy() {
    value
  } else {
    cx.number_v(0.0)
  };

  if !required.truthy() && cx.eq_num(array_length, 0.0) {
    return Ok(cx.of(cx.yes()));
  }

  if min_rows.truthy() && cx.lt(array_length, min_rows)? {
    let label = cx.t(t, K::GeneralRows, None)?;
    let vars = cx.object(&[(K::Count, min_rows.v), (K::Label, label)])?;
    return Ok(cx.of(cx.t(t, K::RequiresAtLeast, Some(vars))?));
  }

  if max_rows.truthy() && cx.gt(array_length, max_rows)? {
    let label = cx.t(t, K::GeneralRows, None)?;
    let vars = cx.object(&[(K::Count, max_rows.v), (K::Label, label)])?;
    return Ok(cx.of(cx.t(t, K::RequiresNoMoreThan, Some(vars))?));
  }

  if required.truthy() && !array_length.truthy() {
    let label = cx.t(t, K::GeneralRow, None)?;
    let vars = cx.object(&[(K::Count, cx.number(1.0)), (K::Label, label)])?;
    return Ok(cx.of(cx.t(t, K::RequiresAtLeast, Some(vars))?));
  }

  Ok(cx.of(cx.yes()))
}

pub fn number(cx: &Cx, args: [V; 8]) -> JsResult<Local> {
  let [value, has_many, max, min, required, t, max_rows, min_rows] = args;

  if has_many.is_true() {
    let (max_rows, min_rows) = (cx.classify(max_rows), cx.classify(min_rows));
    let length_validation_result = validate_array_length(cx, value, max_rows, min_rows, required, t)?;
    if length_validation_result.is_string() {
      return Ok(length_validation_result.v);
    }
  }

  if !value.truthy() && !cx.is_number(value)? {
    if required.truthy() {
      return cx.t(t, K::Required, None);
    }
    return Ok(cx.yes());
  }

  let body = |number: V| -> JsResult<Option<Local>> {
    if !cx.is_number(number)? {
      return Ok(Some(cx.t(t, K::EnterNumber, None)?));
    }

    let number_value = cx.parse_float(number)?;

    if let Some(max_value) = cx.num(max)
      && number_value > max_value
    {
      let label = cx.t(t, K::GeneralValue, None)?;
      let vars = cx.object(&[(K::Label, label), (K::Max, max.v), (K::Value, cx.number(number_value))])?;
      return Ok(Some(cx.t(t, K::GreaterThanMax, Some(vars))?));
    }

    if let Some(min_value) = cx.num(min)
      && number_value < min_value
    {
      let label = cx.t(t, K::GeneralValue, None)?;
      let vars = cx.object(&[(K::Label, label), (K::Min, min.v), (K::Value, cx.number(number_value))])?;
      return Ok(Some(cx.t(t, K::LessThanMin, Some(vars))?));
    }
    Ok(None)
  };
  let returned = if cx.is_array(value)? {
    cx.for_of(value, Loop::NumbersToValidate, &body)?
  } else {
    cx.for_of_literal(value, "numbersToValidate", &body)?
  };

  Ok(returned.unwrap_or_else(|| cx.yes()))
}

pub fn array(cx: &Cx, args: [V; 5]) -> JsResult<Local> {
  let [value, max_rows, min_rows, t, required] = args;
  Ok(validate_array_length(cx, value, max_rows, min_rows, required, t)?.v)
}

/// `option === value || (typeof option !== 'string' && option.value === value)` (`option.value`
/// throws for nullish options, like the TS).
pub(crate) fn option_matches(cx: &Cx, option: V, value: V) -> JsResult<bool> {
  Ok(cx.strict_eq(option.v, value.v) || (!option.is_string() && cx.strict_eq(cx.get(option, K::Value)?, value.v)))
}

pub fn radio(cx: &Cx, args: [V; 4]) -> JsResult<Local> {
  let [value, options, t, required] = args;

  if value.truthy() {
    let value_matches_option = cx.some(options, "options", &|option| option_matches(cx, option, value))?;
    return if value_matches_option.truthy() {
      Ok(value_matches_option.v)
    } else {
      cx.t(t, K::InvalidSelection, None)
    };
  }

  if required.truthy() { cx.t(t, K::Required, None) } else { Ok(cx.yes()) }
}

pub fn point(cx: &Cx, args: [V; 3]) -> JsResult<Local> {
  // The shell applies the `value = ['', '']` parameter default.
  let [value, t, required] = args;

  if value.ty() == Type::Null {
    if required.truthy() {
      return cx.t(t, K::Required, None);
    }
    return Ok(cx.yes());
  }

  let lng = cx.parse_float_of_string(cx.get_index(value, 0)?)?;
  let lat = cx.parse_float_of_string(cx.get_index(value, 1)?)?;
  if required.truthy() && {
    // (value[0] && value[1] && typeof lng !== 'number' && typeof lat !== 'number'): `lng` is a number
    let _ = cx.get_index(value, 0)?.truthy() && cx.get_index(value, 1)?.truthy();
    lng.is_nan() || lat.is_nan() || (cx.is_array(value)? && !cx.eq_num(cx.length(value)?, 2.0))
  } {
    return cx.t(t, K::RequiresTwoNumbers, None);
  }

  if (cx.get_index(value, 1)?.truthy() && lng.is_nan()) || (cx.get_index(value, 0)?.truthy() && lat.is_nan()) {
    return cx.t(t, K::InvalidInput, None);
  }

  if cx.get_index(value, 0)?.truthy() && !lng.is_nan() && (lng < -180.0 || lng > 180.0) {
    return cx.t(t, K::LongitudeOutOfBounds, None);
  }

  if cx.get_index(value, 1)?.truthy() && !lat.is_nan() && (lat < -90.0 || lat > 90.0) {
    return cx.t(t, K::LatitudeOutOfBounds, None);
  }

  Ok(cx.yes())
}
