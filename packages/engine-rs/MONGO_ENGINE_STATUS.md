# MongoDB engine status

Owner: mongoglue since phase J (before: liveglue; this file, `packages/engine-rs/src/mongo-adapter/**`,
`packages/engine-rs/src/shadow-mongo/**`, `test/__rs/mongo-harness/**`, `test/__rs/mongo-adapter/**`,
the variant baselines `.rs-baseline/mongodb-<variant>.json`). Contract: `MONGO_ENGINE_CONTRACT.md`
("Stage 1b decision": live-object engine); decisions: `.rs-baseline/mongo-coordination.md`.

## Pieces

| piece                        | where                                                         | state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withRustMongoEngine` (glue) | `src/mongo-adapter/index.ts`, `live.ts`                       | thin: right after upstream `mongooseAdapter` `init` builds the adapter, every data method is replaced by its live Rust port (reads: `installLiveReads`, `adapter[m] = function (args) { return binding[m](this, args) }`; writes: `adapter[m] = mongoLiveWriteBinding()[m]`, native functions with `this` = adapter). The caller's real `args` / `req` / `data` objects reach Rust; nothing is copied, encoded or wrapped.                                                                                                                                                                                                                                                                                                                                                             |
| driver lane (WP B)           | `src/mongo-driver/` (contract: `MONGO_DRIVER_CONTRACT.md`)    | installed by `withRustMongoEngine` after the live methods: count / countVersions / countGlobalVersions / find / findOne / findVersions / findGlobal / findGlobalVersions / queryDrafts outside transactions run on a Rust `mongodb` client (`crates/payload-mongo-driver`); everything else, and every call the lane cannot serve exactly, on the live methods (mongoose). `connect` opens mongoose and the Rust client concurrently; `PAYLOAD_MONGO_DRIVER=lazy` opens only the Rust client and mongoose on first touch. `PAYLOAD_MONGO_DRIVER=node` / `lazy`, `PAYLOAD_MONGO_DRIVER_VERIFY=true` (lane differential). Stats `driverLane` (served, fallback reasons, connects); the runner counts driver-served reads as Rust calls. Test: `test/__rs/mongo-driver/lane.int.spec.ts`. |
| live deps                    | `live.ts` `initializeLiveDeps`                                | once per process: `mongoLiveTransformBinding().init({ APIError, ValidationError, flattenAllFields, Types })`, `getMongoLiveJoins()`; query ports via `getMongoLive()`. Stats `livePorted`: buildQuery, buildSortParam, buildProjectionFromSelect, transform, buildJoinAggregation, resolveJoins all Rust in every process.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| model building (`init`)      | `live.ts` `createLiveInit` -> `init.ts` `createRustMongoInit` | the default on `PAYLOAD_ENGINE=rs` since phase J (init parity posted 11-11 16:55; `PAYLOAD_RS_MONGO_INIT` removed). Deps: db-mongodb's `mongoose`, `mongoose-paginate-v2` from db-mongodb's location, the live query port's `getBuildQueryPlugin`. Stats `liveInit` per adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| completeness check           | `live.ts` `installLiveEngine`                                 | `PAYLOAD_ENGINE=rs` throws at adapter init (`PAYLOAD_ENGINE=rs: the engine addon at <path> lacks the live MongoDB engine (...)`) when the addon lacks any of `requiredLiveBindings` (checked before anything is initialized), a data method has no live port, or, with `PAYLOAD_RS_MONGO_LIVE_DEPS=rust`, a `payload_mongo_live::deps` entry is not ported. By default the live data methods call upstream's TS `buildQuery` / `buildSortParam` / `buildProjectionFromSelect` / `transform` / `buildJoinAggregation` / `resolveJoins` (the ports cross Node-API once per field and made writes slower than upstream); `PAYLOAD_RS_MONGO_LIVE_UPSTREAM_DEPS=true` forces them in either mode. No silent fallback. Test: `test/__rs/mongo-adapter/required.int.spec.ts` (stub addon).    |
| stage-1 JSON engine          | removed (2026-11-22)                                          | `MongoEngine`, host.ts / codec.ts / loopback.ts, crates payload-mongo-engine / -joins / -query / -transform and their record / replay harnesses (test/__rs/mongo-engine, mongo-query, mongo-joins) are gone; the live engine is the only implementation. test/__rs/mongo-transform's TS recorder stays (its corpus feeds test/__rs/mongo-live-transform/replay.spec.ts).                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PAYLOAD_ENGINE=rs` switch   | `packages/db-mongodb/src/index.ts` (defaultpath)              | lazy `import('@payloadcms/engine-rs')` in `init`; see known gaps (Next dev server).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| stats                        | `index.ts`                                                    | `<PAYLOAD_RS_MONGO_ENGINE_STATS_DIR>/mongo-engine-<pid>.json` per process: `engines.{live,native,loopback}`, `liveCalls` (reads counted by the installer, writes by the addon), `liveMethods`, `livePorted`, `liveInit`; flushed periodically, on `destroy`, at exit and at the end of every test file (`flushOnFileEnd.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## How to run

```sh
A=/tmp/liveglue-addon/payload-engine.node   # cp target/shared/debug/libpayload_node.dylib
# full suite, PAYLOAD_ENGINE=rs, per test vs baseline (native proof per file from the stats)
node test/__rs/mongo-harness/runSuites.mjs --engine rs --addon $A --rerun-failed --allow-child-process-suites \
  --baseline .rs-baseline/mongodb-all.json --baseline .rs-baseline/mongodb-env-recheck.json
# variants: --database cosmosdb|documentdb|firestore with --baseline .rs-baseline/mongodb-<variant>.json
# native shadow (reference upstream TS adapter vs live engine on a second database)
node test/__rs/mongo-harness/runSuites.mjs --shadow --candidate rs --shadow-mode serial|concurrent --addon $A ...
# recompute a run's summary from its artifacts
node test/__rs/mongo-harness/runSuites.mjs --resummarize --tag <tag> <same flags>
# per-suite table
node test/__rs/mongo-adapter/statusTable.mjs --baseline .rs-baseline/mongodb-all.json --column 'engine rs'=<tag> ...
# glue / harness self-tests
PAYLOAD_ENGINE_ADDON=$A PAYLOAD_DATABASE=mongodb MONGODB_URL=... pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts \
  test/__rs/mongo-adapter/live.int.spec.ts test/__rs/mongo-harness/shadow.int.spec.ts
PAYLOAD_ENGINE=rs PAYLOAD_ENGINE_ADDON=$A ... test/__rs/mongo-harness/parity.int.spec.ts
node --test test/__rs/mongo-harness/runnerLib.test.mjs
```

Runner rules (`test/__rs/mongo-harness/runSuites.mjs`): tests are matched per file by full name and
occurrence index; with `--engine rs` / `--candidate rs` every file with passing tests must show
data-method calls served by Rust in its processes' stats (exemptions `FILES_WITHOUT_MONGO_ADAPTER`,
`FILES_WITHOUT_MONGO_ADAPTER_ON`, `FILES_WITHOUT_DATA_METHOD_CALLS`, each justified in the file) and
`PAYLOAD_RS_MONGO_LOOPBACK` is rejected; a file whose first run differed but whose solo rerun
(`--rerun-failed`) matches the baseline is counted clean and listed as such; shadow divergences never are.

## Verification (2026-11-11, addon of 11-11 12:41, live engine)

| check                                                                                                  | result                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/__rs/mongo-adapter/live.int.spec.ts`                                                             | 4/4: every data method live (addon counters, 0 stage-1 calls, native functions installed), shadow serial + concurrent + serial with `PAYLOAD_RS_MONGO_INIT=live`: 0 divergences                                                                                                                                                                                                                                                   |
| `test/__rs/mongo-harness/shadow.int.spec.ts`                                                           | 19/19 (TS vs TS clean; injected wrong values, key order, missing keys, errors, stored ObjectId-as-hex, unseen raw writes, argument mutations, extra/missing clock readings, typed values vs marker-spelled user data, timestamp rule on Dates and ISO strings only inside lifecycle windows, concurrent-mode reorder of non-tied docs, race list only in concurrent mode + resync, strict mode)                                   |
| parity goldens on `PAYLOAD_ENGINE=rs`                                                                  | 503/503 (incl. the non-vacuous `live` section re-recorded from TS: versions where parent, joins with docs, near with matches, update many over several docs / drafts)                                                                                                                                                                                                                                                             |
| `runnerLib.test.mjs`                                                                                   | 4/4 (duplicate full names, per-process stats incl. loopback, resolve hook without the default resolver, child process on a clean checkout)                                                                                                                                                                                                                                                                                        |
| mongodb, `--engine rs` (`liveglue_rs`)                                                                 | 135 files, 3262 / 166 / 416; 49,117 data-method calls, all live (0 stage-1, 0 loopback); **132/135 clean** vs `mongodb-all.json` + `mongodb-env-recheck.json`                                                                                                                                                                                                                                                                     |
| mongodb, native shadow serial (`liveglue_shs` + `shs2`)                                                | 110,789 shadowed calls, **0 divergences**; 131/135 files clean (the rest: below)                                                                                                                                                                                                                                                                                                                                                  |
| mongodb, native shadow concurrent (`liveglue_shc` + `shc2`)                                            | **0 divergences** after the race classification (rerun of the 5 race files: 35,387 calls, 0); first full run 231, all upstream races (below)                                                                                                                                                                                                                                                                                      |
| cosmosdb, `--engine rs` (`liveglue_cosrs`)                                                             | 135 files, 3298 / 160 / 453; 53,166 live calls; **133/135 clean** vs `mongodb-cosmosdb.json` + `mongodb-cosmosdb-env-recheck.json`                                                                                                                                                                                                                                                                                                |
| cosmosdb, `--engine rs` (11-16, `mongoglue_rs_cosmosdb`, addon target/shared 14:47, live init default) | 135 files, 3277 / 164 / 470; 53,107 live calls, 0 stage-1; **131/135 clean** vs `mongodb-cosmosdb.json` + `mongodb-cosmosdb-env-recheck.json` (TS reruns 11-16 added: schedules-autocron, uploads)                                                                                                                                                                                                                                |
| documentdb TS baseline (11-16, `.rs-baseline/mongodb-documentdb.json`)                                 | 135 files, 3283 / 170 / 463, 131/135 clean (4 environment load errors); TS recheck `.rs-baseline/mongodb-documentdb-env-recheck.json` (cli, uploads, versions: first-run TS flakes)                                                                                                                                                                                                                                               |
| documentdb, `--engine rs` (`mongoglue_rs_documentdb`)                                                  | 135 files, 3286 / 167 / 463; 53,320 live calls; **131/135 clean** (the 3 first-run differences were failed -> passed where the TS baseline run flaked; a TS rerun passes them too)                                                                                                                                                                                                                                                |
| firestore TS baseline (11-16, `.rs-baseline/mongodb-firestore.json`)                                   | 135 files, 3274 / 168 / 469, 131/135 clean; TS recheck `.rs-baseline/mongodb-firestore-env-recheck.json` (lexical, trash: first-run TS flakes)                                                                                                                                                                                                                                                                                    |
| firestore, `--engine rs` (`mongoglue_rs_firestore`)                                                    | 135 files, 3274 / 168 / 469; 51,036 live calls; **131/135 clean** (cli, schedules-autocron: solo rerun clean; lexical 2 + trash 2 failed -> passed, matched by the TS rerun)                                                                                                                                                                                                                                                      |
| mongodb, native shadow serial, TS vs TS with the phase-J harness (`mongoglue_shts`)                    | 135 files, 76,822 shadowed calls, **0 divergences** (event traces, first-await args, identity, prototypes on)                                                                                                                                                                                                                                                                                                                     |
| mongodb, native shadow serial, rs (`mongoglue_shrs` + versions rerun `mongoglue_shrv`)                 | 76,845 shadowed calls, 51,289 live calls; 14 divergences in the first run, all `errorResponse.$clusterTime` / `operationTime` of write conflicts (reproduced TS vs TS: `mongoglue_shtv1`), exempted; rerun **0 divergences**. Files not clean in both TS-vs-TS and rs: create-payload-app / hmr (pnpm registry down), uploads cookie-filtering `fetch failed`, plugin-import-export / storage-azure / storage-gcs (services down) |
| model-building differential (test/__rs/mongo-schema, 11-16)                                            | 98 suite configs + synthetic configs and negative controls in 5 batches (12 GB heap: one process OOMs at 4 GB): 128/128 pass                                                                                                                                                                                                                                                                                                      |
| parity goldens incl. new `golden/trace` (11-16)                                                        | TS 503/503 twice on fresh databases; `PAYLOAD_ENGINE=rs` 503/503; trace mutants detected (defer-create 13, extra-op 6, copy-where 440 failing steps)                                                                                                                                                                                                                                                                              |

Every remaining difference (mongodb and cosmosdb):

- test/hmr (`--engine rs` only): every Next API route fails with `Cannot find package
  '@payloadcms/engine-rs' imported from .next/dev/server/chunks/packages_db-mongodb_src_*.js`: Turbopack
  bundles db-mongodb, so the switch's runtime `import('@payloadcms/engine-rs')` resolves from the repo
  root, where that package is not installed. Owner: defaultpath (switch lines), reported in the
  coordination log 16:50. In shadow mode the dev server bundles the generated test/databaseAdapter.js
  itself (the harness cannot reach it), so there is no candidate to prove: TS-only there.
- test/plugin-import-export/int.spec.ts, test/storage-azure/int.spec.ts: suite-level load errors
  (localstack :4566 / Azurite not running), identical in every TS run. Environment.
- First-run differences that matched the baseline on the solo rerun (counted clean): file-versioning
  int + rename (30 min timeouts at load average ~68), create-payload-app (pnpm install timeouts),
  plugin-mcp/instructions in the serial shadow run (a harness edit made mid-run; rerun 10/0/0).
- Environment changes since the Nov 1/2 baselines (TS re-recorded 11-11 in the `*-env-recheck.json`
  files; Rust equal to them): Redis and the GCS emulator now run (kv, storage-gcs pass), the engine-rs
  packaging fix makes create-payload-app pass.

Shadow concurrent mode (`--shadow-mode concurrent`, `packages/engine-rs/src/shadow-mongo/index.ts`):
pairs are not serialised (causal order only). Where upstream itself is nondeterministic:

- `NONDETERMINISTIC_ORDER` (reads): a read result that differs is accepted iff it strictly equals
  upstream TS on the candidate's own database right after the candidate half (oracle). Covers tie order
  and which tied documents make a page (test/relationships `should allow clearing hasMany relationships`).
- `UPSTREAM_RACES` (13 tests, each with its race; all observed diverging in TS-vs-TS concurrent runs of
  the same files on 11-11): auth parallel failed logins (2), llm-instructions concurrent initialisation
  of one unique id (3), queues parallel task logs / competing workers / concurrency keys (7), versions
  parallel transactions with write conflicts (1). Divergences in those tests and their end-of-test
  database diff become `unshadowed upstreamRace:<test>`, then the candidate database is reset to a copy
  of the reference's. Serial mode has no exception (and 0 divergences).
- Call totals of `liveglue_shc` count each shadow adapter twice (stats written at file end and at
  destroy before stats records carried an `instance` id; the runner now keeps the last record per
  instance). Divergence counts are per record and exact.

### mongodb (baseline `.rs-baseline/mongodb-all.json`; TS ref 11-11 = `.rs-baseline/mongodb-env-recheck.json`)

| file                                                                  | TS baseline p/f/s | TS ref 11-11 p/f/s | engine rs p/f/s                           | shadow serial p/f/s                                          | shadow concurrent p/f/s       |
| --------------------------------------------------------------------- | ----------------- | ------------------ | ----------------------------------------- | ------------------------------------------------------------ | ----------------------------- |
| test/__helpers/int/configImport.int.spec.ts                           | 1/0/0             | -                  | 1/0/0                                     | 1/0/0                                                        | 1/0/0                         |
| test/__helpers/shared/getTestSuiteDir.int.spec.ts                     | 4/0/0             | -                  | 4/0/0                                     | 4/0/0                                                        | 4/0/0                         |
| test/_community/int.spec.ts                                           | 2/0/0             | -                  | 2/0/0                                     | 2/0/0 (30 calls, 0 div)                                      | 2/0/0 (59 calls, 0 div)       |
| test/access-control/int.spec.ts                                       | 84/0/0            | -                  | 84/0/0                                    | 84/0/0 (1679 calls, 0 div)                                   | 84/0/0 (3357 calls, 0 div)    |
| test/access-control/postgres-logs.int.spec.ts                         | 0/0/6             | -                  | 0/0/6                                     | 0/0/6                                                        | 0/0/6                         |
| test/admin-root/int.spec.ts                                           | 2/0/0             | -                  | 2/0/0                                     | 2/0/0 (34 calls, 0 div)                                      | 2/0/0 (67 calls, 0 div)       |
| test/admin-routing/int.spec.ts                                        | 3/0/0             | -                  | 3/0/0                                     | 3/0/0                                                        | 3/0/0                         |
| test/array-update/int.spec.ts                                         | 5/0/0             | -                  | 5/0/0                                     | 5/0/0 (68 calls, 0 div)                                      | 5/0/0 (135 calls, 0 div)      |
| test/auth-api-key/int.spec.ts                                         | 11/0/0            | -                  | 11/0/0                                    | 11/0/0 (206 calls, 0 div)                                    | 11/0/0 (411 calls, 0 div)     |
| test/auth/api-key/int.spec.ts                                         | 11/0/0            | -                  | 11/0/0                                    | 11/0/0 (152 calls, 0 div)                                    | 11/0/0 (303 calls, 0 div)     |
| test/auth/custom-strategy/int.spec.ts                                 | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (9 calls, 0 div)                                       | 1/0/0 (17 calls, 0 div)       |
| test/auth/first-user/int.spec.ts                                      | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (20 calls, 0 div)                                      | 1/0/0 (39 calls, 0 div)       |
| test/auth/forgot-password-localized/int.spec.ts                       | 2/0/0             | -                  | 2/0/0                                     | 2/0/0 (43 calls, 0 div)                                      | 2/0/0 (85 calls, 0 div)       |
| test/auth/int.spec.ts                                                 | 116/0/1           | -                  | 116/0/1                                   | 116/0/1 (1592 calls, 0 div)                                  | 116/0/1 (3517 calls, 0 div)   |
| test/auth/jwt/int.spec.ts                                             | 3/0/0             | -                  | 3/0/0                                     | 3/0/0 (106 calls, 0 div)                                     | 3/0/0 (211 calls, 0 div)      |
| test/auth/removed-token/int.spec.ts                                   | 5/0/0             | -                  | 5/0/0                                     | 5/0/0 (109 calls, 0 div)                                     | 5/0/0 (217 calls, 0 div)      |
| test/authorship/int.spec.ts                                           | 32/0/0            | -                  | 32/0/0                                    | 32/0/0 (547 calls, 0 div)                                    | 32/0/0 (1093 calls, 0 div)    |
| test/authorship/single-auth.int.spec.ts                               | 5/0/0             | -                  | 5/0/0                                     | 5/0/0 (100 calls, 0 div)                                     | 5/0/0 (199 calls, 0 div)      |
| test/base-access/int.spec.ts                                          | 7/0/0             | -                  | 7/0/0                                     | 7/0/0 (22 calls, 0 div)                                      | 7/0/0 (43 calls, 0 div)       |
| test/cli/int.spec.ts                                                  | 73/0/3            | -                  | 73/0/3                                    | 73/0/3 (403 calls, 0 div)                                    | 73/0/3 (506 calls, 0 div)     |
| test/collections-graphql/int.spec.ts                                  | 50/0/0            | -                  | 50/0/0                                    | 50/0/0 (807 calls, 0 div)                                    | 50/0/0 (1613 calls, 0 div)    |
| test/collections-rest/bulk-delete-rollback.int.spec.ts                | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (49 calls, 0 div)                                      | 1/0/0 (97 calls, 0 div)       |
| test/collections-rest/int.spec.ts                                     | 128/0/2           | -                  | 128/0/2                                   | 128/0/2 (2878 calls, 0 div)                                  | 128/0/2 (5755 calls, 0 div)   |
| test/collections-rest/tanstack-server-adapter.int.spec.ts             | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (38 calls, 0 div)                                      | 1/0/0 (75 calls, 0 div)       |
| test/config/int.spec.ts                                               | 12/0/1            | -                  | 12/0/1                                    | 12/0/1 (22 calls, 0 div)                                     | 12/0/1 (31 calls, 0 div)      |
| test/create-payload-app/int.spec.ts                                   | 4/7/0             | 11/0/0 **7 diff**  | 7/4/0 **2 diff**, solo rerun clean 11/0/0 | 11/0/0                                                       | 11/0/0                        |
| test/custom-graphql/int.spec.ts                                       | 2/0/0             | -                  | 2/0/0                                     | 2/0/0 (17 calls, 0 div)                                      | 2/0/0 (33 calls, 0 div)       |
| test/dashboard/documents.int.spec.ts                                  | 11/0/0            | -                  | 11/0/0                                    | 11/0/0 (2345 calls, 0 div)                                   | 11/0/0 (4695 calls, 0 div)    |
| test/dashboard/int.spec.ts                                            | 3/0/0             | -                  | 3/0/0                                     | 3/0/0                                                        | 3/0/0                         |
| test/dashboard/pins.int.spec.ts                                       | 4/0/0             | -                  | 4/0/0                                     | 4/0/0 (2013 calls, 0 div)                                    | 4/0/0 (4055 calls, 0 div)     |
| test/dashboard/thumbnails.int.spec.ts                                 | 3/0/0             | -                  | 3/0/0                                     | 3/0/0 (2122 calls, 0 div)                                    | 3/0/0 (4195 calls, 0 div)     |
| test/database/batch-processing.int.spec.ts                            | 4/0/0             | -                  | 4/0/0                                     | 4/0/0 (35 calls, 0 div)                                      | 4/0/0 (69 calls, 0 div)       |
| test/database/copy.int.spec.ts                                        | 5/0/0             | -                  | 5/0/0                                     | 5/0/0 (31 calls, 0 div)                                      | 5/0/0 (61 calls, 0 div)       |
| test/database/int.spec.ts                                             | 164/0/17          | -                  | 164/0/17                                  | 164/0/17 (3503 calls, 0 div)                                 | 164/0/17 (6955 calls, 0 div)  |
| test/database/migrate-to-blocks-as-json/int.spec.ts                   | 0/0/1             | -                  | 0/0/1                                     | 0/0/1 (0 calls, 0 div)                                       | 0/0/1 (0 calls, 0 div)        |
| test/database/migrations-cli.int.spec.ts                              | 3/0/0             | -                  | 3/0/0                                     | 3/0/0 (13 calls, 0 div)                                      | 3/0/0 (19 calls, 0 div)       |
| test/database/pg-replica/int.spec.ts                                  | 0/0/16            | -                  | 0/0/16                                    | 0/0/16                                                       | 0/0/16                        |
| test/database/postgres-logs.int.spec.ts                               | 0/0/6             | -                  | 0/0/6                                     | 0/0/6                                                        | 0/0/6                         |
| test/database/postgres-operator-handlers.int.spec.ts                  | 0/0/29            | -                  | 0/0/29                                    | 0/0/29                                                       | 0/0/29                        |
| test/database/postgres-relationships-v2-v3-migration/int.spec.ts      | 0/0/1             | -                  | 0/0/1                                     | 0/0/1                                                        | 0/0/1                         |
| test/database/postgres-vector.int.spec.ts                             | 0/0/4             | -                  | 0/0/4                                     | 0/0/4                                                        | 0/0/4                         |
| test/database/sqlite-bound-parameters-limit.int.spec.ts               | 0/0/4             | -                  | 0/0/4                                     | 0/0/4                                                        | 0/0/4                         |
| test/database/up-down-migration/int.spec.ts                           | 0/0/1             | -                  | 0/0/1                                     | 0/0/1                                                        | 0/0/1                         |
| test/dataloader/int.spec.ts                                           | 4/0/0             | -                  | 4/0/0                                     | 4/0/0 (565 calls, 0 div)                                     | 4/0/0 (1129 calls, 0 div)     |
| test/email-nodemailer/int.spec.ts                                     | 2/0/0             | -                  | 2/0/0                                     | 2/0/0 (7 calls, 0 div)                                       | 2/0/0 (13 calls, 0 div)       |
| test/endpoints/int.spec.ts                                            | 10/0/0            | -                  | 10/0/0                                    | 10/0/0 (17 calls, 0 div)                                     | 10/0/0 (33 calls, 0 div)      |
| test/endpoints/tanstack.int.spec.ts                                   | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (9 calls, 0 div)                                       | 1/0/0 (17 calls, 0 div)       |
| test/field-access-context/int.spec.ts                                 | 11/0/0            | -                  | 11/0/0                                    | 11/0/0 (178 calls, 0 div)                                    | 11/0/0 (355 calls, 0 div)     |
| test/field-paths/int.spec.ts                                          | 2/0/0             | -                  | 2/0/0                                     | 2/0/0 (18 calls, 0 div)                                      | 2/0/0 (35 calls, 0 div)       |
| test/fields-relationship/int.spec.ts                                  | 4/0/0             | -                  | 4/0/0                                     | 4/0/0 (376 calls, 0 div)                                     | 4/0/0 (751 calls, 0 div)      |
| test/fields/graphql-select.int.spec.ts                                | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (154 calls, 0 div)                                     | 1/0/0 (307 calls, 0 div)      |
| test/fields/int.spec.ts                                               | 233/0/1           | -                  | 233/0/1                                   | 233/0/1 (7886 calls, 0 div)                                  | 233/0/1 (7886 calls, 0 div)   |
| test/file-versioning/fileOperationManager.int.spec.ts                 | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (18 calls, 0 div)                                      | 1/0/0 (35 calls, 0 div)       |
| test/file-versioning/int.spec.ts                                      | 56/0/2            | -                  | 0/0/0 LOAD, solo rerun clean 56/0/2       | 56/0/2 (2804 calls, 0 div)                                   | 56/0/2 (5607 calls, 0 div)    |
| test/file-versioning/rename.int.spec.ts                               | 14/0/0            | -                  | 0/0/0 LOAD, solo rerun clean 14/0/0       | 14/0/0 (314 calls, 0 div)                                    | 14/0/0 (627 calls, 0 div)     |
| test/folders/int.spec.ts                                              | 6/0/0             | -                  | 6/0/0                                     | 6/0/0 (287 calls, 0 div)                                     | 6/0/0 (573 calls, 0 div)      |
| test/form-state/int.spec.ts                                           | 27/0/0            | -                  | 27/0/0                                    | 27/0/0 (94 calls, 0 div)                                     | 27/0/0 (187 calls, 0 div)     |
| test/globals/int.spec.ts                                              | 13/0/0            | -                  | 13/0/0                                    | 13/0/0 (87 calls, 0 div)                                     | 13/0/0 (173 calls, 0 div)     |
| test/graphql/hidden-fields.int.spec.ts                                | 11/0/0            | -                  | 11/0/0                                    | 11/0/0 (116 calls, 0 div)                                    | 11/0/0 (231 calls, 0 div)     |
| test/graphql/int.spec.ts                                              | 9/0/0             | -                  | 9/0/0                                     | 9/0/0 (87 calls, 0 div)                                      | 9/0/0 (173 calls, 0 div)      |
| test/hierarchy/collection-specific.int.spec.ts                        | 14/0/0            | -                  | 14/0/0                                    | 14/0/0 (301 calls, 0 div)                                    | 14/0/0 (601 calls, 0 div)     |
| test/hierarchy/int.spec.ts                                            | 36/0/0            | -                  | 36/0/0                                    | 36/0/0 (2089 calls, 0 div)                                   | 36/0/0 (4167 calls, 0 div)    |
| test/hmr/int.spec.ts                                                  | 2/0/2             | 3/1/0 **2 diff**   | 0/0/4 **2 diff** LOAD                     | 3/1/0 **no native proof**                                    | 3/1/0 **no native proof**     |
| test/hooks/int.spec.ts                                                | 45/0/0            | -                  | 45/0/0                                    | 45/0/0 (426 calls, 0 div)                                    | 45/0/0 (851 calls, 0 div)     |
| test/joins/buildJoinAggregation.int.spec.ts                           | 8/0/0             | -                  | 8/0/0                                     | 8/0/0 (0 calls, 0 div)                                       | 8/0/0 (2 calls, 0 div)        |
| test/joins/hierarchy.int.spec.ts                                      | 0/0/2             | -                  | 0/0/2                                     | 0/0/2                                                        | 0/0/2                         |
| test/joins/int.spec.ts                                                | 79/0/44           | -                  | 79/0/44                                   | 79/0/44 (1046 calls, 0 div)                                  | 79/0/44 (2091 calls, 0 div)   |
| test/joins/queryPath.int.spec.ts                                      | 4/0/0             | -                  | 4/0/0                                     | 4/0/0 (42 calls, 0 div)                                      | 4/0/0 (42 calls, 0 div)       |
| test/joins/whereMutation.int.spec.ts                                  | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (149 calls, 0 div)                                     | 1/0/0 (297 calls, 0 div)      |
| test/kv/int.spec.ts                                                   | 3/1/0             | 4/0/0 **1 diff**   | 4/0/0                                     | 4/0/0 (22 calls, 0 div)                                      | 4/0/0 (43 calls, 0 div)       |
| test/lexical-mdx/int.spec.ts                                          | 89/0/0            | -                  | 89/0/0                                    | 89/0/0 (0 calls, 0 div)                                      | 89/0/0 (0 calls, 0 div)       |
| test/lexical/lexical.int.spec.ts                                      | 124/0/0           | -                  | 124/0/0                                   | 124/0/0 (1460 calls, 0 div)                                  | 124/0/0 (2919 calls, 0 div)   |
| test/live-preview/int.spec.ts                                         | 18/0/0            | -                  | 18/0/0                                    | 18/0/0 (287 calls, 0 div)                                    | 18/0/0 (573 calls, 0 div)     |
| test/llm-instructions/access.int.spec.ts                              | 12/0/0            | -                  | 12/0/0                                    | 12/0/0 (175 calls, 0 div)                                    | 12/0/0 (349 calls, 0 div)     |
| test/llm-instructions/cli.int.spec.ts                                 | 11/0/0            | -                  | 11/0/0                                    | 11/0/0 (180 calls, 0 div)                                    | 11/0/0 (308 calls, 0 div)     |
| test/llm-instructions/int.spec.ts                                     | 36/0/0            | -                  | 36/0/0                                    | 36/0/0 (381 calls, 0 div)                                    | 36/0/0 (761 calls, 0 div)     |
| test/llm-instructions/slots.int.spec.ts                               | 5/0/0             | -                  | 5/0/0                                     | 5/0/0 (86 calls, 0 div)                                      | 5/0/0 (171 calls, 0 div)      |
| test/loader/int.spec.ts                                               | 4/0/0             | -                  | 4/0/0                                     | 4/0/0                                                        | 4/0/0                         |
| test/localization/int.spec.ts                                         | 159/0/0           | -                  | 159/0/0                                   | 159/0/0 (1915 calls, 0 div)                                  | 159/0/0 (3829 calls, 0 div)   |
| test/localization/localizeStatus.int.spec.ts                          | 2/0/9             | -                  | 2/0/9                                     | 2/0/9 (15 calls, 0 div)                                      | 2/0/9 (29 calls, 0 div)       |
| test/locked-documents/bulk-delete.int.spec.ts                         | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (65 calls, 0 div)                                      | 1/0/0 (129 calls, 0 div)      |
| test/locked-documents/int.spec.ts                                     | 13/0/0            | -                  | 13/0/0                                    | 13/0/0 (226 calls, 0 div)                                    | 13/0/0 (451 calls, 0 div)     |
| test/login-with-username/int.spec.ts                                  | 4/0/0             | -                  | 4/0/0                                     | 4/0/0 (52 calls, 0 div)                                      | 4/0/0 (103 calls, 0 div)      |
| test/mongodb-schema-build-cache/int.spec.ts                           | 7/0/0             | -                  | 7/0/0                                     | 7/0/0 (222 calls, 0 div)                                     | 7/0/0 (222 calls, 0 div)      |
| test/payload-cloud/int.spec.ts                                        | 4/0/1             | -                  | 4/0/1                                     | 4/0/1 (60 calls, 0 div)                                      | 4/0/1 (119 calls, 0 div)      |
| test/plugin-cloud-storage/int.compositePrefixes.int.spec.ts           | 0/0/2             | -                  | 0/0/2                                     | 0/0/2                                                        | 0/0/2                         |
| test/plugin-cloud-storage/int.spec.ts                                 | 33/3/13           | -                  | 33/3/13                                   | 33/3/13 (319 calls, 0 div)                                   | 33/3/13 (637 calls, 0 div)    |
| test/plugin-cloud-storage/versioning.int.spec.ts                      | 46/0/3            | -                  | 46/0/3                                    | 46/0/3 (1199 calls, 0 div)                                   | 46/0/3 (2397 calls, 0 div)    |
| test/plugin-ecommerce/int.spec.ts                                     | 36/0/0            | -                  | 36/0/0                                    | 36/0/0 (923 calls, 0 div)                                    | 36/0/0 (1845 calls, 0 div)    |
| test/plugin-form-builder/int.spec.ts                                  | 55/0/0            | -                  | 55/0/0                                    | 55/0/0 (938 calls, 0 div)                                    | 55/0/0 (1875 calls, 0 div)    |
| test/plugin-import-export/field-hooks.int.spec.ts                     | 0/29/0            | -                  | 0/29/0                                    | 0/29/0 (3 calls, 0 div)                                      | 0/29/0 (5 calls, 0 div)       |
| test/plugin-import-export/hooks.int.spec.ts                           | 0/42/0            | -                  | 0/42/0                                    | 0/42/0 (3 calls, 0 div)                                      | 0/42/0 (5 calls, 0 div)       |
| test/plugin-import-export/int.spec.ts                                 | 0/0/198           | 0/0/198 LOAD       | 0/0/198 LOAD                              | 0/0/198 LOAD (3 calls, 0 div)                                | 0/0/198 LOAD (5 calls, 0 div) |
| test/plugin-mcp/instructions.int.spec.ts                              | 10/0/0            | -                  | 10/0/0                                    | 0/10/0 **10 diff** (0 calls, 0 div), solo rerun clean 10/0/0 | 10/0/0 (839 calls, 0 div)     |
| test/plugin-mcp/int.spec.ts                                           | 237/0/1           | -                  | 237/0/1                                   | 237/0/1 (4304 calls, 0 div)                                  | 237/0/1 (8601 calls, 0 div)   |
| test/plugin-multi-tenant/int.spec.ts                                  | 21/0/0            | -                  | 21/0/0                                    | 21/0/0 (2449 calls, 0 div)                                   | 21/0/0 (2449 calls, 0 div)    |
| test/plugin-nested-docs/int.spec.ts                                   | 12/0/0            | -                  | 12/0/0                                    | 12/0/0 (1725 calls, 0 div)                                   | 12/0/0 (1725 calls, 0 div)    |
| test/plugin-redirects/int.spec.ts                                     | 3/0/0             | -                  | 3/0/0                                     | 3/0/0 (75 calls, 0 div)                                      | 3/0/0 (75 calls, 0 div)       |
| test/plugin-search/int.spec.ts                                        | 21/0/0            | -                  | 21/0/0                                    | 21/0/0 (2005 calls, 0 div)                                   | 21/0/0 (2005 calls, 0 div)    |
| test/plugin-sentry/int.spec.ts                                        | 0/0/1             | -                  | 0/0/1                                     | 0/0/1                                                        | 0/0/1                         |
| test/plugin-seo/int.spec.ts                                           | 21/0/0            | -                  | 21/0/0                                    | 21/0/0 (1551 calls, 0 div)                                   | 21/0/0 (1551 calls, 0 div)    |
| test/plugin-stripe/int.spec.ts                                        | 7/0/3             | -                  | 7/0/3                                     | 7/0/3 (131 calls, 0 div)                                     | 7/0/3 (131 calls, 0 div)      |
| test/plugins/int.spec.ts                                              | 6/0/0             | -                  | 6/0/0                                     | 6/0/0 (19 calls, 0 div)                                      | 6/0/0 (19 calls, 0 div)       |
| test/query-presets/int.spec.ts                                        | 13/0/1            | -                  | 13/0/1                                    | 13/0/1 (583 calls, 0 div)                                    | 13/0/1 (583 calls, 0 div)     |
| test/queues/cli.int.spec.ts                                           | 2/0/0             | -                  | 2/0/0                                     | 2/0/0 (65 calls, 0 div)                                      | 2/0/0 (59 calls, 0 div)       |
| test/queues/int.spec.ts                                               | 84/0/3            | -                  | 84/0/3                                    | 84/0/3 (7083 calls, 0 div)                                   | 84/0/3 (7079 calls, 0 div)    |
| test/queues/postgres-logs.int.spec.ts                                 | 0/0/2             | -                  | 0/0/2                                     | 0/0/2                                                        | 0/0/2                         |
| test/queues/schedules-autocron.int.spec.ts                            | 1/0/0             | -                  | 1/0/0                                     | 1/0/0 (83 calls, 0 div)                                      | 1/0/0 (107 calls, 0 div)      |
| test/queues/schedules.int.spec.ts                                     | 13/0/0            | -                  | 13/0/0                                    | 13/0/0 (865 calls, 0 div)                                    | 13/0/0 (875 calls, 0 div)     |
| test/relationships/int.spec.ts                                        | 74/0/0            | -                  | 74/0/0                                    | 74/0/0 (7645 calls, 0 div)                                   | 74/0/0 (7645 calls, 0 div)    |
| test/sdk/int.spec.ts                                                  | 39/0/0            | -                  | 39/0/0                                    | 39/0/0 (1119 calls, 0 div)                                   | 39/0/0 (1119 calls, 0 div)    |
| test/select/graphql-select.int.spec.ts                                | 4/0/0             | -                  | 4/0/0                                     | 4/0/0 (137 calls, 0 div)                                     | 4/0/0 (137 calls, 0 div)      |
| test/select/int.spec.ts                                               | 115/0/0           | -                  | 115/0/0                                   | 115/0/0 (851 calls, 0 div)                                   | 115/0/0 (851 calls, 0 div)    |
| test/select/postgreslogs.int.spec.ts                                  | 0/0/2             | -                  | 0/0/2                                     | 0/0/2                                                        | 0/0/2                         |
| test/sizes-to-variants/int.spec.ts                                    | 8/0/15            | -                  | 8/0/15                                    | 8/0/15 (143 calls, 0 div)                                    | 8/0/15 (143 calls, 0 div)     |
| test/sort/int.spec.ts                                                 | 44/0/0            | -                  | 44/0/0                                    | 44/0/0 (1669 calls, 0 div)                                   | 44/0/0 (1669 calls, 0 div)    |
| test/storage-azure/client-uploads/int.spec.ts                         | 0/13/0            | -                  | 0/13/0                                    | 0/13/0 (2 calls, 0 div)                                      | 0/13/0 (2 calls, 0 div)       |
| test/storage-azure/int.spec.ts                                        | 0/0/7             | 0/0/7 LOAD         | 0/0/7 LOAD                                | 0/0/7 LOAD (2 calls, 0 div)                                  | 0/0/7 LOAD (2 calls, 0 div)   |
| test/storage-azure/publicAccess.int.spec.ts                           | 0/2/0             | -                  | 0/2/0                                     | 0/2/0 (2 calls, 0 div)                                       | 0/2/0 (2 calls, 0 div)        |
| test/storage-azure/streamingUploads.int.spec.ts                       | 0/4/0             | -                  | 0/4/0                                     | 0/4/0 (0 calls, 0 div)                                       | 0/4/0 (0 calls, 0 div)        |
| test/storage-gcs/int.spec.ts                                          | 0/0/6             | 6/0/0 **6 diff**   | 6/0/0                                     | 6/0/0 (91 calls, 0 div)                                      | 6/0/0 (91 calls, 0 div)       |
| test/storage-s3/client-uploads/int.spec.ts                            | 0/25/0            | -                  | 0/25/0                                    | 0/25/0 (13 calls, 0 div)                                     | 0/25/0 (13 calls, 0 div)      |
| test/storage-s3/int.spec.ts                                           | 0/18/1            | -                  | 0/18/1                                    | 0/18/1 (0 calls, 0 div)                                      | 0/18/1 (0 calls, 0 div)       |
| test/storage-s3/searchBeforeS3.int.spec.ts                            | 0/3/0             | -                  | 0/3/0                                     | 0/3/0 (61 calls, 0 div)                                      | 0/3/0 (61 calls, 0 div)       |
| test/storage-vercel-blob/client-uploads/compositePrefixes.int.spec.ts | 0/1/0             | -                  | 0/1/0                                     | 0/1/0 (21 calls, 0 div)                                      | 0/1/0 (21 calls, 0 div)       |
| test/storage-vercel-blob/client-uploads/int.spec.ts                   | 0/6/0             | -                  | 0/6/0                                     | 0/6/0 (53 calls, 0 div)                                      | 0/6/0 (53 calls, 0 div)       |
| test/storage-vercel-blob/int.spec.ts                                  | 0/16/0            | -                  | 0/16/0                                    | 0/16/0 (13 calls, 0 div)                                     | 0/16/0 (13 calls, 0 div)      |
| test/tags/int.spec.ts                                                 | 9/0/0             | -                  | 9/0/0                                     | 9/0/0 (297 calls, 0 div)                                     | 9/0/0 (297 calls, 0 div)      |
| test/trash/int.spec.ts                                                | 102/0/5           | -                  | 102/0/5                                   | 102/0/5 (8517 calls, 0 div)                                  | 102/0/5 (8517 calls, 0 div)   |
| test/types/int.spec.ts                                                | 2/0/0             | -                  | 2/0/0                                     | 2/0/0                                                        | 2/0/0                         |
| test/upload-transformers/int.spec.ts                                  | 37/0/0            | -                  | 37/0/0                                    | 37/0/0 (867 calls, 0 div)                                    | 37/0/0 (867 calls, 0 div)     |
| test/uploads/int.spec.ts                                              | 155/0/0           | -                  | 155/0/0                                   | 155/0/0 (5513 calls, 0 div)                                  | 155/0/0 (5513 calls, 0 div)   |
| test/uuid-v7/int.spec.ts                                              | 0/0/6             | -                  | 0/0/6                                     | 0/0/6                                                        | 0/0/6                         |
| test/validate/int.spec.ts                                             | 112/0/0           | -                  | 112/0/0                                   | 112/0/0 (1895 calls, 0 div)                                  | 112/0/0 (1895 calls, 0 div)   |
| test/versions/int.spec.ts                                             | 153/0/0           | -                  | 153/0/0                                   | 153/0/0 (16385 calls, 0 div)                                 | 153/0/0 (16385 calls, 0 div)  |

### cosmosdb (baseline `.rs-baseline/mongodb-cosmosdb.json`; TS recheck = `.rs-baseline/mongodb-cosmosdb-env-recheck.json`)

Deltas of `engine rs` vs the 11-11 column: create-payload-app 11/0/0 -> LOAD (pnpm registry down),
kv 4/0/0 -> 3/1/0 (Redis not running, = TS baseline), schedules-autocron 0/1/0 -> 1/0/0 (= TS
rerun), storage-gcs 6/0/0 -> LOAD (emulator down), uploads 155/0/0 -> 151/4/0 (cookie-filtering
`fetch failed`, same in the TS rerun). No other file changed.

| file                                                                  | TS baseline p/f/s | TS recheck 11-16 p/f/s | engine rs 11-16 p/f/s   |
| --------------------------------------------------------------------- | ----------------- | ---------------------- | ----------------------- |
| test/__helpers/int/configImport.int.spec.ts                           | 1/0/0             | -                      | 1/0/0                   |
| test/__helpers/shared/getTestSuiteDir.int.spec.ts                     | 4/0/0             | -                      | 4/0/0                   |
| test/_community/int.spec.ts                                           | 2/0/0             | -                      | 2/0/0                   |
| test/access-control/int.spec.ts                                       | 84/0/0            | -                      | 84/0/0                  |
| test/access-control/postgres-logs.int.spec.ts                         | 0/0/6             | -                      | 0/0/6                   |
| test/admin-root/int.spec.ts                                           | 2/0/0             | -                      | 2/0/0                   |
| test/admin-routing/int.spec.ts                                        | 3/0/0             | -                      | 3/0/0                   |
| test/array-update/int.spec.ts                                         | 5/0/0             | -                      | 5/0/0                   |
| test/auth-api-key/int.spec.ts                                         | 11/0/0            | -                      | 11/0/0                  |
| test/auth/api-key/int.spec.ts                                         | 11/0/0            | -                      | 11/0/0                  |
| test/auth/custom-strategy/int.spec.ts                                 | 1/0/0             | -                      | 1/0/0                   |
| test/auth/first-user/int.spec.ts                                      | 1/0/0             | -                      | 1/0/0                   |
| test/auth/forgot-password-localized/int.spec.ts                       | 2/0/0             | -                      | 2/0/0                   |
| test/auth/int.spec.ts                                                 | 116/0/1           | -                      | 116/0/1                 |
| test/auth/jwt/int.spec.ts                                             | 3/0/0             | -                      | 3/0/0                   |
| test/auth/removed-token/int.spec.ts                                   | 5/0/0             | -                      | 5/0/0                   |
| test/authorship/int.spec.ts                                           | 32/0/0            | -                      | 32/0/0                  |
| test/authorship/single-auth.int.spec.ts                               | 5/0/0             | -                      | 5/0/0                   |
| test/base-access/int.spec.ts                                          | 7/0/0             | -                      | 7/0/0                   |
| test/cli/int.spec.ts                                                  | 73/0/3            | -                      | 73/0/3                  |
| test/collections-graphql/int.spec.ts                                  | 50/0/0            | -                      | 50/0/0                  |
| test/collections-rest/bulk-delete-rollback.int.spec.ts                | 0/0/1             | -                      | 0/0/1                   |
| test/collections-rest/int.spec.ts                                     | 128/0/2           | -                      | 128/0/2                 |
| test/collections-rest/tanstack-server-adapter.int.spec.ts             | 1/0/0             | -                      | 1/0/0                   |
| test/config/int.spec.ts                                               | 12/0/1            | -                      | 12/0/1                  |
| test/create-payload-app/int.spec.ts                                   | 11/0/0            | -                      | 0/0/11 **11 diff** LOAD |
| test/custom-graphql/int.spec.ts                                       | 1/0/0             | -                      | 1/0/0                   |
| test/dashboard/documents.int.spec.ts                                  | 11/0/0            | -                      | 11/0/0                  |
| test/dashboard/int.spec.ts                                            | 3/0/0             | -                      | 3/0/0                   |
| test/dashboard/pins.int.spec.ts                                       | 4/0/0             | -                      | 4/0/0                   |
| test/dashboard/thumbnails.int.spec.ts                                 | 3/0/0             | -                      | 3/0/0                   |
| test/database/batch-processing.int.spec.ts                            | 2/0/2             | -                      | 2/0/2                   |
| test/database/copy.int.spec.ts                                        | 4/0/1             | -                      | 4/0/1                   |
| test/database/int.spec.ts                                             | 159/0/18          | -                      | 159/0/18                |
| test/database/migrate-to-blocks-as-json/int.spec.ts                   | 0/0/1             | -                      | 0/0/1                   |
| test/database/migrations-cli.int.spec.ts                              | 3/0/0             | -                      | 3/0/0                   |
| test/database/pg-replica/int.spec.ts                                  | 0/0/16            | -                      | 0/0/16                  |
| test/database/postgres-logs.int.spec.ts                               | 0/0/6             | -                      | 0/0/6                   |
| test/database/postgres-operator-handlers.int.spec.ts                  | 0/0/29            | -                      | 0/0/29                  |
| test/database/postgres-relationships-v2-v3-migration/int.spec.ts      | 0/0/1             | -                      | 0/0/1                   |
| test/database/postgres-vector.int.spec.ts                             | 0/0/4             | -                      | 0/0/4                   |
| test/database/sqlite-bound-parameters-limit.int.spec.ts               | 0/0/4             | -                      | 0/0/4                   |
| test/database/up-down-migration/int.spec.ts                           | 0/0/1             | -                      | 0/0/1                   |
| test/dataloader/int.spec.ts                                           | 4/0/0             | -                      | 4/0/0                   |
| test/email-nodemailer/int.spec.ts                                     | 2/0/0             | -                      | 2/0/0                   |
| test/endpoints/int.spec.ts                                            | 10/0/0            | -                      | 10/0/0                  |
| test/endpoints/tanstack.int.spec.ts                                   | 1/0/0             | -                      | 1/0/0                   |
| test/field-access-context/int.spec.ts                                 | 11/0/0            | -                      | 11/0/0                  |
| test/field-paths/int.spec.ts                                          | 2/0/0             | -                      | 2/0/0                   |
| test/fields-relationship/int.spec.ts                                  | 4/0/0             | -                      | 4/0/0                   |
| test/fields/graphql-select.int.spec.ts                                | 1/0/0             | -                      | 1/0/0                   |
| test/fields/int.spec.ts                                               | 233/0/1           | -                      | 233/0/1                 |
| test/file-versioning/fileOperationManager.int.spec.ts                 | 1/0/0             | -                      | 1/0/0                   |
| test/file-versioning/int.spec.ts                                      | 49/0/9            | -                      | 49/0/9                  |
| test/file-versioning/rename.int.spec.ts                               | 13/0/1            | -                      | 13/0/1                  |
| test/folders/int.spec.ts                                              | 6/0/0             | -                      | 6/0/0                   |
| test/form-state/int.spec.ts                                           | 27/0/0            | -                      | 27/0/0                  |
| test/globals/int.spec.ts                                              | 13/0/0            | -                      | 13/0/0                  |
| test/graphql/hidden-fields.int.spec.ts                                | 11/0/0            | -                      | 11/0/0                  |
| test/graphql/int.spec.ts                                              | 9/0/0             | -                      | 9/0/0                   |
| test/hierarchy/collection-specific.int.spec.ts                        | 14/0/0            | -                      | 14/0/0                  |
| test/hierarchy/int.spec.ts                                            | 36/0/0            | -                      | 36/0/0                  |
| test/hmr/int.spec.ts                                                  | 0/0/4             | -                      | 0/0/4                   |
| test/hooks/int.spec.ts                                                | 45/0/0            | -                      | 45/0/0                  |
| test/joins/buildJoinAggregation.int.spec.ts                           | 0/0/8             | -                      | 0/0/8                   |
| test/joins/hierarchy.int.spec.ts                                      | 0/0/2             | -                      | 0/0/2                   |
| test/joins/int.spec.ts                                                | 79/0/44           | -                      | 79/0/44                 |
| test/joins/queryPath.int.spec.ts                                      | 0/0/4             | -                      | 0/0/4                   |
| test/joins/whereMutation.int.spec.ts                                  | 1/0/0             | -                      | 1/0/0                   |
| test/kv/int.spec.ts                                                   | 3/1/0             | -                      | 3/1/0                   |
| test/lexical-mdx/int.spec.ts                                          | 89/0/0            | -                      | 89/0/0                  |
| test/lexical/lexical.int.spec.ts                                      | 124/0/0           | -                      | 124/0/0                 |
| test/live-preview/int.spec.ts                                         | 18/0/0            | -                      | 18/0/0                  |
| test/llm-instructions/access.int.spec.ts                              | 12/0/0            | -                      | 12/0/0                  |
| test/llm-instructions/cli.int.spec.ts                                 | 11/0/0            | -                      | 11/0/0                  |
| test/llm-instructions/int.spec.ts                                     | 35/0/1            | -                      | 35/0/1                  |
| test/llm-instructions/slots.int.spec.ts                               | 5/0/0             | -                      | 5/0/0                   |
| test/loader/int.spec.ts                                               | 4/0/0             | -                      | 4/0/0                   |
| test/localization/int.spec.ts                                         | 159/0/0           | -                      | 159/0/0                 |
| test/localization/localizeStatus.int.spec.ts                          | 0/0/11            | -                      | 0/0/11                  |
| test/locked-documents/bulk-delete.int.spec.ts                         | 1/0/0             | -                      | 1/0/0                   |
| test/locked-documents/int.spec.ts                                     | 13/0/0            | -                      | 13/0/0                  |
| test/login-with-username/int.spec.ts                                  | 4/0/0             | -                      | 4/0/0                   |
| test/mongodb-schema-build-cache/int.spec.ts                           | 7/0/0             | -                      | 7/0/0                   |
| test/payload-cloud/int.spec.ts                                        | 4/0/1             | -                      | 4/0/1                   |
| test/plugin-cloud-storage/int.compositePrefixes.int.spec.ts           | 0/0/2             | -                      | 0/0/2                   |
| test/plugin-cloud-storage/int.spec.ts                                 | 33/3/13           | -                      | 33/3/13                 |
| test/plugin-cloud-storage/versioning.int.spec.ts                      | 42/0/7            | -                      | 42/0/7                  |
| test/plugin-ecommerce/int.spec.ts                                     | 36/0/0            | -                      | 36/0/0                  |
| test/plugin-form-builder/int.spec.ts                                  | 55/0/0            | -                      | 55/0/0                  |
| test/plugin-import-export/field-hooks.int.spec.ts                     | 0/29/0            | -                      | 0/29/0                  |
| test/plugin-import-export/hooks.int.spec.ts                           | 0/42/0            | -                      | 0/42/0                  |
| test/plugin-import-export/int.spec.ts                                 | 0/0/198           | -                      | 0/0/198 LOAD            |
| test/plugin-mcp/instructions.int.spec.ts                              | 10/0/0            | -                      | 10/0/0                  |
| test/plugin-mcp/int.spec.ts                                           | 237/0/1           | -                      | 237/0/1                 |
| test/plugin-multi-tenant/int.spec.ts                                  | 21/0/0            | -                      | 21/0/0                  |
| test/plugin-nested-docs/int.spec.ts                                   | 12/0/0            | -                      | 12/0/0                  |
| test/plugin-redirects/int.spec.ts                                     | 3/0/0             | -                      | 3/0/0                   |
| test/plugin-search/int.spec.ts                                        | 21/0/0            | -                      | 21/0/0                  |
| test/plugin-sentry/int.spec.ts                                        | 0/0/1             | -                      | 0/0/1                   |
| test/plugin-seo/int.spec.ts                                           | 21/0/0            | -                      | 21/0/0                  |
| test/plugin-stripe/int.spec.ts                                        | 7/0/3             | -                      | 7/0/3                   |
| test/plugins/int.spec.ts                                              | 6/0/0             | -                      | 6/0/0                   |
| test/query-presets/int.spec.ts                                        | 13/0/1            | -                      | 13/0/1                  |
| test/queues/cli.int.spec.ts                                           | 2/0/0             | -                      | 2/0/0                   |
| test/queues/int.spec.ts                                               | 84/0/3            | -                      | 84/0/3                  |
| test/queues/postgres-logs.int.spec.ts                                 | 0/0/2             | -                      | 0/0/2                   |
| test/queues/schedules-autocron.int.spec.ts                            | 0/1/0             | 1/0/0 **1 diff**       | 1/0/0                   |
| test/queues/schedules.int.spec.ts                                     | 13/0/0            | -                      | 13/0/0                  |
| test/relationships/int.spec.ts                                        | 74/0/0            | -                      | 74/0/0                  |
| test/sdk/int.spec.ts                                                  | 39/0/0            | -                      | 39/0/0                  |
| test/select/graphql-select.int.spec.ts                                | 4/0/0             | -                      | 4/0/0                   |
| test/select/int.spec.ts                                               | 115/0/0           | -                      | 115/0/0                 |
| test/select/postgreslogs.int.spec.ts                                  | 0/0/2             | -                      | 0/0/2                   |
| test/sizes-to-variants/int.spec.ts                                    | 8/0/15            | -                      | 8/0/15                  |
| test/sort/int.spec.ts                                                 | 44/0/0            | -                      | 44/0/0                  |
| test/storage-azure/client-uploads/int.spec.ts                         | 0/13/0            | -                      | 0/13/0                  |
| test/storage-azure/int.spec.ts                                        | 0/0/7             | -                      | 0/0/7 LOAD              |
| test/storage-azure/publicAccess.int.spec.ts                           | 0/2/0             | -                      | 0/2/0                   |
| test/storage-azure/streamingUploads.int.spec.ts                       | 0/4/0             | -                      | 0/4/0                   |
| test/storage-gcs/int.spec.ts                                          | 0/0/6             | -                      | 0/0/6 LOAD              |
| test/storage-s3/client-uploads/int.spec.ts                            | 0/25/0            | -                      | 0/25/0                  |
| test/storage-s3/int.spec.ts                                           | 0/18/1            | -                      | 0/18/1                  |
| test/storage-s3/searchBeforeS3.int.spec.ts                            | 0/3/0             | -                      | 0/3/0                   |
| test/storage-vercel-blob/client-uploads/compositePrefixes.int.spec.ts | 0/1/0             | -                      | 0/1/0                   |
| test/storage-vercel-blob/client-uploads/int.spec.ts                   | 0/4/2             | -                      | 0/4/2                   |
| test/storage-vercel-blob/int.spec.ts                                  | 0/15/1            | -                      | 0/15/1                  |
| test/tags/int.spec.ts                                                 | 9/0/0             | -                      | 9/0/0                   |
| test/trash/int.spec.ts                                                | 102/0/5           | -                      | 102/0/5                 |
| test/types/int.spec.ts                                                | 2/0/0             | -                      | 2/0/0                   |
| test/upload-transformers/int.spec.ts                                  | 37/0/0            | -                      | 37/0/0                  |
| test/uploads/int.spec.ts                                              | 155/0/0           | 151/4/0 **4 diff**     | 151/4/0                 |
| test/uuid-v7/int.spec.ts                                              | 0/0/6             | -                      | 0/0/6                   |
| test/validate/int.spec.ts                                             | 112/0/0           | -                      | 112/0/0                 |
| test/versions/int.spec.ts                                             | 153/0/0           | -                      | 153/0/0                 |

- TS recheck 11-16: {"differences":5,"divergences":0,"engineCalls":0,"failed":4,"files":2,"nativeCalls":0,"noNativeProof":0,"passed":152,"shadowCalls":0,"skipped":0}
  - test/queues/schedules-autocron.int.spec.ts: failed -> passed: Queues - scheduling, with automatic scheduling handling can auto-schedule through automatic crons and autorun jobs
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should resolve relative URLs against the configured server origin (TypeError: fetch failed)
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should apply request origin policy to relative URLs (TypeError: fetch failed)
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should filter authentication cookies after a cross-origin redirect (TypeError: fetch failed)
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should provide each request destination to the external file header filter (TypeError: fetch failed)
- engine rs 11-16: {"differences":11,"divergences":0,"engineCalls":53107,"failed":164,"files":135,"nativeCalls":53107,"noNativeProof":0,"passed":3277,"shadowCalls":0,"skipped":470}
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with srcDir should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with srcDir should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with noSrcDir should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with noSrcDir should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with srcDirCanary should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with srcDirCanary should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with noSrcDirCanary should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with noSrcDirCanary should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app official TanStack generator should initialize and build a generated TanStack Start project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app official TanStack generator should initialize and build a generated TanStack Router-only project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app adapter replacement should replace mongodb with postgres adapter
  - test/create-payload-app/int.spec.ts: load error FAIL |int| test/create-payload-app/int.spec.ts > create-payload-app Error: Hook timed out in 90000ms. If this is a long-running hook, pass a timeout value as t
  - test/plugin-import-export/int.spec.ts: load error FAIL |int| test/plugin-import-export/int.spec.ts > @payloadcms/plugin-import-export Error: connect ECONNREFUSED ::1:4566 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
  - test/storage-azure/int.spec.ts: load error FAIL |int| test/storage-azure/int.spec.ts > @payloadcms/storage-azure RestError: bad gateway ❯ handleErrorResponse node_modules/.pnpm/@azure+core-client@1.11
  - test/storage-gcs/int.spec.ts: load error FAIL |int| test/storage-gcs/int.spec.ts > @payloadcms/storage-gcs Error: Multiple errors occurred during the request. Please see the `errors` array for complet

### documentdb (baseline `.rs-baseline/mongodb-documentdb.json`, recorded 11-16)

| file                                                                  | TS baseline p/f/s | TS recheck 11-16 p/f/s | engine rs 11-16 p/f/s |
| --------------------------------------------------------------------- | ----------------- | ---------------------- | --------------------- |
| test/__helpers/int/configImport.int.spec.ts                           | 1/0/0             | -                      | 1/0/0                 |
| test/__helpers/shared/getTestSuiteDir.int.spec.ts                     | 4/0/0             | -                      | 4/0/0                 |
| test/_community/int.spec.ts                                           | 2/0/0             | -                      | 2/0/0                 |
| test/access-control/int.spec.ts                                       | 84/0/0            | -                      | 84/0/0                |
| test/access-control/postgres-logs.int.spec.ts                         | 0/0/6             | -                      | 0/0/6                 |
| test/admin-root/int.spec.ts                                           | 2/0/0             | -                      | 2/0/0                 |
| test/admin-routing/int.spec.ts                                        | 3/0/0             | -                      | 3/0/0                 |
| test/array-update/int.spec.ts                                         | 5/0/0             | -                      | 5/0/0                 |
| test/auth-api-key/int.spec.ts                                         | 11/0/0            | -                      | 11/0/0                |
| test/auth/api-key/int.spec.ts                                         | 11/0/0            | -                      | 11/0/0                |
| test/auth/custom-strategy/int.spec.ts                                 | 1/0/0             | -                      | 1/0/0                 |
| test/auth/first-user/int.spec.ts                                      | 1/0/0             | -                      | 1/0/0                 |
| test/auth/forgot-password-localized/int.spec.ts                       | 2/0/0             | -                      | 2/0/0                 |
| test/auth/int.spec.ts                                                 | 116/0/1           | -                      | 116/0/1               |
| test/auth/jwt/int.spec.ts                                             | 3/0/0             | -                      | 3/0/0                 |
| test/auth/removed-token/int.spec.ts                                   | 5/0/0             | -                      | 5/0/0                 |
| test/authorship/int.spec.ts                                           | 32/0/0            | -                      | 32/0/0                |
| test/authorship/single-auth.int.spec.ts                               | 5/0/0             | -                      | 5/0/0                 |
| test/base-access/int.spec.ts                                          | 7/0/0             | -                      | 7/0/0                 |
| test/cli/int.spec.ts                                                  | 72/1/3            | 68/5/3 **6 diff**      | 73/0/3                |
| test/collections-graphql/int.spec.ts                                  | 50/0/0            | -                      | 50/0/0                |
| test/collections-rest/bulk-delete-rollback.int.spec.ts                | 0/0/1             | -                      | 0/0/1                 |
| test/collections-rest/int.spec.ts                                     | 128/0/2           | -                      | 128/0/2               |
| test/collections-rest/tanstack-server-adapter.int.spec.ts             | 1/0/0             | -                      | 1/0/0                 |
| test/config/int.spec.ts                                               | 12/0/1            | -                      | 12/0/1                |
| test/create-payload-app/int.spec.ts                                   | 0/0/11            | -                      | 0/0/11 LOAD           |
| test/custom-graphql/int.spec.ts                                       | 2/0/0             | -                      | 2/0/0                 |
| test/dashboard/documents.int.spec.ts                                  | 11/0/0            | -                      | 11/0/0                |
| test/dashboard/int.spec.ts                                            | 3/0/0             | -                      | 3/0/0                 |
| test/dashboard/pins.int.spec.ts                                       | 4/0/0             | -                      | 4/0/0                 |
| test/dashboard/thumbnails.int.spec.ts                                 | 3/0/0             | -                      | 3/0/0                 |
| test/database/batch-processing.int.spec.ts                            | 2/0/2             | -                      | 2/0/2                 |
| test/database/copy.int.spec.ts                                        | 4/0/1             | -                      | 4/0/1                 |
| test/database/int.spec.ts                                             | 164/0/17          | -                      | 164/0/17              |
| test/database/migrate-to-blocks-as-json/int.spec.ts                   | 0/0/1             | -                      | 0/0/1                 |
| test/database/migrations-cli.int.spec.ts                              | 3/0/0             | -                      | 3/0/0                 |
| test/database/pg-replica/int.spec.ts                                  | 0/0/16            | -                      | 0/0/16                |
| test/database/postgres-logs.int.spec.ts                               | 0/0/6             | -                      | 0/0/6                 |
| test/database/postgres-operator-handlers.int.spec.ts                  | 0/0/29            | -                      | 0/0/29                |
| test/database/postgres-relationships-v2-v3-migration/int.spec.ts      | 0/0/1             | -                      | 0/0/1                 |
| test/database/postgres-vector.int.spec.ts                             | 0/0/4             | -                      | 0/0/4                 |
| test/database/sqlite-bound-parameters-limit.int.spec.ts               | 0/0/4             | -                      | 0/0/4                 |
| test/database/up-down-migration/int.spec.ts                           | 0/0/1             | -                      | 0/0/1                 |
| test/dataloader/int.spec.ts                                           | 4/0/0             | -                      | 4/0/0                 |
| test/email-nodemailer/int.spec.ts                                     | 2/0/0             | -                      | 2/0/0                 |
| test/endpoints/int.spec.ts                                            | 10/0/0            | -                      | 10/0/0                |
| test/endpoints/tanstack.int.spec.ts                                   | 1/0/0             | -                      | 1/0/0                 |
| test/field-access-context/int.spec.ts                                 | 11/0/0            | -                      | 11/0/0                |
| test/field-paths/int.spec.ts                                          | 2/0/0             | -                      | 2/0/0                 |
| test/fields-relationship/int.spec.ts                                  | 4/0/0             | -                      | 4/0/0                 |
| test/fields/graphql-select.int.spec.ts                                | 1/0/0             | -                      | 1/0/0                 |
| test/fields/int.spec.ts                                               | 233/0/1           | -                      | 233/0/1               |
| test/file-versioning/fileOperationManager.int.spec.ts                 | 1/0/0             | -                      | 1/0/0                 |
| test/file-versioning/int.spec.ts                                      | 51/0/7            | -                      | 51/0/7                |
| test/file-versioning/rename.int.spec.ts                               | 14/0/0            | -                      | 14/0/0                |
| test/folders/int.spec.ts                                              | 6/0/0             | -                      | 6/0/0                 |
| test/form-state/int.spec.ts                                           | 27/0/0            | -                      | 27/0/0                |
| test/globals/int.spec.ts                                              | 13/0/0            | -                      | 13/0/0                |
| test/graphql/hidden-fields.int.spec.ts                                | 11/0/0            | -                      | 11/0/0                |
| test/graphql/int.spec.ts                                              | 9/0/0             | -                      | 9/0/0                 |
| test/hierarchy/collection-specific.int.spec.ts                        | 14/0/0            | -                      | 14/0/0                |
| test/hierarchy/int.spec.ts                                            | 36/0/0            | -                      | 36/0/0                |
| test/hmr/int.spec.ts                                                  | 0/0/4             | -                      | 0/0/4                 |
| test/hooks/int.spec.ts                                                | 45/0/0            | -                      | 45/0/0                |
| test/joins/buildJoinAggregation.int.spec.ts                           | 0/0/8             | -                      | 0/0/8                 |
| test/joins/hierarchy.int.spec.ts                                      | 0/0/2             | -                      | 0/0/2                 |
| test/joins/int.spec.ts                                                | 79/0/44           | -                      | 79/0/44               |
| test/joins/queryPath.int.spec.ts                                      | 0/0/4             | -                      | 0/0/4                 |
| test/joins/whereMutation.int.spec.ts                                  | 1/0/0             | -                      | 1/0/0                 |
| test/kv/int.spec.ts                                                   | 3/1/0             | -                      | 3/1/0                 |
| test/lexical-mdx/int.spec.ts                                          | 89/0/0            | -                      | 89/0/0                |
| test/lexical/lexical.int.spec.ts                                      | 124/0/0           | -                      | 124/0/0               |
| test/live-preview/int.spec.ts                                         | 18/0/0            | -                      | 18/0/0                |
| test/llm-instructions/access.int.spec.ts                              | 12/0/0            | -                      | 12/0/0                |
| test/llm-instructions/cli.int.spec.ts                                 | 11/0/0            | -                      | 11/0/0                |
| test/llm-instructions/int.spec.ts                                     | 35/0/1            | -                      | 35/0/1                |
| test/llm-instructions/slots.int.spec.ts                               | 5/0/0             | -                      | 5/0/0                 |
| test/loader/int.spec.ts                                               | 4/0/0             | -                      | 4/0/0                 |
| test/localization/int.spec.ts                                         | 159/0/0           | -                      | 159/0/0               |
| test/localization/localizeStatus.int.spec.ts                          | 0/0/11            | -                      | 0/0/11                |
| test/locked-documents/bulk-delete.int.spec.ts                         | 1/0/0             | -                      | 1/0/0                 |
| test/locked-documents/int.spec.ts                                     | 13/0/0            | -                      | 13/0/0                |
| test/login-with-username/int.spec.ts                                  | 4/0/0             | -                      | 4/0/0                 |
| test/mongodb-schema-build-cache/int.spec.ts                           | 7/0/0             | -                      | 7/0/0                 |
| test/payload-cloud/int.spec.ts                                        | 4/0/1             | -                      | 4/0/1                 |
| test/plugin-cloud-storage/int.compositePrefixes.int.spec.ts           | 0/0/2             | -                      | 0/0/2                 |
| test/plugin-cloud-storage/int.spec.ts                                 | 33/3/13           | -                      | 33/3/13               |
| test/plugin-cloud-storage/versioning.int.spec.ts                      | 42/0/7            | -                      | 42/0/7                |
| test/plugin-ecommerce/int.spec.ts                                     | 36/0/0            | -                      | 36/0/0                |
| test/plugin-form-builder/int.spec.ts                                  | 55/0/0            | -                      | 55/0/0                |
| test/plugin-import-export/field-hooks.int.spec.ts                     | 0/29/0            | -                      | 0/29/0                |
| test/plugin-import-export/hooks.int.spec.ts                           | 0/42/0            | -                      | 0/42/0                |
| test/plugin-import-export/int.spec.ts                                 | 0/0/198           | -                      | 0/0/198 LOAD          |
| test/plugin-mcp/instructions.int.spec.ts                              | 10/0/0            | -                      | 10/0/0                |
| test/plugin-mcp/int.spec.ts                                           | 237/0/1           | -                      | 237/0/1               |
| test/plugin-multi-tenant/int.spec.ts                                  | 21/0/0            | -                      | 21/0/0                |
| test/plugin-nested-docs/int.spec.ts                                   | 12/0/0            | -                      | 12/0/0                |
| test/plugin-redirects/int.spec.ts                                     | 3/0/0             | -                      | 3/0/0                 |
| test/plugin-search/int.spec.ts                                        | 21/0/0            | -                      | 21/0/0                |
| test/plugin-sentry/int.spec.ts                                        | 0/0/1             | -                      | 0/0/1                 |
| test/plugin-seo/int.spec.ts                                           | 21/0/0            | -                      | 21/0/0                |
| test/plugin-stripe/int.spec.ts                                        | 7/0/3             | -                      | 7/0/3                 |
| test/plugins/int.spec.ts                                              | 6/0/0             | -                      | 6/0/0                 |
| test/query-presets/int.spec.ts                                        | 13/0/1            | -                      | 13/0/1                |
| test/queues/cli.int.spec.ts                                           | 2/0/0             | -                      | 2/0/0                 |
| test/queues/int.spec.ts                                               | 84/0/3            | -                      | 84/0/3                |
| test/queues/postgres-logs.int.spec.ts                                 | 0/0/2             | -                      | 0/0/2                 |
| test/queues/schedules-autocron.int.spec.ts                            | 1/0/0             | -                      | 1/0/0                 |
| test/queues/schedules.int.spec.ts                                     | 13/0/0            | -                      | 13/0/0                |
| test/relationships/int.spec.ts                                        | 74/0/0            | -                      | 74/0/0                |
| test/sdk/int.spec.ts                                                  | 39/0/0            | -                      | 39/0/0                |
| test/select/graphql-select.int.spec.ts                                | 4/0/0             | -                      | 4/0/0                 |
| test/select/int.spec.ts                                               | 115/0/0           | -                      | 115/0/0               |
| test/select/postgreslogs.int.spec.ts                                  | 0/0/2             | -                      | 0/0/2                 |
| test/sizes-to-variants/int.spec.ts                                    | 8/0/15            | -                      | 8/0/15                |
| test/sort/int.spec.ts                                                 | 44/0/0            | -                      | 44/0/0                |
| test/storage-azure/client-uploads/int.spec.ts                         | 0/13/0            | -                      | 0/13/0                |
| test/storage-azure/int.spec.ts                                        | 0/0/7             | -                      | 0/0/7 LOAD            |
| test/storage-azure/publicAccess.int.spec.ts                           | 0/2/0             | -                      | 0/2/0                 |
| test/storage-azure/streamingUploads.int.spec.ts                       | 0/4/0             | -                      | 0/4/0                 |
| test/storage-gcs/int.spec.ts                                          | 0/0/6             | -                      | 0/0/6 LOAD            |
| test/storage-s3/client-uploads/int.spec.ts                            | 0/25/0            | -                      | 0/25/0                |
| test/storage-s3/int.spec.ts                                           | 0/18/1            | -                      | 0/18/1                |
| test/storage-s3/searchBeforeS3.int.spec.ts                            | 0/3/0             | -                      | 0/3/0                 |
| test/storage-vercel-blob/client-uploads/compositePrefixes.int.spec.ts | 0/1/0             | -                      | 0/1/0                 |
| test/storage-vercel-blob/client-uploads/int.spec.ts                   | 0/6/0             | -                      | 0/6/0                 |
| test/storage-vercel-blob/int.spec.ts                                  | 0/16/0            | -                      | 0/16/0                |
| test/tags/int.spec.ts                                                 | 9/0/0             | -                      | 9/0/0                 |
| test/trash/int.spec.ts                                                | 102/0/5           | -                      | 102/0/5               |
| test/types/int.spec.ts                                                | 2/0/0             | -                      | 2/0/0                 |
| test/upload-transformers/int.spec.ts                                  | 37/0/0            | -                      | 37/0/0                |
| test/uploads/int.spec.ts                                              | 150/5/0           | 151/4/0 **1 diff**     | 151/4/0               |
| test/uuid-v7/int.spec.ts                                              | 0/0/6             | -                      | 0/0/6                 |
| test/validate/int.spec.ts                                             | 112/0/0           | -                      | 112/0/0               |
| test/versions/int.spec.ts                                             | 152/1/0           | 153/0/0 **1 diff**     | 153/0/0               |

- TS recheck 11-16: {"differences":8,"divergences":0,"engineCalls":0,"failed":9,"files":3,"nativeCalls":0,"noNativeProof":0,"passed":372,"shadowCalls":0,"skipped":3}
  - test/cli/int.spec.ts: passed -> failed: CLI migrate:fresh --force-accept-warning --json (AssertionError: expected undefined to match object { batch: 1 })
  - test/cli/int.spec.ts: passed -> failed: CLI migrate:refresh --json (AssertionError: expected undefined to be defined)
  - test/cli/int.spec.ts: passed -> failed: CLI migrate:reset --json (AssertionError: expected undefined to be defined)
  - test/cli/int.spec.ts: passed -> failed: CLI migrate:reset --help (AssertionError: expected undefined to be defined)
  - test/cli/int.spec.ts: passed -> failed: CLI migrate:status --json (AssertionError: expected '{"command":"migrate:status","result":…' to contain '20261116_114135_status')
  - test/cli/int.spec.ts: failed -> passed: CLI migrate:status --help
  - test/uploads/int.spec.ts: failed -> passed: Collections - Uploads REST API create creates from upload instructions
  - test/versions/int.spec.ts: failed -> passed: Versions Scheduled Publish should preserve the scheduling user collection for scheduled publish jobs
- engine rs 11-16: {"differences":0,"divergences":0,"engineCalls":53320,"failed":167,"files":135,"nativeCalls":53320,"noNativeProof":0,"passed":3286,"shadowCalls":0,"skipped":463}
  - test/create-payload-app/int.spec.ts: load error FAIL |int| test/create-payload-app/int.spec.ts > create-payload-app Error: Hook timed out in 90000ms. If this is a long-running hook, pass a timeout value as t
  - test/plugin-import-export/int.spec.ts: load error FAIL |int| test/plugin-import-export/int.spec.ts > @payloadcms/plugin-import-export Error: connect ECONNREFUSED ::1:4566 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
  - test/storage-azure/int.spec.ts: load error FAIL |int| test/storage-azure/int.spec.ts > @payloadcms/storage-azure RestError: bad gateway ❯ handleErrorResponse node_modules/.pnpm/@azure+core-client@1.11
  - test/storage-gcs/int.spec.ts: load error FAIL |int| test/storage-gcs/int.spec.ts > @payloadcms/storage-gcs Error: Multiple errors occurred during the request. Please see the `errors` array for complet

### firestore (baseline `.rs-baseline/mongodb-firestore.json`, recorded 11-16)

| file                                                                  | TS baseline p/f/s | TS recheck 11-16 p/f/s | engine rs 11-16 p/f/s                      |
| --------------------------------------------------------------------- | ----------------- | ---------------------- | ------------------------------------------ |
| test/__helpers/int/configImport.int.spec.ts                           | 1/0/0             | -                      | 1/0/0                                      |
| test/__helpers/shared/getTestSuiteDir.int.spec.ts                     | 4/0/0             | -                      | 4/0/0                                      |
| test/_community/int.spec.ts                                           | 2/0/0             | -                      | 2/0/0                                      |
| test/access-control/int.spec.ts                                       | 84/0/0            | -                      | 84/0/0                                     |
| test/access-control/postgres-logs.int.spec.ts                         | 0/0/6             | -                      | 0/0/6                                      |
| test/admin-root/int.spec.ts                                           | 2/0/0             | -                      | 2/0/0                                      |
| test/admin-routing/int.spec.ts                                        | 3/0/0             | -                      | 3/0/0                                      |
| test/array-update/int.spec.ts                                         | 5/0/0             | -                      | 5/0/0                                      |
| test/auth-api-key/int.spec.ts                                         | 11/0/0            | -                      | 11/0/0                                     |
| test/auth/api-key/int.spec.ts                                         | 11/0/0            | -                      | 11/0/0                                     |
| test/auth/custom-strategy/int.spec.ts                                 | 1/0/0             | -                      | 1/0/0                                      |
| test/auth/first-user/int.spec.ts                                      | 1/0/0             | -                      | 1/0/0                                      |
| test/auth/forgot-password-localized/int.spec.ts                       | 2/0/0             | -                      | 2/0/0                                      |
| test/auth/int.spec.ts                                                 | 116/0/1           | -                      | 116/0/1                                    |
| test/auth/jwt/int.spec.ts                                             | 3/0/0             | -                      | 3/0/0                                      |
| test/auth/removed-token/int.spec.ts                                   | 5/0/0             | -                      | 5/0/0                                      |
| test/authorship/int.spec.ts                                           | 32/0/0            | -                      | 32/0/0                                     |
| test/authorship/single-auth.int.spec.ts                               | 5/0/0             | -                      | 5/0/0                                      |
| test/base-access/int.spec.ts                                          | 7/0/0             | -                      | 7/0/0                                      |
| test/cli/int.spec.ts                                                  | 73/0/3            | -                      | 70/3/3 **3 diff**, solo rerun clean 73/0/3 |
| test/collections-graphql/int.spec.ts                                  | 50/0/0            | -                      | 50/0/0                                     |
| test/collections-rest/bulk-delete-rollback.int.spec.ts                | 1/0/0             | -                      | 1/0/0                                      |
| test/collections-rest/int.spec.ts                                     | 128/0/2           | -                      | 128/0/2                                    |
| test/collections-rest/tanstack-server-adapter.int.spec.ts             | 1/0/0             | -                      | 1/0/0                                      |
| test/config/int.spec.ts                                               | 12/0/1            | -                      | 12/0/1                                     |
| test/create-payload-app/int.spec.ts                                   | 0/0/11            | -                      | 0/0/11 LOAD                                |
| test/custom-graphql/int.spec.ts                                       | 1/0/0             | -                      | 1/0/0                                      |
| test/dashboard/documents.int.spec.ts                                  | 11/0/0            | -                      | 11/0/0                                     |
| test/dashboard/int.spec.ts                                            | 3/0/0             | -                      | 3/0/0                                      |
| test/dashboard/pins.int.spec.ts                                       | 4/0/0             | -                      | 4/0/0                                      |
| test/dashboard/thumbnails.int.spec.ts                                 | 3/0/0             | -                      | 3/0/0                                      |
| test/database/batch-processing.int.spec.ts                            | 2/0/2             | -                      | 2/0/2                                      |
| test/database/copy.int.spec.ts                                        | 4/0/1             | -                      | 4/0/1                                      |
| test/database/int.spec.ts                                             | 159/0/18          | -                      | 159/0/18                                   |
| test/database/migrate-to-blocks-as-json/int.spec.ts                   | 0/0/1             | -                      | 0/0/1                                      |
| test/database/migrations-cli.int.spec.ts                              | 3/0/0             | -                      | 3/0/0                                      |
| test/database/pg-replica/int.spec.ts                                  | 0/0/16            | -                      | 0/0/16                                     |
| test/database/postgres-logs.int.spec.ts                               | 0/0/6             | -                      | 0/0/6                                      |
| test/database/postgres-operator-handlers.int.spec.ts                  | 0/0/29            | -                      | 0/0/29                                     |
| test/database/postgres-relationships-v2-v3-migration/int.spec.ts      | 0/0/1             | -                      | 0/0/1                                      |
| test/database/postgres-vector.int.spec.ts                             | 0/0/4             | -                      | 0/0/4                                      |
| test/database/sqlite-bound-parameters-limit.int.spec.ts               | 0/0/4             | -                      | 0/0/4                                      |
| test/database/up-down-migration/int.spec.ts                           | 0/0/1             | -                      | 0/0/1                                      |
| test/dataloader/int.spec.ts                                           | 4/0/0             | -                      | 4/0/0                                      |
| test/email-nodemailer/int.spec.ts                                     | 2/0/0             | -                      | 2/0/0                                      |
| test/endpoints/int.spec.ts                                            | 10/0/0            | -                      | 10/0/0                                     |
| test/endpoints/tanstack.int.spec.ts                                   | 1/0/0             | -                      | 1/0/0                                      |
| test/field-access-context/int.spec.ts                                 | 11/0/0            | -                      | 11/0/0                                     |
| test/field-paths/int.spec.ts                                          | 2/0/0             | -                      | 2/0/0                                      |
| test/fields-relationship/int.spec.ts                                  | 4/0/0             | -                      | 4/0/0                                      |
| test/fields/graphql-select.int.spec.ts                                | 1/0/0             | -                      | 1/0/0                                      |
| test/fields/int.spec.ts                                               | 233/0/1           | -                      | 233/0/1                                    |
| test/file-versioning/fileOperationManager.int.spec.ts                 | 1/0/0             | -                      | 1/0/0                                      |
| test/file-versioning/int.spec.ts                                      | 49/0/9            | -                      | 49/0/9                                     |
| test/file-versioning/rename.int.spec.ts                               | 13/0/1            | -                      | 13/0/1                                     |
| test/folders/int.spec.ts                                              | 6/0/0             | -                      | 6/0/0                                      |
| test/form-state/int.spec.ts                                           | 27/0/0            | -                      | 27/0/0                                     |
| test/globals/int.spec.ts                                              | 13/0/0            | -                      | 13/0/0                                     |
| test/graphql/hidden-fields.int.spec.ts                                | 11/0/0            | -                      | 11/0/0                                     |
| test/graphql/int.spec.ts                                              | 9/0/0             | -                      | 9/0/0                                      |
| test/hierarchy/collection-specific.int.spec.ts                        | 14/0/0            | -                      | 14/0/0                                     |
| test/hierarchy/int.spec.ts                                            | 36/0/0            | -                      | 36/0/0                                     |
| test/hmr/int.spec.ts                                                  | 0/0/4             | -                      | 0/0/4                                      |
| test/hooks/int.spec.ts                                                | 45/0/0            | -                      | 45/0/0                                     |
| test/joins/buildJoinAggregation.int.spec.ts                           | 0/0/8             | -                      | 0/0/8                                      |
| test/joins/hierarchy.int.spec.ts                                      | 0/0/2             | -                      | 0/0/2                                      |
| test/joins/int.spec.ts                                                | 79/0/44           | -                      | 79/0/44                                    |
| test/joins/queryPath.int.spec.ts                                      | 0/0/4             | -                      | 0/0/4                                      |
| test/joins/whereMutation.int.spec.ts                                  | 1/0/0             | -                      | 1/0/0                                      |
| test/kv/int.spec.ts                                                   | 3/1/0             | -                      | 3/1/0                                      |
| test/lexical-mdx/int.spec.ts                                          | 89/0/0            | -                      | 89/0/0                                     |
| test/lexical/lexical.int.spec.ts                                      | 122/2/0           | 124/0/0 **2 diff**     | 124/0/0                                    |
| test/live-preview/int.spec.ts                                         | 18/0/0            | -                      | 18/0/0                                     |
| test/llm-instructions/access.int.spec.ts                              | 12/0/0            | -                      | 12/0/0                                     |
| test/llm-instructions/cli.int.spec.ts                                 | 11/0/0            | -                      | 11/0/0                                     |
| test/llm-instructions/int.spec.ts                                     | 35/0/1            | -                      | 35/0/1                                     |
| test/llm-instructions/slots.int.spec.ts                               | 5/0/0             | -                      | 5/0/0                                      |
| test/loader/int.spec.ts                                               | 4/0/0             | -                      | 4/0/0                                      |
| test/localization/int.spec.ts                                         | 159/0/0           | -                      | 159/0/0                                    |
| test/localization/localizeStatus.int.spec.ts                          | 0/0/11            | -                      | 0/0/11                                     |
| test/locked-documents/bulk-delete.int.spec.ts                         | 1/0/0             | -                      | 1/0/0                                      |
| test/locked-documents/int.spec.ts                                     | 13/0/0            | -                      | 13/0/0                                     |
| test/login-with-username/int.spec.ts                                  | 4/0/0             | -                      | 4/0/0                                      |
| test/mongodb-schema-build-cache/int.spec.ts                           | 7/0/0             | -                      | 7/0/0                                      |
| test/payload-cloud/int.spec.ts                                        | 4/0/1             | -                      | 4/0/1                                      |
| test/plugin-cloud-storage/int.compositePrefixes.int.spec.ts           | 0/0/2             | -                      | 0/0/2                                      |
| test/plugin-cloud-storage/int.spec.ts                                 | 33/3/13           | -                      | 33/3/13                                    |
| test/plugin-cloud-storage/versioning.int.spec.ts                      | 42/0/7            | -                      | 42/0/7                                     |
| test/plugin-ecommerce/int.spec.ts                                     | 36/0/0            | -                      | 36/0/0                                     |
| test/plugin-form-builder/int.spec.ts                                  | 55/0/0            | -                      | 55/0/0                                     |
| test/plugin-import-export/field-hooks.int.spec.ts                     | 0/29/0            | -                      | 0/29/0                                     |
| test/plugin-import-export/hooks.int.spec.ts                           | 0/42/0            | -                      | 0/42/0                                     |
| test/plugin-import-export/int.spec.ts                                 | 0/0/198           | -                      | 0/0/198 LOAD                               |
| test/plugin-mcp/instructions.int.spec.ts                              | 10/0/0            | -                      | 10/0/0                                     |
| test/plugin-mcp/int.spec.ts                                           | 237/0/1           | -                      | 237/0/1                                    |
| test/plugin-multi-tenant/int.spec.ts                                  | 21/0/0            | -                      | 21/0/0                                     |
| test/plugin-nested-docs/int.spec.ts                                   | 12/0/0            | -                      | 12/0/0                                     |
| test/plugin-redirects/int.spec.ts                                     | 3/0/0             | -                      | 3/0/0                                      |
| test/plugin-search/int.spec.ts                                        | 21/0/0            | -                      | 21/0/0                                     |
| test/plugin-sentry/int.spec.ts                                        | 0/0/1             | -                      | 0/0/1                                      |
| test/plugin-seo/int.spec.ts                                           | 21/0/0            | -                      | 21/0/0                                     |
| test/plugin-stripe/int.spec.ts                                        | 7/0/3             | -                      | 7/0/3                                      |
| test/plugins/int.spec.ts                                              | 6/0/0             | -                      | 6/0/0                                      |
| test/query-presets/int.spec.ts                                        | 13/0/1            | -                      | 13/0/1                                     |
| test/queues/cli.int.spec.ts                                           | 2/0/0             | -                      | 2/0/0                                      |
| test/queues/int.spec.ts                                               | 84/0/3            | -                      | 84/0/3                                     |
| test/queues/postgres-logs.int.spec.ts                                 | 0/0/2             | -                      | 0/0/2                                      |
| test/queues/schedules-autocron.int.spec.ts                            | 1/0/0             | -                      | 0/1/0 **1 diff**, solo rerun clean 1/0/0   |
| test/queues/schedules.int.spec.ts                                     | 13/0/0            | -                      | 13/0/0                                     |
| test/relationships/int.spec.ts                                        | 74/0/0            | -                      | 74/0/0                                     |
| test/sdk/int.spec.ts                                                  | 39/0/0            | -                      | 39/0/0                                     |
| test/select/graphql-select.int.spec.ts                                | 4/0/0             | -                      | 4/0/0                                      |
| test/select/int.spec.ts                                               | 115/0/0           | -                      | 115/0/0                                    |
| test/select/postgreslogs.int.spec.ts                                  | 0/0/2             | -                      | 0/0/2                                      |
| test/sizes-to-variants/int.spec.ts                                    | 8/0/15            | -                      | 8/0/15                                     |
| test/sort/int.spec.ts                                                 | 44/0/0            | -                      | 44/0/0                                     |
| test/storage-azure/client-uploads/int.spec.ts                         | 0/13/0            | -                      | 0/13/0                                     |
| test/storage-azure/int.spec.ts                                        | 0/0/7             | -                      | 0/0/7 LOAD                                 |
| test/storage-azure/publicAccess.int.spec.ts                           | 0/2/0             | -                      | 0/2/0                                      |
| test/storage-azure/streamingUploads.int.spec.ts                       | 0/4/0             | -                      | 0/4/0                                      |
| test/storage-gcs/int.spec.ts                                          | 0/0/6             | -                      | 0/0/6 LOAD                                 |
| test/storage-s3/client-uploads/int.spec.ts                            | 0/25/0            | -                      | 0/25/0                                     |
| test/storage-s3/int.spec.ts                                           | 0/18/1            | -                      | 0/18/1                                     |
| test/storage-s3/searchBeforeS3.int.spec.ts                            | 0/3/0             | -                      | 0/3/0                                      |
| test/storage-vercel-blob/client-uploads/compositePrefixes.int.spec.ts | 0/1/0             | -                      | 0/1/0                                      |
| test/storage-vercel-blob/client-uploads/int.spec.ts                   | 0/4/2             | -                      | 0/4/2                                      |
| test/storage-vercel-blob/int.spec.ts                                  | 0/15/1            | -                      | 0/15/1                                     |
| test/tags/int.spec.ts                                                 | 9/0/0             | -                      | 9/0/0                                      |
| test/trash/int.spec.ts                                                | 100/2/5           | 102/0/5 **2 diff**     | 102/0/5                                    |
| test/types/int.spec.ts                                                | 2/0/0             | -                      | 2/0/0                                      |
| test/upload-transformers/int.spec.ts                                  | 37/0/0            | -                      | 37/0/0                                     |
| test/uploads/int.spec.ts                                              | 151/4/0           | -                      | 151/4/0                                    |
| test/uuid-v7/int.spec.ts                                              | 0/0/6             | -                      | 0/0/6                                      |
| test/validate/int.spec.ts                                             | 112/0/0           | -                      | 112/0/0                                    |
| test/versions/int.spec.ts                                             | 153/0/0           | -                      | 153/0/0                                    |

- TS recheck 11-16: {"differences":4,"divergences":0,"engineCalls":0,"failed":0,"files":2,"nativeCalls":0,"noNativeProof":0,"passed":226,"shadowCalls":0,"skipped":5}
  - test/lexical/lexical.int.spec.ts: failed -> passed: Lexical basic should reject a REST update with a nonnumeric list item value
  - test/lexical/lexical.int.spec.ts: failed -> passed: Lexical basic should allow querying on lexical content
  - test/trash/int.spec.ts: failed -> passed: trash REST API update endpoint should update only normal document when trash: false
  - test/trash/int.spec.ts: failed -> passed: trash REST API update endpoint should update all documents including soft-deleted documents when trash: true
- engine rs 11-16: {"differences":4,"divergences":0,"engineCalls":51036,"failed":168,"files":135,"nativeCalls":51036,"noNativeProof":0,"passed":3274,"shadowCalls":0,"skipped":469}
  - test/cli/int.spec.ts: first run differed, solo rerun matches the baseline (below: first run)
  - test/cli/int.spec.ts: passed -> failed: CLI generate:types --json (Error: promise resolved "undefined" instead of rejecting)
  - test/cli/int.spec.ts: passed -> failed: CLI updateDocument --slug media --id <seeded-media-id> --data '{"title":"Updated media"}' --file <repo>/test/uploads/image.png (Error: Command failed with exit code 1: /Users/tmx/.nvm/versions/node/v24.22.1/bin/node --import tsx <repo>/test/__helpers/shared/runPa)
  - test/cli/int.spec.ts: passed -> failed: CLI updateDocument --slug media --id <seeded-media-id> --data '{"title":"External media"}' --file <external-url-json> (Error: Command failed with exit code 1: /Users/tmx/.nvm/versions/node/v24.22.1/bin/node --import tsx <repo>/test/__helpers/shared/runPa)
  - test/create-payload-app/int.spec.ts: load error FAIL |int| test/create-payload-app/int.spec.ts > create-payload-app Error: Hook timed out in 90000ms. If this is a long-running hook, pass a timeout value as t
  - test/plugin-import-export/int.spec.ts: load error FAIL |int| test/plugin-import-export/int.spec.ts > @payloadcms/plugin-import-export Error: connect ECONNREFUSED ::1:4566 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
  - test/queues/schedules-autocron.int.spec.ts: first run differed, solo rerun matches the baseline (below: first run)
  - test/queues/schedules-autocron.int.spec.ts: passed -> failed: Queues - scheduling, with automatic scheduling handling can auto-schedule through automatic crons and autorun jobs (AssertionError: expected 1 to be greater than or equal to 2)
  - test/storage-azure/int.spec.ts: load error FAIL |int| test/storage-azure/int.spec.ts > @payloadcms/storage-azure RestError: bad gateway ❯ handleErrorResponse node_modules/.pnpm/@azure+core-client@1.11
  - test/storage-gcs/int.spec.ts: load error FAIL |int| test/storage-gcs/int.spec.ts > @payloadcms/storage-gcs Error: Multiple errors occurred during the request. Please see the `errors` array for complet

### mongodb native shadow, phase-J harness (11-16)

| file                                                                  | TS baseline p/f/s | shadow ts-vs-ts 11-16 p/f/s            | shadow serial rs 11-16 p/f/s           |
| --------------------------------------------------------------------- | ----------------- | -------------------------------------- | -------------------------------------- |
| test/__helpers/int/configImport.int.spec.ts                           | 1/0/0             | 1/0/0                                  | 1/0/0                                  |
| test/__helpers/shared/getTestSuiteDir.int.spec.ts                     | 4/0/0             | 4/0/0                                  | 4/0/0                                  |
| test/_community/int.spec.ts                                           | 2/0/0             | 2/0/0 (30 calls, 0 div)                | 2/0/0 (30 calls, 0 div)                |
| test/access-control/int.spec.ts                                       | 84/0/0            | 84/0/0 (1679 calls, 0 div)             | 84/0/0 (1679 calls, 0 div)             |
| test/access-control/postgres-logs.int.spec.ts                         | 0/0/6             | 0/0/6                                  | 0/0/6                                  |
| test/admin-root/int.spec.ts                                           | 2/0/0             | 2/0/0 (34 calls, 0 div)                | 2/0/0 (34 calls, 0 div)                |
| test/admin-routing/int.spec.ts                                        | 3/0/0             | 3/0/0                                  | 3/0/0                                  |
| test/array-update/int.spec.ts                                         | 5/0/0             | 5/0/0 (68 calls, 0 div)                | 5/0/0 (68 calls, 0 div)                |
| test/auth-api-key/int.spec.ts                                         | 11/0/0            | 11/0/0 (206 calls, 0 div)              | 11/0/0 (206 calls, 0 div)              |
| test/auth/api-key/int.spec.ts                                         | 11/0/0            | 11/0/0 (152 calls, 0 div)              | 11/0/0 (152 calls, 0 div)              |
| test/auth/custom-strategy/int.spec.ts                                 | 1/0/0             | 1/0/0 (9 calls, 0 div)                 | 1/0/0 (9 calls, 0 div)                 |
| test/auth/first-user/int.spec.ts                                      | 1/0/0             | 1/0/0 (20 calls, 0 div)                | 1/0/0 (20 calls, 0 div)                |
| test/auth/forgot-password-localized/int.spec.ts                       | 2/0/0             | 2/0/0 (43 calls, 0 div)                | 2/0/0 (43 calls, 0 div)                |
| test/auth/int.spec.ts                                                 | 116/0/1           | 116/0/1 (1596 calls, 0 div)            | 116/0/1 (1576 calls, 0 div)            |
| test/auth/jwt/int.spec.ts                                             | 3/0/0             | 3/0/0 (106 calls, 0 div)               | 3/0/0 (106 calls, 0 div)               |
| test/auth/removed-token/int.spec.ts                                   | 5/0/0             | 5/0/0 (109 calls, 0 div)               | 5/0/0 (109 calls, 0 div)               |
| test/authorship/int.spec.ts                                           | 32/0/0            | 32/0/0 (547 calls, 0 div)              | 32/0/0 (547 calls, 0 div)              |
| test/authorship/single-auth.int.spec.ts                               | 5/0/0             | 5/0/0 (100 calls, 0 div)               | 5/0/0 (100 calls, 0 div)               |
| test/base-access/int.spec.ts                                          | 7/0/0             | 7/0/0 (22 calls, 0 div)                | 7/0/0 (22 calls, 0 div)                |
| test/cli/int.spec.ts                                                  | 73/0/3            | 73/0/3 (403 calls, 0 div)              | 73/0/3 (403 calls, 0 div)              |
| test/collections-graphql/int.spec.ts                                  | 50/0/0            | 50/0/0 (807 calls, 0 div)              | 50/0/0 (807 calls, 0 div)              |
| test/collections-rest/bulk-delete-rollback.int.spec.ts                | 1/0/0             | 1/0/0 (49 calls, 0 div)                | 1/0/0 (49 calls, 0 div)                |
| test/collections-rest/int.spec.ts                                     | 128/0/2           | 128/0/2 (2878 calls, 0 div)            | 128/0/2 (2878 calls, 0 div)            |
| test/collections-rest/tanstack-server-adapter.int.spec.ts             | 1/0/0             | 1/0/0 (38 calls, 0 div)                | 1/0/0 (38 calls, 0 div)                |
| test/config/int.spec.ts                                               | 12/0/1            | 12/0/1 (22 calls, 0 div)               | 12/0/1 (22 calls, 0 div)               |
| test/create-payload-app/int.spec.ts                                   | 4/7/0             | 0/0/11 **11 diff** LOAD                | 0/0/11 **11 diff** LOAD                |
| test/custom-graphql/int.spec.ts                                       | 2/0/0             | 2/0/0 (17 calls, 0 div)                | 2/0/0 (17 calls, 0 div)                |
| test/dashboard/documents.int.spec.ts                                  | 11/0/0            | 11/0/0 (2342 calls, 0 div)             | 11/0/0 (2348 calls, 0 div)             |
| test/dashboard/int.spec.ts                                            | 3/0/0             | 3/0/0                                  | 3/0/0                                  |
| test/dashboard/pins.int.spec.ts                                       | 4/0/0             | 4/0/0 (2016 calls, 0 div)              | 4/0/0 (2010 calls, 0 div)              |
| test/dashboard/thumbnails.int.spec.ts                                 | 3/0/0             | 3/0/0 (2104 calls, 0 div)              | 3/0/0 (2113 calls, 0 div)              |
| test/database/batch-processing.int.spec.ts                            | 4/0/0             | 4/0/0 (35 calls, 0 div)                | 4/0/0 (35 calls, 0 div)                |
| test/database/copy.int.spec.ts                                        | 5/0/0             | 5/0/0 (31 calls, 0 div)                | 5/0/0 (31 calls, 0 div)                |
| test/database/int.spec.ts                                             | 164/0/17          | 164/0/17 (3490 calls, 0 div)           | 164/0/17 (3524 calls, 0 div)           |
| test/database/migrate-to-blocks-as-json/int.spec.ts                   | 0/0/1             | 0/0/1                                  | 0/0/1 (0 calls, 0 div)                 |
| test/database/migrations-cli.int.spec.ts                              | 3/0/0             | 3/0/0 (13 calls, 0 div)                | 3/0/0 (13 calls, 0 div)                |
| test/database/pg-replica/int.spec.ts                                  | 0/0/16            | 0/0/16                                 | 0/0/16                                 |
| test/database/postgres-logs.int.spec.ts                               | 0/0/6             | 0/0/6                                  | 0/0/6                                  |
| test/database/postgres-operator-handlers.int.spec.ts                  | 0/0/29            | 0/0/29                                 | 0/0/29                                 |
| test/database/postgres-relationships-v2-v3-migration/int.spec.ts      | 0/0/1             | 0/0/1                                  | 0/0/1                                  |
| test/database/postgres-vector.int.spec.ts                             | 0/0/4             | 0/0/4                                  | 0/0/4                                  |
| test/database/sqlite-bound-parameters-limit.int.spec.ts               | 0/0/4             | 0/0/4                                  | 0/0/4                                  |
| test/database/up-down-migration/int.spec.ts                           | 0/0/1             | 0/0/1                                  | 0/0/1                                  |
| test/dataloader/int.spec.ts                                           | 4/0/0             | 4/0/0 (565 calls, 0 div)               | 4/0/0 (565 calls, 0 div)               |
| test/email-nodemailer/int.spec.ts                                     | 2/0/0             | 2/0/0 (7 calls, 0 div)                 | 2/0/0 (7 calls, 0 div)                 |
| test/endpoints/int.spec.ts                                            | 10/0/0            | 10/0/0 (17 calls, 0 div)               | 10/0/0 (17 calls, 0 div)               |
| test/endpoints/tanstack.int.spec.ts                                   | 1/0/0             | 1/0/0 (9 calls, 0 div)                 | 1/0/0 (9 calls, 0 div)                 |
| test/field-access-context/int.spec.ts                                 | 11/0/0            | 11/0/0 (178 calls, 0 div)              | 11/0/0 (178 calls, 0 div)              |
| test/field-paths/int.spec.ts                                          | 2/0/0             | 2/0/0 (18 calls, 0 div)                | 2/0/0 (18 calls, 0 div)                |
| test/fields-relationship/int.spec.ts                                  | 4/0/0             | 4/0/0 (376 calls, 0 div)               | 4/0/0 (376 calls, 0 div)               |
| test/fields/graphql-select.int.spec.ts                                | 1/0/0             | 1/0/0 (154 calls, 0 div)               | 1/0/0 (154 calls, 0 div)               |
| test/fields/int.spec.ts                                               | 233/0/1           | 233/0/1 (4584 calls, 0 div)            | 233/0/1 (4584 calls, 0 div)            |
| test/file-versioning/fileOperationManager.int.spec.ts                 | 1/0/0             | 1/0/0 (18 calls, 0 div)                | 1/0/0 (18 calls, 0 div)                |
| test/file-versioning/int.spec.ts                                      | 56/0/2            | 56/0/2 (2804 calls, 0 div)             | 56/0/2 (2804 calls, 0 div)             |
| test/file-versioning/rename.int.spec.ts                               | 14/0/0            | 14/0/0 (314 calls, 0 div)              | 14/0/0 (314 calls, 0 div)              |
| test/folders/int.spec.ts                                              | 6/0/0             | 6/0/0 (287 calls, 0 div)               | 6/0/0 (287 calls, 0 div)               |
| test/form-state/int.spec.ts                                           | 27/0/0            | 27/0/0 (94 calls, 0 div)               | 27/0/0 (94 calls, 0 div)               |
| test/globals/int.spec.ts                                              | 13/0/0            | 13/0/0 (87 calls, 0 div)               | 13/0/0 (87 calls, 0 div)               |
| test/graphql/hidden-fields.int.spec.ts                                | 11/0/0            | 11/0/0 (116 calls, 0 div)              | 11/0/0 (116 calls, 0 div)              |
| test/graphql/int.spec.ts                                              | 9/0/0             | 9/0/0 (87 calls, 0 div)                | 9/0/0 (87 calls, 0 div)                |
| test/hierarchy/collection-specific.int.spec.ts                        | 14/0/0            | 14/0/0 (301 calls, 0 div)              | 14/0/0 (301 calls, 0 div)              |
| test/hierarchy/int.spec.ts                                            | 36/0/0            | 36/0/0 (2089 calls, 0 div)             | 36/0/0 (2089 calls, 0 div)             |
| test/hmr/int.spec.ts                                                  | 2/0/2             | 0/0/4 **2 diff** LOAD                  | 0/0/4 **2 diff** LOAD                  |
| test/hooks/int.spec.ts                                                | 45/0/0            | 45/0/0 (426 calls, 0 div)              | 45/0/0 (426 calls, 0 div)              |
| test/joins/buildJoinAggregation.int.spec.ts                           | 8/0/0             | 8/0/0 (2 calls, 0 div)                 | 8/0/0 (2 calls, 0 div)                 |
| test/joins/hierarchy.int.spec.ts                                      | 0/0/2             | 0/0/2                                  | 0/0/2                                  |
| test/joins/int.spec.ts                                                | 79/0/44           | 79/0/44 (1046 calls, 0 div)            | 79/0/44 (1046 calls, 0 div)            |
| test/joins/queryPath.int.spec.ts                                      | 4/0/0             | 4/0/0 (42 calls, 0 div)                | 4/0/0 (42 calls, 0 div)                |
| test/joins/whereMutation.int.spec.ts                                  | 1/0/0             | 1/0/0 (149 calls, 0 div)               | 1/0/0 (149 calls, 0 div)               |
| test/kv/int.spec.ts                                                   | 3/1/0             | 3/1/0 (22 calls, 0 div)                | 3/1/0 (22 calls, 0 div)                |
| test/lexical-mdx/int.spec.ts                                          | 89/0/0            | 89/0/0                                 | 89/0/0 (0 calls, 0 div)                |
| test/lexical/lexical.int.spec.ts                                      | 124/0/0           | 124/0/0 (1460 calls, 0 div)            | 124/0/0 (1460 calls, 0 div)            |
| test/live-preview/int.spec.ts                                         | 18/0/0            | 18/0/0 (287 calls, 0 div)              | 18/0/0 (287 calls, 0 div)              |
| test/llm-instructions/access.int.spec.ts                              | 12/0/0            | 12/0/0 (175 calls, 0 div)              | 12/0/0 (175 calls, 0 div)              |
| test/llm-instructions/cli.int.spec.ts                                 | 11/0/0            | 11/0/0 (180 calls, 0 div)              | 11/0/0 (180 calls, 0 div)              |
| test/llm-instructions/int.spec.ts                                     | 36/0/0            | 36/0/0 (381 calls, 0 div)              | 36/0/0 (381 calls, 0 div)              |
| test/llm-instructions/slots.int.spec.ts                               | 5/0/0             | 5/0/0 (86 calls, 0 div)                | 5/0/0 (86 calls, 0 div)                |
| test/loader/int.spec.ts                                               | 4/0/0             | 4/0/0                                  | 4/0/0                                  |
| test/localization/int.spec.ts                                         | 159/0/0           | 159/0/0 (1915 calls, 0 div)            | 159/0/0 (1915 calls, 0 div)            |
| test/localization/localizeStatus.int.spec.ts                          | 2/0/9             | 2/0/9 (15 calls, 0 div)                | 2/0/9 (15 calls, 0 div)                |
| test/locked-documents/bulk-delete.int.spec.ts                         | 1/0/0             | 1/0/0 (65 calls, 0 div)                | 1/0/0 (65 calls, 0 div)                |
| test/locked-documents/int.spec.ts                                     | 13/0/0            | 13/0/0 (226 calls, 0 div)              | 13/0/0 (226 calls, 0 div)              |
| test/login-with-username/int.spec.ts                                  | 4/0/0             | 4/0/0 (52 calls, 0 div)                | 4/0/0 (52 calls, 0 div)                |
| test/mongodb-schema-build-cache/int.spec.ts                           | 7/0/0             | 7/0/0 (76 calls, 0 div)                | 7/0/0 (76 calls, 0 div)                |
| test/payload-cloud/int.spec.ts                                        | 4/0/1             | 4/0/1 (60 calls, 0 div)                | 4/0/1 (60 calls, 0 div)                |
| test/plugin-cloud-storage/int.compositePrefixes.int.spec.ts           | 0/0/2             | 0/0/2                                  | 0/0/2                                  |
| test/plugin-cloud-storage/int.spec.ts                                 | 33/3/13           | 33/3/13 (319 calls, 0 div)             | 33/3/13 (319 calls, 0 div)             |
| test/plugin-cloud-storage/versioning.int.spec.ts                      | 46/0/3            | 46/0/3 (1199 calls, 0 div)             | 46/0/3 (1199 calls, 0 div)             |
| test/plugin-ecommerce/int.spec.ts                                     | 36/0/0            | 36/0/0 (923 calls, 0 div)              | 36/0/0 (924 calls, 0 div)              |
| test/plugin-form-builder/int.spec.ts                                  | 55/0/0            | 55/0/0 (938 calls, 0 div)              | 55/0/0 (938 calls, 0 div)              |
| test/plugin-import-export/field-hooks.int.spec.ts                     | 0/29/0            | 0/29/0 (3 calls, 0 div)                | 0/29/0 (3 calls, 0 div)                |
| test/plugin-import-export/hooks.int.spec.ts                           | 0/42/0            | 0/42/0 (3 calls, 0 div)                | 0/42/0 (3 calls, 0 div)                |
| test/plugin-import-export/int.spec.ts                                 | 0/0/198           | 0/0/198 LOAD (3 calls, 0 div)          | 0/0/198 LOAD (3 calls, 0 div)          |
| test/plugin-mcp/instructions.int.spec.ts                              | 10/0/0            | 10/0/0 (424 calls, 0 div)              | 10/0/0 (424 calls, 0 div)              |
| test/plugin-mcp/int.spec.ts                                           | 237/0/1           | 237/0/1 (4304 calls, 0 div)            | 237/0/1 (4304 calls, 0 div)            |
| test/plugin-multi-tenant/int.spec.ts                                  | 21/0/0            | 21/0/0 (1225 calls, 0 div)             | 21/0/0 (1225 calls, 0 div)             |
| test/plugin-nested-docs/int.spec.ts                                   | 12/0/0            | 12/0/0 (863 calls, 0 div)              | 12/0/0 (863 calls, 0 div)              |
| test/plugin-redirects/int.spec.ts                                     | 3/0/0             | 3/0/0 (38 calls, 0 div)                | 3/0/0 (38 calls, 0 div)                |
| test/plugin-search/int.spec.ts                                        | 21/0/0            | 21/0/0 (1003 calls, 0 div)             | 21/0/0 (1003 calls, 0 div)             |
| test/plugin-sentry/int.spec.ts                                        | 0/0/1             | 0/0/1                                  | 0/0/1                                  |
| test/plugin-seo/int.spec.ts                                           | 21/0/0            | 21/0/0 (776 calls, 0 div)              | 21/0/0 (776 calls, 0 div)              |
| test/plugin-stripe/int.spec.ts                                        | 7/0/3             | 7/0/3 (66 calls, 0 div)                | 7/0/3 (66 calls, 0 div)                |
| test/plugins/int.spec.ts                                              | 6/0/0             | 6/0/0 (10 calls, 0 div)                | 6/0/0 (10 calls, 0 div)                |
| test/query-presets/int.spec.ts                                        | 13/0/1            | 13/0/1 (292 calls, 0 div)              | 13/0/1 (292 calls, 0 div)              |
| test/queues/cli.int.spec.ts                                           | 2/0/0             | 2/0/0 (35 calls, 0 div)                | 2/0/0 (38 calls, 0 div)                |
| test/queues/int.spec.ts                                               | 84/0/3            | 84/0/3 (3552 calls, 0 div)             | 84/0/3 (3560 calls, 0 div)             |
| test/queues/postgres-logs.int.spec.ts                                 | 0/0/2             | 0/0/2                                  | 0/0/2                                  |
| test/queues/schedules-autocron.int.spec.ts                            | 1/0/0             | 1/0/0 (46 calls, 0 div)                | 1/0/0 (42 calls, 0 div)                |
| test/queues/schedules.int.spec.ts                                     | 13/0/0            | 13/0/0 (443 calls, 0 div)              | 13/0/0 (435 calls, 0 div)              |
| test/relationships/int.spec.ts                                        | 74/0/0            | 74/0/0 (3823 calls, 0 div)             | 74/0/0 (3823 calls, 0 div)             |
| test/sdk/int.spec.ts                                                  | 39/0/0            | 39/0/0 (560 calls, 0 div)              | 39/0/0 (560 calls, 0 div)              |
| test/select/graphql-select.int.spec.ts                                | 4/0/0             | 4/0/0 (69 calls, 0 div)                | 4/0/0 (69 calls, 0 div)                |
| test/select/int.spec.ts                                               | 115/0/0           | 115/0/0 (426 calls, 0 div)             | 115/0/0 (426 calls, 0 div)             |
| test/select/postgreslogs.int.spec.ts                                  | 0/0/2             | 0/0/2                                  | 0/0/2                                  |
| test/sizes-to-variants/int.spec.ts                                    | 8/0/15            | 8/0/15 (72 calls, 0 div)               | 8/0/15 (72 calls, 0 div)               |
| test/sort/int.spec.ts                                                 | 44/0/0            | 44/0/0 (835 calls, 0 div)              | 44/0/0 (835 calls, 0 div)              |
| test/storage-azure/client-uploads/int.spec.ts                         | 0/13/0            | 0/13/0 (2 calls, 0 div)                | 0/13/0 (2 calls, 0 div)                |
| test/storage-azure/int.spec.ts                                        | 0/0/7             | 0/0/7 LOAD (2 calls, 0 div)            | 0/0/7 LOAD (2 calls, 0 div)            |
| test/storage-azure/publicAccess.int.spec.ts                           | 0/2/0             | 0/2/0 (2 calls, 0 div)                 | 0/2/0 (2 calls, 0 div)                 |
| test/storage-azure/streamingUploads.int.spec.ts                       | 0/4/0             | 0/4/0                                  | 0/4/0 (0 calls, 0 div)                 |
| test/storage-gcs/int.spec.ts                                          | 0/0/6             | 0/0/6 LOAD (7 calls, 0 div)            | 0/0/6 LOAD (7 calls, 0 div)            |
| test/storage-s3/client-uploads/int.spec.ts                            | 0/25/0            | 0/25/0 (7 calls, 0 div)                | 0/25/0 (7 calls, 0 div)                |
| test/storage-s3/int.spec.ts                                           | 0/18/1            | 0/18/1                                 | 0/18/1 (0 calls, 0 div)                |
| test/storage-s3/searchBeforeS3.int.spec.ts                            | 0/3/0             | 0/3/0 (31 calls, 0 div)                | 0/3/0 (31 calls, 0 div)                |
| test/storage-vercel-blob/client-uploads/compositePrefixes.int.spec.ts | 0/1/0             | 0/1/0 (11 calls, 0 div)                | 0/1/0 (11 calls, 0 div)                |
| test/storage-vercel-blob/client-uploads/int.spec.ts                   | 0/6/0             | 0/6/0 (27 calls, 0 div)                | 0/6/0 (27 calls, 0 div)                |
| test/storage-vercel-blob/int.spec.ts                                  | 0/16/0            | 0/16/0 (7 calls, 0 div)                | 0/16/0 (7 calls, 0 div)                |
| test/tags/int.spec.ts                                                 | 9/0/0             | 9/0/0 (149 calls, 0 div)               | 9/0/0 (149 calls, 0 div)               |
| test/trash/int.spec.ts                                                | 102/0/5           | 102/0/5 (4259 calls, 0 div)            | 102/0/5 (4259 calls, 0 div)            |
| test/types/int.spec.ts                                                | 2/0/0             | 2/0/0                                  | 2/0/0                                  |
| test/upload-transformers/int.spec.ts                                  | 37/0/0            | 37/0/0 (434 calls, 0 div)              | 37/0/0 (434 calls, 0 div)              |
| test/uploads/int.spec.ts                                              | 155/0/0           | 151/4/0 **4 diff** (2757 calls, 0 div) | 151/4/0 **4 diff** (2757 calls, 0 div) |
| test/uuid-v7/int.spec.ts                                              | 0/0/6             | 0/0/6                                  | 0/0/6                                  |
| test/validate/int.spec.ts                                             | 112/0/0           | 112/0/0 (948 calls, 0 div)             | 112/0/0 (948 calls, 0 div)             |
| test/versions/int.spec.ts                                             | 153/0/0           | 153/0/0 (8193 calls, 0 div)            | 153/0/0 (8193 calls, 0 div)            |

- shadow ts-vs-ts 11-16: {"differences":17,"divergences":0,"engineCalls":0,"failed":167,"files":135,"nativeCalls":0,"noNativeProof":0,"passed":3314,"shadowCalls":76822,"skipped":435}
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app --init-next with srcDir should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with srcDir should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app --init-next with noSrcDir should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with noSrcDir should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app --init-next with srcDirCanary should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with srcDirCanary should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app --init-next with noSrcDirCanary should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with noSrcDirCanary should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app official TanStack generator should initialize and build a generated TanStack Start project
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app official TanStack generator should initialize and build a generated TanStack Router-only project
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app adapter replacement should replace mongodb with postgres adapter
  - test/create-payload-app/int.spec.ts: load error FAIL |int| test/create-payload-app/int.spec.ts > create-payload-app Error: Command failed with exit code 1: pnpm run script:pack --all --no-build --dest /priva
  - test/hmr/int.spec.ts: passed -> skipped: Dev config reload tanstack-start should serve the updated config before an admin request
  - test/hmr/int.spec.ts: passed -> skipped: Dev config reload tanstack-start should serve the updated config when it changes right after a server reload
  - test/hmr/int.spec.ts: load error FAIL |int| test/hmr/int.spec.ts > Dev config reload > next Error: next dev server did not start: Error: ERR_PNPM_BAD_CONFIG_DEP
  - test/plugin-import-export/int.spec.ts: load error FAIL |int| test/plugin-import-export/int.spec.ts > @payloadcms/plugin-import-export Error: connect ECONNREFUSED ::1:4566 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
  - test/storage-azure/int.spec.ts: load error FAIL |int| test/storage-azure/int.spec.ts > @payloadcms/storage-azure RestError: bad gateway ❯ handleErrorResponse node_modules/.pnpm/@azure+core-client@1.11
  - test/storage-gcs/int.spec.ts: load error FAIL |int| test/storage-gcs/int.spec.ts > @payloadcms/storage-gcs Error: Multiple errors occurred during the request. Please see the `errors` array for complet
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should resolve relative URLs against the configured server origin (TypeError: fetch failed)
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should apply request origin policy to relative URLs (TypeError: fetch failed)
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should filter authentication cookies after a cross-origin redirect (TypeError: fetch failed)
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should provide each request destination to the external file header filter (TypeError: fetch failed)
- shadow serial rs 11-16: {"differences":17,"divergences":0,"engineCalls":51289,"failed":167,"files":135,"nativeCalls":51289,"noNativeProof":0,"passed":3314,"shadowCalls":76845,"skipped":435}
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app --init-next with srcDir should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with srcDir should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app --init-next with noSrcDir should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with noSrcDir should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app --init-next with srcDirCanary should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with srcDirCanary should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app --init-next with noSrcDirCanary should install payload app in Next.js project
  - test/create-payload-app/int.spec.ts: passed -> skipped: create-payload-app --init-next with noSrcDirCanary should install payload app with postgres adapter
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app official TanStack generator should initialize and build a generated TanStack Start project
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app official TanStack generator should initialize and build a generated TanStack Router-only project
  - test/create-payload-app/int.spec.ts: failed -> skipped: create-payload-app adapter replacement should replace mongodb with postgres adapter
  - test/create-payload-app/int.spec.ts: load error FAIL |int| test/create-payload-app/int.spec.ts > create-payload-app Error: Command failed with exit code 1: pnpm run script:pack --all --no-build --dest /priva
  - test/hmr/int.spec.ts: passed -> skipped: Dev config reload tanstack-start should serve the updated config before an admin request
  - test/hmr/int.spec.ts: passed -> skipped: Dev config reload tanstack-start should serve the updated config when it changes right after a server reload
  - test/hmr/int.spec.ts: load error FAIL |int| test/hmr/int.spec.ts > Dev config reload > next Error: next dev server did not start: Error: ERR_PNPM_BAD_CONFIG_DEP
  - test/plugin-import-export/int.spec.ts: load error FAIL |int| test/plugin-import-export/int.spec.ts > @payloadcms/plugin-import-export Error: connect ECONNREFUSED ::1:4566 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
  - test/storage-azure/int.spec.ts: load error FAIL |int| test/storage-azure/int.spec.ts > @payloadcms/storage-azure RestError: bad gateway ❯ handleErrorResponse node_modules/.pnpm/@azure+core-client@1.11
  - test/storage-gcs/int.spec.ts: load error FAIL |int| test/storage-gcs/int.spec.ts > @payloadcms/storage-gcs Error: Multiple errors occurred during the request. Please see the `errors` array for complet
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should resolve relative URLs against the configured server origin (TypeError: fetch failed)
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should apply request origin policy to relative URLs (TypeError: fetch failed)
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should filter authentication cookies after a cross-origin redirect (TypeError: fetch failed)
  - test/uploads/int.spec.ts: passed -> failed: Collections - Uploads Local API cookie filtering should provide each request destination to the external file header filter (TypeError: fetch failed)

## Review items (`.rs-baseline/review-mongo-joins-engine-glue-sol.md`)

| item                                                                                                              | fix                                                                                                                                                                                                                                                                                                                                                                                                                   | test                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| glue 1 static import                                                                                              | defaultpath (lazy import)                                                                                                                                                                                                                                                                                                                                                                                             | - (see hmr gap)                                                                                                                 |
| glue 2-7 (copied args, eager `toObject`, single clock, model at op time, eager error reads, partial localization) | stage-1 glue is off the production path: the live ports run on the caller's objects (livereads / livewrites / livetransform / livequery / livejoins own the behaviour)                                                                                                                                                                                                                                                | their live differentials; here: live.int.spec (installed natively, no copy), shadow (argument mutations, clock counts)          |
| 8 stats env var, loopback                                                                                         | per-process stats dir, native proof per file, loopback rejected                                                                                                                                                                                                                                                                                                                                                       | runnerLib.test `readEngineStats`; runner `nativeProof`                                                                          |
| 9 child-process loader on a clean checkout                                                                        | resolve decided before `nextResolve`                                                                                                                                                                                                                                                                                                                                                                                  | runnerLib.test (hook + real child process)                                                                                      |
| 10 per-test map by full name                                                                                      | full name + occurrence index                                                                                                                                                                                                                                                                                                                                                                                          | runnerLib.test `testsOf`                                                                                                        |
| 11 argument mutations                                                                                             | `$args` compared after each pair                                                                                                                                                                                                                                                                                                                                                                                      | shadow.int.spec `detects argument mutations`                                                                                    |
| 12 normalisation                                                                                                  | typed values never equal `{ $oid }`-like user data, no SQL alias rule, data-method stamps identical (window rule only for lifecycle pairs: Dates, their ISO strings, ObjectId time bytes), clock / uuid / ObjectId readings counted per pair AND ordered against driver operations; phase J: functions, -0, error own props / cause / prototype, prototypes, sessions per transaction, lifecycle results now compared | shadow.int.spec `never equates ...`, `timestamp rule ...`, `ObjectId time bytes ...`, `extra and missing clock readings`        |
| phase J harness gaps (argument identity, mutation timing vs awaits, clock order, call order)                      | shadow: `$arg` identity labels, `$firstAwait`, `$events` (trace.ts); parity: `golden/trace` (adapterTrace.ts)                                                                                                                                                                                                                                                                                                         | shadow.int.spec `detects argument identity, mutation timing and driver call order ...`; parity mutants `RS_PARITY_TRACE_MUTANT` |
| 13 concurrency                                                                                                    | `--shadow-mode concurrent` + oracle + documented races                                                                                                                                                                                                                                                                                                                                                                | shadow.int.spec concurrent cases; full concurrent run                                                                           |
| 14 vacuous goldens                                                                                                | `live` section re-recorded from TS, `live > non-empty` asserts every step returns documents (update many: > 2)                                                                                                                                                                                                                                                                                                        | parity.int.spec                                                                                                                 |

## Known gaps

- test/hmr with `PAYLOAD_ENGINE=rs` (Next dev server cannot resolve `@payloadcms/engine-rs`), see above.
- Harness blind spots that remain (not exemptions backed by TS-vs-TS evidence, but limits):
  error `stack` is not compared (it names the shadow's own frames, which differ between the
  halves; Rust frames would differ too); property descriptors / non-enumerable and symbol keys are
  not compared; under `vi.useFakeTimers()` the shadow neither replays nor counts clock readings;
  only the driver `Collection` layer is traced (not mongoose `Model` / `Query` calls, promise
  species or getter reads on arguments: those stay with the per-crate live differentials); the
  parity trace sorts groups of concurrently started adapter calls by content (their start order
  differed between two TS recordings) and identity is checked only for objects reachable from
  the arguments outside `req`.
- Environment on 11-16: pnpm registry mirror down (create-payload-app, hmr), localstack / Azurite /
  GCS emulator / Redis down, external fetch in uploads cookie-filtering tests fails; all identical
  in TS runs.
