# MongoDB engine status

Owner: mongoadapter (this file, `packages/engine-rs/src/mongo-adapter/**`, `test/__rs/mongo-adapter/**`,
the `PAYLOAD_ENGINE` switch in `packages/db-mongodb/src/index.ts`). Contract:
`MONGO_ENGINE_CONTRACT.md`; interface decisions: `.rs-baseline/mongo-coordination.md`.

## Pieces

| piece                                            | where                                                              | state                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS glue `withRustMongoEngine`                    | `src/mongo-adapter/index.ts`                                       | done: wraps the 24 data methods, engine created after upstream `init`, per-call host object table, mutations applied in place, error rebuild                                                                                                    |
| host executor                                    | `src/mongo-adapter/host.ts`                                        | done: `model` (+ `chain`, `post: toObject`, `fnOptions`), `getSession` (upstream copy, original `req`), `modelInfo`, `adapterCall`, `logError`; resolves `{ok: tree}`, rejects `{error: {handle, isObject, name?, message?, code?, keyValue?}}` |
| typed values                                     | `src/mongo-adapter/codec.ts` + `src/serialize.ts` (`BsonBoundary`) | done: `$oid`, `$regex`, `$decimal`, `$binary {base64, subType}`, `$buffer`, `$hostObject`                                                                                                                                                       |
| errors                                           | `src/mongo-adapter/errors.ts`                                      | done: `rethrow`, `HostError`, `ValidationError` exactly upstream's `{ collection, errors, global }`, `BSONError` with the adapter's bson class, rest via SQLite `rebuildError`                                                                  |
| loopback engine                                  | `src/mongo-adapter/loopback.ts` (`PAYLOAD_RS_MONGO_LOOPBACK=true`) | done: upstream methods on stand-in models, every DB call a host op through the real glue                                                                                                                                                        |
| native `MongoEngine` (napi)                      | `crates/payload-node/src/mongo_engine.rs` (mongoengine)            | in the addon; all 135 files run through it (see Results)                                                                                                                                                                                       |
| mongoose models from the Rust schema description | `src/mongo-schema` (mongoschema)                                   | not wired: upstream `init` builds the models (lead 16:05: keep upstream until review finding 1, init ordering, is fixed)                                                                                                                       |
| `PAYLOAD_ENGINE=rs` switch in db-mongodb         | `packages/db-mongodb/src/index.ts`                                 | done: `PAYLOAD_ENGINE === 'rs'` returns `withRustMongoEngine(adapterObj)`, otherwise the unchanged object; engine-rs `src/index.ts` exports the mongo glue                                                                                    |

## How to run

```sh
# the target configuration: db-mongodb switch + Rust core engine (shared runner)
node test/__rs/mongo-harness/runSuites.mjs --engine rs --addon <payload-engine.node> --jobs 1 \
  --baseline .rs-baseline/mongodb-all.json [files]
# glue alone (TS loopback engine) / native MongoEngine with the TS core, per-test comparison
node test/__rs/mongo-adapter/runSuites.mjs [--native --addon <payload-engine.node>] --jobs 1 \
  --tag <tag> --baseline .rs-baseline/mongodb-all.json [files]
# recompute against a newer baseline without re-running
node test/__rs/mongo-adapter/runSuites.mjs --resummarize --tag <tag> --baseline .rs-baseline/mongodb-all.json
# shadow differential (reference TS adapter vs candidate on a second database)
node test/__rs/mongo-harness/runSuites.mjs --shadow --candidate rs --addon <payload-engine.node> <files>
PAYLOAD_RS_MONGO_LOOPBACK=true node test/__rs/mongo-harness/runSuites.mjs --shadow \
  --candidate test/__rs/mongo-adapter/candidate.ts <files>        # loopback candidate
# per-suite table of this file
node test/__rs/mongo-adapter/statusTable.mjs --baseline .rs-baseline/mongodb-all.json \
  --column 'TS child-process ref'=madts1 --column loopback=madl2,madl3,madl4 --column native=madn1 \
  --column 'engine rs'=madrs1
# codec round trip
node --experimental-strip-types test/__rs/mongo-adapter/codecCheck.mts
```

`test/__rs/mongo-adapter/vitest.config.ts` = mongo-harness config with `databaseAdapter.js` aliased to
`databaseAdapter.ts` (the harness adapter wrapped by `withRustMongoEngine`, imported by path).
Stats: `PAYLOAD_RS_MONGO_ENGINE_STATS_FILE` (calls per method, host ops per op, engines).

## Results

Runs of 2026-11-01 against `.rs-baseline/mongodb-all.json` (TS engine on MongoDB, 127 files,
3130 passed / 165 failed / 414 skipped; the 8 child-process suites were deferred there and have their
own TS reference run `madts1`). Addon: mongoengine's 16:11 build (`/tmp/mongoengine-addon/payload-engine.node`).
Per-file databases, dropped after each file.

| run | config | files | passed / failed / skipped | status differences vs TS |
|---|---|---|---|---|
| `madl2`+`madl3`+`madl4` | loopback engine (glue only), TS core | 127 | 3131 / 164 / 414 | 1 (baseline flake, see below) |
| `madn1` | native `MongoEngine`, TS core | 127 | 3130 / 163 / 416 | 3 (flake + test/hmr) |
| `madrs1` | `--engine rs`: db-mongodb switch + Rust core engine | 135 | 3321 / 170 / 422 | none engine-caused (below) |
| `madts1` | TS reference for the 8 child-process suites + hmr | 9 | 192 / 8 / 8 | `madrs1` equal on all 9 except one TS-side flake |

Engine calls: 47,140 (loopback), 45,981 (native, per-file stats files); `madrs1` stats
(`PAYLOAD_RS_MONGO_ENGINE_STATS_FILE`, last process) show `engines.native: 1` and the calls served
natively. Glue overhead measured on test/dashboard (505 calls): args encoding 15 ms, result decoding
11 ms, host op codec 21 ms in total; the rest is MongoDB time.

Every remaining difference, with root cause and owner:

- test/queues/schedules-autocron `can auto-schedule through automatic crons and autorun jobs`:
  failed in the TS baseline, passes in every Rust run (and in TS reruns per mongobaseline): baseline
  flake (timing under load). Owner: none (mongobaseline to refresh the baseline).
- test/hmr (2 tests passed/failed -> skipped, native and engine rs): `next dev server did not start`
  in `beforeAll` (0 engine calls); environment (dev server under load). The TS reference run
  `madts1` shows the same 2/0/2. Owner: none.
- test/cli `createDocuments --slug pages ...`: failed in TS (`ENOTEMPTY rmdir test/cli/generated`,
  the test's own cleanup race), passed with rs. Owner: none.
- Load errors (all runs, also TS): storage-azure / storage-gcs / storage-s3 / storage-vercel-blob /
  plugin-import-export / plugin-cloud-storage need docker services (Azurite, GCS emulator,
  localstack :4566, ...) that are not running. Owner: none.
- Earlier jobs-4 differences (90 s timeouts at load average ~30, the disk-full window when mongod
  refused connections, a mongod restart during test/lexical) all passed on solo reruns
  (`madl3`, `madl4`) and are not listed in the table.

Shadow differential (`test/__rs/mongo-harness`, reference TS adapter vs candidate on a second
database, results and database state compared per call):
- loopback candidate on hooks / localization / select (`madsh1`): select 0 divergences; hooks and
  localization showed 1 ms `createdAt` / `updatedAt` drift caused by the glue reading `Date.now()`
  for `contextJson.now` (consuming one reading of the shadow's clock tape). Fixed: no clock read in
  loopback mode, and the engine reads the clock through a per-call `clockFunction` bound to the
  caller's async context. localization also showed a `globals` collection index-name race between
  discriminators (upstream `ensureIndexes`, both sides upstream models): not engine-related.
- native candidate: see "Shadow (native)" below.

### Shadow (native)

`madshrs1`: `node test/__rs/mongo-harness/runSuites.mjs --shadow --candidate rs --addon ...` (test
statuses all equal to TS):

| file | shadowed calls | db checks | divergences |
|---|---|---|---|
| test/hooks/int.spec.ts | 426 | 43 | 0 |
| test/localization/int.spec.ts | 1915 | 119 | 0 |
| test/database/int.spec.ts | 3502 | 152 | 2 |
| test/relationships/int.spec.ts | 3824 | 74 | 3 |
| test/select/int.spec.ts | 427 | 26 | 15 |
| test/joins/int.spec.ts | 1047 | 28 | 85 |

Every divergence is the same: the candidate's `updatedAt` is 1 ms earlier than the reference's
(results and stored documents). Root cause: upstream reads the clock several times per call
(`create`: `data.createdAt = new Date()`, then the write transform's `updatedAt`); the engine uses
the one `contextJson.now` the glue reads at call start for all of them. Under the shadow's clock
replay that is the reference's first reading. Fix (owner mongoengine, with mongotransform's `now`
callback): call `callFunction(context.clockFunction, "[]")` exactly where upstream evaluates
`new Date()`; then the glue stops reading the clock for `now` (owner mongoadapter; one line in
`callContextJson`) so the readings line up 1:1. Outside the shadow this is a real 1:1 difference
too: upstream's `createdAt` and `updatedAt` of one `create` can differ by a millisecond, the
engine's never do.

### Per-file table

| file | TS baseline p/f/s | TS child-process ref p/f/s | loopback p/f/s | native p/f/s | engine rs p/f/s |
|---|---|---|---|---|---|
| test/__helpers/int/configImport.int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/__helpers/shared/getTestSuiteDir.int.spec.ts | 4/0/0 | - | 4/0/0 | 4/0/0 | 4/0/0 |
| test/_community/int.spec.ts | 2/0/0 | - | 2/0/0 | 2/0/0 | 2/0/0 |
| test/access-control/int.spec.ts | 84/0/0 | - | 84/0/0 | 84/0/0 | 84/0/0 |
| test/access-control/postgres-logs.int.spec.ts | 0/0/6 | - | 0/0/6 | 0/0/6 | 0/0/6 |
| test/admin-root/int.spec.ts | 2/0/0 | - | 2/0/0 | 2/0/0 | 2/0/0 |
| test/admin-routing/int.spec.ts | 3/0/0 | - | 3/0/0 | 3/0/0 | 3/0/0 |
| test/array-update/int.spec.ts | 5/0/0 | - | 5/0/0 | 5/0/0 | 5/0/0 |
| test/auth-api-key/int.spec.ts | 11/0/0 | - | 11/0/0 | 11/0/0 | 11/0/0 |
| test/auth/api-key/int.spec.ts | 11/0/0 | - | 11/0/0 | 11/0/0 | 11/0/0 |
| test/auth/custom-strategy/int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/auth/first-user/int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/auth/forgot-password-localized/int.spec.ts | 2/0/0 | - | 2/0/0 | 2/0/0 | 2/0/0 |
| test/auth/int.spec.ts | 116/0/1 | - | 116/0/1 | 116/0/1 | 116/0/1 |
| test/auth/jwt/int.spec.ts | 3/0/0 | - | 3/0/0 | 3/0/0 | 3/0/0 |
| test/auth/removed-token/int.spec.ts | 5/0/0 | - | 5/0/0 | 5/0/0 | 5/0/0 |
| test/authorship/int.spec.ts | 32/0/0 | - | 32/0/0 | 32/0/0 | 32/0/0 |
| test/authorship/single-auth.int.spec.ts | 5/0/0 | - | 5/0/0 | 5/0/0 | 5/0/0 |
| test/base-access/int.spec.ts | 7/0/0 | - | 7/0/0 | 7/0/0 | 7/0/0 |
| test/cli/int.spec.ts | 73/0/3 | 72/1/3 | - | - | 73/0/3 **76 diff** |
| test/collections-graphql/int.spec.ts | 50/0/0 | - | 50/0/0 | 50/0/0 | 50/0/0 |
| test/collections-rest/bulk-delete-rollback.int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/collections-rest/int.spec.ts | 128/0/2 | - | 125/0/2 | 125/0/2 | 125/0/2 |
| test/collections-rest/tanstack-server-adapter.int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/config/int.spec.ts | 12/0/1 | - | 12/0/1 | 12/0/1 | 12/0/1 |
| test/create-payload-app/int.spec.ts | 4/7/0 | 4/7/0 | - | - | 4/7/0 **11 diff** |
| test/custom-graphql/int.spec.ts | 2/0/0 | - | 2/0/0 | 2/0/0 | 2/0/0 |
| test/dashboard/documents.int.spec.ts | 11/0/0 | - | 11/0/0 | 11/0/0 | 11/0/0 |
| test/dashboard/int.spec.ts | 3/0/0 | - | 3/0/0 | 3/0/0 | 3/0/0 |
| test/dashboard/pins.int.spec.ts | 4/0/0 | - | 4/0/0 | 4/0/0 | 4/0/0 |
| test/dashboard/thumbnails.int.spec.ts | 3/0/0 | - | 3/0/0 | 3/0/0 | 3/0/0 |
| test/database/batch-processing.int.spec.ts | 4/0/0 | - | 4/0/0 | 4/0/0 | 4/0/0 |
| test/database/copy.int.spec.ts | 5/0/0 | - | 5/0/0 | 5/0/0 | 5/0/0 |
| test/database/int.spec.ts | 164/0/17 | - | 164/0/17 | 164/0/17 | 164/0/17 |
| test/database/migrate-to-blocks-as-json/int.spec.ts | 0/0/1 | - | 0/0/1 | 0/0/1 | 0/0/1 |
| test/database/migrations-cli.int.spec.ts | 3/0/0 | 3/0/0 | - | - | 3/0/0 **3 diff** |
| test/database/pg-replica/int.spec.ts | 0/0/16 | - | 0/0/16 | 0/0/16 | 0/0/16 |
| test/database/postgres-logs.int.spec.ts | 0/0/6 | - | 0/0/6 | 0/0/6 | 0/0/6 |
| test/database/postgres-operator-handlers.int.spec.ts | 0/0/29 | - | 0/0/29 | 0/0/29 | 0/0/29 |
| test/database/postgres-relationships-v2-v3-migration/int.spec.ts | 0/0/1 | - | 0/0/1 | 0/0/1 | 0/0/1 |
| test/database/postgres-vector.int.spec.ts | 0/0/4 | - | 0/0/4 | 0/0/4 | 0/0/4 |
| test/database/sqlite-bound-parameters-limit.int.spec.ts | 0/0/4 | - | 0/0/4 | 0/0/4 | 0/0/4 |
| test/database/up-down-migration/int.spec.ts | 0/0/1 | - | 0/0/1 | 0/0/1 | 0/0/1 |
| test/dataloader/int.spec.ts | 4/0/0 | - | 4/0/0 | 4/0/0 | 4/0/0 |
| test/email-nodemailer/int.spec.ts | 2/0/0 | - | 2/0/0 | 2/0/0 | 2/0/0 |
| test/endpoints/int.spec.ts | 10/0/0 | - | 10/0/0 | 10/0/0 | 10/0/0 |
| test/endpoints/tanstack.int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/field-access-context/int.spec.ts | 11/0/0 | - | 11/0/0 | 11/0/0 | 11/0/0 |
| test/field-paths/int.spec.ts | 2/0/0 | - | 2/0/0 | 2/0/0 | 2/0/0 |
| test/fields-relationship/int.spec.ts | 4/0/0 | - | 4/0/0 | 4/0/0 | 4/0/0 |
| test/fields/graphql-select.int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/fields/int.spec.ts | 233/0/1 | - | 233/0/1 | 233/0/1 | 233/0/1 |
| test/file-versioning/fileOperationManager.int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/file-versioning/int.spec.ts | 56/0/2 | - | 56/0/2 | 56/0/2 | 56/0/2 |
| test/file-versioning/rename.int.spec.ts | 14/0/0 | - | 14/0/0 | 14/0/0 | 14/0/0 |
| test/folders/int.spec.ts | 6/0/0 | - | 6/0/0 | 6/0/0 | 6/0/0 |
| test/form-state/int.spec.ts | 27/0/0 | - | 27/0/0 | 27/0/0 | 27/0/0 |
| test/globals/int.spec.ts | 13/0/0 | - | 13/0/0 | 13/0/0 | 13/0/0 |
| test/graphql/hidden-fields.int.spec.ts | 11/0/0 | - | 11/0/0 | 11/0/0 | 11/0/0 |
| test/graphql/int.spec.ts | 9/0/0 | - | 9/0/0 | 9/0/0 | 9/0/0 |
| test/hierarchy/collection-specific.int.spec.ts | 14/0/0 | - | 14/0/0 | 14/0/0 | 14/0/0 |
| test/hierarchy/int.spec.ts | 36/0/0 | - | 36/0/0 | 36/0/0 | 36/0/0 |
| test/hmr/int.spec.ts | 2/0/2 | 2/0/2 LOAD | 3/1/0 | 2/0/2 **2 diff** | 2/0/2 **2 diff** LOAD |
| test/hooks/int.spec.ts | 45/0/0 | - | 45/0/0 | 45/0/0 | 45/0/0 |
| test/joins/buildJoinAggregation.int.spec.ts | 8/0/0 | - | 8/0/0 | 8/0/0 | 8/0/0 |
| test/joins/hierarchy.int.spec.ts | 0/0/2 | - | 0/0/2 | 0/0/2 | 0/0/2 |
| test/joins/int.spec.ts | 79/0/44 | - | 79/0/44 | 79/0/44 | 79/0/44 |
| test/joins/queryPath.int.spec.ts | 4/0/0 | - | 4/0/0 | 4/0/0 | 4/0/0 |
| test/joins/whereMutation.int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/kv/int.spec.ts | 3/1/0 | - | 3/1/0 | 3/1/0 | 3/1/0 |
| test/lexical-mdx/int.spec.ts | 89/0/0 | - | 89/0/0 | 89/0/0 | 89/0/0 |
| test/lexical/lexical.int.spec.ts | 124/0/0 | - | 124/0/0 | 124/0/0 | 124/0/0 |
| test/live-preview/int.spec.ts | 18/0/0 | - | 18/0/0 | 18/0/0 | 18/0/0 |
| test/llm-instructions/access.int.spec.ts | 12/0/0 | - | 12/0/0 | 12/0/0 | 12/0/0 |
| test/llm-instructions/cli.int.spec.ts | 11/0/0 | 11/0/0 | - | - | 11/0/0 **11 diff** |
| test/llm-instructions/int.spec.ts | 36/0/0 | - | 36/0/0 | 36/0/0 | 36/0/0 |
| test/llm-instructions/slots.int.spec.ts | 5/0/0 | - | 5/0/0 | 5/0/0 | 5/0/0 |
| test/loader/int.spec.ts | 4/0/0 | 4/0/0 | - | - | 4/0/0 **4 diff** |
| test/localization/int.spec.ts | 159/0/0 | - | 159/0/0 | 159/0/0 | 159/0/0 |
| test/localization/localizeStatus.int.spec.ts | 2/0/9 | - | 2/0/9 | 2/0/9 | 2/0/9 |
| test/locked-documents/bulk-delete.int.spec.ts | 1/0/0 | - | 1/0/0 | 1/0/0 | 1/0/0 |
| test/locked-documents/int.spec.ts | 13/0/0 | - | 13/0/0 | 13/0/0 | 13/0/0 |
| test/login-with-username/int.spec.ts | 4/0/0 | - | 4/0/0 | 4/0/0 | 4/0/0 |
| test/mongodb-schema-build-cache/int.spec.ts | 7/0/0 | - | 7/0/0 | 7/0/0 | 7/0/0 |
| test/payload-cloud/int.spec.ts | 4/0/1 | - | 4/0/1 | 4/0/1 | 4/0/1 |
| test/plugin-cloud-storage/int.compositePrefixes.int.spec.ts | 0/0/2 | - | 0/0/2 | 0/0/2 | 0/0/2 |
| test/plugin-cloud-storage/int.spec.ts | 33/3/13 | - | 33/3/13 | 33/3/13 | 33/3/13 |
| test/plugin-cloud-storage/versioning.int.spec.ts | 46/0/3 | - | 46/0/3 | 46/0/3 | 46/0/3 |
| test/plugin-ecommerce/int.spec.ts | 36/0/0 | - | 36/0/0 | 36/0/0 | 36/0/0 |
| test/plugin-form-builder/int.spec.ts | 55/0/0 | - | 55/0/0 | 55/0/0 | 55/0/0 |
| test/plugin-import-export/field-hooks.int.spec.ts | 0/29/0 | - | 0/29/0 | 0/29/0 | 0/29/0 |
| test/plugin-import-export/hooks.int.spec.ts | 0/42/0 | - | 0/42/0 | 0/42/0 | 0/42/0 |
| test/plugin-import-export/int.spec.ts | 0/0/198 | - | 0/0/198 | 0/0/198 | 0/0/198 LOAD |
| test/plugin-mcp/instructions.int.spec.ts | 10/0/0 | 10/0/0 | - | - | 10/0/0 **10 diff** |
| test/plugin-mcp/int.spec.ts | 237/0/1 | - | 237/0/1 | 237/0/1 | 237/0/1 |
| test/plugin-multi-tenant/int.spec.ts | 21/0/0 | - | 21/0/0 | 21/0/0 | 21/0/0 |
| test/plugin-nested-docs/int.spec.ts | 12/0/0 | - | 12/0/0 | 12/0/0 | 12/0/0 |
| test/plugin-redirects/int.spec.ts | 3/0/0 | - | 3/0/0 | 3/0/0 | 3/0/0 |
| test/plugin-search/int.spec.ts | 21/0/0 | - | 21/0/0 | 21/0/0 | 21/0/0 |
| test/plugin-sentry/int.spec.ts | 0/0/1 | - | 0/0/1 | 0/0/1 | 0/0/1 |
| test/plugin-seo/int.spec.ts | 21/0/0 | - | 21/0/0 | 21/0/0 | 21/0/0 |
| test/plugin-stripe/int.spec.ts | 7/0/3 | - | 7/0/3 | 7/0/3 | 7/0/3 |
| test/plugins/int.spec.ts | 6/0/0 | - | 6/0/0 | 6/0/0 | 6/0/0 |
| test/query-presets/int.spec.ts | 13/0/1 | - | 13/0/1 | 13/0/1 | 13/0/1 |
| test/queues/cli.int.spec.ts | 2/0/0 | 2/0/0 | - | - | 2/0/0 **2 diff** |
| test/queues/int.spec.ts | 84/0/3 | 84/0/3 | - | - | 84/0/3 **87 diff** |
| test/queues/postgres-logs.int.spec.ts | 0/0/2 | - | 0/0/2 | 0/0/2 | 0/0/2 |
| test/queues/schedules-autocron.int.spec.ts | 1/0/0 | - | 1/0/0 **1 diff** | 1/0/0 **1 diff** | 1/0/0 **1 diff** |
| test/queues/schedules.int.spec.ts | 13/0/0 | - | 13/0/0 | 13/0/0 | 13/0/0 |
| test/relationships/int.spec.ts | 74/0/0 | - | 74/0/0 | 74/0/0 | 74/0/0 |
| test/sdk/int.spec.ts | 39/0/0 | - | 39/0/0 | 39/0/0 | 39/0/0 |
| test/select/graphql-select.int.spec.ts | 4/0/0 | - | 4/0/0 | 4/0/0 | 4/0/0 |
| test/select/int.spec.ts | 115/0/0 | - | 115/0/0 | 115/0/0 | 115/0/0 |
| test/select/postgreslogs.int.spec.ts | 0/0/2 | - | 0/0/2 | 0/0/2 | 0/0/2 |
| test/sizes-to-variants/int.spec.ts | 8/0/15 | - | 8/0/15 | 8/0/15 | 8/0/15 |
| test/sort/int.spec.ts | 44/0/0 | - | 44/0/0 | 44/0/0 | 44/0/0 |
| test/storage-azure/client-uploads/int.spec.ts | 0/13/0 | - | 0/13/0 | 0/13/0 | 0/13/0 |
| test/storage-azure/int.spec.ts | 0/0/7 | - | 0/0/7 | 0/0/7 | 0/0/7 LOAD |
| test/storage-azure/publicAccess.int.spec.ts | 0/2/0 | - | 0/2/0 | 0/2/0 | 0/2/0 |
| test/storage-azure/streamingUploads.int.spec.ts | 0/4/0 | - | 0/4/0 | 0/4/0 | 0/4/0 |
| test/storage-gcs/int.spec.ts | 0/0/6 | - | 0/0/6 | 0/0/6 | 0/0/6 LOAD |
| test/storage-s3/client-uploads/int.spec.ts | 0/25/0 | - | 0/25/0 | 0/25/0 | 0/25/0 |
| test/storage-s3/int.spec.ts | 0/18/1 | - | 0/18/1 | 0/18/1 | 0/18/1 |
| test/storage-s3/searchBeforeS3.int.spec.ts | 0/3/0 | - | 0/3/0 | 0/3/0 | 0/3/0 |
| test/storage-vercel-blob/client-uploads/compositePrefixes.int.spec.ts | 0/1/0 | - | 0/1/0 | 0/1/0 | 0/1/0 |
| test/storage-vercel-blob/client-uploads/int.spec.ts | 0/6/0 | - | 0/6/0 | 0/6/0 | 0/6/0 |
| test/storage-vercel-blob/int.spec.ts | 0/16/0 | - | 0/16/0 | 0/16/0 | 0/16/0 |
| test/tags/int.spec.ts | 9/0/0 | - | 9/0/0 | 9/0/0 | 9/0/0 |
| test/trash/int.spec.ts | 102/0/5 | - | 102/0/5 | 102/0/5 | 102/0/5 |
| test/types/int.spec.ts | 2/0/0 | - | 2/0/0 | 2/0/0 | 2/0/0 |
| test/upload-transformers/int.spec.ts | 37/0/0 | - | 37/0/0 | 37/0/0 | 37/0/0 |
| test/uploads/int.spec.ts | 155/0/0 | - | 155/0/0 | 155/0/0 | 155/0/0 |
| test/uuid-v7/int.spec.ts | 0/0/6 | - | 0/0/6 | 0/0/6 | 0/0/6 |
| test/validate/int.spec.ts | 112/0/0 | - | 112/0/0 | 112/0/0 | 112/0/0 |
| test/versions/int.spec.ts | 153/0/0 | - | 153/0/0 | 153/0/0 | 153/0/0 |


## Known gaps / differences

- `test/__rs/mongo-adapter/runSuites.mjs` wraps only the harness adapter (configs that build their
  own `mongooseAdapter(...)` stay TS there); `--engine rs` through the db-mongodb switch covers them.
- Mongoose models still come from upstream `init` (not from `MongoEngine.schemaDescription()`).
- Loopback only (glue-irrelevant): `getSession` runs before the upstream method instead of where
  upstream awaits it; `Model.buildQuery` and `buildSearchParams` relationship subqueries run
  in-process on the real models.
- `hasReq` is `Boolean(req)`: `handleError`'s `stripLocaleFromPath` reads
  `req.payload.config.localization`; the engine uses its own config, so a truthy `req` without
  `payload` would strip where upstream does not (no suite does this).
- Mutations are applied when the call settles; upstream mutates the caller's `data` synchronously
  during the call (only observable by code reading the args concurrently).
