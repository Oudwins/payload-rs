//! Pieces shared by the write operations: the collection hook loops, field traversal calls, the
//! upstream transaction utilities and the `catch` blocks of the operations.

use payload_core_runtime::executor::await_js;
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Val};

use crate::host::{self, call, call_fn, element, get, iterable};

/// `for (const hook of config.hooks[name]) { target = (await hook(build(target))) || target }`.
/// `build` creates the hook's args literal from the current target (a JS helper, upstream's key
/// order). The hook array is read once and iterated by index with a live length.
pub async fn reduce_hooks(
  config: &Val,
  name: &str,
  mut target: Val,
  mut build: impl FnMut(Local) -> JsResult<Local>,
) -> JsResult<Val> {
  let hooks = iterable(get(get(config.get(), "hooks")?, name)?)?;
  let mut i = 0;
  while i < js::array_length(hooks.get()) {
    let hook = element(hooks.get(), i)?;
    let args = build(target.get())?;
    let p = call_fn(hook, js::undefined(), &[args], "hook")?;
    let r = await_js(p).await?;
    if js::truthy(r.get()) {
      target = r;
    }
    i += 1;
  }
  Ok(target)
}

/// `for (const hook of config.hooks[name]) { await hook(build()) }` (result ignored).
pub async fn each_hook(config: &Val, name: &str, mut build: impl FnMut() -> JsResult<Local>) -> JsResult<()> {
  let hooks = iterable(get(get(config.get(), "hooks")?, name)?)?;
  let mut i = 0;
  while i < js::array_length(hooks.get()) {
    let hook = element(hooks.get(), i)?;
    let args = build()?;
    let p = call_fn(hook, js::undefined(), &[args], "hook")?;
    await_js(p).await?;
    i += 1;
  }
  Ok(())
}

/// `await <traversal>(args)` for a field traversal (`beforeValidate`, `beforeChange`,
/// `afterChange`, `afterRead`).
pub async fn traverse(name: &str, args: Local) -> JsResult<Val> {
  let p = host::traversal(name, args)?;
  await_js(p).await
}

/// `await helper(...args)`: calls an upstream async utility through its host helper and awaits it.
pub async fn await_helper(name: &str, args: &[Local]) -> JsResult<Val> {
  let p = call(name, args)?;
  await_js(p).await
}

/// `const shouldCommit = !args.disableTransaction && (await initTransaction(args.req))`
pub async fn init_transaction_unless_disabled(args: &Val) -> JsResult<bool> {
  if js::truthy(get(args.get(), "disableTransaction")?) {
    return Ok(false);
  }
  let req = get(args.get(), "req")?;
  let r = await_helper("initTransaction", &[req]).await?;
  Ok(js::truthy(r.get()))
}

/// The `catch` block of create/update/updateByID:
/// `await unlinkTempFiles({...args}).catch(log); await killTransaction(args.req);
/// if (hasFileOperationScope) await abortFileOperationScope({ req: args.req }); throw error`.
pub async fn catch_with_unlink(args: &Val, has_file_operation_scope: bool, error: Thrown) -> JsResult<Val> {
  await_helper("unlinkTempFilesOnError", &[args.get()]).await?;
  catch_kill(args, has_file_operation_scope, error).await
}

/// The `catch` block of delete/deleteByID: `await killTransaction(args.req);
/// if (hasFileOperationScope) await abortFileOperationScope({ req: args.req }); throw error`.
pub async fn catch_kill(args: &Val, has_file_operation_scope: bool, error: Thrown) -> JsResult<Val> {
  let req = get(args.get(), "req")?;
  await_helper("killTransaction", &[req]).await?;
  if has_file_operation_scope {
    let req = get(args.get(), "req")?;
    await_helper("abortFileOperationScope", &[req]).await?;
  }
  Err(error)
}

/// The end of a successful operation: `if (shouldCommit) await commitTransaction(req);
/// if (hasFileOperationScope) await completeFileOperationScope({ req })`.
pub async fn commit_and_complete(req: &Val, should_commit: bool, has_file_operation_scope: bool) -> JsResult<()> {
  if should_commit {
    await_helper("commitTransaction", &[req.get()]).await?;
  }
  if has_file_operation_scope {
    await_helper("completeFileOperationScope", &[req.get()]).await?;
  }
  Ok(())
}

/// `config.<a>.<b>` truthiness.
pub fn truthy_path(o: Local, a: &str, b: &str) -> JsResult<bool> {
  Ok(js::truthy(get(get(o, a)?, b)?))
}

/// `args.collection.config`
pub fn args_collection_config(args: &Val) -> JsResult<Local> {
  get(get(args.get(), "collection")?, "config")
}

/// `{}` (a fresh object literal).
pub fn empty_object() -> JsResult<Val> {
  Val::from_local(js::object())
}
