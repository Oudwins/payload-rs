//! Field predicates from `payload/src/fields/config/types.ts` and
//! `payload/src/utilities/getVersionsConfig.ts`, with identical JS semantics.

use crate::js::JsVal;

fn field_type(field: &JsVal) -> &str {
  field.get("type").as_str().unwrap_or("")
}

/// `fieldIsPresentationalOnly`
pub fn field_is_presentational_only(field: &JsVal) -> bool {
  field_type(field) == "ui"
}

/// `fieldAffectsData`
pub fn field_affects_data(field: &JsVal) -> bool {
  field.has("name") && !field_is_presentational_only(field)
}

/// `fieldHasSubFields`
pub fn field_has_sub_fields(field: &JsVal) -> bool {
  matches!(field_type(field), "group" | "array" | "row" | "collapsible")
}

/// `fieldShouldBeLocalized`
pub fn field_should_be_localized(field: &JsVal, parent_is_localized: bool) -> bool {
  field.has("localized") && field.get("localized").truthy() && !parent_is_localized
}

/// `fieldIsVirtual`
pub fn field_is_virtual(field: &JsVal) -> bool {
  field.has("virtual") && field.get("virtual").truthy()
}

/// `tabHasName`
pub fn tab_has_name(tab: &JsVal) -> bool {
  tab.has("name")
}

/// `optionIsObject`
pub fn option_is_object(option: &JsVal) -> bool {
  option.is_object_like()
}

fn drafts(entity: &JsVal) -> Option<&JsVal> {
  let versions = entity.get("versions");
  (versions.truthy() && versions.is_object_like()).then(|| versions.get("drafts"))
}

/// `hasVersionsEnabled`
pub fn has_versions_enabled(entity: &JsVal) -> bool {
  entity.get("versions").truthy()
}

/// `hasDraftsEnabled`
pub fn has_drafts_enabled(entity: &JsVal) -> bool {
  drafts(entity).is_some_and(|d| d.truthy())
}

fn drafts_option(entity: &JsVal, key: &str) -> bool {
  drafts(entity).is_some_and(|d| d.truthy() && d.is_object_like() && d.get(key).truthy())
}

/// `hasAutosaveEnabled`
pub fn has_autosave_enabled(entity: &JsVal) -> bool {
  drafts_option(entity, "autosave")
}

/// `hasLocalizeStatusEnabled`
pub fn has_localize_status_enabled(entity: &JsVal) -> bool {
  drafts_option(entity, "localizeStatus")
}

/// `hasDraftValidationEnabled`
pub fn has_draft_validation_enabled(entity: &JsVal) -> bool {
  drafts_option(entity, "validate")
}

/// `hasScheduledPublishEnabled`
pub fn has_scheduled_publish_enabled(entity: &JsVal) -> bool {
  drafts_option(entity, "schedulePublish")
}
