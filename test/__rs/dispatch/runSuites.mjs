#!/usr/bin/env node
/**
 * Runs upstream int suites with the Rust engine (SQL engine + core field hooks + validators) and
 * compares every test's status with the TS baseline (.rs-baseline/sqlite-all.json). Copy of
 * test/__rs/adapter/runSuites.mjs that also records how many calls the Rust core hooks served.
 *
 *   node test/__rs/dispatch/runSuites.mjs [--mode full|core|sql] [--addon path] [--out dir]
 *     [--jobs n] [--timeout ms] [--all] test/hooks/int.spec.ts test/database/int.spec.ts ...
 *
 * --mode full  PAYLOAD_ENGINE=rs (default): Rust SQL engine and Rust core hooks
 * --mode core  PAYLOAD_CORE_ENGINE=rs only: Rust core hooks on the TS SQL adapter
 * --mode sql   PAYLOAD_ENGINE=rs PAYLOAD_CORE_ENGINE=ts: Rust SQL engine only
 * --all        every baseline file that ran sqlite tests (except storage-*, which need services)
 *
 * Exits non-zero when a file has no result, compared zero tests or differs from the baseline. Files
 * where the Rust core hooks served no call (modes full/core) are listed.
 *
 * --loopback   PAYLOAD_RS_ENGINE_LOOPBACK=true (TS stand-in engine; verifies the glue only)
 * --addon      PAYLOAD_ENGINE_ADDON (default: the shared packages/engine-rs/payload-engine.node)
 *
 * Files of one test/<suite> directory never run concurrently. Every file gets its own SQLite file under /tmp (deleted afterwards) and an engine stats file, so
 * the summary shows that the engine served the data methods. Writes <out>/summary.json and prints
 * a markdown table plus every test whose status differs from the baseline.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const argv = process.argv.slice(2)
const options = {
  addon: undefined,
  jobs: 1,
  all: false,
  loopback: false,
  mode: 'full',
  out: '/tmp/rs-dispatch-runs',
  timeout: 1_200_000,
}
const files = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--loopback') {
    options.loopback = true
  } else if (arg === '--mode') {
    options.mode = argv[++i]
  } else if (arg === '--all') {
    options.all = true
  } else if (arg === '--addon') {
    options.addon = path.resolve(argv[++i])
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

const baseline = JSON.parse(readFileSync(path.join(root, '.rs-baseline/sqlite-all.json'), 'utf8'))
const baselineByFile = new Map(
  baseline.testResults.map((file) => [path.relative(root, file.name), file]),
)

if (options.all) {
  for (const file of baseline.testResults) {
    const rel = path.relative(root, file.name)
    const ran = file.assertionResults.some((t) => t.status === 'passed' || t.status === 'failed')
    if (ran && !rel.startsWith('test/storage-') && !rel.startsWith('test/__rs/') && !files.includes(rel)) {
      files.push(rel)
    }
  }
}
if (!['core', 'full', 'sql'].includes(options.mode)) {
  throw new Error(`unknown --mode ${options.mode}`)
}
if (files.length === 0) {
  throw new Error('no test files given')
}

const slugOf = (file) => file.replace(/[^a-zA-Z0-9]+/g, '_')

const runFile = (file, index) =>
  new Promise((resolve) => {
    const slug = slugOf(file)
    const dbFile = `/tmp/rs-dispatch-${process.pid}-${index}.db`
    const jsonFile = path.join(options.out, `${slug}.json`)
    const statsFile = path.join(options.out, `${slug}.stats.json`)
    const coreStatsFile = path.join(options.out, `${slug}.core.json`)
    const logFile = path.join(options.out, `${slug}.log`)
    rmSync(jsonFile, { force: true })
    rmSync(statsFile, { force: true })
    rmSync(coreStatsFile, { force: true })
    const env = {
      ...process.env,
      PAYLOAD_RS_CORE_STATS_FILE: coreStatsFile,
      PAYLOAD_RS_ENGINE_STATS_FILE: statsFile,
      SQLITE_URL: `file:${dbFile}`,
      TZ: 'UTC',
    }
    delete env.PAYLOAD_ENGINE
    delete env.PAYLOAD_CORE_ENGINE
    if (options.mode === 'full') {
      env.PAYLOAD_ENGINE = 'rs'
    } else if (options.mode === 'core') {
      env.PAYLOAD_CORE_ENGINE = 'rs'
    } else {
      env.PAYLOAD_ENGINE = 'rs'
      env.PAYLOAD_CORE_ENGINE = 'ts'
    }
    if (options.loopback) {
      env.PAYLOAD_RS_ENGINE_LOOPBACK = 'true'
    }
    if (options.addon) {
      env.PAYLOAD_ENGINE_ADDON = options.addon
    }
    const started = Date.now()
    const child = spawn(
      'pnpm',
      [
        'test:int:sqlite',
        '--config',
        'test/__rs/harness/vitest.config.ts',
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
    child.on('close', (code) => {
      clearTimeout(timer)
      writeFileSync(logFile, log)
      for (const entry of readdirSync('/tmp')) {
        if (entry.startsWith(path.basename(dbFile))) {
          rmSync(path.join('/tmp', entry), { force: true, recursive: true })
        }
      }
      resolve({ code, coreStatsFile, durationMs: Date.now() - started, file, jsonFile, statsFile })
    })
  })

const testsOf = (fileResult) =>
  new Map((fileResult?.assertionResults ?? []).map((test) => [test.fullName, test]))

const compare = ({ code, coreStatsFile, durationMs, file, jsonFile, statsFile }) => {
  const core = existsSync(coreStatsFile) ? JSON.parse(readFileSync(coreStatsFile, 'utf8')) : undefined
  const coreCalls = core ? Object.values(core.calls).reduce((a, b) => a + b, 0) : 0
  const result = existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : undefined
  const fileResult = result?.testResults?.[0]
  const stats = existsSync(statsFile) ? JSON.parse(readFileSync(statsFile, 'utf8')) : undefined
  const baseTests = testsOf(baselineByFile.get(file))
  const tests = testsOf(fileResult)
  const counts = { failed: 0, passed: 0, skipped: 0 }
  const differences = []
  for (const [name, test] of tests) {
    const status =
      test.status === 'passed' ? 'passed' : test.status === 'failed' ? 'failed' : 'skipped'
    counts[status]++
    const baseStatus = baseTests.get(name)?.status
    const normalizedBase =
      baseStatus === undefined
        ? 'missing'
        : baseStatus === 'passed'
          ? 'passed'
          : baseStatus === 'failed'
            ? 'failed'
            : 'skipped'
    if (normalizedBase !== status) {
      differences.push({
        baseline: normalizedBase,
        failure: (test.failureMessages ?? []).join('\n').split('\n').slice(0, 6).join('\n'),
        name,
        status,
      })
    }
  }
  for (const [name, test] of baseTests) {
    if (!tests.has(name)) {
      differences.push({ baseline: test.status, name, status: 'missing' })
    }
  }
  const baseCounts = { failed: 0, passed: 0, skipped: 0 }
  for (const test of baseTests.values()) {
    baseCounts[
      test.status === 'passed' ? 'passed' : test.status === 'failed' ? 'failed' : 'skipped'
    ]++
  }
  const calls = stats ? Object.values(stats.calls).reduce((a, b) => a + b, 0) : 0
  return {
    baseline: baseCounts,
    calls,
    code,
    coreCalls,
    coreDeferred: core?.deferredCalls ?? 0,
    counts,
    differences,
    durationMs,
    engines: stats?.engines,
    file,
    loadError: fileResult
      ? fileResult.status === 'failed' && tests.size === 0
        ? fileResult.message
        : undefined
      : 'no json result',
  }
}

const queue = files.map((file, index) => ({ file, index }))
const results = []
const summaryFile = path.join(options.out, 'summary.json')
const previous = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : []
// files of one test/<suite> directory share fixtures on disk (media dirs): never run them together
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
    const run = await runFile(file, index).finally(() => runningSuites.delete(suiteDirOf(file)))
    const entry = compare(run)
    results.push(entry)
    const merged = [...previous.filter((p) => !results.some((r) => r.file === p.file)), ...results]
    writeFileSync(summaryFile, JSON.stringify(merged, null, 2))
    process.stdout.write(
      `${entry.file}: ${entry.counts.passed}/${entry.baseline.passed} passed, ${entry.counts.failed} failed (baseline ${entry.baseline.failed}), ${entry.differences.length} diffs, ${entry.calls} engine calls, ${entry.coreCalls} core calls (${entry.coreDeferred} deferred), ${Math.round(entry.durationMs / 1000)}s${entry.loadError ? ` LOAD ERROR ${String(entry.loadError).slice(0, 200)}` : ''}\n`,
    )
  }
}
await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, worker))

results.sort((a, b) => a.file.localeCompare(b.file))
let md =
  '| suite | baseline pass/fail/skip | rs pass/fail/skip | diffs | engine calls | core hook calls |\n|---|---|---|---|---|---|\n'
for (const r of results) {
  md += `| ${r.file} | ${r.baseline.passed}/${r.baseline.failed}/${r.baseline.skipped} | ${r.counts.passed}/${r.counts.failed}/${r.counts.skipped} | ${r.differences.length}${r.loadError ? ' (load error)' : ''} | ${r.calls} | ${r.coreCalls} |\n`
}
const total = (key) => results.reduce((a, r) => a + r.counts[key], 0)
const baseTotal = (key) => results.reduce((a, r) => a + r.baseline[key], 0)
md += `| **total (${results.length} files)** | ${baseTotal('passed')}/${baseTotal('failed')}/${baseTotal('skipped')} | ${total('passed')}/${total('failed')}/${total('skipped')} | ${results.reduce((a, r) => a + r.differences.length, 0)} | ${results.reduce((a, r) => a + r.calls, 0)} | ${results.reduce((a, r) => a + r.coreCalls, 0)} |\n`
for (const r of results) {
  if (r.differences.length || r.loadError) {
    md += `\n### ${r.file}\n`
    if (r.loadError) {
      md += `load error: ${String(r.loadError).split('\n').slice(0, 5).join(' / ')}\n`
    }
    for (const d of r.differences) {
      md += `- ${d.name} (${d.baseline} -> ${d.status})${d.failure ? `: ${d.failure.split('\n')[0]}` : ''}\n`
    }
  }
}
writeFileSync(path.join(options.out, 'summary.md'), md)
process.stdout.write(`\n${md}`)

const problems = []
for (const r of results) {
  if (r.loadError) {
    problems.push(`${r.file}: ${r.loadError}`)
  } else if (r.counts.passed + r.counts.failed + r.counts.skipped === 0) {
    problems.push(`${r.file}: compared zero tests`)
  }
  if (r.differences.length) {
    problems.push(`${r.file}: ${r.differences.length} differences from the baseline`)
  }
}
const noCore = results.filter((r) => options.mode !== 'sql' && r.counts.passed > 0 && r.coreCalls === 0)
if (noCore.length) {
  // files whose tests never run a field traversal (CLI, config, helpers, ...)
  process.stdout.write(`\nfiles without Rust core hook calls: ${noCore.map((r) => r.file).join(', ')}\n`)
}
if (problems.length) {
  process.stdout.write(`\nFAIL\n${problems.map((p) => `- ${p}`).join('\n')}\n`)
  process.exitCode = 1
}
