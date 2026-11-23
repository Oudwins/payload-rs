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
 * --engine default  PAYLOAD_ENGINE unset (the default selection: Rust), checked like rs
 * --engine ts  the reference side: PAYLOAD_ENGINE=ts, PAYLOAD_CORE_ENGINE unset (upstream TS); the
 *              engine-call checks below do not apply. Default `rs`.
 * --variant v  the adapter matrix (test/__rs/harness/databaseAdapter.ts):
 *              `default`      PAYLOAD_DATABASE=sqlite (test/dbAdapters.ts `sqlite`)
 *              `transactions` the same plus `transactionOptions: {}` (PAYLOAD_RS_SQLITE_TRANSACTIONS)
 *              `uuid`         PAYLOAD_DATABASE=sqlite-uuid (test/dbAdapters.ts `sqlite-uuid`)
 *              `uuidv7`       PAYLOAD_DATABASE=sqlite-uuidv7
 * --baseline f vitest JSON result(s) to compare with (repeatable; default
 *              .rs-baseline/sqlite-all.json). With several reference runs a test's status must
 *              equal its status in at least one of them; tests whose reference runs disagree are
 *              listed as `reference flaky`.
 * --write-baseline f  merges this run's per-file results into one vitest JSON (a baseline for
 *              --baseline, e.g. a variant's TS run)
 * --config f  vitest config (default test/__rs/harness/vitest.config.ts); a replacement must keep
 *              its databaseAdapter.js resolution (e.g. test/__rs/http-lanes/vitest.sqlite.config.ts)
 * --fuse m     PAYLOAD_RS_FUSE=m for the fused read lanes (packages/engine-rs/FUSE_CONTRACT.md):
 *              `shadow` compares every fused call with the exact lane (a file with a difference
 *              fails); `off` disables them. Every Rust run records the lanes' counters per file
 *              (fused hits, bails, shadow differences; columns of the summary).
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
  baselines: [],
  core: undefined,
  engine: 'rs',
  jobs: 1,
  loopback: false,
  out: '/tmp/rs-adapter-runs',
  timeout: 1_200_000,
  variant: 'default',
  writeBaseline: undefined,
  fuse: undefined,
  config: 'test/__rs/harness/vitest.config.ts',
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
  } else if (arg === '--engine') {
    options.engine = argv[++i]
  } else if (arg === '--variant') {
    options.variant = argv[++i]
  } else if (arg === '--baseline') {
    options.baselines.push(path.resolve(argv[++i]))
  } else if (arg === '--write-baseline') {
    options.writeBaseline = path.resolve(argv[++i])
  } else if (arg === '--fuse') {
    options.fuse = argv[++i]
  } else if (arg === '--config') {
    options.config = path.relative(root, path.resolve(argv[++i]))
  } else {
    files.push(path.relative(root, path.resolve(root, arg)))
  }
}

const variants = {
  default: { PAYLOAD_DATABASE: 'sqlite' },
  transactions: { PAYLOAD_DATABASE: 'sqlite', PAYLOAD_RS_SQLITE_TRANSACTIONS: 'true' },
  uuid: { PAYLOAD_DATABASE: 'sqlite-uuid' },
  uuidv7: { PAYLOAD_DATABASE: 'sqlite-uuidv7' },
}
if (!variants[options.variant]) {
  throw new Error(`--variant must be one of ${Object.keys(variants).join(', ')}`)
}
if (!['default', 'rs', 'ts'].includes(options.engine)) {
  throw new Error(
    '--engine must be rs, ts or default (PAYLOAD_ENGINE unset: Rust, checked like rs)',
  )
}
const isRs = options.engine === 'rs' || options.engine === 'default'

mkdirSync(options.out, { recursive: true })

if (options.baselines.length === 0) {
  options.baselines.push(path.join(root, '.rs-baseline/sqlite-all.json'))
}
/** One Map(file -> vitest file result) per reference run. */
const baselineRuns = options.baselines.map(
  (file) =>
    new Map(
      JSON.parse(readFileSync(file, 'utf8')).testResults.map((result) => [
        path.relative(root, result.name),
        result,
      ]),
    ),
)
const baselineByFile = baselineRuns[0]

/** Output file stem (injective): `/` → `__`, `_` → `_u`, other non-alphanumerics → `_x` + 6 hex digits. */
const slugOf = (file) =>
  file
    .replace(/_/g, '_u')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_]/g, (char) => `_x${char.codePointAt(0).toString(16).padStart(6, '0')}`)
{
  const seen = new Map()
  for (const file of files) {
    const slug = slugOf(file)
    if (seen.has(slug) && seen.get(slug) !== file) {
      throw new Error(`output name collision: ${seen.get(slug)} and ${file}`)
    }
    seen.set(slug, file)
  }
}

const runFile = (file, index) =>
  new Promise((resolve) => {
    const slug = slugOf(file)
    const dbFile = `/tmp/rs-adapter-${process.pid}-${index}.db`
    const jsonFile = path.join(options.out, `${slug}.json`)
    const statsFile = path.join(options.out, `${slug}.stats.json`)
    const logFile = path.join(options.out, `${slug}.log`)
    const fuseDir = path.join(options.out, `${slug}.fuse`)
    rmSync(jsonFile, { force: true })
    rmSync(statsFile, { force: true })
    rmSync(fuseDir, { force: true, recursive: true })
    mkdirSync(fuseDir, { recursive: true })
    const env = {
      ...process.env,
      PAYLOAD_ENGINE: 'rs',
      PAYLOAD_RS_ENGINE_STATS_FILE: statsFile,
      PAYLOAD_RS_FUSE_STATS_DIR: fuseDir,
      PAYLOAD_RS_OPS_STATS_DIR: fuseDir,
      SQLITE_URL: `file:${dbFile}`,
      TZ: 'UTC',
      ...variants[options.variant],
    }
    if (!variants[options.variant].PAYLOAD_RS_SQLITE_TRANSACTIONS) {
      delete env.PAYLOAD_RS_SQLITE_TRANSACTIONS
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
    if (options.engine === 'default') {
      delete env.PAYLOAD_ENGINE
    }
    if (options.fuse) {
      env.PAYLOAD_RS_FUSE = options.fuse
    } else {
      delete env.PAYLOAD_RS_FUSE
    }
    if (!isRs) {
      env.PAYLOAD_ENGINE = 'ts'
      delete env.PAYLOAD_CORE_ENGINE
      delete env.PAYLOAD_ENGINE_ADDON
      delete env.PAYLOAD_RS_ENGINE_LOOPBACK
    }
    const started = Date.now()
    const child = spawn(
      'pnpm',
      ['test:int', '--config', options.config, '--reporter=json', `--outputFile=${jsonFile}`, file],
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
      resolve({ code, durationMs: Date.now() - started, file, fuseDir, jsonFile, statsFile })
    })
  })

const normalizeStatus = (status) =>
  status === undefined
    ? 'missing'
    : status === 'passed'
      ? 'passed'
      : status === 'failed'
        ? 'failed'
        : 'skipped'

const testsOf = (fileResult) =>
  new Map((fileResult?.assertionResults ?? []).map((test) => [test.fullName, test]))

const readJSON = (file) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  } catch {
    return undefined
  }
}

/** The fused lanes' counters of every process of one file, and the Rust read operations served. */
const readFuseStats = (dir) => {
  const total = { bails: 0, diffs: 0, hits: 0, opsCalls: 0, reasons: {} }
  if (!dir || !existsSync(dir)) {
    return total
  }
  for (const entry of readdirSync(dir)) {
    const stats = readJSON(path.join(dir, entry))
    if (!stats) {
      continue
    }
    if (/^fuse-\d+\.json$/.test(entry)) {
      total.hits += Object.values(stats.hits ?? {}).reduce((a, b) => a + b, 0)
      total.bails += Object.values(stats.bails ?? {}).reduce((a, b) => a + b, 0)
      total.diffs += stats.diffs ?? 0
      for (const [reason, n] of Object.entries(stats.bails ?? {})) {
        total.reasons[reason] = (total.reasons[reason] ?? 0) + n
      }
    } else if (/^ops-\d+\.json$/.test(entry)) {
      total.opsCalls += Object.values(stats.calls ?? {}).reduce((a, b) => a + b, 0)
    }
  }
  return total
}

const compare = ({ code, durationMs, file, fuseDir, jsonFile, statsFile }) => {
  const result = readJSON(jsonFile)
  const fileResult = result?.testResults?.[0]
  const stats = readJSON(statsFile)
  const baseTests = testsOf(baselineByFile.get(file))
  const baseRunsTests = baselineRuns.map((run) => testsOf(run.get(file)))
  const tests = testsOf(fileResult)
  const referenceFlaky = []
  const counts = { failed: 0, passed: 0, skipped: 0 }
  const differences = []
  for (const [name, test] of tests) {
    const status =
      test.status === 'passed' ? 'passed' : test.status === 'failed' ? 'failed' : 'skipped'
    counts[status]++
    const baseStatuses = baseRunsTests.map((run) => normalizeStatus(run.get(name)?.status))
    const normalizedBase = baseStatuses[0]
    if (new Set(baseStatuses).size > 1) {
      referenceFlaky.push({ name, reference: baseStatuses, status })
    }
    if (!baseStatuses.includes(status)) {
      differences.push({
        baseline: normalizedBase,
        failure: (test.failureMessages ?? []).join('\n').split('\n').slice(0, 6).join('\n'),
        name,
        status,
      })
    }
  }
  for (const [name, test] of baseTests) {
    if (!tests.has(name) && !baseRunsTests.some((run) => !run.has(name))) {
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
  const fuse = readFuseStats(fuseDir)
  return {
    baseline: baseCounts,
    calls,
    fuse,
    isEngineBypassed: isRs && calls === 0 && upstreamCalls > 0,
    referenceFlaky,
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
      `${entry.file}: ${entry.counts.passed}/${entry.baseline.passed} passed, ${entry.counts.failed} failed (baseline ${entry.baseline.failed}), ${entry.differences.length} diffs, ${entry.calls} engine calls, ${entry.upstreamCalls} upstream, fused ${entry.fuse.hits} hits / ${entry.fuse.bails} bails / ${entry.fuse.diffs} lane diffs, ${Math.round(entry.durationMs / 1000)}s${entry.loadError ? ` LOAD ERROR ${String(entry.loadError).slice(0, 200)}` : ''}\n`,
    )
  }
}
await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, worker))

results.sort((a, b) => a.file.localeCompare(b.file))
if (options.writeBaseline) {
  const testResults = []
  for (const r of results) {
    const fileResult = readJSON(path.join(options.out, `${slugOf(r.file)}.json`))?.testResults?.[0]
    if (fileResult) {
      testResults.push(fileResult)
    }
  }
  writeFileSync(
    options.writeBaseline,
    JSON.stringify({ engine: options.engine, testResults, variant: options.variant }),
  )
}
let md = `engine ${options.engine}, variant ${options.variant}, baselines ${options.baselines.map((file) => path.relative(root, file)).join(', ')}\n\n| suite | baseline pass/fail/skip | ${options.engine} pass/fail/skip | diffs | engine calls | upstream calls | fused hits / bails / lane diffs | Rust read ops |\n|---|---|---|---|---|---|---|---|\n`
for (const r of results) {
  md += `| ${r.file} | ${r.baseline.passed}/${r.baseline.failed}/${r.baseline.skipped} | ${r.counts.passed}/${r.counts.failed}/${r.counts.skipped} | ${r.differences.length}${r.loadError ? ' (load error)' : ''}${r.hasBaseline ? '' : ' (no baseline)'} | ${r.calls}${r.isEngineBypassed ? ' (engine bypassed)' : r.upstreamCalls > r.calls ? ' (mostly upstream)' : ''} | ${r.upstreamCalls}${r.upstreamCalls ? ` (${Object.keys(r.upstreamReasons ?? {}).join(', ')})` : ''} | ${r.fuse.hits} / ${r.fuse.bails} / ${r.fuse.diffs} | ${r.fuse.opsCalls} |\n`
}
const totals = results.reduce(
  (sum, r) => ({
    calls: sum.calls + r.calls,
    differing:
      sum.differing +
      (r.differences.length || r.loadError || !r.hasBaseline || r.isEngineBypassed || r.fuse.diffs
        ? 1
        : 0),
    fuseHits: sum.fuseHits + r.fuse.hits,
    fuseDiffs: sum.fuseDiffs + r.fuse.diffs,
    tests: sum.tests + r.counts.passed + r.counts.failed + r.counts.skipped,
    upstream: sum.upstream + r.upstreamCalls,
  }),
  { calls: 0, differing: 0, fuseDiffs: 0, fuseHits: 0, tests: 0, upstream: 0 },
)
md += `\n**${results.length - totals.differing}/${results.length} files identical to the baseline**, ${totals.tests} tests, ${totals.calls} engine calls, ${totals.upstream} upstream calls, ${totals.fuseHits} fused read hits, ${totals.fuseDiffs} lane-shadow differences\n`
for (const r of results) {
  if (r.referenceFlaky.length) {
    md += `\n### ${r.file}: reference flaky\n`
    for (const f of r.referenceFlaky) {
      md += `- ${f.name}: reference ${f.reference.join(' / ')}, this run ${f.status}\n`
    }
  }
  if (r.fuse.diffs) {
    md += `\n### ${r.file}: ${r.fuse.diffs} lane-shadow differences (see ${path.relative(root, path.join(options.out, `${slugOf(r.file)}.fuse`))})\n`
  }
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
if (totals.differing > 0 || totals.tests === 0 || (isRs && totals.calls === 0)) {
  process.exitCode = 1
}
