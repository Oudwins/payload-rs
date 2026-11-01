#!/usr/bin/env node
/**
 * Copies a size-bounded selection of a recorded corpus (record.mjs output) into the fixture dir
 * the replay reads by default (test/__rs/mongo-joins/fixtures, git-ignored).
 *
 *   node test/__rs/mongo-joins/curate.mjs <corpus dir> [--out <dir>] [--budget-mb <n>]
 *
 * Units are taken round-robin over (recording, kind), smallest first within each, until the
 * budget (default 15 MB, configs included) is used, so every recorded kind of every spec file is
 * represented.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const argv = process.argv.slice(2)
let source
let out = path.join(root, 'test/__rs/mongo-joins/fixtures')
let budget = 15 * 1024 * 1024
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') out = path.resolve(argv[++i])
  else if (argv[i] === '--budget-mb') budget = Number(argv[++i]) * 1024 * 1024
  else source = path.resolve(argv[i])
}
if (!source) {
  throw new Error('usage: curate.mjs <corpus dir> [--out <dir>] [--budget-mb <n>]')
}

const recordings = fs
  .readdirSync(source)
  .map((name) => path.join(source, name))
  .filter((dir) => fs.existsSync(path.join(dir, 'units.ndjson')))
  .sort()

/** queue per (recording, kind): lines sorted by size */
const queues = []
for (const dir of recordings) {
  const byKind = new Map()
  for (const line of fs.readFileSync(path.join(dir, 'units.ndjson'), 'utf8').split('\n')) {
    if (!line) continue
    const { config = 0, kind } = JSON.parse(line)
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push({ config, line })
  }
  for (const [kind, units] of byKind) {
    units.sort((a, b) => a.line.length - b.line.length)
    queues.push({ dir, kind, units })
  }
}

fs.rmSync(out, { force: true, recursive: true })
fs.mkdirSync(out, { recursive: true })

let used = 0
const selected = new Map()
const configBytes = new Map()
let progress = true
while (progress) {
  progress = false
  for (const queue of queues) {
    const unit = queue.units.shift()
    if (!unit) continue
    const configFile = path.join(queue.dir, `config-${unit.config}.json`)
    const extra = configBytes.has(configFile) ? 0 : fs.statSync(configFile).size
    if (used + extra + unit.line.length + 1 > budget) continue
    progress = true
    configBytes.set(configFile, extra)
    used += extra + unit.line.length + 1
    if (!selected.has(queue.dir)) selected.set(queue.dir, { configs: new Set(), lines: [] })
    selected.get(queue.dir).configs.add(unit.config)
    selected.get(queue.dir).lines.push(unit.line)
  }
}

const counts = {}
for (const [dir, { configs, lines }] of selected) {
  const target = path.join(out, path.basename(dir))
  fs.mkdirSync(target, { recursive: true })
  for (const config of configs) {
    fs.copyFileSync(
      path.join(dir, `config-${config}.json`),
      path.join(target, `config-${config}.json`),
    )
  }
  fs.writeFileSync(path.join(target, 'units.ndjson'), `${lines.join('\n')}\n`)
  for (const line of lines) {
    const { kind } = JSON.parse(line)
    counts[kind] = (counts[kind] ?? 0) + 1
  }
}
console.log(`${(used / 1024 / 1024).toFixed(1)} MB in ${out}:`, counts)
