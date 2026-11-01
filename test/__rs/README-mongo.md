# MongoDB verification for the Rust port (`test/__rs/mongo-harness`)

Shared infrastructure for running the upstream int suite against MongoDB
(`@payloadcms/db-mongodb`) without touching the shared, generated `test/databaseAdapter.js`.
Contract: `packages/engine-rs/MONGO_ENGINE_CONTRACT.md`.

## Server

Replica set `rs0` on `localhost:27018`, user `payload`/`payload` (upstream's default URL). If it
is down:

```sh
mongod --replSet rs0 --port 27018 --bind_ip 127.0.0.1 --dbpath /tmp/rs-mongo-data --oplogSize 256 \
  --wiredTigerCacheSizeGB 1 --fork --logpath /tmp/rs-mongo.log
```

Every run needs its **own database** (suites drop their database on start):

```sh
node packages/engine-rs/scripts/mongo/mongoDatabases.mjs list
node packages/engine-rs/scripts/mongo/mongoDatabases.mjs drop <name> '/^myprefix_/'
```

## Running one file

```sh
PAYLOAD_DATABASE=mongodb \
MONGODB_URL='mongodb://payload:payload@localhost:27018/<unique_db>?authSource=admin&directConnection=true&replicaSet=rs0' \
  pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/hooks/int.spec.ts
```

- `test/__rs/mongo-harness/vitest.config.ts` aliases `databaseAdapter.js` to
  `test/__rs/mongo-harness/databaseAdapter.ts` and sets `PAYLOAD_RS_SKIP_ADAPTER_CODEGEN=true`.
- `databaseAdapter.ts` builds exactly the `mongodb` entry of `test/dbAdapters.ts`:
  `mongooseAdapter({ ensureIndexes: true, url: MONGODB_URL || DATABASE_URL || default })`,
  imported from `@payloadcms/db-mongodb` (so `PAYLOAD_ENGINE=rs` picks the Rust engine there).
  It requires `PAYLOAD_DATABASE=mongodb` and an explicit `MONGODB_URL`.
- Child processes (the `cli` fixture etc.): `databaseAdapter.ts` adds
  `--import test/__rs/mongo-harness/childProcessLoader.mjs` to `NODE_OPTIONS`; a synchronous
  `module.registerHooks` resolve hook maps `test/databaseAdapter.js` (imported by test modules) to
  the harness adapter, so children never read the shared generated file. In shadow mode
  `@payloadcms/db-mongodb` imported by test modules resolves to `childDbMongodb.ts` (configs that
  build their own `mongooseAdapter`).

## Variants

`PAYLOAD_DATABASE=cosmosdb|documentdb|firestore` (runner: `--database <name>`) build upstream's
entries of test/dbAdapters.ts for those databases (`compatibilityOptions`: `useJoinAggregations:
false`, `usePipelineInSortLookup: false`, `transactionOptions: false`, `useBigIntForNumberIDs`, ...)
against the same rs0 server (test/__rs/mongo-harness/args.ts). Suites gate tests on these values
exactly as upstream (`isMongoose`, `db: (adapter) => ...`). This is how the non-default adapter
branches (resolveJoins, no transactions, bigint ids) get covered.

## Running many files

```sh
node test/__rs/mongo-harness/runSuites.mjs [--engine ts|rs] [--database mongodb|cosmosdb|documentdb|firestore] \
  [--config <vitest config>] [--jobs 1] [--tag mytag] \
  [--baseline .rs-baseline/mongodb-all.json] [--rerun-failed] [--shadow [--candidate ts|rs]] \
  [files or dirs...]
```

One vitest process per file, database `<tag>_<n>` (shadow candidate `<tag>_<n>_c`), dropped after
the file. Use `--jobs 1` (one upstream file at a time per agent, coordination rule); every file
waits while /tmp has less than 3 GB free (resumes at 5 GB). The vitest log of each file
(`<out>/logs/`) contains the default reporter output (suite-level errors such as `beforeAll` hook
timeouts are reported as `loadError`). Writes `<out>/summary.{json,md}`, per-file vitest JSON in `<out>/results/`, logs in
`<out>/logs/` (default out `/tmp/rs-mongo-runs/<tag>`). With `--baseline` every test's status is
compared with the TS baseline. Suites that spawn child processes (`CHILD_PROCESS_SUITES` in
`runSuites.mjs`) are deferred while `/tmp/rs-phase-f-done` is missing.

## TS baseline

- `.rs-baseline/mongodb-all.json`: per-test vitest JSON of the TS engine on MongoDB (repo-relative
  file names), the `--baseline` input of every comparison run.
- `.rs-baseline/mongodb-summary.md`: per-file pass/fail/skip, failing tests with their cause
  (environmental vs to investigate), tests that only run on MongoDB / only on sqlite, mongo gating
  in the specs. Regenerate with
  `node packages/engine-rs/scripts/mongo/analyzeBaseline.mjs --summary /tmp/rs-mongo-runs/<tag>/summary.json`.
- Shared server note: the rs0 server needs `maxNumActiveUserIndexBuilds` above the default 3 when
  several agents run suites (`db.adminCommand({ setParameter: 1, maxNumActiveUserIndexBuilds: 64 })`
  after a restart), otherwise suites with many collections (test/versions) time out in `beforeAll`.

## Shadow (differential) harness

```sh
node test/__rs/mongo-harness/runSuites.mjs --shadow [--candidate ts|rs|<module>] [--strict] \
  --baseline .rs-baseline/mongodb-all.json [files...]
```

`PAYLOAD_RS_MONGO_SHADOW=true` makes `databaseAdapter.ts` build
`createMongoShadowAdapter` (`packages/engine-rs/src/shadow-mongo`, wired in
`test/__rs/mongo-harness/shadowDatabaseAdapter.ts`): reference = upstream TS `mongooseAdapter` on
`MONGODB_URL` (always TS, even with PAYLOAD_ENGINE=rs), candidate on `<db>_c`:
`PAYLOAD_RS_MONGO_CANDIDATE=ts` (default, self-check: must give 0 divergences), `rs`
(`withRustMongoEngine(mongooseAdapter(args))` exported by packages/engine-rs), or a module path
exporting `mongooseAdapter`.

- Every `payload.db.*` data method runs on both sides and results / thrown errors are compared with
  typed bson values (`{$oid}`, `{$regex}`, `{$decimal}`, `{$binary}`, other bson as `{$bson}`),
  key order, `undefined` vs missing. The caller always gets the reference outcome.
- Both databases are dumped (collections sorted by name, documents by `_id`, indexes by name,
  options) and compared at the end of every test that wrote and on `destroy`.
- Writes outside adapter methods (fixture reset/snapshot restore through
  `Model.db.collections[x]`, `payload.db.collections[slug].insertMany`,
  `connection.collection(x).updateOne`, ...) are mirrored at the mongoose `Collection` level, and
  writes through the native driver (`payload.db.connection.db.collection(x)`) at the driver level.
  Writes through another client are not (the self-test shows they are detected as drift).
- Determinism: pairs run one at a time (reference half, then candidate half; released after
  `PAYLOAD_RS_MONGO_SHADOW_RELEASE_MS`, default 1000, to avoid lock waits deadlocking), `Date`
  readings and bson `ObjectId.getInc()` of the reference half are replayed to the candidate half,
  so generated ObjectIds are identical; server-generated upsert `_id`s are aligned (candidate doc
  moved to the reference id; the top-level field order the server takes from the upsert query is
  not stable between two identical upserts, so it is aligned for that just-inserted document).
  Commits/rollbacks run exclusively too, so no read sees a transaction committed on one side only. Normalisations are listed in the `session` record of every report
  (`NORMALISATIONS` in shadow-mongo/index.ts).
- Vitest timeouts are tripled in shadow mode (`PAYLOAD_RS_TIMEOUT_FACTOR`).
- Reports: `<out>/reports/<file>/<test file>.jsonl` (`divergence`, `unshadowed`, `stats` records);
  `--strict` (`PAYLOAD_RS_SHADOW_STRICT=true`) throws on the first divergence.
- Self-test: `test/__rs/mongo-harness/shadow.int.spec.ts` (TS vs TS 0 divergences incl.
  transactions, upserts, geo; injected wrong values / key order / ObjectId-vs-string storage /
  thrown errors / unmirrored writes are detected; strict mode).
- Requirement for an `rs` candidate: host ops must run in the async context of the adapter call
  (AsyncLocalStorage), otherwise ObjectId/clock replay cannot reach them.

## Parity goldens (MongoDB)

`test/__rs/mongo-harness/parity.int.spec.ts` = the steps of `test/__rs/harness/parity.int.spec.ts`
(same config) plus a `mongo` section (regex escaping, ObjectId-like strings, invalid ids, geo
near/within/intersects, relationship-path lookups and sort, joins with where/sort/limit/count,
transactions commit/rollback, `db.upsert`, custom ids, versions by parent, raw stored types).
Goldens in `test/__rs/mongo-harness/golden/` recorded from the TS engine (record + 2 replays
identical); database dumps (`mongoGolden.ts`) read the database through a separate MongoClient and
keep bson types.

```sh
# record (TS engine only)
PAYLOAD_RS_UPDATE_GOLDEN=1 PAYLOAD_DATABASE=mongodb TZ=UTC MONGODB_URL='mongodb://payload:payload@localhost:27018/<db>?authSource=admin&directConnection=true&replicaSet=rs0' \
  pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-harness/parity.int.spec.ts
# check (any engine): same without PAYLOAD_RS_UPDATE_GOLDEN, e.g. with PAYLOAD_ENGINE=rs
```
