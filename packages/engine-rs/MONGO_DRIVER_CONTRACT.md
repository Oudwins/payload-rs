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
`PAYLOAD_MONGO_DRIVER_THREADS` sets the driver runtime's workers (default below).

### Driver runtime workers (WP-Z)

Every Rust client and lane call runs on one tokio runtime (`client.rs` `runtime`). Its worker count
is `PAYLOAD_MONGO_DRIVER_THREADS` when set (a positive integer), else
`clamp(cpus / 3 + 1, 2, 6)`. Here `cpus` is `std::thread::available_parallelism`: the process's
affinity mask (taskset, cpusets) and its cgroup CPU quota (v1 and v2, rounded down), whichever is
smaller. It is read once, when the runtime starts.

| CPUs    | 1-5 | 6-8 | 9-11 | 12-14 | 15+ |
| ------- | --- | --- | ---- | ----- | --- |
| workers | 2   | 3   | 4    | 5     | 6   |

The fused reads' and writes' Rust work (BSON decode, transforms, prepare) runs on these workers.
`find` and `update` throughput under load grows with them. `findByID` and REST requests are bound by
the JS thread, and extra workers cost them throughput: wake-ups, and on hyper-threads the sibling of
the JS thread's core. Measured with the perf suite: release addon, typical shape, 1k posts, MongoDB
8.2 rs0 on loopback (not pinned), 3 interleaved rounds per set, i9-13900HX. CPUs 0-15 are 8 P-cores
with 2 hyper-threads each; CPUs 16-31 are 16 E-cores in clusters of 4. Each cell is the geometric
mean over the 7 throughput scenarios of the per-round ratios, with the 95% t interval over the
rounds. Latency is the geometric mean over 47 Local API and 14 REST single-request scenarios
(1/median).

| set                   | workers  | x8 vs ts | x64 vs ts | x8 vs 3 workers  | x64 vs 3 workers | CPU / req x8, x64 vs 3 | local, rest latency vs 3 |
| --------------------- | -------- | -------- | --------- | ---------------- | ---------------- | ---------------------- | ------------------------ |
| 4 E-cores (16-19)     | 2 (dflt) | 6.04     | 6.27      | 0.99 [0.96-1.02] | 0.90 [0.84-0.96] | 0.97, 0.99             | 0.99, 0.98               |
|                       | 3        | 6.09     | 6.97      | 1                | 1                | 1                      | 1                        |
|                       | 4        | 5.97     | 7.03      | 0.98 [0.93-1.04] | 1.01 [0.95-1.07] | 1.00, 1.00             | 0.99, 0.98               |
|                       | 6        | 5.88     | 7.15      | 0.97 [0.92-1.01] | 1.03 [0.94-1.12] | 1.01, 0.99             | 1.00, 0.96 [0.94-0.99]   |
| 6 E-cores (16-21)     | 2        | 6.02     | 6.55      | 0.95 [0.92-0.98] | 0.88 [0.87-0.90] | 0.95, 0.96             | 1.02, 1.05               |
|                       | 3 (dflt) | 6.34     | 7.41      | 1                | 1                | 1                      | 1                        |
|                       | 4        | 6.34     | 7.89      | 1.00 [0.99-1.01] | 1.07 [1.02-1.11] | 1.02, 0.99             | 1.01, 1.02               |
|                       | 6        | 6.23     | 8.07      | 0.98 [0.95-1.02] | 1.09 [1.06-1.12] | 1.01, 1.01             | 1.01, 1.02               |
| 8 E-cores (16-23)     | 3 (dflt) | 7.18     | 7.88      | 1                | 1                | 1                      | 1                        |
|                       | 4        | 7.34     | 8.22      | 1.02 [1.00-1.04] | 1.04 [1.02-1.07] | 1.01, 1.04             | 1.01, 1.03               |
| 10 E-cores (22-31)    | 2        | 6.41     | 6.46      | 0.95 [0.84-1.07] | 0.87 [0.82-0.91] | 0.95, 0.97             | 1.00, 0.98               |
|                       | 4 (dflt) | 6.82     | 7.97      | 1.01 [0.75-1.36] | 1.07 [1.02-1.11] | 1.05, 1.03             | 1.01, 0.99               |
|                       | 5        | 7.11     | 8.75      | 1.02 [0.99-1.06] | 1.09 [1.07-1.12] | 1.07, 1.07             | 0.95 [0.91-1.00], 0.96   |
|                       | 6        | 7.12     | 8.07      | 1.05 [0.97-1.14] | 1.08 [1.06-1.11] | 1.06, 1.09             | 1.01, 0.96               |
|                       | 8        | 7.10     | 8.36      | 1.05 [1.01-1.09] | 1.12 [1.07-1.17] | 1.04, 1.06             | 0.98, 0.98               |
| 16 E-cores (16-31)    | 2        | 6.25     | 6.82      | 0.91 [0.90-0.92] | 0.85 [0.84-0.86] | 0.95, 0.98             | 0.99, 1.02               |
|                       | 4        | 7.06     | 8.59      | 1.03 [0.98-1.08] | 1.07 [1.03-1.11] | 1.03, 1.03             | 0.97 [0.94-1.00], 0.98   |
|                       | 6 (dflt) | 7.22     | 8.96      | 1.05 [1.02-1.08] | 1.12 [1.10-1.13] | 1.05, 1.08             | 0.99, 0.98               |
|                       | 6, rerun | 6.96     | 9.01      | 1.06 [0.94-1.19] | 1.12 [1.10-1.15] | 1.03, 1.08             | 1.01, 0.96               |
|                       | 8        | 7.27     | 9.18      | 1.06 [1.00-1.12] | 1.14 [1.13-1.16] | 1.03, 1.08             | 0.98 [0.97-1.00], 0.94   |
| 8 hyper-threads (0-7) | 2        | 5.71     | 6.22      | 0.86 [0.82-0.91] | 0.86 [0.84-0.87] | 0.94, 0.95             | 0.99, 1.05               |
|                       | 3 (dflt) | 6.61     | 7.25      | 1                | 1                | 1                      | 1                        |
|                       | 4        | 6.13     | 7.41      | 0.93 [0.71-1.21] | 1.02 [0.98-1.07] | 1.10, 1.08             | 0.98 [0.97-1.00], 1.01   |
|                       | 6        | 6.50     | 7.59      | 0.98 [0.96-1.01] | 1.05 [1.00-1.09] | 1.11, 1.14             | 0.98, 1.03               |
| 16 hyper-threads      | 2        | 5.85     | 6.49      | 0.88 [0.88-0.89] | 0.84 [0.80-0.87] | 0.94, 0.96             | 1.10, 1.03               |
| (0-15)                | 4        | 6.33     | 8.43      | 0.96 [0.65-1.41] | 1.09 [1.05-1.12] | 1.09, 1.04             | 1.02, 0.97               |
|                       | 6 (dflt) | 6.37     | 9.15      | 0.96 [0.68-1.36] | 1.18 [1.13-1.23] | 1.15, 1.11             | 0.99, 0.96               |
| 0-15, 8 busy loops on | 6 (dflt) | 5.85     | 6.97      | 1.01 [0.95-1.08] | 1.08 [1.06-1.10] | 1.10, 1.14             | -                        |
| 8-15 (shared machine) |          |          |           |                  |                  |                        |                          |

- Scenarios: `find` and `update` x64 grow up to 6 workers (16 CPUs: `find limit 10` +42-55%,
  `update scalar field` +49-64% over 3 workers). `findByID` and REST lose a few percent when there
  are more workers than the formula gives:
  - `findByID` x8: 0.84 [0.78-0.90] with 4 workers on 4 E-cores, 0.92 [0.84-1.00] with 4 on 6
    E-cores.
  - `findByID` x64: 0.95 [0.93-0.98] with 4 on 8 E-cores.
  - REST `GET /posts` with 4 workers on 8 hyper-threads: x8 0.92 [0.85-1.00], x64 0.88 [0.79-0.98].
  - Within the formula, the worst cases are on 16 CPUs with 6 workers: REST `GET /posts` x8 0.87
    [0.79-0.97] on E-cores in one of two runs, `REST POST` x64 0.96 [0.93-0.99] on
    hyper-threads; with the busy loops, `findByID` x8 0.95 [0.91-0.99].
- `cpus / 2` (the previous rule without its cap of 3) gives 4 workers on 8 CPUs. That costs REST
  throughput on hyper-threads, where 4 workers fill the 4 cores' second threads. `cpus / 3 + 1`
  keeps 2 workers on 4 CPUs and 3 on 6 and 8, the best or equal settings there.
- The cap of 6 bounds the CPU cost: past 6 workers (8 workers on 16 E-cores) x64 gains 2% more for
  the same CPU per request. A host whose quota or affinity is wider than its actual share gets at
  most 6 workers. With half of 16 CPUs busy, 6 workers still gain 8% at x64 over 3. Idle workers
  park; the cost of the extra workers is their wake-ups (CPU per request +3-15%).
- Single-request latency does not depend on the worker count beyond the placement noise
  (test/__rs/perf/README.md). The same scenario switches between about 0.7 and 1.3 ms
  (`find limit 10`) by round, in every variant. One run on 10 E-cores had 5 workers 4-5% slower,
  and the sweep with 4 and 6 workers did not repeat it.
- `create` x8 sometimes collapses for one round (2,600 → 470-720 req/s, event-loop utilization
  0.28, CPU per request x2). It hits 3 and 6 workers alike: in 8 rounds with only the throughput
  scenarios, both collapsed in the same round. It is not a worker-count effect (open).
- Reproduce with `node test/__rs/perf/run.mjs --surfaces throughput --engines
  ts,rs-threads-3,rs-threads-6 --cpus <set>`. `rs-threads-<n>` is the default selection with
  `PAYLOAD_MONGO_DRIVER_THREADS=<n>`.

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
