#!/usr/bin/env node
/**
 * Groups the divergences of a runShadowAll.mjs run by method and root-cause signature.
 *
 *   node packages/engine-rs/scripts/summarizeShadowDivergences.mjs [--in <dir>] [--out <file>] [--title <text>]
 *
 * --in   runShadowAll output dir (default .rs-baseline/shadow-all/rs): reads summary.json and reports/
 * --out  markdown file (default .rs-baseline/shadow-all/rs-summary.md)
 * --notes hand-written markdown included after the header when it exists
 *         (default .rs-baseline/shadow-all/rs-notes.md): root-cause analysis, pointers
 *
 * Signature of a divergence: method + the set of (kind, path) of its differences with array indices,
 * ids and numbers abstracted. For thrown errors the error name and a normalised message are part of
 * the signature; for `dbState` the table names are. Groups are sorted by number of occurrences.
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const options = parseArgs(process.argv.slice(2))
const inDir = path.resolve(root, options.in ?? '.rs-baseline/shadow-all/rs')
const outFile = path.resolve(root, options.out ?? '.rs-baseline/shadow-all/rs-summary.md')
const title = options.title ?? 'Shadow run: Rust candidate divergences'
const notesFile = path.resolve(root, options.notes ?? '.rs-baseline/shadow-all/rs-notes.md')

const summary = JSON.parse(fs.readFileSync(path.join(inDir, 'summary.json'), 'utf8'))
const reportsDir = path.join(inDir, 'reports')

/** method -> signature -> group */
const groups = new Map()
let total = 0
/** Rust engine stats (rs-engine-stats-<pid>.json written by the rs candidate), per file. */
const engineStats = new Map()

const fileBySlug = new Map(
  Object.keys(summary.files ?? {}).map((file) => [file.split('/').join('__'), file]),
)

for (const slug of fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : []) {
  const file = fileBySlug.get(slug) ?? slug
  const dir = path.join(reportsDir, slug)
  for (const name of fs.readdirSync(dir).filter((n) => /^rs-engine-stats-\d+\.json$/.test(n))) {
    const stats = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    const fileStats = engineStats.get(file) ?? { calls: 0, native: 0 }
    engineStats.set(file, fileStats)
    fileStats.native += stats.engines?.native ?? 0
    fileStats.calls += Object.values(stats.calls ?? {}).reduce((n, c) => n + c, 0)
  }
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) {
        continue
      }
      const record = JSON.parse(line)
      if (record.type !== 'divergence') {
        continue
      }
      total++
      const signature = signatureOf(record)
      const byMethod = groups.get(record.method) ?? new Map()
      groups.set(record.method, byMethod)
      const group = byMethod.get(signature) ?? {
        collections: new Set(),
        count: 0,
        examples: [],
        files: new Set(),
        signature,
      }
      byMethod.set(signature, group)
      group.count++
      group.files.add(file)
      if (record.collection ?? record.global) {
        group.collections.add(record.collection ?? record.global)
      }
      if (group.examples.length < 2) {
        group.examples.push({
          args: record.args,
          differences: (record.differences ?? []).slice(0, 4),
          file,
          test: record.finishedTest ?? record.testName,
        })
      }
    }
  }
}

fs.writeFileSync(outFile, render())
console.log(
  `[summarize] ${total} divergences, ${[...groups.values()].reduce((n, g) => n + g.size, 0)} signatures -> ${path.relative(root, outFile)}`,
)

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      opts[argv[i].slice(2)] = argv[++i]
    }
  }
  return opts
}

/** Array indices -> [], so row-level differences of the same field group together. */
function normalisePath(p) {
  return String(p ?? '').replace(/\[\d+\]/g, '[]')
}

/** Numbers, quoted values, uuids and hex ids abstracted out of error messages. */
function normaliseMessage(message) {
  return String(message ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/<alias:\d+>/g, '<alias>')
    .replace(/\b[0-9a-f]{24}\b/g, '<id>')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/\d+/g, 'N')
    .slice(0, 200)
}

function errorSummary(value) {
  if (!value || typeof value !== 'object') {
    return 'ok'
  }
  if ('name' in value || 'message' in value) {
    return `${value.name ?? value.class}: ${normaliseMessage(value.message)}`
  }
  return 'ok'
}

function signatureOf(record) {
  const differences = record.differences ?? []
  const parts = new Set()
  for (const d of differences) {
    if (d.path === '$threw') {
      parts.add(`threw ref=${errorSummary(d.reference)} cand=${errorSummary(d.candidate)}`)
    } else if (d.path === '$method') {
      parts.add(`missing method`)
    } else if (record.method === 'dbState') {
      // tables.<table>[i].<column> / schema.<entry>.sql
      const [, area, rest] = /^(tables|schema)\.(.*)$/.exec(d.path) ?? [, '', d.path]
      parts.add(`${d.kind} ${area}.${normalisePath(rest)}`)
    } else if (['message', 'name', 'class', 'status', 'data'].includes(d.path.split(/[.[]/)[0])) {
      parts.add(
        `error ${d.kind} ${normalisePath(d.path)}${d.path === 'message' ? ` ref="${normaliseMessage(d.reference)}" cand="${normaliseMessage(d.candidate)}"` : ''}`,
      )
    } else {
      parts.add(`${d.kind} ${normalisePath(d.path)}`)
    }
  }
  const sorted = [...parts].sort()
  return sorted.length > 6
    ? [...sorted.slice(0, 6), `… +${sorted.length - 6}`].join(' · ')
    : sorted.join(' · ')
}

function engineStatsLine(files) {
  let calls = 0
  const withEngine = []
  const withoutEngine = []
  for (const r of files) {
    const stats = engineStats.get(r.file)
    calls += stats?.calls ?? 0
    if (stats?.calls) {
      withEngine.push(r.file)
    } else if (r.calls) {
      withoutEngine.push(r.file)
    }
  }
  return `- Rust engine (\`rs-engine-stats-*.json\`): ${calls} \`SqliteEngine.call\`s; ${withEngine.length} files with engine calls${withoutEngine.length ? `; shadowed calls but no engine stats: ${withoutEngine.join(', ')}` : ''}`
}

function render() {
  const cell = (text) =>
    String(text ?? '')
      .replaceAll('|', '\\|')
      .replaceAll('\n', ' ')
  const json = (value, max = 300) => {
    const text = JSON.stringify(value)
    return text === undefined ? 'undefined' : text.length > max ? `${text.slice(0, max)}…` : text
  }
  const files = Object.values(summary.files ?? {})
  const byStatus = summary.byStatus ?? {}
  const methods = [...groups.entries()]
    .map(([method, byMethod]) => ({
      count: [...byMethod.values()].reduce((n, g) => n + g.count, 0),
      method,
      signatures: [...byMethod.values()].sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count)

  const lines = [
    `# ${title}`,
    '',
    `Generated by packages/engine-rs/scripts/summarizeShadowDivergences.mjs from \`${path.relative(root, inDir)}\` (candidate: ${summary.candidate}).`,
    '',
    `- files: ${files.length} (${Object.entries(byStatus)
      .map(([status, n]) => `${status} ${n}`)
      .join(', ')})`,
    `- shadowed calls: ${summary.totals?.calls ?? 0}, database diffs: ${summary.totals?.dbChecks ?? 0}, raw statements mirrored: ${summary.totals?.rawMirrored ?? 0}`,
    `- divergences: ${total} in ${methods.reduce((n, m) => n + m.signatures.length, 0)} signatures`,
    ...(engineStats.size ? [engineStatsLine(files)] : []),
    '',
    ...(fs.existsSync(notesFile) ? ['', fs.readFileSync(notesFile, 'utf8').trim(), ''] : []),
    'Reports: `<in>/reports/<file>/*.jsonl` (one `divergence` record per line, with args and all differences).',
    '`dbState` divergences are often consequences of an earlier method divergence in the same test.',
    '',
    '## By method',
    '',
    '| method | divergences | signatures | files |',
    '| --- | --- | --- | --- |',
  ]
  for (const m of methods) {
    const fileCount = new Set(m.signatures.flatMap((g) => [...g.files])).size
    lines.push(`| ${m.method} | ${m.count} | ${m.signatures.length} | ${fileCount} |`)
  }

  const attention = files.filter((r) => ['loadError', 'newFailures', 'timeout'].includes(r.status))
  if (attention.length) {
    lines.push('', '## Files with load errors / new test failures / timeouts', '')
    for (const r of attention.sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(
        `- **${r.file}** (${r.status}${r.loadError ? `: ${cell(r.loadError).slice(0, 300)}` : ''})`,
      )
      for (const name of (r.newFailures ?? []).slice(0, 10)) {
        lines.push(`  - ${cell(name)}`)
      }
      if ((r.newFailures ?? []).length > 10) {
        lines.push(`  - … ${r.newFailures.length - 10} more`)
      }
    }
  }

  lines.push('', '## Signatures', '')
  for (const m of methods) {
    lines.push(`### ${m.method} (${m.count})`, '')
    for (const g of m.signatures) {
      lines.push(
        `- **${g.count}×** \`${cell(g.signature)}\``,
        `  - files (${g.files.size}): ${[...g.files].sort().slice(0, 6).join(', ')}${g.files.size > 6 ? ', …' : ''}`,
      )
      if (g.collections.size) {
        lines.push(`  - collections/globals: ${[...g.collections].sort().slice(0, 10).join(', ')}`)
      }
      for (const example of g.examples) {
        lines.push(`  - e.g. ${cell(example.file)} › ${cell(example.test)}`)
        if (example.args !== undefined) {
          lines.push(`    - args: \`${cell(json(example.args, 400))}\``)
        }
        for (const d of example.differences) {
          lines.push(
            `    - \`${cell(d.path)}\` (${d.kind}): ref \`${cell(json(d.reference))}\` / cand \`${cell(json(d.candidate))}\``,
          )
        }
      }
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}
