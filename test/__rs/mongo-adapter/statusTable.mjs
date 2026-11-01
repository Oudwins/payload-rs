#!/usr/bin/env node
/**
 * Per-suite markdown table for packages/engine-rs/MONGO_ENGINE_STATUS.md from runSuites.mjs
 * summaries (later tags override earlier ones per file, i.e. solo reruns):
 *
 *   node test/__rs/mongo-adapter/statusTable.mjs --baseline .rs-baseline/mongodb-all.json \
 *     --loopback madl2,madl3,madl4 --native madn1
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
const loopback = readRuns(option('--loopback'))
const native = readRuns(option('--native'))

const countsOf = (fileResult) => {
  const counts = { failed: 0, passed: 0, skipped: 0 }
  for (const test of fileResult?.assertionResults ?? []) {
    counts[test.status === 'passed' ? 'passed' : test.status === 'failed' ? 'failed' : 'skipped']++
  }
  return counts
}
const cell = (entry) =>
  entry
    ? `${entry.counts.passed}/${entry.counts.failed}/${entry.counts.skipped}${entry.differences.length ? ` **${entry.differences.length} diff**` : ''}${entry.loadError ? ' LOAD' : ''}`
    : '-'

const files = [
  ...new Set([...baseline.keys(), ...Object.keys(loopback), ...Object.keys(native)]),
].sort()
const lines = [
  '| file | TS baseline p/f/s | loopback p/f/s | native p/f/s | native engine calls |',
  '|---|---|---|---|---|',
]
const totals = { loopbackDiffs: 0, nativeDiffs: 0, nativeFiles: 0 }
for (const file of files) {
  const base = countsOf(baseline.get(file))
  totals.loopbackDiffs += loopback[file]?.differences.length ?? 0
  totals.nativeDiffs += native[file]?.differences.length ?? 0
  totals.nativeFiles += native[file] ? 1 : 0
  lines.push(
    `| ${file} | ${base.passed}/${base.failed}/${base.skipped} | ${cell(loopback[file])} | ${cell(native[file])} | ${native[file]?.engineCalls ?? '-'} |`,
  )
}
lines.push('')
lines.push(`Totals: ${JSON.stringify(totals)}`)
const differing = files.filter((file) => native[file]?.differences.length)
if (differing.length) {
  lines.push('', 'Native differences:', '')
  for (const file of differing) {
    for (const difference of native[file].differences) {
      lines.push(
        `- ${file}: ${difference.baseline} -> ${difference.status}: ${difference.name}${difference.failure ? ` (${difference.failure.slice(0, 200)})` : ''}`,
      )
    }
  }
}
process.stdout.write(`${lines.join('\n')}\n`)
