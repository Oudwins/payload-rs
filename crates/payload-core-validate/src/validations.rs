//! The validators, in the order of `validations.ts`.

use indexmap::IndexMap;
use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};

use crate::ValidationResult::{self, Invalid, Valid};
use crate::date::date_parse;
use crate::host::{FilterOptionsCall, FindArgs, HostTz, Req};
use crate::js::{
  OBJECT_PROTOTYPE_KEYS, call_to_string_with, get, get_opt, gt, join, json_stringify_interpolated, lt, object_id_is_valid,
  parse_float, parse_float_str, same_value_zero, strict_eq, to_number, to_string_with, trim, type_error, type_of,
};

/// The built-in validators (`validations` plus `username`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Validator {
  Array,
  Blocks,
  Checkbox,
  Code,
  ConfirmPassword,
  Date,
  Email,
  Json,
  Number,
  Password,
  Point,
  Radio,
  Relationship,
  RichText,
  Select,
  Slug,
  Text,
  Textarea,
  Upload,
  Username,
}

impl Validator {
  /// Looks up a validator by its export name (`validations[name]`, plus `username`).
  pub fn from_name(name: &str) -> Option<Self> {
    Some(match name {
      "array" => Self::Array,
      "blocks" => Self::Blocks,
      "checkbox" => Self::Checkbox,
      "code" => Self::Code,
      "confirmPassword" => Self::ConfirmPassword,
      "date" => Self::Date,
      "email" => Self::Email,
      "json" => Self::Json,
      "number" => Self::Number,
      "password" => Self::Password,
      "point" => Self::Point,
      "radio" => Self::Radio,
      "relationship" => Self::Relationship,
      "richText" => Self::RichText,
      "select" => Self::Select,
      "slug" => Self::Slug,
      "text" => Self::Text,
      "textarea" => Self::Textarea,
      "upload" => Self::Upload,
      "username" => Self::Username,
      _ => return None,
    })
  }
}

pub fn validate(validator: Validator, value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  match validator {
    Validator::Array => array(value, options, req),
    Validator::Blocks => blocks(value, options, req),
    Validator::Checkbox => checkbox(value, options, req),
    Validator::Code => code(value, options, req),
    Validator::ConfirmPassword => confirm_password(value, options, req),
    Validator::Date => date(value, options, req),
    Validator::Email => email(value, options, req),
    Validator::Json => json(value, options, req),
    Validator::Number => number(value, options, req),
    Validator::Password => password(value, options, req),
    Validator::Point => point(value, options, req),
    Validator::Radio => radio(value, options, req),
    Validator::Relationship => relationship(value, options, req),
    Validator::RichText => rich_text(value, options, req),
    Validator::Select => select(value, options, req),
    Validator::Slug => Ok(slug()),
    Validator::Text => text(value, options, req),
    Validator::Textarea => textarea(value, options, req),
    Validator::Upload => upload(value, options, req),
    Validator::Username => username(value, options, req),
  }
}

fn vars<const N: usize>(entries: [(&str, JsVal); N]) -> Obj {
  entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn t(req: &Req, key: &str) -> Result<String> {
  req.t.t(key, None)
}

fn t_vars(req: &Req, key: &str, vars: Obj) -> Result<String> {
  req.t.t(key, Some(&vars))
}

/// `String(value)`, with `Date` texts from the host.
fn string(value: &JsVal, req: &Req) -> Result<String> {
  to_string_with(value, &|ms| req.host.date_to_string(ms))
}

fn invalid(message: String) -> Result<ValidationResult> {
  Ok(Invalid(message))
}

/// `config?.defaultMaxTextLength` when it is a number.
fn default_max_text_length(req: &Req) -> JsVal {
  match get_opt(req.config, "defaultMaxTextLength") {
    n @ JsVal::Num(_) => n,
    _ => JsVal::Undefined,
  }
}

/// `typeof fieldMaxLength === 'number'` overriding the config default.
fn max_length(options: &JsVal, req: &Req) -> JsVal {
  match get_opt(options, "maxLength") {
    n @ JsVal::Num(_) => n,
    _ => default_max_text_length(req),
  }
}

/// `value?.length || 0`
fn length_or_zero(value: &JsVal) -> JsVal {
  let length = get_opt(value, "length");
  if length.truthy() { length } else { JsVal::Num(0.0) }
}

/// `value.length === 0` for strings and arrays.
fn is_empty_string_or_array(value: &JsVal) -> bool {
  match value {
    JsVal::Str(s) => s.is_empty(),
    JsVal::Arr(a) => a.is_empty(),
    _ => false,
  }
}

pub fn text(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  let required = get_opt(options, "required");
  if !required.truthy() && value.is_nullish() {
    return Ok(Valid);
  }

  if get_opt(options, "hasMany").is_true() {
    let result = validate_array_length(value, options, &required, req)?;
    if !result.is_valid() {
      return Ok(result);
    }
  }

  let max_length = max_length(options, req);
  let min_length = get_opt(options, "minLength");

  let single = [value.clone()];
  let strings = value.as_arr().unwrap_or(&single);

  for string_value in strings {
    let length = length_or_zero(string_value);

    if matches!(max_length, JsVal::Num(_)) && gt(&length, &max_length)? {
      let label = t(req, "general:value")?;
      return invalid(t_vars(
        req,
        "validation:shorterThanMax",
        vars([("label", JsVal::str(label)), ("maxLength", max_length.clone()), ("stringValue", string_value.clone())]),
      )?);
    }

    if matches!(min_length, JsVal::Num(_)) && lt(&length, &min_length)? {
      let label = t(req, "general:value")?;
      return invalid(t_vars(
        req,
        "validation:longerThanMin",
        vars([("label", JsVal::str(label)), ("minLength", min_length.clone()), ("stringValue", string_value.clone())]),
      )?);
    }
  }

  if required.truthy() && (!value.truthy() || is_empty_string_or_array(value)) {
    return invalid(t(req, "validation:required")?);
  }

  Ok(Valid)
}

/// Always valid: slugs are populated (and made unique) by the field's hooks.
pub fn slug() -> ValidationResult {
  Valid
}

/// Shared tail of `password` / `textarea`.
fn text_length(
  value: &JsVal,
  max_length: &JsVal,
  min_length: &JsVal,
  required: &JsVal,
  req: &Req,
) -> Result<ValidationResult> {
  if value.truthy() && max_length.truthy() && gt(&get(value, "length")?, max_length)? {
    return invalid(t_vars(req, "validation:shorterThanMax", vars([("maxLength", max_length.clone())]))?);
  }

  if value.truthy() && min_length.truthy() && lt(&get(value, "length")?, min_length)? {
    return invalid(t_vars(req, "validation:longerThanMin", vars([("minLength", min_length.clone())]))?);
  }

  if required.truthy() && !value.truthy() {
    return invalid(t(req, "validation:required")?);
  }

  Ok(Valid)
}

pub fn password(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  let min_length = match get_opt(options, "minLength") {
    JsVal::Undefined => JsVal::Num(3.0),
    other => other,
  };
  text_length(value, &max_length(options, req), &min_length, &get_opt(options, "required"), req)
}

pub fn confirm_password(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  if get_opt(options, "required").truthy() && !value.truthy() {
    return invalid(t(req, "validation:required")?);
  }

  if value.truthy() && !strict_eq(value, &get(&get_opt(options, "siblingData"), "password")?) {
    return invalid(t(req, "fields:passwordsDoNotMatch")?);
  }

  Ok(Valid)
}

/// `collections?.[collectionSlug]?.config ?? config.collections.find(({ slug }) => slug === collectionSlug)`
fn collection_config(collection_slug: &JsVal, req: &Req) -> Result<JsVal> {
  let from_collections = if req.collections.is_nullish() {
    JsVal::Undefined
  } else {
    get_opt(&get_opt(req.collections, &string(collection_slug, req)?), "config")
  };
  if !from_collections.is_nullish() {
    return Ok(from_collections);
  }
  let configs = get(req.config, "collections")?;
  let JsVal::Arr(configs) = &configs else {
    return Err(type_error("config.collections.find is not a function"));
  };
  for collection in configs.iter() {
    if strict_eq(&get(collection, "slug")?, collection_slug) {
      return Ok(collection.clone());
    }
  }
  Ok(JsVal::Undefined)
}

/// The `loginWithUsername` "email or username is required" check of `email` / `username`.
fn login_with_username_requires_either(
  value: &JsVal,
  options: &JsVal,
  other_field: &str,
  req: &Req,
) -> Result<Option<ValidationResult>> {
  let collection_slug = get_opt(options, "collectionSlug");
  if !collection_slug.truthy() {
    return Ok(None);
  }
  let collection = collection_config(&collection_slug, req)?;
  let login_with_username = get(&get(&collection, "auth")?, "loginWithUsername")?;
  if login_with_username.truthy()
    && !get_opt(&login_with_username, "requireUsername").truthy()
    && !get_opt(&login_with_username, "requireEmail").truthy()
    && !value.truthy()
    && !get_opt(&get_opt(options, "siblingData"), other_field).truthy()
  {
    return Ok(Some(Invalid(t(req, "validation:required")?)));
  }
  Ok(None)
}

pub fn email(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  if let Some(result) = login_with_username_requires_either(value, options, "username", req)? {
    return Ok(result);
  }

  let required = get_opt(options, "required");
  if !value.truthy() && required.truthy() {
    return invalid(t(req, "validation:required")?);
  }

  if value.truthy() && !is_valid_email(&string(value, req)?) {
    return invalid(t(req, "validation:emailAddress")?);
  }

  Ok(Valid)
}

/// The email regex of `validations.ts` (`/i`, non-unicode):
/// `^(?!.*\.\.)[\w!#$%&'*+/=?^`{|}~-](?:[\w!#$%&'*+/=?^`{|}~.-]*[\w!#$%&'*+/=?^`{|}~-])?@`
/// `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$`
///
/// No class contains a line terminator, so the `(?!.*\.\.)` lookahead (whose `.` stops at line
/// terminators) is equivalent to "contains no `..`".
pub fn is_valid_email(s: &str) -> bool {
  fn is_local(c: char) -> bool {
    c.is_ascii_alphanumeric() || "_!#$%&'*+/=?^`{|}~-".contains(c)
  }
  fn is_label(label: &str) -> bool {
    let b = label.as_bytes();
    !b.is_empty()
      && b[0].is_ascii_alphanumeric()
      && b[b.len() - 1].is_ascii_alphanumeric()
      && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
  }
  if s.contains("..") {
    return false;
  }
  let Some((local, domain)) = s.split_once('@') else { return false };
  let local_chars: Vec<char> = local.chars().collect();
  let (Some(first), Some(last)) = (local_chars.first(), local_chars.last()) else { return false };
  if !is_local(*first) || !is_local(*last) || !local_chars.iter().all(|c| is_local(*c) || *c == '.') {
    return false;
  }
  let Some((labels, tld)) = domain.rsplit_once('.') else { return false };
  tld.len() >= 2 && tld.bytes().all(|c| c.is_ascii_alphabetic()) && labels.split('.').all(is_label)
}

pub fn username(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  if let Some(result) = login_with_username_requires_either(value, options, "email", req)? {
    return Ok(result);
  }

  let max_length = default_max_text_length(req);
  if value.truthy() && max_length.truthy() && gt(&get(value, "length")?, &max_length)? {
    return invalid(t_vars(req, "validation:shorterThanMax", vars([("maxLength", max_length)]))?);
  }

  if !value.truthy() && get_opt(options, "required").truthy() {
    return invalid(t(req, "validation:required")?);
  }

  Ok(Valid)
}

pub fn textarea(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  text_length(
    value,
    &max_length(options, req),
    &get_opt(options, "minLength"),
    &get_opt(options, "required"),
    req,
  )
}

pub fn code(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  if get_opt(options, "required").truthy() && (!value.truthy() || matches!(value, JsVal::Str(s) if s.is_empty())) {
    return invalid(t(req, "validation:required")?);
  }
  Ok(Valid)
}

/// `isNotEmpty` of the `json` validator.
fn json_is_not_empty(value: &JsVal) -> bool {
  match value {
    JsVal::Undefined | JsVal::Null => false,
    JsVal::Arr(a) => !a.is_empty(),
    JsVal::Obj(o) => !o.is_empty(),
    _ => true,
  }
}

pub fn json(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  if get_opt(options, "required").truthy() && !value.truthy() {
    return invalid(t(req, "validation:required")?);
  }

  if !get_opt(options, "jsonError").is_undefined() {
    return invalid(t(req, "validation:invalidInput")?);
  }

  let json_schema = get_opt(options, "jsonSchema");
  if json_schema.truthy() && json_is_not_empty(value) {
    return req.host.validate_json_schema(&json_schema, value);
  }

  Ok(Valid)
}

pub fn checkbox(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  let is_boolean = matches!(value, JsVal::Bool(_));
  if (value.truthy() && !is_boolean) || (get_opt(options, "required").truthy() && !is_boolean) {
    return invalid(t(req, "validation:trueOrFalse")?);
  }
  Ok(Valid)
}

pub fn date(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  let is_valid_date = value.truthy()
    && !date_parse(&call_to_string_with(value, "value", &|ms| req.host.date_to_string(ms))?, &HostTz(req.host))
      .is_nan();

  let required = get_opt(options, "required");
  let has_required_timezone = get_opt(options, "timezone").truthy() && required.truthy();
  let timezone_key = format!("{}_tz", string(&get_opt(options, "name"), req)?);
  let selected_timezone = get_opt(&get_opt(options, "siblingData"), &timezone_key);
  let is_valid_timezone = if has_required_timezone { selected_timezone.truthy() } else { true };

  if is_valid_date && is_valid_timezone {
    return Ok(Valid);
  }

  if is_valid_date && !is_valid_timezone {
    return invalid(t(req, "validation:timezoneRequired")?);
  }

  if value.truthy() {
    return invalid(t_vars(req, "validation:notValidDate", vars([("value", JsVal::str(string(value, req)?))]))?);
  }

  if required.truthy() {
    return invalid(t(req, "validation:required")?);
  }

  Ok(Valid)
}

pub fn rich_text(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  let editor = get_opt(options, "editor");
  if !editor.truthy() {
    return Err(EngineError::internal("richText field has no editor property."));
  }
  if editor.is_fn() {
    return Err(EngineError::internal("Attempted to access unsanitized rich text editor."));
  }
  req.host.rich_text_validate(&editor, value, options)
}

/// `validateArrayLength(value, { maxRows, minRows, required, t })`
fn validate_array_length(value: &JsVal, options: &JsVal, required: &JsVal, req: &Req) -> Result<ValidationResult> {
  let max_rows = get_opt(options, "maxRows");
  let min_rows = get_opt(options, "minRows");

  let array_length = match value {
    JsVal::Arr(a) => JsVal::Num(a.len() as f64),
    v if v.truthy() => v.clone(),
    _ => JsVal::Num(0.0),
  };

  if !required.truthy() && strict_eq(&array_length, &JsVal::Num(0.0)) {
    return Ok(Valid);
  }

  if min_rows.truthy() && lt(&array_length, &min_rows)? {
    let label = t(req, "general:rows")?;
    return invalid(t_vars(req, "validation:requiresAtLeast", vars([("count", min_rows), ("label", JsVal::str(label))]))?);
  }

  if max_rows.truthy() && gt(&array_length, &max_rows)? {
    let label = t(req, "general:rows")?;
    return invalid(t_vars(
      req,
      "validation:requiresNoMoreThan",
      vars([("count", max_rows), ("label", JsVal::str(label))]),
    )?);
  }

  if required.truthy() && !array_length.truthy() {
    let label = t(req, "general:row")?;
    return invalid(t_vars(
      req,
      "validation:requiresAtLeast",
      vars([("count", JsVal::Num(1.0)), ("label", JsVal::str(label))]),
    )?);
  }

  Ok(Valid)
}

/// `isNumber` from `utilities/isNumber.ts`
fn is_number(value: &JsVal) -> Result<bool> {
  match value {
    JsVal::Undefined | JsVal::Null => Ok(false),
    JsVal::Str(s) if trim(s).is_empty() => Ok(false),
    _ => Ok(!to_number(value)?.is_nan()),
  }
}

pub fn number(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  let required = get_opt(options, "required");

  if get_opt(options, "hasMany").is_true() {
    let result = validate_array_length(value, options, &required, req)?;
    if !result.is_valid() {
      return Ok(result);
    }
  }

  if !value.truthy() && !is_number(value)? {
    if required.truthy() {
      return invalid(t(req, "validation:required")?);
    }
    return Ok(Valid);
  }

  let max = get_opt(options, "max");
  let min = get_opt(options, "min");
  let single = [value.clone()];
  let numbers = value.as_arr().unwrap_or(&single);

  for n in numbers {
    if !is_number(n)? {
      return invalid(t(req, "validation:enterNumber")?);
    }

    let number_value = parse_float(n)?;

    if let JsVal::Num(max_n) = max
      && number_value > max_n
    {
      let label = t(req, "general:value")?;
      return invalid(t_vars(
        req,
        "validation:greaterThanMax",
        vars([("label", JsVal::str(label)), ("max", max.clone()), ("value", JsVal::Num(number_value))]),
      )?);
    }

    if let JsVal::Num(min_n) = min
      && number_value < min_n
    {
      let label = t(req, "general:value")?;
      return invalid(t_vars(
        req,
        "validation:lessThanMin",
        vars([("label", JsVal::str(label)), ("min", min.clone()), ("value", JsVal::Num(number_value))]),
      )?);
    }
  }

  Ok(Valid)
}

pub fn array(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  validate_array_length(value, options, &get_opt(options, "required"), req)
}

/// The result of `validateBlocksFilterOptions`.
#[derive(Debug)]
pub struct BlocksFilterOptionsResult {
  /// All truthy `blockType`s found in the value.
  pub all_block_slugs: Vec<JsVal>,
  /// `None`: all blocks are allowed.
  pub allowed_block_slugs: Option<Vec<JsVal>>,
  pub invalid_block_slugs: Vec<JsVal>,
}

/// `validateBlocksFilterOptions({ id, data, filterOptions, req, siblingData, value })`
pub fn validate_blocks_filter_options(
  value: &JsVal,
  id: &JsVal,
  data: &JsVal,
  filter_options: &JsVal,
  sibling_data: &JsVal,
  req: &Req,
) -> Result<BlocksFilterOptionsResult> {
  let all_block_slugs = match value {
    JsVal::Arr(blocks) => {
      let block_types = blocks.iter().map(|b| get(b, "blockType")).collect::<Result<Vec<_>>>()?;
      block_types.into_iter().filter(JsVal::truthy).collect()
    }
    _ => Vec::new(),
  };

  let mut allowed_block_slugs = None;
  match filter_options {
    JsVal::Fn(func) => {
      let result = req.host.filter_options(*func, FilterOptionsCall::Blocks { id, data, sibling_data })?;
      if let JsVal::Arr(allowed) = result {
        allowed_block_slugs = Some(allowed.to_vec());
      }
    }
    JsVal::Arr(allowed) => allowed_block_slugs = Some(allowed.to_vec()),
    _ => {}
  }

  let invalid_block_slugs = match &allowed_block_slugs {
    Some(allowed) => {
      all_block_slugs.iter().filter(|slug| !allowed.iter().any(|a| same_value_zero(a, slug))).cloned().collect()
    }
    None => Vec::new(),
  };

  Ok(BlocksFilterOptionsResult { all_block_slugs, allowed_block_slugs, invalid_block_slugs })
}

pub fn blocks(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  if let Some(result) = blocks_prefix(value, options, req)? {
    return Ok(result);
  }
  let BlocksFilterOptionsResult { invalid_block_slugs, .. } = validate_blocks_filter_options(
    value,
    &get_opt(options, "id"),
    &get_opt(options, "data"),
    &get_opt(options, "filterOptions"),
    &get_opt(options, "siblingData"),
    req,
  )?;
  blocks_invalid_block_slugs(&invalid_block_slugs, req)
}

/// `blocks` up to `await validateBlocksFilterOptions(...)`: `Some` when it returns before.
pub fn blocks_prefix(value: &JsVal, options: &JsVal, req: &Req) -> Result<Option<ValidationResult>> {
  let result = validate_array_length(value, options, &get_opt(options, "required"), req)?;
  if !result.is_valid() {
    return Ok(Some(result));
  }
  if !get_opt(options, "filterOptions").truthy() {
    return Ok(Some(Valid));
  }
  Ok(None)
}

/// `blocks` after `validateBlocksFilterOptions` returned `invalidBlockSlugs`.
pub fn blocks_invalid_block_slugs(invalid_block_slugs: &[JsVal], req: &Req) -> Result<ValidationResult> {
  if !invalid_block_slugs.is_empty() {
    return invalid(t_vars(
      req,
      "validation:invalidBlocks",
      vars([("blocks", JsVal::str(join(invalid_block_slugs, ", ")?))]),
    )?);
  }
  Ok(Valid)
}

/// `validateFilterOptions` of relationship / upload fields.
pub fn validate_filter_options(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  let filter_options = get_opt(options, "filterOptions");
  if filter_options.is_undefined() || !value.truthy() {
    return Ok(Valid);
  }

  let relation_to = get_opt(options, "relationTo");
  let single_collection = [relation_to.clone()];
  let collections = relation_to.as_arr().unwrap_or(&single_collection);
  let single_value = [value.clone()];
  let values = value.as_arr().unwrap_or(&single_value);

  let mut options_by_collection: IndexMap<String, Vec<JsVal>> = IndexMap::new();
  let mut false_collections: Vec<JsVal> = Vec::new();

  for collection in collections {
    let mut attempt = || -> Result<(String, Vec<JsVal>)> {
      let mut option_filter = match &filter_options {
        JsVal::Fn(func) => req.host.filter_options(
          *func,
          FilterOptionsCall::Relationship {
            id: &get_opt(options, "id"),
            block_data: &get_opt(options, "blockData"),
            data: &get_opt(options, "data"),
            relation_to: collection,
            sibling_data: &get_opt(options, "siblingData"),
          },
        )?,
        other => other.clone(),
      };

      if option_filter.is_true() {
        option_filter = JsVal::Null;
      }

      let mut value_ids = Vec::new();
      for val in values {
        if type_of(val) == "object" {
          let id = get_opt(val, "value");
          if id.truthy() {
            value_ids.push(id);
          }
        }
        if matches!(val, JsVal::Str(_) | JsVal::Num(_)) {
          value_ids.push(val.clone());
        }
      }

      if value_ids.is_empty() {
        return Ok((string(collection, req)?, Vec::new()));
      }

      let mut and = vec![JsVal::obj(vars([("id", JsVal::obj(vars([("in", JsVal::arr(value_ids))])))]))];
      if option_filter.truthy() && !option_filter.is_true() {
        and.push(option_filter.clone());
      }
      let find_where = JsVal::obj(vars([("and", JsVal::arr(and))]));

      if matches!(option_filter, JsVal::Bool(false)) {
        false_collections.push(collection.clone());
      }

      let override_access = match get_opt(options, "overrideAccess") {
        v if v.is_nullish() => JsVal::Bool(false),
        v => v,
      };
      let result =
        req.host.find(FindArgs { collection, override_access: &override_access, where_: &find_where })?;
      let docs = get(&result, "docs")?;
      let JsVal::Arr(docs) = &docs else {
        return Err(type_error("result.docs.map is not a function"));
      };
      let ids = docs.iter().map(|doc| get(doc, "id")).collect::<Result<Vec<_>>>()?;
      Ok((string(collection, req)?, ids))
    };

    match attempt() {
      Ok((key, ids)) => {
        options_by_collection.insert(key, ids);
      }
      Err(err) if req.host.is_interrupt(&err) => return Err(err),
      Err(err) => {
        let collection_name = string(collection, req)?;
        req.host.log_error(&format!("Error validating filter options for collection {collection_name}"), &err)?;
        options_by_collection.insert(collection_name, Vec::new());
      }
    }
  }

  let mut invalid_relationships = Vec::new();
  for val in values {
    let mut collection = JsVal::Undefined;
    let mut requested_id = JsVal::Undefined;

    if let JsVal::Str(_) = relation_to {
      collection = relation_to.clone();
      if matches!(val, JsVal::Str(_) | JsVal::Num(_)) {
        requested_id = val.clone();
      }
    }

    if matches!(relation_to, JsVal::Arr(_)) && type_of(val) == "object" && get_opt(val, "relationTo").truthy() {
      collection = get_opt(val, "relationTo");
      requested_id = get_opt(val, "value");
    }

    let is_false_collection =
      false_collections.iter().find(|slug| strict_eq(&relation_to, slug)).is_some_and(JsVal::truthy);
    if is_false_collection {
      invalid_relationships.push(val.clone());
      continue;
    }

    let key = string(&collection, req)?;
    let is_invalid = match options_by_collection.get(&key) {
      Some(ids) => !ids.iter().any(|id| strict_eq(id, &requested_id)),
      None if OBJECT_PROTOTYPE_KEYS.contains(&key.as_str()) => {
        return Err(type_error("options[collection].indexOf is not a function"));
      }
      None => true,
    };
    if is_invalid {
      invalid_relationships.push(val.clone());
    }
  }

  if invalid_relationships.is_empty() {
    return Ok(Valid);
  }

  let mut message = t(req, "validation:invalidSelections")?;
  let count = invalid_relationships.len();
  for (i, relationship) in invalid_relationships.iter().enumerate() {
    let comma = if count == i + 1 { "," } else { "" };
    message = format!("{message} {}{comma} ", json_stringify_interpolated(relationship)?);
  }
  invalid(message)
}

/// `isValidID(value, type)` from `utilities/isValidID.ts`
fn is_valid_id(value: &JsVal, id_type: &JsVal, req: &Req) -> Result<bool> {
  let id_type = id_type.as_str();
  if id_type == Some("text") && value.truthy() {
    if matches!(type_of(value), "object" | "string") {
      let is_object_id = object_id_is_valid(value);
      return Ok(matches!(value, JsVal::Str(_)) || is_object_id);
    }
    return Ok(false);
  }

  if id_type == Some("number") && matches!(value, JsVal::Num(n) if !n.is_nan()) {
    return Ok(true);
  }

  if id_type == Some("ObjectID") {
    return Ok(object_id_is_valid(&JsVal::str(string(value, req)?)));
  }

  Ok(false)
}

/// Shared implementation of `upload` and `relationship` (identical in TS).
fn relationship_like(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  match relationship_prefix(value, options, req)? {
    Some(result) => Ok(result),
    None => validate_filter_options(value, options, req),
  }
}

/// `upload` / `relationship` up to `return validateFilterOptions(value, options)`: `Some` when
/// they return before it.
pub fn relationship_prefix(value: &JsVal, options: &JsVal, req: &Req) -> Result<Option<ValidationResult>> {
  let required = get_opt(options, "required");
  let relation_to = get_opt(options, "relationTo");

  let is_empty =
    (!value.truthy() && !matches!(value, JsVal::Num(_))) || matches!(value, JsVal::Arr(a) if a.is_empty());
  if is_empty && required.truthy() {
    return Ok(Some(Invalid(t(req, "validation:required")?)));
  }

  if let JsVal::Arr(items) = value
    && !items.is_empty()
  {
    let length = JsVal::Num(items.len() as f64);
    let min_rows = get_opt(options, "minRows");
    if min_rows.truthy() && lt(&length, &min_rows)? {
      let label = t(req, "general:rows")?;
      return Ok(Some(Invalid(t_vars(
        req,
        "validation:lessThanMin",
        vars([("label", JsVal::str(label)), ("min", min_rows), ("value", length)]),
      )?)));
    }

    let max_rows = get_opt(options, "maxRows");
    if max_rows.truthy() && gt(&length, &max_rows)? {
      let label = t(req, "general:rows")?;
      return Ok(Some(Invalid(t_vars(
        req,
        "validation:greaterThanMax",
        vars([("label", JsVal::str(label)), ("max", max_rows), ("value", length)]),
      )?)));
    }
  }

  if !value.is_nullish() {
    let single = [value.clone()];
    let values = value.as_arr().unwrap_or(&single);

    let mut invalid_relationships = Vec::new();
    for val in values {
      let mut collection_slug = JsVal::Undefined;
      let mut requested_id = JsVal::Undefined;

      if let JsVal::Str(_) = relation_to {
        collection_slug = relation_to.clone();
        if val.truthy() || matches!(val, JsVal::Num(_)) {
          requested_id = val.clone();
        }
      }

      if matches!(relation_to, JsVal::Arr(_)) && type_of(val) == "object" && get_opt(val, "relationTo").truthy() {
        collection_slug = get_opt(val, "relationTo");
        requested_id = get_opt(val, "value");
      }

      if requested_id.is_null() {
        continue;
      }

      let collection = get(req.collections, &string(&collection_slug, req)?)?;
      let mut id_type = get_opt(&collection, "customIDType");
      if !id_type.truthy() {
        id_type = req.default_id_type.clone();
      }
      if !id_type.truthy() {
        id_type = JsVal::str("text");
      }

      if !is_valid_id(&requested_id, &id_type, req)? {
        invalid_relationships.push(val.clone());
      }
    }

    if !invalid_relationships.is_empty() {
      let parts = invalid_relationships
        .iter()
        .enumerate()
        .map(|(index, err)| Ok(format!("{} {index}", string(err, req)?)))
        .collect::<Result<Vec<_>>>()?;
      return Ok(Some(Invalid(format!(
        "This relationship field has the following invalid relationships: {}",
        parts.join(", ")
      ))));
    }
  }

  if strict_eq(&get_opt(options, "event"), &JsVal::str("onChange")) {
    return Ok(Some(Valid));
  }

  Ok(None)
}

pub fn upload(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  relationship_like(value, options, req)
}

pub fn relationship(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  relationship_like(value, options, req)
}

/// `options.some(option => option === input || (typeof option !== 'string' && option?.value === input))`
/// (`optional_value`) or with `option.value` (throws on nullish options).
/// `name` is the receiver's variable name in the TS (`filteredOptions` / `options`), as V8 prints it.
fn options_include(options: &JsVal, input: &JsVal, optional_value: bool, name: &str) -> Result<bool> {
  let JsVal::Arr(items) = options else {
    return Err(type_error(if options.is_nullish() {
      format!("Cannot read properties of {} (reading 'some')", if options.is_null() { "null" } else { "undefined" })
    } else {
      format!("{name}.some is not a function")
    }));
  };
  for option in items.iter() {
    if strict_eq(option, input) {
      return Ok(true);
    }
    if !matches!(option, JsVal::Str(_)) {
      let option_value = if optional_value { get_opt(option, "value") } else { get(option, "value")? };
      if strict_eq(&option_value, input) {
        return Ok(true);
      }
    }
  }
  Ok(false)
}

pub fn select(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  let field_options = get_opt(options, "options");
  let filtered_options = match get_opt(options, "filterOptions") {
    JsVal::Fn(func) => req.host.filter_options(
      func,
      FilterOptionsCall::Select {
        data: &get_opt(options, "data"),
        options: &field_options,
        sibling_data: &get_opt(options, "siblingData"),
      },
    )?,
    _ => field_options,
  };

  if let JsVal::Arr(inputs) = value {
    for input in inputs.iter() {
      if !options_include(&filtered_options, input, true, "filteredOptions")? {
        return invalid(t(req, "validation:invalidSelection")?);
      }
    }
  }

  let has_many = get_opt(options, "hasMany");
  if let JsVal::Arr(items) = value
    && has_many.truthy()
    && items.len() > 1
  {
    let mut counts: Vec<(JsVal, usize)> = Vec::new();
    for item in items.iter() {
      match counts.iter_mut().find(|(key, _)| same_value_zero(key, item)) {
        Some((_, count)) => *count += 1,
        None => counts.push((item.clone(), 1)),
      }
    }

    let duplicates: Vec<&JsVal> =
      counts.iter().filter(|(_, count)| *count > 1).flat_map(|(item, count)| std::iter::repeat_n(item, *count)).collect();

    if !duplicates.is_empty() {
      let mut message = t(req, "validation:invalidSelections")?;
      for (i, duplicate) in duplicates.iter().enumerate() {
        let comma = if i < duplicates.len() - 1 { "," } else { "" };
        message = format!("{message} {}{comma}", json_stringify_interpolated(duplicate)?);
      }
      return invalid(message);
    }
  }

  if matches!(value, JsVal::Str(_)) && !options_include(&filtered_options, value, false, "filteredOptions")? {
    return invalid(t(req, "validation:invalidSelection")?);
  }

  if get_opt(options, "required").truthy()
    && (value.is_nullish() || (has_many.truthy() && matches!(value, JsVal::Arr(a) if a.is_empty())))
  {
    return invalid(t(req, "validation:required")?);
  }

  Ok(Valid)
}

pub fn radio(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  if value.truthy() {
    if options_include(&get_opt(options, "options"), value, false, "options")? {
      return Ok(Valid);
    }
    return invalid(t(req, "validation:invalidSelection")?);
  }

  if get_opt(options, "required").truthy() {
    return invalid(t(req, "validation:required")?);
  }
  Ok(Valid)
}

pub fn point(value: &JsVal, options: &JsVal, req: &Req) -> Result<ValidationResult> {
  let required = get_opt(options, "required");
  let value = match value {
    JsVal::Undefined => JsVal::arr(vec![JsVal::str(""), JsVal::str("")]),
    other => other.clone(),
  };

  if value.is_null() {
    if required.truthy() {
      return invalid(t(req, "validation:required")?);
    }
    return Ok(Valid);
  }

  let first = get(&value, "0")?;
  let second = get(&value, "1")?;
  let lng = parse_float_str(&string(&first, req)?);
  let lat = parse_float_str(&string(&second, req)?);

  if required.truthy() && (lng.is_nan() || lat.is_nan() || matches!(&value, JsVal::Arr(a) if a.len() != 2)) {
    return invalid(t(req, "validation:requiresTwoNumbers")?);
  }

  if (second.truthy() && lng.is_nan()) || (first.truthy() && lat.is_nan()) {
    return invalid(t(req, "validation:invalidInput")?);
  }

  if first.truthy() && !lng.is_nan() && !(-180.0..=180.0).contains(&lng) {
    return invalid(t(req, "validation:longitudeOutOfBounds")?);
  }

  if second.truthy() && !lat.is_nan() && !(-90.0..=90.0).contains(&lat) {
    return invalid(t(req, "validation:latitudeOutOfBounds")?);
  }

  Ok(Valid)
}
