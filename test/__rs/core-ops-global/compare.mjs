#!/usr/bin/env node
/**
 * Compares the traces run.sh recorded (`<out>/<mode>/<suite>/trace-*.jsonl`, see trace.ts).
 *
 *   node test/__rs/core-ops-global/compare.mjs <out> <suite...>
 *
 * Per suite, every case of the `ts` run (key: test file, test name, call sequence number in the
 * test) is compared event for event with the same case of the candidate run (`rs`). A case whose
 * candidate log differs from `ts` is checked against every reference run, and only counted as not
 * a diff when the candidate equals one of them:
 * - `unstable`: the candidate log equals the case's log in the second reference run (`ts2`);
 * - `idOrder`: equal to a reference log once record ids are numbered per case by first appearance
 *   (ids of documents created concurrently, e.g. `Promise.all(payload.create(...))` racing
 *   password hashing on the thread pool, are assigned in completion order), and values of fields
 *   that are random by construction but too short for trace.ts' token canonicalization
 *   (`apiKey` / `apiKeyLast4` of generated API keys: their random tails can be shorter than the
 *   24 hex characters trace.ts tokenizes) are numbered the same way (snapshot bookkeeping keys
 *   such as `$id` are left alone);
 * - `reordered`: the multiset of the test's case logs (ids numbered as above) equals that of a
 *   reference run (concurrent calls of one test settling in a different interleaving).
 * Anything else is a diff; cases only one side has are diffs. Per-test outcomes of the candidate
 * must equal the reference's.
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

const CANDIDATES = ['rs']
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

/**
 * The case log with record ids numbered by first appearance: values of `id` keys anywhere in the
 * events are collected, then every equal number or string in the log becomes `{"$idn":n}`.
 */
const RANDOM_KEYS = new Set(['apiKey', 'apiKeyLast4'])
const normalizeIDs = (log) => {
  const events = log.map((e) => JSON.parse(e))
  const ids = new Set()
  const collect = (v) => {
    if (Array.isArray(v)) {
      v.forEach(collect)
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k.startsWith('$') && k !== '$a') {
          continue
        }
        if (
          (k === 'id' || RANDOM_KEYS.has(k)) &&
          (typeof x === 'number' || typeof x === 'string')
        ) {
          ids.add(`${typeof x}:${x}`)
        }
        collect(x)
      }
    }
  }
  events.forEach(collect)
  const order = new Map()
  const replace = (v) => {
    if (typeof v === 'number' || typeof v === 'string') {
      const key = `${typeof v}:${v}`
      if (ids.has(key)) {
        if (!order.has(key)) {
          order.set(key, order.size)
        }
        return { $idn: order.get(key) }
      }
      return v
    }
    if (Array.isArray(v)) {
      return v.map(replace)
    }
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, x] of Object.entries(v)) {
        out[k] = k.startsWith('$') && k !== '$a' ? x : replace(x)
      }
      return out
    }
    return v
  }
  return events.map((e) => JSON.stringify(replace(e)))
}

const sameLog = (a, b) => !!a && !!b && firstDiff(a, b) === -1

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
    const perOp = {}
    const stat = (op) =>
      (perOp[op] ??= {
        compared: 0,
        diffs: 0,
        equal: 0,
        events: 0,
        idOrder: 0,
        rejections: 0,
        reordered: 0,
        unstable: 0,
      })
    let shown = 0
    const showDiff = (entry, key, other, at) => {
      if (shown++ < MAX_SHOWN) {
        console.log(`\n[${suite} ${mode}] DIFF ${entry.op} ${key} at event ${at}`)
        for (let i = Math.max(0, at - 2); i < at; i++) {
          console.log(`  =  ${clip(entry.log[i])}`)
        }
        console.log(`  ts ${clip(entry.log[at])}`)
        console.log(`  ${mode} ${clip(other.log[at])}`)
      }
    }
    // Cases that match no reference run case by case, per test: decided by the multiset check.
    const pendingByTest = new Map()
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
      if (entry.log.some((e) => e.includes('"ev":"outcome","ok":false'))) {
        s.rejections++
      }
      if (sameLog(entry.log, other.log)) {
        s.equal++
        continue
      }
      const again = ref2?.get(key)
      if (sameLog(again?.log, other.log)) {
        s.unstable++
        continue
      }
      const otherIDs = normalizeIDs(other.log)
      if (
        sameLog(normalizeIDs(entry.log), otherIDs) ||
        (again && sameLog(normalizeIDs(again.log), otherIDs))
      ) {
        s.idOrder++
        continue
      }
      const testKey = `${entry.file}|${entry.test}`
      if (!pendingByTest.has(testKey)) {
        pendingByTest.set(testKey, [])
      }
      pendingByTest.get(testKey).push({ at: firstDiff(entry.log, other.log), entry, key, other })
    }
    const testLogs = (cases, testKey) =>
      [...cases.values()]
        .filter((e) => `${e.file}|${e.test}` === testKey)
        .map((e) => `${e.op}\n${normalizeIDs(e.log).join('\n')}`)
        .sort()
    for (const [testKey, pending] of pendingByTest) {
      const candLogs = testLogs(cand, testKey)
      const matches = [ref, ref2]
        .filter(Boolean)
        .some((r) => sameLog(testLogs(r, testKey), candLogs))
      for (const { at, entry, key, other } of pending) {
        if (matches) {
          stat(entry.op).reordered++
        } else {
          stat(entry.op).diffs++
          showDiff(entry, key, other, at)
        }
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
      {
        compared: 0,
        diffs: 0,
        equal: 0,
        events: 0,
        idOrder: 0,
        rejections: 0,
        reordered: 0,
        unstable: 0,
      },
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
  '\n| suite | mode | cases compared | equal | diffs | unstable (= ts2) | id order | reordered | events | rejecting cases | outcomes changed |',
)
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for (const { changed, mode, suite, total } of rows) {
  console.log(
    `| ${suite} | ${mode} | ${total.compared} | ${total.equal} | ${total.diffs} | ${total.unstable} | ${total.idOrder} | ${total.reordered} | ${total.events} | ${total.rejections} | ${changed} |`,
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
