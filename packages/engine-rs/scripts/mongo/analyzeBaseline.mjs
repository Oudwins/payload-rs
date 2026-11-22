#!/usr/bin/env node
/**
 * Writes the MongoDB baseline report (.rs-baseline/mongodb-summary.md) from
 * - a runSuites summary (`/tmp/rs-mongo-runs/<tag>/summary.json`, test/__rs/mongo-harness/runSuites.mjs)
 * - the merged vitest JSON of that run (.rs-baseline/mongodb-all.json)
 * - the SQLite TS baseline (.rs-baseline/sqlite-all.json) for mongo-only / sqlite-only tests
 * - a static scan of the int specs for mongo gating (`db: 'mongo'`, `payload.db.name === 'mongoose'`, ...)
 *
 *   node packages/engine-rs/scripts/mongo/analyzeBaseline.mjs --summary /tmp/rs-mongo-runs/rsmbase/summary.json \
 *     [--baseline .rs-baseline/mongodb-all.json] [--sqlite .rs-baseline/sqlite-all.json] [--out .rs-baseline/mongodb-summary.md]
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
const summaryFile = option('--summary', '/tmp/rs-mongo-runs/rsmbase/summary.json')
const baselineFile = path.resolve(root, option('--baseline', '.rs-baseline/mongodb-all.json'))
const sqliteFile = path.resolve(root, option('--sqlite', '.rs-baseline/sqlite-all.json'))
const outFile = path.resolve(root, option('--out', '.rs-baseline/mongodb-summary.md'))

const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
const sqlite = fs.existsSync(sqliteFile)
  ? JSON.parse(fs.readFileSync(sqliteFile, 'utf8'))
  : undefined

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
const mongoTests = byFile(baseline)
const sqliteTests = byFile(sqlite)
const fileStatus = new Map((baseline.testResults ?? []).map((r) => [rel(r.name), r]))

const counts = (tests) => {
  const out = { failed: 0, passed: 0, skipped: 0 }
  for (const test of tests?.values() ?? []) {
    out[statusOf(test.status)]++
  }
  return out
}
const fmt = (c) => (c ? `${c.passed}/${c.failed}/${c.skipped}` : '-')

/** Environmental causes, recognised from the first failure line. */
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
  [
    /vercel|BLOB_READ_WRITE_TOKEN|blob\.vercel/i,
    'Vercel Blob API not reachable (no token / network)',
  ],
  [
    /Hook timed out|Test timed out/,
    'timeout (shared MongoDB server under load from parallel agents)',
  ],
  [
    /ERR_PNPM_FETCH_404[\s\S]*engine-rs|engine-rs[\s\S]*ERR_PNPM_FETCH_404/,
    'PORT REGRESSION: the packed adapter depends on the unpublished @payloadcms/engine-rs (pnpm 404)',
  ],
  [/ERR_PNPM_FETCH_404/, 'pnpm registry fetch 404 while installing into a temp project'],
  [/^RestError/m, 'Azure SDK RestError: no Azurite on :10000 (docker service not running)'],
]
const causeOf = (message = '') => CAUSES.find(([pattern]) => pattern.test(message))?.[1]

const files = Object.values(summary.files).sort((a, b) => a.file.localeCompare(b.file))
let totals = { failed: 0, passed: 0, skipped: 0 }
const failing = []
for (const entry of files) {
  const tests = mongoTests.get(entry.file)
  const c = counts(tests)
  totals = {
    failed: totals.failed + c.failed,
    passed: totals.passed + c.passed,
    skipped: totals.skipped + c.skipped,
  }
  for (const [name, test] of tests ?? []) {
    if (statusOf(test.status) !== 'failed') continue
    const message = (test.failureMessages ?? []).join('\n').split('\n')[0]
    const sqliteStatus = statusOf(sqliteTests.get(entry.file)?.get(name)?.status ?? 'missing')
    failing.push({
      cause:
        causeOf((test.failureMessages ?? []).join('\n')) ??
        (sqliteStatus === 'failed'
          ? 'also fails on the sqlite TS baseline (not mongo-specific)'
          : undefined),
      file: entry.file,
      flaky: entry.rerun?.flaky?.includes(name) ?? false,
      message,
      name,
      reproduced: entry.rerun?.reproduced?.includes(name) ?? false,
      sqliteStatus: sqliteTests.has(entry.file) ? sqliteStatus : 'no sqlite baseline',
    })
  }
}

// mongo-only / sqlite-only tests
const mongoOnly = []
const sqliteOnly = []
for (const [file, tests] of mongoTests) {
  const other = sqliteTests.get(file)
  if (!other) continue
  for (const [name, test] of tests) {
    const m = statusOf(test.status)
    const s = other.has(name) ? statusOf(other.get(name).status) : 'missing'
    if (m !== 'skipped' && (s === 'skipped' || s === 'missing'))
      mongoOnly.push({ file, name, status: m })
    if (m === 'skipped' && s !== 'skipped' && s !== 'missing')
      sqliteOnly.push({ file, name, status: s })
  }
}

// static scan for mongo gating
const GATES = [
  [
    "test.options(..., { db: 'mongo' }) / db: (adapter) => adapter === 'mongodb'",
    /db:\s*'mongo'|adapter === 'mongodb'|=== 'mongodb'/g,
  ],
  ["payload.db.name === / !== 'mongoose'", /db\.name\s*[!=]==\s*'mongoose'/g],
  ['isMongoose(payload)', /isMongoose\(/g],
  [
    'raw mongoose access (payload.db.collections/versions/connection)',
    /db(?: as [A-Za-z]+\))?\.(collections|versions|connection)\b|\(payload\.db as any\)\.(collections|connection)/g,
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

let md = `# MongoDB TS baseline (upstream TS engine, \`PAYLOAD_DATABASE=mongodb\`)

Generated by \`packages/engine-rs/scripts/mongo/analyzeBaseline.mjs\` from \`${rel(summaryFile)}\` and
\`${rel(baselineFile)}\` (per-test vitest JSON, repo-relative file names). Run with
\`node test/__rs/mongo-harness/runSuites.mjs --engine ts --jobs 3 --rerun-failed --write-baseline .rs-baseline/mongodb-all.json\`
(test/__rs/README-mongo.md): one vitest process per file, own database per file on the shared replica
set \`rs0\` (localhost:27018, MongoDB 8.0.8), \`mongooseAdapter({ ensureIndexes: true, url })\` exactly
as upstream codegen writes it. PAYLOAD_ENGINE=ts, PAYLOAD_CORE_ENGINE unset.

**${files.length} files, ${totals.passed} passed / ${totals.failed} failed / ${totals.skipped} skipped tests.**
Failures re-run once alone: ${failing.filter((f) => f.reproduced).length} reproduced, ${failing.filter((f) => f.flaky).length} flaky (passed alone).
${summary.deferred?.length ? `\nDeferred (spawn child processes; /tmp/rs-phase-f-done missing at run time): ${summary.deferred.join(', ')}\n` : ''}
## Failing tests

| file | test | rerun alone | sqlite TS | cause | first line |
|---|---|---|---|---|---|
`
for (const f of failing) {
  md += `| ${f.file} | ${f.name.replaceAll('|', '\\|')} | ${f.reproduced ? 'reproduced' : f.flaky ? 'flaky (passed)' : '-'} | ${f.sqliteStatus} | ${f.cause ?? '**not environmental (investigate)**'} | ${f.message.replaceAll('|', '\\|').slice(0, 160)} |\n`
}

md += `\n## Per file (pass/fail/skip)\n\n| file | mongodb | sqlite (TS baseline) | vitest file status | rerun |\n|---|---|---|---|---|\n`
for (const entry of files) {
  const status = fileStatus.get(entry.file)
  const c = counts(mongoTests.get(entry.file))
  const isSuiteFailure = status?.status === 'failed' && c.failed === 0
  md += `| ${entry.file} | ${fmt(c)} | ${fmt(sqliteTests.has(entry.file) ? counts(sqliteTests.get(entry.file)) : undefined)} | ${status?.status ?? 'no result'}${isSuiteFailure ? ' (suite-level error)' : ''} | ${entry.rerun ? `reproduced ${entry.rerun.reproduced.length}, flaky ${entry.rerun.flaky.length}` : ''} |\n`
}

md += `\n## Tests that run only on MongoDB (${mongoOnly.length}; skipped or absent on sqlite)\n\n`
for (const t of mongoOnly) md += `- ${t.file} > ${t.name} (${t.status})\n`
md += `\n## Tests that run on sqlite but are skipped on MongoDB (${sqliteOnly.length})\n\n`
for (const t of sqliteOnly) md += `- ${t.file} > ${t.name} (sqlite ${t.status})\n`
md += `\n## Mongo gating in int specs (static scan)\n\n| file | gates |\n|---|---|\n`
for (const g of gating)
  md += `| ${g.file} | ${g.hits.map(([label, n]) => `${label}: ${n}`).join('; ')} |\n`

const shadowFile = path.join(root, '.rs-baseline/mongodb-shadow-ts.json')
if (fs.existsSync(shadowFile)) {
  const shadow = Object.values(JSON.parse(fs.readFileSync(shadowFile, 'utf8')).files)
  const sum = (key) => shadow.reduce((total, r) => total + (r.shadow?.[key] ?? 0), 0)
  md += `
## Shadow harness self-check (TS vs TS, \`.rs-baseline/mongodb-shadow-ts.json\`)

${shadow.length} files, ${sum('calls')} shadowed adapter calls, ${sum('dbChecks')} database-state
diffs, ${sum('rawMirrored')} mirrored raw writes: **${sum('divergences')} divergences**. Files whose
status differs from this baseline only because of the environment (or the hmr regression) are
listed in the run summary.
`
}

md += `
## Notes (investigation, 2026-11-01)

- All failures except two are environmental: the docker services of the int suite are not
  running here (LocalStack S3 :4566, Azurite :10000, fake GCS :4443, Redis :6379, Vercel Blob API);
  the same tests fail on the sqlite TS baseline. Three files fail at suite level for the same reason
  (plugin-import-export/int, storage-azure/int, storage-gcs/int: \`beforeAll\` cannot reach the
  service).
- test/versions/int.spec.ts first skipped all 153 tests (\`beforeAll\` hook timeout, 90 s): the
  shared server allowed only 3 concurrent index builds (\`maxNumActiveUserIndexBuilds\`) while
  several agents' suites created collections, and \`dropDatabase\` alone took 49 s. With the
  parameter raised to 64 the file passes 153/0/0 (this baseline).
- test/queues/schedules-autocron.int.spec.ts failed twice under load (0 jobs completed in its
  fixed 3.5 s window; 62 s test duration) and passes on a quiet server (this baseline): timing.
- test/hmr/int.spec.ts (Next dev server): passed 3/1 (1 flaky) before \`@payloadcms/db-mongodb\`
  imported \`withRustMongoEngine\` statically; since then the dev server cannot bundle
  \`packages/engine-rs/payload-engine.node\` ("node addon is not placeable in ESM chunks") and every
  API route returns 500 (suite-level error). A regression of the port's wiring, not of MongoDB;
  reported in .rs-baseline/mongo-coordination.md. The hmr dev server bundles the shared
  test/databaseAdapter.js itself.
- test/create-payload-app/int.spec.ts: 7 failures. 5 are \`ERR_PNPM_FETCH_404\` for
  \`@payloadcms/engine-rs\` while \`pnpm add\` installs the packed packages into a temp project: the
  packed \`@payloadcms/db-mongodb\` / \`@payloadcms/db-sqlite\` now depend on the private, unpublished
  engine-rs package (port regression, not MongoDB-specific; reported in the coordination log). The 2
  TanStack generator tests fail their build assertion after the same kind of install (log shows
  no other cause).

## Mongo-specific behaviour covered by the upstream suite (default adapter args)

- ObjectId ids and their casting from strings in every suite; invalid ids (test/database "id
  type"); custom text/number ids (test/database, test/fields, test/relationships custom-id
  collections).
- Geo queries on point fields: \`near\` (8 files), \`within\` (3), \`intersects\` (2), mostly
  test/fields.
- Collation: test/database "ensure mongodb respects collation …" (collection-level), "collation
  works with draft pagination".
- Sessions/transactions: every Local API write runs in a transaction on the replica set;
  test/database covers \`bulkOperationsSingleTransaction\`, \`beginTransaction\` failures,
  \`disableTransaction\`, rollback on hook errors.
- Joins through aggregation (\`useJoinAggregations\` default true): test/joins/*
  (buildJoinAggregation, queryPath, whereMutation, int).
- Localized sort and \`localizeStatus\`: test/localization, test/sort.
- Versions/drafts/autosave/\`queryDrafts\`: test/versions and drafts in many suites.
- Raw mongoose access by tests: test/database (insertMany, predefined migrations,
  \`allowAdditionalKeys\`), test/sizes-to-variants (indexes), test/localization (migration helpers),
  test/relationships (Model), test/fields (\`schema.indexes()\`), test/joins (profiler),
  test/mongodb-schema-build-cache.

## Not covered (options the suite never enables; only the default branches run)

- \`useJoinAggregations: false\` (resolveJoins path), \`usePipelineInSortLookup: false\`,
  \`useBigIntForNumberIDs\`, \`disableFallbackSort\`, \`autoPluralization: false\`,
  \`collectionsSchemaOptions\`: 0 tests.
- \`compatibilityOptions\` (cosmosdb / documentdb / firestore: \`useAlternativeDropDatabase\`,
  \`transactionOptions: false\`, \`disableIndexHints\`, …): only selectable as other
  PAYLOAD_DATABASE values, not part of this baseline; \`transactionOptions: false\` /
  no-replica-set fallback (\`defaultBeginTransaction\`) and \`prodMigrations\` likewise.
- These need matrix variants (like the sqlite matrix in test/__rs/adapter/runSuites.mjs) or the
  differential corpora of the mongo agents (mongojoins records \`useJoinAggregations=false\`).
- test/__rs/mongo-harness/parity.int.spec.ts adds goldens for regex escaping, ObjectId-like strings,
  invalid ids in \`equals\`/\`in\`/\`not_equals\`, geo, relationship-path lookups and sort,
  joins with where/sort/limit/count, transactions, \`db.upsert\` (server-generated ids), custom ids
  and raw stored bson types.
`

fs.writeFileSync(outFile, md)
process.stdout.write(
  `${rel(outFile)}: ${files.length} files, ${totals.passed}/${totals.failed}/${totals.skipped}, ${failing.length} failing, ${mongoOnly.length} mongo-only, ${sqliteOnly.length} sqlite-only\n`,
)
