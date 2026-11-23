//! Statement templates (RUST_PERF_PLAN.md S5): the statements of the fast path depend on the
//! values in `where` only through bound parameters for most queries, so they are built once per
//! query shape and the values are bound per call.
//!
//! The shape of a call is its `payload.db` arguments with every `where` leaf value of a safe class
//! replaced by a slot (`#3:i`, the value's class). A template is built from the arguments with each
//! slot holding a sentinel of that class, then verified: every sentinel must come back unchanged as
//! a bound parameter (at most once per statement) and nowhere else (not in the SQL text, not inside
//! another parameter). A shape that fails verification (a value the builder transforms, inlines or
//! branches on) is remembered as uncacheable and always built from the real values. Values of
//! other classes (booleans, `null`, dates, numeric or unusual strings) are part of the shape.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use payload_engine::js::{JsVal, Obj, num_to_js_string};
use payload_sql_find::exec::string_to_number;
use payload_sql_find::sql::Sql;

/// A where leaf value of a class whose sentinel the builder treats like any value of the class.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
  /// A finite non-negative integer.
  Int,
  /// A finite negative integer.
  NegInt,
  /// A finite non-integer.
  Frac,
  /// A non-empty string of ASCII letters and inner single spaces (not numeric, not a date).
  Word,
}

pub fn class_of(value: &JsVal) -> Option<Class> {
  match value {
    JsVal::Num(n) if n.is_finite() && !(*n == 0.0 && n.is_sign_negative()) => Some(if n.fract() != 0.0 {
      Class::Frac
    } else if *n < 0.0 {
      Class::NegInt
    } else {
      Class::Int
    }),
    JsVal::Str(s)
      if !s.is_empty()
        && s.len() <= 200
        && s.bytes().all(|b| b.is_ascii_alphabetic() || b == b' ')
        && !s.starts_with(' ')
        && !s.ends_with(' ')
        && !s.contains("  ")
        && string_to_number(s).is_nan()
        // words the query builder gives a meaning (`'null'`, `'true'` / `'false'`, ...)
        && !["null", "true", "false", "undefined", "nan", "infinity"].iter().any(|w| s.eq_ignore_ascii_case(w)) =>
    {
      Some(Class::Word)
    }
    _ => None,
  }
}

/// The sentinel of slot `slot` of `class`.
pub fn sentinel(class: Class, slot: usize) -> JsVal {
  let n = slot as f64;
  match class {
    Class::Int => JsVal::Num(1_000_003_017.0 + n * 7919.0),
    Class::NegInt => JsVal::Num(-(1_000_003_017.0 + n * 7919.0)),
    Class::Frac => JsVal::Num(0.718_281_828_459 + n),
    Class::Word => {
      let mut s = String::from("qzxwfuse");
      let mut k = slot;
      loop {
        s.push((b'a' + (k % 26) as u8) as char);
        k /= 26;
        if k == 0 {
          break;
        }
      }
      s.push_str("zq");
      JsVal::str(s)
    }
  }
}

/// The shape key of `args` and the slot values, with the sentinel arguments to build a template
/// from. Only `args.where` is abstracted.
pub struct Shaped {
  pub key: String,
  pub values: Vec<JsVal>,
  pub sentinel_args: JsVal,
}

pub fn shape(args: &JsVal, prefix: &str) -> Option<Shaped> {
  let JsVal::Obj(props) = args else { return None };
  let mut key = String::with_capacity(256);
  key.push_str(prefix);
  let mut values = Vec::new();
  let mut sentinel_props = Obj::with_capacity(props.len());
  for (k, v) in props.iter() {
    key.push('|');
    key.push_str(k);
    key.push('=');
    if k == "where" {
      let sentinel_where = abstract_value(v, &mut key, &mut values)?;
      sentinel_props.insert(k.clone(), sentinel_where);
    } else {
      literal(v, &mut key, 0)?;
      sentinel_props.insert(k.clone(), v.clone());
    }
  }
  Some(Shaped { key, values, sentinel_args: JsVal::obj(sentinel_props) })
}

/// Writes `value` into the key; leaves of a [`Class`] become slots (and sentinels in the copy).
fn abstract_value(value: &JsVal, key: &mut String, values: &mut Vec<JsVal>) -> Option<JsVal> {
  if let Some(class) = class_of(value) {
    let slot = values.len();
    values.push(value.clone());
    key.push_str(&format!("#{slot}:{class:?}"));
    return Some(sentinel(class, slot));
  }
  match value {
    JsVal::Obj(props) if props.is_empty() && value.typed().is_some() => {
      literal(value, key, 0)?;
      Some(value.clone())
    }
    JsVal::Obj(props) => {
      key.push('{');
      let mut out = Obj::with_capacity(props.len());
      for (k, v) in props.iter() {
        write_str(k, key);
        key.push(':');
        out.insert(k.clone(), abstract_value(v, key, values)?);
        key.push(',');
      }
      key.push('}');
      Some(JsVal::obj(out))
    }
    JsVal::Arr(items) => {
      key.push('[');
      let mut out = Vec::with_capacity(items.len());
      for item in items.iter() {
        out.push(abstract_value(item, key, values)?);
        key.push(',');
      }
      key.push(']');
      Some(JsVal::arr(out))
    }
    other => {
      literal(other, key, 0)?;
      Some(other.clone())
    }
  }
}

fn write_str(s: &str, key: &mut String) {
  key.push('"');
  for c in s.chars() {
    if c == '"' || c == '\\' {
      key.push('\\');
    }
    key.push(c);
  }
  key.push('"');
}

/// An exact rendering of `value` (types distinguished, own `undefined` kept).
fn literal(value: &JsVal, key: &mut String, depth: usize) -> Option<()> {
  if depth > 64 {
    return None;
  }
  match value {
    JsVal::Undefined => key.push('U'),
    JsVal::Null => key.push('N'),
    JsVal::Bool(b) => key.push(if *b { 'T' } else { 'F' }),
    JsVal::Num(n) => {
      key.push('n');
      if *n == 0.0 && n.is_sign_negative() {
        key.push_str("-0");
      } else {
        key.push_str(&num_to_js_string(*n));
      }
    }
    JsVal::Str(s) => {
      key.push('s');
      write_str(s, key);
    }
    JsVal::Fn(_) => return None,
    JsVal::Arr(items) => {
      key.push('[');
      for item in items.iter() {
        literal(item, key, depth + 1)?;
        key.push(',');
      }
      key.push(']');
    }
    JsVal::Obj(props) => {
      if props.is_empty() {
        if let Some(ms) = value.as_date() {
          key.push_str("D");
          key.push_str(&num_to_js_string(ms));
          return Some(());
        }
        if value.typed().is_some() || value.bson().is_some() || value.as_host_object().is_some() {
          return None;
        }
      }
      key.push('{');
      for (k, v) in props.iter() {
        write_str(k, key);
        key.push(':');
        literal(v, key, depth + 1)?;
        key.push(',');
      }
      key.push('}');
    }
  }
  Some(())
}

/// Where the slots go in one statement: `(param index, slot)`.
pub type Slots = Vec<(usize, usize)>;

/// Finds the slots of `values.len()` sentinels in `sql`; `None` when a sentinel occurs other
/// than as one whole parameter.
pub fn locate(sql: &Sql, sentinels: &[JsVal]) -> Option<Slots> {
  let texts: Vec<String> = sentinels
    .iter()
    .map(|s| match s {
      JsVal::Str(s) => s.to_string(),
      JsVal::Num(n) => num_to_js_string(*n),
      _ => String::new(),
    })
    .collect();
  for text in &texts {
    // numbers are bound, never rendered; a word sentinel in the text was inlined
    if !text.is_empty() && sql.sql.contains(text.as_str()) {
      return None;
    }
  }
  let mut slots = Vec::new();
  let mut seen = vec![false; sentinels.len()];
  for (index, param) in sql.params.iter().enumerate() {
    if let Some(slot) = sentinels.iter().position(|s| s.strict_eq(param) && type_eq(s, param)) {
      if seen[slot] {
        return None;
      }
      seen[slot] = true;
      slots.push((index, slot));
      continue;
    }
    if let JsVal::Str(s) = param {
      if texts.iter().any(|t| !t.is_empty() && s.contains(t.as_str())) {
        return None;
      }
    }
  }
  Some(slots)
}

fn type_eq(a: &JsVal, b: &JsVal) -> bool {
  matches!((a, b), (JsVal::Num(_), JsVal::Num(_)) | (JsVal::Str(_), JsVal::Str(_)))
}

/// `sql` with the slot values bound.
pub fn bind(sql: &Sql, slots: &Slots, values: &[JsVal]) -> Sql {
  let mut out = sql.clone();
  for &(index, slot) in slots {
    out.params[index] = values[slot].clone();
  }
  out
}

/// A bounded cache of `T` by shape key (`None`: the shape is uncacheable).
pub struct Cache<T> {
  entries: Mutex<HashMap<String, Option<Arc<T>>>>,
}

const MAX_ENTRIES: usize = 2048;

impl<T> Cache<T> {
  pub fn new() -> Self {
    Self { entries: Mutex::new(HashMap::new()) }
  }

  pub fn get(&self, key: &str) -> Option<Option<Arc<T>>> {
    self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned()
  }

  pub fn insert(&self, key: String, value: Option<Arc<T>>) {
    let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
    if entries.len() >= MAX_ENTRIES {
      entries.clear();
    }
    entries.insert(key, value);
  }
}

/// A process-wide cache.
pub fn global<T: Send + Sync + 'static>(cell: &'static OnceLock<Cache<T>>) -> &'static Cache<T> {
  cell.get_or_init(Cache::new)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn classes() {
    assert_eq!(class_of(&JsVal::Num(1000.0)), Some(Class::Int));
    assert_eq!(class_of(&JsVal::Num(-3.0)), Some(Class::NegInt));
    assert_eq!(class_of(&JsVal::Num(0.5)), Some(Class::Frac));
    assert_eq!(class_of(&JsVal::Num(-0.0)), None);
    assert_eq!(class_of(&JsVal::Num(f64::NAN)), None);
    assert_eq!(class_of(&JsVal::str("hotel kilo")), Some(Class::Word));
    assert_eq!(class_of(&JsVal::str("post-1")), None);
    assert_eq!(class_of(&JsVal::str("Infinity")), None);
    assert_eq!(class_of(&JsVal::str(" a")), None);
    assert_eq!(class_of(&JsVal::str("")), None);
    assert_eq!(class_of(&JsVal::str("True")), None);
    assert_eq!(class_of(&JsVal::str("null")), None);
    for slot in 0..100 {
      assert_eq!(class_of(&sentinel(Class::Word, slot)), Some(Class::Word));
      assert_eq!(class_of(&sentinel(Class::Int, slot)), Some(Class::Int));
      assert_eq!(class_of(&sentinel(Class::Frac, slot)), Some(Class::Frac));
      assert_eq!(class_of(&sentinel(Class::NegInt, slot)), Some(Class::NegInt));
    }
  }
}
