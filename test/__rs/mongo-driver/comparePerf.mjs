#!/usr/bin/env node
/**
 * Speedups between two perf-suite runs (test/__rs/perf `results.json`): the reference engine's
 * medians from one run against the candidate engine's from another (or the same) run, per scenario,
 * with geometric means per surface, per category and overall, per database / shape.
 *
 *   node test/__rs/mongo-driver/comparePerf.mjs <ref results.json> <candidate results.json>
 *     [--ref-engine ts] [--candidate-engine rs] [--scenarios <regex>] [--rows]
 */
import fs from 'node:fs'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}
const [refFile, candidateFile] = argv.filter(
  (arg, i) => !arg.startsWith('--') && !argv[i - 1]?.startsWith('--'),
)
const refEngine = option('--ref-engine', 'ts')
const candidateEngine = option('--candidate-engine', 'rs')
const pattern = new RegExp(option('--scenarios', '.'), 'i')
const isRows = argv.includes('--rows')

const medians = (file, engine) => {
  const out = new Map()
  for (const cell of JSON.parse(fs.readFileSync(file, 'utf8')).cells) {
    if (cell.engine !== engine || cell.kind === 'startup') continue
    for (const scenario of cell.scenarios ?? []) {
      if (!scenario.stats || !pattern.test(scenario.name)) continue
      const key = [
        cell.database,
        cell.shape,
        cell.size,
        scenario.surface,
        scenario.category,
        scenario.name,
      ].join('|')
      out.set(key, scenario.stats.medianMs)
    }
  }
  return out
}
const ref = medians(refFile, refEngine)
const candidate = medians(candidateFile, candidateEngine)
const groups = new Map()
const add = (group, value) => {
  const entry = groups.get(group) ?? { logSum: 0, n: 0 }
  entry.logSum += Math.log(value)
  entry.n++
  groups.set(group, entry)
}
const rows = []
for (const [key, refMs] of ref) {
  const candidateMs = candidate.get(key)
  if (!(refMs > 0) || !(candidateMs > 0)) continue
  const speedup = refMs / candidateMs
  const [database, shape, size, surface, category, name] = key.split('|')
  rows.push({ category, name, refMs, candidateMs, shape, speedup, surface })
  add(`${database} all`, speedup)
  add(`${database} ${surface}`, speedup)
  add(`${database} category ${category}`, speedup)
  add(`${database} ${shape}/${size} ${surface}`, speedup)
}
const geo = ({ logSum, n }) => Math.exp(logSum / n)
console.log('| group | n | geomean |\n|---|---|---|')
for (const [group, entry] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`| ${group} | ${entry.n} | ${geo(entry).toFixed(2)}x |`)
}
if (isRows) {
  console.log(
    '\n| shape | surface | category | scenario | ref ms | candidate ms | speedup |\n|---|---|---|---|---|---|---|',
  )
  for (const row of rows) {
    console.log(
      `| ${row.shape} | ${row.surface} | ${row.category} | ${row.name} | ${row.refMs.toFixed(3)} | ${row.candidateMs.toFixed(3)} | ${row.speedup.toFixed(2)}x |`,
    )
  }
}
