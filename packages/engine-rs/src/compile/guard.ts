import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { inspect, types } from 'node:util'

import type { ConfigFunction } from './configFunctions.js'
import type { CompiledResult } from './native.js'
import type { AnyFunction } from './snapshot.js'

import { aliasCompiledFunction, compileFunction } from './compileFunction.js'
import { configFunctions } from './configFunctions.js'
import { getFnIr } from './native.js'
import { snapshot, snapshotArgs } from './snapshot.js'

/**
 * Guard mode: every compiled function of the config is replaced by a wrapper that calls the real
 * function (the authority: its result, errors and `this` are returned unchanged) and, for the calls
 * the policy selects (`fnIrShouldVerify`), evaluates the compiled IR on a snapshot of the
 * arguments taken before the call and compares it with the real result. A mismatch de-optimises
 * the function permanently and is logged.
 *
 * `PAYLOAD_FN_COMPILE_GUARD=all` verifies every call; `=sample` the policy default (first 32
 * calls, then 1 in 256). `PAYLOAD_FN_COMPILE_STATS=<dir>` writes `<dir>/<pid>.json`: every
 * function seen, compiled or not (and why), with its counters and mismatches.
 */
type Tracked = {
  calls: number
  compiled: boolean
  id?: number
  kind: string
  label: string
  mismatches: { args: string; compiled: string; js: string }[]
  reason?: string
}

const tracked: Tracked[] = []
const guardedConfigs = new WeakSet<object>()
let exitHookInstalled = false
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
  fnIr.fnIrSetPolicy(mode === 'all' ? Infinity : 32, mode === 'all' ? 1 : 256)
  installExitHook()
  const wrapped = new Map<AnyFunction, AnyFunction>()
  let compiledCount = 0
  const entries = configFunctions(config)
  for (const entry of entries) {
    const result = compileFunction(entry.fn, entry.label)
    const record: Tracked = {
      calls: 0,
      compiled: result.ok,
      kind: entry.kind,
      label: entry.label,
      mismatches: [],
      ...(result.ok ? { id: result.id } : { reason: result.reason }),
    }
    tracked.push(record)
    if (!result.ok) {
      continue
    }
    compiledCount++
    // One wrapper per function object (shared functions appear under several labels).
    let guard = wrapped.get(entry.fn)
    if (!guard) {
      guard = createGuard(entry, result.id, result.argKeys, record)
      wrapped.set(entry.fn, guard)
    }
    entry.replace(guard)
  }
  return { compiled: compiledCount, total: entries.length }
}

const createGuard = (
  entry: ConfigFunction,
  id: number,
  argKeys: (null | string[])[],
  record: Tracked,
): AnyFunction => {
  const fnIr = getFnIr()
  const original = entry.fn
  const compare = (compiled: CompiledResult, args: unknown[], jsResult: unknown) => {
    const outcome = fnIr.fnIrCompare(compiled, snapshot(jsResult))
    fnIr.fnIrRecord(id, outcome)
    if (outcome === 1) {
      logMismatch(record, args, fnIr.fnIrResultToJs(compiled), jsResult)
    }
  }
  const guard = function (this: unknown, ...args: unknown[]) {
    record.calls++
    let compiled: CompiledResult | undefined
    let snapArgs: undefined | unknown[]
    if (fnIr.fnIrIsActive(id) && fnIr.fnIrShouldVerify(id)) {
      snapArgs = snapshotArgs(args, argKeys)
      const evaluated = fnIr.fnIrEvaluate(id, snapArgs)
      if (typeof evaluated === 'string') {
        fnIr.fnIrRecord(id, 2)
      } else {
        compiled = evaluated
      }
    }
    let result: unknown
    try {
      result = Reflect.apply(original, this, args)
    } catch (error) {
      if (compiled) {
        fnIr.fnIrRecord(id, 1)
        logMismatch(record, snapArgs!, fnIr.fnIrResultToJs(compiled), `threw ${String(error)}`)
      }
      throw error
    }
    if (compiled) {
      const c = compiled
      if (types.isPromise(result)) {
        result.then(
          (value) => compare(c, snapArgs!, value),
          (error) => {
            fnIr.fnIrRecord(id, 1)
            logMismatch(record, snapArgs!, fnIr.fnIrResultToJs(c), `rejected ${String(error)}`)
          },
        )
      } else {
        compare(c, snapArgs!, result)
      }
    }
    return result
  }
  Object.defineProperties(guard, Object.getOwnPropertyDescriptors(original))
  Object.setPrototypeOf(guard, Object.getPrototypeOf(original))
  aliasCompiledFunction(guard, original)
  return guard
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
const installExitHook = () => {
  if (exitHookInstalled) {
    return
  }
  exitHookInstalled = true
  const dir = process.env.PAYLOAD_FN_COMPILE_STATS
  if (!dir) {
    return
  }
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${process.pid}.json`)
  const flush = () => {
    const fnIr = getFnIr()
    const functions = tracked.map((t) => ({
      ...t,
      ...(t.id !== undefined ? { stats: fnIr.fnIrStats(t.id) } : {}),
    }))
    writeFileSync(file, JSON.stringify({ functions, pid: process.pid, testFile: testFile ?? null }))
  }
  setInterval(flush, 1000).unref()
  process.on('exit', flush)
}
