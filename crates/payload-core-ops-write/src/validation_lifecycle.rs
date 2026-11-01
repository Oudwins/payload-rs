//! Port of `packages/payload/src/utilities/runValidationLifecycle.ts`: the hook and field-validation
//! lifecycle shared by the collection and the global `validate` operations (the global one,
//! crates/payload-core-ops-global `global_validate`, calls it too).
//!
//! `runValidationLifecycle` is an `async` function: [`run_validation_lifecycle`] spawns it as its
//! own task and returns its promise. Field traversals are called through the caller's
//! [`LifecycleArgs::traverse`]: the collection validate passes [`crate::host::traversal`] (the Rust ports,
//! or the TS ones with `PAYLOAD_OPS_WRITE_TRAVERSALS=ts`), the global validate payload's own
//! (dispatched) traversal exports, as its other operations do; the collection/global
//! `beforeValidate`/`beforeChange` hook loops are `for...of` loops here. Object literals, upstream
//! utilities (`deepCopyObjectSimple`, `deepMergeWithSourceArraysIgnoringUndefined`,
//! `toValidationResult`) and the caller's arrows are host helpers.

use payload_core_ops::host::ForOf;
use payload_core_runtime::executor::{await_js, spawn};
use payload_core_runtime::js::{self, JsResult, Local, Thrown, Val};

use crate::host::{call, call_fn, call_val, get, is_nullish, throw_from, val};

/// The `runValidationLifecycle({...})` argument (built by the Rust callers, so destructuring it is
/// not observable; `undefined` where the caller's literal has no such key).
pub struct LifecycleArgs {
  /// Calls the field traversal `name` (`beforeValidate`, `beforeChange`) with `args` and returns
  /// its promise.
  pub traverse: fn(&str, Local) -> JsResult<Local>,
  pub id: Val,
  pub before_validation: Val,
  pub collection: Val,
  pub doc_with_locales: Val,
  pub global: Val,
  pub incoming_data: Val,
  pub on_validation_data: Val,
  pub original_doc: Val,
  pub override_access: Val,
  pub req: Val,
  pub skip_mutation_hooks: Val,
  pub validate_data: Val,
  pub validation_operation: Val,
}

/// `runValidationLifecycle(args)`: returns its promise.
pub fn run_validation_lifecycle(args: LifecycleArgs) -> JsResult<Local> {
  spawn(run(args))
}

async fn run(mut a: LifecycleArgs) -> JsResult<Val> {
  // skipMutationHooks = false, validationOperation = 'validate'
  if a.skip_mutation_hooks.is_undefined() {
    a.skip_mutation_hooks = Val::Bool(false);
  }
  if a.validation_operation.is_undefined() {
    a.validation_operation = val(js::string("validate"))?;
  }
  // let data = deepCopyObjectSimple(incomingData ?? {})
  let data = call_val("lifecycleCopyIncomingData", &[a.incoming_data.get()])?;

  match body(&a, data).await {
    Ok(()) => call_val("lifecycleValid", &[]),
    // catch (error) { return toValidationResult({ error, req }) }
    Err(Thrown(error)) => call_val("lifecycleValidationResult", &[error.get(), a.req.get()]),
  }
}

/// The `try` block.
async fn body(a: &LifecycleArgs, mut data: Val) -> JsResult<()> {
  // onValidationData?.(deepMergeWithSourceArraysIgnoringUndefined(originalDoc, data))
  on_validation_data(a, || call("deepMergeWithSourceArraysIgnoringUndefined", &[a.original_doc.get(), data.get()]))?;

  if !js::truthy(a.skip_mutation_hooks.get()) {
    // await beforeValidation?.({ data })
    let r = optional_call(&a.before_validation, "beforeValidation", || call("dataArg", &[data.get()]))?;
    await_js(r).await?;

    // data = await beforeValidate({ ... })
    let args = call(
      "lifecycleBeforeValidateArgs",
      &[
        a.id.get(),
        a.collection.get(),
        a.req.get(),
        data.get(),
        a.original_doc.get(),
        a.global.get(),
        a.validation_operation.get(),
        a.override_access.get(),
      ],
    )?;
    data = await_js((a.traverse)("beforeValidate", args)?).await?;
    on_validation_data(a, || Ok(data.get()))?;

    if js::truthy(a.collection.get()) {
      let build = |d: Local| {
        call(
          "lifecycleCollectionHookArgs",
          &[a.collection.get(), a.req.get(), d, a.validation_operation.get(), a.original_doc.get()],
        )
      };
      data = hook_loop(&a.collection, "beforeValidate", data, build).await?;
      data = hook_loop(&a.collection, "beforeChange", data, build).await?;
    } else {
      // if (validationOperation === 'create') throw new Error(...)
      let op = a.validation_operation.get();
      if js::strict_equals(op, js::string("create")) {
        return Err(throw_from("lifecycleGlobalCreateError", &[]));
      }
      let build = |d: Local| {
        call(
          "lifecycleGlobalHookArgs",
          &[a.req.get(), d, a.global.get(), a.validation_operation.get(), a.original_doc.get(), a.override_access.get()],
        )
      };
      data = hook_loop(&a.global, "beforeValidate", data, build).await?;
      data = hook_loop(&a.global, "beforeChange", data, build).await?;
    }

    on_validation_data(a, || Ok(data.get()))?;
  }

  // let processedData = data (the `onDataProcessed` arrow reassigns it: processed[0])
  let processed = js::array();
  js::set_element(processed, 0, data.get())?;
  let processed = val(processed)?;

  // await beforeChange({ ... })
  let args = call(
    "lifecycleBeforeChangeArgs",
    &[
      a.id.get(),
      a.collection.get(),
      a.req.get(),
      data.get(),
      a.original_doc.get(),
      a.doc_with_locales.get(),
      a.global.get(),
      a.validation_operation.get(),
      a.override_access.get(),
      a.skip_mutation_hooks.get(),
      processed.get(),
    ],
  )?;
  await_js((a.traverse)("beforeChange", args)?).await?;

  let processed_data = js::get_element(processed.get(), 0)?;
  let validation_data =
    call_val("deepMergeWithSourceArraysIgnoringUndefined", &[a.original_doc.get(), processed_data])?;
  on_validation_data(a, || Ok(validation_data.get()))?;
  // await validateData?.({ data: validationData })
  let r = optional_call(&a.validate_data, "validateData", || call("dataArg", &[validation_data.get()]))?;
  await_js(r).await?;
  Ok(())
}

/// `onValidationData?.(<arg>)`: the argument is only evaluated when the callback is not nullish.
fn on_validation_data(a: &LifecycleArgs, arg: impl FnOnce() -> JsResult<Local>) -> JsResult<()> {
  optional_call(&a.on_validation_data, "onValidationData", arg)?;
  Ok(())
}

/// `f?.(<arg>)` (`this` undefined); `undefined` when `f` is nullish.
fn optional_call(f: &Val, expr: &str, arg: impl FnOnce() -> JsResult<Local>) -> JsResult<Local> {
  let fv = f.get();
  if is_nullish(fv) {
    return Ok(js::undefined());
  }
  let arg = arg()?;
  call_fn(fv, js::undefined(), &[arg], expr)
}

/// `for (const hook of config.hooks[name] ?? []) { data = (await hook(build(data))) || data }`
async fn hook_loop(config: &Val, name: &str, mut data: Val, build: impl Fn(Local) -> JsResult<Local>) -> JsResult<Val> {
  let hooks = get(get(config.get(), "hooks")?, name)?;
  let mut hooks = if is_nullish(hooks) {
    ForOf::Array { arr: val(js::array())?, index: 0 }
  } else if js::is_array(hooks) {
    ForOf::Array { arr: val(hooks)?, index: 0 }
  } else {
    // proxies and other iterables, and V8's error for a non-iterable value of `<expr> ?? []`
    ForOf::Iter(call_val("forOfNullishOr", &[hooks])?)
  };
  while let Some(hook) = hooks.next()? {
    let hook = val(hook)?;
    let step = async {
      let args = build(data.get())?;
      let p = call_fn(hook.get(), js::undefined(), &[args], "hook")?;
      await_js(p).await
    }
    .await;
    match step {
      Ok(r) => {
        if js::truthy(r.get()) {
          data = r;
        }
      }
      Err(e) => {
        hooks.close();
        return Err(e);
      }
    }
  }
  Ok(data)
}
