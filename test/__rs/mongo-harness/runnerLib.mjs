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
 * adapters served per engine kind (live Rust engine, stage-1 native `MongoEngine`, stage-1 TS
 * loopback) and the data-method calls they served. `nativeCalls` = calls served by Rust (live +
 * stage-1 native); a process with a loopback engine contributes none.
 */
export const readEngineStats = (dir) => {
  const out = { calls: 0, files: 0, live: 0, liveCalls: 0, loopback: 0, native: 0, nativeCalls: 0 }
  if (!dir || !fs.existsSync(dir)) {
    return out
  }
  const sum = (record) => Object.values(record ?? {}).reduce((a, b) => a + b, 0)
  for (const name of fs.readdirSync(dir).filter((n) => /^mongo-engine-\d+\.json$/.test(n))) {
    const stats = readJSON(path.join(dir, name))
    if (!stats) continue
    out.files++
    const stage1Calls = sum(stats.calls)
    const liveCalls = sum(stats.liveCalls)
    out.calls += stage1Calls + liveCalls
    out.liveCalls += liveCalls
    out.live += stats.engines?.live ?? 0
    out.loopback += stats.engines?.loopback ?? 0
    out.native += stats.engines?.native ?? 0
    out.nativeCalls += liveCalls + (stats.engines?.loopback ? 0 : stage1Calls)
  }
  return out
}
