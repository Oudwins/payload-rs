#!/usr/bin/env node
/**
 * Runs upstream int suites with `PAYLOAD_ENGINE=rs` and compares every test's status with the TS
 * baseline (.rs-baseline/sqlite-all.json).
 *
 *   node test/__rs/adapter/runSuites.mjs [--loopback] [--addon path] [--out dir] [--jobs n]
 *     [--timeout ms] test/hooks/int.spec.ts test/database/int.spec.ts ...
 *
 * --loopback   PAYLOAD_RS_ENGINE_LOOPBACK=true (TS stand-in engine; verifies the glue only)
 * --addon      PAYLOAD_ENGINE_ADDON (default: the shared packages/engine-rs/payload-engine.node)
 * --core ts    PAYLOAD_CORE_ENGINE=ts: field hooks / validators stay TS (SQL engine parity only);
 *              default: PAYLOAD_ENGINE=rs alone, i.e. the Rust core runtime too
 *
 * Files of one test/<suite> directory never run concurrently. Every file gets its own SQLite file under /tmp (deleted afterwards) and an engine stats file, so
 * the summary shows that the engine served the data methods (and how many calls ran the upstream
 * TS method because an adapter internal or the client's `execute` was replaced). Writes
 * <out>/summary.json and prints a markdown table plus every test whose status differs from the
 * baseline. Exits non-zero when a file differs, has no result, has no baseline entry, ran its
 * data methods only through the upstream TS methods (upstream calls but no engine call), or when
 * the run compared no tests or made no engine calls at all. Files where most calls ran upstream
 * are flagged `(mostly upstream)`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const argv = process.argv.slice(2)
const options = {
  addon: undefined,
  core: undefined,
  jobs: 1,
  loopback: false,
  out: '/tmp/rs-adapter-runs',
  timeout: 1_200_000,
}
const files = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--loopback') {
    options.loopback = true
  } else if (arg === '--core') {
    options.core = argv[++i]
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

const slugOf = (file) => file.replace(/[^a-zA-Z0-9]+/g, '_')

const runFile = (file, index) =>
  new Promise((resolve) => {
    const slug = slugOf(file)
    const dbFile = `/tmp/rs-adapter-${process.pid}-${index}.db`
    const jsonFile = path.join(options.out, `${slug}.json`)
    const statsFile = path.join(options.out, `${slug}.stats.json`)
    const logFile = path.join(options.out, `${slug}.log`)
    rmSync(jsonFile, { force: true })
    rmSync(statsFile, { force: true })
    const env = {
      ...process.env,
      PAYLOAD_ENGINE: 'rs',
      PAYLOAD_RS_ENGINE_STATS_FILE: statsFile,
      SQLITE_URL: `file:${dbFile}`,
      TZ: 'UTC',
    }
    if (options.loopback) {
      env.PAYLOAD_RS_ENGINE_LOOPBACK = 'true'
    }
    if (options.addon) {
      env.PAYLOAD_ENGINE_ADDON = options.addon
    }
    if (options.core) {
      env.PAYLOAD_CORE_ENGINE = options.core
    } else {
      delete env.PAYLOAD_CORE_ENGINE
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
      resolve({ code, durationMs: Date.now() - started, file, jsonFile, statsFile })
    })
  })

const testsOf = (fileResult) =>
  new Map((fileResult?.assertionResults ?? []).map((test) => [test.fullName, test]))

const readJSON = (file) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

const compare = ({ code, durationMs, file, jsonFile, statsFile }) => {
  const result = readJSON(jsonFile)
  const fileResult = result?.testResults?.[0]
  const stats = readJSON(statsFile)
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
  const upstreamCalls = stats?.upstream
    ? Object.values(stats.upstream).reduce((a, b) => a + b, 0)
    : 0
  return {
    baseline: baseCounts,
    calls,
    isEngineBypassed: calls === 0 && upstreamCalls > 0,
    hasBaseline: baselineByFile.has(file),
    upstreamCalls,
    upstreamReasons: stats?.upstreamReasons,
    code,
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
      `${entry.file}: ${entry.counts.passed}/${entry.baseline.passed} passed, ${entry.counts.failed} failed (baseline ${entry.baseline.failed}), ${entry.differences.length} diffs, ${entry.calls} engine calls, ${entry.upstreamCalls} upstream, ${Math.round(entry.durationMs / 1000)}s${entry.loadError ? ` LOAD ERROR ${String(entry.loadError).slice(0, 200)}` : ''}\n`,
    )
  }
}
await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, worker))

results.sort((a, b) => a.file.localeCompare(b.file))
let md =
  '| suite | baseline pass/fail/skip | rs pass/fail/skip | diffs | engine calls | upstream calls |\n|---|---|---|---|---|---|\n'
for (const r of results) {
  md += `| ${r.file} | ${r.baseline.passed}/${r.baseline.failed}/${r.baseline.skipped} | ${r.counts.passed}/${r.counts.failed}/${r.counts.skipped} | ${r.differences.length}${r.loadError ? ' (load error)' : ''}${r.hasBaseline ? '' : ' (no baseline)'} | ${r.calls}${r.isEngineBypassed ? ' (engine bypassed)' : r.upstreamCalls > r.calls ? ' (mostly upstream)' : ''} | ${r.upstreamCalls}${r.upstreamCalls ? ` (${Object.keys(r.upstreamReasons ?? {}).join(', ')})` : ''} |\n`
}
const totals = results.reduce(
  (sum, r) => ({
    calls: sum.calls + r.calls,
    differing:
      sum.differing +
      (r.differences.length || r.loadError || !r.hasBaseline || r.isEngineBypassed ? 1 : 0),
    tests: sum.tests + r.counts.passed + r.counts.failed + r.counts.skipped,
    upstream: sum.upstream + r.upstreamCalls,
  }),
  { calls: 0, differing: 0, tests: 0, upstream: 0 },
)
md += `\n**${results.length - totals.differing}/${results.length} files identical to the baseline**, ${totals.tests} tests, ${totals.calls} engine calls, ${totals.upstream} upstream calls\n`
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
if (totals.differing > 0 || totals.tests === 0 || totals.calls === 0) {
  process.exitCode = 1
}
