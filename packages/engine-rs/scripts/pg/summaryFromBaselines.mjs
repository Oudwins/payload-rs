#!/usr/bin/env node
/**
 * Rebuilds a runSuites-shaped summary.json (test/__rs/pg-harness/runSuites.mjs) for the PostgreSQL
 * TS baseline from the committed per-test files, so analyzeBaseline.mjs can regenerate
 * .rs-baseline/postgres-summary.md (e.g. with --variant columns) after /tmp/rs-pg-runs was cleaned:
 *
 * - `--baseline` (.rs-baseline/postgres-all.json): first-run vitest JSON
 * - `--rerun` (.rs-baseline/postgres-rerun.json): vitest JSON of the files re-run alone
 * - `--previous` (.rs-baseline/postgres-summary.md): causes of the failing tests and suite-level
 *   errors as the original analysis found them (some came from the first run's logs, which are
 *   not kept); stored as `causes` / `loadError` on each entry
 *
 *   node packages/engine-rs/scripts/pg/summaryFromBaselines.mjs --out /tmp/rs-pg-runs/rsp_base/summary.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const baseline = JSON.parse(
  fs.readFileSync(
    path.resolve(root, option('--baseline', '.rs-baseline/postgres-all.json')),
    'utf8',
  ),
)
const rerun = JSON.parse(
  fs.readFileSync(
    path.resolve(root, option('--rerun', '.rs-baseline/postgres-rerun.json')),
    'utf8',
  ),
)
const previousFile = path.resolve(root, option('--previous', '.rs-baseline/postgres-summary.md'))
const outFile = path.resolve(option('--out', '/tmp/rs-pg-runs/rsp_base/summary.json'))

/** Cells of a markdown table row (`\|` is an escaped pipe inside a cell). */
const cellsOf = (line) =>
  line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'))

const previous = fs.existsSync(previousFile) ? fs.readFileSync(previousFile, 'utf8') : ''
const section = (title) => {
  const start = previous.indexOf(`\n## ${title}`)
  if (start === -1) return []
  const end = previous.indexOf('\n## ', start + 1)
  return previous.slice(start, end === -1 ? undefined : end).split('\n')
}
const previousCauses = new Map()
for (const line of section('Failing tests')) {
  if (!line.startsWith('| test/')) continue
  const [file, name, , , , cause] = cellsOf(line)
  if (cause && !cause.includes('not environmental')) previousCauses.set(`${file}\0${name}`, cause)
}
const previousLoadErrors = new Map()
for (const line of section('Suite-level errors')) {
  const match = /^- (test\/\S+): (.*?)(?: \(rerun alone: \w+\))?$/.exec(line)
  if (match) previousLoadErrors.set(match[1], match[2].replaceAll('\\|', '|'))
}

const statusOf = (status) =>
  status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped'

const summarize = (fileResult) => {
  const counts = { failed: 0, passed: 0, skipped: 0 }
  const failures = []
  for (const test of fileResult.assertionResults) {
    const status = statusOf(test.status)
    counts[status]++
    if (status === 'failed') {
      failures.push({
        message: (test.failureMessages ?? []).join('\n').split('\n').slice(0, 4).join('\n'),
        name: test.fullName,
      })
    }
  }
  const isSuiteError = fileResult.status === 'failed' && counts.failed === 0
  return {
    counts,
    failures,
    loadError: isSuiteError
      ? fileResult.message ||
        previousLoadErrors.get(fileResult.name) ||
        'file failed without a failed test'
      : undefined,
  }
}

const reruns = new Map(rerun.testResults.map((result) => [result.name, result]))
const files = {}
for (const fileResult of baseline.testResults) {
  const first = summarize(fileResult)
  const entry = {
    causes: Object.fromEntries(
      first.failures
        .map((f) => [f.name, previousCauses.get(`${fileResult.name}\0${f.name}`)])
        .filter(([, cause]) => cause),
    ),
    counts: first.counts,
    differences: [],
    failures: first.failures,
    file: fileResult.name,
    loadError: first.loadError,
    referenceFlaky: [],
  }
  const again = reruns.get(fileResult.name)
  if (again) {
    const second = summarize(again)
    const failedAgain = new Set(second.failures.map((f) => f.name))
    entry.rerun = {
      counts: second.counts,
      failures: second.failures,
      flaky: first.failures.filter((f) => !failedAgain.has(f.name)).map((f) => f.name),
      loadError: second.loadError,
      newFailures: second.failures
        .filter((f) => !first.failures.some((g) => g.name === f.name))
        .map((f) => f.name),
      reproduced: first.failures.filter((f) => failedAgain.has(f.name)).map((f) => f.name),
    }
  }
  files[fileResult.name] = entry
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      files,
      options: { database: baseline.database, engine: baseline.engine, rebuiltFrom: 'baselines' },
    },
    null,
    2,
  ),
)
process.stdout.write(
  `${outFile}: ${Object.keys(files).length} files, ${reruns.size} re-run, ${previousCauses.size} previous causes, ${previousLoadErrors.size} suite-level errors\n`,
)
