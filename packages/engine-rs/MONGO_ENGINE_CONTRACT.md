# MongoDB engine contract (Rust ⇄ TS)

Binding interface between `crates/payload-mongo-*` + `crates/payload-node/src/mongo_engine.rs`
(Rust) and `packages/engine-rs/src/mongo-adapter/**` (TS). Either side may extend it;
breaking changes are written here first. Mirrors `ENGINE_CONTRACT.md` (SQLite).

## Boundary (stage 1)

`@payloadcms/db-mongodb` logic moves to Rust: schema description (`models/buildSchema.ts`
and friends), queries (`queries/*`), projection, sort, joins/aggregation pipelines
(`utilities/buildJoinAggregation.ts`, `resolveJoins.ts`, `aggregatePaginate.ts`),
read/write transforms (`utilities/transform.ts`) and every data method
(`find.ts` … `updateJobs.ts`, `upsert.ts`, `queryDrafts.ts`, versions, globals).

**I/O stays on the JS mongoose models.** Rust builds each database call
(`{ model, method, filter, update, pipeline, options }`) and the TS host executes it on the
mongoose `Model` of that collection, on the JS thread, with the session resolved exactly
like upstream `getSession(adapter, req)`. Reasons:

- mongoose casts every filter/update against the schema (strings to ObjectId, Dates,
  numbers, `strictQuery`, update operators). Executing through the same models keeps
  that casting byte-identical without porting mongoose.
- `payload.db.collections[slug]`, `payload.db.versions`, `payload.db.connection`,
  `payload.db.mongoose` are user-facing mongoose objects. They stay the real ones, and
  user overrides/spies on them keep affecting behaviour exactly like upstream.
- Transactions use mongoose `ClientSession`s from `beginTransaction`; sharing them with
  a second (Rust) driver is not possible without protocol-level hacks.

Stage 2 (only after stage 1 parity): evaluate porting mongoose casting and moving I/O to the
Rust `mongodb` driver. Not part of this contract.

## Selection (no user-facing API change)

- `packages/engine-rs` exports `withRustMongoEngine(adapterObj)`, wrapping the object returned
  by `mongooseAdapter(args)`.
- `@payloadcms/db-mongodb`'s `mongooseAdapter(args)` returns `withRustMongoEngine(obj)` when
  `process.env.PAYLOAD_ENGINE === 'rs'`, otherwise upstream unchanged.
- `engine-rs` never imports `@payloadcms/db-mongodb` (no cycle).

## Values

Typed values cross the boundary in the tree encoding and are decoded into typed Rust values
(never compared as strings). Canonical markers, implemented in `crates/payload-engine/src/bson.rs`
and `js.rs` (owned by mongoengine; everyone else consumes this API):

| JS value | marker | Rust |
|---|---|---|
| bson `ObjectId` | `{"$oid": "<24 lowercase hex>"}` | `BsonValue::ObjectId([u8; 12])`, `JsVal::object_id` / `as_object_id` |
| `RegExp` | `{"$regex": {"source": "…", "flags": "…"}}` | `BsonValue::RegExp { source, flags }`, `JsVal::regexp` |
| bson `Decimal128` | `{"$decimal": "<toString()>"}` | `BsonValue::Decimal128`, `JsVal::decimal128` |
| bson `Binary` | `{"$binary": {"base64": "…", "subType": <0..=255>}}` | `BsonValue::Binary { sub_type, bytes }`, `JsVal::binary` |
| Node `Buffer` / `Uint8Array` (not a bson `Binary`) | `{"$buffer": "<base64>"}` | `BsonValue::Buffer`, `JsVal::buffer` |
| host-held JS object (see below) | `{"$hostObject": n}` | `JsVal::host_object(n)` |
| `Date`, `bigint`, `undefined`, non-finite numbers | `$date`, `$bigint`, `$undefined`, `$num` (unchanged) | `TypedValue` |

- `$buffer` is canonical for Buffers (decision 2026-11-01 14:45; `$binary` without `subType`
  is NOT used). `packages/engine-rs/src/mongo-adapter/codec.ts` must follow this table.
- All of these keys are reserved: TS `serializeForEngine` and every encoder `$obj`-escape a user
  object whose only key is one of them. The Mongo markers are decoded only by the bson-aware
  decoders (`decode_graph_bson`, `decode_value_bson`); the SQLite decoders keep treating them as
  plain data, so SQLite behaviour is unchanged.
- `{"$hostObject": n}` is an opaque handle to a JS object the host keeps for the current `call`
  only (the mongoose `ClientSession` returned by the `getSession` op, the original error a host
  op threw, BSON types the engine never needs to inspect such as `Long`/`Int32`/`Timestamp`/
  `Code`/`DBRef`/`MinKey`/`MaxKey`/non-lean mongoose docs). Rust never inspects or branches on it
  and never keeps it past the call; the host frees its table when the call settles, and resolves
  handles that appear in the call's result back to the original objects.

## Host ops (final)

A host op is handed to the host when the Rust code creates it (like evaluating `Model.find(...)`),
in the TS call order; Rust awaits it where the TS awaits it (`Promise.all` = `join_all`, several
ops may be in flight: `aggregatePaginate`, `resolveJoins`). Request JSON (values are trees in the
boundary encoding, "Values"), one of:

- `{"op": "model", "model": {"kind": "collections" | "versions" | "globals", "slug"?: string},
  "method": "<Model static>", "args": [tree…], "chain"?: [["lean", []], ["select", [tree]], …],
  "post"?: "toObject", "fnOptions"?: [{"arg": i, "key": k, "call": <model request>}]}`: the model is
  resolved at op time from `adapter.collections[slug]` / `adapter.versions[slug]` /
  `adapter.globals` (user overrides and spies apply), `Model[method](...args)`, `chain` applied in
  order, awaited once. `post: "toObject"` maps hydrated docs (`Model.create([data], opts)`) through
  `doc.toObject()`. `fnOptions` assigns `args[i][k] = () => Promise.resolve(<call's query, built
  but not awaited>)` (mongoose-paginate-v2 `useCustomCountFn`); the options object already holds
  `k: undefined` where the TS assigns it, so the key keeps the TS position. `Model.paginate` is a
  host op (mongoose-paginate-v2 is not ported).
- `{"op": "getSession"}`: upstream `getSession(adapter, req)` on the call's original `req` (awaits
  a promise `transactionID`, drops an orphaned session), issued where upstream awaits it; result
  `{"$hostObject": n}` or `undefined`. Only issued when the call has a `req` (`hasReq`).
- `{"op": "modelInfo", "model": {…}}`: `{ collectionName, modelName }` read at op time (used only
  when the context has no `models`).
- `{"op": "adapterCall", "method": m, "args": tree, "fromCallArgs"?: [key…]}`:
  `adapter[m]({ ...args, req })` through the adapter object (`upsert` → `this.updateOne`), `req`
  the call's original `req` (own key). Keys listed in `fromCallArgs` take the call's original
  argument values (same objects, in the position of `args`), so the inner call's mutations of
  `data` reach the caller like upstream.
- `{"op": "logError", "msg": s}`: `payload.logger.error(msg)` (`create` with an invalid
  `allowIDOnCreate` id).

Answer: the op's promise resolves with `{"ok": tree}` (values the engine has no representation
for, e.g. non-lean documents, `Long`, `ClientSession`, are `{"$hostObject": n}`), or rejects with an
`Error` whose message is `{"error": {"handle": n, "isObject": bool, "name"?, "message"?, "code"?,
"keyValue"?}}` (a key is present iff it is `in` the thrown value; values are trees). Rust turns it
into an `EngineError` with `thrown: Some(HostThrow { handle, is_object, message, code, key_value })`
(crates/payload-engine/src/error.rs), which every crate propagates with `?`; upstream
`handleError` (payload-mongo-transform `handle_host_error`) reads the properties, anything else is
rethrown as the original value.

`Model.buildQuery` (the schema static of `getBuildQueryPlugin`) is ported (payload-mongo-query
`schema_build_query`); no host op.

## Call context and arguments

- `argsJson`: the method's argument without `req`, tree-encoded (`encodeMongoTree`).
- `contextJson`: `{ adapter: { allowAdditionalKeys, allowIDOnCreate, collation,
  disableFallbackSort, disableIndexHints, useBigIntForNumberIDs, useJoinAggregations,
  usePipelineInSortLookup }, hasReq, models: { collections: { [slug]: Model.collection.name },
  versions: { [slug]: … } }, now: Date.now(), withMutations: true }`, read live per call. `now` is
  the clock of the `new Date()` stamps (`createdAt` of the create methods, `updatedAt` of the write
  transform), so faked JS clocks apply; without it the system clock is used. `handleError`'s
  `req.payload.config.localization` is the engine's config (when `hasReq`).
- Result: `{ "result": tree, "mutations": [[["data" | "versionData"], tree]] }`: the caller's
  `data` / `versionData` as the method left it (write transform, `createdAt`, `_id`, `delete
  data.log`, …), reported only when it changed; the glue syncs it into the caller's object in place.
- Errors: the call rejects with an `Error` whose message is `{ "rethrow": n, "mutations"? }` (the
  original value a host op threw) or `{ name, message, data, "mutations"? }`: `ValidationError`
  (`data = { collection, errors: [{ path }], global }`, no `id`, messages filled by the glue with
  `req?.t ? req.t('error:valueMustBeUnique') : 'Value must be unique'`), `BSONError` (rebuilt with
  the adapter's bson class), `APIError`, JS built-ins, `HostError` (`JS function <id> threw`).

## napi surface (`crates/payload-node/src/mongo_engine.rs`, implemented)

```ts
class MongoEngine {
  /** Decodes `graphJson` (`serializeForEngine({ blocks, collections: { [slug]: { config, customIDType } }, config })`) once. */
  static create(graphJson: string, optionsJson: string, callFunction: (id: number, argJson: string) => string): MongoEngine
  /** payload-mongo-schema's description of the engine's graph (`optionsJson`: collectionsSchemaOptions, autoPluralization, useBigIntForNumberIDs, isCacheEnabled). */
  schemaDescription(): string
  /** Runs one data method (`METHODS` in crates/payload-mongo-engine/src/lib.rs). */
  call(method: string, argsJson: string, contextJson: string, host: (opJson: string) => Promise<string>): Promise<string>
}
```

- `call` polls the method's Rust future on the JS thread: the first poll runs inside `call` (the
  synchronous start of the TS async method), every later poll from the reaction of the host op
  promise that settled, i.e. in the microtask where the TS `await` continues. No threads.
- Config functions (`$fn`, e.g. `join.getForeignPath`) are called synchronously through
  `callFunction` (`{"$hostError": true}` when they throw → `HostError`).
- Data methods: every method of `packages/db-mongodb/src` listed in "Boundary"; transactions
  (`beginTransaction` / `commitTransaction` / `rollbackTransaction`), connect, init, migrations
  stay TS.

## Verification (mongoengine)

- `cargo test -p payload-mongo-engine` (unit + `tests/call.rs`: `MongoEngine::call` envelope,
  session op, duplicate key → `ValidationError` with mutations, rethrow by handle, APIError).
- Differential replay: `node test/__rs/mongo-engine/record.mjs [--no-aggregations] <specs…>`
  records upstream TS data method calls (args, context, every mongoose call with result / thrown
  error, `useCustomCountFn` call, `getForeignPath` calls, result / error, caller `data` after the
  call) into `/tmp/rs-mongoengine-fixtures`; `PAYLOAD_RS_MONGO_ENGINE_FIXTURES=<dir> cargo test -p
  payload-mongo-engine --test replay -- --ignored --nocapture` replays them through the full engine
  (data methods + query / transform / joins crates) and requires exact equality of every host op
  request, the result / error and the mutated argument. `replay_detects_altered_recordings` is the
  negative control; zero replayed calls fail the test.
- End to end: `node test/__rs/mongo-adapter/runSuites.mjs --native --addon <addon> --baseline-dir
  <TS results>` (mongoadapter's glue + this addon on the upstream int suites).

## Test setup

- MongoDB 8.0.8 replica set `rs0` on `localhost:27018` with user `payload`/`payload`
  (matches upstream's default `MONGODB_URL`). Data in `/tmp/rs-mongo-data`, log `/tmp/rs-mongo.log`.
- Every run must use its own database name: `MONGODB_URL=mongodb://payload:payload@localhost:27018/<unique>?authSource=admin&directConnection=true&replicaSet=rs0`
  (the suites drop their database on start). Drop your databases when done (disk is tight).
