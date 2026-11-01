/**
 * Rust ports of the collection read operations (crates/payload-core-ops, exported by the main
 * addon as `coreOpsBinding()`), as drop-ins with the upstream signatures of
 * `packages/payload/src/collections/operations/*.ts`.
 *
 * The exports are plain functions returning the engine task's promise (not `async` wrappers),
 * so a caller awaiting them takes the same microtask ticks as awaiting the TS `async` function.
 *
 * `PAYLOAD_OPS_AFTER_READ=ts` makes the Rust operations call the TS `afterRead` instead of the
 * Rust traversal (isolates the operations in differential runs).
 */
import { createRequire } from 'node:module'

import type { Access, AccessResult } from '../../../payload/src/config/types.js'

import { afterRead as tsAfterRead } from '../../../payload/src/fields/hooks/afterRead/index.js'
import { getCoreRuntime } from '../runtime/index.js'
import { createOpsHost } from './host.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- drop-ins keep the upstream generics */
type Any = any

export type CoreOpsBinding = {
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

let binding: CoreOpsBinding | undefined

export const getCoreOps = (): CoreOpsBinding => {
  if (binding) {
    return binding
  }
  getCoreRuntime()
  const require = createRequire(import.meta.url)
  // Same resolution as `getCoreRuntime()`: both bindings must come from one addon instance.
  const addonPath =
    process.env.PAYLOAD_CORE_RUNTIME_ADDON ??
    process.env.PAYLOAD_ENGINE_ADDON ??
    '../../payload-engine.node'
  const addon = require(addonPath) as { coreOpsBinding?: () => CoreOpsBinding }
  if (typeof addon.coreOpsBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} has no coreOpsBinding export`)
  }
  const created = addon.coreOpsBinding()
  created.init({
    ...createOpsHost(
      process.env.PAYLOAD_OPS_AFTER_READ === 'ts' ? (tsAfterRead as Any) : undefined,
    ),
    // Harness sensitivity checks only (RUST_OPS_DESIGN.md): a deliberately wrong code path.
    mutant: process.env.RS_OPS_MUTANT ? Number(process.env.RS_OPS_MUTANT) : 0,
  })
  binding = created
  return created
}

export const findOperation = (args: Any): Promise<Any> => getCoreOps().find(args)
export const findByIDOperation = (args: Any): Promise<Any> => getCoreOps().findByID(args)
export const countOperation = (args: Any): Promise<{ totalDocs: number }> =>
  getCoreOps().count(args) as Promise<{ totalDocs: number }>
export const countVersionsOperation = (args: Any): Promise<{ totalDocs: number }> =>
  getCoreOps().countVersions(args) as Promise<{ totalDocs: number }>
export const findDistinctOperation = (args: Any): Promise<Any> => getCoreOps().findDistinct(args)
export const findVersionsOperation = (args: Any): Promise<Any> => getCoreOps().findVersions(args)
export const findVersionByIDOperation = (args: Any): Promise<Any> =>
  getCoreOps().findVersionByID(args)
export const docAccessOperation = (args: Any): Promise<Any> => getCoreOps().docAccess(args)
export const executeAccess = (args: Any, access?: Access): Promise<AccessResult> =>
  getCoreOps().executeAccess(args, access)
export const sanitizeSortQuery = (args: Any): Any => getCoreOps().sanitizeSortQuery(args)
