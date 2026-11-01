# SQLite engine status (`PAYLOAD_ENGINE=rs`)

Maintained by the adapter (TS glue) owner. Per-suite parity of the upstream int suites run with
`PAYLOAD_ENGINE=rs` against the TS baseline (`.rs-baseline/sqlite-all.json`), plus every test
whose status differs, with root cause and owner (**engine** = Rust side, `crates/payload-sql-*` /
`crates/payload-node/src/engine.rs`; **glue** = `packages/engine-rs/src/adapter/**`).

## How to run

```sh
source /tmp/penv.sh
export CARGO_TARGET_DIR=$PWD/target/shared
cargo build -p payload-node
mkdir -p /tmp/my-addon && cp target/shared/debug/libpayload_node.dylib /tmp/my-addon/payload-engine.node

# per-test comparison with the baseline (own db file per suite, engine / upstream call counts
# per suite; exits 1 on any difference, missing result, or when nothing was compared).
# --core ts keeps field hooks / validators in TS (SQL engine parity only)
node test/__rs/adapter/runSuites.mjs --addon /tmp/my-addon/payload-engine.node [--core ts] \
  --out /tmp/rs-runs --jobs 4 test/hooks/int.spec.ts test/database/int.spec.ts ...

# glue differential spec (TS sqliteAdapter vs withRustEngine, exact results and errors)
PAYLOAD_ENGINE_ADDON=/tmp/my-addon/payload-engine.node SQLITE_URL=file:/tmp/x.db \
  pnpm test:int:sqlite --config test/__rs/harness/vitest.config.ts test/__rs/adapter/adapter.int.spec.ts

# shadow (every payload.db.* call diffed against TS)
PAYLOAD_ENGINE_ADDON=... node packages/engine-rs/scripts/runShadowAll.mjs --candidate rs --out /tmp/rs-shadow test/hooks/int.spec.ts
```

`--loopback` / `PAYLOAD_RS_ENGINE_LOOPBACK=true` replaces the native `SqliteEngine` with a TS
stand-in that speaks the same wire format (Rust raw schema, upstream TS data methods behind
`call`). It verifies the glue alone: any failure in loopback mode is a glue bug.

## Wire format the glue implements (additions to ENGINE_CONTRACT.md)

- `optionsJson`: `allowIDOnCreate, autoIncrement, blocksAsJSON, blockTableNameIndexes ([path,
  index][] seeds, like napi buildRawSchema), idType, limitedBoundParameters, localesSuffix, name,
  relationshipsSuffix, versionsSuffix`.
- `rawSchema()`: napi `buildRawSchema` output (`rawTableKeys`, `columnDefaults`,
  `blockTableNameIndexes`, ...). Decoded and applied with upstream merge semantics
  (`applyRawSchemaRS`); `InternalBlockTableNameIndex` is written back onto block objects.
  Re-init creates a new engine for the (possibly changed) config.
- `call(method, argsJson, connId, contextJson)`: 4th argument
  `contextJson = { allowIDOnCreate, blocksAsJSON, limitedBoundParameters, now }`. `now = Date.now()` is the JS
  clock (so `vi.setSystemTime` / fake timers apply); **the engine must use it for every "now"
  stamp** (`updatedAt` default in transformForWrite, `updateJobs` claim `now`, upsertRow
  `createdAt`). `allowIDOnCreate` / `blocksAsJSON` / `limitedBoundParameters` are the live adapter properties
  drizzle reads at call time (tests set `payload.db.allowIDOnCreate = true` after init); **the
  engine must prefer them over the create-time options**.
- `req` is reduced to `{ fallbackLocale, locale, payloadAPI }`; `transactionID` is resolved by
  TS exactly like `getTransaction` (missing session falls back to the client) and passed as
  `connId`. `req.translations` is not sent: unique-violation messages are rebuilt in TS with
  `req.t` (the engine already strips `errors[].message` then).
- Caller-visible input mutations are done by the glue on the caller's `data` before the call; the
  engine receives the mutated data and **must not repeat them**:
  `createGlobal` `data.createdAt = new Date().toISOString()`; `create` `data.createdAt` when
  falsy; `updateJobs` `delete data.log` (unless non-empty array / `$push`).
- Result: tree encoding, decoded with `deserializeFromEngine`.
- Errors (`message` = JSON), rebuilt by `adapter/errors.ts`:
  - `APIError`: `message`, and `status` / `isPublic` / `data` either top level or as the
    `data: { status, data?, isPublic? }` envelope the crates use.
  - `QueryError`: `data` = `[{ path }]` (or the envelope with `data`).
  - `ValidationError`: `data = { id, collection, errors: [{ path, tableName, message? }], global }`;
    missing `message` = unique violation, filled with `req.t('error:valueMustBeUnique')`; class
    rebuilt with `new ValidationError({ ... req }, req.t)`.
  - `DrizzleQueryError`: `{ query, params (tree), cause: NativeError }`; `cause` rebuilt with
    `toJsError` (`kind` `sqlite` / `native` / `libsql` / ...).
  - `LibsqlError`: `data` = NativeError.
  - `NotFound`, `InvalidConfiguration`, JS built-ins, other names: `createEngineError`.
  - A JS callback that threw (`{"$hostError":true}`) is rethrown as the original error. Only
    `SqliteEngine.create` calls JS (`call` has no host), and it is synchronous, so the error is
    always the one of that `create`.
  - `DrizzleQueryError` is constructed with the class passed as
    `withRustEngine(obj, { DrizzleQueryError })`; db-sqlite passes `drizzle-orm`'s class from its
    own dependency, the copy its `drizzle-orm/libsql` session throws upstream, so `instanceof`
    gives upstream's answer for every drizzle-orm copy (the shape-identical copy is only used
    without the option, e.g. by the shadow harness).

## Calls that run the upstream TS method (glue)

The engine cannot see JS-level replacements of what upstream reaches at call time through `this`
/ `adapter` / the client. When one is detected, `callEngine` runs the upstream
`@payloadcms/drizzle` method itself (statements through drizzle and the Rust-backed JS client, on
the same connections), which is upstream's behaviour by construction. Checked on every call
(identity compares, no I/O):

- `payload.db.countDistinct`, `deleteWhere`, `insert`, `execute`, `createJSONQuery`,
  `convertPathToJSONTraversal`, `operators` (identity and every entry) differ from the values the
  upstream adapter was built with (`vi.spyOn(payload.db, 'countDistinct')`, ...);
- `upsert` while `payload.db.updateOne` is not the engine method (upstream `upsert` is
  `this.updateOne(...)`, e.g. plugin-cloud-storage's `vi.spyOn(payload.db, 'updateOne')`);
- the drizzle session logs queries (`sqliteAdapter({ logger })`, not drizzle's `NoopLogger`);
- `payload.db.drizzle` (or the transaction's drizzle) is not on a Rust sqlite client;
- the client's / transaction's `execute` is not the original method
  (`payload.db.drizzle.$client.execute = ...`, database/sqlite-bound-parameters-limit). Wrappers
  that only forward can opt out with `registerTransparentClientMethod(wrapper, isTransparent)`;
  the shadow harness's candidate wrapper (`candidateClientCall`) is treated as transparent until
  it registers itself.

Every such call is counted in the stats (`upstream`, `upstreamReasons`); `runSuites.mjs` reports
them per file. `markWrite` (`payload.db.lastWriteTimestamp = Date.now()`) is reproduced after the
engine call: always on success of `create*`, `update{Global,Version,GlobalVersion}`, `upsert`,
`deleteMany`; `updateOne` with an `id` / `options.upsert` / `options.atomic` or a non-null result;
`updateMany` / `updateJobs` / `deleteVersions` with a non-empty result; `deleteOne` with a result;
and for unique-violation `ValidationError`s of write methods (raised after `upsertRow`'s mark).

## Results (2026-11-01 08:22 addon build, full `PAYLOAD_ENGINE=rs`, TZ=UTC)

`node test/__rs/adapter/runSuites.mjs --addon <08:22 build> --out /tmp/rs-adapter-runs/r4 --jobs 4
<all 135 files of .rs-baseline/sqlite-all.json>`: SQL engine **and** the Rust core runtime
(field hooks, validators; `PAYLOAD_CORE_ENGINE` unset). Every file of the baseline, including
`storage-*` (their tests fail on missing local services in the baseline too, and do so identically).

**135/135 files have the baseline's per-test outcome for every baseline-passing and
baseline-failing test**, except where the baseline itself failed for environmental reasons:

- `select/int.spec.ts`: baseline 78/1/36 (an `EEXIST` on a media file, which skipped the rest of
  the file); rs 115/0/0; the TS engine also gives 115/0/0 when rerun now.
- `uploads/int.spec.ts`: baseline 154/1/0 (`allow-list-media` URL `http://10.0.0.1/file.png`,
  network dependent); rs 155/0/0.
- `validate/int.spec.ts` failed 2 upload tests with `ENOENT` in `test/validate/validation-uploads`
  while another agent ran the same suite; rerun alone: 112/112 (row below).

Totals: rs 3307 passed / 160 failed / 440 skipped (baseline 3269 / 162 / 476); every rs failure
is a baseline failure. 51,752 engine calls; 322 calls ran the upstream TS method, all in
`database/sqlite-bound-parameters-limit` (replaced `client.execute`). Files with 0 engine calls make
no data calls (CLI / config / postgres- or mongo-only suites, skipped on sqlite).

Same run with `--core ts` (SQL engine only, 07:37 build, `/tmp/rs-adapter-runs/r2`): 129/135
identical; the 6 differing files were `select` / `uploads` (as above) and four file-system
collisions with concurrent runs of the same suites by other agents (`cli`, `database/migrations-cli`,
`file-versioning/rename`, `validate`), all identical when rerun alone (`cli` is 64/64 in the full rs
run).

`test/__rs/adapter/adapter.int.spec.ts` (TS `sqliteAdapter` vs `withRustEngine`, exact results,
errors incl. class identity and cause chain, executed statements, `lastWriteTimestamp`): native
13 passed + 1 expected fail (#4), loopback 13 passed + 1 expected fail.

| file                                                                  | baseline pass/fail/skip | rs pass/fail/skip | differing tests | engine calls | upstream calls |
| --------------------------------------------------------------------- | ----------------------- | ----------------- | --------------- | ------------ | -------------- |
| test/__helpers/int/configImport.int.spec.ts                           | 1/0/0                   | 1/0/0             | 0               | 0            | 0              |
| test/__helpers/shared/getTestSuiteDir.int.spec.ts                     | 4/0/0                   | 4/0/0             | 0               | 0            | 0              |
| test/_community/int.spec.ts                                           | 2/0/0                   | 2/0/0             | 0               | 6            | 0              |
| test/access-control/int.spec.ts                                       | 84/0/0                  | 84/0/0            | 0               | 714          | 0              |
| test/access-control/postgres-logs.int.spec.ts                         | 0/0/6                   | 0/0/6             | 0               | 0            | 0              |
| test/admin-root/int.spec.ts                                           | 2/0/0                   | 2/0/0             | 0               | 13           | 0              |
| test/admin-routing/int.spec.ts                                        | 3/0/0                   | 3/0/0             | 0               | 0            | 0              |
| test/array-update/int.spec.ts                                         | 5/0/0                   | 5/0/0             | 0               | 22           | 0              |
| test/auth-api-key/int.spec.ts                                         | 11/0/0                  | 11/0/0            | 0               | 134          | 0              |
| test/auth/api-key/int.spec.ts                                         | 11/0/0                  | 11/0/0            | 0               | 97           | 0              |
| test/auth/custom-strategy/int.spec.ts                                 | 1/0/0                   | 1/0/0             | 0               | 1            | 0              |
| test/auth/first-user/int.spec.ts                                      | 1/0/0                   | 1/0/0             | 0               | 1            | 0              |
| test/auth/forgot-password-localized/int.spec.ts                       | 2/0/0                   | 2/0/0             | 0               | 20           | 0              |
| test/auth/int.spec.ts                                                 | 117/0/0                 | 117/0/0           | 0               | 1094         | 0              |
| test/auth/jwt/int.spec.ts                                             | 3/0/0                   | 3/0/0             | 0               | 55           | 0              |
| test/auth/removed-token/int.spec.ts                                   | 5/0/0                   | 5/0/0             | 0               | 73           | 0              |
| test/authorship/int.spec.ts                                           | 32/0/0                  | 32/0/0            | 0               | 346          | 0              |
| test/authorship/single-auth.int.spec.ts                               | 5/0/0                   | 5/0/0             | 0               | 55           | 0              |
| test/base-access/int.spec.ts                                          | 7/0/0                   | 7/0/0             | 0               | 1            | 0              |
| test/cli/int.spec.ts                                                  | 64/0/12                 | 64/0/12           | 0               | 62           | 0              |
| test/collections-graphql/int.spec.ts                                  | 50/0/0                  | 50/0/0            | 0               | 481          | 0              |
| test/collections-rest/bulk-delete-rollback.int.spec.ts                | 1/0/0                   | 1/0/0             | 0               | 1            | 0              |
| test/collections-rest/int.spec.ts                                     | 125/0/2                 | 125/0/2           | 0               | 1646         | 0              |
| test/collections-rest/tanstack-server-adapter.int.spec.ts             | 1/0/0                   | 1/0/0             | 0               | 1            | 0              |
| test/config/int.spec.ts                                               | 12/0/1                  | 12/0/1            | 0               | 9            | 0              |
| test/create-payload-app/int.spec.ts                                   | 11/0/0                  | 11/0/0            | 0               | 0            | 0              |
| test/custom-graphql/int.spec.ts                                       | 1/0/0                   | 1/0/0             | 0               | 0            | 0              |
| test/dashboard/documents.int.spec.ts                                  | 11/0/0                  | 11/0/0            | 0               | 842          | 0              |
| test/dashboard/int.spec.ts                                            | 3/0/0                   | 3/0/0             | 0               | 0            | 0              |
| test/dashboard/pins.int.spec.ts                                       | 4/0/0                   | 4/0/0             | 0               | 676          | 0              |
| test/dashboard/thumbnails.int.spec.ts                                 | 3/0/0                   | 3/0/0             | 0               | 717          | 0              |
| test/database/batch-processing.int.spec.ts                            | 2/0/2                   | 2/0/2             | 0               | 10           | 0              |
| test/database/copy.int.spec.ts                                        | 4/0/1                   | 4/0/1             | 0               | 10           | 0              |
| test/database/int.spec.ts                                             | 156/0/21                | 156/0/21          | 0               | 2084         | 0              |
| test/database/migrate-to-blocks-as-json/int.spec.ts                   | 1/0/0                   | 1/0/0             | 0               | 2071         | 0              |
| test/database/migrations-cli.int.spec.ts                              | 2/0/1                   | 2/0/1             | 0               | 0            | 0              |
| test/database/pg-replica/int.spec.ts                                  | 0/0/16                  | 0/0/16            | 0               | 0            | 0              |
| test/database/postgres-logs.int.spec.ts                               | 0/0/6                   | 0/0/6             | 0               | 0            | 0              |
| test/database/postgres-operator-handlers.int.spec.ts                  | 0/0/29                  | 0/0/29            | 0               | 0            | 0              |
| test/database/postgres-relationships-v2-v3-migration/int.spec.ts      | 0/0/1                   | 0/0/1             | 0               | 0            | 0              |
| test/database/postgres-vector.int.spec.ts                             | 0/0/4                   | 0/0/4             | 0               | 0            | 0              |
| test/database/sqlite-bound-parameters-limit.int.spec.ts               | 4/0/0                   | 4/0/0             | 0               | 2            | 322            |
| test/database/up-down-migration/int.spec.ts                           | 0/0/1                   | 0/0/1             | 0               | 0            | 0              |
| test/dataloader/int.spec.ts                                           | 4/0/0                   | 4/0/0             | 0               | 520          | 0              |
| test/email-nodemailer/int.spec.ts                                     | 2/0/0                   | 2/0/0             | 0               | 1            | 0              |
| test/endpoints/int.spec.ts                                            | 10/0/0                  | 10/0/0            | 0               | 8            | 0              |
| test/endpoints/tanstack.int.spec.ts                                   | 1/0/0                   | 1/0/0             | 0               | 1            | 0              |
| test/field-access-context/int.spec.ts                                 | 11/0/0                  | 11/0/0            | 0               | 107          | 0              |
| test/field-paths/int.spec.ts                                          | 2/0/0                   | 2/0/0             | 0               | 1            | 0              |
| test/fields-relationship/int.spec.ts                                  | 4/0/0                   | 4/0/0             | 0               | 133          | 0              |
| test/fields/graphql-select.int.spec.ts                                | 1/0/0                   | 1/0/0             | 0               | 77           | 0              |
| test/fields/int.spec.ts                                               | 221/0/13                | 221/0/13          | 0               | 2760         | 0              |
| test/file-versioning/fileOperationManager.int.spec.ts                 | 1/0/0                   | 1/0/0             | 0               | 1            | 0              |
| test/file-versioning/int.spec.ts                                      | 51/0/7                  | 51/0/7            | 0               | 2441         | 0              |
| test/file-versioning/rename.int.spec.ts                               | 13/0/1                  | 13/0/1            | 0               | 219          | 0              |
| test/folders/int.spec.ts                                              | 6/0/0                   | 6/0/0             | 0               | 131          | 0              |
| test/form-state/int.spec.ts                                           | 27/0/0                  | 27/0/0            | 0               | 9            | 0              |
| test/globals/int.spec.ts                                              | 13/0/0                  | 13/0/0            | 0               | 34           | 0              |
| test/graphql/hidden-fields.int.spec.ts                                | 11/0/0                  | 11/0/0            | 0               | 75           | 0              |
| test/graphql/int.spec.ts                                              | 9/0/0                   | 9/0/0             | 0               | 30           | 0              |
| test/hierarchy/collection-specific.int.spec.ts                        | 14/0/0                  | 14/0/0            | 0               | 159          | 0              |
| test/hierarchy/int.spec.ts                                            | 36/0/0                  | 36/0/0            | 0               | 1440         | 0              |
| test/hmr/int.spec.ts                                                  | 0/0/4                   | 0/0/4             | 0               | 0            | 0              |
| test/hooks/int.spec.ts                                                | 44/0/1                  | 44/0/1            | 0               | 135          | 0              |
| test/joins/buildJoinAggregation.int.spec.ts                           | 0/0/8                   | 0/0/8             | 0               | 0            | 0              |
| test/joins/hierarchy.int.spec.ts                                      | 2/0/0                   | 2/0/0             | 0               | 1            | 0              |
| test/joins/int.spec.ts                                                | 115/0/8                 | 115/0/8           | 0               | 2216         | 0              |
| test/joins/queryPath.int.spec.ts                                      | 0/0/4                   | 0/0/4             | 0               | 0            | 0              |
| test/joins/whereMutation.int.spec.ts                                  | 1/0/0                   | 1/0/0             | 0               | 70           | 0              |
| test/kv/int.spec.ts                                                   | 3/1/0                   | 3/1/0             | 0               | 1            | 0              |
| test/lexical-mdx/int.spec.ts                                          | 89/0/0                  | 89/0/0            | 0               | 0            | 0              |
| test/lexical/lexical.int.spec.ts                                      | 124/0/0                 | 124/0/0           | 0               | 1134         | 0              |
| test/live-preview/int.spec.ts                                         | 18/0/0                  | 18/0/0            | 0               | 181          | 0              |
| test/llm-instructions/access.int.spec.ts                              | 12/0/0                  | 12/0/0            | 0               | 109          | 0              |
| test/llm-instructions/cli.int.spec.ts                                 | 11/0/0                  | 11/0/0            | 0               | 1            | 0              |
| test/llm-instructions/int.spec.ts                                     | 35/0/1                  | 35/0/1            | 0               | 221          | 0              |
| test/llm-instructions/slots.int.spec.ts                               | 5/0/0                   | 5/0/0             | 0               | 49           | 0              |
| test/loader/int.spec.ts                                               | 4/0/0                   | 4/0/0             | 0               | 0            | 0              |
| test/localization/int.spec.ts                                         | 158/0/0                 | 158/0/0           | 0               | 1212         | 0              |
| test/localization/localizeStatus.int.spec.ts                          | 4/0/7                   | 4/0/7             | 0               | 9            | 0              |
| test/locked-documents/bulk-delete.int.spec.ts                         | 1/0/0                   | 1/0/0             | 0               | 34           | 0              |
| test/locked-documents/int.spec.ts                                     | 13/0/0                  | 13/0/0            | 0               | 91           | 0              |
| test/login-with-username/int.spec.ts                                  | 4/0/0                   | 4/0/0             | 0               | 25           | 0              |
| test/mongodb-schema-build-cache/int.spec.ts                           | 0/0/7                   | 0/0/7             | 0               | 0            | 0              |
| test/payload-cloud/int.spec.ts                                        | 4/0/1                   | 4/0/1             | 0               | 31           | 0              |
| test/plugin-cloud-storage/int.compositePrefixes.int.spec.ts           | 0/0/2                   | 0/0/2             | 0               | 0            | 0              |
| test/plugin-cloud-storage/int.spec.ts                                 | 33/3/13                 | 33/3/13           | 0               | 242          | 0              |
| test/plugin-cloud-storage/versioning.int.spec.ts                      | 45/0/4                  | 45/0/4            | 0               | 1001         | 0              |
| test/plugin-ecommerce/int.spec.ts                                     | 36/0/0                  | 36/0/0            | 0               | 614          | 0              |
| test/plugin-form-builder/int.spec.ts                                  | 55/0/0                  | 55/0/0            | 0               | 659          | 0              |
| test/plugin-import-export/field-hooks.int.spec.ts                     | 0/29/0                  | 0/29/0            | 0               | 0            | 0              |
| test/plugin-import-export/hooks.int.spec.ts                           | 0/42/0                  | 0/42/0            | 0               | 0            | 0              |
| test/plugin-import-export/int.spec.ts                                 | 0/0/198                 | 0/0/198           | 0               | 0            | 0              |
| test/plugin-mcp/instructions.int.spec.ts                              | 10/0/0                  | 10/0/0            | 0               | 296          | 0              |
| test/plugin-mcp/int.spec.ts                                           | 237/0/1                 | 237/0/1           | 0               | 3269         | 0              |
| test/plugin-multi-tenant/int.spec.ts                                  | 21/0/0                  | 21/0/0            | 0               | 769          | 0              |
| test/plugin-nested-docs/int.spec.ts                                   | 12/0/0                  | 12/0/0            | 0               | 737          | 0              |
| test/plugin-redirects/int.spec.ts                                     | 3/0/0                   | 3/0/0             | 0               | 4            | 0              |
| test/plugin-search/int.spec.ts                                        | 21/0/0                  | 21/0/0            | 0               | 718          | 0              |
| test/plugin-sentry/int.spec.ts                                        | 0/0/1                   | 0/0/1             | 0               | 0            | 0              |
| test/plugin-seo/int.spec.ts                                           | 21/0/0                  | 21/0/0            | 0               | 485          | 0              |
| test/plugin-stripe/int.spec.ts                                        | 7/0/3                   | 7/0/3             | 0               | 27           | 0              |
| test/plugins/int.spec.ts                                              | 6/0/0                   | 6/0/0             | 0               | 2            | 0              |
| test/query-presets/int.spec.ts                                        | 13/0/1                  | 13/0/1            | 0               | 206          | 0              |
| test/queues/cli.int.spec.ts                                           | 2/0/0                   | 2/0/0             | 0               | 20           | 0              |
| test/queues/int.spec.ts                                               | 85/0/2                  | 85/0/2            | 0               | 2719         | 0              |
| test/queues/postgres-logs.int.spec.ts                                 | 0/0/2                   | 0/0/2             | 0               | 0            | 0              |
| test/queues/schedules-autocron.int.spec.ts                            | 1/0/0                   | 1/0/0             | 0               | 41           | 0              |
| test/queues/schedules.int.spec.ts                                     | 13/0/0                  | 13/0/0            | 0               | 361          | 0              |
| test/relationships/int.spec.ts                                        | 69/0/5                  | 69/0/5            | 0               | 1947         | 0              |
| test/sdk/int.spec.ts                                                  | 39/0/0                  | 39/0/0            | 0               | 355          | 0              |
| test/select/graphql-select.int.spec.ts                                | 4/0/0                   | 4/0/0             | 0               | 9            | 0              |
| test/select/int.spec.ts                                               | 78/1/36                 | 115/0/0           | 37              | 215          | 0              |
| test/select/postgreslogs.int.spec.ts                                  | 0/0/2                   | 0/0/2             | 0               | 0            | 0              |
| test/sizes-to-variants/int.spec.ts                                    | 10/0/13                 | 10/0/13           | 0               | 45           | 0              |
| test/sort/int.spec.ts                                                 | 44/0/0                  | 44/0/0            | 0               | 532          | 0              |
| test/storage-azure/client-uploads/int.spec.ts                         | 0/13/0                  | 0/13/0            | 0               | 0            | 0              |
| test/storage-azure/int.spec.ts                                        | 0/0/7                   | 0/0/7             | 0               | 0            | 0              |
| test/storage-azure/publicAccess.int.spec.ts                           | 0/2/0                   | 0/2/0             | 0               | 0            | 0              |
| test/storage-azure/streamingUploads.int.spec.ts                       | 0/4/0                   | 0/4/0             | 0               | 0            | 0              |
| test/storage-gcs/int.spec.ts                                          | 0/0/6                   | 0/0/6             | 0               | 1            | 0              |
| test/storage-s3/client-uploads/int.spec.ts                            | 0/25/0                  | 0/25/0            | 0               | 1            | 0              |
| test/storage-s3/int.spec.ts                                           | 0/18/1                  | 0/18/1            | 0               | 0            | 0              |
| test/storage-s3/searchBeforeS3.int.spec.ts                            | 0/3/0                   | 0/3/0             | 0               | 11           | 0              |
| test/storage-vercel-blob/client-uploads/compositePrefixes.int.spec.ts | 0/1/0                   | 0/1/0             | 0               | 1            | 0              |
| test/storage-vercel-blob/client-uploads/int.spec.ts                   | 0/4/2                   | 0/4/2             | 0               | 1            | 0              |
| test/storage-vercel-blob/int.spec.ts                                  | 0/15/1                  | 0/15/1            | 0               | 1            | 0              |
| test/tags/int.spec.ts                                                 | 9/0/0                   | 9/0/0             | 0               | 1            | 0              |
| test/trash/int.spec.ts                                                | 102/0/5                 | 102/0/5           | 0               | 2774         | 0              |
| test/types/int.spec.ts                                                | 2/0/0                   | 2/0/0             | 0               | 0            | 0              |
| test/upload-transformers/int.spec.ts                                  | 37/0/0                  | 37/0/0            | 0               | 283          | 0              |
| test/uploads/int.spec.ts                                              | 154/1/0                 | 155/0/0           | 1               | 2157         | 0              |
| test/uuid-v7/int.spec.ts                                              | 0/0/6                   | 0/0/6             | 0               | 0            | 0              |
| test/validate/int.spec.ts                                             | 112/0/0                 | 112/0/0           | 0 (rerun alone) | 666          | 0              |
| test/versions/int.spec.ts                                             | 153/0/0                 | 153/0/0           | 0               | 5671         | 0              |

## Open items

| #   | test / symptom                                                                                                                                                       | root cause                                                                                                                                                                                                                                           | owner / state                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | database/sqlite-bound-parameters-limit (`payload.db.drizzle.$client.execute` replaced)                                                                               | engine SQL cannot go through a JS `execute`                                                                                                                                                                                                          | **fixed (glue)**: a replaced `execute` makes the calls run the upstream TS method (4/4, `adapter.int.spec.ts` compares the executed statements with TS)                                                                                                                                                                                                                                                   |
| 2   | `adapter.int.spec.ts` "DrizzleQueryError": NOT NULL violation of an `insert ... returning`                                                                           | libsql raises the raw binding error (`kind: 'native'`: plain `Error` with `code`, `rawCode`, `libsqlError: true`) for an error surfacing while stepping a returning statement; the engine reports `kind: 'sqlite'` (LibsqlError + SqliteError cause) | engine, **fixed** (08:22 build: the adapter spec matches)                                                                                                                                                                                                                                                                                                                                                 |
| 3   | `adapter.int.spec.ts` "create, read, update and delete": `find({ draft: true })` (queryDrafts) with equal `createdAt` returns `[.., 2, 1]` on TS, `[.., 1, 2]` on rs | tie order of the versions query differs: SQL / plan not identical to drizzle's                                                                                                                                                                       | engine, **fixed** (08:22 build: the adapter spec matches)                                                                                                                                                                                                                                                                                                                                                 |
| 4   | `adapter.int.spec.ts` `test.fails` "own undefined properties of the raw schema"                                                                                      | `rawSchema()` JSON drops own properties holding `undefined` (e.g. `rawTables[t].indexes[i].unique`)                                                                                                                                                  | engine (schema JSON encoding), open                                                                                                                                                                                                                                                                                                                                                                       |
| 5   | concurrent operations                                                                                                                                                | one engine call is one queue job (atomic); upstream interleaves the statements of concurrent operations at every `await`                                                                                                                             | design, documented                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | spies / replacements of adapter internals (`countDistinct`, `deleteWhere`, `insert`, `execute`, operators, `updateOne` for `upsert`), drizzle `logger`               | the engine implements them internally                                                                                                                                                                                                                | **fixed (glue)**: detected per call, the call runs the upstream TS method ("Calls that run the upstream TS method")                                                                                                                                                                                                                                                                                       |
| 7   | caller-visible mutations                                                                                                                                             | glue reproduces `create` / `createGlobal` / `updateJobs` mutations of `data`; `updateGlobal`'s create path (`data.createdAt` set when no global row exists yet) is not reproduced (needs the row-exists read)                                        | engine could return it; low impact, open                                                                                                                                                                                                                                                                                                                                                                  |
| 8   | `lastWriteTimestamp` (`markWrite`)                                                                                                                                   | not set by the engine                                                                                                                                                                                                                                | **glue, reproduced** from method + result (see above); not derivable: `updateOne` / `updateMany` / `updateJobs` / `deleteOne` with `returning: false` and no id (not marked), failures after `upsertRow` other than unique violations (not marked), and the value is `Date.now()` after the call instead of during it (equal under fake timers). Only read for read-replica routing, which sqlite has not |
| 9   | error identity                                                                                                                                                       |                                                                                                                                                                                                                                                      | **fixed (glue)**: `DrizzleQueryError` is db-sqlite's drizzle-orm class; host errors are only possible in the synchronous `create`, so attribution is exact. `LibsqlError` / `SqliteError` causes are the Rust client's classes (as for every rs-mode client error), not `@libsql/client`'s                                                                                                                |
| 10  | schema hooks                                                                                                                                                         | `beforeSchemaInit` / `afterSchemaInit` changes to drizzle tables are visible to TS (push, `payload.db.drizzle`) but not to the engine's retained schema                                                                                              | engine/design, open                                                                                                                                                                                                                                                                                                                                                                                       |
