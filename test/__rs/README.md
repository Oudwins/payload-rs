# Rust port verification (`test/__rs`)

How the Rust port of the DB engine (`@payloadcms/drizzle` + `@payloadcms/db-sqlite`)
and later the core engine is proven to behave 1:1 with upstream TypeScript.

Three layers:

1. **Upstream int suite** (`test/**/*int.spec.ts`): assertion based. Necessary, but
   it can't prove parity by itself (see the analysis below).
2. **Shadow mode** (`PAYLOAD_DATABASE=sqlite-shadow`): every `payload.db.*` call in
   any int suite runs on the reference TS adapter and on a candidate adapter. Both
   results are deep-compared, and the two database files (schema + all rows) are
   diffed after every test that wrote. Every divergence goes to a JSONL report.
3. **Parity suite** (`test/__rs/harness/parity.int.spec.ts`): records full
   normalised Local API outputs, DB rows and the DB schema to golden files, then
   asserts strict equality against them.

---

## 1. Upstream int suite analysis

Numbers come from the reproducible scripts:

- `node packages/engine-rs/scripts/analyzeIntSuite.mjs --md`: static analysis of
  135 spec files.
- `node packages/engine-rs/scripts/summarizeBaseline.mjs`: turns
  `.rs-baseline/sqlite-all.json` (the vitest JSON reporter output of a full
  `pnpm test:int:sqlite` run) into `.rs-baseline/summary.md`.

### Baseline: full sqlite run, TS engine (2026-10-31)

|                             | count                                         |
| --------------------------- | --------------------------------------------- |
| test files                  | 135 (117 passed, 18 failed)                   |
| tests                       | 3272 passed, 162 failed, 461 skipped, 15 todo |
| files with 0 executed tests | 19                                            |

**Failures (162).** None of them are DB-engine failures. All are environmental:

- `storage-s3`, `plugin-import-export`, `plugin-cloud-storage`: `ECONNREFUSED :4566`
  (no localstack).
- `storage-azure`: `RestError` (no azurite).
- `storage-vercel-blob`: `fetch failed`.
- `kv`: no redis.
- `uploads`: a URL allow-list test timed out on the network.
- `select`: `EEXIST` on `test/select/media/image-original.jpg` (leftover file).

The Rust port can't fix these and they don't depend on it. Compare per test name,
not totals.

**Skipped on sqlite (461).** These are gated by adapter:

- `test.suite(..., { db })` / `test.options(..., { db: 'mongo' | 'drizzle' | fn })`:
  33 files.
- `process.env.PAYLOAD_DATABASE` lists: 7 files, e.g. the database transactions
  tests skip `sqlite`.
- `payload.db.name === 'sqlite'` branches: 5 files.
- `skipIf`/`runIf`: 2 files.
- `.skip`: 8 files.

Fully skipped on sqlite:

- postgres-only: `postgres-logs` ×4, `pg-replica`, `postgres-operator-handlers`,
  `postgres-vector`, `postgres-relationships-v2-v3-migration`.
- mongo-only: `mongodb-schema-build-cache`, `joins/buildJoinAggregation`,
  `joins/queryPath`.
- `uuid-v7`, `hmr`, `up-down-migration`.
- `plugin-import-export/int` (198 tests, skipped after its S3 setup fails).

Partly skipped: `select` 36/115, `database` 21/177, `fields` 13/234, `joins`
8/123, `sizes-to-variants` 13/23, `cli` 12/76, `file-versioning` 7/58.

### What the suite exercises (static counts over 135 files)

| area                                        | files        | occurrences      | notes                                               |
| ------------------------------------------- | ------------ | ---------------- | --------------------------------------------------- |
| create / update / delete                    | 93 / 56 / 58 | 2602 / 625 / 516 | mostly as fixtures; results rarely asserted in full |
| find / findByID                             | 55 / 57      | 800 / 990        |                                                     |
| count / findDistinct                        | 15 / 5       | 39 / 42          | findDistinct is thin (database + select suites)     |
| versions / restore                          | 21 / 10      | 216 / 35         | `versions` suite is the main one                    |
| `draft: true` / autosave                    | 30 / 8       | 425 / 255        |                                                     |
| globals                                     | 20           | 262              |                                                     |
| `locale:` / `'all'` / fallbackLocale        | 33 / 13 / 6  | 881 / 180 / 51   | `localization` suite                                |
| depth / populate                            | 40 / 3       | 526 / 11         | populate barely covered                             |
| select                                      | 17           | 160              | `select` suite                                      |
| joins                                       | 5            | 79               | `joins` suite                                       |
| sort                                        | 24           | 205              | `sort` suite; localized and nested sort thin        |
| pagination (limit/page, `pagination:false`) | 43 / 19      | 430 / 78         |                                                     |
| REST / GraphQL                              | 56 / 25      | 703 / 398        | same operations through other APIs                  |
| `overrideAccess: false`                     | 30           | 360              | `access-control`, `auth`                            |
| hooks referenced in specs                   | 25           | 201              | `hooks` asserts order of a few hooks only           |
| direct `payload.db.<method>()`              | 37           | 385              | `database` suite exercises the adapter directly     |
| raw drizzle / `execute`                     | 4            | 40               | sqlite-specific SQL behaviour                       |

**Where operators** (occurrences in specs):

| operator                              | files     | occurrences |
| ------------------------------------- | --------- | ----------- |
| `equals`                              | 72        | 995         |
| `contains`                            | 12        | 170         |
| `in`                                  | 26        | 98          |
| `exists`                              | 17        | 91          |
| `like`                                | 8         | 30          |
| `not_equals`                          | 8         | 22          |
| `not_in`                              | 5         | 12          |
| `greater_than` / `greater_than_equal` | 3 / 3     | 3 / 5       |
| `less_than` / `less_than_equal`       | 3 / 1     | 5 / 1       |
| `not_like`                            | 2         | 3           |
| `all`                                 | 1         | 2           |
| `near` / `within` / `intersects`      | 3 / 2 / 2 | 6 / 5 / 3   |

Comparison operators per field type, `all`, and the geo operators are barely
exercised. The geo operators are not supported on sqlite at all.

### Coverage matrix (DB engine behaviours vs upstream suite)

✓ = covered with assertions, ~ = partial or only via fixtures, ✗ = effectively not covered.

| behaviour                                                                                            | upstream suite                                          | parity suite                                      | shadow mode                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| scalar field types (text, textarea, email, code, json, number, checkbox, date, point, radio, select) | ✓ `fields`                                              | ✓ full docs                                       | ✓                                                                                                                |
| hasMany text / number / select                                                                       | ~ `fields`                                              | ✓                                                 | ✓                                                                                                                |
| relationship hasOne/hasMany, polymorphic, upload, upload hasMany                                     | ✓ `relationships`, `fields-relationship`, `uploads`     | ✓                                                 | ✓                                                                                                                |
| group / tabs (named + unnamed) / row / collapsible                                                   | ✓ `fields`                                              | ✓                                                 | ✓                                                                                                                |
| arrays, nested arrays, blocks, nested blocks                                                         | ✓ `fields`, `database`                                  | ✓ incl. row-id preservation on reorder            | ✓                                                                                                                |
| localized top-level, localized inside non-localized containers                                       | ✓ `localization`                                        | ✓ both                                            | ✓                                                                                                                |
| `locale: 'all'`, fallback on/off                                                                     | ✓ `localization`                                        | ✓                                                 | ✓                                                                                                                |
| versions + drafts + autosave + maxPerDoc                                                             | ✓ `versions`                                            | ✓ full version docs                               | ✓                                                                                                                |
| restoreVersion (collections + globals)                                                               | ~                                                       | ✓                                                 | ✓                                                                                                                |
| globals (+ localized, versions)                                                                      | ✓ `globals`/`versions`                                  | ✓                                                 | ✓                                                                                                                |
| where: every operator × field type                                                                   | ✗ (mostly `equals`)                                     | ✓ 333 queries, including the errors sqlite throws | ✓ for queries suites issue                                                                                       |
| where on nested paths (group/tab/array/blocks/relationship sub-fields, json paths)                   | ~                                                       | ✓                                                 | ✓                                                                                                                |
| and / or / nested logic                                                                              | ~                                                       | ✓                                                 | ✓                                                                                                                |
| sort: single/multi/desc, nested, relationship path, localized, unknown field                         | ~ `sort`                                                | ✓ 29 cases                                        | ✓                                                                                                                |
| select (include/exclude, nested, blocks by type)                                                     | ✓ `select`                                              | ✓                                                 | ✓                                                                                                                |
| depth 0/1/2, populate                                                                                | ~                                                       | ✓                                                 | ✓                                                                                                                |
| joins (options, `false`, count, where, sort, on array path)                                          | ✓ `joins`                                               | ✓                                                 | ✓                                                                                                                |
| pagination edge cases (page beyond, limit 0, `pagination: false`)                                    | ~                                                       | ✓                                                 | ✓                                                                                                                |
| findDistinct (sort, where, depth, pagination, relationship paths)                                    | ~ `database`                                            | ✓                                                 | ✓                                                                                                                |
| count / countVersions / countGlobalVersions                                                          | ~                                                       | ✓                                                 | ✓                                                                                                                |
| custom text ids                                                                                      | ✓ `fields`/`relationships`                              | ✓                                                 | ✓                                                                                                                |
| deleteMany, delete cascades on relationship tables                                                   | ~                                                       | ✓ rows                                            | ✓                                                                                                                |
| raw DB rows / schema produced by writes                                                              | ✗ (4 files use raw SQL)                                 | ✓ golden rows + structural schema                 | ✓ `dbState`: sqlite_master + all rows diffed after each test that wrote and on destroy                           |
| error class / message / data for invalid queries                                                     | ~ (`toThrow` without message in many places)            | ✓ exact                                           | ✓ exact (name, class, message, status, data)                                                                     |
| transactions (commit/rollback isolation)                                                             | ~ (skipped on sqlite: no concurrent write transactions) | ✗ (sqlite default has no transactions)            | ✓ id mapping; self-test with `transactionOptions: {}`                                                            |
| uuid / uuidv7 ids                                                                                    | sqlite-uuid adapters only                               | ✗ (autoincrement only)                            | possible via adapter args                                                                                        |
| hooks order / args, access control                                                                   | ✓ `hooks`, `access-control` (core engine, phase 3)      | ✗ (DB engine scope)                               | indirect (DB calls they trigger)                                                                                 |
| migrations / `createMigration` / schema push                                                         | ✓ `database`, `cli`                                     | schema golden only                                | run on the reference only (`unshadowed`); their SQL is mirrored and the resulting schema is covered by `dbState` |

### Why the upstream suite can't prove 1:1

- **Assertions check selected properties.** 3942 `toBe`, 1338
  `toBeDefined`/`toBeTruthy`-style, 852 `toHaveLength` and 405 `toMatchObject`
  assertions, against 685 `toStrictEqual`.
- **`toEqual` (1259 uses) is lenient.** It ignores `undefined` properties and key
  order. Only 2 assertions check key order, and there are no snapshots.
- **Many results are never asserted.** Writes mostly act as fixtures.
- **Operators × field types and sort/locale combinations are sparse.** See the
  operator table above.
- **Error checks are loose.** They often only check that something throws, not
  the class and message.
- **Adapter gating.** Some sqlite behaviour is skipped outright, e.g.
  transactions.

So for the port, **equality of complete outputs** against the TS reference is the
criterion. The upstream suite is the "nothing else broke" check on top of that.

---

## 2. Shadow mode (differential harness)

Code: `packages/engine-rs/src/shadow/`.

- `index.ts`: `createShadowAdapter({ reference, candidate, report, compare?, serialize?, onDivergence?, mirrorRaw?, dumpDatabase? })`.
  Returns a normal `DatabaseAdapterObj` (structurally typed, no `payload` import).
- `compare.ts`: strict deep compare plus the documented normalisations.
- `clock.ts`: replays the reference's clock readings and `crypto.randomUUID()` values to the candidate.
- `report.ts`: JSONL reporter.

Test wiring: `test/__rs/harness/shadowDatabaseAdapter.ts`
(`createShadowSqliteAdapter`, `loadShadowSqliteAdapterFactory`). Child processes:
`childProcessLoader.mjs`, `childProcessHooks.mjs`, `childDbSqlite.ts` (see Semantics).

### Running

```sh
# Doesn't touch the shared generated test/databaseAdapter.js. Safe while other runs are in progress.
PAYLOAD_DATABASE=sqlite-shadow SQLITE_URL=file:/tmp/x.db \
  pnpm vitest run --config test/__rs/harness/vitest.config.ts --project int test/hooks/int.spec.ts

# Standard flow (codegen writes the sqlite-shadow entry to test/databaseAdapter.js)
PAYLOAD_DATABASE=sqlite-shadow SQLITE_URL=file:/tmp/x.db pnpm test:int test/hooks/int.spec.ts

# Whole sqlite-capable int suite, one file at a time with its own db files, summary per file
node packages/engine-rs/scripts/runShadowAll.mjs [--jobs 2] [--candidate rs] [--out dir] \
  [--resume [--rerun divergent,newFailures,loadError,timeout]] [path filters...]
# -> .rs-baseline/shadow-all/{summary.md,summary.json,reports/,logs/,results/}

# Rust candidate (own addon copy, so the shared packages/engine-rs/payload-engine.node is untouched)
PAYLOAD_ENGINE_ADDON=/tmp/shadow-addon/payload-engine.node \
  node packages/engine-rs/scripts/runShadowAll.mjs --candidate rs --out .rs-baseline/shadow-all/rs --jobs 2
# divergences grouped by method + root-cause signature
node packages/engine-rs/scripts/summarizeShadowDivergences.mjs \
  --in .rs-baseline/shadow-all/rs --out .rs-baseline/shadow-all/rs-summary.md
```

Files of the same `test/<suite>` directory never run concurrently under `--jobs`
(they share fixtures on disk, e.g. `test/file-versioning/media`).

`runShadowAll.mjs` skips files that executed 0 tests in the sqlite baseline
(`.rs-baseline/sqlite-all.json`, override with `--all`), and reports tests failing
under shadow that passed in the baseline as `newFailures`. It exits 1 when any file
has divergences, new failures, a load error or a timeout.

`pnpm test:int:sqlite` forces `PAYLOAD_DATABASE=sqlite`, so use `test:int` or the
harness config for shadow mode.

| env                                | meaning                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYLOAD_RS_CANDIDATE`             | `ts` (default: a second plain TS `sqliteAdapter`, harness self-check), `rs` (`withRustEngine(sqliteAdapter(args))` from `packages/engine-rs`, as in ENGINE_CONTRACT.md), or a module path exporting `sqliteAdapter` / default. The reference is always the upstream TS adapter, even with `PAYLOAD_ENGINE=rs` set |
| `PAYLOAD_ENGINE_ADDON`             | native addon used by the `rs` candidate (default `packages/engine-rs/payload-engine.node`)                                                                                                                                                                                                                        |
| `PAYLOAD_RS_CANDIDATE_URL`         | candidate db file. Default: `SQLITE_URL` with `.candidate` before the extension                                                                                                                                                                                                                                   |
| `PAYLOAD_RS_REPORT_DIR`            | default `.rs-baseline/divergences`                                                                                                                                                                                                                                                                                |
| `PAYLOAD_RS_SHADOW_STRICT=true`    | throw `ShadowDivergenceError` on the first divergence                                                                                                                                                                                                                                                             |
| `PAYLOAD_RS_SHADOW_SERIALIZE=true` | run each reference+candidate pair exclusively (see below)                                                                                                                                                                                                                                                         |

`test/vitest.setup.ts` rewrites `PAYLOAD_DATABASE=sqlite-shadow` to `sqlite` and
sets `PAYLOAD_RS_SHADOW=true` after codegen. Suites therefore select exactly the
same tests as the sqlite baseline: they check `PAYLOAD_DATABASE === 'sqlite'` and
`db.name === 'sqlite'`. `test/__rs/harness/vitest.config.ts` aliases
`databaseAdapter.js` to `test/__rs/harness/databaseAdapter.ts` and sets
`PAYLOAD_RS_SKIP_ADAPTER_CODEGEN=true`.

### Semantics

- **Compared methods** (results or thrown errors):
  - `batchProcessing`, `copy`, `count`, `countGlobalVersions`, `countVersions`
  - `create`, `createGlobal`, `createGlobalVersion`, `createVersion`
  - `deleteMany`, `deleteOne`, `deleteVersions`
  - `find`, `findDistinct`, `findGlobal`, `findGlobalVersions`, `findOne`, `findVersions`
  - `queryDrafts`
  - `updateGlobal`, `updateGlobalVersion`, `updateJobs`, `updateMany`, `updateOne`, `updateVersion`
  - `upsert`
- **Order and arguments.** The reference starts first and its result (or error)
  is what the caller gets. The candidate starts right after the reference has
  started (not after it settles), so concurrent calls overlap on the candidate
  the same way they overlap on the reference and both databases see the same
  statement interleaving (bulk update/delete run per-document writes in
  parallel; running the candidate afterwards gave different autoincrement ids in
  version sub-tables). The candidate gets a deep clone of the arguments taken
  _before_ the reference runs, because adapters mutate input: drizzle
  `upsertRow`/`createGlobal` set `data.createdAt`. Any `adapter` argument equal
  to `payload.db` is swapped for the candidate instance.
- **Clock replay.** `globalThis.Date` is wrapped once. Inside the reference half
  of a call, `Date.now()` / `new Date()` readings are recorded; the candidate half
  of the same call reads them back in order. A TS candidate therefore stamps the
  same `createdAt` as the reference, and sort ties on those stamps (e.g. three
  concurrent creates sorted by `-createdAt`) resolve the same way. Readings past
  the tape, native clocks (Rust) and SQLite `strftime('now')` defaults use the
  real clock and fall under the timestamp rule below. Outside shadowed calls the
  wrapper behaves exactly like `Date`.
- **Lifecycle methods** (`init`, `connect`, `destroy`, `dropDatabase`) run on both,
  reference first; only throw vs no-throw is compared. drizzle's `pushDevSchema`
  caches the last pushed schema in a module global, which the reference keeps
  using unchanged. The TS candidate makes the same push/skip decision against
  its own copy of that cache (`withOwnSchemaPushCache`). Always forcing the
  candidate push made the candidate schema diverge in `database > should CRUD
  with blocks as JSON` where upstream skips the push.
- **Nested calls.** When a wrapper is reached from inside a shadowed call (drizzle
  `upsert` calls `this.updateOne`; after `vi.spyOn(payload.db, 'updateOne')` the
  spy sits on the reference instance), it only forwards to the side that is
  executing. The outer pair already covers both sides, so the candidate isn't
  called twice and `serialize` can't deadlock.
- **Database state (`dbState`).** On entry of each shadowed call, the shadow
  checks whether the running test (vitest `currentTestName`) changed since the
  last database activity. If it changed and something was written, it waits for
  in-flight calls (max 5 s), then dumps both databases and diffs them before the
  call proceeds. The diff therefore sees the final state of the previous test,
  before the next test's reset. It also diffs on `destroy`, and
  `getShadowState(db).diffDatabases()` diffs on demand.
  - The dump comes from `dumpClientDatabase(adapter.client)`: sqlite_master
    (`type, name, tbl_name, sql`, keyed `<type> <name>`, without `rootpage`)
    plus `SELECT * ... ORDER BY rowid` of every table, including
    `sqlite_sequence`.
  - It reads through each adapter's own libsql-compatible client, so it sees
    what `payload.db.drizzle` would see. A different reader can be supplied
    with `dumpDatabase`.
  - Rows are compared in rowid order with no reordering.
  - A divergent state is reported once until it changes, with `reason`
    (`testEnd`/`destroy`/`manual`) and `finishedTest`.
- **Transactions.** `beginTransaction` ids are random. Only null vs non-null is
  compared, and the reference id maps to the candidate id. The candidate then
  sees `req` through a proxy whose `transactionID` is mapped (promises
  included). `commit`/`rollback` use the mapped id.
- **`payload.db` is a Proxy over the reference.** Every other property
  (`drizzle`, `tables`, `name`, `sessions`, ...) and every other method
  (`execute`, `migrate*`, `generateSchema`, ...) belong to the reference.
  Non-shadowed method calls are counted under `unshadowed`.
- **Property writes.** Non-function writes (`allowIDOnCreate`, `blocksAsJSON`,
  `beforeSchemaInit`, `migrationDir`, `payload`, ...) go to both adapters.
  Function writes and `vi.spyOn` replace the reference method only. A spy wraps
  the shadow wrapper, so calls through the spy are still shadowed.
- **Raw SQL mirroring.** Writes on the reference libsql client that happen
  outside a shadowed method are replayed on the candidate client. This covers
  `payload.db.execute`, `payload.db.drizzle.insert(...)`, the `resetDB` /
  snapshot-restore test helpers, and migrations. `AsyncLocalStorage` tells them
  apart from the adapter's own queries. Mirrored methods: `execute`, `batch`,
  `migrate`, `executeMultiple`. Statements starting with `SELECT` are skipped. A
  non-libsql candidate can plug in `mirrorRaw`; otherwise the call is recorded as
  `unshadowed: client.<method>`.
- **`serialize`** (default `false`). Setting it to `true` makes each
  reference+candidate pair exclusive. That keeps both DBs in identical
  operation order under concurrency, but it changes how the reference
  interleaves concurrent writes. Bulk update/delete run per-document operations
  in parallel, so version row order changed and the parity row goldens failed
  in that mode. With the default, each candidate call starts right after its
  reference call settles.

- **Random ids.** `crypto.randomUUID()` (what `uuid` v4 calls) is replayed like
  the clock: the default `copy` assigns fresh array/block row ids, and the
  candidate half of the call gets the same ones.
- **Test overrides of client methods.** Tests inject faults by replacing
  `payload.db.drizzle.$client.execute` (the reference client) with a function
  that calls the saved original (`sqlite-bound-parameters-limit`). While the
  candidate half of a shadowed call runs, the candidate client's calls go
  through that override too, and the override's call to the saved method lands
  on the candidate's own original. Mirrored raw statements bypass it (the
  reference already ran it). Database dumps always use the unpatched methods.
  A Rust candidate that doesn't execute through its client's `execute` doesn't
  see such overrides.
- **Several payload instances.** Call windows for the timestamp rule are shared
  by every instance of one shadow adapter (tests calling `getPayload` with
  another config on the same database files).
- **Child processes.** In shadow mode `databaseAdapter.ts` adds
  `--import test/__rs/harness/childProcessLoader.mjs` to `NODE_OPTIONS`, so Node
  processes spawned by tests (the `cli` fixture, `test/queues/crashWorker.ts`)
  run the shadow adapter too. A synchronous `module.registerHooks` resolve hook
  (runs before tsx / `@swc-node/register`) maps, for imports from test modules,
  `test/databaseAdapter.js` to the harness adapter and `@payloadcms/db-sqlite`
  to `childDbSqlite.ts`, whose `sqliteAdapter(args)` returns the shadow adapter
  for those args (configs that build their own adapter). A child reports to
  `child-process-<pid>.jsonl` next to the test file's report, with the command
  line as test name.
- **Cross-process coordination** (`crossProcessFile`, set through
  `PAYLOAD_RS_SHADOW_CROSS_PROCESS_FILE`). The test process and its children
  append their call windows and the start/end of their shadowed pairs to one
  file. Stamps made by another process count for the timestamp rule, and a pair
  (or database diff) first waits, up to 2 s, until no other live process has a
  pair in flight. Without that, the test process polling a job row could read
  the child's write on the reference before the child's candidate half wrote
  it.

### Normalisations (the only ones applied; see `NORMALISATIONS` in `compare.ts`)

| what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | why                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| two differing timestamps (any key, results and DB rows) are accepted only if both are valid `Date`s, or both are strings in exact `toISOString()` format (`YYYY-MM-DDTHH:mm:ss.sssZ`), or both are strings in exact SQLite `CURRENT_TIMESTAMP` format (`YYYY-MM-DD HH:MM:SS`, second precision), round-tripping, **and** the reference value lies in the reference's execution window and the candidate value in the candidate's execution window of the _same_ shadowed call or mirrored raw statement (±1 ms at the value's precision; real clock or faked `Date` clock; windows of other instances and processes on the same files count) | values legitimately stamped with "now" by native clocks / SQLite `strftime('%Y-%m-%dT%H:%M:%fZ','now')` / `CURRENT_TIMESTAMP` defaults of raw migration SQL. Other formats (`+00:00`, no ms, µs), mixed formats, stale values (e.g. `updatedAt` not bumped) and values not stamped by the same call are divergences |
| clock and `randomUUID` replay (see Semantics)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | identical JS clock readings and random ids for the TS candidate                                                                                                                                                                                                                                                     |
| `dbState`: `rootpage` left out of sqlite_master                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | physical page number                                                                                                                                                                                                                                                                                                |
| `beginTransaction` result compared as null / non-null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | uuid v4 ids                                                                                                                                                                                                                                                                                                         |
| errors compared by class, `name`, `message`, `status`, `data`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | stack traces and `cause` differ                                                                                                                                                                                                                                                                                     |
| drizzle table aliases `xxxxxxxx_xxxx_..._xxxxxxxxxxxx` inside strings → `<alias:N>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `getTableAlias` uses `toSnakeCase(uuid())`; visible in SQL error messages                                                                                                                                                                                                                                           |
| numbers: `===` plus NaN = NaN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `-0` equals `0`, as in JSON                                                                                                                                                                                                                                                                                         |

Everything else is strict: key order (`keyOrder`), `undefined` vs missing
(`missingKey`/`extraKey`), types, array lengths, class names, Dates, bytes.

### Report format

`.rs-baseline/divergences/<test file path with / → __>.jsonl`. The file is
truncated once per process. Record types:

- `session`: reference, candidate, normalisations.
- `divergence`: `method`, `collection`/`global`, `seq`, `args` (with `req`
  reduced to locale/transactionID, max 8 KB), `differences[{path, kind,
  reference, candidate}]`, `testFile`, `testName`.
- `unshadowed`: first call of each method that bypassed the shadow.
- `divergence` with `method: 'dbState'`: database diff, plus `reason` and `finishedTest`.
- `stats`: on `destroy`; calls, dbChecks, divergences, rawMirrored, unshadowed counts.

### Results (TS reference vs TS candidate)

Full sqlite-capable int suite, `node packages/engine-rs/scripts/runShadowAll.mjs --jobs 2`
(2026-11-01, `.rs-baseline/shadow-all/summary.md`):

|                         | count                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| files                   | 136: 117 run, 19 skipped (0 tests executed on sqlite in the baseline)                                         |
| tests                   | 3706 passed, 160 failed, 171 skipped                                                                          |
| new failures            | **0** (the 160 failures are the environmental ones of the baseline: s3/azure/vercel-blob/redis/import-export) |
| shadowed calls          | 71767                                                                                                         |
| database diffs          | 3098                                                                                                          |
| raw statements mirrored | 84694                                                                                                         |
| divergences             | **0**                                                                                                         |

Harness bugs the full run surfaced, all fixed: CLI/worker child processes wrote
only to the reference database; `copy` row ids from `uuid()`; a test's
`$client.execute` fault injection applied only to the reference (and broke the
database dump); `payload_migrations` dev-push stamps of a second payload
instance on the same files; second-precision `CURRENT_TIMESTAMP` defaults of
raw migration SQL; files of one suite running concurrently and sharing on-disk
fixtures.

### Results (TS reference vs Rust candidate)

`PAYLOAD_RS_CANDIDATE=rs` over the same 117 files (2026-11-01, debug addon build), grouped in
`.rs-baseline/shadow-all/rs-summary.md` (root causes in `.rs-baseline/shadow-all/rs-notes.md`):
51819 `SqliteEngine.call`s in 102 files, **21 divergences** in 2 root causes:

- `updateJobs` ×19: statements of concurrent calls run call by call in Rust, interleaved per
  await in TS (`$push` of 20 parallel tasks: first result has 20 log entries in TS, 1 in Rust).
  The final database state is identical.
- `find` ×2: test fault injection on `$client.execute`, which the native engine doesn't go
  through (harness limit, see Semantics).

The parity goldens `update/globals/delete > rows` fail under the Rust candidate because
the candidate's latency reorders the reference's concurrent bulk operations. Reference and
candidate rows still agree.

Self-test `test/__rs/harness/shadow.int.spec.ts` (19 tests) injects bugs into a
wrapped candidate and checks each one is detected, while the caller still
receives the reference result:

- wrong field value (`docs[0].title`)
- off-by-one `count`
- dropped key (`missingKey`)
- reversed key order (`keyOrder`)
- `updateOne` throwing
- JSONL contents including test file/name
- raw SQL mirroring on vs off (drift detected on the next `find`)
- commit and rollback with real transactions (`transactionOptions: {}`)
- `vi.spyOn(payload.db, 'count')` still shadowed
- no doubled candidate call: `upsert` → spied `updateOne` reaches the candidate once
- now-stamps: a 5 ms delayed candidate `createGlobal` passes; a `createdAt` 5 s stale is reported
- `dbState`: an extra candidate index and a reformatted `created_at` in storage only are reported
- `dbState` at test boundaries: a storage-only change in one test is reported, with `finishedTest`, at the first call of the next test
- strict mode throws
- a test override of `$client.execute` throwing applies to both sides (each on its own client), no divergence
- clock replay: the candidate gets the reference readings, then the real clock; `Date()` / `instanceof` unchanged
- `crypto.randomUUID()` replay: same ids for the candidate half, fresh ones past the tape and outside calls
- `compareValues` strictness, and the timestamp rule (format variants `Z` without ms, `+00:00`, µs, space separator, lowercase `z`, and Date vs string are all divergences)
- SQLite `CURRENT_TIMESTAMP` values: accepted as now-pairs only in that exact format (mixed with ISO, with ms, unpadded or non-round-tripping values are divergences), precision 1000 ms passed to the window check

### Known limits

- **Raw reads only hit the reference.** Raw SQL _writes_ are mirrored, and the
  resulting candidate storage is checked by `dbState`. Tests reading through
  `payload.db.drizzle` still read only the reference.
- **`dbState` granularity.** Intermediate states inside a test aren't diffed,
  only the state at the end of each test that wrote. With `test.suite` resets,
  the end state is read before the next test's reset. In-memory databases have
  no second reader. That doesn't matter here, because the dump goes through
  each adapter's own client.
- **Native clocks.** A Rust candidate that stamps "now" itself (not through JS
  `Date`) relies on the window rule. Its value orders under sort ties can still
  differ from the reference's.
- **Migrations run on the reference.** The candidate receives only their SQL
  (mirrored) and the `payload-migrations` documents (shadowed through
  `payload.create`).
- **Child processes** are shadowed only when they are Node processes started
  with the inherited `NODE_OPTIONS` and import the adapter from a test module.
  A child killed (`SIGKILL`) in the middle of a pair leaves the two databases
  apart; the next test's reset restores them.
- **Rust candidate needs a mirroring channel.** Raw SQL mirroring needs a
  libsql-compatible `client` on the candidate, or a `mirrorRaw` implementation.

---

## 3. Parity suite (golden outputs)

- `test/__rs/harness/config.ts`: built with `buildConfigWithDefaults`.
  - `kitchen` / `kitchen-localized` have every data field type:
    - scalars: text, textarea, email, code, json, number, checkbox, date, point, radio, select
    - hasMany select/text/number
    - relationships: hasOne, hasMany, polymorphic, polymorphic hasMany
    - uploads: hasOne and hasMany
    - richText
    - containers: group with nested group and array; named and unnamed tabs; row; collapsible
    - array with nested array; blocks with nested blocks and arrays
    - localized fields nested inside non-localized containers
  - `targets` has 3 join fields: plain, on an array path, and to the localized
    collection.
  - `media` (upload, text files, no sharp).
  - `drafts`: drafts + autosave, `maxPerDoc: 5`.
  - `versioned`: versions without drafts.
  - `custom-ids`: text ids.
  - Globals `site` (drafts) and `localized-global` (localized array, versions).
  - Locales `en`, `es`, `de`, with fallback.
- `test/__rs/harness/parity.int.spec.ts`: 451 ordered steps. Sections:
  `seed`, `read`, `where`, `sort`, `select`, `pagination`, `distinct`, `update`,
  `versions`, `globals`, `delete`.
  - **where:** 333 queries. Every operator per field type, plus nested, relationship,
    json, polymorphic and array/block paths, and/or logic, invalid
    paths/operators. Unsupported-on-sqlite operators record the exact error.
  - **sort:** 29 cases, including localized and relationship paths.
  - **select, depth, populate, joins, pagination, findDistinct.**
  - **update:** scalars, containers, nulls, array/block reorder, bulk update,
    locales, duplicate, validation error.
  - **versions and globals:** drafts, autosave, queryDrafts, find/count versions,
    restore, `maxPerDoc`.
  - **delete:** by id, by where, missing id; plus counts.
  - **DB:** raw rows of every table after seed/update/globals/delete, and the
    structural schema (columns, indexes, foreign keys via PRAGMA). Read directly
    with `node:sqlite`, independent of the adapter.
- `test/__rs/harness/golden.ts`: normaliser and golden store. Keeps key order and
  `undefined` (`{"$undefined":true}`). Errors become `{"$error":{class,name,message,status,data}}`.
  - Only normalisations: generated ObjectId row ids become `<oid:N>`, and drizzle
    table aliases become `<alias:N>`.
  - Timestamps are deterministic: `Date` is faked (`vi.useFakeTimers({ toFake: ['Date'] })`)
    and advanced 1 s per step/write.
- `test/__rs/harness/golden/*.json`: generated from the TS engine (~4.1 MB, where
  ~2.6 MB).

```sh
# regenerate goldens (TS engine)
PAYLOAD_RS_UPDATE_GOLDEN=1 SQLITE_URL=file:/tmp/rs-parity.db pnpm test:int:sqlite test/__rs/harness/parity.int.spec.ts
# assert
SQLITE_URL=file:/tmp/rs-parity.db pnpm test:int:sqlite test/__rs/harness/parity.int.spec.ts
# or, without touching test/databaseAdapter.js
PAYLOAD_DATABASE=sqlite SQLITE_URL=file:/tmp/rs-parity.db pnpm vitest run --config test/__rs/harness/vitest.config.ts --project int test/__rs/harness/parity.int.spec.ts
```

Verified against TS: 451/451 passed in 4 consecutive runs (3× harness config,
1× `pnpm test:int:sqlite`). Also 451/451 under `sqlite-shadow` with 0
divergences.

Steps share state (`resetBetweenTests: false`), so run the file as a whole.
`-t` filters will fail on missing state.

Quirks recorded as expected output (the port must reproduce them):

- `all`, `near`, `within` and `intersects` throw
  `TypeError: adapter.operators[...] is not a function` on sqlite.
- `blocks.nestedBlocks.text` and localized hasMany `in`/`contains` produce
  `DrizzleQueryError` with an empty column in the SQL.
- `poly exists` throws `APIError: Not supported`.
- Updating a group to `null` throws `TypeError: Cannot read properties of null`.

Gaps in the parity suite:

- uuid/uuidv7 ids
- postgres
- REST/GraphQL layers: they call the same operations, and shadow mode covers
  them via the upstream suites
- hooks/access (core engine phase)
- `localizeStatus`
- trash / soft delete
- jobs (`updateJobs`)
- `batchProcessing` / `copy`: covered by shadow mode via
  `test/database/batch-processing` and `copy`, not by goldens
