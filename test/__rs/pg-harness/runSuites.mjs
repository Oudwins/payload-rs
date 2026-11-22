#!/usr/bin/env node
/**
 * Runs upstream int spec files against PostgreSQL through test/__rs/pg-harness/vitest.config.ts,
 * one vitest process per file, each with its own database (created before, dropped afterwards),
 * and records per-test outcomes (vitest JSON reporter).
 *
 *   node test/__rs/pg-harness/runSuites.mjs [options] [files or dirs...]
 *
 * No files: every test/**\/*int.spec.ts outside test/__rs.
 *
 * Options:
 *   --engine ts|rs|default
 *                      ts (default): upstream TS (PAYLOAD_ENGINE=ts, PAYLOAD_CORE_ENGINE unset);
 *                      rs: PAYLOAD_ENGINE=rs (today only the core engine: db-postgres has no Rust
 *                      SQL engine yet, see RUST_POSTGRES_PLAN.md); default: PAYLOAD_ENGINE unset
 *                      (the default selection, i.e. what users get)
 *   --core ts          with --engine rs: PAYLOAD_CORE_ENGINE=ts
 *   --database <name>  PAYLOAD_DATABASE: postgres (default) | postgres-uuid | postgres-uuidv7 |
 *                      postgres-custom-schema (upstream's test/dbAdapters.ts entries, same server;
 *                      the `custom` schema is created in each database for the latter)
 *   --config <file>    vitest config (default test/__rs/pg-harness/vitest.config.ts)
 *   --addon <path>     PAYLOAD_ENGINE_ADDON
 *   --jobs <n>         files in parallel (default 1, the port's rule); files of one test/<suite>
 *                      dir never run together. Every file waits while /tmp has < 3 GB free (until 5 GB).
 *   --timeout <ms>     per file (default 1800000)
 *   --out <dir>        default /tmp/rs-pg-runs/<tag>: summary.json, summary.md, results/, logs/
 *   --tag <name>       database name prefix (default rsp<pid>); databases are <tag>_<n>
 *   --baseline <f>     vitest JSON (e.g. .rs-baseline/postgres-all.json) to compare test statuses
 *                      with (repeatable: a status must match one of the runs)
 *   --write-baseline <f>  merged vitest JSON of this run (first-run results; see the `rerun` field
 *                      of summary.json for re-runs)
 *   --rerun-failed     re-run every file with failed tests (or no result) once alone afterwards and
 *                      classify each failure as `reproduced` or `flaky`
 *   --resume           keep results in <out>/summary.json and only run missing files
 *
 * Exit code 1 when a file differs from the baseline, has no result, or when no test ran.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createDatabase,
  dropDatabases,
  pgUrlFor,
} from '../../../packages/engine-rs/scripts/pg/pgDatabases.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const SUPPORTED_DATABASES = [
  'postgres',
  'postgres-custom-schema',
  'postgres-uuid',
  'postgres-uuidv7',
]

const argv = process.argv.slice(2)
const options = {
  addon: undefined,
  baselines: [],
  config: 'test/__rs/pg-harness/vitest.config.ts',
  core: undefined,
  database: 'postgres',
  engine: 'ts',
  jobs: 1,
  out: undefined,
  rerunFailed: false,
  resume: false,
  tag: `rsp${process.pid}`,
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
  else if (arg === '--jobs') options.jobs = Number(next())
  else if (arg === '--timeout') options.timeout = Number(next())
  else if (arg === '--out') options.out = path.resolve(next())
  else if (arg === '--tag') options.tag = next()
  else if (arg === '--baseline') options.baselines.push(path.resolve(next()))
  else if (arg === '--write-baseline') options.writeBaseline = path.resolve(next())
  else if (arg === '--rerun-failed') options.rerunFailed = true
  else if (arg === '--resume') options.resume = true
  else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
  else inputs.push(arg)
}
if (!SUPPORTED_DATABASES.includes(options.database)) {
  throw new Error(`--database must be one of ${SUPPORTED_DATABASES.join(', ')}`)
}
if (!['default', 'rs', 'ts'].includes(options.engine)) {
  throw new Error('--engine must be ts, rs or default (PAYLOAD_ENGINE unset: Rust)')
}
if (!/^[a-z0-9_]{1,40}$/.test(options.tag)) {
  throw new Error('--tag must be 1-40 characters of [a-z0-9_]')
}
const schemas = options.database === 'postgres-custom-schema' ? ['custom'] : []
const outDir = options.out ?? path.join('/tmp/rs-pg-runs', options.tag)
for (const dir of ['results', 'logs']) {
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
      if (rel.startsWith('test/__rs/') && !inputs.length) {
        continue
      }
      found.add(rel)
    }
  }
  return [...found].sort()
}

const files = discover()

/** Output file stem (injective): `/` → `__`, `_` → `_u`, other non-alphanumerics → `_x` + hex. */
const slugOf = (file) =>
  file
    .replace(/_/g, '_u')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_]/g, (char) => `_x${char.codePointAt(0).toString(16).padStart(6, '0')}`)

const readJSON = (file) => {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

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

/** Disk rule of the port: pause below 3 GB free, resume above 5 GB. */
const waitForDisk = async () => {
  if (freeBytes() >= 3 * GB) return
  process.stdout.write(`[pg-runner] ${(freeBytes() / GB).toFixed(1)} GB free: paused until 5 GB\n`)
  while (freeBytes() < 5 * GB) {
    await new Promise((r) => setTimeout(r, 60_000))
  }
  process.stdout.write(`[pg-runner] ${(freeBytes() / GB).toFixed(1)} GB free: resumed\n`)
}

let dbCounter = 0
const runFile = async (file, { attempt }) => {
  await waitForDisk()
  const dbName = `${options.tag}_${++dbCounter}`
  try {
    await createDatabase(dbName, { schemas })
  } catch (error) {
    process.stderr.write(`[pg-runner] could not create ${dbName}: ${error.message}\n`)
  }
  return runFileNow(file, { attempt, dbName })
}
const runFileNow = (file, { attempt, dbName }) =>
  new Promise((resolve) => {
    const slug = slugOf(file)
    const suffix = attempt === 0 ? '' : `.rerun${attempt}`
    const jsonFile = path.join(outDir, 'results', `${slug}${suffix}.json`)
    const logFile = path.join(outDir, 'logs', `${slug}${suffix}.log`)
    const statsFile = path.join(outDir, 'results', `${slug}${suffix}.stats.json`)
    fs.rmSync(jsonFile, { force: true })
    fs.rmSync(statsFile, { force: true })
    const env = {
      ...process.env,
      PAYLOAD_DATABASE: options.database,
      POSTGRES_URL: pgUrlFor(dbName),
      TZ: 'UTC',
    }
    for (const key of [
      'DATABASE_URL',
      'POSTGRES_REPLICA_URL',
      'PAYLOAD_CORE_ENGINE',
      'PAYLOAD_ENGINE',
      'PAYLOAD_ENGINE_ADDON',
      'PAYLOAD_RS_ENGINE_STATS_FILE',
    ]) {
      delete env[key]
    }
    if (options.engine === 'rs') {
      env.PAYLOAD_ENGINE = 'rs'
      env.PAYLOAD_RS_ENGINE_STATS_FILE = statsFile
      if (options.core) env.PAYLOAD_CORE_ENGINE = options.core
    } else if (options.engine === 'default') {
      env.PAYLOAD_RS_ENGINE_STATS_FILE = statsFile
      if (options.core) env.PAYLOAD_CORE_ENGINE = options.core
    } else {
      // upstream TS (unset selects the Rust engine)
      env.PAYLOAD_ENGINE = 'ts'
    }
    if (options.addon) env.PAYLOAD_ENGINE_ADDON = options.addon
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
        await dropDatabases([dbName])
      } catch (error) {
        process.stderr.write(`[pg-runner] could not drop ${dbName}: ${error.message}\n`)
      }
      resolve({
        code,
        durationMs: Date.now() - started,
        file,
        isTimedOut,
        jsonFile,
        logFile,
        statsFile,
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

const testsOf = (fileResult) =>
  new Map((fileResult?.assertionResults ?? []).map((test) => [test.fullName, test]))

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
  const stats = readJSON(run.statsFile)
  return {
    code: run.code,
    counts,
    differences,
    durationMs: run.durationMs,
    engineCalls: stats?.calls ? Object.values(stats.calls).reduce((a, b) => a + b, 0) : undefined,
    failures,
    file: run.file,
    hasBaseline: baselineRuns.length ? baselineRuns[0].has(run.file) : undefined,
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
  }
}

const summaryFile = path.join(outDir, 'summary.json')
const previous = options.resume ? (readJSON(summaryFile)?.files ?? {}) : {}
const results = { ...previous }
const writeSummary = () =>
  fs.writeFileSync(
    summaryFile,
    JSON.stringify({ files: results, options: { ...options } }, null, 2),
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

const todo = files.filter((file) => !results[file])
process.stdout.write(
  `[pg-runner] ${files.length} files (${todo.length} to run), database ${options.database}, engine ${options.engine}, jobs ${options.jobs}, out ${outDir}\n`,
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
      `[${done}/${todo.length}] ${entry.file}: ${entry.counts.passed}/${entry.counts.failed}/${entry.counts.skipped}${entry.differences.length ? `, ${entry.differences.length} diffs vs baseline` : ''}${entry.loadError ? `, LOAD ERROR ${entry.loadError.split('\n')[0].slice(0, 160)}` : ''} ${Math.round(entry.durationMs / 1000)}s\n`,
    )
  },
)

if (options.rerunFailed) {
  const rerunQueue = Object.values(results)
    .filter((r) => !r.rerun && (r.counts.failed > 0 || r.loadError))
    .map((r) => ({ attempt: 1, file: r.file }))
  process.stdout.write(`[pg-runner] re-running ${rerunQueue.length} files alone\n`)
  await runQueue(rerunQueue, 1, (run) => {
    const again = summarize(run)
    const first = results[run.file]
    const failedAgain = new Set(again.failures.map((f) => f.name))
    first.rerun = {
      counts: again.counts,
      failures: again.failures,
      flaky: first.failures.filter((f) => !failedAgain.has(f.name)).map((f) => f.name),
      loadError: again.loadError,
      newFailures: again.failures
        .filter((f) => !first.failures.some((g) => g.name === f.name))
        .map((f) => f.name),
      reproduced: first.failures.filter((f) => failedAgain.has(f.name)).map((f) => f.name),
    }
    writeSummary()
    process.stdout.write(
      `[rerun] ${run.file}: reproduced ${first.rerun.reproduced.length}, flaky ${first.rerun.flaky.length}${again.loadError ? `, LOAD ERROR ${again.loadError.split('\n')[0].slice(0, 160)}` : ''}\n`,
    )
  })
}

const list = Object.values(results).sort((a, b) => a.file.localeCompare(b.file))
if (options.writeBaseline) {
  const testResults = []
  for (const r of list) {
    const fileResult = readJSON(path.join(outDir, 'results', `${slugOf(r.file)}.json`))
      ?.testResults?.[0]
    if (fileResult) {
      // repo-relative names: the baseline must not depend on the checkout path
      testResults.push({ ...fileResult, name: path.relative(root, fileResult.name) })
    }
  }
  fs.writeFileSync(
    options.writeBaseline,
    JSON.stringify({ database: options.database, engine: options.engine, testResults }),
  )
}

const totals = list.reduce(
  (sum, r) => ({
    differing:
      sum.differing + (r.differences.length || r.loadError || r.hasBaseline === false ? 1 : 0),
    failed: sum.failed + r.counts.failed,
    passed: sum.passed + r.counts.passed,
    skipped: sum.skipped + r.counts.skipped,
  }),
  { differing: 0, failed: 0, passed: 0, skipped: 0 },
)
let md = `database ${options.database}, engine ${options.engine}${options.baselines.length ? `, baselines ${options.baselines.map((f) => path.relative(root, f)).join(', ')}` : ''}\n\n`
md += `| file | pass/fail/skip | ${options.baselines.length ? 'diffs vs baseline | ' : ''}rerun |\n|---|---|${options.baselines.length ? '---|' : ''}---|\n`
for (const r of list) {
  md += `| ${r.file} | ${r.counts.passed}/${r.counts.failed}/${r.counts.skipped}${r.loadError ? ` (${r.loadError === 'timeout' ? 'timeout' : 'load error'})` : ''} | ${options.baselines.length ? `${r.differences.length}${r.hasBaseline === false ? ' (no baseline)' : ''} | ` : ''}${r.rerun ? `reproduced ${r.rerun.reproduced.length}, flaky ${r.rerun.flaky.length}` : ''} |\n`
}
md += `\n**${list.length - totals.differing}/${list.length} files clean**, tests ${totals.passed} passed / ${totals.failed} failed / ${totals.skipped} skipped\n`
for (const r of list) {
  if (r.differences.length || r.loadError) {
    md += `\n### ${r.file}\n`
    if (r.loadError) md += `load error: ${r.loadError.split('\n').slice(0, 3).join(' / ')}\n`
    for (const d of r.differences) {
      md += `- ${d.name} (${d.baseline} -> ${d.status})${d.failure ? `: ${d.failure}` : ''}\n`
    }
  }
}
fs.writeFileSync(path.join(outDir, 'summary.md'), md)
process.stdout.write(`\n${md}`)
if (totals.differing > 0 || totals.passed + totals.failed === 0) {
  process.exitCode = 1
}
