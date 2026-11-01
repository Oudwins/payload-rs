//! `utilities/getEntity.ts`, `utilities/handleError.ts` and the bson `ObjectId` constructor.

use payload_engine::bson::{object_id_bytes_from_hex, object_id_is_valid};
use payload_engine::error::{EngineError, Result};
use payload_engine::js::{BsonValue, JsVal};

use crate::context::Call;
use crate::host::{ModelRef, MongoError};

pub struct CollectionEntity<'a> {
  pub config: &'a JsVal,
  pub custom_id_type: &'a JsVal,
  pub model: ModelRef,
}

/// `getCollection({ adapter, collectionSlug, versions })`
pub fn get_collection<'a>(call: &Call<'a>, slug: &str, versions: bool) -> Result<CollectionEntity<'a>> {
  let Some(collection) = call.graph.collection(slug) else {
    return Err(EngineError::api(format!(
      "ERROR: Failed to retrieve collection with the slug \"{slug}\". Does not exist."
    )));
  };
  let model = if versions { ModelRef::Versions(slug.to_string()) } else { ModelRef::Collections(slug.to_string()) };
  if !call.ctx.has_model(&model) {
    return Err(EngineError::api(if versions {
      format!("ERROR: Failed to retrieve collection version model with the slug \"{slug}\". Does not exist.")
    } else {
      format!("ERROR: Failed to retrieve collection model with the slug \"{slug}\". Does not exist.")
    }));
  }
  Ok(CollectionEntity { config: collection.get("config"), custom_id_type: collection.get("customIDType"), model })
}

pub struct GlobalEntity<'a> {
  pub config: &'a JsVal,
  pub model: ModelRef,
}

/// `getGlobal({ adapter, globalSlug, versions })`
pub fn get_global<'a>(call: &Call<'a>, slug: &str, versions: bool) -> Result<GlobalEntity<'a>> {
  let Some(config) = call.graph.global(slug) else {
    return Err(EngineError::api(format!("ERROR: Failed to retrieve global with the slug \"{slug}\". Does not exist.")));
  };
  if versions {
    let model = ModelRef::Versions(slug.to_string());
    if !call.ctx.has_model(&model) {
      return Err(EngineError::api(format!(
        "ERROR: Failed to retrieve global version model with the slug \"{slug}\". Does not exist."
      )));
    }
    return Ok(GlobalEntity { config, model });
  }
  Ok(GlobalEntity { config, model: ModelRef::Globals })
}

/// `handleError({ collection, error, global, req })` (payload-mongo-transform's port): a unique
/// violation a host op threw becomes a `ValidationError` (`errors[].message` left out: the glue
/// fills `req?.t ? req.t('error:valueMustBeUnique') : 'Value must be unique'`); anything else is
/// rethrown.
pub fn handle_error(call: &Call<'_>, error: MongoError, collection: Option<&str>, global: Option<&str>) -> MongoError {
  let localization = call.ctx.has_req.then(|| call.graph.localization());
  payload_mongo_transform::handle_host_error(error, collection, global, localization)
}

/// `Types.ObjectId.isValid(value)` for a string.
pub fn is_valid_object_id_string(value: &str) -> bool {
  object_id_bytes_from_hex(value).is_some()
}

/// `new Types.ObjectId(value)` (bson 7), `BSONError` where the constructor throws.
pub fn new_object_id(value: &JsVal) -> Result<JsVal> {
  let bson_error = |message: &str| EngineError::new("BSONError", message);
  let mut working = value.clone();
  if value.type_of() == "object" && !value.is_null() && has_property(value, "id") {
    if let Some(bytes) = value.as_object_id() {
      return Ok(JsVal::object_id(bytes));
    }
    let id = value.get("id");
    let id_is_view = matches!(id.bson(), Some(BsonValue::Buffer(_)));
    if !matches!(id, JsVal::Str(_)) && !id_is_view {
      return Err(bson_error("Argument passed in must have an id that is of type string or Buffer"));
    }
    if value.get("toHexString").is_fn() {
      return Err(EngineError::internal("new ObjectId() of an object with a toHexString function is not supported"));
    }
    working = id.clone();
  }
  match &working {
    JsVal::Undefined | JsVal::Null => {
      Err(EngineError::internal("new ObjectId() without an input generates an id (not supported by the engine)"))
    }
    JsVal::Str(s) => match object_id_bytes_from_hex(s) {
      Some(bytes) => Ok(JsVal::object_id(bytes)),
      None => Err(bson_error("input must be a 24 character hex string, 12 byte Uint8Array, or an integer")),
    },
    _ => match working.bson() {
      Some(BsonValue::Buffer(bytes)) if bytes.len() == 12 => {
        let mut out = [0u8; 12];
        out.copy_from_slice(&bytes);
        Ok(JsVal::object_id(out))
      }
      _ => Err(bson_error("Argument passed in does not match the accepted types")),
    },
  }
}

/// `'key' in value` for the engine's values (own properties; `id` of an `ObjectId` is a getter).
fn has_property(value: &JsVal, key: &str) -> bool {
  if value.is_object_id() {
    return key == "id";
  }
  value.has(key)
}

/// `Types.ObjectId.isValid(customID)` for any value (strings are the only case the methods ask).
pub fn object_id_valid(value: &JsVal) -> bool {
  object_id_is_valid(value).unwrap_or(false)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn object_id_constructor() {
    assert!(new_object_id(&JsVal::str("507f1f77bcf86cd799439011")).is_ok());
    assert_eq!(new_object_id(&JsVal::str("abc")).unwrap_err().name, "BSONError");
    assert_eq!(new_object_id(&JsVal::Num(1.0)).unwrap_err().message, "Argument passed in does not match the accepted types");
  }
}
