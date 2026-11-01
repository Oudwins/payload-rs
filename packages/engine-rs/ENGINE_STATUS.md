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
# per suite; exits 1 on any difference, missing result, a file whose data calls all ran
# upstream, or when nothing was compared).
# --core ts keeps field hooks / validators in TS (SQL engine parity only)
node test/__rs/adapter/runSuites.mjs --addon /tmp/my-addon/payload-engine.node [--core ts] \
  --out /tmp/rs-runs --jobs 4 test/hooks/int.spec.ts test/database/int.spec.ts ...

# adapter matrix (see "Adapter matrix"): the TS reference first, written as a baseline, then rs
# against every reference run (a test's status must equal its status in at least one of them;
# tests whose reference runs disagree are listed as `reference flaky`)
node test/__rs/adapter/runSuites.mjs --engine ts --variant uuid --jobs 4 --out /tmp/ts-uuid \
  --write-baseline .rs-baseline/sqlite-uuid.json <files>
node test/__rs/adapter/runSuites.mjs --addon ... --variant uuid --jobs 4 --out /tmp/rs-uuid \
  --baseline .rs-baseline/sqlite-uuid.json [--baseline <second TS run>] <files>

# glue differential spec (TS sqliteAdapter vs withRustEngine, exact results and errors)
PAYLOAD_ENGINE_ADDON=/tmp/my-addon/payload-engine.node SQLITE_URL=file:/tmp/x.db \
  pnpm test:int:sqlite --config test/__rs/harness/vitest.config.ts test/__rs/adapter/adapter.int.spec.ts

# shadow (every payload.db.* call diffed against TS)
PAYLOAD_ENGINE_ADDON=... node packages/engine-rs/scripts/runShadowAll.mjs --candidate rs --out /tmp/rs-shadow test/hooks/int.spec.ts
```

`PAYLOAD_SQLITE_TRACE=true` (read when a connection opens) records the SQL and bound parameter
count of every statement on that connection between `sqliteStartStatementTrace()` and
`sqliteTakeStatementTrace()` (addon functions, `sqlite/native.ts`): the engine's statements do not
go through `client.execute`, so this is how the adapter spec compares them with the TS adapter's.

`--loopback` / `PAYLOAD_RS_ENGINE_LOOPBACK=true` replaces the native `SqliteEngine` with a TS
stand-in that speaks the same wire format (Rust raw schema, upstream TS data methods behind
`call`). It verifies the glue alone: any failure in loopback mode is a glue bug.

## Wire format the glue implements (additions to ENGINE_CONTRACT.md)

- `optionsJson`: `allowIDOnCreate, autoIncrement, blocksAsJSON, blockTableNameIndexes ([path,
  index][] seeds, like napi buildRawSchema), idType, limitedBoundParameters, localesSuffix, name,
  relationshipsSuffix, versionsSuffix`.
- `rawSchema()`: napi `buildRawSchema` output (`rawTableKeys`, `columnDefaults`,
  `blockTableNameIndexes`, ...). Decoded and applied with upstream merge semantics
  (`applyRawSchemaRS`); `InternalBlockTableNameIndex` is written back onto block objects, and the
  own `undefined` properties listed in `undefinedProperties` are restored on `rawTables`.
  Re-init creates a new engine for the (possibly changed) config.
- `setLiveSchema({ drizzle, rawTables })`: before the first `call` on a drizzle instance (again
  after `connect` builds a new one, e.g. re-init) the glue describes `adapter.drizzle._.schema` /
  `_.tableNamesMap` (`describeLiveSchema` in `adapter/schema.ts`: `name, columnType, primary,
  sqlType, mode?`, custom columns' `fromDriver` / `toDriver` registered as host functions that
  decode their tree argument and call `column.mapFromDriverValue` / `mapToDriverValue`) and sends
  `adapter.rawTables` as JSON (omitted when JSON cannot hold it, e.g. a bigint default: the
  engine then keeps its own raw tables). So `beforeSchemaInit` / `afterSchemaInit` changes reach
  the engine. Sent in the synchronous part of the call (before upstream's argument mutations) and
  checked again after `getTransaction` (a `connect` may build a new drizzle instance meanwhile).
  **It never fails a user call**: the engine swaps its schema `Arc` (calls already running keep
  the schema they started with, e.g. a request in flight during a hot reload's `connect`); if the
  engine refuses anyway (an engine that needs exclusive access: `engine calls are in progress`),
  that call runs the upstream TS method and a later call sends the schema again; a schema that
  cannot be described or that the engine rejects makes every call on that drizzle instance run
  upstream (`upstreamReasons` `live schema: ...`). `adapter.int.spec.ts` "hot reload": `db.init()`,
  a call between init and connect, `connect({ hotReload: true })` while another call is still
  inside the engine, a call started right then, and the engine serving the next call.
- `call(method, argsJson, connId, contextJson)`: 4th argument
  `contextJson = { allowIDOnCreate, blocksAsJSON, limitedBoundParameters, now, withMutations: true }`. `now = Date.now()` is the JS
  clock (so `vi.setSystemTime` / fake timers apply); **the engine must use it for every "now"
  stamp** (`updatedAt` default in transformForWrite, `updateJobs` claim `now`, upsertRow
  `createdAt`). `allowIDOnCreate` / `blocksAsJSON` / `limitedBoundParameters` are the live adapter properties
  drizzle reads at call time (tests set `payload.db.allowIDOnCreate = true` after init); **the
  engine must prefer them over the create-time options**.
- `req` is reduced to `{ fallbackLocale, locale, payloadAPI }`; `transactionID` is resolved by
  TS exactly like `getTransaction` (missing session falls back to the client) and passed as
  `connId`. `req.translations` is not sent: unique-violation messages are rebuilt in TS with
  `req.t` (the engine already strips `errors[].message` then).
- Caller-visible input mutations are done by the glue on the caller's arguments, at upstream's
  point relative to `getTransaction`; the engine receives the mutated arguments and **must not
  repeat them**: `createGlobal` `data.createdAt = new Date().toISOString()` and `createVersion`
  `select.updatedAt = true` (drafts collection, `select` an object; `null` throws upstream's
  TypeError), both before `getTransaction`; `updateJobs` `delete data.log` (unless non-empty array
  / `$push`); `create` `data.createdAt` when falsy. Mutations that depend on the database come
  back in the `{ result, mutations }` envelope (`withMutations`) and are applied on the caller's
  objects when the call resolves: `updateGlobal` without a global row sets `data.createdAt`.
  When `req.transactionID` is not a promise, the transaction's connection is checked for an
  upstream fallback (below) before these mutations.
- Result: `{ result, mutations }`, `result` in the tree encoding, decoded with
  `deserializeFromEngine`. `deleteOne` with `returning: false` is sent with `returning: true`
  (upstream only skips `transform` then) so the glue knows whether a document was deleted
  (`markWrite`); it returns `null` without decoding the document (only `tree !== null` is read).
  The engine still transforms and encodes it (open item 18).
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
  - A JS callback that threw (`{"$hostError":true}`) is rethrown as the original error. In
    `SqliteEngine.create` (synchronous) every collected error belongs to it. During `call` (custom
    column `fromDriver` / `toDriver`) the errors are kept per registry function id in throw order;
    a call failing with `HostError` `JS function <id> threw` rethrows the oldest error of that id
    (`adapter.int.spec.ts` "live schema": the user's own error object). The table is emptied
    whenever no engine call is in flight, so an error no call claimed cannot reach a later call.
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
- `payload.db.operatorHandlers` is anything but the empty array sqlite builds (upstream
  `buildOperatorConstraint` reads it at call time; the engine has none);
- `upsert` while `payload.db.updateOne` is not the engine method (upstream `upsert` is
  `this.updateOne(...)`, e.g. plugin-cloud-storage's `vi.spyOn(payload.db, 'updateOne')`);
- the drizzle session logs queries (`sqliteAdapter({ logger })`, not drizzle's `NoopLogger`);
- `payload.db.drizzle` (or the transaction's drizzle) is not on a Rust sqlite client;
- the client's / transaction's `execute` is not the original method
  (`payload.db.drizzle.$client.execute = ...`, database/sqlite-bound-parameters-limit). Wrappers
  that only forward can opt out with `registerTransparentClientMethod(wrapper, isTransparent)`;
  the shadow harness registers its candidate wrapper with "the reference client's method is not
  overridden by the test" (no name-based exception any more);
- `setLiveSchema` could not take the live schema (see the wire format).

Every such call is counted in the stats (`upstream`, `upstreamReasons`); `runSuites.mjs` reports
them per file and fails a file whose data calls all ran upstream (`engine bypassed`).

`markWrite` (`payload.db.lastWriteTimestamp = Date.now()`) is reproduced after the engine call:

- success: always for `create*`, `update{Global,Version,GlobalVersion}`, `upsert`, `deleteMany`;
  `updateOne` with an `id` / `options.upsert` / `options.atomic` or a non-null result;
  `updateMany` / `updateJobs` / `deleteVersions` with a non-empty result; `deleteOne` when a
  document was deleted (also with `returning: false`, see above);
- failure: methods whose first statement is `upsertRow`'s (`create`, `createGlobal`,
  `createGlobalVersion`, `createVersion`, `updateVersion`, `updateGlobalVersion`, `updateOne` /
  `upsert` with an `id`) on every statement error, unique violation or host function error;
  `updateGlobal` / `updateJobs` / `updateMany` / `updateOne` / `upsert` on a unique violation or
  a failed `insert` / `update` / `delete` (not `updateJobs`' initial claim, which marks after its
  update; the claim is upstream's `isInitialJobClaim`: string `processingToken` and
  `processingUntil`, no other keys but `updatedAt`); the atomic `updateOne` on any statement
  error. Deletes mark after their statement.

Other glue parity details: `createVersion` / `createGlobal` with an unknown slug throw upstream's
`TypeError` (`...collections[slug].config`, `globalConfig.slug`) before `getTransaction`.

## Results (2026-11-01 15:08, phase F, full `PAYLOAD_ENGINE=rs`, TZ=UTC)

`node test/__rs/adapter/runSuites.mjs --addon <addon> --variant default --jobs 4 <all 135 files of
.rs-baseline/sqlite-all.json>`: SQL engine, glue and the Rust core runtime (`PAYLOAD_CORE_ENGINE`
unset), on the workspace build of 15:06 (the addon copied to `packages/engine-rs/payload-engine.node`).
Other agents ran suites at the same time (load average 20 to 30).

**Every baseline-passing test passes and every baseline failure fails identically, in all 135
files**, once the files that differed under load are rerun alone, each next to a second TS
reference run (rs must match one of the reference runs):

- `cli`, `llm-instructions/cli`, `plugin-mcp/instructions`: CLI child processes read the shared,
  generated `test/databaseAdapter.js`, which another agent's run had regenerated as MongoDB at
  15:51. The harness now resolves it to its own adapter in child processes for every database
  (`test/__rs/harness/databaseAdapter.ts`, `childProcessLoader.mjs`). Rerun alone: identical.
- `queues` "should recover a job after its worker process is killed": worker spawn timing under
  load (known). Rerun alone: 85/0/2 on TS and rs.
- `create-payload-app` (no data calls): its rerun fails the same 7 scaffolding tests alone on TS
  and rs (environment); the full run's single failure was a 90 s hook timeout.
- `select` (baseline 78/1/36, an `EEXIST` that skipped the rest of the file) and `uploads`
  (baseline 154/1/0, a network dependent URL): rs passes more than the baseline; a second TS run
  passes them too (115/0/0, 155/0/0), which rs matches.

Totals of the full run: 3282 passed / 185 failed / 440 skipped; with the reruns above 3306 / 161 /
440 (baseline 3269 / 162 / 476). 53,388 engine calls; 322 ran the upstream TS method, all in
`database/sqlite-bound-parameters-limit` (replaced `client.execute`). The previous phase's tables
counted `test/auth-api-key/int.spec.ts` and `test/auth/api-key/int.spec.ts` from one shared output
file (open item 22); both now have their own.

The shared addon was then refreshed from the final workspace build (16:54, other agents' core
runtime changes included) after these files matched the baseline on it: `hooks`, `database/int`,
`sqlite-bound-parameters-limit`, `versions`, `localization`, `relationships`, `plugin-cloud-storage`,
`fields`, `auth`, `queues`, `joins` (identical) and `uploads` (baseline environmental).

`test/__rs/adapter/adapter.int.spec.ts` (TS `sqliteAdapter` vs `withRustEngine`): native 20/20,
loopback 19 + 1 skipped (native-only connection guard test). `test/__rs/sqlite/client.int.spec.ts`
(Rust client vs `@libsql/client`) 31/31 and `payload.int.spec.ts` 5/5. Shadow
(`runShadowAll.mjs --candidate rs`, `PAYLOAD_CORE_ENGINE=ts`): `sqlite-bound-parameters-limit` 0
divergences (634 calls), `hooks` 0 (341). `cargo test -p payload-sqlite` 27/27.

| file                                                                  | baseline pass/fail/skip | rs pass/fail/skip | differing tests                                     | engine calls | upstream calls       |
| --------------------------------------------------------------------- | ----------------------- | ----------------- | --------------------------------------------------- | ------------ | -------------------- |
| test/__helpers/int/configImport.int.spec.ts                           | 1/0/0                   | 1/0/0             | 0                                                   | 0            | 0                    |
| test/__helpers/shared/getTestSuiteDir.int.spec.ts                     | 4/0/0                   | 4/0/0             | 0                                                   | 0            | 0                    |
| test/_community/int.spec.ts                                           | 2/0/0                   | 2/0/0             | 0                                                   | 11           | 0                    |
| test/access-control/int.spec.ts                                       | 84/0/0                  | 84/0/0            | 0                                                   | 893          | 0                    |
| test/access-control/postgres-logs.int.spec.ts                         | 0/0/6                   | 0/0/6             | 0                                                   | 0            | 0                    |
| test/admin-root/int.spec.ts                                           | 2/0/0                   | 2/0/0             | 0                                                   | 13           | 0                    |
| test/admin-routing/int.spec.ts                                        | 3/0/0                   | 3/0/0             | 0                                                   | 0            | 0                    |
| test/array-update/int.spec.ts                                         | 5/0/0                   | 5/0/0             | 0                                                   | 36           | 0                    |
| test/auth-api-key/int.spec.ts                                         | 11/0/0                  | 11/0/0            | 0                                                   | 132          | 0                    |
| test/auth/api-key/int.spec.ts                                         | 11/0/0                  | 11/0/0            | 0                                                   | 106          | 0                    |
| test/auth/custom-strategy/int.spec.ts                                 | 1/0/0                   | 1/0/0             | 0                                                   | 1            | 0                    |
| test/auth/first-user/int.spec.ts                                      | 1/0/0                   | 1/0/0             | 0                                                   | 7            | 0                    |
| test/auth/forgot-password-localized/int.spec.ts                       | 2/0/0                   | 2/0/0             | 0                                                   | 20           | 0                    |
| test/auth/int.spec.ts                                                 | 117/0/0                 | 117/0/0           | 0                                                   | 1090         | 0                    |
| test/auth/jwt/int.spec.ts                                             | 3/0/0                   | 3/0/0             | 0                                                   | 59           | 0                    |
| test/auth/removed-token/int.spec.ts                                   | 5/0/0                   | 5/0/0             | 0                                                   | 75           | 0                    |
| test/authorship/int.spec.ts                                           | 32/0/0                  | 32/0/0            | 0                                                   | 370          | 0                    |
| test/authorship/single-auth.int.spec.ts                               | 5/0/0                   | 5/0/0             | 0                                                   | 55           | 0                    |
| test/base-access/int.spec.ts                                          | 7/0/0                   | 7/0/0             | 0                                                   | 1            | 0                    |
| test/cli/int.spec.ts                                                  | 64/0/12                 | 46/18/12          | 18 (rerun alone: 0, 64/0/12)                        | 54           | 0                    |
| test/collections-graphql/int.spec.ts                                  | 50/0/0                  | 50/0/0            | 0                                                   | 481          | 0                    |
| test/collections-rest/bulk-delete-rollback.int.spec.ts                | 1/0/0                   | 1/0/0             | 0                                                   | 17           | 0                    |
| test/collections-rest/int.spec.ts                                     | 125/0/2                 | 125/0/2           | 0                                                   | 1648         | 0                    |
| test/collections-rest/tanstack-server-adapter.int.spec.ts             | 1/0/0                   | 1/0/0             | 0                                                   | 12           | 0                    |
| test/config/int.spec.ts                                               | 12/0/1                  | 12/0/1            | 0                                                   | 9            | 0                    |
| test/create-payload-app/int.spec.ts                                   | 11/0/0                  | 10/1/0            | 1 (rerun: TS fails the same 7 alone, environmental) | 0            | 0                    |
| test/custom-graphql/int.spec.ts                                       | 1/0/0                   | 1/0/0             | 0                                                   | 0            | 0                    |
| test/dashboard/documents.int.spec.ts                                  | 11/0/0                  | 11/0/0            | 0                                                   | 872          | 0                    |
| test/dashboard/int.spec.ts                                            | 3/0/0                   | 3/0/0             | 0                                                   | 0            | 0                    |
| test/dashboard/pins.int.spec.ts                                       | 4/0/0                   | 4/0/0             | 0                                                   | 677          | 0                    |
| test/dashboard/thumbnails.int.spec.ts                                 | 3/0/0                   | 3/0/0             | 0                                                   | 720          | 0                    |
| test/database/batch-processing.int.spec.ts                            | 2/0/2                   | 2/0/2             | 0                                                   | 10           | 0                    |
| test/database/copy.int.spec.ts                                        | 4/0/1                   | 4/0/1             | 0                                                   | 10           | 0                    |
| test/database/int.spec.ts                                             | 156/0/21                | 156/0/21          | 0                                                   | 2093         | 0                    |
| test/database/migrate-to-blocks-as-json/int.spec.ts                   | 1/0/0                   | 1/0/0             | 0                                                   | 2073         | 0                    |
| test/database/migrations-cli.int.spec.ts                              | 2/0/1                   | 2/0/1             | 0                                                   | 2            | 0                    |
| test/database/pg-replica/int.spec.ts                                  | 0/0/16                  | 0/0/16            | 0                                                   | 0            | 0                    |
| test/database/postgres-logs.int.spec.ts                               | 0/0/6                   | 0/0/6             | 0                                                   | 0            | 0                    |
| test/database/postgres-operator-handlers.int.spec.ts                  | 0/0/29                  | 0/0/29            | 0                                                   | 0            | 0                    |
| test/database/postgres-relationships-v2-v3-migration/int.spec.ts      | 0/0/1                   | 0/0/1             | 0                                                   | 0            | 0                    |
| test/database/postgres-vector.int.spec.ts                             | 0/0/4                   | 0/0/4             | 0                                                   | 0            | 0                    |
| test/database/sqlite-bound-parameters-limit.int.spec.ts               | 4/0/0                   | 4/0/0             | 0                                                   | 2            | 322 (client.execute) |
| test/database/up-down-migration/int.spec.ts                           | 0/0/1                   | 0/0/1             | 0                                                   | 0            | 0                    |
| test/dataloader/int.spec.ts                                           | 4/0/0                   | 4/0/0             | 0                                                   | 535          | 0                    |
| test/email-nodemailer/int.spec.ts                                     | 2/0/0                   | 2/0/0             | 0                                                   | 1            | 0                    |
| test/endpoints/int.spec.ts                                            | 10/0/0                  | 10/0/0            | 0                                                   | 12           | 0                    |
| test/endpoints/tanstack.int.spec.ts                                   | 1/0/0                   | 1/0/0             | 0                                                   | 1            | 0                    |
| test/field-access-context/int.spec.ts                                 | 11/0/0                  | 11/0/0            | 0                                                   | 108          | 0                    |
| test/field-paths/int.spec.ts                                          | 2/0/0                   | 2/0/0             | 0                                                   | 9            | 0                    |
| test/fields-relationship/int.spec.ts                                  | 4/0/0                   | 4/0/0             | 0                                                   | 143          | 0                    |
| test/fields/graphql-select.int.spec.ts                                | 1/0/0                   | 1/0/0             | 0                                                   | 76           | 0                    |
| test/fields/int.spec.ts                                               | 221/0/13                | 221/0/13          | 0                                                   | 2770         | 0                    |
| test/file-versioning/fileOperationManager.int.spec.ts                 | 1/0/0                   | 1/0/0             | 0                                                   | 8            | 0                    |
| test/file-versioning/int.spec.ts                                      | 51/0/7                  | 51/0/7            | 0                                                   | 2479         | 0                    |
| test/file-versioning/rename.int.spec.ts                               | 13/0/1                  | 13/0/1            | 0                                                   | 208          | 0                    |
| test/folders/int.spec.ts                                              | 6/0/0                   | 6/0/0             | 0                                                   | 160          | 0                    |
| test/form-state/int.spec.ts                                           | 27/0/0                  | 27/0/0            | 0                                                   | 46           | 0                    |
| test/globals/int.spec.ts                                              | 13/0/0                  | 13/0/0            | 0                                                   | 58           | 0                    |
| test/graphql/hidden-fields.int.spec.ts                                | 11/0/0                  | 11/0/0            | 0                                                   | 75           | 0                    |
| test/graphql/int.spec.ts                                              | 9/0/0                   | 9/0/0             | 0                                                   | 46           | 0                    |
| test/hierarchy/collection-specific.int.spec.ts                        | 14/0/0                  | 14/0/0            | 0                                                   | 157          | 0                    |
| test/hierarchy/int.spec.ts                                            | 36/0/0                  | 36/0/0            | 0                                                   | 1614         | 0                    |
| test/hmr/int.spec.ts                                                  | 0/0/4                   | 0/0/4             | 0                                                   | 0            | 0                    |
| test/hooks/int.spec.ts                                                | 44/0/1                  | 44/0/1            | 0                                                   | 246          | 0                    |
| test/joins/buildJoinAggregation.int.spec.ts                           | 0/0/8                   | 0/0/8             | 0                                                   | 0            | 0                    |
| test/joins/hierarchy.int.spec.ts                                      | 2/0/0                   | 2/0/0             | 0                                                   | 16           | 0                    |
| test/joins/int.spec.ts                                                | 115/0/8                 | 115/0/8           | 0                                                   | 2230         | 0                    |
| test/joins/queryPath.int.spec.ts                                      | 0/0/4                   | 0/0/4             | 0                                                   | 0            | 0                    |
| test/joins/whereMutation.int.spec.ts                                  | 1/0/0                   | 1/0/0             | 0                                                   | 79           | 0                    |
| test/kv/int.spec.ts                                                   | 3/1/0                   | 3/1/0             | 0                                                   | 1            | 0                    |
| test/lexical-mdx/int.spec.ts                                          | 89/0/0                  | 89/0/0            | 0                                                   | 0            | 0                    |
| test/lexical/lexical.int.spec.ts                                      | 124/0/0                 | 124/0/0           | 0                                                   | 1132         | 0                    |
| test/live-preview/int.spec.ts                                         | 18/0/0                  | 18/0/0            | 0                                                   | 201          | 0                    |
| test/llm-instructions/access.int.spec.ts                              | 12/0/0                  | 12/0/0            | 0                                                   | 120          | 0                    |
| test/llm-instructions/cli.int.spec.ts                                 | 11/0/0                  | 8/3/0             | 3 (rerun alone: 0, 11/0/0)                          | 92           | 0                    |
| test/llm-instructions/int.spec.ts                                     | 35/0/1                  | 35/0/1            | 0                                                   | 244          | 0                    |
| test/llm-instructions/slots.int.spec.ts                               | 5/0/0                   | 5/0/0             | 0                                                   | 64           | 0                    |
| test/loader/int.spec.ts                                               | 4/0/0                   | 4/0/0             | 0                                                   | 0            | 0                    |
| test/localization/int.spec.ts                                         | 158/0/0                 | 158/0/0           | 0                                                   | 1232         | 0                    |
| test/localization/localizeStatus.int.spec.ts                          | 4/0/7                   | 4/0/7             | 0                                                   | 9            | 0                    |
| test/locked-documents/bulk-delete.int.spec.ts                         | 1/0/0                   | 1/0/0             | 0                                                   | 28           | 0                    |
| test/locked-documents/int.spec.ts                                     | 13/0/0                  | 13/0/0            | 0                                                   | 91           | 0                    |
| test/login-with-username/int.spec.ts                                  | 4/0/0                   | 4/0/0             | 0                                                   | 25           | 0                    |
| test/mongodb-schema-build-cache/int.spec.ts                           | 0/0/7                   | 0/0/7             | 0                                                   | 0            | 0                    |
| test/payload-cloud/int.spec.ts                                        | 4/0/1                   | 4/0/1             | 0                                                   | 31           | 0                    |
| test/plugin-cloud-storage/int.compositePrefixes.int.spec.ts           | 0/0/2                   | 0/0/2             | 0                                                   | 0            | 0                    |
| test/plugin-cloud-storage/int.spec.ts                                 | 33/3/13                 | 33/3/13           | 0                                                   | 242          | 0                    |
| test/plugin-cloud-storage/versioning.int.spec.ts                      | 45/0/4                  | 45/0/4            | 0                                                   | 1001         | 0                    |
| test/plugin-ecommerce/int.spec.ts                                     | 36/0/0                  | 36/0/0            | 0                                                   | 664          | 0                    |
| test/plugin-form-builder/int.spec.ts                                  | 55/0/0                  | 55/0/0            | 0                                                   | 656          | 0                    |
| test/plugin-import-export/field-hooks.int.spec.ts                     | 0/29/0                  | 0/29/0            | 0                                                   | 0            | 0                    |
| test/plugin-import-export/hooks.int.spec.ts                           | 0/42/0                  | 0/42/0            | 0                                                   | 0            | 0                    |
| test/plugin-import-export/int.spec.ts                                 | 0/0/198                 | 0/0/198           | 0                                                   | 0            | 0                    |
| test/plugin-mcp/instructions.int.spec.ts                              | 10/0/0                  | 8/2/0             | 2 (rerun alone: 0, 10/0/0)                          | 331          | 0                    |
| test/plugin-mcp/int.spec.ts                                           | 237/0/1                 | 237/0/1           | 0                                                   | 3272         | 0                    |
| test/plugin-multi-tenant/int.spec.ts                                  | 21/0/0                  | 21/0/0            | 0                                                   | 837          | 0                    |
| test/plugin-nested-docs/int.spec.ts                                   | 12/0/0                  | 12/0/0            | 0                                                   | 765          | 0                    |
| test/plugin-redirects/int.spec.ts                                     | 3/0/0                   | 3/0/0             | 0                                                   | 16           | 0                    |
| test/plugin-search/int.spec.ts                                        | 21/0/0                  | 21/0/0            | 0                                                   | 727          | 0                    |
| test/plugin-sentry/int.spec.ts                                        | 0/0/1                   | 0/0/1             | 0                                                   | 0            | 0                    |
| test/plugin-seo/int.spec.ts                                           | 21/0/0                  | 21/0/0            | 0                                                   | 504          | 0                    |
| test/plugin-stripe/int.spec.ts                                        | 7/0/3                   | 7/0/3             | 0                                                   | 33           | 0                    |
| test/plugins/int.spec.ts                                              | 6/0/0                   | 6/0/0             | 0                                                   | 1            | 0                    |
| test/query-presets/int.spec.ts                                        | 13/0/1                  | 13/0/1            | 0                                                   | 225          | 0                    |
| test/queues/cli.int.spec.ts                                           | 2/0/0                   | 2/0/0             | 0                                                   | 137          | 0                    |
| test/queues/int.spec.ts                                               | 85/0/2                  | 84/1/2            | 1 (rerun alone: 0, 85/0/2)                          | 2818         | 0                    |
| test/queues/postgres-logs.int.spec.ts                                 | 0/0/2                   | 0/0/2             | 0                                                   | 0            | 0                    |
| test/queues/schedules-autocron.int.spec.ts                            | 1/0/0                   | 1/0/0             | 0                                                   | 31           | 0                    |
| test/queues/schedules.int.spec.ts                                     | 13/0/0                  | 13/0/0            | 0                                                   | 348          | 0                    |
| test/relationships/int.spec.ts                                        | 69/0/5                  | 69/0/5            | 0                                                   | 1963         | 0                    |
| test/sdk/int.spec.ts                                                  | 39/0/0                  | 39/0/0            | 0                                                   | 368          | 0                    |
| test/select/graphql-select.int.spec.ts                                | 4/0/0                   | 4/0/0             | 0                                                   | 21           | 0                    |
| test/select/int.spec.ts                                               | 78/1/36                 | 115/0/0           | 37 (baseline environmental)                         | 258          | 0                    |
| test/select/postgreslogs.int.spec.ts                                  | 0/0/2                   | 0/0/2             | 0                                                   | 0            | 0                    |
| test/sizes-to-variants/int.spec.ts                                    | 10/0/13                 | 10/0/13           | 0                                                   | 45           | 0                    |
| test/sort/int.spec.ts                                                 | 44/0/0                  | 44/0/0            | 0                                                   | 537          | 0                    |
| test/storage-azure/client-uploads/int.spec.ts                         | 0/13/0                  | 0/13/0            | 0                                                   | 0            | 0                    |
| test/storage-azure/int.spec.ts                                        | 0/0/7                   | 0/0/7             | 0                                                   | 0            | 0                    |
| test/storage-azure/publicAccess.int.spec.ts                           | 0/2/0                   | 0/2/0             | 0                                                   | 0            | 0                    |
| test/storage-azure/streamingUploads.int.spec.ts                       | 0/4/0                   | 0/4/0             | 0                                                   | 0            | 0                    |
| test/storage-gcs/int.spec.ts                                          | 0/0/6                   | 0/0/6             | 0                                                   | 1            | 0                    |
| test/storage-s3/client-uploads/int.spec.ts                            | 0/25/0                  | 0/25/0            | 0                                                   | 1            | 0                    |
| test/storage-s3/int.spec.ts                                           | 0/18/1                  | 0/18/1            | 0                                                   | 0            | 0                    |
| test/storage-s3/searchBeforeS3.int.spec.ts                            | 0/3/0                   | 0/3/0             | 0                                                   | 11           | 0                    |
| test/storage-vercel-blob/client-uploads/compositePrefixes.int.spec.ts | 0/1/0                   | 0/1/0             | 0                                                   | 1            | 0                    |
| test/storage-vercel-blob/client-uploads/int.spec.ts                   | 0/4/2                   | 0/4/2             | 0                                                   | 8            | 0                    |
| test/storage-vercel-blob/int.spec.ts                                  | 0/15/1                  | 0/15/1            | 0                                                   | 1            | 0                    |
| test/tags/int.spec.ts                                                 | 9/0/0                   | 9/0/0             | 0                                                   | 64           | 0                    |
| test/trash/int.spec.ts                                                | 102/0/5                 | 102/0/5           | 0                                                   | 2802         | 0                    |
| test/types/int.spec.ts                                                | 2/0/0                   | 2/0/0             | 0                                                   | 0            | 0                    |
| test/upload-transformers/int.spec.ts                                  | 37/0/0                  | 37/0/0            | 0                                                   | 281          | 0                    |
| test/uploads/int.spec.ts                                              | 154/1/0                 | 155/0/0           | 1 (baseline environmental)                          | 2169         | 0                    |
| test/uuid-v7/int.spec.ts                                              | 0/0/6                   | 0/0/6             | 0                                                   | 0            | 0                    |
| test/validate/int.spec.ts                                             | 112/0/0                 | 112/0/0           | 0                                                   | 666          | 0                    |
| test/versions/int.spec.ts                                             | 153/0/0                 | 153/0/0           | 0                                                   | 5687         | 0                    |

## Adapter matrix (test/dbAdapters.ts-compatible variants)

`runSuites.mjs --variant <v>` runs the suite through `test/__rs/harness/vitest.config.ts` with the
adapter the variant names (`test/__rs/harness/databaseAdapter.ts`, `sqliteArgs`; the shared
test/dbAdapters.ts and the generated test/databaseAdapter.js are not touched; child processes get
the same adapter):

| variant        | adapter                                                                        | `PAYLOAD_DATABASE` | TS baseline                                                            |
| -------------- | ------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------- |
| `default`      | `sqliteAdapter({ autoIncrement: true, client })` (dbAdapters `sqlite`)         | `sqlite`           | `.rs-baseline/sqlite-all.json`                                         |
| `transactions` | `default` plus `transactionOptions: {}` (how users enable sqlite transactions) | `sqlite`           | `sqlite-transactions.json`, `sqlite-transactions-2.json` (two TS runs) |
| `uuid`         | `sqliteAdapter({ idType: 'uuid', client })` (dbAdapters `sqlite-uuid`)         | `sqlite-uuid`      | `sqlite-uuid.json`                                                     |
| `uuidv7`       | `sqliteAdapter({ idType: 'uuidv7', client })` (dbAdapters `sqlite-uuidv7`)     | `sqlite-uuidv7`    | `sqlite-uuidv7.json`                                                   |

Each TS baseline was computed first (`--engine ts`, `PAYLOAD_ENGINE` / `PAYLOAD_CORE_ENGINE`
unset), files whose TS run died without a result (4 in `uuidv7`, under load) and the two files of
open item 22 rerun and patched in. rs runs compare every test's status with every reference run;
each differing file was rerun alone next to a fresh TS reference run.

| variant        | rs files identical (full run) | after reruns alone                   | differing files and root cause                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`      | 128/135 (15:06 build)         | 135/135 (7 files rerun)              | none (see "Results": shared generated adapter file, load, environment, baseline-environmental)                                                                                                                                                                                                                                                                                                                                                 |
| `uuid`         | 127/135 (11:45 build)         | 135/135 (9 files rerun, 15:0x build) | none: `cli`, `uploads` (two runners shared `test/cli/generated` and media), `endpoints/tanstack`, `database/postgres-logs`, `create-payload-app` (vitest died without a result under load), `queues` (the TS baseline failed the worker-recovery test under load; TS rerun and rs pass), `plugin-cloud-storage` (another agent's core runtime regression at the time, passes with `--core ts` and on later builds), the two open item 22 files |
| `uuidv7`       | 133/135 (11:45 build)         | 135/135 (2 files rerun)              | none: `cli` (TS baseline had 4 shared-directory failures; TS rerun and rs pass 64), `plugin-cloud-storage` (as in `uuid`)                                                                                                                                                                                                                                                                                                                      |
| `transactions` | 122/135 (15:06 build)         | 124/135 (2 files rerun)              | **11 files where rs passes tests that fail in both TS runs** (`plugin-mcp` 233 vs 10 passed, `queues` 63 vs 29, `access-control`, `auth`, `dashboard/documents`, `database/int`, `sqlite-bound-parameters-limit`, `plugin-ecommerce`, `sdk`, `uploads`, `queues/schedules`; `queues` also fails 5 tests TS passes); `database/migrations-cli` (2/0/1 alone, as TS) and `create-payload-app` (TS fails the same 7 alone) match when rerun       |

**`transactions`.** The TS reference itself is nondeterministic: its two full runs differ in 8
files (e.g. `lexical` 124 vs 5 passed, `database` 125 vs 61) and total 2483 / 743 / 684 vs 2281 /
942 / 687 (rs: 2868 / 358 / 681). The failures are `SQLITE_BUSY` cascades: libsql opens a new
connection for the client whenever `transaction()` takes the current one, and has no busy
timeout, so a `BEGIN IMMEDIATE` (or a write) on another connection while a transaction holds the
write lock fails at once, and drizzle's `beginTransaction` wrapper swallows a failed `COMMIT`
(writes then silently disappear, e.g. `plugin-mcp`'s API keys, so every later request is 401).
Two root causes were found:

1. **Fixed (open item 21):** libsql-js finalizes a statement only when V8 collects its JS
   `Statement`; one whose step failed with `SQLITE_BUSY` stays active and keeps its connection's
   locks until then (a forced GC releases it), which is also why the TS runs differ from each
   other. The Rust client now keeps such statements until a native-finalized JS object standing
   for them is collected (differential scenario in `test/__rs/sqlite`, byte-identical errors).
2. **Open:** the remaining gap is systematic, not flaky: the same tests fail in both TS runs and
   pass with rs, with the TS core (`--core ts`) and with the loopback engine (upstream TS data
   methods on the Rust client), so it is in the Rust client / connection layer, not the engine.
   In TS a file stays locked after its first `SQLITE_BUSY` (every later commit fails), while rs
   recovers after one more failure. Minimal client and drizzle level probes (concurrent
   transactions, failed `BEGIN` then reads, reads on committed transaction connections) all match
   upstream, so the remaining difference is in what keeps locks alive longer in libsql-js
   (candidates: the lifetime of other un-reset statements or of transaction connections until GC,
   which `Conn::retire` releases early). Next step: a statement-level trace of one TS cascade
   (`plugin-mcp` "should keep simultaneous requests separate" and the test after it).

## Open items

| #   | item                                                                                                                                                                                                                         | root cause                                                                                               | owner / state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | database/sqlite-bound-parameters-limit replaces `payload.db.drizzle.$client.execute`                                                                                                                                         | engine SQL does not go through a JS `execute`                                                            | **glue, fixed**: a replaced `execute` runs the upstream TS method. The suite then runs mostly upstream, so the engine's `limitedBoundParameters` path has its own differential: `adapter.int.spec.ts` "limitedBoundParameters" compares every statement's SQL and bound parameter count (SQLite statement trace of the candidate's connections, `PAYLOAD_SQLITE_TRACE=true`) with the TS adapter's                                                                                                                                                                                                                                                                                                                                                    |
| 2   | NOT NULL error kind of `insert ... returning`                                                                                                                                                                                |                                                                                                          | engine, fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3   | `queryDrafts` tie order                                                                                                                                                                                                      |                                                                                                          | engine, fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | own `undefined` properties of the raw schema                                                                                                                                                                                 |                                                                                                          | **fixed**: engine `undefinedProperties`, applied by the glue (`adapter.int.spec.ts`, native and loopback)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | concurrent operations                                                                                                                                                                                                        |                                                                                                          | engine: statement-granular steps (ENGINE_CONTRACT.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | replaced adapter internals, drizzle `logger`, `operatorHandlers`                                                                                                                                                             | the engine implements them internally                                                                    | **glue, fixed**: the call runs the upstream TS method                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7   | caller-visible argument mutations                                                                                                                                                                                            |                                                                                                          | **fixed**: `createVersion`'s `select.updatedAt` (glue), `updateGlobal`'s `data.createdAt` (engine `mutations`, applied by the glue). Open: mutations made before a call fails are lost when the engine reports them (`updateGlobal` failing after `upsertRow` started); `transformForWrite`'s mutations of `data` (ENGINE_CONTRACT.md)                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8   | `lastWriteTimestamp` (`markWrite`)                                                                                                                                                                                           | not set by the engine                                                                                    | **glue**, see "markWrite" above. Not derivable: `updateMany` / `updateJobs` / `updateOne` without an id with `returning: false` (not marked); a failed select inside `upsertRow` of a method that also selects before it (not marked). The value is `Date.now()` after the call (equal under fake timers). Only read for read-replica routing, which sqlite has not                                                                                                                                                                                                                                                                                                                                                                                   |
| 9   | error identity                                                                                                                                                                                                               |                                                                                                          | **fixed**: `DrizzleQueryError` is db-sqlite's drizzle-orm class; host function errors of `call` are rethrown per function id (FIFO). Rust client error classes as causes, as for every rs-mode client error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | schema hooks                                                                                                                                                                                                                 |                                                                                                          | **fixed**: `setLiveSchema` (see wire format). Columns added only to drizzle tables (`afterSchemaInit` `extendTable`) are now written like upstream (engine): `adapter.int.spec.ts` compares every statement strictly (it asserted the exact old difference, the missing column in `insert ... returning`, until the engine change made it fail)                                                                                                                                                                                                                                                                                                                                                                                                       |
| 11  | shadow harness: its candidate `execute` wrapper `candidateClientCall` was treated as transparent by name                                                                                                                     |                                                                                                          | **fixed**: the wrapper registers itself (`registerTransparentClientMethod(wrapper, () => !redirectedOverride())`), the name check is gone. Shadow `sqlite-bound-parameters-limit` 0 divergences (634 calls; the candidate runs upstream exactly while the test's override must run), `hooks` 0 (165 engine calls, 0 upstream)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 12  | connection ownership                                                                                                                                                                                                         | one process-wide queue made `same_queue` always true                                                     | **fixed (payload-sqlite)**: every `ConnId` records its database (canonical file path with symlinks resolved, shared-cache memory path, or the opening client for private in-memory databases; transactions inherit their client's), `worker::same_database` is the guard of `SqliteEngine.call` (`adapter.int.spec.ts` "reject connections of another database"; `ids_record_their_database` covers the paths `createClient` produces and a symlinked file). Through the glue the guard cannot trigger (it always attaches the call's own client); it protects the raw napi API. `file:` URI branches of `database_of` are reached only by the raw `open_client` API                                                                                  |
| 13  | `createClient` opened and keyed the file outside the queue                                                                                                                                                                   |                                                                                                          | **fixed**: open, cipher, key and the `SELECT 1` check run as one queued job, after every earlier call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 14  | statement getters ran before `#getDb()` / the transaction's closed check                                                                                                                                                     |                                                                                                          | **fixed**: statements whose reads are observable (getters, proxies, accessor elements, named args) run upstream's order synchronously (`test/__rs/sqlite` "statement reads after the closed check")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 15  | `conn::compat_message` is an identity no-op                                                                                                                                                                                  |                                                                                                          | callers (payload-sql-engine, payload-sql-find) can drop it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 16  | possible deadlock: a JS function called during a step making a blocking client call while the step's lend held the process queue                                                                                             |                                                                                                          | **gone with the engine's current model**: every statement is its own queue job and nothing is held between statements (ENGINE_CONTRACT.md), so JS functions may use the clients synchronously                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 17  | `createGlobal` inside a transaction whose `req.transactionID` is still a promise, when the transaction's client `execute` was replaced (upstream fallback decided after the await)                                           | the glue stamps `data.createdAt` before awaiting (upstream's order), the upstream method stamps it again | glue, accepted: only with a pending `transactionID` and a replaced transaction `execute`; a resolved `transactionID` is checked before the stamp                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 18  | `deleteOne` with `returning: false` costs a read `transform` + encoding per document                                                                                                                                         | the glue needs to know whether a document matched (`markWrite`), the engine's reply has no flag for it   | glue: no longer decodes the document. Engine: a `matched` flag (or a `mutations`-like side channel) in the reply would let the glue send `returning: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 19  | `setLiveSchema` failed while calls held the engine (`Arc::get_mut`)                                                                                                                                                          |                                                                                                          | **fixed**: engine swaps the `Arc` (calls keep their snapshot); the glue never fails a call on it (wire format, "hot reload" test)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | host function errors no call claimed stayed in the table forever                                                                                                                                                             |                                                                                                          | **fixed** (glue): emptied whenever no engine call is in flight. Two concurrent calls whose functions of the same id throw are matched oldest first, which is their rejection order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 21  | libsql-js finalizes a statement only when its JS `Statement` is garbage collected; one whose step failed with `SQLITE_BUSY` stays active and keeps its connection's locks until then                                         | the Rust client finalized every statement at once                                                        | **fixed (payload-sqlite + client)**: client calls run under `conn::with_statement_retention`; a failed statement that `sqlite3_stmt_busy` reports active is kept and handed to JS as a napi external whose native finalizer finalizes it (the same kind of object as the binding's `Statement`). E.g. after a failed `BEGIN IMMEDIATE`, a client read keeps a shared lock and the open transaction's `COMMIT` fails with `SQLITE_BUSY` / `cannot commit transaction - SQL statements in progress`, as upstream. `test/__rs/sqlite` "busy statements stay active until garbage collected" (fails against the previous addon), `busy_statements_stay_active_until_released`. Engine statements (no JS object upstream either way) are finalized at once |
| 22  | `runSuites.mjs` output names collided (`test/auth-api-key/int.spec.ts` and `test/auth/api-key/int.spec.ts` both wrote `test_auth_api_key_int_spec_ts.*`, so one file's result replaced the other's in every earlier summary) |                                                                                                          | **fixed**: injective names (`/` → `__`, `_` → `_u`, others `_x` + hex), a collision check, and both files rerun for every variant baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
