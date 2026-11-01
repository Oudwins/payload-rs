/**
 * Entry point payload's field-hook modules load (dynamic import) when the Rust core engine is
 * selected (`PAYLOAD_ENGINE=rs`, overridable with `PAYLOAD_CORE_ENGINE=rs|ts`):
 * `packages/payload/src/fields/hooks/{afterRead,beforeValidate,beforeChange,afterChange,beforeDuplicate}/index.ts`.
 * Every export is a drop-in with the upstream signature and return semantics.
 *
 * `PAYLOAD_RS_CORE_STATS_FILE`: writes (throttled, and at exit) how many calls each Rust traversal served
 * (and how many had to wait for this module to load) so suite runs can prove the engine ran.
 */
import { writeFileSync } from 'node:fs'

import { afterChange as afterChangeRS } from './afterChange/index.js'
import { beforeChange as beforeChangeRS } from './beforeChange/index.js'
import { beforeDuplicate as beforeDuplicateRS } from './beforeDuplicate/index.js'
import {
  beforeValidate as beforeValidateRS,
  traverseFields as beforeValidateTraverseFieldsRS,
} from './beforeValidate/index.js'
import { afterRead as afterReadRS, getCoreRuntime } from './index.js'

type HookName = 'afterChange' | 'afterRead' | 'beforeChange' | 'beforeDuplicate' | 'beforeValidate'

const statsFile = process.env.PAYLOAD_RS_CORE_STATS_FILE
const calls: Record<HookName, number> = {
  afterChange: 0,
  afterRead: 0,
  beforeChange: 0,
  beforeDuplicate: 0,
  beforeValidate: 0,
}
let deferredCalls = 0

const writeStats = () => {
  const executor = Object.values(calls).some(Boolean) ? getCoreRuntime().stats() : null
  writeFileSync(statsFile!, JSON.stringify({ calls, deferredCalls, executor }))
}
let lastStatsWrite = 0

// Written synchronously (throttled, plus once more at exit, which vitest workers may skip):
// timers could be faked by the suite.
const recordCall = (name: HookName) => {
  calls[name]++
  if (lastStatsWrite === 0) {
    process.once('exit', writeStats)
  }
  const now = performance.now()
  if (now - lastStatsWrite > 250) {
    lastStatsWrite = now
    writeStats()
  }
}

const counted = <F extends (args: any) => unknown>(name: HookName, fn: F): F =>
  (statsFile
    ? (args: unknown) => {
        recordCall(name)
        return fn(args)
      }
    : fn) as F

export const afterRead = counted('afterRead', afterReadRS)
export const beforeValidate = counted('beforeValidate', beforeValidateRS)
export const beforeChange = counted('beforeChange', beforeChangeRS)
export const afterChange = counted('afterChange', afterChangeRS)
export const beforeDuplicate = counted('beforeDuplicate', beforeDuplicateRS)

/**
 * Drop-in for payload's exported `beforeValidateTraverseFields` (what lexical's beforeValidate
 * editor hook calls for block/link sub-fields). Not wired yet: payload re-exports the TS
 * `traverseFields` from `packages/payload/src/index.ts`.
 */
export const beforeValidateTraverseFields = beforeValidateTraverseFieldsRS

/**
 * Called by payload's dispatch when a hook ran before this module finished loading (the call then
 * waits for the load, which adds microtask ticks upstream does not have).
 */
export const recordDeferredCall = (): void => {
  deferredCalls++
}
