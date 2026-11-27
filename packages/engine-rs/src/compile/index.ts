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
import { encodeSnapshot, readDataProperty, snapshotArgs } from './snapshot.js'

export type { CompiledFunction } from './compileFunction.js'
export { compileFunction, getCompiledFunction } from './compileFunction.js'
export { configFunctions } from './configFunctions.js'
export { compileGuardsInstalled, guardStats, installCompileGuards } from './guard.js'
export { capturedRequest, encodeSnapshot, snapshotRequest } from './snapshot.js'

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
  const { entry, reason } = laneFunction(fn)
  if (!entry) {
    return { ok: false, reason }
  }
  const fnIr = getFnIr()
  if (fnIr.fnIrLaneShouldVerify(entry.id)) {
    return { ok: false, reason: 'verify' }
  }
  const unwrapped = unwrapBaseAccess(fn, entry.id, args)
  const target = unwrapped ?? { args, entry }
  // the snapshot crosses as one JSON text (far fewer Node-API calls than its objects)
  const snapshot = snapshotArgs(target.args, target.entry.argKeys)
  const result =
    fnIr.fnIrEvaluateText(target.entry.id, JSON.stringify(encodeSnapshot(snapshot))) ??
    fnIr.fnIrEvaluate(target.entry.id, snapshot)
  if (typeof result === 'string') {
    return { ok: false, reason: `bail:${result}` }
  }
  return { ok: true, value: fnIr.fnIrResultToJs(result) }
}

/** payload's `withBaseAccess` wrappers (auth/withBaseAccess.ts): the access function each calls. */
const baseAccessWrappers = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('payload.withBaseAccess')
] ??= new WeakMap()) as WeakMap<AnyFunction, { documentAccess: AnyFunction; slug: string }>

/** Wrappers whose compiled form has matched JS on the policy's first calls (monotonic). */
const verifiedWrappers = new WeakSet<AnyFunction>()

/**
 * A `withBaseAccess` wrapper's call as the call of the access function it wraps: without
 * `req.payload.config.baseAccess` the wrapper returns `documentAccess({ ...args, slug })`, so the
 * compiled access function is evaluated on those arguments and the snapshot holds only what it
 * reads (the wrapper's spread makes its own snapshot copy the whole argument, `data` and `req`
 * included). Only for a wrapper whose compiled form, which evaluates the wrapped function's, has
 * been verified (its guard sampling covers the wrapped function: the lane call above counts on
 * the wrapper), a wrapped function that is compiled and active, and arguments read without
 * running code (plain data properties, as the snapshot would read them). `undefined`: evaluate
 * the wrapper itself.
 */
const unwrapBaseAccess = (fn: AnyFunction, id: number, args: unknown[]) => {
  const wrapped = baseAccessWrappers.get(fn)
  const [arg] = args
  if (!wrapped || args.length !== 1 || typeof arg !== 'object' || arg === null) {
    return undefined
  }
  const fnIr = getFnIr()
  if (!verifiedWrappers.has(fn)) {
    if (fnIr.fnIrStats(id).verified < 32) {
      return undefined
    }
    verifiedWrappers.add(fn)
  }
  const entry = getCompiledFunction(wrapped.documentAccess)
  if (
    !entry?.ok ||
    !fnIr.fnIrIsActive(entry.id) ||
    Object.getPrototypeOf(arg) !== Object.prototype
  ) {
    return undefined
  }
  const req = readDataProperty(arg, 'req')
  const payload = isObjectRead(req) ? readDataProperty(req.value, 'payload') : undefined
  const config = isObjectRead(payload) ? readDataProperty(payload.value, 'config') : undefined
  const baseAccess = isObjectRead(config) ? readDataProperty(config.value, 'baseAccess') : undefined
  if (!baseAccess || baseAccess.value !== undefined) {
    return undefined
  }
  const accessArgs: Record<string, unknown> = {}
  for (const key of Object.keys(arg)) {
    const read = readDataProperty(arg, key)
    if (!read?.found) {
      return undefined
    }
    accessArgs[key] = read.value
  }
  accessArgs.slug = wrapped.slug
  return { args: [accessArgs], entry }
}

const isObjectRead = (
  read: { found: boolean; value?: unknown } | undefined,
): read is { found: true; value: object } =>
  read?.found === true && typeof read.value === 'object' && read.value !== null

/**
 * `evaluateOnLane`'s checks for a lane that evaluates `fn` in Rust itself (the fused `afterRead`'s
 * field read access and population's nested access, crates/payload-fuse): guards installed,
 * compiled, active. The lane asks `lane_should_verify` itself when the operation first calls the
 * function (`after_read::lane_call`). `{ reason }`: the call runs on the exact lane.
 */
export const laneFunction = (fn: AnyFunction) => {
  if (!compileGuardsInstalled()) {
    return { reason: 'no-guards' }
  }
  const entry = getCompiledFunction(fn)
  if (!entry?.ok) {
    return { reason: 'not-compiled' }
  }
  const fnIr = getFnIr()
  if (!fnIr.fnIrIsActive(entry.id)) {
    return { reason: 'deoptimized' }
  }
  return { entry }
}
