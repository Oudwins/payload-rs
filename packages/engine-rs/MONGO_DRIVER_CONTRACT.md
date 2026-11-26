# MongoDB driver lane contract (Rust driver ⇄ TS)

Binding interface of the driver lane (RUST_PERF_PLAN.md S3, work package B): Payload's MongoDB
reads run on a Rust `mongodb` client instead of mongoose / the Node driver.

| part                   | where                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| client, pool, commands | `crates/payload-mongo-driver/src/client.rs` (`mongodb` 3.9.1 on tokio)    |
| lazy BSON values       | `crates/payload-mongo-driver/src/value.rs`                                |
| read transform (plans) | `crates/payload-mongo-driver/src/transform.rs`                            |
| JSON materialization   | `crates/payload-mongo-driver/src/json.rs`                                 |
| napi binding           | `crates/payload-mongo-driver/node/mod.rs` (path-included by payload-node) |
| read methods, guards   | `packages/engine-rs/src/mongo-driver/lane.ts`                             |
| plans from the config  | `packages/engine-rs/src/mongo-driver/plan.ts`                             |
| lazy mongoose, connect | `packages/engine-rs/src/mongo-driver/lazy.ts`, `index.ts`                 |
| lane differential      | `packages/engine-rs/src/mongo-driver/verify.ts`                           |
| run summaries          | `test/__rs/mongo-driver/laneSummary.mjs`, `comparePerf.mjs`               |

## Selection

`withRustMongoEngine` (packages/engine-rs/src/mongo-adapter) installs the live engine's methods,
then `installDriverLane(adapter)`. `PAYLOAD_ENGINE=ts` runs upstream (nothing of this).

| `PAYLOAD_MONGO_DRIVER` | behaviour                                                                  |
| ---------------------- | -------------------------------------------------------------------------- |
| unset                  | driver lane, mongoose connected at `connect` next to the Rust client       |
| `lazy`                 | driver lane, mongoose lazy (opened on first touch)                         |
| `node`                 | no driver lane: everything on the live engine / mongoose (the Node driver) |

`PAYLOAD_MONGO_DRIVER_VERIFY=true|strict` runs the lane differential (below);
`PAYLOAD_MONGO_DRIVER_THREADS` sets the driver runtime's workers (default 2).

## Clients

- One Rust client (pool) per adapter, created by `connect` from `adapter.url` and the mapped
  `connectOptions` (`appName`, `connectTimeoutMS`, `dbName`, `maxPoolSize` (default 100 like the
  Node driver), `minPoolSize`, `replicaSet`, `serverSelectionTimeoutMS`; `autoCreate`, `autoIndex`,
  `bufferCommands` only concern mongoose). The database is `dbName`, else the URL's, else `test`
  (mongoose's default). `connect` waits for a `ping` (mongoose's `openUri` waits for the server).
- No Rust client (everything on mongoose, eager): a URL that is not `mongodb://` / `mongodb+srv://`,
  a URL option outside the list in `index.ts` `supportedUrlOptions` (compressors, TLS files, AWS /
  X.509 / Kerberos auth, ...), any other `connectOptions` key (`autoEncryption`, `tls*`,
  `monitorCommands`, `driverInfo`, ...), or a failed Rust connect (mongoose then reports upstream's
  error).
- `destroy` closes the client (and the mongoose connection, without opening it).

## Read methods

`count`, `countGlobalVersions`, `countVersions`, `find`, `findDistinct`, `findGlobal`, `findGlobalVersions`,
`findOne`, `findVersions`, `queryDrafts`. Each is upstream's db-mongodb method
(packages/db-mongodb/src/<method>.ts) statement by statement: upstream's `getCollection` /
`getGlobal`, `flattenWhereToOperators`, `buildSortParam`, `buildQuery`, `buildProjectionFromSelect`,
`buildJoinAggregation`, collation / hint / estimated-count decisions, the queryDrafts
`version` / `parent` unwrapping, and the result objects of mongoose-paginate-v2 `paginate` and
db-mongodb `aggregatePaginate`. The I/O steps (`Model.paginate`, `Model.findOne`,
`Model.countDocuments`, `Model.estimatedDocumentCount`, `Model.aggregate`) and the read
`transform` run in Rust.

`findDistinct` (upstream's method stays the adapter's, `upstreamMethods`; the lane wraps it) is
findDistinct.ts statement by statement as well: its two `Model.aggregate(pipeline, { session })`
calls (the `$count` pipeline, then the values) run one after the other on the Rust client
(`mongoDriverAggregateRaw`: the Node driver's `aggregate` without options), whose documents come
back untransformed as the BSON document `{ docs }` and are decoded by the driver's js-bson with
the Node driver's defaults, so upstream's `JSON.parse(JSON.stringify(...))` of the group ids sees
the values mongoose would return. Inside a transaction it runs on the mongoose lane.

Casting is mongoose's own: the lane builds the very `Query` the replaced call would build
(`Model.find(query, projection, queryOptions).select().sort().lean().skip().limit()` of
mongoose-paginate-v2, `Model.findOne(query, {}, options)`, `Model.countDocuments(query, options)`,
`Model.estimatedDocumentCount(options)`), runs `_applyTranslateAliases()` / `_castConditions()`
and reads `_conditions` and `_optionsForExec()` (mongoose 9's exec path). Aggregation pipelines are
not cast (as in mongoose).

### When a call stays on the mongoose lane

The call is handed to the method installed before (the live engine, which runs on mongoose) with
the same `this` and arguments, before any observable step, or re-run there after a Rust bail
(reads are idempotent; the mongoose lane produces upstream's result or error):

- the call runs inside a transaction (see "Transactions") and needs an estimated count, or
  `PAYLOAD_MONGO_DRIVER_SESSION_IO=false`,
- the model is not pristine: an own property shadows `aggregate` / `countDocuments` /
  `estimatedDocumentCount` / `find` / `findOne` (`vi.spyOn`), `paginate` is not
  mongoose-paginate-v2's, the collection has own `aggregate` / `countDocuments` /
  `estimatedDocumentCount` / `find` / `findOne`, or the model has query middleware
  (`Model.Query.prototype._queryMiddleware`) or `aggregate` / query hooks (`Model.hooks`) for these
  operations; `paginate.options` (global paginate options) is set,
- mongoose would apply something the lane does not: `mongoose.set('debug')`, global `maxTimeMS` /
  `allowDiskUse`, a `transactionAsyncLocalStorage` session, query options beyond `collation`,
  `hint`, `limit`, `projection`, `session` (null), `skip`, `sort` (e.g. a schema `read` preference
  or `readConcern`), a cast error (mongoose throws it), an aggregate on a discriminator model,
- the entity's transform plan is ineligible (plan.ts: non-string names, names that are
  `Object.prototype` members, malformed fields / blocks / tabs),
- `useJoinAggregations: false` with requested joins (`resolveJoins` runs mongoose queries),
- Rust bails: a value `JSON.parse` cannot reproduce in the result (ObjectId / Date outside the
  fields transform converts, Decimal128, Binary, Long beyond 2^53, RegExp, Timestamp, Code, MinKey,
  NaN / Infinity, `undefined`), a `__proto__` or `$ref` key, malformed BSON, data the transform would
  reach through JS semantics the lane does not model (enumerating an array or bson instance where
  upstream expects an object, dotted keys `traverseFields` would expand), a driver or server error.

Counters per method and reason: the engine stats file's `driverLane` (`served`, `fallback`).

## Command parity

Commands are the Node driver's for the replaced calls: `find` (filter, sort, projection, skip,
limit, collation, hint; `findOne`: `limit: 1`, `singleBatch`), `aggregate` (the pipeline,
collation), count documents as `aggregate [{ $match }, { $group: { _id: 1, n: { $sum: 1 } } }]`
with hint / collation (test/joins/int.spec.ts reads this command from `system.profile`),
estimated counts as `count`. Arguments are serialized by js-bson with `ignoreUndefined: false`
like the Node driver's commands (`{ $eq: undefined }` is sent as `null`). Concurrency as upstream:
paginate starts the count first, aggregatePaginate the aggregate first, both in flight. Integer
options may be int64 where the Node driver sends int32 (`skip`, `limit`).

## Arguments (`ReadArgs`, js-bson)

`{ collection, database?, find?: { filter, sort?, projection?, skip?, limit?, collation?, hint? },
count?: 'estimated' | { filter, hint?, collation? }, pipeline?: [stage...], collation?,
allowAdditionalKeys? }`.

## Transform plans

plan.ts builds, once per entity (collection, its versions, a global, its versions; the sanitized
config is immutable), `{ fieldsArrays: [[field...]...], blocks: [{ slug, fields, flattened }],
configBlocks, collections, localization: { localeCodes, locales } | null, fields, flattened }`:
`fields` = the `fields` argument upstream passes to `transform`, `flattened` =
`flattenAllFields({ cache: true, fields })`. A field records `type`, `name` (iff `'name' in field`),
`localized`, `relationTo` (iff a string), `joinCollectionIsArray`, `fields` / `flattened` /
`hasBlocks` / `blocks` / `tabs` (iff the property exists). transform.rs runs upstream's read
transform on that plan in upstream's order: the header (`delete __v`, `id = _id || id`,
`delete _id`, ObjectId ids to hex; `leanWithId` key position for paginated reads), `stripFields`,
then payload's `traverseFields` with the `sanitize` callback (dates to ISO strings, relationship /
upload / join ObjectIds to hex, polymorphic join docs through `JSON.parse(JSON.stringify())`). Per
fields array the plan derives the sorted names and the fields whose steps can have an effect.

## Materialization

Rust writes each result as JSON text (shortest round-trip numbers, `-0` kept, keys in the
object's order; subtrees the transform never visits are transcoded from BSON directly, a repeated
key written twice so `JSON.parse` keeps the first position with the last value like js-bson) and
JS runs one `JSON.parse`. Lane results resolve with that text or `"!<reason>"` (re-run on the
mongoose lane); they never reject.

## Lazy mongoose

Owner decision (RUST_PERF_PLAN.md section 0): `payload.db.connection` / `collections` /
`versions` / `globals` / `sessions` stay the real mongoose objects (built by `init` on the
unopened connection, as upstream does) and become accessor properties: the first read opens the
mongoose connection (`openUri` with upstream's options, the `useAlternativeDropDatabase` patch).
Until then mongoose buffers model / collection operations (`bufferCommands`), so they work. The
lane reads them through an adapter view that does not open mongoose. Assigning
`payload.db.connection` replaces it (the lane never opens a user-assigned connection).

`connect` does upstream's steps through the Rust client: the replica set check, `PAYLOAD_DROP_DATABASE`,
what opening the connection starts for every model of the connection (`Model.init()`:
`createCollection` when `autoCreate`, `ensureIndexes` when `autoIndex`, not awaited) and the
awaited `ensureIndexes` of `ensureIndexes: true`. Both run mongoose's own `createCollection` /
`ensureIndexes`; only their I/O is redirected (`connection.createCollection`,
`collection.createIndex` as temporary own properties) to the Node driver's commands (`create`,
`createIndexes` with the driver's valid index options and its generated names) on the Rust client,
so specs, names and discriminator partial filters are mongoose's. When mongoose opens later it runs
its own `Model.init()` again (idempotent). Errors are reported like upstream
(`Error: cannot connect to MongoDB: ...`).

The lazy mode is opt-in (`PAYLOAD_MONGO_DRIVER=lazy`). By default `connect` runs upstream's
`connect` (mongoose) and starts the Rust client at the same time, so every mongoose object is open
as upstream's and reads are still served by the driver lane. Eager even in lazy mode:
`afterOpenConnection`, `mongoMemoryServer`, `bufferCommands: false`, no Rust client.

Observable differences of the lazy mode, the reason it is not the default: the five properties are accessors
(`Object.getOwnPropertyDescriptor`); state that exists only on an open connection
(`connection.db`, `connection.getClient()`, `readyState`, `Model.collection.collection`) is
missing until something has touched mongoose and the open has completed.

## Transactions

Transactions stay on mongoose (owner decision). `beginTransaction` opens mongoose first (one
await) and returns a mongoose `ClientSession` id; `payload.db.sessions[id]` is the mongoose session
users may pass to models. A process that writes inside transactions (every Payload write on a
replica set, unless `disableTransaction`) therefore opens mongoose at its first write. Without a
replica set (or with `transactionOptions: false`) no session exists.

A read whose `req` has a session (`getSession(adapter, req)`, upstream's: a pending
`req.transactionID` is awaited, one resolving to `null` is no transaction) stays on the lane (owner
decision, 2026-11-24): it is planned and cast like any other lane read, but its I/O runs on the Node
driver in that session: the mongoose collection calls the replaced query would make
(`Model.collection.find` / `findOne` / `countDocuments` / `aggregate` with the cast filter,
mongoose's options and the session, count and find both in flight in upstream's order) with
`raw: true`, and the raw documents go through the lane's Rust transform and JSON materialization
(`mongoDriverTransform`, synchronous). An estimated count (the `count` command is not allowed in a
transaction) or a Rust bail runs the call on the mongoose lane. Counters: `driverLane.inTransaction`.
`PAYLOAD_MONGO_DRIVER_SESSION_IO=false` runs every read inside a transaction on the mongoose lane
(fallback reason `transaction`).

A measurement switch, off by default (it changes what this section states, so it needs an owner
decision before it could become a default):

- `PAYLOAD_MONGO_RUST_TXN=true` (prototype of RUST_PERF_PLAN.md D4, `mongo-driver/rustTxn.ts`):
  write operations without collection / root hooks and with `overrideAccess` run in a transaction
  the Rust client owns (`mongoDriverTxnBegin` / `mongoDriverTxnCommand` / `mongoDriverTxnEnd`);
  `payload.db.sessions[id]` holds a stand-in, lane reads pass `txn`, mongoose collection calls
  carrying the stand-in send the Node driver's command for that call through the Rust client in the
  transaction. Counters: `driverLane.rustTransactions`.

## Verification

- `PAYLOAD_MONGO_DRIVER_VERIFY=true`: every served read also runs on the mongoose lane with the same
  arguments; results are compared exactly (key order, own keys, `typeof`, prototypes, numbers by
  `Object.is`); a mismatch is re-checked by running the lane again (equal to the reference: a
  concurrent write between the reads, counted as `raced`). Stats: `driverLane.verify`. Summary of a
  harness run: `node test/__rs/mongo-driver/laneSummary.mjs /tmp/rs-mongo-runs/<tag> --divergences`.
- The harness runner counts reads served by the driver as Rust calls (`readEngineStats` `driver`).
- `cargo test -p payload-mongo-driver` (JSON, dates, raw transcoding);
  `cargo run --release -p payload-mongo-driver --example timing -- <url> <collection> [plan.json]`.

## For the fused lanes (WP A)

The crate has no Node dependency: a `FusedBackend` for MongoDB can call `client::paginate` /
`find_one` / `count` / `aggregate` with a `FindSpec` / `CountSpec` it builds itself and a
registered plan, and get the transformed documents as JSON text, or use `value::decode_document`
(lazy, borrowed values) and `transform::transform_read` directly on a cursor's documents to keep
them in Rust. What it needs on top: query building in Rust (where → filter, sort, projection) with
mongoose's casting, and Rust-owned transactions for fused writes (see the open decisions in the
work package report).
