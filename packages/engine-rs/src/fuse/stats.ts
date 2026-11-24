import { appendFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Lane counters (FUSE_CONTRACT.md section 7). With `PAYLOAD_RS_FUSE_STATS_DIR` set, every process
 * writes `fuse-<pid>.json` (throttled, and at exit) and appends shadow differences to
 * `fuse-diffs-<pid>.jsonl`.
 */
export type FuseStats = {
  /** Calls refused by a per-call guard, per reason. */
  bails: Record<string, number>
  /** Shadow mode: fused results that differed from the exact lane's. */
  diffs: number
  guards: Record<string, number>
  /** Fused results returned (or compared, in shadow mode), per operation. */
  hits: Record<string, number>
  /** Collections whose plan is ineligible, per reason (counted per call). */
  ineligible: Record<string, number>
  /** Fused results that populated relationships (a subset of `hits`), per operation. */
  populated: Record<string, number>
}

export const stats: FuseStats = {
  bails: {},
  diffs: 0,
  guards: {},
  hits: {},
  ineligible: {},
  populated: {},
}

const statsDir = process.env.PAYLOAD_RS_FUSE_STATS_DIR
let lastWrite = 0

const write = () => {
  writeFileSync(path.join(statsDir!, `fuse-${process.pid}.json`), JSON.stringify(stats))
}

// Written synchronously (throttled, plus once more at exit): timers could be faked by the suite.
const flush = () => {
  if (!statsDir) {
    return
  }
  if (lastWrite === 0) {
    process.once('exit', write)
  }
  const now = performance.now()
  if (now - lastWrite > 250) {
    lastWrite = now
    write()
  }
}

export const count = (table: Record<string, number>, key: string): void => {
  table[key] = (table[key] ?? 0) + 1
  flush()
}

export const recordDiff = (entry: Record<string, unknown>): void => {
  stats.diffs++
  if (statsDir) {
    appendFileSync(
      path.join(statsDir, `fuse-diffs-${process.pid}.jsonl`),
      JSON.stringify(entry) + '\n',
    )
  }
  flush()
}

/** Fused results served in this process (all operations). */
export const getFusedCallCount = (): number =>
  Object.values(stats.hits).reduce((sum, n) => sum + n, 0)
