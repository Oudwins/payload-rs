#!/usr/bin/env node
/**
 * Checks a dual-run report (RS_LIVE_JOINS_REPORT JSONL of dual.ts): fails on zero compared calls,
 * on any difference, on a candidate that was not the Rust port or did not reach the engine, and
 * when a function was never exercised beyond its early return.
 *
 *   node test/__rs/mongo-live-joins/check.mjs <report.jsonl> [--require resolveJoins,buildJoinAggregation]
 */
import fs from 'node:fs'

const [file, ...rest] = process.argv.slice(2)
const required = (rest[rest.indexOf('--require') + 1] ?? '').split(',').filter(Boolean)
const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
const entries = lines.map((l) => JSON.parse(l))
const problems = []
if (entries.length === 0) {
  problems.push('no compared calls')
}
const stats = {}
for (const e of entries) {
  const s = (stats[e.name] ??= { calls: 0, differ: 0, maxEvents: 0, threw: 0 })
  s.calls++
  s.maxEvents = Math.max(s.maxEvents, e.events)
  if (e.threw) s.threw++
  if (!e.ok) {
    s.differ++
    if (s.differ <= 3) problems.push(`${e.name} differs: ${e.diff.slice(0, 500)}`)
  }
  if (e.candidate !== 'rs') problems.push(`${e.name}: candidate was ${e.candidate}, not the Rust port`)
  if (!e.reachedRust) problems.push(`${e.name}: the candidate call did not reach the engine`)
}
for (const name of required) {
  if (!stats[name]) problems.push(`${name}: never called`)
  else if (stats[name].maxEvents < 100) problems.push(`${name}: only trivial traces (max ${stats[name].maxEvents} events)`)
}
console.log(JSON.stringify(stats))
if (problems.length) {
  console.error([...new Set(problems)].slice(0, 20).join('\n'))
  process.exit(1)
}
