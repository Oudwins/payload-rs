/**
 * Compares the cross-process traces of test/__rs/core-ops-write/run.sh's trace modes (shadow.ts
 * `trace-ts` / `trace-rs`): for every suite, the `trace-rs` run's top-level write calls against the
 * `trace-ts` run's, test by test and call by call. A call whose Rust log differs from the TS log is
 * counted `unstable` only when it equals the log of the same call in the second TS process
 * (`trace-ts2`), else it is a diff; a test with a different number of calls is compared the same
 * way. Fails on any diff, a changed test outcome, a missing report or trace of a mode, zero calls
 * compared, a Rust run that served no call from the Rust crate, or a TS run that did
 * (`sameEngine`).
 *
 *   node test/__rs/core-ops-write/trace-compare.mjs /tmp/rs-ops-write synthetic hooks
 */
import fs from 'node:fs'
import path from 'node:path'

const [outDir, ...suites] = process.argv.slice(2)
const MODES = ['trace-ts', 'trace-ts2', 'trace-rs']
let failed = false
const fail = (msg) => {
  failed = true
  console.log(`FAIL ${msg}`)
}

const outcomes = (file) => {
  if (!fs.existsSync(file)) {
    return undefined
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const map = new Map()
  for (const result of report.testResults ?? []) {
    for (const t of result.assertionResults ?? []) {
      map.set(t.fullName, t.status)
    }
  }
  return map
}

/** `test name -> [{ op, log }]` in call order, the summed stats and the Rust call count. */
const traces = (dir) => {
  if (!fs.existsSync(dir)) {
    return undefined
  }
  const byTest = new Map()
  const stats = {}
  let rustCalls = 0
  let files = 0
  for (const f of fs.readdirSync(dir).sort()) {
    if (f.endsWith('.traces.jsonl')) {
      files++
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const line of text.split('\n')) {
        if (!line) {
          continue
        }
        const t = JSON.parse(line)
        const key = `${f.replace(/\.\d+\.\d+\.json\.traces\.jsonl$/, '')} > ${t.test ?? '(outside a test)'}`
        if (!byTest.has(key)) {
          byTest.set(key, [])
        }
        byTest.get(key).push(t)
      }
    } else if (f.endsWith('.json')) {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      rustCalls += r.rustCalls ?? 0
      for (const [op, s] of Object.entries(r.stats)) {
        const total = (stats[op] ??= {})
        for (const [k, v] of Object.entries(s)) {
          total[k] = (total[k] ?? 0) + v
        }
      }
    }
  }
  return { byTest, files, rustCalls, stats }
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

const clip = (s) => (s && s.length > 1500 ? `${s.slice(0, 1500)}...(${s.length})` : s)
const sameCall = (a, b) => a && b && a.op === b.op && firstDiff(a.log, b.log) === -1

const rows = []
for (const suite of suites) {
  const tag = suite.replaceAll('/', '_')
  const row = { suite, compared: 0, diffs: 0, equal: 0, unstable: 0 }
  const runs = {}
  for (const mode of MODES) {
    const o = outcomes(path.join(outDir, mode, `${tag}.json`))
    const t = traces(path.join(outDir, mode, `ops-${tag}`))
    if (!o || !t || t.files === 0) {
      fail(`${suite}: missing ${mode} report or traces`)
      continue
    }
    runs[mode] = { outcomes: o, ...t }
    const counts = { failed: 0, passed: 0, skipped: 0 }
    for (const status of o.values()) {
      counts[status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped']++
    }
    row[mode] = `${counts.passed}/${counts.failed}/${counts.skipped}`
    const sameEngine = Object.values(t.stats).reduce((n, s) => n + (s.sameEngine ?? 0), 0)
    if (sameEngine) {
      fail(`${suite} ${mode}: ${sameEngine} calls ran the other engine`)
    }
  }
  const ts = runs['trace-ts']
  const ts2 = runs['trace-ts2']
  const rs = runs['trace-rs']
  if (!ts || !ts2 || !rs) {
    rows.push(row)
    continue
  }
  for (const [name, status] of ts.outcomes) {
    if (rs.outcomes.get(name) !== status) {
      fail(
        `${suite}: test outcome changed in trace-rs: ${name} (${status} -> ${rs.outcomes.get(name)})`,
      )
    }
  }
  if (rs.rustCalls === 0) {
    fail(`${suite}: the Rust run served no write operation from the Rust crate`)
  }
  row.rustCalls = rs.rustCalls
  const shown = []
  const testNames = new Set([...ts.byTest.keys(), ...rs.byTest.keys()])
  for (const test of testNames) {
    const a = ts.byTest.get(test) ?? []
    const b = rs.byTest.get(test) ?? []
    const c = ts2.byTest.get(test) ?? []
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      row.compared++
      if (sameCall(a[i], b[i])) {
        row.equal++
        continue
      }
      if (sameCall(c[i], b[i])) {
        row.unstable++
        continue
      }
      row.diffs++
      if (shown.length < 5) {
        const at = a[i] && b[i] ? firstDiff(a[i].log, b[i].log) : -1
        shown.push({
          at,
          op: `${a[i]?.op ?? '-'} / ${b[i]?.op ?? '-'}`,
          rs: b[i]?.log.slice(Math.max(0, at - 1), at + 2).map(clip),
          test,
          ts: a[i]?.log.slice(Math.max(0, at - 1), at + 2).map(clip),
          ts2: c[i]?.log.slice(Math.max(0, at - 1), at + 2).map(clip),
        })
      }
    }
  }
  const byOp = {}
  for (const [op, s] of Object.entries(rs.stats)) {
    byOp[op] = s.compared
  }
  row.ops = JSON.stringify(byOp)
  if (row.compared === 0) {
    fail(`${suite}: no write call compared`)
  }
  if (row.diffs) {
    fail(`${suite}: ${row.diffs} diffs`)
    for (const d of shown) {
      console.log(JSON.stringify(d, null, 1))
    }
  }
  rows.push(row)
}
console.table(rows)
console.log(failed ? 'trace-compare: FAILED' : 'trace-compare: OK')
process.exit(failed ? 1 : 0)
