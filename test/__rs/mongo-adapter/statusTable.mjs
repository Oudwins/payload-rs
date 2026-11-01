#!/usr/bin/env node
/**
 * Per-suite markdown table for packages/engine-rs/MONGO_ENGINE_STATUS.md from run summaries of
 * test/__rs/mongo-adapter/runSuites.mjs or test/__rs/mongo-harness/runSuites.mjs (same per-file
 * shape). Each `--column <name>=<tag>[,<tag>...]` is one column; later tags override earlier ones per
 * file (solo reruns). Totals and every difference / load error are listed below the table.
 *
 *   node test/__rs/mongo-adapter/statusTable.mjs --baseline .rs-baseline/mongodb-all.json \
 *     --column loopback=madl2,madl3,madl4 --column native=madn1 --column 'engine rs'=madrs1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const columnArgs = argv.flatMap((arg, i) => (arg === '--column' ? [argv[i + 1]] : []))

const readRuns = (tags) => {
  const files = {}
  for (const tag of (tags ?? '').split(',').filter(Boolean)) {
    const summary = path.join('/tmp/rs-mongo-runs', tag, 'summary.json')
    if (fs.existsSync(summary)) {
      Object.assign(files, JSON.parse(fs.readFileSync(summary, 'utf8')).files)
    }
  }
  return files
}

const baseline = new Map(
  JSON.parse(fs.readFileSync(path.resolve(root, option('--baseline')), 'utf8')).testResults.map(
    (result) => [path.relative(root, result.name), result],
  ),
)
const columns = columnArgs.map((arg) => {
  const [name, tags] = arg.split('=')
  return { name, runs: readRuns(tags) }
})

const countsOf = (fileResult) => {
  const counts = { failed: 0, passed: 0, skipped: 0 }
  for (const test of fileResult?.assertionResults ?? []) {
    counts[test.status === 'passed' ? 'passed' : test.status === 'failed' ? 'failed' : 'skipped']++
  }
  return counts
}
const cell = (entry) =>
  entry
    ? `${entry.counts.passed}/${entry.counts.failed}/${entry.counts.skipped}${entry.differences?.length ? ` **${entry.differences.length} diff**` : ''}${entry.loadError ? ' LOAD' : ''}`
    : '-'

const files = [
  ...new Set([...baseline.keys(), ...columns.flatMap((column) => Object.keys(column.runs))]),
].sort()
const lines = [
  `| file | TS baseline p/f/s | ${columns.map((column) => `${column.name} p/f/s`).join(' | ')} |`,
  `|---|---|${columns.map(() => '---').join('|')}|`,
]
for (const file of files) {
  const base = baseline.get(file)
  const counts = countsOf(base)
  lines.push(
    `| ${file} | ${base ? `${counts.passed}/${counts.failed}/${counts.skipped}` : '-'} | ${columns.map((column) => cell(column.runs[file])).join(' | ')} |`,
  )
}
lines.push('')
for (const column of columns) {
  const entries = Object.values(column.runs)
  const totals = { differences: 0, engineCalls: 0, failed: 0, files: entries.length, passed: 0, skipped: 0 }
  for (const entry of entries) {
    totals.passed += entry.counts.passed
    totals.failed += entry.counts.failed
    totals.skipped += entry.counts.skipped
    totals.differences += entry.differences?.length ?? 0
    totals.engineCalls += entry.engineCalls ?? 0
  }
  lines.push(`- ${column.name}: ${JSON.stringify(totals)}`)
  for (const [file, entry] of Object.entries(column.runs).sort()) {
    for (const difference of entry.differences ?? []) {
      lines.push(
        `  - ${file}: ${difference.baseline} -> ${difference.status}: ${difference.name}${difference.failure ? ` (${String(difference.failure).slice(0, 160)})` : ''}`,
      )
    }
    if (entry.loadError) {
      lines.push(`  - ${file}: load error ${String(entry.loadError).split('\n')[0].slice(0, 160)}`)
    }
  }
}
process.stdout.write(`${lines.join('\n')}\n`)
