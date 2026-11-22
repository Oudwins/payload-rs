#!/usr/bin/env node
/**
 * Runs upstream int spec files against MongoDB through test/__rs/mongo-harness/vitest.config.ts,
 * one vitest process per file, each with its own database (dropped afterwards), and records
 * per-test outcomes (vitest JSON reporter).
 *
 *   node test/__rs/mongo-harness/runSuites.mjs [options] [files or dirs...]
 *
 * No files: every test/**\/*int.spec.ts outside test/__rs (plus test/__rs/mongo-harness specs with
 * --include-rs).
 *
 * Options:
 *   --engine ts|rs|default
 *                      ts (default): upstream TS (PAYLOAD_ENGINE=ts, PAYLOAD_CORE_ENGINE unset);
 *                      rs: PAYLOAD_ENGINE=rs (mongooseAdapter returns withRustMongoEngine);
 *                      default: PAYLOAD_ENGINE unset (the default engine selection, Rust), checked
 *                      like rs. Every
 *                      process writes its Mongo engine stats (PAYLOAD_RS_MONGO_ENGINE_STATS_DIR);
 *                      a file with passing tests but no data-method call served by Rust (live
 *                      engine or stage-1 native MongoEngine), or with the TS loopback engine
 *                      anywhere, counts as differing (see `nativeProof` and the exemption sets).
 *                      PAYLOAD_RS_MONGO_LOOPBACK in the environment is rejected.
 *   --core ts          with --engine rs: PAYLOAD_CORE_ENGINE=ts
 *   --database <name>  PAYLOAD_DATABASE: mongodb (default) | cosmosdb | documentdb | firestore
 *                      (upstream's test/dbAdapters.ts entries with `compatibilityOptions`, same server)
 *   --config <file>    vitest config (default test/__rs/mongo-harness/vitest.config.ts); a
 *                      replacement must keep this config's databaseAdapter.js alias semantics
 *   --addon <path>     PAYLOAD_ENGINE_ADDON
 *   --shadow           PAYLOAD_RS_MONGO_SHADOW=true: differential adapter (reference TS adapter vs
 *                      candidate on a second database), JSONL reports under <out>/reports/<file>/
 *   --candidate <c>    with --shadow: PAYLOAD_RS_MONGO_CANDIDATE (ts | rs | module path), default ts
 *   --strict           with --shadow: PAYLOAD_RS_SHADOW_STRICT=true
 *   --shadow-mode <m>  with --shadow: PAYLOAD_RS_MONGO_SHADOW_MODE serial (default: pairs one at a
 *                      time) | concurrent (no pair serialisation, causal order only; see
 *                      packages/engine-rs/src/shadow-mongo/index.ts)
 *   --jobs <n>         files in parallel (default 1; the port's rule is 1 per agent, see
 *                      .rs-baseline/mongo-coordination.md); files of one test/<suite> dir never run
 *                      together. Every file waits while /tmp has < 3 GB free (until 5 GB).
 *   --timeout <ms>     per file (default 1800000)
 *   --out <dir>        default /tmp/rs-mongo-runs/<tag>: summary.json, summary.md, results/, logs/
 *   --tag <name>       database name prefix (default rsm<pid>); databases are <tag>_<n>[_c]
 *   --baseline <f>     vitest JSON (e.g. .rs-baseline/mongodb-all.json) to compare test statuses
 *                      with (repeatable: a status must match one of the runs)
 *   --write-baseline <f>  merged vitest JSON of this run (failures re-run alone with --rerun-failed
 *                      keep the status of the first run; see the `rerun` field)
 *   --rerun-failed     re-run every file with failed tests (or no result) once alone afterwards and
 *                      classify each failure as `reproduced` or `flaky`
 *   --resume           keep results in <out>/summary.json and only run missing files
 *   --resummarize      run nothing: recompute <out>/summary.json / summary.md from the stored
 *                      artifacts (use with the run's --tag/--out, --engine, --shadow, --baseline)
 *   --include-rs       also run test/__rs/mongo-harness/*.int.spec.ts
 *   --allow-child-process-suites  run suites that spawn Node child processes even when
 *                      /tmp/rs-phase-f-done does not exist (see CHILD_PROCESS_SUITES)
 *
 * Tests are matched with the baseline per file by full name AND occurrence index (vitest reports
 * duplicate full names, e.g. tests generated in a loop with the same title).
 *
 * Exit code 1 when a file differs from the baseline, has no result, a shadow divergence, lacks
 * native-execution proof (--engine rs / --candidate rs), or when no test ran. With --rerun-failed,
 * a file whose first run differed but whose solo rerun matches the baseline (no load error, proof
 * present) counts as clean and is listed as "solo rerun clean"; shadow divergences never do.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  dropDatabases,
  mongoUrlFor,
} from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'
import { readEngineStats, readJSON, testsOf } from './runnerLib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** Spawn Node children that import test/databaseAdapter.js (or build their own adapter). */
export const CHILD_PROCESS_SUITES = [
  'test/cli/int.spec.ts',
  'test/create-payload-app/int.spec.ts',
  'test/database/migrations-cli.int.spec.ts',
  'test/llm-instructions/cli.int.spec.ts',
  'test/loader/int.spec.ts',
  'test/plugin-mcp/instructions.int.spec.ts',
  'test/queues/cli.int.spec.ts',
  'test/queues/int.spec.ts',
]

const argv = process.argv.slice(2)
/**
 * Files that never create a MongoDB adapter (no Payload instance, or their own non-Mongo adapter):
 * no Mongo engine stats are expected there with --engine rs. Each entry was checked (spec source:
 * no Payload initialization; --engine rs run: no stats file in any process) and must stay justified.
 */
export const FILES_WITHOUT_MONGO_ADAPTER = new Set([
  // fixture with a config, but no test reads `payload`, so the fixture never initializes it
  'test/__helpers/int/configImport.int.spec.ts',
  // `test.suite(name, {}, ...)`: no config, no Payload instance
  'test/__helpers/shared/getTestSuiteDir.int.spec.ts',
  'test/admin-routing/int.spec.ts',
  'test/dashboard/int.spec.ts',
  'test/types/int.spec.ts',
  // reads only the sanitized `config` fixture (editor config), never `payload`
  'test/lexical-mdx/int.spec.ts',
  // scaffolds projects in temp dirs (pnpm installs); never initializes a Payload instance itself
  'test/create-payload-app/int.spec.ts',
  // child processes only import configs (test/loader/init.js awaits the sanitized config, exits)
  'test/loader/int.spec.ts',
])

/**
 * Like FILES_WITHOUT_MONGO_ADAPTER, for the listed `--database` values only (the tests that use
 * Payload are skipped there; the rest never initialize it).
 */
export const FILES_WITHOUT_MONGO_ADAPTER_ON = {
  // the transaction-isolation tests are skipped without transactions; the remaining test is static
  'test/custom-graphql/int.spec.ts': ['cosmosdb', 'firestore'],
}

/**
 * Files that create a MongoDB adapter but never call one of its data methods (they test db-mongodb
 * utilities directly): proof there = the live engine was installed on the adapter (`engines.live`),
 * with zero data-method calls on either engine.
 */
export const FILES_WITHOUT_DATA_METHOD_CALLS = new Set([
  // calls db-mongodb's buildJoinAggregation / buildProjectionFromSelect on `payload.db` directly
  'test/joins/buildJoinAggregation.int.spec.ts',
])

const options = {
  addon: undefined,
  allowChildProcessSuites: fs.existsSync('/tmp/rs-phase-f-done'),
  baselines: [],
  candidate: 'ts',
  config: 'test/__rs/mongo-harness/vitest.config.ts',
  core: undefined,
  database: 'mongodb',
  engine: 'ts',
  includeRs: false,
  jobs: 1,
  out: undefined,
  rerunFailed: false,
  resume: false,
  resummarize: false,
  shadow: false,
  shadowMode: 'serial',
  strict: false,
  tag: `rsm${process.pid}`,
  timeout: 1_800_000,
  writeBaseline: undefined,
}
const inputs = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const next = () => argv[++i]
  if (arg === '--engine') options.engine = next()
  else if (arg === '--core') options.core = next()
  else if (arg === '--database') options.database = next()
  else if (arg === '--config') options.config = path.relative(root, path.resolve(next()))
  else if (arg === '--addon') options.addon = path.resolve(next())
  else if (arg === '--shadow') options.shadow = true
  else if (arg === '--candidate') options.candidate = next()
  else if (arg === '--strict') options.strict = true
  else if (arg === '--shadow-mode') options.shadowMode = next()
  else if (arg === '--jobs') options.jobs = Number(next())
  else if (arg === '--timeout') options.timeout = Number(next())
  else if (arg === '--out') options.out = path.resolve(next())
  else if (arg === '--tag') options.tag = next()
  else if (arg === '--baseline') options.baselines.push(path.resolve(next()))
  else if (arg === '--write-baseline') options.writeBaseline = path.resolve(next())
  else if (arg === '--rerun-failed') options.rerunFailed = true
  else if (arg === '--resume') options.resume = true
  else if (arg === '--resummarize') options.resummarize = true
  else if (arg === '--include-rs') options.includeRs = true
  else if (arg === '--allow-child-process-suites') options.allowChildProcessSuites = true
  else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
  else inputs.push(arg)
}
if (!['cosmosdb', 'documentdb', 'firestore', 'mongodb'].includes(options.database)) {
  throw new Error('--database must be mongodb, cosmosdb, documentdb or firestore')
}
if (!['concurrent', 'serial'].includes(options.shadowMode)) {
  throw new Error('--shadow-mode must be serial or concurrent')
}
if (!['default', 'rs', 'ts'].includes(options.engine)) {
  throw new Error('--engine must be ts, rs or default')
}
const isNativeExpected =
  options.engine === 'rs' ||
  options.engine === 'default' ||
  (options.shadow && options.candidate === 'rs')
if (isNativeExpected && process.env.PAYLOAD_RS_MONGO_LOOPBACK) {
  // the loopback engine is TS: a run through it proves nothing about the Rust engine
  throw new Error(
    'PAYLOAD_RS_MONGO_LOOPBACK is set: unset it for --engine rs / --candidate rs (native runs only)',
  )
}
if (!/^[a-zA-Z0-9_]{1,40}$/.test(options.tag)) {
  throw new Error('--tag must be 1-40 characters of [a-zA-Z0-9_]')
}
const outDir = options.out ?? path.join('/tmp/rs-mongo-runs', options.tag)
for (const dir of ['results', 'logs', 'reports', 'stats']) {
  fs.mkdirSync(path.join(outDir, dir), { recursive: true })
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : walk(full)
    }
    return entry.name.endsWith('int.spec.ts') ? [full] : []
  })

const discover = () => {
  const roots = inputs.length ? inputs : ['test']
  const found = new Set()
  for (const input of roots) {
    const abs = path.resolve(root, input)
    const list = fs.statSync(abs).isDirectory() ? walk(abs) : [abs]
    for (const file of list) {
      const rel = path.relative(root, file)
      const isRs = rel.startsWith('test/__rs/')
      if (
        isRs &&
        !(inputs.length || (options.includeRs && rel.startsWith('test/__rs/mongo-harness/')))
      ) {
        continue
      }
      found.add(rel)
    }
  }
  return [...found].sort()
}

const allFiles = discover()
const deferred = options.allowChildProcessSuites
  ? []
  : allFiles.filter((file) => CHILD_PROCESS_SUITES.includes(file))
const files = allFiles.filter((file) => !deferred.includes(file))

/** Output file stem (injective): `/` → `__`, `_` → `_u`, other non-alphanumerics → `_x` + hex. */
const slugOf = (file) =>
  file
    .replace(/_/g, '_u')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_]/g, (char) => `_x${char.codePointAt(0).toString(16).padStart(6, '0')}`)

const baselineRuns = options.baselines.map(
  (file) =>
    new Map(readJSON(file).testResults.map((result) => [path.relative(root, result.name), result])),
)

/** Free bytes on the volume of /tmp. */
const freeBytes = () => {
  const stats = fs.statfsSync('/tmp')
  return stats.bavail * stats.bsize
}
const GB = 1024 ** 3

/**
 * Disk rule of the port (.rs-baseline/mongo-coordination.md, lead 15:40): pause below 3 GB free,
 * resume above 5 GB.
 */
const waitForDisk = async () => {
  if (freeBytes() >= 3 * GB) return
  process.stdout.write(
    `[mongo-runner] ${(freeBytes() / GB).toFixed(1)} GB free: paused until 5 GB\n`,
  )
  while (freeBytes() < 5 * GB) {
    await new Promise((r) => setTimeout(r, 60_000))
  }
  process.stdout.write(`[mongo-runner] ${(freeBytes() / GB).toFixed(1)} GB free: resumed\n`)
}

let dbCounter = 0
/** Output paths of one run of `file` (`attempt` 0 = first run, n = n-th solo rerun). */
const artifactsOf = (file, attempt) => {
  const slug = slugOf(file)
  const suffix = attempt === 0 ? '' : `.rerun${attempt}`
  return {
    jsonFile: path.join(outDir, 'results', `${slug}${suffix}.json`),
    logFile: path.join(outDir, 'logs', `${slug}${suffix}.log`),
    reportDir: path.join(outDir, 'reports', `${slug}${suffix}`),
    statsDir: path.join(outDir, 'stats', `${slug}${suffix}`),
  }
}

const runFile = async (file, { attempt }) => {
  await waitForDisk()
  return runFileNow(file, { attempt })
}
const runFileNow = (file, { attempt }) =>
  new Promise((resolve) => {
    const dbName = `${options.tag}_${++dbCounter}`
    const { jsonFile, logFile, reportDir, statsDir } = artifactsOf(file, attempt)
    fs.rmSync(jsonFile, { force: true })
    fs.rmSync(statsDir, { force: true, recursive: true })
    fs.mkdirSync(statsDir, { recursive: true })
    fs.rmSync(reportDir, { force: true, recursive: true })
    const env = {
      ...process.env,
      MONGODB_URL: mongoUrlFor(dbName),
      PAYLOAD_DATABASE: options.database,
      TZ: 'UTC',
    }
    for (const key of [
      'DATABASE_URL',
      'PAYLOAD_CORE_ENGINE',
      'PAYLOAD_ENGINE',
      'PAYLOAD_ENGINE_ADDON',
      'PAYLOAD_RS_MONGO_CANDIDATE',
      'PAYLOAD_RS_MONGO_CANDIDATE_URL',
      'PAYLOAD_RS_MONGO_SHADOW',
      'PAYLOAD_RS_MONGO_SHADOW_MODE',
      'PAYLOAD_RS_SHADOW_STRICT',
      'PAYLOAD_RS_REPORT_DIR',
      'PAYLOAD_RS_ENGINE_STATS_FILE',
      'PAYLOAD_RS_MONGO_ENGINE_STATS_DIR',
      'PAYLOAD_RS_MONGO_ENGINE_STATS_FILE',
      'PAYLOAD_RS_MONGO_LOOPBACK',
    ]) {
      delete env[key]
    }
    // every process (incl. child processes) writes mongo-engine-<pid>.json there
    env.PAYLOAD_RS_MONGO_ENGINE_STATS_DIR = statsDir
    if (options.engine === 'rs') {
      env.PAYLOAD_ENGINE = 'rs'
      if (options.core) env.PAYLOAD_CORE_ENGINE = options.core
    } else if (options.engine === 'default') {
      if (options.core) env.PAYLOAD_CORE_ENGINE = options.core
    } else {
      // upstream TS (unset selects the Rust engine)
      env.PAYLOAD_ENGINE = 'ts'
    }
    if (options.addon) env.PAYLOAD_ENGINE_ADDON = options.addon
    const candidateDb = `${dbName}_c`
    if (options.shadow) {
      env.PAYLOAD_RS_MONGO_SHADOW = 'true'
      env.PAYLOAD_RS_MONGO_CANDIDATE = options.candidate
      env.PAYLOAD_RS_MONGO_CANDIDATE_URL = mongoUrlFor(candidateDb)
      env.PAYLOAD_RS_REPORT_DIR = reportDir
      env.PAYLOAD_RS_MONGO_SHADOW_MODE = options.shadowMode
      if (options.strict) env.PAYLOAD_RS_SHADOW_STRICT = 'true'
    }
    const started = Date.now()
    const child = spawn(
      'pnpm',
      [
        'test:int',
        '--config',
        options.config,
        '--reporter=json',
        // suite-level errors (hook timeouts) only show up in the default reporter's output
        '--reporter=default',
        `--outputFile.json=${jsonFile}`,
        file,
      ],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const log = fs.createWriteStream(logFile)
    child.stdout.pipe(log)
    child.stderr.pipe(log)
    let isTimedOut = false
    const timer = setTimeout(() => {
      isTimedOut = true
      child.kill('SIGKILL')
    }, options.timeout)
    child.on('close', async (code) => {
      clearTimeout(timer)
      log.end()
      try {
        await dropDatabases([dbName, candidateDb])
      } catch (error) {
        process.stderr.write(`[mongo-runner] could not drop ${dbName}: ${error.message}\n`)
      }
      resolve({
        code,
        durationMs: Date.now() - started,
        file,
        isTimedOut,
        jsonFile,
        logFile,
        reportDir,
        statsDir,
      })
    })
  })

const statusOf = (status) =>
  status === undefined
    ? 'missing'
    : status === 'passed'
      ? 'passed'
      : status === 'failed'
        ? 'failed'
        : 'skipped'

/** Totals of the JSONL shadow reports of one file (all processes). */
const readShadowReports = (dir) => {
  const out = {
    calls: 0,
    dbChecks: 0,
    divergences: 0,
    first: [],
    modes: [],
    orderedCandidates: 0,
    overlappingCandidates: 0,
    pairsReleased: 0,
    racesResynced: 0,
    rawMirrored: 0,
    unshadowed: {},
  }
  if (!fs.existsSync(dir)) {
    return undefined
  }
  // stats records are cumulative per shadow adapter instance (written at destroy and at the end of
  // the test file): only the last one of each instance counts
  const statsByInstance = new Map()
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.type === 'stats') {
        statsByInstance.set(record.instance ?? `${name}:${statsByInstance.size}`, record)
      } else if (record.type === 'divergence') {
        out.divergences++
        if (out.first.length < 5) {
          out.first.push(
            `${record.method}${record.collection ? `(${record.collection})` : ''} ${record.testName ?? record.finishedTest ?? ''}: ${JSON.stringify(record.differences?.[0] ?? {}).slice(0, 300)}`,
          )
        }
      }
    }
  }
  for (const record of statsByInstance.values()) {
    out.calls += record.calls ?? 0
    out.dbChecks += record.dbChecks ?? 0
    out.rawMirrored += record.rawMirrored ?? 0
    out.orderedCandidates += record.orderedCandidates ?? 0
    out.overlappingCandidates += record.overlappingCandidates ?? 0
    out.pairsReleased += record.pairsReleased ?? 0
    out.racesResynced += record.racesResynced ?? 0
    if (record.mode && !out.modes.includes(record.mode)) out.modes.push(record.mode)
    for (const [key, count] of Object.entries(record.unshadowed ?? {})) {
      out.unshadowed[key] = (out.unshadowed[key] ?? 0) + count
    }
  }
  return out
}

/** First suite-level error (e.g. a `beforeAll` hook timeout) of a vitest log. */
const suiteErrorFromLog = (logFile) => {
  try {
    const log = fs.readFileSync(logFile, 'utf8')
    const index = log.indexOf('Failed Suites')
    return index === -1
      ? undefined
      : log
          .slice(index, index + 600)
          .split('\n')
          .slice(1, 6)
          .join(' ')
          .trim()
  } catch {
    return undefined
  }
}

const summarize = (run) => {
  const fileResult = readJSON(run.jsonFile)?.testResults?.[0]
  const tests = testsOf(fileResult)
  const counts = { failed: 0, passed: 0, skipped: 0 }
  const failures = []
  for (const [name, test] of tests) {
    const status = statusOf(test.status)
    counts[status === 'missing' ? 'skipped' : status]++
    if (status === 'failed') {
      failures.push({
        message: (test.failureMessages ?? []).join('\n').split('\n').slice(0, 4).join('\n'),
        name,
      })
    }
  }
  const differences = []
  const referenceFlaky = []
  if (baselineRuns.length) {
    const baseRunsTests = baselineRuns.map((runMap) => testsOf(runMap.get(run.file)))
    for (const [name, test] of tests) {
      const status = statusOf(test.status)
      const baseStatuses = baseRunsTests.map((t) => statusOf(t.get(name)?.status))
      if (new Set(baseStatuses).size > 1) referenceFlaky.push({ name, reference: baseStatuses })
      if (!baseStatuses.includes(status)) {
        differences.push({
          baseline: baseStatuses[0],
          failure: (test.failureMessages ?? []).join('\n').split('\n')[0],
          name,
          status,
        })
      }
    }
    for (const [name, test] of baseRunsTests[0]) {
      if (!tests.has(name) && !baseRunsTests.some((t) => !t.has(name))) {
        differences.push({ baseline: statusOf(test.status), name, status: 'missing' })
      }
    }
  }
  const stats = readEngineStats(run.statsDir)
  // a file where no test passed proves nothing either way (its statuses are still compared)
  const hasPassedTests = counts.passed > 0
  // native execution proof: the Rust engine served data methods, no loopback engine anywhere
  const nativeProof = !isNativeExpected
    ? undefined
    : stats.loopback > 0
      ? `loopback engine used (${stats.loopback})`
      : !hasPassedTests ||
          stats.nativeCalls > 0 ||
          FILES_WITHOUT_MONGO_ADAPTER.has(run.file) ||
          FILES_WITHOUT_MONGO_ADAPTER_ON[run.file]?.includes(options.database) ||
          (FILES_WITHOUT_DATA_METHOD_CALLS.has(run.file) && stats.live > 0 && stats.calls === 0)
        ? undefined
        : `no Rust-served data method call (${stats.files} stats files, ${stats.live} live engines, ${stats.native} stage-1 native engines)`
  return {
    code: run.code,
    counts,
    differences,
    durationMs: run.durationMs,
    engineCalls: stats.calls,
    engineStats: stats,
    failures,
    file: run.file,
    hasBaseline: baselineRuns.length ? baselineRuns[0].has(run.file) : undefined,
    nativeProof,
    loadError: run.isTimedOut
      ? 'timeout'
      : fileResult
        ? fileResult.status === 'failed' && counts.failed === 0
          ? String(
              fileResult.message ||
                suiteErrorFromLog(run.logFile) ||
                'file failed without a failed test',
            ).slice(0, 2000)
          : undefined
        : 'no json result',
    referenceFlaky,
    shadow: options.shadow ? readShadowReports(run.reportDir) : undefined,
  }
}

const summaryFile = path.join(outDir, 'summary.json')
const previous = options.resume || options.resummarize ? (readJSON(summaryFile)?.files ?? {}) : {}
const results = { ...previous }
const writeSummary = () =>
  fs.writeFileSync(
    summaryFile,
    JSON.stringify({ deferred, files: results, options: { ...options } }, null, 2),
  )

const suiteOf = (file) => file.split('/').slice(0, 2).join('/')
const runQueue = async (queue, jobs, onResult) => {
  const running = new Set()
  await Promise.all(
    Array.from({ length: Math.max(1, jobs) }, async () => {
      while (queue.length) {
        const index = queue.findIndex(({ file }) => !running.has(suiteOf(file)))
        if (index === -1) {
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        const [item] = queue.splice(index, 1)
        running.add(suiteOf(item.file))
        try {
          onResult(await runFile(item.file, item))
        } finally {
          running.delete(suiteOf(item.file))
        }
      }
    }),
  )
}

if (options.resummarize) {
  // recompute every entry (baseline comparison, native proof, shadow totals) from the stored
  // vitest JSON, logs, stats and reports of the first run and of the solo rerun
  for (const entry of Object.values(results)) {
    const fresh = summarize({
      ...artifactsOf(entry.file, 0),
      code: entry.code,
      durationMs: entry.durationMs,
      file: entry.file,
      isTimedOut: entry.loadError === 'timeout',
    })
    if (entry.rerun) {
      fresh.rerun = rerunRecordOf(
        fresh,
        summarize({
          ...artifactsOf(entry.file, 1),
          durationMs: 0,
          file: entry.file,
          isTimedOut: entry.rerun.loadError === 'timeout',
        }),
      )
    }
    results[entry.file] = fresh
  }
  writeSummary()
}

const todo = options.resummarize ? [] : files.filter((file) => !results[file])
process.stdout.write(
  `[mongo-runner] ${files.length} files (${todo.length} to run, ${deferred.length} child-process suites deferred), engine ${options.engine}${options.shadow ? `, shadow candidate ${options.candidate} (${options.shadowMode})` : ''}, jobs ${options.jobs}, out ${outDir}\n`,
)
let done = 0
await runQueue(
  todo.map((file) => ({ attempt: 0, file })),
  options.jobs,
  (run) => {
    const entry = summarize(run)
    results[run.file] = entry
    writeSummary()
    done++
    process.stdout.write(
      `[${done}/${todo.length}] ${entry.file}: ${entry.counts.passed}/${entry.counts.failed}/${entry.counts.skipped}${entry.differences.length ? `, ${entry.differences.length} diffs vs baseline` : ''}${isNativeExpected ? `, ${entry.engineStats.nativeCalls} native calls${entry.nativeProof ? ` (NO PROOF: ${entry.nativeProof})` : ''}` : ''}${entry.shadow ? `, ${entry.shadow.divergences} divergences, ${entry.shadow.calls} calls` : ''}${entry.loadError ? `, LOAD ERROR ${entry.loadError.split('\n')[0].slice(0, 160)}` : ''} ${Math.round(entry.durationMs / 1000)}s\n`,
    )
  },
)

if (options.rerunFailed && !options.resummarize) {
  const rerunQueue = Object.values(results)
    .filter((r) => !r.rerun && (r.counts.failed > 0 || r.loadError))
    .map((r) => ({ attempt: 1, file: r.file }))
  process.stdout.write(`[mongo-runner] re-running ${rerunQueue.length} files alone\n`)
  await runQueue(rerunQueue, 1, (run) => {
    const first = results[run.file]
    first.rerun = rerunRecordOf(first, summarize(run))
    writeSummary()
    process.stdout.write(
      `[rerun] ${run.file}: reproduced ${first.rerun.reproduced.length}, flaky ${first.rerun.flaky.length}${first.rerun.loadError ? `, LOAD ERROR ${first.rerun.loadError.split('\n')[0].slice(0, 160)}` : ''}\n`,
    )
  })
}

/** Outcome of a solo rerun compared with the first run of the same file. */
function rerunRecordOf(first, again) {
  const failedAgain = new Set(again.failures.map((f) => f.name))
  return {
    counts: again.counts,
    differences: again.differences,
    // the solo rerun matches the baseline: the first run's difference was the environment
    // (load timeouts, server restarts), not the engine. Counted clean, listed as such.
    isClean: !again.differences.length && !again.loadError && !again.nativeProof,
    flaky: first.failures.filter((f) => !failedAgain.has(f.name)).map((f) => f.name),
    loadError: again.loadError,
    newFailures: again.failures
      .filter((f) => !first.failures.some((g) => g.name === f.name))
      .map((f) => f.name),
    reproduced: first.failures.filter((f) => failedAgain.has(f.name)).map((f) => f.name),
  }
}

const list = Object.values(results).sort((a, b) => a.file.localeCompare(b.file))
if (options.writeBaseline) {
  const testResults = []
  for (const r of list) {
    const fileResult = readJSON(path.join(outDir, 'results', `${slugOf(r.file)}.json`))
      ?.testResults?.[0]
    if (fileResult) {
      // repo-relative names: the baseline is checked in
      testResults.push({ ...fileResult, name: path.relative(root, fileResult.name) })
    }
  }
  fs.writeFileSync(
    options.writeBaseline,
    JSON.stringify({ database: options.database, engine: options.engine, testResults }),
  )
}

/** A file differs unless its run (or, after a first-run difference, its solo rerun) is clean. */
const isFirstRunDiffering = (r) =>
  Boolean(
    r.differences.length ||
    r.loadError ||
    r.nativeProof ||
    r.hasBaseline === false ||
    (r.shadow && r.shadow.divergences),
  )
const isDiffering = (r) =>
  isFirstRunDiffering(r) && !(r.rerun?.isClean && !(r.shadow && r.shadow.divergences))

const totals = list.reduce(
  (sum, r) => ({
    differing: sum.differing + (isDiffering(r) ? 1 : 0),
    divergences: sum.divergences + (r.shadow?.divergences ?? 0),
    failed: sum.failed + r.counts.failed,
    passed: sum.passed + r.counts.passed,
    shadowCalls: sum.shadowCalls + (r.shadow?.calls ?? 0),
    skipped: sum.skipped + r.counts.skipped,
  }),
  { differing: 0, divergences: 0, failed: 0, passed: 0, shadowCalls: 0, skipped: 0 },
)
let md = `database ${options.database}, engine ${options.engine}${options.shadow ? `, shadow candidate ${options.candidate} (${options.shadowMode} mode)` : ''}${options.baselines.length ? `, baselines ${options.baselines.map((f) => path.relative(root, f)).join(', ')}` : ''}\n\n`
md += `| file | pass/fail/skip | ${options.baselines.length ? 'diffs vs baseline | ' : ''}${isNativeExpected ? 'native engine calls | ' : ''}${options.shadow ? 'shadow calls | db checks | raw mirrored | overlapping candidates | divergences | ' : ''}rerun |\n|---|---|${options.baselines.length ? '---|' : ''}${isNativeExpected ? '---|' : ''}${options.shadow ? '---|---|---|---|---|' : ''}---|\n`
for (const r of list) {
  md += `| ${r.file} | ${r.counts.passed}/${r.counts.failed}/${r.counts.skipped}${r.loadError ? ` (${r.loadError === 'timeout' ? 'timeout' : 'load error'})` : ''} | ${options.baselines.length ? `${r.differences.length}${r.hasBaseline === false ? ' (no baseline)' : ''} | ` : ''}${isNativeExpected ? `${r.engineStats?.nativeCalls ?? '-'}${r.nativeProof ? ' (no proof)' : ''} | ` : ''}${options.shadow ? `${r.shadow?.calls ?? '-'} | ${r.shadow?.dbChecks ?? '-'} | ${r.shadow?.rawMirrored ?? '-'} | ${r.shadow?.overlappingCandidates ?? '-'} | ${r.shadow?.divergences ?? 'no report'} | ` : ''}${r.rerun ? `reproduced ${r.rerun.reproduced.length}, flaky ${r.rerun.flaky.length}${r.rerun.isClean ? ', rerun clean' : ''}` : ''} |\n`
}
const unreported = options.shadow ? list.filter((r) => !r.shadow).map((r) => r.file) : []
if (unreported.length) {
  md += `\nNo shadow report (the file created no shadowed adapter): ${unreported.join(', ')}\n`
}
md += `\n**${list.length - totals.differing}/${list.length} files clean**, tests ${totals.passed} passed / ${totals.failed} failed / ${totals.skipped} skipped${options.shadow ? `, ${totals.shadowCalls} shadowed calls, ${totals.divergences} divergences` : ''}${deferred.length ? `; deferred (child processes, /tmp/rs-phase-f-done missing): ${deferred.join(', ')}` : ''}\n`
for (const r of list) {
  if (isFirstRunDiffering(r)) {
    md += `\n### ${r.file}${isDiffering(r) ? '' : ' (solo rerun clean)'}\n`
    if (r.rerun) {
      md += `rerun: ${r.rerun.counts.passed}/${r.rerun.counts.failed}/${r.rerun.counts.skipped}, ${r.rerun.differences?.length ?? '?'} diffs vs baseline${r.rerun.loadError ? `, load error ${r.rerun.loadError.split('\n')[0].slice(0, 160)}` : ''}\n`
    }
    if (r.loadError) md += `load error: ${r.loadError.split('\n').slice(0, 3).join(' / ')}\n`
    if (r.nativeProof) md += `native execution not proven: ${r.nativeProof}\n`
    for (const d of r.differences) {
      md += `- ${d.name} (${d.baseline} -> ${d.status})${d.failure ? `: ${d.failure}` : ''}\n`
    }
    for (const d of r.shadow?.first ?? []) md += `- divergence: ${d}\n`
  }
}
fs.writeFileSync(path.join(outDir, 'summary.md'), md)
process.stdout.write(`\n${md}`)
if (totals.differing > 0 || totals.passed + totals.failed === 0) {
  process.exitCode = 1
}
