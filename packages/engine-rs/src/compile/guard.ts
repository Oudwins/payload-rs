import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as setTimeoutReal } from 'node:timers'
import { inspect, types } from 'node:util'

import type { CompiledResult } from './native.js'
import type { AnyFunction } from './snapshot.js'

import { setUserFunctionGuard } from '../../../payload/src/utilities/callUserFunction.js'
import { compileFunction } from './compileFunction.js'
import { configFunctions } from './configFunctions.js'
import { getFnIr } from './native.js'
import { snapshot, snapshotArgs } from './snapshot.js'

/**
 * Guard mode: verification of compiled functions at their call sites. The config is not touched:
 * Payload calls access functions, hooks and validators through `callUserFunction` (payload
 * `utilities/callUserFunction.ts`, both engines' JS call sites) and the Rust core calls every JS
 * function through `js::call`; with guards installed both go through `guardCall`, which looks the
 * function up by identity. For a compiled function and the calls the policy selects
 * (`fnIrShouldVerify`) it evaluates the IR on a snapshot of the arguments taken before the call,
 * calls the real function (the authority: same `this`, arguments, result, errors, promise) and
 * compares. A mismatch de-optimises the function permanently and is logged.
 *
 * `PAYLOAD_FN_COMPILE_GUARD=all` verifies every call; `=sample` the policy default (first 32
 * calls, then 1 in 256). The policy is applied here, on the function's JS call count, so a call
 * that is not verified does not cross into the addon (`fnIrIsActive` is asked only for the calls
 * the policy selects; a de-optimisation is permanent). `PAYLOAD_FN_COMPILE_STATS=<dir>` writes `<dir>/<pid>.json`: every
 * function seen (once per function object, with all its config labels), compiled or not (and
 * why), with its counters, bail reasons and mismatches.
 */
type Tracked = {
  bailReasons: Record<string, number>
  calls: number
  compiled: boolean
  id?: number
  kind: string
  label: string
  labels: string[]
  mismatches: { args: string; compiled: string; js: string }[]
  reason?: string
}

type Guarded = { argKeys: (null | string[])[]; id: number; record: Tracked }

const tracked: Tracked[] = []
const trackedByFunction = new WeakMap<AnyFunction, Tracked>()
const guarded = new WeakMap<AnyFunction, Guarded>()
const guardedConfigs = new WeakSet<object>()
let installed = false
/** `fnIrSetPolicy`'s values: verify the first `first` calls of a function, then 1 in `sampleEvery`. */
let verifyPolicy = { first: 32, sampleEvery: 256 }
let scheduleFlush: () => void = () => {}
let flushTimer: ReturnType<typeof setTimeoutReal> | undefined
let testFile: string | undefined

export const installCompileGuards = (
  config: Record<string, any>,
): { compiled: number; total: number } => {
  if (guardedConfigs.has(config)) {
    return { compiled: 0, total: 0 }
  }
  guardedConfigs.add(config)
  testFile ??= (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__
    ?.filepath
  const fnIr = getFnIr()
  const mode = process.env.PAYLOAD_FN_COMPILE_GUARD
  verifyPolicy =
    mode === 'all' ? { first: Infinity, sampleEvery: 1 } : { first: 32, sampleEvery: 256 }
  fnIr.fnIrSetPolicy(verifyPolicy.first, verifyPolicy.sampleEvery)
  let compiledCount = 0
  const entries = configFunctions(config)
  for (const entry of entries) {
    const existing = trackedByFunction.get(entry.fn)
    if (existing) {
      existing.labels.push(entry.label)
      compiledCount += existing.compiled ? 1 : 0
      continue
    }
    const result = compileFunction(entry.fn, entry.label)
    const record: Tracked = {
      bailReasons: {},
      calls: 0,
      compiled: result.ok,
      kind: entry.kind,
      label: entry.label,
      labels: [entry.label],
      mismatches: [],
      ...(result.ok ? { id: result.id } : { reason: result.reason }),
    }
    tracked.push(record)
    trackedByFunction.set(entry.fn, record)
    if (result.ok) {
      compiledCount++
      guarded.set(entry.fn, { id: result.id, argKeys: result.argKeys, record })
    }
  }
  if (!installed) {
    installed = true
    setUserFunctionGuard(guardCall)
    fnIr.fnIrSetCallGuard(guardCall)
    installStatsWriter()
  }
  return { compiled: compiledCount, total: entries.length }
}

/**
 * Whether call-site guards are installed: a fused lane may only substitute a compiled function
 * then (FN_COMPILE_CONTRACT.md section 3).
 */
export const compileGuardsInstalled = (): boolean => installed

/** Guard counters of one config function (tests): `undefined` when guards never saw it. */
export const guardStats = (fn: AnyFunction) => {
  const record = trackedByFunction.get(fn)
  if (!record) {
    return undefined
  }
  return {
    bailReasons: record.bailReasons,
    compiled: record.compiled,
    mismatches: record.mismatches.length,
    ...(record.id !== undefined ? getFnIr().fnIrStats(record.id) : {}),
    calls: record.calls,
  }
}

const bail = (record: Tracked, reason: string) => {
  record.bailReasons[reason] = (record.bailReasons[reason] ?? 0) + 1
}

/** `Reflect.apply(fn, thisArg, args)`, verifying `fn` when it is a guarded compiled function. */
const guardCall = (fn: AnyFunction, thisArg: unknown, args: unknown[]): unknown => {
  const entry = guarded.get(fn)
  if (!entry) {
    return Reflect.apply(fn, thisArg, args)
  }
  const { id, record } = entry
  const fnIr = getFnIr()
  const calls = ++record.calls
  scheduleFlush()
  let compiled: CompiledResult | undefined
  let snapArgs: undefined | unknown[]
  // besides the policy's calls: the call a fused lane left to this (exact) lane for verification,
  // and calls of functions halfway due on the lanes (`fnIrTakeVerify`)
  const shouldVerify =
    calls <= verifyPolicy.first ||
    (verifyPolicy.sampleEvery > 0 && calls % verifyPolicy.sampleEvery === 0) ||
    fnIr.fnIrTakeVerify(id)
  if (shouldVerify && fnIr.fnIrIsActive(id)) {
    snapArgs = snapshotArgs(args, entry.argKeys)
    const evaluated = fnIr.fnIrEvaluate(id, snapArgs)
    if (typeof evaluated === 'string') {
      fnIr.fnIrRecord(id, 2)
      bail(record, evaluated)
    } else {
      compiled = evaluated
    }
  }
  let result: unknown
  try {
    result = Reflect.apply(fn, thisArg, args)
  } catch (error) {
    if (compiled) {
      fnIr.fnIrRecord(id, 1)
      logMismatch(record, snapArgs!, fnIr.fnIrResultToJs(compiled), `threw ${String(error)}`)
    }
    throw error
  }
  if (compiled) {
    const c = compiled
    const compare = (jsResult: unknown) => {
      const outcome = fnIr.fnIrCompare(c, snapshot(jsResult))
      fnIr.fnIrRecord(id, outcome)
      if (outcome === 1) {
        logMismatch(record, snapArgs!, fnIr.fnIrResultToJs(c), jsResult)
      } else if (outcome === 2) {
        bail(record, 'result not comparable')
      }
    }
    if (types.isPromise(result)) {
      result.then(compare, (error) => {
        fnIr.fnIrRecord(id, 1)
        logMismatch(record, snapArgs!, fnIr.fnIrResultToJs(c), `rejected ${String(error)}`)
      })
    } else {
      compare(result)
    }
  }
  return result
}

const show = (value: unknown) => inspect(value, { breakLength: Infinity, depth: 6 })

const logMismatch = (record: Tracked, args: unknown[], compiled: unknown, js: unknown) => {
  if (record.mismatches.length < 5) {
    record.mismatches.push({
      args: show(args).slice(0, 2000),
      compiled: show(compiled),
      js: show(js),
    })
  }
  process.stderr.write(
    `[payload fn-compile] MISMATCH ${record.label}: compiled ${show(compiled)} js ${show(js)}\n`,
  )
}

/**
 * Writes `<PAYLOAD_FN_COMPILE_STATS>/<pid>.json` (a directory) every second and at exit: test
 * workers are often terminated without an `exit` event.
 */
const installStatsWriter = () => {
  const dir = process.env.PAYLOAD_FN_COMPILE_STATS
  if (!dir) {
    return
  }
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${process.pid}.json`)
  const flush = () => {
    flushTimer = undefined
    const fnIr = getFnIr()
    const functions = tracked.map((t) => ({
      ...t,
      ...(t.id !== undefined ? { stats: { ...fnIr.fnIrStats(t.id), calls: t.calls } } : {}),
    }))
    writeFileSync(file, JSON.stringify({ functions, pid: process.pid, testFile: testFile ?? null }))
  }
  // Debounced after every guarded call (node:timers: not affected by a test's fake timers).
  scheduleFlush = () => {
    flushTimer ??= setTimeoutReal(flush, 20).unref()
  }
  flush()
  process.on('exit', flush)
}
