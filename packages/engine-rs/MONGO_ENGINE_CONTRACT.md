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

## Stage 1b decision (2026-11-01 18:50): live-object engine

The gpt-6.1-sol reviews of stage 1 (`.rs-baseline/review-mongo-*-sol.md`) found ~30
observable differences with one root cause: the stage-1 crates work on serialized copies behind
JSON host ops. Lost: object identity/prototypes (class-instance query values, caller-retained
arrays, `_bsontype` forgery, `__proto__`/prototype-named fields), mutation timing (TS mutates
`data` before its first await), await points (Rust ran through awaits TS yields at, so a session
assigned meanwhile was missed), separate clock readings, model capture timing, getter exceptions,
fail-fast `Promise.all`, lazy `toObject()`.

So the Mongo engine is rebased on the core engine's strategy B runtime (`RUST_CORE_DESIGN.md`,
`crates/payload-core-runtime`): Rust operates on the LIVE JS objects (where, data, req, docs,
mongoose models/queries/sessions) through Node-API on the JS thread, awaits exactly where the TS
awaits (`await_js`, never inlining a ready future across an upstream await), composes concurrency
only through JS `Promise.all`, reads the clock wherever upstream does, and calls mongoose methods
directly on the models resolved at the same points upstream resolves them. There is no JSON
host-op protocol and no mutation log: mutations happen in place, when upstream makes them.

- New crates (one owner each): `payload-mongo-live` (shared live helpers + read methods),
  `payload-mongo-live-write`, `payload-mongo-live-query`, `payload-mongo-live-transform`,
  `payload-mongo-live-joins`; model building moves onto the same runtime in `payload-mongo-schema`.
- Pure computations of the stage-1 crates (regex escaping, pagination arithmetic, path parsing)
  may be reused; once the live engine reaches parity, the stage-1 JSON engine is removed from the
  production path (one implementation per behaviour).
- Verification: live differentials in the style of `test/__rs/core-runtime/` (same live inputs to
  TS and Rust, proxies recording every property read/write on args and docs, spied mongoose
  models recording calls and their order, microtask/settle order, error identity), plus the
  existing recorded corpora as regression, plus the full upstream suite and the shadow harness.

## Live helpers (`crates/payload-mongo-live`, owner livereads)

Shared by every `payload-mongo-live*` crate (depend on `payload-mongo-live = { path =
"../payload-mongo-live" }`; all functions run on the JS thread inside the core runtime, `Local`s
only within the current synchronous segment, `Val` across awaits). One implementation per
behaviour: do not re-port these in another crate.

- JS host: `packages/engine-rs/src/mongo-live/host.ts` `createMongoLiveHost({ mongoose })`
  (`mongoose` = the module `@payloadcms/db-mongodb` imports; default: resolved from db-mongodb's
  location). Installed by `mongoLiveBinding().init(host, { upstreamDeps? })` after
  `getCoreRuntime()` and `getCoreQueryBinding()`; `getMongoLive()` in
  `packages/engine-rs/src/mongo-live/index.ts` does all of it. Other live crates whose bindings
  need these helpers: initialize via `getMongoLive()` first (same addon instance).
- `host`: `call(name, args)` / `call_val` (host helper by name), `get` / `get_val` / `get_key` /
  `get_key_optional` / `opt` (`o.k`, `o[k]`, `o?.[k]`: getters, proxies, V8 TypeErrors), `set` /
  `set_key` (assignment into an EXISTING object: strict [[Set]], setters run, failure throws like
  TS module code), `del` (ONE strict `delete`: one `deleteProperty` trap call, a false result
  throws V8's TypeError, never retried), `has` / `has_key` (`k in o`, the operator's intrinsic
  TypeError for primitives), `call_method(obj, name, args, expr)` (`obj.name(...)`, `this ===
  obj`), `call_fn` (both throw the realm's intrinsic `TypeError: <expr> is not a function`, never
  `globalThis.TypeError`), `promise_all(array)` (global `Promise.all` at call time, fail-fast),
  value tests (`truthy`, `is_nullish`, `is_false`, `str_eq`, ...), JS operators with coercion
  (`add`, `sub`, `mul`, `gt`: numbers natively, anything else through V8, so `"2" + 1` is `"21"`),
  `nullish_or` / `or_else` / `default_of`, `throw_from(helper, args)`, `thrown(v)`.
- Literals (syntax = intrinsic semantics): `literal(&[(key, value)])` (fresh `{ k: v, ... }`, key
  order kept, own `undefined` kept), `array_of(&[..])` (fresh `[a, b]`), `define_key(o, k, v)`
  (computed key of a literal / spread / `map` result) are CreateDataProperty: setters inherited
  from `Object.prototype` / `Array.prototype` never run and cannot drop the property. Core
  equivalents: `payload_core_runtime::js::{object_literal, array_literal, define_property,
  define_named, define_element}`. Never fill a fresh literal with `set`.
- Built-ins the TS calls by name (replaceable globals and prototype methods): read and call them
  at the TS point, once per TS evaluation. `object_keys(o)` / `object_keys_length(o)` (current
  `Object.keys`), `is_array(v)` (current `Array.isArray`), `push(arr, v, expr)` (`arr.push`
  looked up on `arr`), `global(name)`, `global_method("Number", "isNaN") -> Method`,
  `method(recv, "lastIndexOf") -> Method` (string primitives too), then `Method::call(args,
  expr)`. For `G.m(<expr>)` evaluate `global_method(G, m)` BEFORE the argument expression (JS
  evaluates the callee first). `construct_global("TypeError", args)` / `construct(ctor, args,
  expr)` for `new X(...)` written in the TS source (constructor read at that point). Core
  equivalents: `payload_core_runtime::host::{global, global_method, method, Method, call_fn,
  call_method, object_keys, array_is_array, push, object_values, object_entries, has}`.
  `is_array_intrinsic(v)` is only for engine-internal decisions the TS does not make through
  `Array.isArray` (no observable effect). Intrinsic errors V8 itself throws:
  `payload_core_runtime::js::{type_error, range_error, not_a_function}` (`%TypeError%` /
  `%RangeError%` whatever the globals are).
- Awaits (`payload_core_runtime::executor`): `await_js(v)` is V8's own Await (a compiled async
  function whose only step is `await v` resumes the task): one `constructor` read for native
  promises, no SpeciesConstructor / `Symbol.species`, thenable jobs and ticks as native `await`
  (proof: test/__rs/core-runtime/semantics.mjs). `spawn_tail`'s fast tail is `async (p, v) => {
  await p; return v }`. JS-side host helpers that await (`awaitValue(f(...), token)`) must use
  `coreRuntimeBinding().awaitValue`, never `Promise.resolve(v).then(...)`.
- Nested async calls: `executor::call(f(...)).await?` (or `call_with_frame(fut, bytes)`) is the TS
  `const p = f(...)` of an async `f` inside an engine task: the callee's synchronous prefix runs
  before the caller continues and the caller gets the callee's promise (like `spawn`), but the
  callee is run by the task's driver loop, not on top of the caller's native frames, so nesting
  (`and` in `and`, fields in fields) costs heap, not native stack. Each level counts `bytes`
  (default `MIN_TS_FRAME` = 64, the smallest TS async-call frame) against V8's measured stack limit
  and throws the intrinsic `RangeError: Maximum call stack size exceeded` beyond it: the overflow
  depth stays comparable to TS and never below it (pass the TS frame size of one level of your
  construct, at most). Not a JS await: no tick passes; the returned promise `Local` is valid in the
  current synchronous segment. `executor::run_sync(fut)` runs such a traversal for a synchronous
  export. Recursion through plain `spawn` inside a poll keeps the old native-stack cost (~0.5-1.5
  KB per level release, ~25 KB debug vs ~80-700 B in V8): use `call` wherever the TS nests.
- Callbacks handed to user code: `payload_core_runtime::js::closure(name, |this, args| ..)` and
  `js::arrow(arity, |args| ..)` (a real JS arrow: no `prototype`, not constructible, `length ===
  arity`, `name === ''`). The `'static` body is owned by the function and freed by a napi finalizer
  when the GC collects it: user code may keep the function and call it after the creating call
  returned, re-entrantly and recursively, exactly like the TS closure (no "expired callback"
  errors, no pointers to stack closures). Keep mutable state in `Rc<RefCell<..>>` / `Val`; never
  borrow a `RefCell` across a call into JS from the body (re-entrancy).
- `bson`: `types()` (`mongoose.Types`), `bson_module()` (`mongoose.mongo.BSON`, the driver's bson;
  `Types.ObjectId === BSON.ObjectId`), `class(BsonClass)`, `instance_of(v, BsonClass)` (real
  `instanceof`), `bson_class_of(v) -> Option<BsonClass>` (`ObjectId`, `Decimal128`, `Binary`,
  `Long`, `Int32`, `Double`, `Timestamp`, `BSONRegExp`, `BSONSymbol`, `Code`, `DBRef`, `MinKey`,
  `MaxKey`, `UUID`; plain objects with a forged `_bsontype` are `None`), `is_object_id(v)` =
  upstream's duck-typed `isObjectID` with its exact reads (use it where upstream calls
  `isObjectID`, `instance_of` only for engine-internal decisions), `object_id_is_valid(v)`
  (`Types.ObjectId.isValid(v)`), `new_object_id(&[v])` (`new Types.ObjectId(v)`; bson's own
  `BSONError` propagates as the original object), `to_hex_string(v)`, `construct(ctor, args,
  expr)`, `is_date(v)` (`v instanceof Date`, global `Date` at call time).
- `clock`: `new_date()`, `now_iso()` (`new Date().toISOString()`), `new_date_of(v)`,
  `date_now()`; each call is ONE evaluation through the global `Date` at call time (fake timers,
  shadow clock tape). Call exactly where upstream evaluates the expression; never reuse a reading.
- `session::get_session(db, req) -> JsResult<Local>`: calls the ported async `getSession(db,
  req)` on the original `req` and returns its promise; `await_js` it where upstream awaits
  (`req.transactionID` read twice when it is a promise, `db.sessions[id]`, `inTransaction()`,
  orphan `delete`).
- `entity::get_collection(adapter, slug, versions) -> Collection { collection_config,
  custom_id_type, model }`, `entity::get_global(adapter, slug, versions) -> Global { global_config,
  model }`: upstream getEntity.ts with live reads in its order (`adapter.payload.collections[slug]`,
  `adapter.versions|collections[slug]`, `adapter.payload.config.globals.find(...)`,
  `adapter.globals`) and its `APIError`s; call at the point upstream calls it and keep the model
  for the whole method.
- `error`: `api_error(msg)`, `api_error_of(Local)`, `bson_error(msg)`, `new_error(kind, args)`
  (`APIError`, `BSONError`, `ValidationError`, `Error`, `TypeError`, `RangeError`, built in JS with
  upstream's classes), `is_same`. Thrown user/mongoose/bson values are `Thrown(Val)` of the very
  object: propagate with `?`, never copy or read them unless upstream does. `handleError` is NOT
  here (payload-mongo-live-transform ports it).
- `deps`: the db-mongodb entry points owned by the other live crates, called by the reads (and by
  anyone else): `build_query(BuildQueryArgs) -> promise`, `build_sort_param(BuildSortParamArgs) ->
  sort`, `build_projection_from_select(...) -> projection`, `transform(TransformArgs) -> value`,
  `build_join_aggregation(...) -> promise`, `resolve_joins(...) -> promise`. Arg structs = the TS
  args literal, one `Val` per key (`Val::Undefined` = absent). Owners register their port with
  `deps::register_<name>(fn)`; the registration call goes into
  `crates/payload-node/src/mongo_live.rs` (livereads adds it when you announce your fn in the
  log). Unregistered entries call upstream's TS function through the host (`upstream.<name>`), so
  callers are exact meanwhile. `init(host, { upstreamDeps: true })` forces the TS functions
  (differential isolation); `mongoLiveBinding().ported()` reports which entries are Rust.
- `reads::aggregate_paginate(AggregatePaginateArgs) -> promise` is the one port of
  `utilities/aggregatePaginate.ts` (joins: call it, do not re-port it).

Read methods (`mongoLiveBinding()`): `find`, `findOne`, `count`, `countVersions`,
`countGlobalVersions`, `findDistinct`, `findGlobal`, `findVersions`, `findGlobalVersions`,
`queryDrafts`, each `(adapter, args) => Promise` (the upstream async method with `this =
adapter`); the TS glue installs them as `adapter[m] = function (args) { return binding[m](this,
args) }` (`installLiveReads(adapter)` in `packages/engine-rs/src/mongo-live/index.ts`).

Port registration: payload-node's `mongo_live.rs` registers the query ports
(`payload_mongo_live_query::deps::*`) when `mongoLiveBinding()` is created, and `getMongoLive()`
initializes `mongoLiveQueryBinding()` with its host (`packages/engine-rs/src/mongo-live/query.ts`);
transform and joins register themselves from their bindings' `init` (production:
`packages/engine-rs/src/mongo-adapter/live.ts` `initializeLiveDeps`).

Verification (livereads):

- `test/__rs/mongo-live-reads/reads.int.spec.ts` (mongo harness config, `PAYLOAD_ENGINE` unset,
  `PAYLOAD_ENGINE_ADDON=<addon>`, `LIVEREADS_PORTS=upstream|registered|all`): upstream
  `payload.db.<m>` vs `mongoLiveBinding()[m]` on the same live inputs; recording proxies on args /
  where / req / adapter, spied models (call-time argument snapshots), real MongoDB and tape replay
  with a microtask pump (tick-exact awaits, `Promise.all`, settle order), rejection identity, final
  argument / config state; aggregatePaginate, getSession, getEntity, bson helper differentials;
  negative controls; fails on zero cases, a TS run without events, a Rust run without engine entry,
  tape mismatches, or a `LIVEREADS_PORTS` mode whose `ported()` disagrees.
- Upstream suites with only the reads (and the ports `LIVEREADS_PORTS` selects) on Rust:
  `node test/__rs/mongo-harness/runSuites.mjs --config test/__rs/mongo-live-reads/vitest.config.ts
  --addon <addon> --baseline .rs-baseline/mongodb-all.json <files>`; each process writes
  `livereads-<pid>.json` (calls per method, `ported`) into the run's stats dir.

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
