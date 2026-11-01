//! Port of `packages/payload/src/collections/operations/duplicate.ts` (`duplicateOperation`).

use payload_core_runtime::executor::spawn;
use payload_core_runtime::js::{self, JsResult, Local};

use crate::host::{self, call, call_fn, val};

/// `duplicateOperation(incomingArgs)`: returns its promise.
pub fn duplicate(incoming_args: Local) -> JsResult<Local> {
  host::count_call();
  let incoming_args = val(incoming_args)?;
  spawn(async move {
    // const { id, ...args } = incomingArgs
    // return createOperation({ ...args, data: incomingArgs?.data || {}, duplicateFromID: id })
    let create_args = call("duplicateCreateArgs", &[incoming_args.get()])?;
    let create = call("createOperationFn", &[])?;
    // Returned without `await`: the promise resolves this task's promise (thenable job).
    val(call_fn(create, js::undefined(), &[create_args], "createOperation")?)
  })
}

