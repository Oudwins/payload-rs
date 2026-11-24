/**
 * Pure helpers of runSuites.mjs (that module runs on import), unit-tested by runnerLib.test.mjs.
 */
import fs from 'node:fs'
import path from 'node:path'

export const readJSON = (file) => {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

/**
 * Tests of one file keyed by full name and occurrence index (`<fullName>` for the first,
 * `<fullName> [#n]` for the n-th repeat): vitest reports duplicate full names.
 */
export const testsOf = (fileResult) => {
  const seen = new Map()
  const out = new Map()
  for (const test of fileResult?.assertionResults ?? []) {
    const occurrence = seen.get(test.fullName) ?? 0
    seen.set(test.fullName, occurrence + 1)
    out.set(occurrence === 0 ? test.fullName : `${test.fullName} [#${occurrence + 1}]`, test)
  }
  return out
}

/**
 * Mongo engine stats of every process of one file (glue `PAYLOAD_RS_MONGO_ENGINE_STATS_DIR`):
 * live Rust engines created and the data-method calls they served (`calls` = `nativeCalls`):
 * calls of the live engine's methods plus reads served by the Rust driver lane (`driver`, which
 * reach no live method).
 */
export const readEngineStats = (dir) => {
  const out = { calls: 0, driver: 0, files: 0, fused: 0, fusedDiffs: 0, live: 0, nativeCalls: 0 }
  if (!dir || !fs.existsSync(dir)) {
    return out
  }
  const sum = (record) => Object.values(record ?? {}).reduce((a, b) => a + b, 0)
  // the fused read lanes' counters (packages/engine-rs/src/fuse/stats.ts): a fused hit is a read
  // operation served by Rust end to end (it makes no adapter call)
  for (const name of fs.readdirSync(dir).filter((n) => /^fuse-\d+\.json$/.test(n))) {
    const stats = readJSON(path.join(dir, name))
    if (!stats) continue
    out.fused += sum(stats.hits)
    out.fusedDiffs += stats.diffs ?? 0
    out.nativeCalls += sum(stats.hits)
  }
  for (const name of fs.readdirSync(dir).filter((n) => /^mongo-engine-\d+\.json$/.test(n))) {
    const stats = readJSON(path.join(dir, name))
    if (!stats) continue
    out.files++
    const liveCalls = sum(stats.liveCalls)
    const driverCalls = sum(stats.driverLane?.served)
    out.calls += liveCalls + driverCalls
    out.driver += driverCalls
    out.live += stats.engines?.live ?? 0
    out.nativeCalls += liveCalls + driverCalls
  }
  return out
}
