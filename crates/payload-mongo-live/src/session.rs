//! `getSession(db, req)` (db-mongodb utilities/getSession.ts), live on the original `req`.

use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::host::{call, call_method, del, get, get_key, truthy, val};

/// Calls the async function `getSession(db, req)`: returns its promise. Await it with `await_js`
/// exactly where upstream writes `await getSession(this, req)` (engine review item 2: a
/// `req.transactionID` assigned before that point is seen, like upstream).
pub fn get_session(db: Local, req: Local) -> JsResult<Local> {
  let db = val(db)?;
  let req = val(req)?;
  spawn(run(db, req))
}

async fn run(db: Val, req: Val) -> JsResult<Val> {
  if !truthy(req.get()) {
    return Ok(Val::Undefined);
  }

  let mut transaction_id = val(get(req.get(), "transactionID")?)?;

  if js::truthy(call("isPromise", &[transaction_id.get()])?) {
    // `await req.transactionID`: read again, like upstream
    let again = get(req.get(), "transactionID")?;
    transaction_id = await_js(again).await?;
  }

  if truthy(transaction_id.get()) {
    let session = val(get_key(get(db.get(), "sessions")?, transaction_id.get())?)?;

    if truthy(session.get())
      && !truthy(call_method(session.get(), "inTransaction", &[], "session.inTransaction")?)
    {
      del(get(db.get(), "sessions")?, transaction_id.get())?;
      return Ok(Val::Undefined);
    }

    return Ok(session);
  }

  Ok(Val::Undefined)
}
