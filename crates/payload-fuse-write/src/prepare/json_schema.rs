//! A json field's `jsonSchema` check: zod's `safeParse` of the schema that `fromJSONSchema` makes of
//! `jsonSchema.schema` (payload `validateJSONSchema`), on the nodes the write plan converts the
//! schema into (writePlan.ts `jsonSchemaNode`, a port of zod's conversion for the keywords it
//! models; FUSED_WRITES.md section 12.6):
//!
//! `any`, `never`, `lit` (`v`: `z.literal` / `z.enum` / their union, `Set#has` membership),
//! `union` (`o`), `str` (`min` / `max`: the length in code points, as zod's `codePointLength`), `num` (`int`: `.int()`, a safe
//! integer; `gte` / `lte` / `gt` / `lt`), `bool`, `null`, `obj` (`p`: `{ n: key, s: node, r: required }`,
//! `x`: `"strict"`, `"pass"` or the catchall node), `arr` (`e`, `min` / `max`).
//!
//! Only what zod accepts is valid. A value zod rejects, or one the check does not decide here
//! (`undefined` values, typed values such as a `Date`, an absent required key), is a bail: the
//! exact lane builds upstream's message.

use payload_engine::js::JsVal;

/// `Ok(true)`: zod accepts `value`; `Ok(false)`: it rejects it; `Err`: not decided here.
pub fn accepts(node: &JsVal, value: &JsVal) -> Result<bool, &'static str> {
  if value.typed().is_some() || value.bson().is_some() || value.as_host_object().is_some() || value.is_fn() {
    return Err("value");
  }
  if value.is_undefined() {
    return Err("undefined");
  }
  let bound = |key: &str| node.get(key).as_num();
  Ok(match node.get("k").as_str().ok_or("node")? {
    "any" => true,
    "never" => false,
    "lit" => is_literal(node.get("v").as_arr().ok_or("node")?, value),
    "union" => {
      let mut undecided = None;
      for option in node.get("o").as_arr().ok_or("node")? {
        match accepts(option, value) {
          Ok(true) => return Ok(true),
          Ok(false) => {}
          Err(reason) => undecided = Some(reason),
        }
      }
      return undecided.map_or(Ok(false), Err);
    }
    "str" => match value.as_str() {
      Some(s) => {
        let length = s.chars().count() as f64;
        bound("min").is_none_or(|min| length >= min) && bound("max").is_none_or(|max| length <= max)
      }
      None => false,
    },
    "num" => match value.as_num() {
      Some(n) if n.is_finite() => {
        (!node.get("int").truthy() || (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0))
          && bound("gte").is_none_or(|b| n >= b)
          && bound("lte").is_none_or(|b| n <= b)
          && bound("gt").is_none_or(|b| n > b)
          && bound("lt").is_none_or(|b| n < b)
      }
      _ => false,
    },
    "bool" => matches!(value, JsVal::Bool(_)),
    "null" => value.is_null(),
    "obj" => {
      let Some(object) = value.as_obj() else {
        return Ok(false);
      };
      if object.contains_key("__proto__") {
        return Err("__proto__");
      }
      let shape = node.get("p").as_arr().ok_or("node")?;
      let mut is_valid = true;
      for entry in shape {
        let key = entry.get("n").as_str().ok_or("node")?;
        match object.get(key) {
          Some(property) => is_valid &= accepts(entry.get("s"), property)?,
          // an absent required key: whether its schema takes `undefined` (`.default()`, `z.any()`)
          None if entry.get("r").truthy() => return Err("required"),
          None => {}
        }
      }
      let rest = node.get("x");
      for (key, property) in object {
        if shape.iter().any(|entry| entry.get("n").as_str() == Some(key)) {
          continue;
        }
        match rest.as_str() {
          Some("pass") => {}
          Some("strict") => is_valid = false,
          Some(_) => return Err("node"),
          None => is_valid &= accepts(rest, property)?,
        }
      }
      is_valid
    }
    "arr" => match value.as_arr() {
      Some(items) => {
        let mut is_valid = true;
        for item in items {
          is_valid &= accepts(node.get("e"), item)?;
        }
        let length = items.len() as f64;
        is_valid && bound("min").is_none_or(|min| length >= min) && bound("max").is_none_or(|max| length <= max)
      }
      None => false,
    },
    _ => return Err("node"),
  })
}

/// `Set#has` (SameValueZero) over the literal values (JSON primitives).
fn is_literal(values: &[JsVal], value: &JsVal) -> bool {
  values.iter().any(|literal| match (literal, value) {
    (JsVal::Num(a), JsVal::Num(b)) => a == b || (a.is_nan() && b.is_nan()),
    (JsVal::Str(a), JsVal::Str(b)) => a == b,
    (JsVal::Bool(a), JsVal::Bool(b)) => a == b,
    (JsVal::Null, JsVal::Null) => true,
    _ => false,
  })
}

#[cfg(test)]
mod tests {
  use super::accepts;
  use payload_engine::js::JsVal;

  fn js(text: &str) -> JsVal {
    JsVal::from_json(&serde_json::from_str(text).unwrap())
  }

  /// test/fields' `json-fields` schema, as writePlan.ts converts it.
  const FIELDS_SCHEMA: &str = r#"{"k":"obj","x":"pass","p":[
    {"n":"array","s":{"k":"arr","e":{"k":"obj","x":"strict","p":[
      {"n":"object","s":{"k":"obj","x":"strict","p":[{"n":"array","s":{"k":"arr","e":{"k":"num"}}},{"n":"text","s":{"k":"str"}}]}},
      {"n":"text","s":{"k":"str"}}]}}},
    {"n":"foo","s":{"k":"lit","v":["bar","foobar"]}},
    {"n":"number","s":{"k":"lit","v":[10,5]}}]}"#;

  #[test]
  fn decides_like_zod() {
    let node = js(FIELDS_SCHEMA);
    assert_eq!(accepts(&node, &js(r#"{"foo":"bar"}"#)), Ok(true));
    assert_eq!(accepts(&node, &js(r#"{"foo":"bad"}"#)), Ok(false));
    assert_eq!(accepts(&node, &js(r#"{"baz":"bar","number":10}"#)), Ok(true));
    assert_eq!(accepts(&node, &js(r#"{"number":-0}"#)), Ok(false));
    assert_eq!(accepts(&node, &js(r#"{"array":[{"text":"a","object":{"array":[1,2.5]}}]}"#)), Ok(true));
    assert_eq!(accepts(&node, &js(r#"{"array":[{"other":1}]}"#)), Ok(false));
    assert_eq!(accepts(&node, &js(r#"[1]"#)), Ok(false));
    assert_eq!(accepts(&node, &js(r#""text""#)), Ok(false));
    assert_eq!(accepts(&js(r#"{"k":"str","min":2,"max":2}"#), &js(r#""😀""#)), Ok(false));
    assert_eq!(accepts(&js(r#"{"k":"str","min":1,"max":1}"#), &js(r#""😀""#)), Ok(true));
    let ints = js(r#"{"k":"num","int":true,"gt":0}"#);
    assert_eq!(accepts(&ints, &js("1")), Ok(true));
    assert_eq!(accepts(&ints, &js("1.5")), Ok(false));
    assert_eq!(accepts(&ints, &js("9007199254740992")), Ok(false));
    let required = js(r#"{"k":"obj","x":"pass","p":[{"n":"a","s":{"k":"any"},"r":1}]}"#);
    assert_eq!(accepts(&required, &js("{}")), Err("required"));
  }
}
