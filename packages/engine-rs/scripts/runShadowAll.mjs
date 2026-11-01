#!/usr/bin/env node
/**
 * Runs the sqlite-capable int suite in shadow mode (PAYLOAD_DATABASE=sqlite-shadow) one spec file
 * at a time, each with its own database files, and summarises divergences per file.
 *
 *   node packages/engine-rs/scripts/runShadowAll.mjs [options] [path filters...]
 *
 * Options:
 *   --out <dir>        output dir (default .rs-baseline/shadow-all): summary.json, summary.md,
 *                      reports/<file>/ (JSONL divergence reports), logs/<file>.log, results/<file>.json
 *   --baseline <file>  vitest JSON report of a plain sqlite run (default .rs-baseline/sqlite-all.json).
 *                      Files that executed 0 tests there are skipped, and failures are compared to it.
 *   --all              also run files that executed 0 tests in the baseline
 *   --include-rs       also run the port's own suites under test/__rs (default: only
 *                      test/__rs/harness/parity.int.spec.ts from there)
 *   --candidate <c>    PAYLOAD_RS_CANDIDATE (ts | rs | module path), default ts
 *   --jobs <n>         files run in parallel (default 1); files of the same test/<suite> directory
 *                      never run concurrently (they share fixtures on disk)
 *   --timeout <ms>     per file (default 1800000)
 *   --resume           keep results already in summary.json and only run the missing files
 *   --rerun <statuses> with --resume: also rerun files whose status is in the comma separated
 *                      list (e.g. divergent,newFailures,loadError,timeout)
 *
 * Runs through test/__rs/harness/vitest.config.ts, so the shared test/databaseAdapter.js is not
 * rewritten. Exit code 1 when any file has divergences, new failures vs the baseline, or timed out.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')

const { filters, options } = parseArgs(process.argv.slice(2))
const outDir = path.resolve(root, options.out ?? '.rs-baseline/shadow-all')
const baselineFile = path.resolve(root, options.baseline ?? '.rs-baseline/sqlite-all.json')
const jobs = Number(options.jobs ?? 1)
const timeoutMs = Number(options.timeout ?? 1_800_000)
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-shadow-all-'))
const summaryFile = path.join(outDir, 'summary.json')

const baseline = loadBaseline(baselineFile)
const files = discoverFiles()
const previous =
  options.resume && fs.existsSync(summaryFile)
    ? JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    : {}
const results = { ...previous.files }

for (const dir of ['reports', 'logs', 'results']) {
  fs.mkdirSync(path.join(outDir, dir), { recursive: true })
}

const rerunStatuses = new Set(['skipped', ...(options.rerun ?? '').split(',').filter(Boolean)])
const queue = files.filter((file) => !results[file] || rerunStatuses.has(results[file].status))
const startedAt = Date.now()
const totalToRun = queue.length
let done = 0

console.log(
  `[shadow-all] ${files.length} files, ${queue.length} to run, jobs=${jobs}, out=${path.relative(root, outDir)}`,
)

/**
 * Suite directories with a file currently running. Files of one suite share fixtures on disk
 * (e.g. test/file-versioning/media), so they never run concurrently.
 */
const runningSuites = new Set()
const suiteOf = (file) => file.split('/').slice(0, 2).join('/')
let wakeIdle = () => {}

await Promise.all(
  Array.from({ length: Math.max(1, jobs) }, async () => {
    while (queue.length) {
      const index = queue.findIndex((file) => !runningSuites.has(suiteOf(file)))
      if (index === -1) {
        await new Promise((resolve) => {
          const previous = wakeIdle
          wakeIdle = () => {
            previous()
            resolve()
          }
        })
        continue
      }
      const [file] = queue.splice(index, 1)
      const skipReason = skipReasonFor(file)
      runningSuites.add(suiteOf(file))
      const result = skipReason
        ? { file, reason: skipReason, status: 'skipped' }
        : await runFile(file).finally(() => {
            runningSuites.delete(suiteOf(file))
            const wake = wakeIdle
            wakeIdle = () => {}
            wake()
          })
      if (skipReason) {
        runningSuites.delete(suiteOf(file))
      }
      results[file] = result
      done++
      writeSummary()
      console.log(`[shadow-all] ${done}/${totalToRun} ${formatLine(result)}`)
    }
  }),
)

fs.rmSync(dbDir, { force: true, recursive: true })
writeSummary()
fs.writeFileSync(path.join(outDir, 'summary.md'), renderMarkdown())
const failing = Object.values(results).filter((r) =>
  ['divergent', 'newFailures', 'timeout', 'loadError'].includes(r.status),
)
console.log(
  `[shadow-all] done in ${Math.round((Date.now() - startedAt) / 1000)}s; ${failing.length} file(s) need attention; summary: ${path.relative(root, path.join(outDir, 'summary.md'))}`,
)
process.exit(failing.length ? 1 : 0)

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (['--all', '--include-rs', '--resume'].includes(arg)) {
      opts[arg.slice(2)] = true
    } else if (arg.startsWith('--')) {
      opts[arg.slice(2)] = argv[++i]
    } else {
      rest.push(arg)
    }
  }
  return { filters: rest, options: opts }
}

function loadBaseline(file) {
  if (!fs.existsSync(file)) {
    console.warn(`[shadow-all] no baseline at ${file}: running every file, no failure comparison`)
    return undefined
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const byFile = new Map()
  for (const entry of report.testResults) {
    byFile.set(path.relative(root, entry.name), summariseTests(entry))
  }
  return byFile
}

function discoverFiles() {
  return fs
    .globSync('test/**/*int.spec.ts', { cwd: root, exclude: (p) => p.includes('node_modules') })
    .filter(
      (file) =>
        options['include-rs'] ||
        !file.startsWith('test/__rs/') ||
        file === 'test/__rs/harness/parity.int.spec.ts',
    )
    .filter((file) => !filters.length || filters.some((filter) => file.includes(filter)))
    .sort()
}

function skipReasonFor(file) {
  const base = baseline?.get(file)
  if (!options.all && base && base.counts.passed + base.counts.failed === 0) {
    return 'no tests executed on sqlite in the baseline'
  }
  return undefined
}

function summariseTests(entry) {
  const counts = { failed: 0, passed: 0, skipped: 0, todo: 0 }
  const failed = []
  const passed = []
  for (const test of entry?.assertionResults ?? []) {
    if (test.status === 'passed') {
      counts.passed++
      passed.push(test.fullName)
    } else if (test.status === 'failed') {
      counts.failed++
      failed.push(test.fullName)
    } else if (test.status === 'todo') {
      counts.todo++
    } else {
      counts.skipped++
    }
  }
  return {
    counts,
    failed,
    loadError:
      entry && entry.status === 'failed' && !entry.assertionResults.length
        ? firstLine(entry.message)
        : '',
    passed,
  }
}

function slugOf(file) {
  return file.split('/').join('__')
}

async function runFile(file) {
  const slug = slugOf(file)
  const reportDir = path.join(outDir, 'reports', slug)
  const resultFile = path.join(outDir, 'results', `${slug}.json`)
  const logFile = path.join(outDir, 'logs', `${slug}.log`)
  const dbFile = path.join(dbDir, `${slug}.db`)
  fs.rmSync(reportDir, { force: true, recursive: true })
  fs.rmSync(resultFile, { force: true })

  const env = {
    ...process.env,
    DISABLE_LOGGING: 'true',
    NODE_NO_WARNINGS: '1',
    NODE_OPTIONS:
      `${process.env.NODE_OPTIONS ?? ''} --no-deprecation --no-experimental-strip-types`.trim(),
    PAYLOAD_DATABASE: 'sqlite-shadow',
    PAYLOAD_RS_CANDIDATE: options.candidate ?? process.env.PAYLOAD_RS_CANDIDATE ?? 'ts',
    PAYLOAD_RS_REPORT_DIR: reportDir,
    SQLITE_URL: `file:${dbFile}`,
    TZ: process.env.TZ ?? 'UTC',
  }
  delete env.PAYLOAD_RS_CANDIDATE_URL
  delete env.PAYLOAD_RS_SHADOW
  delete env.PAYLOAD_RS_SHADOW_CHILD
  delete env.PAYLOAD_RS_SHADOW_CROSS_PROCESS_FILE

  const started = Date.now()
  const { code, timedOut } = await run({
    args: [
      'run',
      '--config',
      'test/__rs/harness/vitest.config.ts',
      '--project',
      'int',
      '--reporter=json',
      `--outputFile=${resultFile}`,
      file,
    ],
    env,
    logFile,
  })
  const durationMs = Date.now() - started

  for (const name of fs.readdirSync(dbDir)) {
    if (name.startsWith(slug)) {
      fs.rmSync(path.join(dbDir, name), { force: true, recursive: true })
    }
  }

  const vitestResult = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    : undefined
  const tests = summariseTests(vitestResult?.testResults?.[0])
  const shadow = readReports(reportDir)
  const base = baseline?.get(file)
  const basePassed = new Set(base?.passed ?? [])
  const newFailures = tests.failed.filter((name) => !base || basePassed.has(name))

  const status = timedOut
    ? 'timeout'
    : !vitestResult || tests.loadError
      ? 'loadError'
      : shadow.divergences
        ? 'divergent'
        : newFailures.length
          ? 'newFailures'
          : 'ok'

  return {
    baseline: base?.counts,
    durationMs,
    exitCode: code,
    file,
    loadError: tests.loadError || (vitestResult ? '' : lastLines(logFile)),
    newFailures,
    status,
    tests: tests.counts,
    ...shadow,
  }
}

function run({ args, env, logFile }) {
  return new Promise((resolve) => {
    const log = fs.openSync(logFile, 'w')
    const child = spawn(path.join(root, 'node_modules/.bin/vitest'), args, {
      cwd: root,
      detached: true,
      env,
      stdio: ['ignore', log, log],
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      fs.closeSync(log)
      resolve({ code, timedOut })
    })
  })
}

function readReports(dir) {
  const out = {
    byMethod: {},
    calls: 0,
    dbChecks: 0,
    divergences: 0,
    examples: [],
    rawMirrored: 0,
    sessions: 0,
    unshadowed: {},
  }
  if (!fs.existsSync(dir)) {
    return out
  }
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) {
        continue
      }
      const record = JSON.parse(line)
      if (record.type === 'session') {
        out.sessions++
      } else if (record.type === 'stats') {
        out.calls += record.calls ?? 0
        out.dbChecks += record.dbChecks ?? 0
        out.rawMirrored += record.rawMirrored ?? 0
        for (const [method, count] of Object.entries(record.unshadowed ?? {})) {
          out.unshadowed[method] = (out.unshadowed[method] ?? 0) + count
        }
      } else if (record.type === 'divergence') {
        out.divergences++
        out.byMethod[record.method] = (out.byMethod[record.method] ?? 0) + 1
        if (out.examples.length < 5) {
          const first = record.differences?.[0]
          out.examples.push({
            collection: record.collection ?? record.global,
            kind: first?.kind,
            method: record.method,
            path: first?.path,
            test: record.finishedTest ?? record.testName,
          })
        }
      }
    }
  }
  return out
}

function writeSummary() {
  const list = Object.values(results)
  const totals = { calls: 0, dbChecks: 0, divergences: 0, files: list.length, rawMirrored: 0 }
  const byStatus = {}
  for (const r of list) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    for (const key of ['calls', 'dbChecks', 'divergences', 'rawMirrored']) {
      totals[key] += r[key] ?? 0
    }
  }
  fs.writeFileSync(
    summaryFile,
    `${JSON.stringify({ byStatus, candidate: options.candidate ?? 'ts', files: results, totals }, null, 1)}\n`,
  )
}

function renderMarkdown() {
  const list = Object.values(results).sort((a, b) => a.file.localeCompare(b.file))
  const cell = (text) => String(text ?? '').replaceAll('|', '\\|')
  const counts = (c) => (c ? `${c.passed}/${c.failed}/${c.skipped}` : '')
  const lines = [
    `# Shadow run (candidate: ${options.candidate ?? 'ts'})`,
    '',
    `Generated by packages/engine-rs/scripts/runShadowAll.mjs. Tests are passed/failed/skipped.`,
    '',
    '| file | status | tests | baseline | new failures | calls | db checks | raw mirrored | divergences | first divergences |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const r of list) {
    lines.push(
      `| ${cell(r.file)} | ${r.status}${r.reason ? ` (${cell(r.reason)})` : ''} | ${counts(r.tests)} | ${counts(r.baseline)} | ${r.newFailures?.length ?? ''} | ${r.calls ?? ''} | ${r.dbChecks ?? ''} | ${r.rawMirrored ?? ''} | ${r.divergences ?? ''} | ${cell(
        (r.examples ?? []).map((e) => `${e.method} ${e.path ?? ''}`).join('; '),
      )} |`,
    )
  }
  const attention = list.filter((r) => r.newFailures?.length || r.loadError)
  if (attention.length) {
    lines.push('', '## New failures / load errors', '')
    for (const r of attention) {
      lines.push(`- **${r.file}**${r.loadError ? `: ${cell(r.loadError)}` : ''}`)
      for (const name of r.newFailures ?? []) {
        lines.push(`  - ${cell(name)}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

function formatLine(r) {
  if (r.status === 'skipped') {
    return `${r.file}: skipped (${r.reason})`
  }
  return `${r.file}: ${r.status} tests ${r.tests.passed}/${r.tests.failed}/${r.tests.skipped} calls ${r.calls} db ${r.dbChecks} divergences ${r.divergences} newFailures ${r.newFailures.length} ${Math.round(r.durationMs / 1000)}s`
}

function firstLine(text) {
  return (
    String(text ?? '')
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 300) ?? ''
  )
}

function lastLines(file) {
  if (!fs.existsSync(file)) {
    return ''
  }
  return firstLine(fs.readFileSync(file, 'utf8').split('\n').slice(-20).reverse().join('\n'))
}
