#!/usr/bin/env node
/**
 * Prints report rows (`.rs-runs/fn-compile/*.json`) matching filters, for inspecting the
 * compile-rate report:
 *
 *   node test/__rs/fn-compile/show.mjs [--origin user] [--kind access] [--compiled true|false] [--match text]
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const dir = path.resolve(flag('--dir') ?? '.rs-runs/fn-compile')
const rows = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json') && !f.includes('failed'))
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
const distinct = new Map(rows.map((r) => [`${r.url}\n${r.source}`, r]))
for (const r of distinct.values()) {
  if (flag('--origin') && r.origin !== flag('--origin')) continue
  if (flag('--kind') && r.kind !== flag('--kind')) continue
  if (flag('--compiled') && String(r.compiled) !== flag('--compiled')) continue
  if (flag('--match') && !`${r.label} ${r.source} ${r.reason ?? ''}`.includes(flag('--match')))
    continue
  console.log(
    `\n### ${r.suite ?? ''} ${r.label} [${r.compiled ? 'compiled' : r.reason}]\n${r.url}\n${r.source}`,
  )
}
