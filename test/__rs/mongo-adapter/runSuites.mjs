#!/usr/bin/env node
/**
 * Runs upstream int spec files through test/__rs/mongo-adapter/vitest.config.ts (the harness
 * adapter wrapped by `withRustMongoEngine`), one vitest process per file with its own database
 * (dropped afterwards), and compares every test's status with a TS baseline.
 *
 *   node test/__rs/mongo-adapter/runSuites.mjs [--native] [--addon <path>] [--jobs n] [--tag t]
 *     [--baseline <vitest json>] [--baseline-dir <dir of per-file vitest json>] [files or dirs...]
 *
 * Default engine: the TS loopback (`PAYLOAD_RS_MONGO_LOOPBACK=true`); `--native`: the addon's
 * `MongoEngine`. `--baseline-dir` reads `<dir>/<slug>.json` as written by
 * test/__rs/mongo-harness/runSuites.mjs (`results/`). Out: /tmp/rs-mongo-runs/<tag>/
 * (summary.json, results/, logs/). Child-process suites are skipped while /tmp/rs-phase-f-done is
 * missing. `--resummarize --tag <t>`: recompute the comparison of the stored results of run <t>
 * (e.g. against a newer baseline) without running anything. Exit code 1 when a test differs from the baseline, a file has no result or no test ran.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  dropDatabases,
  mongoUrlFor,
} from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'

/** test/__rs/mongo-harness/runSuites.mjs `CHILD_PROCESS_SUITES` (that module runs on import). */
const CHILD_PROCESS_SUITES = [
  'test/cli/int.spec.ts',
  'test/create-payload-app/int.spec.ts',
  'test/database/migrations-cli.int.spec.ts',
  'test/llm-instructions/cli.int.spec.ts',
  'test/loader/int.spec.ts',
  'test/plugin-mcp/instructions.int.spec.ts',
  'test/queues/cli.int.spec.ts',
  'test/queues/int.spec.ts',
]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const argv = process.argv.slice(2)
const options = {
  addon: undefined,
  baseline: undefined,
  baselineDir: undefined,
  jobs: 1,
  native: false,
  tag: `rsma${process.pid}`,
  resummarize: false,
  timeout: 1_800_000,
}
const inputs = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const next = () => argv[++i]
  if (arg === '--native') options.native = true
  else if (arg === '--addon') options.addon = path.resolve(next())
  else if (arg === '--baseline') options.baseline = path.resolve(next())
  else if (arg === '--baseline-dir') options.baselineDir = path.resolve(next())
  else if (arg === '--jobs') options.jobs = Number(next())
  else if (arg === '--tag') options.tag = next()
  else if (arg === '--resummarize') options.resummarize = true
  else if (arg === '--timeout') options.timeout = Number(next())
  else inputs.push(arg)
}

const findSpecs = (dir) =>
  fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || rel === 'test/__rs' ? [] : findSpecs(rel)
    }
    return entry.name.endsWith('int.spec.ts') ? [rel] : []
  })

const files = (inputs.length ? inputs : ['test'])
  .flatMap((input) => {
    const rel = path.relative(root, path.resolve(root, input))
    return fs.statSync(path.join(root, rel)).isDirectory() ? findSpecs(rel) : [rel]
  })
  .sort()
const isPhaseFDone = fs.existsSync('/tmp/rs-phase-f-done')
const deferred = isPhaseFDone ? [] : files.filter((file) => CHILD_PROCESS_SUITES.includes(file))
const todo = files.filter((file) => !deferred.includes(file))

const outDir = path.join('/tmp/rs-mongo-runs', options.tag)
fs.mkdirSync(path.join(outDir, 'results'), { recursive: true })
fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true })

const slugOf = (file) =>
  file
    .replace(/_/g, '_u')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_]/g, (c) => `_x${c.codePointAt(0).toString(16).padStart(6, '0')}`)

const readJSON = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

const baselineMap = options.baseline
  ? new Map(
      readJSON(options.baseline).testResults.map((result) => [
        path.relative(root, result.name),
        result,
      ]),
    )
  : undefined
const baselineOf = (file) =>
  baselineMap
    ? baselineMap.get(file)
    : options.baselineDir
      ? readJSON(path.join(options.baselineDir, `${slugOf(file)}.json`))?.testResults?.[0]
      : undefined

const statusOf = (status) =>
  status === undefined ? 'missing' : ['passed', 'failed'].includes(status) ? status : 'skipped'
const testsOf = (fileResult) =>
  new Map((fileResult?.assertionResults ?? []).map((test) => [test.fullName, test]))

let dbCounter = 0
const runFile = (file) =>
  new Promise((resolve) => {
    const slug = slugOf(file)
    const dbName = `${options.tag}_${++dbCounter}`
    const jsonFile = path.join(outDir, 'results', `${slug}.json`)
    const statsFile = path.join(outDir, 'results', `${slug}.stats.json`)
    const logFile = path.join(outDir, 'logs', `${slug}.log`)
    fs.rmSync(jsonFile, { force: true })
    fs.rmSync(statsFile, { force: true })
    const env = {
      ...process.env,
      MONGODB_URL: mongoUrlFor(dbName),
      PAYLOAD_DATABASE: 'mongodb',
      PAYLOAD_RS_MONGO_ENGINE_STATS_FILE: statsFile,
      TZ: 'UTC',
    }
    for (const key of [
      'DATABASE_URL',
      'PAYLOAD_CORE_ENGINE',
      'PAYLOAD_ENGINE',
      'PAYLOAD_RS_MONGO_SHADOW',
    ]) {
      delete env[key]
    }
    if (options.native) delete env.PAYLOAD_RS_MONGO_LOOPBACK
    else env.PAYLOAD_RS_MONGO_LOOPBACK = 'true'
    if (options.addon) env.PAYLOAD_ENGINE_ADDON = options.addon
    const started = Date.now()
    const child = spawn(
      'pnpm',
      [
        'test:int',
        '--config',
        'test/__rs/mongo-adapter/vitest.config.ts',
        '--reporter=json',
        `--outputFile=${jsonFile}`,
        file,
      ],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const log = fs.createWriteStream(logFile)
    child.stdout.pipe(log)
    child.stderr.pipe(log)
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout)
    child.on('close', async (code) => {
      clearTimeout(timer)
      log.end()
      await dropDatabases([dbName]).catch(() => {})
      resolve({ code, durationMs: Date.now() - started, file, jsonFile, statsFile })
    })
  })

const summarize = (run) => {
  const fileResult = readJSON(run.jsonFile)?.testResults?.[0]
  const tests = testsOf(fileResult)
  const counts = { failed: 0, passed: 0, skipped: 0 }
  for (const test of tests.values()) {
    const status = statusOf(test.status)
    counts[status === 'missing' ? 'skipped' : status]++
  }
  const baseline = baselineOf(run.file)
  const differences = []
  if (baseline) {
    const baseTests = testsOf(baseline)
    for (const [name, test] of tests) {
      const base = statusOf(baseTests.get(name)?.status)
      const status = statusOf(test.status)
      if (base !== status) {
        differences.push({
          baseline: base,
          failure: (test.failureMessages ?? []).join('\n').split('\n').slice(0, 3).join(' | '),
          name,
          status,
        })
      }
    }
    for (const [name, test] of baseTests) {
      if (!tests.has(name)) {
        differences.push({ baseline: statusOf(test.status), name, status: 'missing' })
      }
    }
  }
  const stats = readJSON(run.statsFile)
  return {
    code: run.code,
    counts,
    differences,
    durationMs: run.durationMs,
    engineCalls: stats ? Object.values(stats.calls).reduce((a, b) => a + b, 0) : 0,
    file: run.file,
    hasBaseline: Boolean(baseline),
    hostOps: stats?.hostOps,
    loadError: fileResult
      ? fileResult.status === 'failed' && tests.size === 0
        ? String(fileResult.message).slice(0, 2000)
        : undefined
      : 'no json result',
  }
}

const results = {}
if (options.resummarize) {
  for (const name of fs.readdirSync(path.join(outDir, 'results'))) {
    if (!name.endsWith('.json') || name.endsWith('.stats.json')) continue
    const jsonFile = path.join(outDir, 'results', name)
    const fileName = readJSON(jsonFile)?.testResults?.[0]?.name
    if (!fileName) continue
    const file = path.relative(root, fileName)
    results[file] = summarize({
      code: 0,
      durationMs: 0,
      file,
      jsonFile,
      statsFile: jsonFile.replace(/\.json$/, '.stats.json'),
    })
  }
  todo.length = 0
}
const summaryFile = path.join(outDir, 'summary.json')
const writeSummary = () =>
  fs.writeFileSync(summaryFile, JSON.stringify({ deferred, files: results, options }, null, 2))

process.stdout.write(
  `[mongo-adapter] ${todo.length} files (${deferred.length} child-process suites deferred), ${options.native ? 'native' : 'loopback'} engine, jobs ${options.jobs}, out ${outDir}\n`,
)
const queue = [...todo]
const running = new Set()
/** Files of one test/<suite> dir share fixtures (uploads, media dirs): never run together. */
const suiteOf = (file) => file.split('/').slice(0, 2).join('/')
let done = 0
await Promise.all(
  Array.from({ length: Math.max(1, options.jobs) }, async () => {
    while (queue.length) {
      const index = queue.findIndex((file) => !running.has(suiteOf(file)))
      if (index === -1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }
      const [file] = queue.splice(index, 1)
      running.add(suiteOf(file))
      let entry
      try {
        entry = summarize(await runFile(file))
      } finally {
        running.delete(suiteOf(file))
      }
      results[entry.file] = entry
      writeSummary()
      process.stdout.write(
        `[${++done}/${todo.length}] ${entry.file}: ${entry.counts.passed}/${entry.counts.failed}/${entry.counts.skipped}, ${entry.engineCalls} engine calls${entry.hasBaseline ? `, ${entry.differences.length} diffs` : ', no baseline'}${entry.loadError ? `, LOAD ERROR ${entry.loadError.split('\n')[0].slice(0, 160)}` : ''} ${Math.round(entry.durationMs / 1000)}s\n`,
      )
      for (const difference of entry.differences.slice(0, 8)) {
        process.stdout.write(
          `    ${difference.baseline} -> ${difference.status}: ${difference.name}${difference.failure ? `\n      ${difference.failure.slice(0, 300)}` : ''}\n`,
        )
      }
    }
  }),
)

const all = Object.values(results)
const totals = all.reduce(
  (acc, entry) => {
    acc.passed += entry.counts.passed
    acc.failed += entry.counts.failed
    acc.skipped += entry.counts.skipped
    acc.differences += entry.differences.length
    acc.engineCalls += entry.engineCalls
    return acc
  },
  { differences: 0, engineCalls: 0, failed: 0, passed: 0, skipped: 0 },
)
for (const entry of all.filter((e) => e.differences.length || e.loadError || !e.hasBaseline)) {
  process.stdout.write(
    `${entry.file}: ${entry.hasBaseline ? `${entry.differences.length} diffs` : 'no baseline'}${entry.loadError ? ', LOAD ERROR' : ''}\n`,
  )
  for (const difference of entry.differences.slice(0, 8)) {
    process.stdout.write(`    ${difference.baseline} -> ${difference.status}: ${difference.name}\n`)
  }
}
writeSummary()
process.stdout.write(`[mongo-adapter] totals ${JSON.stringify(totals)}\n`)
const isBad =
  totals.passed + totals.failed === 0 ||
  all.some((entry) => entry.differences.length || entry.loadError)
process.exit(isBad ? 1 : 0)
