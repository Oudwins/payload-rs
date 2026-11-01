/**
 * Summarizes a test/__rs/core-ops/run.sh output dir: per suite, per-test outcome parity of
 * `PAYLOAD_OPS=rs` (and `shadow`) against `ts`, Rust operation call counts, and the shadow
 * differential (cases compared, equal, diffs, unstable). Exits 1 on any diff, any outcome
 * difference, a missing report of a requested mode (`MODES`, default "ts rs shadow"), when a suite
 * compared zero cases, when a shadow branch ran the wrong engine, or when the synthetic suite's
 * recorded `rs` operation outcomes differ from the `ts` ones.
 *
 *   node test/__rs/core-ops/summarize.mjs /tmp/rs-ops sort fields
 */
import fs from 'node:fs'
import path from 'node:path'

const [outDir, ...suites] = process.argv.slice(2)
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

const opReports = (dir) => {
  const total = {}
  const diffs = []
  if (!fs.existsSync(dir)) {
    return { diffs, files: 0, total }
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    for (const [op, s] of Object.entries(r.stats)) {
      const t = (total[op] ??= {})
      for (const [k, v] of Object.entries(s)) {
        t[k] = (t[k] ?? 0) + v
      }
    }
    diffs.push(...r.diffs)
  }
  return { diffs, files: files.length, total }
}

const modes = (process.env.MODES ?? 'ts rs shadow').split(/\s+/).filter(Boolean)
const rows = []
for (const suite of suites) {
  const tag = suite.replaceAll('/', '_')
  const ts = outcomes(path.join(outDir, 'ts', `${tag}.json`))
  const row = { suite }
  for (const mode of ['ts', 'rs', 'shadow']) {
    const o = outcomes(path.join(outDir, mode, `${tag}.json`))
    if (!o) {
      if (modes.includes(mode)) {
        fail(`${suite}: missing ${mode} report`)
      }
      continue
    }
    if (o.size === 0) {
      fail(`${suite} ${mode}: no test ran`)
    }
    const counts = { failed: 0, passed: 0, skipped: 0 }
    for (const status of o.values()) {
      counts[status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped']++
    }
    row[mode] = `${counts.passed}/${counts.failed}/${counts.skipped}`
    if (mode !== 'ts' && ts) {
      const changed = [...ts.entries()].filter(([name, status]) => o.get(name) !== status)
      row[`${mode}Changed`] = changed.length
      for (const [name, status] of changed) {
        const msg = `${suite} ${mode}: "${name}" ${status} -> ${o.get(name)}`
        if (mode === 'rs') {
          fail(msg)
        } else {
          console.log(
            `NOTE ${msg} (shadow runs operations 3x; hook side effects can change outcomes)`,
          )
        }
      }
    }
    const ops = opReports(path.join(outDir, mode, `ops-${tag}`))
    const calls = Object.values(ops.total).reduce((n, s) => n + (s.calls ?? 0), 0)
    row[`${mode}Calls`] = calls
    if (mode === 'rs' && calls === 0) {
      fail(`${suite} rs: no Rust operation was called`)
    }
    if (mode === 'shadow') {
      const sum = (k) => Object.values(ops.total).reduce((n, s) => n + (s[k] ?? 0), 0)
      row.compared = sum('compared')
      row.equal = sum('equal')
      row.diffs = sum('diffs')
      row.unstable = sum('unstable')
      row.events = sum('events')
      row.rejections = sum('rejections')
      row.engineMismatch = sum('engineMismatch')
      if (row.engineMismatch > 0) {
        fail(`${suite} shadow: ${row.engineMismatch} branches ran the wrong engine`)
      }
      row.perOp = Object.entries(ops.total)
        .map(
          ([op, s]) =>
            `${op}:${s.compared}${s.diffs ? `/${s.diffs}d` : ''}${s.unstable ? `/${s.unstable}u` : ''}`,
        )
        .join(' ')
      if (ops.files === 0 || row.compared === 0) {
        fail(`${suite} shadow: zero cases compared`)
      }
      if (row.diffs > 0) {
        fail(`${suite} shadow: ${row.diffs} diffs`)
        for (const d of ops.diffs.slice(0, 5)) {
          console.log(
            `  ${d.op} | ${d.test} | at ${d.at}\n    ts: ${(d.ts[2] ?? d.ts[0] ?? '').slice(0, 600)}\n    rs: ${(d.rs[2] ?? d.rs[0] ?? '').slice(0, 600)}`,
          )
        }
      }
    }
  }
  // operation outcomes the synthetic suite records in ts / rs mode
  const recorded = Object.fromEntries(
    ['ts', 'rs'].map((mode) => {
      const file = path.join(outDir, mode, `ops-${tag}`, 'synthetic.outcomes')
      return [mode, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined]
    }),
  )
  if (recorded.ts || recorded.rs) {
    if (!recorded.ts?.length || !recorded.rs?.length) {
      fail(
        `${suite}: synthetic outcomes missing or empty (ts ${recorded.ts?.length}, rs ${recorded.rs?.length})`,
      )
    } else {
      row.outcomes = recorded.ts.length
      const n = Math.max(recorded.ts.length, recorded.rs.length)
      let differing = 0
      for (let i = 0; i < n; i++) {
        if (recorded.ts[i] !== recorded.rs[i]) {
          if (differing++ < 5) {
            console.log(
              `  outcome ${i}\n    ts: ${String(recorded.ts[i]).slice(0, 400)}\n    rs: ${String(recorded.rs[i]).slice(0, 400)}`,
            )
          }
        }
      }
      row.outcomeDiffs = differing
      if (differing) {
        fail(`${suite}: ${differing} rs operation outcomes differ from ts`)
      }
    }
  }
  rows.push(row)
}
console.table(rows)
process.exit(failed ? 1 : 0)
