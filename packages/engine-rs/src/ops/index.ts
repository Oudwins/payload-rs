/**
 * Rust ports of the collection read operations (crates/payload-core-ops, exported by the main
 * addon as `coreOpsBinding()`), as drop-ins with the upstream signatures of
 * `packages/payload/src/collections/operations/*.ts`. Payload's operation modules load this file
 * (dynamic import) when the Rust core engine is selected (`PAYLOAD_ENGINE=rs`, overridable with
 * `PAYLOAD_CORE_ENGINE=rs|ts`), see RUST_OPS_DESIGN.md.
 *
 * The exports are plain functions returning the engine task's promise (not `async` wrappers),
 * so a caller awaiting them takes the same microtask ticks as awaiting the TS `async` function;
 * a failure to load the engine rejects the returned promise like a throw inside the TS function.
 *
 * - `PAYLOAD_OPS_AFTER_READ=ts`: the Rust operations call the TS `afterRead` instead of the Rust
 *   traversal (isolates the operations in differential runs).
 * - `PAYLOAD_RS_OPS_STATS_DIR=<dir>`: every process writes `<dir>/ops-<pid>.json` with the number of
 *   calls each Rust operation served (throttled, and at exit) so suite runs can prove the engine ran.
 * - `RS_OPS_MUTANT=<n>`: harness sensitivity checks only; needs an addon built with the
 *   `payload-core-ops/mutants` feature (the shipped addon rejects it at init).
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { Access, AccessResult } from '../../../payload/src/config/types.js'

import { afterRead as tsAfterRead } from '../../../payload/src/fields/hooks/afterRead/index.js'
import { getCoreQueryBinding } from '../query/index.js'
import { getCoreRuntime } from '../runtime/index.js'
import { createOpsHost } from './host.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- drop-ins keep the upstream generics */
type Any = any

export type CoreOpsBinding = {
  /** Host-helper contract version (crates/payload-core-ops/src/binding.rs `API_VERSION`), checked
   * at load against `CORE_OPS_API_VERSION`. */
  apiVersion?: number
  count: (args: unknown) => Promise<unknown>
  countVersions: (args: unknown) => Promise<unknown>
  docAccess: (args: unknown) => Promise<unknown>
  executeAccess: (args: unknown, access?: Access) => Promise<AccessResult>
  find: (args: unknown) => Promise<unknown>
  findByID: (args: unknown) => Promise<unknown>
  findDistinct: (args: unknown) => Promise<unknown>
  findVersionByID: (args: unknown) => Promise<unknown>
  findVersions: (args: unknown) => Promise<unknown>
  init: (host: Record<string, unknown>) => void
  sanitizeSortQuery: (args: unknown) => unknown
}

type OperationName = Exclude<keyof CoreOpsBinding, 'apiVersion' | 'init' | 'sanitizeSortQuery'>

let binding: CoreOpsBinding | undefined

/** The binding contract this host implements (crates/payload-core-ops/src/binding.rs `API_VERSION`). */
const CORE_OPS_API_VERSION = 2

export const getCoreOps = (): CoreOpsBinding => {
  if (binding) {
    return binding
  }
  getCoreRuntime()
  // The operations call the live query port (crates/payload-core-query) directly: its host must
  // be installed on the same addon instance.
  getCoreQueryBinding()
  const require = createRequire(import.meta.url)
  // Same resolution as `getCoreRuntime()`: all bindings must come from one addon instance.
  const addonPath =
    process.env.PAYLOAD_CORE_RUNTIME_ADDON ??
    process.env.PAYLOAD_ENGINE_ADDON ??
    '../../payload-engine.node'
  const addon = require(addonPath) as { coreOpsBinding?: () => CoreOpsBinding }
  if (typeof addon.coreOpsBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} has no coreOpsBinding export`)
  }
  const created = addon.coreOpsBinding()
  if (created.apiVersion !== CORE_OPS_API_VERSION) {
    throw new Error(
      `The engine addon at ${addonPath} has core ops API version ${created.apiVersion}, expected ${CORE_OPS_API_VERSION}; rebuild it`,
    )
  }
  created.init({
    ...createOpsHost(
      process.env.PAYLOAD_OPS_AFTER_READ === 'ts' ? (tsAfterRead as Any) : undefined,
    ),
    ...(process.env.RS_OPS_MUTANT ? { mutant: Number(process.env.RS_OPS_MUTANT) } : {}),
  })
  binding = created
  return created
}

// ------------------------------------------------------------------------------------------
// stats

const statsDir = process.env.PAYLOAD_RS_OPS_STATS_DIR
const calls: Partial<Record<OperationName, number>> = {}
let deferredCalls = 0
let lastStatsWrite = 0

const writeStats = () => {
  writeFileSync(
    path.join(statsDir!, `ops-${process.pid}.json`),
    JSON.stringify({ calls, deferredCalls }),
  )
}

// Written synchronously (throttled, plus once more at exit): timers could be faked by the suite.
const recordCall = (name: OperationName) => {
  calls[name] = (calls[name] ?? 0) + 1
  if (!statsDir) {
    return
  }
  if (lastStatsWrite === 0) {
    process.once('exit', writeStats)
  }
  const now = performance.now()
  if (now - lastStatsWrite > 250) {
    lastStatsWrite = now
    writeStats()
  }
}

/** Calls served by the Rust operations in this process (harness guards). */
export const getOpsCallCount = (): number =>
  Object.values(calls).reduce((sum, n) => sum + (n ?? 0), 0)

/**
 * Called by payload's dispatch when an operation ran before this module finished loading (the call
 * then waits for the load, which adds microtask ticks upstream does not have).
 */
export const recordDeferredCall = (): void => {
  deferredCalls++
}

const operation =
  (name: OperationName) =>
  (args: Any): Promise<Any> => {
    let ops: CoreOpsBinding
    try {
      ops = getCoreOps()
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the caught value, unchanged
      return Promise.reject(error)
    }
    recordCall(name)
    return ops[name](args) as Promise<Any>
  }

export const findOperation = operation('find')
export const findByIDOperation = operation('findByID')
export const countOperation = operation('count') as (args: Any) => Promise<{ totalDocs: number }>
export const countVersionsOperation = operation('countVersions') as (
  args: Any,
) => Promise<{ totalDocs: number }>
export const findDistinctOperation = operation('findDistinct')
export const findVersionsOperation = operation('findVersions')
export const findVersionByIDOperation = operation('findVersionByID')
export const docAccessOperation = operation('docAccess')
export const executeAccess = (args: Any, access?: Access): Promise<AccessResult> => {
  let ops: CoreOpsBinding
  try {
    ops = getCoreOps()
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the caught value, unchanged
    return Promise.reject(error)
  }
  recordCall('executeAccess')
  return ops.executeAccess(args, access)
}
export const sanitizeSortQuery = (args: Any): Any => getCoreOps().sanitizeSortQuery(args)
