//! BSON values, live. The classes are those of the bson module mongoose uses (`mongoose.mongo.BSON`;
//! `mongoose.Types.ObjectId === BSON.ObjectId`, `Types.Decimal128 === BSON.Decimal128`), read from the
//! `mongoose` instance the host was created with (the module `@payloadcms/db-mongodb` imports).
//!
//! Two kinds of checks, never mixed up:
//! - [`is_object_id`] is upstream's duck-typed `isObjectID` (utilities/isObjectID.ts) with its exact
//!   property reads, for the places upstream calls it (a plain object with `_bsontype: 'ObjectId'`
//!   and a `toHexString` function passes, exactly like upstream);
//! - [`instance_of`] / [`bson_class_of`] are real `instanceof` checks against the bson classes, for
//!   engine decisions where upstream itself does not inspect the value (never trust `_bsontype`
//!   there; this replaces the stage-1 codec's `_bsontype` sniffing).

use napi::sys;
use payload_core_runtime::js::{self, JsResult, Local, Type};

use crate::host::{call, call_fn, get, has, host, str_eq};

/// The bson classes the engine distinguishes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BsonClass {
  ObjectId,
  Decimal128,
  Binary,
  Long,
  Int32,
  Double,
  Timestamp,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  MinKey,
  MaxKey,
  UUID,
}

impl BsonClass {
  pub const ALL: [BsonClass; 14] = [
    BsonClass::ObjectId,
    BsonClass::Decimal128,
    BsonClass::Binary,
    BsonClass::Long,
    BsonClass::Int32,
    BsonClass::Double,
    BsonClass::Timestamp,
    BsonClass::BSONRegExp,
    BsonClass::BSONSymbol,
    BsonClass::Code,
    BsonClass::DBRef,
    BsonClass::MinKey,
    BsonClass::MaxKey,
    // UUID extends Binary: `bson_class_of` reports the first match, so it is listed after Binary
    // only for explicit `instance_of(v, UUID)` checks.
    BsonClass::UUID,
  ];

  /// The export name in the bson module.
  pub fn name(self) -> &'static str {
    match self {
      BsonClass::ObjectId => "ObjectId",
      BsonClass::Decimal128 => "Decimal128",
      BsonClass::Binary => "Binary",
      BsonClass::Long => "Long",
      BsonClass::Int32 => "Int32",
      BsonClass::Double => "Double",
      BsonClass::Timestamp => "Timestamp",
      BsonClass::BSONRegExp => "BSONRegExp",
      BsonClass::BSONSymbol => "BSONSymbol",
      BsonClass::Code => "Code",
      BsonClass::DBRef => "DBRef",
      BsonClass::MinKey => "MinKey",
      BsonClass::MaxKey => "MaxKey",
      BsonClass::UUID => "UUID",
    }
  }
}

/// `mongoose.Types` (the object upstream's `import { Types } from 'mongoose'` refers to).
pub fn types() -> JsResult<Local> {
  get(host()?.obj.get(), "Types")
}

/// `mongoose.mongo.BSON` (the bson module of the driver mongoose uses).
pub fn bson_module() -> JsResult<Local> {
  get(host()?.obj.get(), "BSON")
}

/// The class `BSON[c]`.
pub fn class(c: BsonClass) -> JsResult<Local> {
  get(bson_module()?, c.name())
}

/// `value instanceof BSON[c]` (V8's `instanceof`: `Symbol.hasInstance`, prototype chain, proxies).
pub fn instance_of(value: Local, c: BsonClass) -> JsResult<bool> {
  let ctor = class(c)?;
  let mut r = false;
  js::check(unsafe { sys::napi_instanceof(js::env(), value.0, ctor.0, &mut r) })?;
  Ok(r)
}

/// The first bson class `value` is a real instance of (`instanceof`), `None` for anything else
/// (plain objects with a forged `_bsontype` included). Primitives answer `None` without reads.
pub fn bson_class_of(value: Local) -> JsResult<Option<BsonClass>> {
  if js::type_of(value) != Type::Object {
    return Ok(None);
  }
  for c in BsonClass::ALL {
    if instance_of(value, c)? {
      return Ok(Some(c));
    }
  }
  Ok(None)
}

/// Upstream `isObjectID(value)` (db-mongodb utilities/isObjectID.ts), same reads in the same order:
/// `value && typeof value === 'object' && '_bsontype' in value && value._bsontype === 'ObjectId'
/// && 'toHexString' in value && typeof value.toHexString === 'function'`.
pub fn is_object_id(value: Local) -> JsResult<bool> {
  if !js::truthy(value) || js::type_of(value) != Type::Object {
    return Ok(false);
  }
  if !has(value, "_bsontype")? || !str_eq(get(value, "_bsontype")?, "ObjectId") {
    return Ok(false);
  }
  if !has(value, "toHexString")? {
    return Ok(false);
  }
  Ok(js::type_of(get(value, "toHexString")?) == Type::Function)
}

/// `Types.ObjectId.isValid(value)` (reads `Types.ObjectId` and `.isValid` live, like upstream).
pub fn object_id_is_valid(value: Local) -> JsResult<bool> {
  let ctor = get(types()?, "ObjectId")?;
  let is_valid = get(ctor, "isValid")?;
  Ok(js::truthy(call_fn(is_valid, ctor, &[value], "Types.ObjectId.isValid")?))
}

/// `new Types.ObjectId(...args)` (bson's constructor: a `BSONError` for invalid input is thrown
/// as the very error object bson created).
pub fn new_object_id(args: &[Local]) -> JsResult<Local> {
  let ctor = get(types()?, "ObjectId")?;
  construct(ctor, args, "Types.ObjectId")
}

/// `value.toHexString()`
pub fn to_hex_string(value: Local) -> JsResult<Local> {
  crate::host::call_method(value, "toHexString", &[], "value.toHexString")
}

/// `new ctor(...args)` (`expr` for V8's `<expr> is not a constructor`).
pub fn construct(ctor: Local, args: &[Local], expr: &str) -> JsResult<Local> {
  if js::type_of(ctor) != Type::Function {
    return Err(crate::host::throw_from("notAConstructor", &[js::string(expr)]));
  }
  let mut out = std::ptr::null_mut();
  let raw = args.as_ptr().cast::<sys::napi_value>();
  js::check(unsafe { sys::napi_new_instance(js::env(), ctor.0, args.len(), raw, &mut out) })?;
  Ok(Local(out))
}

/// `value instanceof Date` (the global `Date` at call time, so faked clocks' `Date` applies).
pub fn is_date(value: Local) -> JsResult<bool> {
  Ok(js::truthy(call("isDate", &[value])?))
}
