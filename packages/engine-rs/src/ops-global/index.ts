/**
 * Rust ports of the global operations (`packages/payload/src/globals/operations/*.ts`) and the auth
 * operations (`packages/payload/src/auth/operations/*.ts`), crates/payload-core-ops-global,
 * exported by the main addon as `coreOpsGlobalBinding()`. Payload's operation modules load this
 * file (dynamic import) when the Rust engine is selected: `PAYLOAD_OPS_GLOBAL_ENGINE=rs|ts` if set,
 * else `PAYLOAD_CORE_ENGINE=rs|ts`, else `PAYLOAD_ENGINE=rs` (see RUST_OPS_DESIGN.md).
 *
 * The exports are plain functions returning the engine task's promise (not `async` wrappers), so a
 * caller awaiting them takes the same microtask ticks as awaiting the TS `async` function; a
 * failure to load the engine rejects the returned promise like a throw inside the TS function.
 *
 * `PAYLOAD_RS_OPS_STATS_DIR=<dir>`: every process writes `<dir>/ops-global-<pid>.json` with the
 * number of calls each Rust operation served (throttled, and at exit).
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { getCoreOps } from '../ops/index.js'
import { getCoreOpsWrite } from '../ops-write/index.js'
import { createOpsGlobalHost } from './host.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- drop-ins keep the upstream generics */
type Any = any

const operationNames = [
  'globalFindOne',
  'globalUpdate',
  'globalFindVersions',
  'globalFindVersionByID',
  'globalCountVersions',
  'globalRestoreVersion',
  'globalDocAccess',
  'globalValidate',
  'login',
  'logout',
  'me',
  'refresh',
  'forgotPassword',
  'resetPassword',
  'registerFirstUser',
  'unlock',
  'verifyEmail',
  'access',
  'auth',
  'authInit',
] as const

type OperationName = (typeof operationNames)[number]

export type CoreOpsGlobalBinding = {
  /** Host-helper contract version (crates/payload-core-ops-global/src/binding.rs `API_VERSION`). */
  apiVersion?: number
  init: (host: Record<string, unknown>) => void
} & Record<OperationName, (args: unknown) => Promise<unknown>>

let binding: CoreOpsGlobalBinding | undefined

/** The binding contract this host implements (crates/payload-core-ops-global/src/binding.rs). */
const CORE_OPS_GLOBAL_API_VERSION = 1

export const getOpsGlobal = (): CoreOpsGlobalBinding => {
  if (binding) {
    return binding
  }
  // Installs the core runtime host and the collection operations' host (executeAccess,
  // buildBeforeOperation / buildAfterOperation and their helpers) on the same addon instance, and
  // the write operations' host (the global validate runs their `runValidationLifecycle` port).
  getCoreOps()
  getCoreOpsWrite()
  const require = createRequire(import.meta.url)
  const addonPath =
    process.env.PAYLOAD_CORE_RUNTIME_ADDON ??
    process.env.PAYLOAD_ENGINE_ADDON ??
    '../../payload-engine.node'
  const addon = require(addonPath) as { coreOpsGlobalBinding?: () => CoreOpsGlobalBinding }
  if (typeof addon.coreOpsGlobalBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} has no coreOpsGlobalBinding export`)
  }
  const created = addon.coreOpsGlobalBinding()
  if (created.apiVersion !== CORE_OPS_GLOBAL_API_VERSION) {
    throw new Error(
      `The engine addon at ${addonPath} has core global/auth ops API version ${created.apiVersion}, expected ${CORE_OPS_GLOBAL_API_VERSION}; rebuild it`,
    )
  }
  created.init(createOpsGlobalHost())
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
    path.join(statsDir!, `ops-global-${process.pid}.json`),
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

/** Calls served by the Rust global/auth operations in this process, per operation. */
export const getOpsGlobalCalls = (): Partial<Record<OperationName, number>> => ({ ...calls })

/**
 * Called by payload's dispatch when an operation ran before this module finished loading (the call
 * then waits for the load, which adds microtask ticks upstream does not have).
 */
export const recordDeferredCall = (): void => {
  deferredCalls++
}

export const getDeferredCalls = (): number => deferredCalls

const operation =
  (name: OperationName) =>
  (args: Any): Promise<Any> => {
    let ops: CoreOpsGlobalBinding
    try {
      ops = getOpsGlobal()
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the caught value, unchanged
      return Promise.reject(error)
    }
    recordCall(name)
    return ops[name](args) as Promise<Any>
  }

// globals/operations
export const globalFindOneOperation = operation('globalFindOne')
export const globalUpdateOperation = operation('globalUpdate')
export const globalFindVersionsOperation = operation('globalFindVersions')
export const globalFindVersionByIDOperation = operation('globalFindVersionByID')
export const countGlobalVersionsOperation = operation('globalCountVersions')
export const globalRestoreVersionOperation = operation('globalRestoreVersion')
export const globalDocAccessOperation = operation('globalDocAccess')
export const globalValidateOperation = operation('globalValidate')

// auth/operations
export const loginOperation = operation('login')
export const logoutOperation = operation('logout')
export const meOperation = operation('me')
export const refreshOperation = operation('refresh')
export const forgotPasswordOperation = operation('forgotPassword')
export const resetPasswordOperation = operation('resetPassword')
export const registerFirstUserOperation = operation('registerFirstUser')
export const unlockOperation = operation('unlock')
export const verifyEmailOperation = operation('verifyEmail')
export const accessOperation = operation('access')
export const auth = operation('auth')
export const initOperation = operation('authInit')
