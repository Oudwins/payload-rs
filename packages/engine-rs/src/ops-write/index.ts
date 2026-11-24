/**
 * Rust ports of the collection write operations (crates/payload-core-ops-write, exported by the
 * main addon as `coreOpsWriteBinding()`), as drop-ins with the upstream signatures of
 * `packages/payload/src/collections/operations/{create,update,updateByID,delete,deleteByID,
 * duplicate,restoreVersion,validate}.ts`. payload's operation modules forward to these when
 * `PAYLOAD_ENGINE=rs` (overridable with `PAYLOAD_CORE_ENGINE=rs|ts`).
 *
 * The exports are plain functions returning the engine task's promise (not `async` wrappers), so
 * a caller awaiting them takes the same microtask ticks as awaiting the TS `async` function.
 *
 * `PAYLOAD_OPS_WRITE_TRAVERSALS=ts` makes the Rust operations call the TS field traversals
 * (beforeValidate, beforeChange, afterChange, afterRead) instead of the Rust ports (isolates the
 * operations in differential runs).
 *
 * With `PAYLOAD_RS_ENGINE_STATS_FILE` set (test/__rs/adapter/runSuites.mjs), the number of
 * operations the crate served and of calls that waited for this module to load are written
 * (throttled, and at exit) to `<file>.ops-write.json`.
 */
import { writeFileSync } from 'node:fs'

import { afterChange as tsAfterChange } from '../../../payload/src/fields/hooks/afterChange/index.js'
import { afterRead as tsAfterRead } from '../../../payload/src/fields/hooks/afterRead/index.js'
import { beforeChange as tsBeforeChange } from '../../../payload/src/fields/hooks/beforeChange/index.js'
import { beforeValidate as tsBeforeValidate } from '../../../payload/src/fields/hooks/beforeValidate/index.js'
import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../addon.js'
import { getCoreOps } from '../ops/index.js'
import { getCoreHooksAfter } from '../runtime/afterChange/binding.js'
import { getBeforeChangeBinding } from '../runtime/beforeChange/index.js'
import { getBeforeValidateBinding } from '../runtime/beforeValidate/index.js'
import { createOpsWriteHost } from './host.js'
import { isAdapterTransactionEnabled, runInAdapterTransaction } from './transactionLanes.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- drop-ins keep the upstream generics */
type Any = any

export type CoreOpsWriteBinding = {
  /** Host-helper contract version (crates/payload-core-ops-write/src/binding.rs `API_VERSION`). */
  apiVersion?: number
  create: (args: unknown) => Promise<unknown>
  delete: (args: unknown) => Promise<unknown>
  deleteByID: (args: unknown) => Promise<unknown>
  duplicate: (args: unknown) => Promise<unknown>
  init: (host: Record<string, unknown>) => void
  restoreVersion: (args: unknown) => Promise<unknown>
  /** Number of operations the crate has served in this process. */
  stats: () => number
  update: (args: unknown) => Promise<unknown>
  updateByID: (args: unknown) => Promise<unknown>
  updateDocument: (args: unknown) => Promise<unknown>
  validate: (args: unknown) => Promise<unknown>
}

let binding: CoreOpsWriteBinding | undefined

/** The binding contract this host implements (crates/payload-core-ops-write/src/binding.rs). */
const CORE_OPS_WRITE_API_VERSION = 1

export const getCoreOpsWrite = (): CoreOpsWriteBinding => {
  if (binding) {
    return binding
  }
  // The read operations' binding (executeAccess, before/afterOperation) and the traversal
  // bindings the crate calls directly must be initialized on the same addon instance first.
  getCoreOps()
  getBeforeValidateBinding()
  getBeforeChangeBinding()
  getCoreHooksAfter()
  const addonPath = coreRuntimeAddonPath()
  const addon = loadCoreRuntimeAddon() as { coreOpsWriteBinding?: () => CoreOpsWriteBinding }
  if (typeof addon.coreOpsWriteBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} has no coreOpsWriteBinding export`)
  }
  const created = addon.coreOpsWriteBinding()
  if (created.apiVersion !== CORE_OPS_WRITE_API_VERSION) {
    throw new Error(
      `The engine addon at ${addonPath} has core write ops API version ${created.apiVersion}, expected ${CORE_OPS_WRITE_API_VERSION}; rebuild it`,
    )
  }
  created.init(
    createOpsWriteHost(
      process.env.PAYLOAD_OPS_WRITE_TRAVERSALS === 'ts'
        ? {
            afterChange: tsAfterChange,
            afterRead: tsAfterRead,
            beforeChange: tsBeforeChange,
            beforeValidate: tsBeforeValidate,
          }
        : undefined,
    ),
  )
  binding = created
  return created
}

const statsFile = process.env.PAYLOAD_RS_ENGINE_STATS_FILE
  ? `${process.env.PAYLOAD_RS_ENGINE_STATS_FILE}.ops-write.json`
  : undefined
let deferredCalls = 0
let lastStatsWrite = 0

const writeStats = () => {
  writeFileSync(statsFile!, JSON.stringify({ calls: binding ? binding.stats() : 0, deferredCalls }))
}

// Written synchronously (throttled, plus once more at exit): timers could be faked by the suite.
const recordStats = () => {
  if (lastStatsWrite === 0) {
    process.once('exit', writeStats)
  }
  const now = performance.now()
  if (now - lastStatsWrite > 250) {
    lastStatsWrite = now
    writeStats()
  }
}

type OperationName = Exclude<keyof CoreOpsWriteBinding, 'apiVersion' | 'init' | 'stats'>

const op =
  (name: OperationName) =>
  (args: Any): Promise<Any> => {
    if (isAdapterTransactionEnabled) {
      const owned = runInAdapterTransaction(name, args, () => runOperation(name, args))
      if (owned) {
        return owned
      }
    }
    return runOperation(name, args)
  }

const runOperation = (name: OperationName, args: Any): Promise<Any> => {
  let promise: Promise<Any>
  try {
    promise = getCoreOpsWrite()[name](args)
  } catch (error) {
    // The upstream operations are `async`: a failure to load the engine rejects (same value).
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(error)
  }
  if (statsFile) {
    recordStats()
  }
  return promise
}

export const createOperation = op('create')
export const updateOperation = op('update')
export const updateByIDOperation = op('updateByID')
export const deleteOperation = op('delete')
export const deleteByIDOperation = op('deleteByID')
export const duplicateOperation = op('duplicate')
export const restoreVersionOperation = op('restoreVersion')
export const validateOperation = op('validate')
/** Drop-in for `updateDocument` of `collections/operations/utilities/update.ts`. */
export const updateDocument = op('updateDocument')

/** Operations served by the Rust crate so far in this process (0 before the first call). */
export const getCoreOpsWriteCalls = (): number => (binding ? binding.stats() : 0)

/**
 * Called by payload's dispatch when an operation ran before this module finished loading (the
 * call then waits for the load, which adds microtask ticks upstream does not have).
 */
export const recordDeferredCall = (): void => {
  deferredCalls++
}
