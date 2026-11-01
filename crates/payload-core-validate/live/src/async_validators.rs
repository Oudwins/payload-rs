//! The `async` validators of `validations.ts` (json, richText, validateBlocksFilterOptions,
//! blocks, upload / relationship with validateFilterOptions, select). Each TS async function is
//! a task on the core runtime executor ([`spawn`]) that awaits ([`await_js`]) exactly where the
//! TS awaits; values are read from the live objects after every await.

use std::cell::RefCell;

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Type, Val};

use crate::ops::{
  ForOf, arg, array, call, call_method, eq_num, eq_str, for_of, get, get_computed, get_opt, gt, is_array, is_false,
  is_nullish, is_true, is_type, is_typeof_object, len, lt, object, object_id_hex, object_id_is_valid, prefix, push,
  same_value_zero, set_computed, strict_eq, string, t, truthy, val, with_callback,
};
use crate::validators::{destructure, option_matches, validate_array_length};
use crate::vhost;

fn yes() -> Local {
  js::boolean(true)
}

fn done(v: Local) -> JsResult<Val> {
  Val::from_local(v)
}

/// `{ ...fields }` destructured into `N` bindings (Vals, kept across awaits).
fn bindings<const N: usize>(a: Local) -> JsResult<[Val; N]> {
  let mut out: [Val; N] = std::array::from_fn(|_| Val::Undefined);
  for (i, slot) in out.iter_mut().enumerate() {
    *slot = val(arg(a, i as u32)?)?;
  }
  Ok(out)
}

pub fn json(value: Local, options: Local) -> JsResult<Local> {
  let (value, options) = (val(value)?, val(options)?);
  spawn(async move {
    let h = vhost()?;
    let value = value.get();
    let a = destructure(&h.args.json, value, options.get())?;
    let [json_error, json_schema, t_fn, required] = [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?];

    if truthy(required) && !truthy(value) {
      return done(t(t_fn, "validation:required", None)?);
    }

    if !is_type(json_error, Type::Undefined) {
      return done(t(t_fn, "validation:invalidInput", None)?);
    }

    if truthy(json_schema) && is_not_empty(value)? {
      return done(js::call(h.validate_json_schema.get(), js::undefined(), &[json_schema, value])?);
    }
    done(yes())
  })
}

/// `isNotEmpty(value)` of `json`.
fn is_not_empty(value: Local) -> JsResult<bool> {
  if is_nullish(value) {
    return Ok(false);
  }
  if is_array(value)? && eq_num(get(value, "length")?, 0.0) {
    return Ok(false);
  }
  if is_typeof_object(value)
    && eq_num(js::call(vhost()?.object_keys_length.get(), js::undefined(), &[value])?, 0.0)
  {
    return Ok(false);
  }
  Ok(true)
}

pub fn rich_text(value: Local, options: Local) -> JsResult<Local> {
  let (value, options) = (val(value)?, val(options)?);
  spawn(async move {
    let (value, options) = (value.get(), options.get());
    if !truthy(get_opt(options, "editor")?) {
      return Err(crate::ops::error("richText field has no editor property."));
    }
    if is_type(get_opt(options, "editor")?, Type::Function) {
      return Err(crate::ops::error("Attempted to access unsanitized rich text editor."));
    }

    let editor = get_opt(options, "editor")?;

    done(call_method(editor, "validate", &[value, options], "editor")?)
  })
}

/// `validateBlocksFilterOptions({ id, data, filterOptions, req, siblingData, value })` (exported).
pub fn validate_blocks_filter_options(args: Local) -> JsResult<Local> {
  let args = val(args)?;
  spawn(async move {
    let a = js::call(vhost()?.args.validate_blocks_filter_options.get(), js::undefined(), &[args.get()])?;
    let [id, data, filter_options, req, sibling_data, value] = bindings::<6>(a)?;
    blocks_filter_options(id, data, filter_options, req, sibling_data, value).await
  })
}

/// The body of `validateBlocksFilterOptions`; resolves to `{ allBlockSlugs, allowedBlockSlugs, invalidBlockSlugs }`.
async fn blocks_filter_options(
  id: Val,
  data: Val,
  filter_options: Val,
  req: Val,
  sibling_data: Val,
  value: Val,
) -> JsResult<Val> {
  let all_block_slugs = {
    let value = value.get();
    val(if is_array(value)? {
      let block_type = |args: &[Local]| get(args[0], "blockType");
      let mapped = with_callback(&block_type, |cb| call_method(value, "map", &[cb], "value"))?;
      let is_slug = |args: &[Local]| Ok(js::boolean(truthy(args[0])));
      with_callback(&is_slug, |cb| call_method(mapped, "filter", &[cb], "value.map(...)"))?
    } else {
      array(&[])?
    })?
  };

  // if undefined => all blocks allowed
  let mut allowed_block_slugs = Val::Undefined;

  if is_type(filter_options.get(), Type::Function) {
    let result = {
      let req = req.get();
      let user = get(req, "user")?;
      let filter_args = object(&[
        ("id", id.get()),
        ("data", data.get()),
        ("req", req),
        ("siblingData", sibling_data.get()),
        ("user", user),
      ])?;
      js::call(filter_options.get(), js::undefined(), &[filter_args])?
    };
    let result = await_js(result).await?;
    if !is_true(result.get()) && is_array(result.get())? {
      allowed_block_slugs = result;
    }
  } else if is_array(filter_options.get())? {
    allowed_block_slugs = filter_options;
  }

  let invalid_block_slugs = array(&[])?;
  let allowed = allowed_block_slugs.get();
  if truthy(allowed) {
    for_of(all_block_slugs.get(), &|block_slug| {
      if !truthy(call_method(allowed, "includes", &[block_slug], "allowedBlockSlugs")?) {
        push(invalid_block_slugs, block_slug)?;
      }
      Ok(None)
    })?;
  }

  done(object(&[
    ("allBlockSlugs", all_block_slugs.get()),
    ("allowedBlockSlugs", allowed),
    ("invalidBlockSlugs", invalid_block_slugs),
  ])?)
}

pub fn blocks(value: Local, options: Local) -> JsResult<Local> {
  let (value, options) = (val(value)?, val(options)?);
  spawn(async move {
    let a = destructure(&vhost()?.args.blocks, value.get(), options.get())?;
    let [id, data, filter_options, max_rows, min_rows, req, t_fn, required, sibling_data] = bindings::<9>(a)?;

    let length_validation_result =
      validate_array_length(value.get(), max_rows.get(), min_rows.get(), required.get(), t_fn.get())?;
    if is_type(length_validation_result, Type::String) {
      return done(length_validation_result);
    }

    if truthy(filter_options.get()) {
      let promise = spawn(blocks_filter_options(id, data, filter_options, req, sibling_data, value))?;
      let result = await_js(promise).await?;
      let invalid_block_slugs = get(result.get(), "invalidBlockSlugs")?;
      if truthy(get_opt(invalid_block_slugs, "length")?) {
        let blocks =
          js::call(vhost()?.join.get(), js::undefined(), &[invalid_block_slugs, js::string(", ")])?;
        return done(t(t_fn.get(), "validation:invalidBlocks", Some(object(&[("blocks", blocks)])?))?);
      }
    }

    done(yes())
  })
}

/// `isValidID(value, type)` (`payload/src/utilities/isValidID.ts`)
fn is_valid_id(value: Local, id_type: Local) -> JsResult<bool> {
  if eq_str(id_type, "text") && truthy(value) {
    if matches!(js::type_of(value), Type::Object | Type::Null | Type::External | Type::String) {
      let is_object_id = object_id_is_valid(value)?;
      return Ok(is_type(value, Type::String) || is_object_id);
    }
    return Ok(false);
  }

  if eq_str(id_type, "number") && is_type(value, Type::Number) && !js::get_f64(value).is_nan() {
    return Ok(true);
  }

  if eq_str(id_type, "ObjectID") {
    return object_id_is_valid(string(value)?);
  }

  Ok(false)
}

/// `upload` and `relationship` (identical bodies).
pub fn relationship(value: Local, options: Local) -> JsResult<Local> {
  let (value, options) = (val(value)?, val(options)?);
  spawn(async move {
    {
      let h = vhost()?;
      let (value, options_l) = (value.get(), options.get());
      let a = destructure(&h.args.relationship, value, options_l)?;
      let [event, max_rows, min_rows, relation_to, payload, t_fn, required] =
        [arg(a, 0)?, arg(a, 1)?, arg(a, 2)?, arg(a, 3)?, arg(a, 4)?, arg(a, 5)?, arg(a, 6)?];

      if ((!truthy(value) && !is_type(value, Type::Number))
        || (is_array(value)? && eq_num(get(value, "length")?, 0.0)))
        && truthy(required)
      {
        return done(t(t_fn, "validation:required", None)?);
      }

      if is_array(value)? && gt(get(value, "length")?, js::number(0.0))? {
        if truthy(min_rows) && lt(get(value, "length")?, min_rows)? {
          let label = t(t_fn, "general:rows", None)?;
          let vars = object(&[("label", label), ("min", min_rows), ("value", get(value, "length")?)])?;
          return done(t(t_fn, "validation:lessThanMin", Some(vars))?);
        }

        if truthy(max_rows) && gt(get(value, "length")?, max_rows)? {
          let label = t(t_fn, "general:rows", None)?;
          let vars = object(&[("label", label), ("max", max_rows), ("value", get(value, "length")?)])?;
          return done(t(t_fn, "validation:greaterThanMax", Some(vars))?);
        }
      }

      if !is_nullish(value) {
        let values = if is_array(value)? { value } else { array(&[value])? };

        let is_invalid = |args: &[Local]| -> JsResult<Local> {
          let val = args[0];
          let mut collection_slug = js::undefined();
          let mut requested_id = js::undefined();

          if is_type(relation_to, Type::String) {
            collection_slug = relation_to;

            // custom id
            if truthy(val) || is_type(val, Type::Number) {
              requested_id = val;
            }
          }

          if is_array(relation_to)? && is_typeof_object(val) && truthy(get_opt(val, "relationTo")?) {
            collection_slug = get(val, "relationTo")?;
            requested_id = get(val, "value")?;
          }

          if is_type(requested_id, Type::Null) {
            return Ok(js::boolean(false));
          }

          let mut id_type = get_opt(get_computed(get(payload, "collections")?, collection_slug)?, "customIDType")?;
          if !truthy(id_type) {
            id_type = get_opt(get_opt(payload, "db")?, "defaultIDType")?;
          }
          if !truthy(id_type) {
            id_type = js::string("text");
          }

          Ok(js::boolean(!is_valid_id(requested_id, id_type)?))
        };
        let invalid_relationships = with_callback(&is_invalid, |cb| call_method(values, "filter", &[cb], "values"))?;

        if gt(get(invalid_relationships, "length")?, js::number(0.0))? {
          return done(js::call(
            h.invalid_relationships_message.get(),
            js::undefined(),
            &[invalid_relationships],
          )?);
        }
      }

      if eq_str(event, "onChange") {
        return done(yes());
      }
    }

    done(spawn(validate_filter_options(value, options))?)
  })
}

/// `validateFilterOptions(value, options)` (upload / relationship).
async fn validate_filter_options(value: Val, options: Val) -> JsResult<Val> {
  let a = destructure(&vhost()?.args.validate_filter_options, value.get(), options.get())?;
  let [id, block_data, data, filter_options, override_access, relation_to, req, t_fn, user, sibling_data] =
    bindings::<10>(a)?;

  if is_type(filter_options.get(), Type::Undefined) || !truthy(value.get()) {
    return done(yes());
  }

  let options = val(js::object())?;
  let false_collections: RefCell<Vec<Val>> = RefCell::new(Vec::new());
  let collections = {
    let relation_to = relation_to.get();
    ForOf::new(if !is_array(relation_to)? { array(&[relation_to])? } else { relation_to })?
  };
  let values = {
    let value = value.get();
    val(if is_array(value)? { value } else { array(&[value])? })?
  };

  loop {
    let Some(collection) = collections.step()? else { break };
    let collection = val(collection)?;

    let attempt: JsResult<()> = async {
      let mut option_filter = if is_type(filter_options.get(), Type::Function) {
        let pending = {
          let filter_args = object(&[
            ("id", id.get()),
            ("blockData", block_data.get()),
            ("data", data.get()),
            ("relationTo", collection.get()),
            ("req", req.get()),
            ("siblingData", sibling_data.get()),
            ("user", user.get()),
          ])?;
          js::call(filter_options.get(), js::undefined(), &[filter_args])?
        };
        await_js(pending).await?
      } else {
        filter_options.clone()
      };

      if is_true(option_filter.get()) {
        option_filter = Val::Null;
      }

      let pending = {
        let value_ids = array(&[])?;

        let collect = |args: &[Local]| -> JsResult<Local> {
          let val = args[0];
          if is_typeof_object(val) {
            if truthy(get_opt(val, "value")?) {
              push(value_ids, get(val, "value")?)?;
            } else if object_id_is_valid(val)? {
              push(value_ids, object_id_hex(val)?)?;
            }
          }

          if is_type(val, Type::String) || is_type(val, Type::Number) {
            push(value_ids, val)?;
          }
          Ok(js::undefined())
        };
        with_callback(&collect, |cb| call_method(values.get(), "forEach", &[cb], "values"))?;

        if len(value_ids) > 0 {
          let and = array(&[object(&[("id", object(&[("in", value_ids)])?)])?])?;
          let find_where = object(&[("and", and)])?;

          let option_filter = option_filter.get();
          if truthy(option_filter) && !is_true(option_filter) {
            push(and, option_filter)?;
          }

          if is_false(option_filter) {
            false_collections.borrow_mut().push(collection.clone());
          }

          let req = req.get();
          let loader = get(req, "payloadDataLoader")?;
          let find = get(loader, "find")?;
          let override_access = override_access.get();
          let find_args = object(&[
            ("collection", collection.get()),
            ("depth", js::number(0.0)),
            ("disableErrors", js::boolean(true)),
            ("limit", js::number(0.0)),
            ("overrideAccess", if is_nullish(override_access) { js::boolean(false) } else { override_access }),
            ("pagination", js::boolean(false)),
            ("req", req),
            ("where", find_where),
          ])?;
          Some(val(call(find, loader, &[find_args], "req.payloadDataLoader.find")?)?)
        } else {
          None
        }
      };

      match pending {
        Some(pending) => {
          let result = await_js(pending.get()).await?;
          let doc_id = |args: &[Local]| get(args[0], "id");
          let docs = get(result.get(), "docs")?;
          let ids = with_callback(&doc_id, |cb| call_method(docs, "map", &[cb], "result.docs"))?;
          set_computed(options.get(), collection.get(), ids)?;
        }
        None => set_computed(options.get(), collection.get(), array(&[])?)?,
      }
      Ok(())
    }
    .await;

    if let Err(Thrown(err)) = attempt {
      let req = req.get();
      let logger = get(get(req, "payload")?, "logger")?;
      let log_error = get(logger, "error")?;
      let msg = prefix("Error validating filter options for collection ", collection.get())?;
      let log_args = object(&[("err", err.get()), ("msg", msg)])?;
      call(log_error, logger, &[log_args], "req.payload.logger.error")?;
      set_computed(options.get(), collection.get(), array(&[])?)?;
    }
  }

  let relation_to = relation_to.get();
  let options = options.get();
  let false_collections = false_collections.into_inner();
  let is_invalid = |args: &[Local]| -> JsResult<Local> {
    let val = args[0];
    let mut collection = js::undefined();
    let mut requested_id = js::undefined();

    if is_type(relation_to, Type::String) {
      collection = relation_to;

      if is_type(val, Type::String) || is_type(val, Type::Number) {
        requested_id = val;
      }

      if is_typeof_object(val) && object_id_is_valid(val)? {
        requested_id = object_id_hex(val)?;
      }
    }

    if is_array(relation_to)? && is_typeof_object(val) && truthy(get_opt(val, "relationTo")?) {
      collection = get(val, "relationTo")?;
      requested_id = get(val, "value")?;
    }

    // falseCollections.find((slug) => relationTo === slug)
    if false_collections.iter().find(|slug| strict_eq(relation_to, slug.get())).is_some_and(|slug| truthy(slug.get())) {
      return Ok(js::boolean(true));
    }

    if !truthy(get_computed(options, collection)?) {
      return Ok(js::boolean(true));
    }

    let index = call_method(get_computed(options, collection)?, "indexOf", &[requested_id], "options[collection]")?;
    Ok(js::boolean(eq_num(index, -1.0)))
  };
  let invalid_relationships = with_callback(&is_invalid, |cb| call_method(values.get(), "filter", &[cb], "values"))?;

  if gt(get(invalid_relationships, "length")?, js::number(0.0))? {
    return done(js::call(
      vhost()?.invalid_selections_message.get(),
      js::undefined(),
      &[invalid_relationships, t_fn.get()],
    )?);
  }

  done(yes())
}

pub fn select(value: Local, options: Local) -> JsResult<Local> {
  let (value, options) = (val(value)?, val(options)?);
  spawn(async move {
    let a = destructure(&vhost()?.args.select, value.get(), options.get())?;
    let [data, filter_options, has_many, field_options, req, t_fn, required, sibling_data] = bindings::<8>(a)?;

    let filtered_options = if is_type(filter_options.get(), Type::Function) {
      let pending = {
        let filter_args = object(&[
          ("data", data.get()),
          ("options", field_options.get()),
          ("req", req.get()),
          ("siblingData", sibling_data.get()),
        ])?;
        js::call(filter_options.get(), js::undefined(), &[filter_args])?
      };
      await_js(pending).await?
    } else {
      field_options
    };

    let (value, filtered_options, has_many, t_fn) = (value.get(), filtered_options.get(), has_many.get(), t_fn.get());

    if is_array(value)? {
      let input_is_invalid = |args: &[Local]| -> JsResult<Local> {
        let input = args[0];
        let matches = |args: &[Local]| -> JsResult<Local> {
          let option = args[0];
          Ok(js::boolean(
            strict_eq(option, input)
              || (!is_type(option, Type::String) && strict_eq(get_opt(option, "value")?, input)),
          ))
        };
        let found = with_callback(&matches, |cb| call_method(filtered_options, "some", &[cb], "filteredOptions"))?;
        Ok(js::boolean(!truthy(found)))
      };
      if truthy(with_callback(&input_is_invalid, |cb| call_method(value, "some", &[cb], "value"))?) {
        return done(t(t_fn, "validation:invalidSelection", None)?);
      }
    }

    // Check for duplicate values when hasMany is true
    if truthy(has_many) && is_array(value)? && gt(get(value, "length")?, js::number(1.0))? {
      // `new Map()` keyed by SameValueZero, insertion ordered (`-0` is stored as `+0`). Items are
      // `Val`s: a callback argument's handle dies with the callback.
      let counts: RefCell<Vec<(Val, f64)>> = RefCell::new(Vec::new());

      for_of(value, &|item| {
        let mut counts = counts.borrow_mut();
        match counts.iter_mut().find(|(key, _)| same_value_zero(key.get(), item)) {
          Some((_, count)) => *count += 1.0,
          None => {
            let key = if eq_num(item, 0.0) { js::number(0.0) } else { item };
            counts.push((val(key)?, 1.0));
          }
        }
        Ok(None)
      })?;

      let duplicates = array(&[])?;
      for (item, count) in counts.into_inner() {
        if count > 1.0 {
          // Add the item 'count' times to show all occurrences
          let mut i = 0.0;
          while i < count {
            push(duplicates, item.get())?;
            i += 1.0;
          }
        }
      }

      if len(duplicates) > 0 {
        return done(js::call(
          vhost()?.duplicates_message.get(),
          js::undefined(),
          &[duplicates, t_fn],
        )?);
      }
    }

    if is_type(value, Type::String) {
      let matches = |args: &[Local]| Ok(js::boolean(option_matches(args[0], value)?));
      if !truthy(with_callback(&matches, |cb| call_method(filtered_options, "some", &[cb], "filteredOptions"))?) {
        return done(t(t_fn, "validation:invalidSelection", None)?);
      }
    }

    if truthy(required.get())
      && (is_nullish(value)
        || (truthy(has_many) && is_array(value)? && eq_num(get_opt(value, "length")?, 0.0)))
    {
      return done(t(t_fn, "validation:required", None)?);
    }

    done(yes())
  })
}
