//! napi bindings for the default field validators (crates/payload-core-validate).
//!
//! A `ValidateRun` is one call of a validator (or of one of the async functions it is split
//! into at its `await` boundaries). `step()` replays it against the journal of JS answers
//! (`payload_core_validate::replay`) and reports the outcome or the next JS call to make; the
//! TS side (`packages/engine-rs/src/validate`) makes that call where TS makes it (awaiting
//! where TS awaits), answers it with `reply*()` and steps again.
//!
//! Values cross the boundary in the `serializeForEngine` format (typed: `Date`s stay dates).

use napi::{Error, Status};
use napi_derive::napi;
use payload_core_validate::replay::{FilterOptionsKind, HostRequest, LoggedError, Outcome, Replay, Reply};
use payload_core_validate::{BlocksFilterOptionsResult, Req, ValidationResult, Validator, js::get_opt};
use payload_engine::error::{EngineError, Result};
use payload_engine::js::{JsVal, decode_graph_typed, encode_value};
use serde_json::{Value as Json, json};

fn decode(graph_json: &str) -> Result<JsVal> {
  let graph: Json =
    serde_json::from_str(graph_json).map_err(|e| EngineError::internal(format!("invalid validate input JSON: {e}")))?;
  decode_graph_typed(&graph)
}

fn to_napi_error(error: EngineError) -> Error {
  Error::new(Status::GenericFailure, error.to_json().to_string())
}

/// The `req.payload` parts the validators read, decoded once per config: `config`
/// (`collections[].slug/auth`; `defaultMaxTextLength` comes with each run) and `collections`
/// (`{ [slug]: { config: { auth }, customIDType } }`, `undefined` on the client).
#[napi]
pub struct ValidateEnv {
  config: JsVal,
  collections: JsVal,
}

#[napi]
impl ValidateEnv {
  /// `graphJson` = `serializeForEngine({ config, collections })`
  #[napi(constructor)]
  pub fn new(graph_json: String) -> napi::Result<Self> {
    let graph = decode(&graph_json).map_err(to_napi_error)?;
    Ok(Self { config: graph.get("config").clone(), collections: graph.get("collections").clone() })
  }
}

/// What a run executes.
#[derive(Clone, Copy)]
enum Entry {
  Validator(Validator),
  /// `upload` / `relationship` up to `return validateFilterOptions(...)`
  RelationshipPrefix,
  ValidateFilterOptions,
  /// `blocks` up to `await validateBlocksFilterOptions(...)`
  BlocksPrefix,
  ValidateBlocksFilterOptions,
  /// `blocks` after it (`value` = `invalidBlockSlugs`)
  BlocksInvalidBlockSlugs,
}

impl Entry {
  fn from_name(name: &str) -> Option<Self> {
    Some(match name {
      "relationshipPrefix" => Entry::RelationshipPrefix,
      "validateFilterOptions" => Entry::ValidateFilterOptions,
      "blocksPrefix" => Entry::BlocksPrefix,
      "validateBlocksFilterOptions" => Entry::ValidateBlocksFilterOptions,
      "blocksInvalidBlockSlugs" => Entry::BlocksInvalidBlockSlugs,
      other => Entry::Validator(Validator::from_name(other)?),
    })
  }
}

enum Done {
  Result(ValidationResult),
  Prefix(Option<ValidationResult>),
  Blocks(BlocksFilterOptionsResult),
}

#[napi]
pub struct ValidateRun {
  entry: Entry,
  config: JsVal,
  collections: JsVal,
  default_id_type: JsVal,
  value: JsVal,
  options: JsVal,
  replay: Replay,
}

#[napi]
impl ValidateRun {
  /// `inputJson` = `serializeForEngine({ value, options, defaultIDType, defaultMaxTextLength })`,
  /// `options` holding the option keys the validator reads (without `req`).
  #[napi(constructor)]
  pub fn new(env: &ValidateEnv, entry: String, input_json: String) -> napi::Result<Self> {
    let entry = Entry::from_name(&entry)
      .ok_or_else(|| to_napi_error(EngineError::internal(format!("unknown validator {entry}"))))?;
    let input = decode(&input_json).map_err(to_napi_error)?;
    let config = match &env.config {
      JsVal::Obj(config) => {
        let mut config = (**config).clone();
        config.insert("defaultMaxTextLength".into(), input.get("defaultMaxTextLength").clone());
        JsVal::obj(config)
      }
      other => other.clone(),
    };
    Ok(Self {
      entry,
      config,
      collections: env.collections.clone(),
      default_id_type: input.get("defaultIDType").clone(),
      value: input.get("value").clone(),
      options: input.get("options").clone(),
      replay: Replay::new(),
    })
  }

  /// Runs from the start against the answers so far. Returns JSON, one of
  /// `{ done: true | message }`, `{ enter: true }` (a prefix reached its async callee),
  /// `{ blocks: { all, allowed, invalid } }`, `{ thrown: index }` (rethrow the JS exception of
  /// reply `index`), `{ error: { name, message } }` or `{ request: kind, ... }`.
  #[napi]
  pub fn step(&self) -> String {
    let replay = &self.replay;
    let outcome = replay.run(|replay| {
      let req = Req {
        config: &self.config,
        collections: &self.collections,
        default_id_type: &self.default_id_type,
        t: replay,
        host: replay,
      };
      let (value, options) = (&self.value, &self.options);
      Ok(match self.entry {
        Entry::Validator(validator) => Done::Result(payload_core_validate::validate(validator, value, options, &req)?),
        Entry::RelationshipPrefix => {
          Done::Prefix(payload_core_validate::relationship_prefix(value, options, &req)?)
        }
        Entry::ValidateFilterOptions => {
          Done::Result(payload_core_validate::validate_filter_options(value, options, &req)?)
        }
        Entry::BlocksPrefix => Done::Prefix(payload_core_validate::blocks_prefix(value, options, &req)?),
        Entry::ValidateBlocksFilterOptions => Done::Blocks(payload_core_validate::validate_blocks_filter_options(
          value,
          &get_opt(options, "id"),
          &get_opt(options, "data"),
          &get_opt(options, "filterOptions"),
          &get_opt(options, "siblingData"),
          &req,
        )?),
        Entry::BlocksInvalidBlockSlugs => {
          Done::Result(payload_core_validate::blocks_invalid_block_slugs(value.as_arr().unwrap_or(&[]), &req)?)
        }
      })
    });
    outcome_json(outcome).to_string()
  }

  /// Answers with a string (`t`, `Date.prototype.toString`).
  #[napi]
  pub fn reply_text(&mut self, text: String) {
    self.replay.reply(Reply::Text(text));
  }

  /// Answers with a value in the `serializeForEngine` format (`filterOptions`, `find`).
  #[napi]
  pub fn reply_value(&mut self, graph_json: String) -> napi::Result<()> {
    let value = decode(&graph_json).map_err(to_napi_error)?;
    self.replay.reply(Reply::Value(value));
    Ok(())
  }

  /// Answers a call without a result (`logger.error`).
  #[napi]
  pub fn reply_unit(&mut self) {
    self.replay.reply(Reply::Unit);
  }

  /// The call threw; the JS side keeps the exception under this reply's index.
  #[napi]
  pub fn reply_thrown(&mut self) {
    self.replay.reply(Reply::Thrown);
  }
}

fn result_json(result: ValidationResult) -> Json {
  match result {
    ValidationResult::Valid => json!({ "done": true }),
    ValidationResult::Invalid(message) => json!({ "done": message }),
  }
}

fn outcome_json(outcome: Outcome<Done>) -> Json {
  match outcome {
    Outcome::Done(Done::Result(result)) => result_json(result),
    Outcome::Done(Done::Prefix(Some(result))) => result_json(result),
    Outcome::Done(Done::Prefix(None)) => json!({ "enter": true }),
    Outcome::Done(Done::Blocks(result)) => json!({ "blocks": {
      "all": encode_value(&JsVal::arr(result.all_block_slugs)),
      "allowed": result.allowed_block_slugs.map(|allowed| encode_value(&JsVal::arr(allowed))),
      "invalid": encode_value(&JsVal::arr(result.invalid_block_slugs)),
    } }),
    Outcome::Thrown(index) => json!({ "thrown": index }),
    Outcome::Error(error) => json!({ "error": { "name": error.name, "message": error.message } }),
    Outcome::Request(request) => request_json(request),
  }
}

fn request_json(request: HostRequest) -> Json {
  match request {
    HostRequest::T { key, vars } => json!({
      "request": "t",
      "key": key,
      "vars": vars.map(|vars| encode_value(&JsVal::obj(vars))),
    }),
    HostRequest::DateToString { ms } => json!({ "request": "dateToString", "ms": ms }),
    HostRequest::LogError { msg, err } => match err {
      LoggedError::Thrown(index) => json!({ "request": "logError", "msg": msg, "thrown": index }),
      LoggedError::Engine(error) => json!({
        "request": "logError",
        "msg": msg,
        "error": { "name": error.name, "message": error.message },
      }),
    },
    HostRequest::FilterOptions { func, kind, relation_to } => json!({
      "request": "filterOptions",
      "fn": func,
      "kind": match kind {
        FilterOptionsKind::Blocks => "blocks",
        FilterOptionsKind::Relationship => "relationship",
        FilterOptionsKind::Select => "select",
      },
      "relationTo": encode_value(&relation_to),
    }),
    HostRequest::Find { collection, override_access, ids, has_option_filter } => json!({
      "request": "find",
      "collection": encode_value(&collection),
      "overrideAccess": encode_value(&override_access),
      "ids": encode_value(&ids),
      "hasOptionFilter": has_option_filter,
    }),
    HostRequest::JsonSchema => json!({ "request": "jsonSchema" }),
    HostRequest::RichText => json!({ "request": "richText" }),
  }
}
