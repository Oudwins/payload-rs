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

# per-test comparison with the baseline (own db file per suite, engine call counts per suite)
node test/__rs/adapter/runSuites.mjs --addon /tmp/my-addon/payload-engine.node \
  --out /tmp/rs-runs test/hooks/int.spec.ts test/database/int.spec.ts ...

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
  - A JS callback that threw (`{"$hostError":true}`) is rethrown as the original error.

## Results (2026-11-01, addon built 06:36 from shared target, TZ=UTC)

Native engine, `runSuites.mjs` per-test comparison with the baseline. 107 int spec files (all
baseline files that ran sqlite tests, except `storage-*`, which fail on missing local services in
the baseline too). Totals: **107/107 files, every baseline-passing test passes except 1**.

| suite                                                                               | baseline pass/fail/skip | rs pass/fail/skip | engine calls | shadow divergences                                                 |
| ----------------------------------------------------------------------------------- | ----------------------- | ----------------- | ------------ | ------------------------------------------------------------------ |
| test/access-control/int.spec.ts                                                     | 84/0/0                  | 84/0/0            | 894          | 0 (1283 calls)                                                     |
| test/auth/int.spec.ts                                                               | 117/0/0                 | 117/0/0           | 1098         | 0 (1347 calls)                                                     |
| test/collections-rest/int.spec.ts                                                   | 125/0/2                 | 125/0/2           | 1706         | 0 (2266 calls)                                                     |
| test/database/int.spec.ts                                                           | 156/0/21                | 156/0/21          | 2065         | 207 before the context fix (all from `allowIDOnCreate`, see below) |
| test/fields/int.spec.ts                                                             | 221/0/13                | 221/0/13          | 2768         | 0 (6231 calls)                                                     |
| test/globals/int.spec.ts                                                            | 13/0/0                  | 13/0/0            | 58           | 0                                                                  |
| test/hooks/int.spec.ts                                                              | 44/0/1                  | 44/0/1            | 155          | 0                                                                  |
| test/joins/int.spec.ts                                                              | 115/0/8                 | 115/0/8           | 2233         | 0                                                                  |
| test/localization/int.spec.ts                                                       | 158/0/0                 | 158/0/0           | 1216         | 0                                                                  |
| test/relationships/int.spec.ts                                                      | 69/0/5                  | 69/0/5            | 1947         | 0                                                                  |
| test/select/int.spec.ts                                                             | 78/1/36                 | 115/0/0           | 231          | 0                                                                  |
| test/sort/int.spec.ts                                                               | 44/0/0                  | 44/0/0            | 576          | 0                                                                  |
| test/uploads/int.spec.ts                                                            | 154/1/0                 | 155/0/0           | 2166         | 0                                                                  |
| test/versions/int.spec.ts                                                           | 153/0/0                 | 153/0/0           | 5662         | 0 (6966 calls)                                                     |
| test/database/sqlite-bound-parameters-limit.int.spec.ts                             | 4/0/0                   | 3/1/0             | 20           | not run                                                            |
| 92 further files (plugins, queues, trash, lexical, hierarchy, file-versioning, ...) | all equal               | all equal         | 29,620       | not run                                                            |

`select` / `uploads`: the baseline failures were environmental (`EEXIST` on a media file, which
then skipped the rest of the select file); both pass on TS too when rerun.
`database/int.spec.ts` failed 3 `allow ID on create` tests until the engine read the live
`allowIDOnCreate` from `contextJson` (fixed in the 06:36 build). `file-versioning/*` failed 18
tests only when its two spec files ran concurrently (shared media dirs); the runner now never runs
files of one suite directory together, and both pass (51/51, 13/13).

Loopback (glue only, `--loopback`): the same 14 priority suites match the baseline exactly
(58 to 5,691 calls each). The loopback shadow run reported 0 divergences for 8 of the 9 suites it
completed validly (select / sort were invalidated by a concurrent edit of `serialize.ts`); the one
loopback shadow divergence (`auth` "login session expires ... narrow time-frame", parallel logins)
is a timing-dependent race that does not occur with the native engine.

## Open items

| #   | test / symptom                                                                                                                                                            | root cause                                                                                                                                                                                                                                                                                 | owner                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| 1   | `database - sqlite bound parameters limit > should not use bound parameters ... if limitedBoundParameters: true` (first `rejects` resolves)                               | the test monkeypatches `payload.db.drizzle.$client.execute` to throw on > 100 bound params; engine SQL runs in Rust and never goes through the JS client's `execute`. Structural: only fixable by routing engine statements through JS.                                                    | design (engine), accepted divergence    |
| 2   | `adapter.int.spec.ts` "DrizzleQueryError": NOT NULL violation of an `insert ... returning`                                                                                | libsql (and the Rust TS client) raise the raw binding error (`kind: 'native'`: plain `Error` with `code`, `rawCode`, `libsqlError: true`) for statements whose error surfaces while stepping a returning statement; the engine reports `kind: 'sqlite'` (LibsqlError + SqliteError cause). | engine (payload-sql-upsert error kind)  |
| 3   | `adapter.int.spec.ts` "create, read, update and delete": `find({ draft: true })` (queryDrafts) with equal `createdAt` returns rows `[.., 2, 1]` on TS, `[.., 1, 2]` on rs | tie order of the versions query differs: the generated SQL / plan is not identical to drizzle's                                                                                                                                                                                            | engine (find / queryDrafts)             |
| 4   | `adapter.int.spec.ts` `test.fails` "own undefined properties of the raw schema"                                                                                           | `rawSchema()` JSON drops own properties holding `undefined` (e.g. `rawTables[t].indexes[i].unique`), which upstream keeps (observable by `beforeSchemaInit` hooks and drizzle's `dequal` push cache)                                                                                       | engine (schema JSON encoding)           |
| 5   | concurrent operations                                                                                                                                                     | one engine call is one queue job (atomic); upstream interleaves the statements of concurrent operations at every `await`. Results of racing read-modify-write tests can differ by timing.                                                                                                  | design, documented                      |
| 6   | spies on adapter internals                                                                                                                                                | upstream data methods call `this.updateOne` (upsert), `this.deleteWhere`, `this.countDistinct`; replacing those on `payload.db` no longer affects engine methods                                                                                                                           | design, documented                      |
| 7   | caller-visible mutations                                                                                                                                                  | glue reproduces `create` / `createGlobal` / `updateJobs` mutations of `data`; `updateGlobal`'s create path (`data.createdAt` set when no global row exists yet) is not reproduced (needs a DB read)                                                                                        | engine could return it; low impact      |
| 8   | `lastWriteTimestamp` (`markWrite`) not set                                                                                                                                | only used for read-replica routing, which sqlite has not                                                                                                                                                                                                                                   | glue, no impact                         |
| 9   | error identity                                                                                                                                                            | `DrizzleQueryError` is a shape-identical copy (drizzle-orm is not resolvable from engine-rs, and two drizzle-orm copies exist anyway), so `instanceof` drizzle's class is false; JS callback errors under concurrent calls are attributed first-in-first-out                               | glue, low impact                        |
| 10  | schema hooks                                                                                                                                                              | `beforeSchemaInit` / `afterSchemaInit` changes to drizzle tables are visible to TS (push, `payload.db.drizzle`) but not to the engine's retained schema                                                                                                                                    | engine/design (all current suites pass) |
