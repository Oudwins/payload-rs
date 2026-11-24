import type { CompiledFunction } from './compileFunction.js'
import type { FunctionKind } from './configFunctions.js'
/**
 * The function compiler's JS side (RUST_PERF_PLAN.md S6, crates/payload-fn-ir).
 *
 * - `compileFunction(fn)`: compiles one function (memoized per function object) and returns its
 *   handle (`id`, the `FnId` Rust code evaluates with `payload_fn_ir::evaluate`), or why it stays
 *   JS. `getCompiledFunction(fn)` / `isCompiled(fn)` look the memo up without compiling.
 * - `compileConfig(config)`: compiles every access function, hook and validator of a sanitized
 *   config and reports the result per function.
 * - `installCompileGuards(config)`: guard mode (see guard.ts: verification at the call sites, the
 *   config is not modified), installed by payload's `init` when `PAYLOAD_FN_COMPILE_GUARD` is set.
 *
 * Users opt a function out by mentioning `skipCompilation` in it: Payload passes a no-op
 * `skipCompilation` in the arguments of access functions, hooks and validators, so
 * `args.skipCompilation?.()` keeps that function in JS.
 */
import type { AnyFunction } from './snapshot.js'

import { compileFunction, getCompiledFunction } from './compileFunction.js'
import { configFunctions } from './configFunctions.js'
import { compileGuardsInstalled } from './guard.js'
import { getFnIr } from './native.js'
import { snapshotArgs } from './snapshot.js'

export type { CompiledFunction } from './compileFunction.js'
export { compileFunction, getCompiledFunction } from './compileFunction.js'
export { configFunctions } from './configFunctions.js'
export { compileGuardsInstalled, guardStats, installCompileGuards } from './guard.js'
export { capturedRequest } from './snapshot.js'

/** Whether `fn` was compiled and is still active (not de-optimised by guard mode). */
export const isCompiled = (fn: AnyFunction): boolean => {
  const entry = getCompiledFunction(fn)
  return entry?.ok === true && getFnIr().fnIrIsActive(entry.id)
}

export type ConfigCompileReport = {
  kind: FunctionKind
  label: string
  name: string
  result: CompiledFunction
}[]

export const compileConfig = (config: Record<string, any>): ConfigCompileReport =>
  configFunctions(config).map(({ fn, kind, label }) => ({
    name: fn.name,
    kind,
    label,
    result: compileFunction(fn, label),
  }))

/**
 * Evaluates compiled `fn` on `args` from JS (tests and diagnostics; fused lanes evaluate from
 * Rust). `{ ok: true, value }`, or `{ ok: false, reason }` when the call must run in JS.
 */
export const evaluateCompiled = (
  fn: AnyFunction,
  args: unknown[],
): { ok: false; reason: string } | { ok: true; value: unknown } => {
  const entry = getCompiledFunction(fn)
  if (!entry?.ok) {
    return { ok: false, reason: entry ? entry.reason : 'not compiled' }
  }
  const fnIr = getFnIr()
  const result = fnIr.fnIrEvaluate(entry.id, snapshotArgs(args, entry.argKeys))
  if (typeof result === 'string') {
    return { ok: false, reason: result }
  }
  return { ok: true, value: fnIr.fnIrResultToJs(result) }
}

/**
 * A fused lane's call of `fn` (FN_COMPILE_CONTRACT.md "Lanes"): the compiled function evaluated on
 * `args` only with call-site guards installed, for an active function whose call the guard does
 * not need to see now (`lane_should_verify`, which counts this call as a lane call).
 * `{ ok: false, reason }`: the call runs on the exact lane.
 */
export const evaluateOnLane = (
  fn: AnyFunction,
  args: unknown[],
): { ok: false; reason: string } | { ok: true; value: unknown } => {
  if (!compileGuardsInstalled()) {
    return { ok: false, reason: 'no-guards' }
  }
  const entry = getCompiledFunction(fn)
  if (!entry?.ok) {
    return { ok: false, reason: 'not-compiled' }
  }
  const fnIr = getFnIr()
  if (!fnIr.fnIrIsActive(entry.id)) {
    return { ok: false, reason: 'deoptimized' }
  }
  if (fnIr.fnIrLaneShouldVerify(entry.id)) {
    return { ok: false, reason: 'verify' }
  }
  // one `argKeys` entry per declared parameter; compiled functions have no rest parameter and no
  // `arguments`, so later arguments are never read (and not snapshotted: e.g. `() => true`)
  const declared = args.slice(0, entry.argKeys.length)
  const result = fnIr.fnIrEvaluate(entry.id, snapshotArgs(declared, entry.argKeys))
  if (typeof result === 'string') {
    return { ok: false, reason: `bail:${result}` }
  }
  return { ok: true, value: fnIr.fnIrResultToJs(result) }
}
