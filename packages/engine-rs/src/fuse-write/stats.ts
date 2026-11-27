import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { registerFlushOnFileEnd } from '../flushOnFileEnd.js'

/**
 * Fused write counters (FUSED_WRITES.md section 9). With `PAYLOAD_RS_FUSE_STATS_DIR` set, every
 * process writes `fuse-writes-<pid>.json` (throttled, and at exit) and appends the write
 * lane-shadow's differences to `fuse-writes-diffs-<pid>.jsonl`.
 */
type Counts = Record<string, number>

export type FuseWriteStats = {
  /** Calls the fused lane started and handed to the exact lane, per reason. */
  bails: Counts
  /** Of `hits`: the writes whose result was given as bytes (the REST write byte lanes). */
  bytes: Counts
  /** Shadow mode: fused writes that differed from the exact lane. */
  diffs: number
  /** Calls refused by a per-call guard, per reason. */
  guards: Counts
  /** Fused writes committed (or compared, in shadow mode), per operation. */
  hits: Counts
  /** Calls on collections whose write plan is ineligible, per reason. */
  ineligible: Counts
  /** Shadow mode: calls whose fused lane and exact lane both threw the same error. */
  sameError: Counts
}

/**
 * One table per process, on `globalThis` (every copy of this module, source or dist entry, counts
 * into it; test/__rs/fuse-writes reads it there).
 */
const statsKey = Symbol.for('@payloadcms/engine-rs/fuse-write-stats')
const created: FuseWriteStats = {
  bails: {},
  bytes: {},
  diffs: 0,
  guards: {},
  hits: {},
  ineligible: {},
  sameError: {},
}
export const stats: FuseWriteStats = Reflect.get(globalThis, statsKey) ?? created
Reflect.set(globalThis, statsKey, stats)

const statsDir = process.env.PAYLOAD_RS_FUSE_STATS_DIR
let lastWrite = 0

const write = () => {
  writeFileSync(path.join(statsDir!, `fuse-writes-${process.pid}.json`), JSON.stringify(stats))
}

// Written synchronously (throttled, plus once more at exit): timers could be faked by the suite.
const flush = () => {
  if (!statsDir) {
    return
  }
  if (lastWrite === 0) {
    process.once('exit', write)
    // vitest ends its workers without an `exit` event (test/__rs/mongo-harness/flushOnFileEnd.ts)
    registerFlushOnFileEnd(write)
  }
  const now = performance.now()
  if (now - lastWrite > 250) {
    lastWrite = now
    write()
  }
}

export const count = (table: Record<string, number>, key: string) => {
  table[key] = (table[key] ?? 0) + 1
  flush()
}

export const recordDiff = (entry: Record<string, unknown>) => {
  stats.diffs++
  if (statsDir) {
    appendFileSync(
      path.join(statsDir, `fuse-writes-diffs-${process.pid}.jsonl`),
      JSON.stringify(entry) + '\n',
    )
  }
  flush()
}
