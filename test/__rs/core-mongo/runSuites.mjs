#!/usr/bin/env node
/**
 * Runs upstream int suites on MongoDB with the TS engine and with the Rust core engine
 * (PAYLOAD_CORE_ENGINE=rs: Rust operations, field hooks, validators and query validation on the
 * TS mongoose adapter), each run on its own database, and compares every test's status.
 *
 *   node test/__rs/core-mongo/runSuites.mjs [--addon path] [--out dir] [--jobs n] [--timeout ms]
 *     [--baseline .rs-baseline/mongodb-all.json] [--all] [--allow-child-processes] [--resume] files...
 *
 * Without --baseline every file also runs with the TS engine (PAYLOAD_ENGINE and
 * PAYLOAD_CORE_ENGINE unset) and that run is the reference. --all selects every int spec file of
 * test/ (except storage-*, test/__rs and, unless --allow-child-processes, the suites that spawn
 * processes importing test/databaseAdapter.js).
 *
 * Exits non-zero when a file has no result, compared zero tests, differs from the reference, or
 * when a core run served no Rust call in a file whose reference passed tests (listed only).
 * Databases are dropped after each run.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const mongoose = createRequire(path.join(root, 'packages/db-mongodb/package.json'))('mongoose')

const argv = process.argv.slice(2)
const options = {
  addon: undefined,
  all: false,
  allowChildProcesses: false,
  baseline: undefined,
  jobs: 1,
  out: '/tmp/coremongo-runs/suites',
  resume: false,
  timeout: 1_200_000,
}
const files = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--all') {
    options.all = true
  } else if (arg === '--resume') {
    options.resume = true
  } else if (arg === '--allow-child-processes') {
    options.allowChildProcesses = true
  } else if (arg === '--addon') {
    options.addon = path.resolve(argv[++i])
  } else if (arg === '--baseline') {
    options.baseline = path.resolve(argv[++i])
  } else if (arg === '--out') {
    options.out = path.resolve(argv[++i])
  } else if (arg === '--jobs') {
    options.jobs = Number(argv[++i])
  } else if (arg === '--timeout') {
    options.timeout = Number(argv[++i])
  } else {
    files.push(path.relative(root, path.resolve(root, arg)))
  }
}
mkdirSync(options.out, { recursive: true })

/** Spawn child processes that import test/databaseAdapter.js (codegen hazard, shared state). */
const childProcessSuites = [
  'test/cli/',
  'test/config/int.spec.ts',
  'test/create-payload-app/',
  'test/database/migrations-cli.int.spec.ts',
  'test/llm-instructions/cli.int.spec.ts',
  'test/loader/',
  'test/plugin-mcp/instructions.int.spec.ts',
  'test/queues/',
]

const listSpecs = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === '__rs' ? [] : listSpecs(full)
    }
    return entry.name.endsWith('int.spec.ts') ? [path.relative(root, full)] : []
  })

if (options.all) {
  for (const file of listSpecs(path.join(root, 'test'))) {
    if (
      !file.startsWith('test/storage-') &&
      (options.allowChildProcesses || !childProcessSuites.some((p) => file.startsWith(p))) &&
      !files.includes(file)
    ) {
      files.push(file)
    }
  }
}
if (files.length === 0) {
  throw new Error('no test files given')
}
if (!options.allowChildProcesses) {
  const blocked = files.filter((file) => childProcessSuites.some((p) => file.startsWith(p)))
  if (blocked.length) {
    throw new Error(`these suites spawn child processes (pass --allow-child-processes): ${blocked}`)
  }
}

const baselineByFile = options.baseline
  ? new Map(
      JSON.parse(readFileSync(options.baseline, 'utf8')).testResults.map((file) => [
        path.relative(root, file.name),
        file,
      ]),
    )
  : undefined

/** Output file stem (injective): `/` → `__`, `_` → `_u`, other non-alphanumerics → `_x` + hex. */
const slugOf = (file) =>
  file
    .replace(/_/g, '_u')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_]/g, (char) => `_x${char.codePointAt(0).toString(16).padStart(6, '0')}`)
const mongoURL = (db) =>
  `mongodb://payload:payload@localhost:27018/${db}?authSource=admin&directConnection=true&replicaSet=rs0`

const dropDatabase = async (db) => {
  const connection = await mongoose.createConnection(mongoURL(db)).asPromise()
  try {
    await connection.dropDatabase()
  } finally {
    await connection.close()
  }
}

const runFile = (file, index, engine) =>
  new Promise((resolve) => {
    const slug = `${slugOf(file)}.${engine}`
    const db = `coremongo_${process.pid}_${index}_${engine}`
    const jsonFile = path.join(options.out, `${slug}.json`)
    const coreStatsFile = path.join(options.out, `${slug}.core.json`)
    const opsStatsDir = path.join(options.out, `${slug}.ops`)
    const engineStatsFile = path.join(options.out, `${slug}.engine`)
    const logFile = path.join(options.out, `${slug}.log`)
    rmSync(jsonFile, { force: true })
    rmSync(coreStatsFile, { force: true })
    rmSync(opsStatsDir, { force: true, recursive: true })
    rmSync(`${engineStatsFile}.ops-write.json`, { force: true })
    mkdirSync(opsStatsDir, { recursive: true })
    const env = {
      ...process.env,
      DISABLE_LOGGING: 'true',
      MONGODB_URL: mongoURL(db),
      NODE_NO_WARNINGS: '1',
      NODE_OPTIONS: '--no-deprecation --no-experimental-strip-types',
      PAYLOAD_DATABASE: 'mongodb',
      PAYLOAD_RS_CORE_STATS_FILE: coreStatsFile,
      PAYLOAD_RS_ENGINE_STATS_FILE: engineStatsFile,
      PAYLOAD_RS_OPS_STATS_DIR: opsStatsDir,
      TZ: 'UTC',
    }
    env.PAYLOAD_ENGINE = 'ts'
    delete env.PAYLOAD_CORE_ENGINE
    delete env.DATABASE_URL
    if (engine === 'core') {
      env.PAYLOAD_CORE_ENGINE = 'rs'
      if (options.addon) {
        env.PAYLOAD_ENGINE_ADDON = options.addon
      }
    } else {
      delete env.PAYLOAD_ENGINE_ADDON
    }
    const started = Date.now()
    const child = spawn(
      'pnpm',
      [
        'vitest',
        'run',
        '--config',
        'test/__rs/core-mongo/vitest.config.ts',
        '--project',
        'int',
        '--reporter=json',
        `--outputFile=${jsonFile}`,
        file,
      ],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let log = ''
    child.stdout.on('data', (chunk) => (log += chunk))
    child.stderr.on('data', (chunk) => (log += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout)
    child.on('close', async (code) => {
      clearTimeout(timer)
      writeFileSync(logFile, log)
      await dropDatabase(db).catch((err) => process.stderr.write(`drop ${db}: ${err}\n`))
      resolve({
        code,
        coreStatsFile,
        durationMs: Date.now() - started,
        jsonFile,
        opsStatsDir,
        writeStatsFile: `${engineStatsFile}.ops-write.json`,
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

/** `undefined` for a missing or unreadable (e.g. truncated) JSON file. */
const readJSON = (file) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

const readResult = (jsonFile) => readJSON(jsonFile)?.testResults?.[0]

const countsOf = (tests) => {
  const counts = { failed: 0, passed: 0, skipped: 0 }
  for (const test of tests.values()) {
    counts[statusOf(test.status)]++
  }
  return counts
}

const sumCalls = (object) => Object.values(object ?? {}).reduce((a, b) => a + b, 0)

const opsCallsOf = (dir) => {
  let calls = 0
  let deferred = 0
  for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
    const stats = readJSON(path.join(dir, entry)) ?? {}
    calls += sumCalls(stats.calls)
    deferred += stats.deferredCalls ?? 0
  }
  return { calls, deferred }
}

const compare = ({ file, reference, core }) => {
  const referenceResult = baselineByFile ? baselineByFile.get(file) : readResult(reference.jsonFile)
  const coreResult = readResult(core.jsonFile)
  const referenceTests = testsOf(referenceResult)
  const tests = testsOf(coreResult)
  const differences = []
  for (const [name, test] of tests) {
    const status = statusOf(test.status)
    const referenceStatus = statusOf(referenceTests.get(name)?.status)
    if (referenceStatus !== status) {
      differences.push({
        failure: (test.failureMessages ?? []).join('\n').split('\n').slice(0, 8).join('\n'),
        name,
        reference: referenceStatus,
        referenceFailure: (referenceTests.get(name)?.failureMessages ?? [])
          .join('\n')
          .split('\n')
          .slice(0, 4)
          .join('\n'),
        status,
      })
    }
  }
  for (const [name, test] of referenceTests) {
    if (!tests.has(name)) {
      differences.push({ name, reference: statusOf(test.status), status: 'missing' })
    }
  }
  const coreStats = readJSON(core.coreStatsFile)
  const ops = opsCallsOf(core.opsStatsDir)
  const writeStats = readJSON(core.writeStatsFile)
  ops.calls += writeStats?.calls ?? 0
  ops.deferred += writeStats?.deferredCalls ?? 0
  const loadError = (result) =>
    result
      ? result.status === 'failed' && (result.assertionResults ?? []).length === 0
        ? result.message || 'failed with no tests'
        : undefined
      : 'no json result'
  // a file that failed without a failing test: a suite-level hook failed (its tests are reported
  // as skipped on both sides, which would otherwise compare equal)
  const hookFailure = (result) =>
    result?.status === 'failed' &&
    !(result.assertionResults ?? []).some((test) => test.status === 'failed')
  return {
    core: countsOf(tests),
    hookFailure: hookFailure(coreResult) || hookFailure(referenceResult) || undefined,
    coreDurationMs: core.durationMs,
    coreHookCalls: sumCalls(coreStats?.calls),
    deferred: (coreStats?.deferredCalls ?? 0) + ops.deferred,
    differences,
    file,
    loadError: loadError(coreResult) ?? loadError(referenceResult),
    opsCalls: ops.calls,
    reference: countsOf(referenceTests),
  }
}

const results = []
const summaryFile = path.join(options.out, 'summary.json')
const previous = readJSON(summaryFile) ?? []
// --resume: files with a complete entry in <out>/summary.json are not run again
const isDone = (file) => previous.some((p) => p.file === file && !p.loadError)
const queue = files
  .map((file, index) => ({ file, index }))
  .filter(({ file }) => !(options.resume && isDone(file)))
const suiteDirOf = (file) => file.split(path.sep).slice(0, 2).join(path.sep)
const runningSuites = new Set()
const worker = async () => {
  while (queue.length) {
    const nextIndex = queue.findIndex(({ file }) => !runningSuites.has(suiteDirOf(file)))
    if (nextIndex === -1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      continue
    }
    const [{ file, index }] = queue.splice(nextIndex, 1)
    runningSuites.add(suiteDirOf(file))
    // files of one test/<suite> directory share fixtures on disk: the ts and core runs of a file
    // run one after the other
    const reference = baselineByFile ? undefined : await runFile(file, index, 'ts')
    const core = await runFile(file, index, 'core')
    runningSuites.delete(suiteDirOf(file))
    const entry = compare({ core, file, reference })
    results.push(entry)
    const merged = [...previous.filter((p) => !results.some((r) => r.file === p.file)), ...results]
    writeFileSync(summaryFile, JSON.stringify(merged, null, 2))
    process.stdout.write(
      `${entry.file}: ts ${entry.reference.passed}/${entry.reference.failed}/${entry.reference.skipped} core ${entry.core.passed}/${entry.core.failed}/${entry.core.skipped}, ${entry.differences.length} diffs, ${entry.opsCalls} op calls, ${entry.coreHookCalls} hook calls (${entry.deferred} deferred), ${Math.round(entry.coreDurationMs / 1000)}s${entry.loadError ? ` LOAD ERROR ${String(entry.loadError).slice(0, 200)}` : ''}\n`,
    )
  }
}
await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, worker))

// the report covers every file of <out>/summary.json (earlier runs into the same --out included)
results.splice(0, 0, ...previous.filter((p) => !results.some((r) => r.file === p.file)))
results.sort((a, b) => a.file.localeCompare(b.file))
let md =
  '| suite | ts pass/fail/skip | core pass/fail/skip | diffs | Rust op calls | Rust hook calls |\n|---|---|---|---|---|---|\n'
for (const r of results) {
  md += `| ${r.file} | ${r.reference.passed}/${r.reference.failed}/${r.reference.skipped} | ${r.core.passed}/${r.core.failed}/${r.core.skipped} | ${r.differences.length}${r.loadError ? ' (load error)' : ''} | ${r.opsCalls} | ${r.coreHookCalls} |\n`
}
const total = (side, key) => results.reduce((a, r) => a + r[side][key], 0)
md += `| **total (${results.length} files)** | ${total('reference', 'passed')}/${total('reference', 'failed')}/${total('reference', 'skipped')} | ${total('core', 'passed')}/${total('core', 'failed')}/${total('core', 'skipped')} | ${results.reduce((a, r) => a + r.differences.length, 0)} | ${results.reduce((a, r) => a + r.opsCalls, 0)} | ${results.reduce((a, r) => a + r.coreHookCalls, 0)} |\n`
for (const r of results) {
  if (r.differences.length || r.loadError) {
    md += `\n### ${r.file}\n`
    if (r.loadError) {
      md += `load error: ${String(r.loadError).split('\n').slice(0, 5).join(' / ')}\n`
    }
    for (const d of r.differences) {
      md += `- ${d.name} (${d.reference} -> ${d.status})${d.failure ? `: ${d.failure.split('\n')[0]}` : ''}\n`
    }
  }
}
writeFileSync(path.join(options.out, 'summary.md'), md)
process.stdout.write(`\n${md}`)

const problems = []
for (const r of results) {
  if (r.loadError) {
    problems.push(`${r.file}: ${r.loadError}`)
  } else if (r.core.passed + r.core.failed + r.core.skipped === 0) {
    problems.push(`${r.file}: compared zero tests`)
  }
  if (r.differences.length) {
    problems.push(`${r.file}: ${r.differences.length} differences from the reference`)
  }
  if (r.hookFailure) {
    problems.push(`${r.file}: a suite-level hook failed (tests reported as skipped)`)
  }
  if (r.deferred) {
    problems.push(`${r.file}: ${r.deferred} deferred calls`)
  }
}
const noRust = results.filter((r) => r.reference.passed > 0 && r.opsCalls + r.coreHookCalls === 0)
if (noRust.length) {
  process.stdout.write(`\nfiles without Rust core calls: ${noRust.map((r) => r.file).join(', ')}\n`)
}
if (results.length === 0) {
  problems.push('compared zero files')
}
if (problems.length) {
  process.stdout.write(`\nFAIL\n${problems.map((p) => `- ${p}`).join('\n')}\n`)
  process.exitCode = 1
}
