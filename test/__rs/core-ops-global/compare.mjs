#!/usr/bin/env node
/**
 * Compares the traces run.sh recorded (`<out>/<mode>/<suite>/trace-*.jsonl`, see trace.ts).
 *
 *   node test/__rs/core-ops-global/compare.mjs <out> <suite...>
 *
 * Per suite, every case of the `ts` run (key: test file, test name, call sequence number in the
 * test) is compared event for event with the same case of each candidate run present (`rs`,
 * `full`). A case whose candidate log differs is a diff, unless the second reference run (`ts2`)
 * differs from `ts` too (then it is `unstable`: the TS run is not reproducible there). Cases only
 * one side has are diffs. Per-test outcomes of the candidate must equal the reference's.
 *
 * Exits 1 on any diff, changed outcome, missing report or trace, a reference case that ran Rust or
 * a candidate case that ran TS, or when a suite compared no case.
 */
import fs from 'node:fs'
import path from 'node:path'

const [out, ...suites] = process.argv.slice(2)
if (!out || suites.length === 0) {
  console.error('usage: compare.mjs <out> <suite...>')
  process.exit(2)
}

const CANDIDATES = ['rs', 'full']
const MAX_SHOWN = Number(process.env.RS_OPS_GLOBAL_SHOW ?? 6)
const failures = []
const fail = (message) => failures.push(message)

const tagOf = (suite) => suite.replace(/[/.]/g, '_')

const readTrace = (dir) => {
  if (!fs.existsSync(dir)) {
    return undefined
  }
  const cases = new Map()
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('trace-') || !name.endsWith('.jsonl')) {
      continue
    }
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line) {
        continue
      }
      const entry = JSON.parse(line)
      const key = `${entry.file}|${entry.test}|${entry.seq}`
      if (cases.has(key)) {
        fail(`${dir}: duplicate case ${key}`)
      }
      cases.set(key, entry)
    }
  }
  return cases
}

const readOutcomes = (file) => {
  if (!fs.existsSync(file)) {
    return undefined
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const outcomes = new Map()
  for (const result of report.testResults ?? []) {
    for (const test of result.assertionResults ?? []) {
      outcomes.set(test.fullName, test.status)
    }
  }
  return outcomes
}

const firstDiff = (a, b) => {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return i
    }
  }
  return -1
}

const clip = (s) => (s === undefined ? '(none)' : s.length > 1500 ? `${s.slice(0, 1500)}...` : s)

const rows = []
for (const suite of suites) {
  const tag = tagOf(suite)
  const ref = readTrace(path.join(out, 'ts', tag))
  const ref2 = readTrace(path.join(out, 'ts2', tag))
  const refOutcomes = readOutcomes(path.join(out, 'ts', tag, 'report.json'))
  if (!ref || !refOutcomes) {
    fail(`${suite}: missing ts trace or report`)
    continue
  }
  if (!ref2) {
    fail(`${suite}: missing ts2 trace (needed to tell diffs from unstable cases)`)
  }
  for (const entry of ref.values()) {
    if (entry.impl !== 'ts') {
      fail(`${suite}: reference case ran ${entry.impl}: ${entry.op} ${entry.test}`)
    }
  }
  let candidatesRun = 0
  for (const mode of CANDIDATES) {
    const dir = path.join(out, mode, tag)
    if (!fs.existsSync(dir)) {
      continue
    }
    candidatesRun++
    const cand = readTrace(dir)
    const candOutcomes = readOutcomes(path.join(dir, 'report.json'))
    if (!candOutcomes) {
      fail(`${suite} ${mode}: missing report`)
      continue
    }
    // A test whose reference run is not reproducible (any of its cases differs between `ts` and
    // `ts2`, e.g. concurrent logins racing password hashing on the thread pool) has every case
    // counted as unstable when it differs: its interleaving is not determined by the code.
    const unstableTests = new Set()
    for (const [key, entry] of ref) {
      const again = ref2?.get(key)
      if (!again || firstDiff(entry.log, again.log) !== -1) {
        unstableTests.add(`${entry.file}|${entry.test}`)
      }
    }
    const perOp = {}
    const stat = (op) =>
      (perOp[op] ??= { compared: 0, diffs: 0, equal: 0, events: 0, rejections: 0, unstable: 0 })
    let shown = 0
    for (const [key, entry] of ref) {
      const s = stat(entry.op)
      const other = cand.get(key)
      if (!other) {
        s.diffs++
        if (shown++ < MAX_SHOWN) {
          console.log(`\n[${suite} ${mode}] DIFF ${entry.op} ${key}: missing in ${mode}`)
        }
        continue
      }
      if (other.impl !== 'rs') {
        fail(`${suite} ${mode}: candidate case ran ${other.impl}: ${entry.op} ${entry.test}`)
      }
      s.compared++
      s.events += entry.log.length
      if (
        entry.log.some(
          (e) => e.includes('"ev":"outcome","ok":false'),
        )
      ) {
        s.rejections++
      }
      const at = firstDiff(entry.log, other.log)
      if (at === -1) {
        s.equal++
        continue
      }
      if (unstableTests.has(`${entry.file}|${entry.test}`)) {
        s.unstable++
        continue
      }
      s.diffs++
      if (shown++ < MAX_SHOWN) {
        console.log(`\n[${suite} ${mode}] DIFF ${entry.op} ${key} at event ${at}`)
        for (let i = Math.max(0, at - 2); i < at; i++) {
          console.log(`  =  ${clip(entry.log[i])}`)
        }
        console.log(`  ts ${clip(entry.log[at])}`)
        console.log(`  ${mode} ${clip(other.log[at])}`)
      }
    }
    for (const [key, entry] of cand) {
      if (!ref.has(key)) {
        stat(entry.op).diffs++
        if (shown++ < MAX_SHOWN) {
          console.log(`\n[${suite} ${mode}] DIFF ${entry.op} ${key}: missing in ts`)
        }
      }
    }
    let changed = 0
    for (const [name, status] of refOutcomes) {
      if (candOutcomes.get(name) !== status) {
        changed++
        console.log(
          `[${suite} ${mode}] outcome changed: ${name}: ${status} -> ${candOutcomes.get(name)}`,
        )
      }
    }
    for (const name of candOutcomes.keys()) {
      if (!refOutcomes.has(name)) {
        changed++
      }
    }
    const total = Object.values(perOp).reduce(
      (acc, s) => {
        for (const k of Object.keys(acc)) {
          acc[k] += s[k]
        }
        return acc
      },
      { compared: 0, diffs: 0, equal: 0, events: 0, rejections: 0, unstable: 0 },
    )
    rows.push({ changed, mode, perOp, suite, total })
    if (total.diffs > 0) {
      fail(`${suite} ${mode}: ${total.diffs} diffs`)
    }
    if (changed > 0) {
      fail(`${suite} ${mode}: ${changed} test outcomes changed`)
    }
    if (total.compared === 0) {
      fail(`${suite} ${mode}: no case compared`)
    }
  }
  if (candidatesRun === 0) {
    fail(`${suite}: no candidate run`)
  }
}

console.log(
  '\n| suite | mode | cases compared | equal | diffs | unstable | events | rejecting cases | outcomes changed |',
)
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const { changed, mode, suite, total } of rows) {
  console.log(
    `| ${suite} | ${mode} | ${total.compared} | ${total.equal} | ${total.diffs} | ${total.unstable} | ${total.events} | ${total.rejections} | ${changed} |`,
  )
}
const ops = {}
for (const { perOp } of rows) {
  for (const [op, s] of Object.entries(perOp)) {
    const t = (ops[op] ??= { compared: 0, diffs: 0, unstable: 0 })
    t.compared += s.compared
    t.diffs += s.diffs
    t.unstable += s.unstable
  }
}
console.log(
  '\nper operation:',
  Object.entries(ops)
    .sort()
    .map(
      ([op, s]) =>
        `${op} ${s.compared}${s.diffs ? ` (${s.diffs} diffs)` : ''}${s.unstable ? ` (${s.unstable} unstable)` : ''}`,
    )
    .join(', '),
)
if (failures.length > 0) {
  console.log(`\nFAILED:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\nOK')
