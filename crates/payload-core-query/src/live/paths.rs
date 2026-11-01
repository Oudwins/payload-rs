//! `database/getLocalizedPaths.ts` and `utilities/getFieldByPath.ts` on live config objects.
//!
//! Both are synchronous: they run inside the caller's synchronous segment, so they work on
//! [`Local`]s. The resulting [`PathToQuery`] entries are internal to the callers (never visible
//! to user code) and hold [`Val`]s so they survive the callers' awaits; the synthetic fields
//! (`blockType`, `globalType`, `relationTo`, `id`) are real JS objects created at the TS points.

use payload_core_runtime::js::{self, JsResult, Local, Val};

use super::host::{
  Loop, Units, call, dot, eq, get, get_named, get_optional, host, in_op, is_array, is_safe_field_path, is_string,
  join_dot, split_dot, str_eq, string, to_string, truthy, units, units_of, val,
};

/// `PathToQuery`
#[derive(Clone)]
pub struct PathToQuery {
  pub collection_slug: Val,
  pub complete: bool,
  pub field: Val,
  pub fields: Val,
  pub global_slug: Val,
  pub invalid: bool,
  pub parent_is_localized: Val,
  pub path: Units,
}

impl PathToQuery {
  /// The `PathToQuery` object literal (for the `getLocalizedPaths` export).
  pub fn to_js(&self) -> JsResult<Local> {
    call(
      &host()?.path_to_query,
      &[
        self.collection_slug.get(),
        js::boolean(self.complete),
        self.field.get(),
        self.fields.get(),
        self.global_slug.get(),
        js::boolean(self.invalid),
        self.parent_is_localized.get(),
        string(&self.path),
      ],
    )
  }
}

pub struct LocalizedPathsArgs {
  pub collection_slug: Local,
  pub fields: Local,
  pub global_slug: Local,
  /// Any JS value (a string everywhere upstream calls it).
  pub incoming_path: Local,
  pub locale: Local,
  /// `overrideAccess = false`
  pub override_access: bool,
  pub parent_is_localized: Local,
  pub payload: Local,
  /// `showHiddenFields = false`
  pub show_hidden_fields: bool,
}

/// `incomingPath.split('.')`
fn split_incoming(path: Local) -> JsResult<Vec<Units>> {
  if let Some(u) = units_of(path) {
    return Ok(split_dot(&u));
  }
  // not a string: `path.split` throws the V8 TypeError; a custom `split` is not supported
  call(&host()?.split_path, &[path])?;
  Err(js::engine_error("core query: a non-string path with its own `split` method is not supported"))
}

fn type_is(field: Local, t: &str) -> JsResult<bool> {
  Ok(str_eq(get_named(field, "type")?, t))
}

/// `field.type === 'relationship' || field.type === 'upload'` (reads `type` once or twice).
fn is_rel_or_upload(field: Local) -> JsResult<bool> {
  Ok(type_is(field, "relationship")? || type_is(field, "upload")?)
}

/// `getLocalizedPaths({ collectionSlug, fields, globalSlug, incomingPath, locale, overrideAccess,
/// parentIsLocalized, payload, showHiddenFields })`
pub fn get_localized_paths(args: &LocalizedPathsArgs) -> JsResult<Vec<PathToQuery>> {
  let h = host()?;
  let path_segments = split_incoming(args.incoming_path)?;
  let localization_config = get_named(get_named(args.payload, "config")?, "localization")?;

  let mut paths = vec![PathToQuery {
    collection_slug: val(args.collection_slug)?,
    complete: false,
    field: Val::Undefined,
    fields: val(args.fields)?,
    global_slug: val(args.global_slug)?,
    invalid: false,
    parent_is_localized: val(args.parent_is_localized)?,
    path: Units::new(),
  }];

  let mut i = 0usize;
  while i < path_segments.len() {
    let segment = &path_segments[i];
    let segment_js = string(segment);

    if let Some(idx) = paths.iter().position(|p| !p.complete) {
      let mut current_path = if paths[idx].path.is_empty() { segment.clone() } else { dot(&paths[idx].path, segment) };
      let mut parent_is_localized = args.parent_is_localized;
      let last_field = paths[idx].field.get();
      let mut matched = js::undefined();

      // lastIncompletePath?.field?.type === 'blocks'
      if str_eq(get_optional(last_field, "type")?, "blocks") {
        if eq(segment, "blockType") {
          matched = call(&h.text_field, &[js::string("blockType")])?;
        } else {
          let blocks = Loop::from_helper(&h.blocks_of, &[last_field])?;
          while let Some(block_ref) = blocks.next()? {
            let block =
              if is_string(block_ref) { get(get_named(args.payload, "blocks")?, block_ref)? } else { block_ref };
            matched = call(&h.find_in_block, &[block, segment_js])?;
            if truthy(matched) {
              break;
            }
          }
        }
      } else {
        let fields_to_search = if truthy(last_field) && in_op("flattenedFields", last_field)? {
          get_named(last_field, "flattenedFields")?
        } else {
          paths[idx].fields.get()
        };
        // parentIsLocalized || lastIncompletePath.field?.localized
        parent_is_localized =
          if truthy(args.parent_is_localized) { args.parent_is_localized } else { get_optional(last_field, "localized")? };
        matched = call(&h.find_fields_to_search, &[fields_to_search, segment_js])?;
      }

      paths[idx].field = val(matched)?;

      if eq(&current_path, "globalType") && truthy(args.global_slug) {
        let p = &mut paths[idx];
        p.path = current_path;
        p.complete = true;
        p.field = val(call(&h.text_field, &[js::string("globalType")])?)?;
        return Ok(paths);
      }

      if eq(&current_path, "relationTo") {
        paths[idx].path = current_path;
        paths[idx].complete = true;
        paths[idx].field = val(call(&h.relation_to_field, &[args.payload])?)?;
        return Ok(paths);
      }

      if !truthy(matched) && eq(&current_path, "id") && i == path_segments.len() - 1 {
        paths[idx].path = current_path;
        paths[idx].field = val(call(&h.id_field, &[args.payload])?)?;
        paths[idx].complete = true;
        return Ok(paths);
      }

      if !truthy(matched) {
        let p = &mut paths[idx];
        p.invalid = true;
        p.path = current_path;
        return Ok(paths);
      }

      if in_op("hidden", matched)?
        && truthy(get_named(matched, "hidden")?)
        && !args.override_access
        && !args.show_hidden_fields
      {
        paths[idx].invalid = true;
      }

      let next_segment = path_segments.get(i + 1);
      let next_segment_js = next_segment.map(|s| string(s)).unwrap_or_else(js::undefined);
      let current_field_is_localized = truthy(call(&h.field_should_be_localized, &[matched, parent_is_localized])?);

      let next_segment_is_locale = truthy(localization_config)
        && truthy(call(&h.locale_codes_include, &[localization_config, next_segment_js])?)
        && current_field_is_localized;

      if next_segment_is_locale {
        i += 1;
        current_path = dot(&current_path, &to_string(next_segment_js)?);
      } else if truthy(localization_config) && current_field_is_localized {
        current_path = dot(&current_path, &to_string(args.locale)?);
      }

      let field_type = get_named(matched, "type")?;
      if str_eq(field_type, "join") || str_eq(field_type, "relationship") || str_eq(field_type, "upload") {
        // matchedField.type !== 'join' && typeof matchedField.relationTo !== 'string'
        if !type_is(matched, "join")? && !is_string(get_named(matched, "relationTo")?) {
          let p = &mut paths[idx];
          p.path = join_dot(&path_segments);
          let last = string(path_segments.last().map(Vec::as_slice).unwrap_or(&[]));
          let name = get_named(matched, "name")?;
          // [matchedField.name, 'relationTo', 'value'].includes(pathSegments.at(-1))
          if !(js::strict_equals(name, last) || str_eq(last, "relationTo") || str_eq(last, "value")) {
            paths[idx].invalid = true;
          } else {
            paths[idx].complete = true;
          }
        } else {
          paths[idx].complete = true;
          paths[idx].path = current_path.clone();

          let start = if next_segment_is_locale { i + 2 } else { i + 1 };
          let nested_path_to_query = join_dot(path_segments.get(start..).unwrap_or(&[]));

          if !nested_path_to_query.is_empty() {
            let related_collection = if type_is(matched, "join")? {
              if is_array(get_named(matched, "collection")?)? {
                return Err(super::host::api_error("Not supported")?);
              }
              // payload.collections[matchedField.collection]!.config (base before key)
              let collections = get_named(args.payload, "collections")?;
              let related = get_named(get(collections, get_named(matched, "collection")?)?, "config")?;
              let found = get_field_by_path(&FieldByPathArgs {
                config: js::undefined(),
                fields: get_named(related, "flattenedFields")?,
                include_relationships: false,
                localized_path: Units::new(),
                path: get_named(matched, "on")?,
              })?;
              if let Some(found) = found {
                let join_on_field = found.field.get();
                if truthy(join_on_field)
                  && is_rel_or_upload(join_on_field)?
                  && is_array(get_named(join_on_field, "relationTo")?)?
                {
                  return Err(super::host::api_error("Not supported")?);
                }
              }
              related
            } else {
              let collections = get_named(args.payload, "collections")?;
              get_named(get(collections, get_named(matched, "relationTo")?)?, "config")?
            };

            let remaining = get_localized_paths(&LocalizedPathsArgs {
              collection_slug: get_named(related_collection, "slug")?,
              fields: get_named(related_collection, "flattenedFields")?,
              global_slug: args.global_slug,
              incoming_path: string(&nested_path_to_query),
              locale: args.locale,
              override_access: false,
              parent_is_localized: js::boolean(false),
              payload: args.payload,
              show_hidden_fields: args.show_hidden_fields,
            })?;
            paths.extend(remaining);
          }
          return Ok(paths);
        }
      } else if str_eq(field_type, "json") || str_eq(field_type, "richText") {
        let upcoming_segments = join_dot(path_segments.get(i + 1..).unwrap_or(&[]));
        if path_segments.iter().any(|s| !is_safe_field_path(s)) {
          paths[idx].invalid = true;
        }
        let p = &mut paths[idx];
        p.complete = true;
        p.path = if upcoming_segments.is_empty() { current_path } else { dot(&current_path, &upcoming_segments) };
        return Ok(paths);
      } else {
        if i + 1 == path_segments.len() {
          paths[idx].complete = true;
        }
        paths[idx].path = current_path;
      }
    }
    i += 1;
  }

  Ok(paths)
}

pub struct FieldByPathArgs {
  pub config: Local,
  pub fields: Local,
  pub include_relationships: bool,
  pub localized_path: Units,
  pub path: Local,
}

pub struct FieldByPath {
  pub field: Val,
  pub localized_path: Units,
  pub path_has_localized: bool,
}

impl FieldByPath {
  pub fn to_js(&self) -> JsResult<Local> {
    call(
      &host()?.field_by_path_result,
      &[self.field.get(), string(&self.localized_path), js::boolean(self.path_has_localized)],
    )
  }
}

/// `getFieldByPath({ config, fields, includeRelationships, localizedPath, path })`
pub fn get_field_by_path(args: &FieldByPathArgs) -> JsResult<Option<FieldByPath>> {
  let h = host()?;
  let mut current_fields = args.fields;
  let mut current_field: Option<Local> = None;
  let mut segments: std::collections::VecDeque<Units> = split_incoming(args.path)?.into();
  let mut localized_path = args.localized_path.clone();
  let mut path_has_localized = false;

  while let Some(segment) = segments.pop_front() {
    localized_path = if localized_path.is_empty() { segment.clone() } else { dot(&localized_path, &segment) };
    let field = call(&h.find_current, &[current_fields, string(&segment)])?;
    if !truthy(field) {
      return Ok(None);
    }

    if truthy(get_named(field, "localized")?) {
      path_has_localized = true;
      localized_path.extend(units(".<locale>"));
    }

    if in_op("flattenedFields", field)? {
      current_fields = get_named(field, "flattenedFields")?;
    }

    if truthy(args.config)
      && args.include_relationships
      && is_rel_or_upload(field)?
      && !is_array(get_named(field, "relationTo")?)?
    {
      let flattened = call(&h.find_collection_flattened_fields, &[args.config, field])?;
      if truthy(flattened) {
        current_fields = flattened;
      }
      if segments.len() == 1 && eq(&segments[0], "id") {
        return Ok(Some(FieldByPath { field: val(field)?, localized_path, path_has_localized }));
      }
    }

    if in_op("blocks", field)? && !segments.is_empty() {
      let block_slug = segments[0].clone();
      let block = call(&h.find_block, &[args.config, field, string(&block_slug)])?;
      if truthy(block) {
        segments.pop_front();
        localized_path = dot(&localized_path, &block_slug);
        if segments.is_empty() {
          return Ok(None);
        }
        let rest: Vec<Units> = segments.into_iter().collect();
        return get_field_by_path(&FieldByPathArgs {
          config: args.config,
          fields: get_named(block, "flattenedFields")?,
          include_relationships: args.include_relationships,
          localized_path,
          path: string(&join_dot(&rest)),
        });
      }
    }

    current_field = Some(field);
  }

  match current_field {
    Some(field) => Ok(Some(FieldByPath { field: val(field)?, localized_path, path_has_localized })),
    None => Ok(None),
  }
}
