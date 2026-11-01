//! Pieces shared by the global and auth operations: the hook loops, transactions, access and
//! afterRead/traversal calls.

use payload_core_ops::common::{AccessArgs, execute_access};
use payload_core_runtime::executor::await_js;
use payload_core_runtime::js::{self, JsResult, Local, Val};

use crate::host::{self, ForOf, call, call_fn, get, loop_body, opt, val};

/// `config.hooks?.[name]?.length` (truthiness; `config` itself not optional).
pub fn has_hooks(config: Local, name: &str) -> JsResult<bool> {
  Ok(js::truthy(opt(opt(get(config, "hooks")?, name)?, "length")?))
}

/// `config.hooks[name]`, as the loop `for (const hook of <config_expr>.hooks.<name>)` iterates
/// (`config_expr` is the TS source text of `config`, for V8's `... is not iterable`).
pub fn hooks_of(config: Local, name: &str, config_expr: &str) -> JsResult<ForOf> {
  ForOf::of(get(get(config, "hooks")?, name)?, &format!("{config_expr}.hooks.{name}"))
}

/// `for (const hook of hooks) { target = (await hook(build(target))) || target }`.
/// `build` makes the args literal of the current iteration (it reads `req.context` etc. at that
/// point); `expr` is the loop variable's name for V8's "is not a function".
pub async fn replace_loop(
  mut hooks: ForOf,
  mut target: Val,
  expr: &str,
  mut build: impl FnMut(Local) -> JsResult<Local>,
) -> JsResult<Val> {
  while let Some(hook) = hooks.next()? {
    let hook = val(hook)?;
    let body = async {
      let args = build(target.get())?;
      let p = call_fn(hook.get(), js::undefined(), &[args], expr)?;
      let result = await_js(p).await?;
      if js::truthy(result.get()) {
        target = result;
      }
      Ok(())
    };
    loop_body(&hooks, body).await?;
  }
  Ok(target)
}

/// `if (config.hooks?.[name]?.length) { for (const hook of config.hooks[name]) { target =
/// (await hook(build(target))) || target } }`
pub async fn config_hooks(
  config: &Val,
  name: &str,
  config_expr: &str,
  target: Val,
  build: impl FnMut(Local) -> JsResult<Local>,
) -> JsResult<Val> {
  if !has_hooks(config.get(), name)? {
    return Ok(target);
  }
  let hooks = hooks_of(config.get(), name, config_expr)?;
  replace_loop(hooks, target, "hook", build).await
}

/// `for (const hook of hooks) { await hook(build()) }`
pub async fn await_loop(mut hooks: ForOf, expr: &str, mut build: impl FnMut() -> JsResult<Local>) -> JsResult<()> {
  while let Some(hook) = hooks.next()? {
    let hook = val(hook)?;
    let body = async {
      let args = build()?;
      let p = call_fn(hook.get(), js::undefined(), &[args], expr)?;
      await_js(p).await?;
      Ok(())
    };
    loop_body(&hooks, body).await?;
  }
  Ok(())
}

/// `await executeAccess({ ...access args }, access)`.
pub async fn access(args: AccessArgs, access: Val) -> JsResult<Val> {
  await_js(execute_access(args, access)?).await
}

/// `await initTransaction(req)`
pub async fn init_transaction(req: &Val) -> JsResult<Val> {
  let p = call("initTransaction", &[req.get()])?;
  await_js(p).await
}

/// `await commitTransaction(req)`
pub async fn commit_transaction(req: &Val) -> JsResult<()> {
  let p = call("commitTransaction", &[req.get()])?;
  await_js(p).await?;
  Ok(())
}

/// `await killTransaction(req)`
pub async fn kill_transaction(req: &Val) -> JsResult<()> {
  let p = call("killTransaction", &[req.get()])?;
  await_js(p).await?;
  Ok(())
}

/// `catch (error) { await killTransaction(req); throw error }` around `body`.
pub async fn or_kill(req: impl Fn() -> JsResult<Val>, body: JsResult<Val>) -> JsResult<Val> {
  match body {
    Ok(v) => Ok(v),
    Err(error) => {
      kill_transaction(&req()?).await?;
      Err(error)
    }
  }
}

/// `await <helper>(...)`: a helper that calls an upstream async utility (the args literal is built
/// inside it) and returns its promise.
pub async fn await_helper(name: &str, args: &[Local]) -> JsResult<Val> {
  let p = call(name, args)?;
  await_js(p).await
}

/// `await payload.db[method](build())`
pub async fn db(payload: &Val, method: &str, build: impl FnOnce() -> JsResult<Local>) -> JsResult<Val> {
  let p = payload_core_ops::common::db_call(payload.get(), method, build)?;
  await_js(p).await
}

/// `await payload[method](build())` (Local API call on the payload instance).
pub async fn local_api(payload: &Val, method: &str, build: impl FnOnce() -> JsResult<Local>) -> JsResult<Val> {
  let expr = format!("payload.{method}");
  let p = host::method(payload.get(), method, &expr, build)?;
  await_js(p).await
}

/// `req.t`
pub fn t(req: &Val) -> JsResult<Local> {
  get(req.get(), "t")
}

/// `throw new <name>(req.t)` (`Forbidden`, `NotFound`, ...).
pub fn throw_t(name: &str, req: &Val) -> js::Thrown {
  match t(req) {
    Ok(t) => host::throw_from(name, &[t]),
    Err(e) => e,
  }
}

/// A kept `undefined`/value helper for optional reads: `o?.name`.
pub fn opt_val(o: Local, name: &str) -> JsResult<Val> {
  val(opt(o, name)?)
}
