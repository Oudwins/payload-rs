//! `req.t`: the translation function the validators call.
//!
//! [`Translate`] is the host interface (an engine embedded in Node can forward to the request's
//! real `req.t`). [`I18n`] ports `t` from `@payloadcms/translations/src/utilities/init.ts`
//! (`getTranslationString` + `replaceVars`) over an i18n `translations` object, i.e. what
//! `initI18n(...).t` does, including its quirks:
//! - plural suffix lookup (`_zero`, `_one`, `_two`, `_many`, `_few`, `_other`) whenever
//!   `vars.count` is a number, with the suffix state carried across key segments;
//! - the `in` operator throwing a `TypeError` when an intermediate value is not an object;
//! - `{{placeholder}}` splitting with `/(\{\{.*?\}\})/` (no line terminators inside) and the
//!   `startsWith('{{') && endsWith('}}')` check applied to every part;
//! - placeholders resolving to inherited `Object.prototype` members.
//!
//! Not ported: the `console.log('key not found:', key)` side effect; non-string translation
//! leaves (TS would return the raw value, or throw on `.split` when vars are given) are reported
//! as an error.

use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, Obj};

use crate::js::{OBJECT_PROTOTYPE_KEYS, to_string, trim, type_error, type_of};

pub trait Translate {
  /// `t(key, vars)`
  fn t(&self, key: &str, vars: Option<&Obj>) -> Result<String>;
}

/// `initI18n(...).t` over an already merged `translations` object.
pub struct I18n {
  pub translations: JsVal,
}

impl Translate for I18n {
  fn t(&self, key: &str, vars: Option<&Obj>) -> Result<String> {
    t(key, &self.translations, vars)
  }
}

/// `key in value`
fn js_in(key: &str, value: &JsVal) -> Result<bool> {
  match value {
    JsVal::Obj(o) => Ok(o.contains_key(key) || OBJECT_PROTOTYPE_KEYS.contains(&key)),
    JsVal::Arr(a) => Ok(key == "length" || key.parse::<usize>().is_ok_and(|i| i < a.len() && i.to_string() == key)),
    JsVal::Fn(_) => Err(EngineError::internal("translations containing functions are not supported")),
    other => Err(type_error(format!(
      "Cannot use 'in' operator to search for '{key}' in {}",
      to_string(other).unwrap_or_default()
    ))),
  }
}

fn lookup(acc: &JsVal, key: &str) -> Result<JsVal> {
  match acc {
    JsVal::Obj(o) => match o.get(key) {
      Some(v) => Ok(v.clone()),
      None => Err(EngineError::internal(format!("translation key '{key}' resolves to an Object.prototype member"))),
    },
    JsVal::Arr(a) => Ok(if key == "length" {
      JsVal::Num(a.len() as f64)
    } else {
      key.parse::<usize>().ok().and_then(|i| a.get(i).cloned()).unwrap_or_default()
    }),
    _ => Ok(JsVal::Undefined),
  }
}

/// `getTranslationString({ count, key, translations })`
pub fn get_translation_string(key: &str, translations: &JsVal, count: Option<f64>) -> Result<JsVal> {
  let keys: Vec<&str> = key.split(':').collect();
  let mut key_suffix = "";
  let mut acc = translations.clone();
  for (index, segment) in keys.iter().enumerate() {
    if matches!(acc, JsVal::Str(_)) {
      continue;
    }
    if let Some(count) = count {
      let has = |suffix: &str| js_in(&format!("{segment}{suffix}"), &acc);
      if count == 0.0 && has("_zero")? {
        key_suffix = "_zero";
      } else if count == 1.0 && has("_one")? {
        key_suffix = "_one";
      } else if count == 2.0 && has("_two")? {
        key_suffix = "_two";
      } else if count > 5.0 && has("_many")? {
        key_suffix = "_many";
      } else if count > 2.0 && count <= 5.0 && has("_few")? {
        key_suffix = "_few";
      } else if has("_other")? {
        key_suffix = "_other";
      }
    }
    let key_to_use =
      if index == keys.len() - 1 && !key_suffix.is_empty() { format!("{segment}{key_suffix}") } else { segment.to_string() };
    acc = if acc.truthy() && js_in(&key_to_use, &acc)? { lookup(&acc, &key_to_use)? } else { JsVal::Undefined };
  }
  Ok(if acc.truthy() { acc } else { JsVal::str(key) })
}

/// `vars[placeholder]` as `replaceVars` substitutes it (`None` keeps the `{{...}}` part).
fn var_value(vars: &Obj, placeholder: &str) -> Result<Option<String>> {
  match vars.get(placeholder) {
    Some(v) if v.is_nullish() => Ok(None),
    Some(v) => to_string(v).map(Some),
    None if placeholder == "__proto__" => Ok(Some("[object Object]".into())),
    None if OBJECT_PROTOTYPE_KEYS.contains(&placeholder) => {
      let name = if placeholder == "constructor" { "Object" } else { placeholder };
      Ok(Some(format!("function {name}() {{ [native code] }}")))
    }
    None => Ok(None),
  }
}

fn is_line_terminator(c: char) -> bool {
  matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `translationString.split(/(\{\{.*?\}\})/)`
fn split_placeholders(s: &str) -> Vec<&str> {
  let mut parts = Vec::new();
  let mut last = 0;
  let mut i = 0;
  while i < s.len() {
    if s[i..].starts_with("{{") {
      let body_start = i + 2;
      let mut found = None;
      let mut j = body_start;
      while j < s.len() {
        if s[j..].starts_with("}}") {
          found = Some(j);
          break;
        }
        let c = s[j..].chars().next().unwrap_or(' ');
        if is_line_terminator(c) {
          break;
        }
        j += c.len_utf8();
      }
      if let Some(j) = found {
        parts.push(&s[last..i]);
        parts.push(&s[i..j + 2]);
        last = j + 2;
        i = j + 2;
        continue;
      }
    }
    i += s[i..].chars().next().map(char::len_utf8).unwrap_or(1);
  }
  parts.push(&s[last..]);
  parts
}

fn replace_vars(translation: &str, vars: &Obj) -> Result<String> {
  let mut out = String::new();
  for part in split_placeholders(translation) {
    if part.len() >= 4 && part.starts_with("{{") && part.ends_with("}}") {
      let placeholder = trim(&part[2..part.len() - 2]);
      match var_value(vars, placeholder)? {
        Some(value) => out.push_str(&value),
        None => out.push_str(part),
      }
    } else {
      out.push_str(part);
    }
  }
  Ok(out)
}

/// `t({ key, translations, vars })`
pub fn t(key: &str, translations: &JsVal, vars: Option<&Obj>) -> Result<String> {
  let count = vars.and_then(|v| v.get("count")).and_then(JsVal::as_num);
  let translation = get_translation_string(key, translations, count)?;
  let JsVal::Str(translation) = translation else {
    return Err(match vars {
      Some(_) => type_error("translationString.split is not a function"),
      None => EngineError::internal(format!(
        "translation '{key}' resolved to a non-string value ({})",
        type_of(&translation)
      )),
    });
  };
  let result = match vars {
    Some(vars) => replace_vars(&translation, vars)?,
    None => translation.to_string(),
  };
  Ok(if result.is_empty() { key.to_string() } else { result })
}
