//! `utilities/buildProjectionFromSelect.ts` on live objects (payload's `deepCopyObjectSimple` /
//! `getSelectMode` on the caller's `select`, `adapter.payload` read where the TS reads it).

use payload_core_runtime::js::{self, JsResult, Local, Type};

use crate::host::{
  Units, call, concat, for_of, get, get_k, host, is_string, object_named, replace_locale, set_k, str_is, string, template,
  typeof_object, units,
};

/// `addFieldToProjection({ adapter, databaseSchemaPath, field, parentIsLocalized, projection })`
fn add_field_to_projection(
  adapter: Local,
  database_schema_path: &[u16],
  field: Local,
  parent_is_localized: Local,
  projection: Local,
) -> JsResult<()> {
  let config = get(get(adapter, "payload")?, "config")?;

  if js::truthy(parent_is_localized) && js::truthy(get(config, "localization")?) {
    let locale_codes = get(get(config, "localization")?, "localeCodes")?;
    let path = string(database_schema_path);
    for_of(locale_codes, |locale| {
      let locale_path = replace_locale(path, locale)?;
      let key = concat(&[&template(locale_path)?, &template(get(field, "name")?)?]);
      set_k(projection, string(&key), js::boolean(true))?;
      Ok(None::<()>)
    })?;
  } else {
    let key = concat(&[database_schema_path, &template(get(field, "name")?)?]);
    set_k(projection, string(&key), js::boolean(true))?;
  }
  Ok(())
}

struct Traverse<'a> {
  adapter: Local,
  database_schema_path: &'a [u16],
  fields: Local,
  /// `parentIsLocalized = false` applied
  parent_is_localized: Local,
  projection: Local,
  select: Local,
  select_all_on_current_level: bool,
  /// `'include'` / `'exclude'` (or whatever `getSelectMode` returned)
  select_mode: Local,
}

/// `parentIsLocalized = false` default of a destructured parameter.
fn default_false(v: Local) -> Local {
  if js::type_of(v) == Type::Undefined { js::boolean(false) } else { v }
}

/// `parentIsLocalized || field.localized`
fn or_localized(parent_is_localized: Local, field: Local) -> JsResult<Local> {
  if js::truthy(parent_is_localized) { Ok(parent_is_localized) } else { get(field, "localized") }
}

fn traverse_fields(t: &Traverse) -> JsResult<()> {
  let h = host()?;
  let include = str_is(t.select_mode, "include");
  let exclude = str_is(t.select_mode, "exclude");
  for_of(t.fields, |field| {
    if js::truthy(call(&h.field_affects_data, &[field])?) {
      if include {
        if is_true(get_k(t.select, get(field, "name")?)?) || t.select_all_on_current_level {
          add_field_to_projection(t.adapter, t.database_schema_path, field, t.parent_is_localized, t.projection)?;
          return Ok(None::<()>);
        }

        if !js::truthy(get_k(t.select, get(field, "name")?)?) {
          return Ok(None);
        }
      }

      if exclude {
        if js::type_of(get_k(t.select, get(field, "name")?)?) == Type::Undefined {
          add_field_to_projection(t.adapter, t.database_schema_path, field, t.parent_is_localized, t.projection)?;
          return Ok(None);
        }

        if is_false(get_k(t.select, get(field, "name")?)?) {
          return Ok(None);
        }
      }
    }

    let mut field_database_schema_path: Units = t.database_schema_path.to_vec();

    if js::truthy(call(&h.field_affects_data, &[field])?) {
      field_database_schema_path = concat(&[t.database_schema_path, &template(get(field, "name")?)?, &units(".")]);

      if js::truthy(call(&h.field_should_be_localized, &[field, t.parent_is_localized])?) {
        field_database_schema_path = concat(&[&field_database_schema_path, &units("<locale>.")]);
      }
    }

    let field_type = get(field, "type")?;
    if str_is(field_type, "array") || str_is(field_type, "group") || str_is(field_type, "tab") {
      let field_select = get_k(t.select, get(field, "name")?)?;

      if str_is(get(field, "type")?, "array") && include {
        crate::host::set(field_select, "id", js::boolean(true))?;
      }

      traverse_fields(&Traverse {
        adapter: t.adapter,
        database_schema_path: &field_database_schema_path,
        fields: get(field, "flattenedFields")?,
        parent_is_localized: default_false(or_localized(t.parent_is_localized, field)?),
        projection: t.projection,
        select: field_select,
        select_all_on_current_level: false,
        select_mode: t.select_mode,
      })?;
    } else if str_is(field_type, "blocks") {
      let blocks_select = get_k(t.select, get(field, "name")?)?;

      for_of(get(field, "blocks")?, |block_ref| {
        let block = if is_string(block_ref) {
          get_k(get(get(t.adapter, "payload")?, "blocks")?, block_ref)?
        } else {
          block_ref
        };

        if !js::truthy(block) {
          return Ok(None::<()>);
        }

        let slug = || get(block, "slug");
        if (include && is_true(get_k(blocks_select, slug()?)?))
          || (exclude && js::type_of(get_k(blocks_select, slug()?)?) == Type::Undefined)
        {
          traverse_fields(&Traverse {
            adapter: t.adapter,
            database_schema_path: &field_database_schema_path,
            fields: get(block, "flattenedFields")?,
            parent_is_localized: default_false(or_localized(t.parent_is_localized, field)?),
            projection: t.projection,
            select: js::object(),
            select_all_on_current_level: true,
            select_mode: js::string("include"),
          })?;
          return Ok(None);
        }

        let mut block_select_mode = t.select_mode;

        if exclude && is_false(get_k(blocks_select, slug()?)?) {
          block_select_mode = js::string("include");
        }

        if !typeof_object(get_k(blocks_select, slug()?)?) {
          set_k(blocks_select, slug()?, js::object())?;
        }

        if str_is(block_select_mode, "include") && typeof_object(get_k(blocks_select, slug()?)?) {
          let block_select = get_k(blocks_select, slug()?)?;
          crate::host::set(block_select, "id", js::boolean(true))?;
          crate::host::set(block_select, "blockType", js::boolean(true))?;
        }

        traverse_fields(&Traverse {
          adapter: t.adapter,
          database_schema_path: &field_database_schema_path,
          fields: get(block, "flattenedFields")?,
          parent_is_localized: default_false(or_localized(t.parent_is_localized, field)?),
          projection: t.projection,
          select: get_k(blocks_select, slug()?)?,
          select_all_on_current_level: false,
          select_mode: block_select_mode,
        })?;
        Ok(None)
      })?;
    } else if str_is(field_type, "relationship") || str_is(field_type, "upload") {
      // When a relationship/upload field is selected with nested fields (for population), we still
      // need to include the raw field value in the projection so that population can work.
      add_field_to_projection(t.adapter, t.database_schema_path, field, t.parent_is_localized, t.projection)?;
    }

    Ok(None)
  })?;
  Ok(())
}

fn is_true(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && js::get_bool(v)
}

fn is_false(v: Local) -> bool {
  js::type_of(v) == Type::Boolean && !js::get_bool(v)
}

/// `buildProjectionFromSelect(args)` export.
pub fn build_projection_from_select_entry(args: Local) -> JsResult<Local> {
  let d = call(&host()?.projection_args, &[args])?;
  build_projection_from_select(js::get_element(d, 0)?, js::get_element(d, 1)?, js::get_element(d, 2)?)
}

/// `buildProjectionFromSelect({ adapter, fields, select })`
pub fn build_projection_from_select(adapter: Local, fields: Local, select: Local) -> JsResult<Local> {
  let h = host()?;
  if !js::truthy(select) {
    return Ok(js::undefined());
  }

  let projection = object_named(&[("_id", js::boolean(true))])?;

  let copied = call(&h.deep_copy_object_simple, &[select])?;
  let select_mode = call(&h.get_select_mode, &[select])?;
  traverse_fields(&Traverse {
    adapter,
    database_schema_path: &[],
    fields,
    parent_is_localized: js::boolean(false),
    projection,
    select: copied,
    select_all_on_current_level: false,
    select_mode,
  })?;

  Ok(projection)
}
