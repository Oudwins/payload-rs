//! Steps shared by the write methods (each one an upstream statement sequence that several methods
//! repeat verbatim).

use crate::drive::wait;
use payload_core_runtime::js::{self, JsResult, Local, Val};
use payload_mongo_live::deps::{self, TransformArgs};
use payload_mongo_live::host::val;
use payload_mongo_live::session;

use crate::helpers;

/// `handleError({ collection, error, global, req })` on the very value that was thrown (the
/// payload-mongo-live-transform port: live `in` / getter reads, `req?.payload?.config?.localization`,
/// `req?.t`); returns what upstream throws.
pub fn handle_error(collection: Local, error: payload_core_runtime::js::Thrown, global: Local, req: Local) -> payload_core_runtime::js::Thrown {
  payload_mongo_live_transform::handle_error(collection, error.0.get(), global, req)
}

/// Runs the destructuring helper `name` on the method argument: the bound values in pattern order.
pub fn destructure<const N: usize>(name: &str, args: &Val) -> JsResult<[Val; N]> {
  let arr = helpers::call(name, &[args.get()])?;
  let mut out: [Val; N] = std::array::from_fn(|_| Val::Undefined);
  for (i, slot) in out.iter_mut().enumerate() {
    *slot = val(js::get_element(arr, i as u32)?)?;
  }
  Ok(out)
}

/// `{ ...optionsArgs, session: await getSession(this, req), timestamps: false }`: the spread is
/// evaluated before the await (reads of `optionsArgs` happen there, like upstream).
pub async fn base_options(adapter: &Val, options_args: &Val, req: &Val) -> JsResult<Val> {
  let partial = helpers::call_val("spread", &[options_args.get()])?;
  let session = wait(session::get_session(adapter.get(), req.get())?).await?;
  helpers::call_val("finishOptions", &[partial.get(), session.get()])
}

/// `{ session: await getSession(this, req), timestamps: false }` (an object literal: own data
/// properties, never inherited setters: writes review item 7)
pub async fn session_options(adapter: &Val, req: &Val) -> JsResult<Val> {
  let session = wait(session::get_session(adapter.get(), req.get())?).await?;
  if crate::mutant(12) {
    // mutant 12: the options object filled with ordinary Sets (inherited setters run)
    let o = js::object();
    js::set_named(o, "session", session.get())?;
    js::set_named(o, "timestamps", js::boolean(false))?;
    return val(o);
  }
  helpers::call_val("sessionOptions", &[session.get()])
}

/// The four operator objects of the update methods (`const $inc = {}`, `$push`, `$addToSet`,
/// `$pull`, in that order).
pub struct UpdateOperators {
  pub inc: Val,
  pub push: Val,
  pub add_to_set: Val,
  pub pull: Val,
}

impl UpdateOperators {
  pub fn new() -> JsResult<UpdateOperators> {
    Ok(UpdateOperators { inc: val(js::object())?, push: val(js::object())?, add_to_set: val(js::object())?, pull: val(js::object())? })
  }

  /// ```ts
  /// const updateOps = {}
  /// if (Object.keys($inc).length) updateOps.$inc = $inc
  /// ... $push, $addToSet, $pull
  /// if (Object.keys(updateOps).length) { updateOps.$set = updateData; updateData = updateOps }
  /// ```
  /// Returns the new `updateData`. Upstream's statements run as one JS helper (writes review items
  /// 5 / 6): the current `Object.keys` is called five times, `.length` read on what it returns, the
  /// assignments are strict-mode Sets (inherited setters run, read-only keys throw) and the last
  /// test looks at the keys `updateOps` really got.
  pub fn apply(&self, update_data: Val) -> JsResult<Val> {
    assemble_update_ops(&self.inc, &self.push, &self.add_to_set, &self.pull, &update_data)
  }
}

/// The one implementation of the operator assembly (swap point for a shared runtime helper).
fn assemble_update_ops(inc: &Val, push: &Val, add_to_set: &Val, pull: &Val, update_data: &Val) -> JsResult<Val> {
  if crate::mutant(11) {
    // mutant 11: native enumeration, sloppy native Sets and a per-operator flag (the pre-fix code)
    let update_ops = js::object();
    let mut any = false;
    for (name, o) in [("$inc", inc), ("$push", push), ("$addToSet", add_to_set), ("$pull", pull)] {
      if payload_mongo_live::host::object_keys_length(o.get())? > 0 {
        js::set_named(update_ops, name, o.get())?;
        any = true;
      }
    }
    if any {
      js::set_named(update_ops, "$set", update_data.get())?;
      return val(update_ops);
    }
    return Ok(update_data.clone());
  }
  helpers::call_val("assembleUpdateOps", &[inc.get(), push.get(), add_to_set.get(), pull.get(), update_data.get()])
}

/// `transform({ adapter: this, data, fields, [globalSlug,] operation: 'write' })`, or with the four
/// operator objects first (`{ $addToSet, $inc, $pull, $push, adapter: this, data, fields, operation:
/// 'write' }`).
pub fn transform_write(adapter: &Val, data: &Val, fields: Val, global_slug: Option<&Val>, ops: Option<&UpdateOperators>) -> JsResult<()> {
  let (add_to_set, inc, pull, push) = match ops {
    Some(o) => (o.add_to_set.clone(), o.inc.clone(), o.pull.clone(), o.push.clone()),
    None => (Val::Undefined, Val::Undefined, Val::Undefined, Val::Undefined),
  };
  deps::transform(TransformArgs {
    add_to_set,
    inc,
    pull,
    push,
    adapter: adapter.clone(),
    data: data.clone(),
    fields,
    global_slug: global_slug.cloned().unwrap_or(Val::Undefined),
    operation: val(js::string("write"))?,
    parent_is_localized: Val::Undefined,
    validate_relationships: Val::Undefined,
  })?;
  Ok(())
}

/// `transform({ adapter: this, data, fields, [globalSlug,] operation: 'read' })`
pub fn transform_read(adapter: &Val, data: &Val, fields: Val, global_slug: Option<&Val>) -> JsResult<()> {
  deps::transform(TransformArgs {
    add_to_set: Val::Undefined,
    inc: Val::Undefined,
    pull: Val::Undefined,
    push: Val::Undefined,
    adapter: adapter.clone(),
    data: data.clone(),
    fields,
    global_slug: global_slug.cloned().unwrap_or(Val::Undefined),
    operation: val(js::string("read"))?,
    parent_is_localized: Val::Undefined,
    validate_relationships: Val::Undefined,
  })?;
  Ok(())
}

/// `await <promise or value>`
pub async fn await_local(v: Local) -> JsResult<Val> {
  wait(v).await
}
