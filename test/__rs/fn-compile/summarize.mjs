#!/usr/bin/env node
/**
 * Summarises the compile-rate reports written by configs.int.spec.ts (`test-configs.json`) and
 * templates.spec.ts (`template-<name>.json`) in `.rs-runs/fn-compile`: compile rate per origin
 * and kind, the user access-function rate (per occurrence and per distinct function), and why
 * functions do not compile.
 *
 *   node test/__rs/fn-compile/summarize.mjs [--dir .rs-runs/fn-compile] [--list]
 *
 * `origin` is where the function is defined: `user` (test/ or templates/), `payload`
 * (packages/payload: sanitization wrappers, default validators and hooks), `plugin` (other
 * packages). Payload wraps every collection / global access function (`withBaseAccess`); the
 * user's function is reported as its own row with the label suffix `(wrapped)`.
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const dir = path.resolve(flag('--dir') ?? '.rs-runs/fn-compile')
const list = argv.includes('--list')

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('failed'))
const groups = [
  { name: 'test configs (test/*/config.ts)', rows: files.filter((f) => f === 'test-configs.json') },
  {
    name: 'templates (templates/*/src/payload.config.ts)',
    rows: files.filter((f) => f.startsWith('template-')),
  },
].map((g) => ({
  ...g,
  rows: g.rows.flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))),
}))

const pct = (a, b) => (b === 0 ? '-' : `${((100 * a) / b).toFixed(1)}%`)
const isAccess = (r) => r.kind === 'access' || r.kind === 'fieldAccess'

for (const { name, rows } of groups) {
  if (rows.length === 0) {
    continue
  }
  const distinct = new Map(rows.map((r) => [`${r.url}\n${r.source}`, r]))
  console.log(`\n## ${name}: ${rows.length} functions (${distinct.size} distinct)\n`)
  console.log('| origin | kind | compiled / total | rate | distinct compiled / total |')
  console.log('| --- | --- | --- | --- | --- |')
  const table = new Map()
  for (const r of rows) {
    const key = `${r.origin}|${r.kind}`
    const g = table.get(key) ?? { compiled: 0, distinct: new Map(), total: 0 }
    g.total++
    g.compiled += r.compiled ? 1 : 0
    g.distinct.set(`${r.url}\n${r.source}`, r.compiled)
    table.set(key, g)
  }
  for (const [key, g] of [...table].sort()) {
    const [origin, kind] = key.split('|')
    const dc = [...g.distinct.values()].filter(Boolean).length
    console.log(
      `| ${origin} | ${kind} | ${g.compiled} / ${g.total} | ${pct(g.compiled, g.total)} | ${dc} / ${g.distinct.size} (${pct(dc, g.distinct.size)}) |`,
    )
  }
  const access = rows.filter((r) => r.origin === 'user' && isAccess(r))
  const accessDistinct = [...new Map(access.map((r) => [`${r.url}\n${r.source}`, r])).values()]
  const c = (xs) => xs.filter((r) => r.compiled).length
  console.log(
    `\nuser access functions (collection / global / field): ${c(access)} / ${access.length} = ${pct(c(access), access.length)}; distinct: ${c(accessDistinct)} / ${accessDistinct.length} = ${pct(c(accessDistinct), accessDistinct.length)}`,
  )
  const reasons = new Map()
  for (const r of [...distinct.values()].filter((r) => !r.compiled)) {
    const reason = r.reason.replace(/__vite_ssr_import_\d+__\./g, '')
    const k = `${r.origin} ${r.kind}: ${reason}`
    reasons.set(k, (reasons.get(k) ?? 0) + 1)
  }
  console.log('\nnot compiled (distinct functions), by reason:\n')
  for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`- ${n} x ${k}`)
  }
  if (list) {
    for (const r of accessDistinct.filter((r) => !r.compiled)) {
      console.log(
        `\n### ${r.suite ?? ''} ${r.label}: ${r.reason}\n${r.url}\n\`\`\`js\n${r.source}\n\`\`\``,
      )
    }
  }
}
