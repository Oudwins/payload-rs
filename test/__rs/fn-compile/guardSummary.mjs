#!/usr/bin/env node
/**
 * Summarises guard-mode statistics (`PAYLOAD_FN_COMPILE_STATS=<dir>`, one `<pid>.json` per test
 * process, written by packages/engine-rs/src/compile/guard.ts): functions seen / compiled, calls,
 * verified evaluations, bails and mismatches, per test file and in total. Exits non-zero on any
 * mismatch.
 *
 *   node test/__rs/fn-compile/guardSummary.mjs <dir> [--json out.json] [--bails]
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const dir = argv[0]
if (!dir) {
  console.error('usage: guardSummary.mjs <dir> [--json out.json] [--bails]')
  process.exit(2)
}
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : undefined

const files = []
const walk = (d) => {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, entry.name)
    if (entry.isDirectory()) {
      walk(p)
    } else if (entry.name.endsWith('.json')) {
      files.push(p)
    }
  }
}
walk(dir)

const total = {
  bails: 0,
  calls: 0,
  compiled: 0,
  deoptimized: 0,
  functions: 0,
  mismatches: 0,
  verified: 0,
}
const perFile = new Map()
const mismatches = []
const bailsByLabel = new Map()
const bailReasons = new Map()
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'))
  const key = data.testFile ? path.relative(process.cwd(), data.testFile) : path.relative(dir, f)
  const row = perFile.get(key) ?? {
    bails: 0,
    calls: 0,
    compiled: 0,
    functions: 0,
    mismatches: 0,
    verified: 0,
  }
  for (const fn of data.functions) {
    row.functions++
    total.functions++
    if (fn.compiled) {
      row.compiled++
      total.compiled++
    }
    const s = fn.stats
    if (!s) {
      continue
    }
    row.calls += s.calls
    row.verified += s.verified
    row.bails += s.bails
    row.mismatches += s.mismatches
    total.calls += s.calls
    total.verified += s.verified
    total.bails += s.bails
    total.mismatches += s.mismatches
    total.deoptimized += s.deoptimized ? 1 : 0
    for (const [reason, n] of Object.entries(fn.bailReasons ?? {})) {
      bailReasons.set(reason, (bailReasons.get(reason) ?? 0) + n)
    }
    if (s.bails) {
      bailsByLabel.set(fn.label, (bailsByLabel.get(fn.label) ?? 0) + s.bails)
    }
    for (const m of fn.mismatches ?? []) {
      mismatches.push({ file: key, label: fn.label, ...m })
    }
  }
  perFile.set(key, row)
}

console.log(
  '| test file | functions | compiled | evaluations checked (match) | bails | mismatches |',
)
console.log('| --- | --- | --- | --- | --- | --- |')
for (const [k, r] of [...perFile].sort()) {
  console.log(
    `| ${k} | ${r.functions} | ${r.compiled} | ${r.verified} | ${r.bails} | ${r.mismatches} |`,
  )
}
console.log(
  `\nprocesses: ${files.length}; functions seen: ${total.functions}, compiled: ${total.compiled}; guarded calls: ${total.calls}; compiled evaluations checked equal to JS: ${total.verified}; bails (JS result used): ${total.bails}; mismatches: ${total.mismatches} (de-optimised functions: ${total.deoptimized})`,
)
console.log('\nbail reasons (compiled evaluations that handed the call back to JS):')
for (const [reason, n] of [...bailReasons].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`- ${n} ${reason}`)
}
if (argv.includes('--bails')) {
  console.log('\nbails by function:')
  for (const [label, n] of [...bailsByLabel].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`- ${n} ${label}`)
  }
}
for (const m of mismatches.slice(0, 30)) {
  console.log(
    `\nMISMATCH ${m.file} ${m.label}\n  compiled: ${m.compiled}\n  js:       ${m.js}\n  args:     ${m.args.slice(0, 600)}`,
  )
}
if (jsonOut) {
  fs.writeFileSync(
    jsonOut,
    JSON.stringify({ mismatches, perFile: Object.fromEntries(perFile), total }, null, 2),
  )
}
process.exit(total.mismatches > 0 ? 1 : 0)
