#!/usr/bin/env node
/**
 * Writes the PostgreSQL baseline report (.rs-baseline/postgres-summary.md) from
 * - a runSuites summary (`/tmp/rs-pg-runs/<tag>/summary.json`, test/__rs/pg-harness/runSuites.mjs)
 * - the merged vitest JSON of that run (.rs-baseline/postgres-all.json)
 * - the SQLite and MongoDB TS baselines (.rs-baseline/sqlite-all.json, mongodb-all.json) for
 *   postgres-only tests and failures shared with other databases
 * - a static scan of the int specs for postgres / drizzle gating
 *
 *   node packages/engine-rs/scripts/pg/analyzeBaseline.mjs --summary /tmp/rs-pg-runs/rsp_base/summary.json \
 *     [--baseline .rs-baseline/postgres-all.json] [--sqlite .rs-baseline/sqlite-all.json] \
 *     [--mongo .rs-baseline/mongodb-all.json] [--out .rs-baseline/postgres-summary.md] \
 *     [--variant <label> <summary.json>]... [--note <text>]...
 *
 * `--variant` adds per-file totals of other runs (postgres-uuid, postgres-custom-schema, ...).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const variants = []
/** `--note <text>` (repeatable): paragraphs added under the header (run dates, environment). */
const notes = argv.flatMap((arg, i) => (arg === '--note' ? [argv[i + 1]] : []))
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--variant') variants.push({ label: argv[i + 1], file: argv[i + 2] })
}
const summaryFile = option('--summary', '/tmp/rs-pg-runs/rsp_base/summary.json')
const baselineFile = path.resolve(root, option('--baseline', '.rs-baseline/postgres-all.json'))
const sqliteFile = path.resolve(root, option('--sqlite', '.rs-baseline/sqlite-all.json'))
const mongoFile = path.resolve(root, option('--mongo', '.rs-baseline/mongodb-all.json'))
const outFile = path.resolve(root, option('--out', '.rs-baseline/postgres-summary.md'))

const readJSON = (file) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined
const summary = readJSON(summaryFile)
const baseline = readJSON(baselineFile)

const rel = (name) =>
  path.isAbsolute(name) && name.startsWith(`${root}/`) ? path.relative(root, name) : name
const statusOf = (status) =>
  status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'skipped'

const byFile = (run) =>
  new Map(
    (run?.testResults ?? []).map((result) => [
      rel(result.name),
      new Map(result.assertionResults.map((test) => [test.fullName, test])),
    ]),
  )
const pgTests = byFile(baseline)
const sqliteTests = byFile(readJSON(sqliteFile))
const mongoTests = byFile(readJSON(mongoFile))
const fileStatus = new Map((baseline.testResults ?? []).map((r) => [rel(r.name), r]))

const counts = (tests) => {
  const out = { failed: 0, passed: 0, skipped: 0 }
  for (const test of tests?.values() ?? []) {
    out[statusOf(test.status)]++
  }
  return out
}
const fmt = (c) => (c ? `${c.passed}/${c.failed}/${c.skipped}` : '-')
const otherStatus = (map, file, name) =>
  map.has(file) ? statusOf(map.get(file).get(name)?.status ?? 'missing') : 'no baseline'

/** Environmental causes, recognised from the failure messages. */
const CAUSES = [
  [/ECONNREFUSED [^ ]*:4566\b/, 'no LocalStack S3 on :4566 (docker service not running)'],
  [/ECONNREFUSED [^ ]*:10000\b|azurite/i, 'no Azurite on :10000 (docker service not running)'],
  [
    /ECONNREFUSED [^ ]*:4443\b|fake-gcs/i,
    'no fake GCS server on :4443 (docker service not running)',
  ],
  [
    /MaxRetriesPerRequest|ECONNREFUSED [^ ]*:6379\b/,
    'no Redis on :6379 (docker service not running)',
  ],
  [/ECONNREFUSED [^ ]*:5434\b/, 'no PostgreSQL read replica on :5434 (not provided by this setup)'],
  [
    /vercel|BLOB_READ_WRITE_TOKEN|blob\.vercel/i,
    'Vercel Blob API not reachable (no token / network)',
  ],
  [
    /ERR_PNPM_FETCH_404[\s\S]*engine-rs|engine-rs[\s\S]*ERR_PNPM_FETCH_404/,
    'PORT REGRESSION: the packed adapters depend on the unpublished @payloadcms/engine-rs (pnpm 404)',
  ],
  [/ERR_PNPM_FETCH_404/, 'pnpm registry fetch 404 while installing into a temp project'],
  [/^RestError/m, 'Azure SDK RestError: no Azurite on :10000 (docker service not running)'],
]
/** Patterns specific enough to attribute a failure from a whole file's log. */
const LOG_PATTERNS = new Set(
  CAUSES.filter(([, label]) => !label.startsWith('Vercel Blob')).map(([pattern]) => pattern),
)
const causeOf = (message = '') => CAUSES.find(([pattern]) => pattern.test(message))?.[1]

/** runSuites.mjs output file stem of a spec file (same function as there). */
const slugOf = (file) =>
  file
    .replace(/_/g, '_u')
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_]/g, (char) => `_x${char.codePointAt(0).toString(16).padStart(6, '0')}`)
/** First-run vitest log of a file (failures whose cause only shows in the log, e.g. pnpm output). */
const firstRunLog = (file) => {
  const logFile = path.join(path.dirname(summaryFile), 'logs', `${slugOf(file)}.log`)
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
}

const LOG_CAUSE_NOTE = " (matched in the file's first-run log, not in this test's message)"
/** Cause of a test that passed alone, from the file's first-run log (the log covers every test of the file). */
const logCauseOf = (entry, name) => {
  if (!entry.rerun?.flaky?.includes(name)) return undefined
  const log = firstRunLog(entry.file)
  // logs list package names such as @payloadcms/storage-vercel-blob: only specific patterns count
  const cause = log
    ? CAUSES.find(([pattern]) => LOG_PATTERNS.has(pattern) && pattern.test(log))?.[1]
    : entry.causes?.[name]?.replace(LOG_CAUSE_NOTE, '')
  return cause && !cause.startsWith('Vercel Blob')
    ? `${cause}${LOG_CAUSE_NOTE}`
    : 'flaky: failed in the full run, passed when its file was re-run alone (no cause in the message)'
}

const files = Object.values(summary.files).sort((a, b) => a.file.localeCompare(b.file))
let totals = { failed: 0, passed: 0, skipped: 0 }
const failing = []
for (const entry of files) {
  const tests = pgTests.get(entry.file)
  const c = counts(tests)
  totals = {
    failed: totals.failed + c.failed,
    passed: totals.passed + c.passed,
    skipped: totals.skipped + c.skipped,
  }
  for (const [name, test] of tests ?? []) {
    if (statusOf(test.status) !== 'failed') continue
    const message = (test.failureMessages ?? []).join('\n')
    const sqliteStatus = otherStatus(sqliteTests, entry.file, name)
    const mongoStatus = otherStatus(mongoTests, entry.file, name)
    failing.push({
      cause:
        causeOf(message) ??
        logCauseOf(entry, name) ??
        // summaries rebuilt by summaryFromBaselines.mjs carry the causes of the original analysis
        entry.causes?.[name] ??
        (sqliteStatus === 'failed' && mongoStatus === 'failed'
          ? 'also fails on the sqlite and mongodb TS baselines (not postgres-specific)'
          : undefined),
      file: entry.file,
      flaky: entry.rerun?.flaky?.includes(name) ?? false,
      message: message.split('\n')[0],
      mongoStatus,
      name,
      reproduced: entry.rerun?.reproduced?.includes(name) ?? false,
      sqliteStatus,
    })
  }
}
const suiteErrors = files.filter((entry) => entry.loadError)

// postgres-only / skipped-on-postgres tests (vs sqlite, the other drizzle dialect)
const pgOnly = []
const sqliteOnly = []
for (const [file, tests] of pgTests) {
  const other = sqliteTests.get(file)
  if (!other) continue
  for (const [name, test] of tests) {
    const p = statusOf(test.status)
    const s = other.has(name) ? statusOf(other.get(name).status) : 'missing'
    if (p !== 'skipped' && (s === 'skipped' || s === 'missing'))
      pgOnly.push({ file, name, status: p })
    if (p === 'skipped' && s !== 'skipped' && s !== 'missing')
      sqliteOnly.push({ file, name, status: s })
  }
}

// static scan for postgres / drizzle gating
const GATES = [
  [
    "db: (adapter) => adapter.startsWith('postgres') / === 'postgres...'",
    /startsWith\('postgres'\)|=== 'postgres[-a-z0-9]*'|includes\('postgres'\)/g,
  ],
  ["payload.db.name === / !== 'postgres'", /db\.name\s*[!=]==\s*'postgres'/g],
  ["test.options(..., { db: 'drizzle' })", /db:\s*'drizzle'/g],
  [
    'raw drizzle access (payload.db.drizzle / execute / tables / pool)',
    /db(?: as [A-Za-z]+\))?\.(drizzle|execute|tables|pool)\b/g,
  ],
]
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === '__rs' ? [] : walk(full)
    return entry.name.endsWith('int.spec.ts') ? [full] : []
  })
const gating = []
for (const file of walk(path.join(root, 'test'))) {
  const source = fs.readFileSync(file, 'utf8')
  const hits = GATES.map(([label, pattern]) => [
    label,
    (source.match(pattern) ?? []).length,
  ]).filter(([, n]) => n)
  if (hits.length) gating.push({ file: rel(file), hits })
}

const variantRuns = variants.map(({ file, label }) => ({ label, summary: readJSON(file) }))

let md = `# PostgreSQL TS baseline (upstream TS engine, \`PAYLOAD_DATABASE=postgres\`)

Generated by \`packages/engine-rs/scripts/pg/analyzeBaseline.mjs\` from \`${rel(summaryFile)}\` and
\`${rel(baselineFile)}\` (per-test vitest JSON, repo-relative file names). Run with
\`node test/__rs/pg-harness/runSuites.mjs --engine ts --jobs 1 --rerun-failed --write-baseline .rs-baseline/postgres-all.json\`
(test/__rs/pg-harness/README.md): one vitest process per file, own database per file on the local
PostgreSQL 17.11 + PostGIS 3.6.4 + pgvector 0.8.6 server (localhost:5433, nix, stands in for
upstream's \`ghcr.io/payloadcms/postgis-vector\` image: PostgreSQL 17.5, PostGIS 3.5.3),
\`postgresAdapter({ pool: { connectionString } })\` exactly as upstream codegen writes it, \`TZ=UTC\`.
PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE unset.

**${files.length} files, ${totals.passed} passed / ${totals.failed} failed / ${totals.skipped} skipped tests.**
Failing tests re-run once alone: ${failing.filter((f) => f.reproduced).length} reproduced, ${failing.filter((f) => f.flaky).length} flaky (passed alone).
Files with a suite-level error (no failed test, file failed): ${suiteErrors.length}${suiteErrors.length ? ` (${suiteErrors.map((e) => e.file).join(', ')})` : ''}.

\`.rs-baseline/postgres-rerun.json\` holds the vitest JSON of the files re-run alone (pass it as a second
\`--baseline\` so either outcome is accepted). Files whose re-run differs from the first run:
${
  files
    .filter((e) => e.rerun && (e.rerun.flaky.length || e.rerun.newFailures.length))
    .map((e) => `\`${e.file}\` (first run ${fmt(e.counts)}, alone ${fmt(e.rerun.counts)})`)
    .join(', ') || 'none'
}.
Causes are matched on the failure messages, and for tests that passed alone also on the first run's log.
${notes.map((note) => `\n${note}\n`).join('')}
## Failing tests

| file | test | rerun alone | sqlite TS | mongodb TS | cause | first line |
|---|---|---|---|---|---|---|
`
for (const f of failing) {
  md += `| ${f.file} | ${f.name.replaceAll('|', '\\|')} | ${f.reproduced ? 'reproduced' : f.flaky ? 'flaky (passed)' : '-'} | ${f.sqliteStatus} | ${f.mongoStatus} | ${f.cause ?? '**not environmental (investigate)**'} | ${f.message.replaceAll('|', '\\|').slice(0, 160)} |\n`
}
if (suiteErrors.length) {
  md += `\n## Suite-level errors\n\n`
  for (const e of suiteErrors) {
    md += `- ${e.file}: ${String(e.loadError).split('\n')[0].replaceAll('|', '\\|').slice(0, 300)}${e.rerun ? ` (rerun alone: ${e.rerun.loadError ? 'reproduced' : 'passed'})` : ''}\n`
  }
}

md += `\n## Per file (pass/fail/skip)\n\n| file | postgres | ${variantRuns.map((v) => `${v.label} | `).join('')}sqlite (TS) | mongodb (TS) | vitest file status | rerun |\n|---|---|${variantRuns.map(() => '---|').join('')}---|---|---|---|\n`
for (const entry of files) {
  const status = fileStatus.get(entry.file)
  const c = counts(pgTests.get(entry.file))
  const isSuiteFailure = status?.status === 'failed' && c.failed === 0
  const variantCells = variantRuns
    .map((v) => {
      const r = v.summary?.files?.[entry.file]
      return `${r ? `${r.counts.passed}/${r.counts.failed}/${r.counts.skipped}${r.loadError ? ' (suite error)' : ''}` : '-'} | `
    })
    .join('')
  md += `| ${entry.file} | ${fmt(c)} | ${variantCells}${fmt(sqliteTests.has(entry.file) ? counts(sqliteTests.get(entry.file)) : undefined)} | ${fmt(mongoTests.has(entry.file) ? counts(mongoTests.get(entry.file)) : undefined)} | ${status?.status ?? 'no result'}${isSuiteFailure ? ' (suite-level error)' : ''} | ${entry.rerun ? `reproduced ${entry.rerun.reproduced.length}, flaky ${entry.rerun.flaky.length}` : ''} |\n`
}
for (const v of variantRuns) {
  const list = Object.values(v.summary?.files ?? {})
  const t = list.reduce(
    (s, r) => ({ f: s.f + r.counts.failed, p: s.p + r.counts.passed, s: s.s + r.counts.skipped }),
    { f: 0, p: 0, s: 0 },
  )
  md += `\n${v.label}: ${list.length} files, ${t.p} passed / ${t.f} failed / ${t.s} skipped.`
}

if (variantRuns.length) {
  md += `\n\n## Variant tests whose status differs from postgres\n\n`
  md += `Variant runs compare every test with this baseline (\`--baseline .rs-baseline/postgres-all.json --baseline .rs-baseline/postgres-rerun.json\`, either outcome accepted). "rerun alone" is the variant's own re-run of the file.\n`
  for (const v of variantRuns) {
    const list = Object.values(v.summary?.files ?? {}).sort((a, b) => a.file.localeCompare(b.file))
    const rows = list.flatMap((r) =>
      r.differences.map((d) => ({
        ...d,
        cause: causeOf(r.failures.find((f) => f.name === d.name)?.message),
        file: r.file,
        rerun: r.rerun
          ? r.rerun.reproduced.includes(d.name)
            ? 'reproduced'
            : r.rerun.flaky.includes(d.name)
              ? 'passed alone'
              : '-'
          : '-',
      })),
    )
    const loadErrors = list.filter((r) => r.loadError)
    md += `\n### ${v.label} (${rows.length} tests, ${loadErrors.length} suite-level errors)\n\n`
    if (rows.length) {
      md += `| file | test | postgres | ${v.label} | rerun alone | cause | first line |\n|---|---|---|---|---|---|---|\n`
      for (const d of rows) {
        md += `| ${d.file} | ${d.name.replaceAll('|', '\\|')} | ${d.baseline} | ${d.status} | ${d.rerun} | ${d.cause ?? '-'} | ${(d.failure ?? '').replaceAll('|', '\\|').slice(0, 160)} |\n`
      }
    }
    for (const r of loadErrors) {
      md += `- suite-level error ${r.file}: ${String(r.loadError).split('\n')[0].replaceAll('|', '\\|').slice(0, 300)}${r.rerun ? ` (rerun alone: ${r.rerun.loadError ? 'reproduced' : 'passed'})` : ''}\n`
    }
  }
}

md += `\n\n## Tests that run only on PostgreSQL (${pgOnly.length}; skipped or absent on sqlite)\n\n`
for (const t of pgOnly) md += `- ${t.file} > ${t.name} (${t.status})\n`
md += `\n## Tests that run on sqlite but are skipped on PostgreSQL (${sqliteOnly.length})\n\n`
for (const t of sqliteOnly) md += `- ${t.file} > ${t.name} (sqlite ${t.status})\n`
md += `\n## Postgres / drizzle gating in int specs (static scan)\n\n| file | gates |\n|---|---|\n`
for (const g of gating)
  md += `| ${g.file} | ${g.hits.map(([label, n]) => `${label}: ${n}`).join('; ')} |\n`

fs.writeFileSync(outFile, md)
process.stdout.write(
  `${rel(outFile)}: ${files.length} files, ${totals.passed}/${totals.failed}/${totals.skipped}, ${failing.length} failing tests (${failing.filter((f) => !f.cause).length} without an environmental cause), ${suiteErrors.length} suite-level errors\n`,
)
