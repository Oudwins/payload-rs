<!-- Ideation plan for the 10x goal (Fable, 2026-11-23). Projections from measured floors, not results; owner decisions in section 5. -->

# Reaching 10x over upstream Payload: ranked plan

Scope: ideation only, nothing in the repo was changed. Numbers marked "measured here" come from read-only experiments run for this plan (scratch in `/tmp/fable-ideas/`, MongoDB on :27028, PostgreSQL on :5433, E-cores 16-31, shared with other jobs, so absolute values are 10-30% noisier than the perf suite's).

## 0. Owner decisions (2026-11-23), binding for every work package

- **Must not change:** user-facing TypeScript types and the behaviour users observe through Payload's APIs (Local API, REST, GraphQL, hooks / access / validation semantics, results, errors). Existing tests keep passing unmodified.
- **Storage:** only additive, non-user-facing changes (extra indexes; internal auxiliary collections / tables Payload maintains itself, never inside existing documents or rows). Existing documents and rows keep exactly their shape and meaning. Any such addition is proposed to the owner with its measured extra gain before it is built (A1-A4 of section 4 are not approved yet; neither is the SQLite WAL default).
- **D1 accepted:** fused lanes may settle after a different number of microtask ticks than upstream. Results, errors, database effects and the order of everything inside one operation (incl. its hooks) stay identical; only the interleaving of other concurrent async code may differ. The tick-exact engine stays the fallback.
- **D5 accepted, on by default:** user functions (access, hooks, validators) may be compiled to the Rust-interpreted IR under the stated assumptions, with guard-mode verification (first N calls, then sampled). Owner requirement: a per-function opt-out, done "by calling something passed through": an extra argument passed to the function (e.g. `args.noCompile()` or similar; a call to it anywhere in the function's source makes the analyzer skip that function; at runtime it is a no-op). The extra argument is an additive type change.
- **mongoose (D3 / D4):** every Payload operation (Local API, REST, GraphQL) runs through Rust talking to MongoDB directly (Rust driver). `payload.db.collections` / `versions` / `globals` / `connection` stay real mongoose objects, made **lazy**: mongoose connects and builds models only when one of them is touched, so a normal app runs a single (Rust) pool. Transactions that user code can share stay on mongoose. A Rust-backed mongoose-compatible facade is a possible later step. An env switch forces the Node drivers.
- **D6 / D9 accepted:** no transaction around single-statement writes; pipelining / merging SQL statements; coalescing identical concurrent reads.
- Every work package must keep: the full upstream suite on MongoDB / SQLite / PostgreSQL equal to the TS baselines, shadow mode at 0 divergences, and add lane-specific differential checks (fast lane vs exact lane) with hit counters proving the fast lane ran.

## 1. Bottom line

- **10x sequential latency is not reachable on MongoDB or PostgreSQL** for most operations: the database round trip is 25-50% of upstream's time today. The ceiling there is about 2-4x for Local API reads, 5-8x for REST and GraphQL reads, and 3-4x for writes (6-8x for PostgreSQL writes on a server with cheap commits).
- **10x latency is reachable on SQLite reads** (in-process, no network) and on REST/GraphQL single-document reads on SQLite.
- **10x is reachable on every database for throughput and JS-thread CPU per request**, for operations with no uncompiled user JS on their path. Upstream spends about 0.4-4 ms of JS-thread CPU per read; a fused Rust lane spends about 0.02-0.6 ms (0.02-0.06 ms when the response is pre-serialized JSON).
- **Startup**: 88-96% of it is module import, not Payload logic. About 2.5-3.5x is realistic; 10x is not, while Node boot, the user's config import and the database handshake remain.
- **No change to the stored data is needed for any of this.** Section 4 lists the additive auxiliary structures that could add more, and what the owner's storage rule excludes.
- The current design (Rust driving live JS objects through Node-API) cannot get there: every crossing costs more than V8's JIT'd access, and the last round's wins all came from moving work back to JS. The multiplier comes from the opposite move: keep data **off the JS heap for the whole operation** whenever nothing in JS can observe it, and keep the current exact engine as the fallback for everything else.

## 2. Where the time goes and what the floors are

Measured here (typical shape, medians):

| measurement                                                                            | value                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| MongoDB `ping` round trip (Node driver)                                                | 0.13 ms                                        |
| MongoDB `findOne` by `_id`: raw bytes / js-bson decoded                                | 0.26 / 0.32 ms                                 |
| MongoDB `find` limit 100: raw / decoded                                                | 0.45 / 2.5 ms                                  |
| MongoDB `find` 100 raw + `countDocuments` in parallel                                  | 0.76 ms                                        |
| js-bson decode of 100 docs (174 KB) / `JSON.parse` of the same data / `JSON.stringify` | 1.86 / 0.57 / 0.77 ms                          |
| MongoDB `insertOne`: w:1 / majority / in a transaction (majority)                      | 0.27 / 1.36 / 1.99 ms                          |
| MongoDB transaction: insert + findOne + update + commit                                | 2.5 ms                                         |
| PostgreSQL `payload.find` limit 100 (TS, 300 posts)                                    | 8.7 ms                                         |
| ... of which `payload.db.find`                                                         | 5.8 ms                                         |
| ... same SQL through node-postgres directly: unprepared / prepared                     | 2.07 / 1.75 ms                                 |
| ... server side (`EXPLAIN ANALYZE`): planning / execution                              | 0.23 / 1.31 ms                                 |
| PostgreSQL `select 1` / `count(*)` round trip                                          | 0.06 / 0.11 ms                                 |
| PostgreSQL `payload.create` (TS): 10 statements, 10 round trips                        | 6.1 ms                                         |
| PostgreSQL begin + insert + commit, 3 round trips (this server's commit is cheap)      | 0.20 ms                                        |
| Import of `payload` / + db-mongodb / + richtext-lexical                                | 520 / 220 / 240 ms, 1,864 files, 12.5 MB of JS |
| Same with `NODE_COMPILE_CACHE` warm                                                    | 967 -> 735 ms total                            |
| In-process inspector read of a function's closure scopes                               | 0.09 ms per function                           |

From the perf suite's last full pass (typical, 1k posts, TS medians):

- **REST fixed overhead is about 1.0-1.3 ms** per request (`count` 0.09 ms Local vs 1.14 ms REST on MongoDB). It covers request construction, auth (the JWT strategy runs `payload.findByID` for the user on every request), i18n and response building.
- **GraphQL fixed overhead is about 2 ms.** `graphql-http`'s handler is rebuilt and the document parsed and validated on every request (`KnownTypeNamesRule` shows up in the profile).
- **A MongoDB `create` is 7.8 ms against a 2.0 ms transactional floor.** The remainder is mongoose document casting, depth-2 population of the result inside the transaction, and JS CPU.
- **SQLite writes are fsync-bound** (27-43 ms): the bench runs the default rollback journal with `synchronous=FULL`.
- **Startup**: `buildConfig` is 13 ms and `getPayload` 17-60 ms; import is 530-890 ms.

## 3. Strategies that keep the current storage format (ranked)

### S1. Fused lanes: whole operations in Rust, off the JS heap

**What.** At init, classify every (collection or global, operation) pair. If nothing on its path is uncompiled user JS, the operation runs entirely in Rust on tokio threads: access, where validation, query build, driver I/O, decode, transform, afterRead, select, population, pagination. The JS thread does three things: capture the arguments (one generated encoder per argument shape, into a buffer, no per-property Node-API calls), one napi call, and materialize one result.

**Eligibility, decided once per config:**

- no collection hooks on the path (`beforeOperation`, `beforeRead`, `afterRead`, `afterOperation` for reads), or only compiled ones (S6);
- `access.read` and field `access.read` absent, compiled, or bypassed by `overrideAccess`;
- no field `afterRead` hooks other than recognised built-ins; lexical's population hook needs a Rust port and is recognised by a marker the lexical package sets, custom lexical features fall off the lane;
- no function-valued `virtual`, `defaultValue` or `filterOptions` unless compiled.

Eligibility is per path: a collection with an `afterChange` revalidation hook (the website template) still has fused reads.

**Guards, checked per call (a few property reads):**

- arguments and `req` are inert (plain objects, no accessors or proxies; `mergeElision.ts` already has this check);
- no `req.transactionID` (a transaction user code may share stays on the live path);
- `payload.db[method]` and the mongoose `Model` methods are the pristine functions, the same pattern as `internalAdapterProperties` / `findUpstreamReason` in `packages/engine-rs/src/adapter/index.ts`;
- no mongoose schema middleware or plugins, and the intrinsics the port assumes are unpatched.

Any failed guard sends the call to today's exact engine.

**Errors are upstream's by construction.** The fast lane only has to be right on success. On any anomaly (forbidden, not found, a query error, an unknown BSON type, a document it cannot plan) a read is discarded and re-run on the exact lane. Reads are idempotent, so the only cost is a second read on error paths.

**Materialization.** Payload results on MongoDB are JSON-safe after `transform` (ids are strings, dates are ISO strings). Rust emits the final document as JSON text in upstream's key order and JS runs one `JSON.parse`: 5.7 µs per typical document against 18.6 µs for js-bson alone. A document holding a value JSON cannot carry (NaN, a `Date` inside a `json` field, a `__proto__` key) bails to the exact lane.

**Expected, Local API, typical shape:**

| operation                     | TS today               | fused floor                       | latency | JS-thread CPU |
| ----------------------------- | ---------------------- | --------------------------------- | ------- | ------------- |
| MongoDB findByID              | 0.39 ms                | ~0.20 ms                          | 2x      | >10x          |
| MongoDB find limit 10         | 0.97 ms                | ~0.30 ms                          | 3.2x    | ~11x          |
| MongoDB find limit 100        | 4.25 ms                | ~1.3 ms (0.76 I/O + 0.57 parse)   | 3.2x    | ~6.5x         |
| MongoDB find limit 10 depth 2 | 2.74 ms                | ~0.75 ms                          | 3.5x    | ~8x           |
| MongoDB count                 | 0.09 ms                | ~0.09 ms                          | 1x      | -             |
| SQLite findByID               | 0.59 ms                | ~0.04 ms                          | 10-15x  | >10x          |
| SQLite find limit 100         | 5.5 ms                 | ~0.9 ms                           | ~6x     | ~9x           |
| PostgreSQL find limit 100     | 8.7 ms (measured here) | ~1.9 ms (1.3 server + 0.42 parse) | 4.4x    | ~15x          |

The floors are sums of the measured parts above; none has been built.

- **Effort:** large, 4-6 weeks for reads on one database, then incremental.
- **Risk to exactness:** medium. Key order, default values, stripping of unknown keys and blocks, locale fallback and select semantics must be re-derived in the transcoder. Mitigation is a lane-shadow mode (below).
- **Tests touched:** none modified. `test/joins/queryPath.int.spec.ts` (4 spies on `Model.aggregate` / `paginate` / `findOne`) and the access-control test that counts `payload.db.findVersions` calls pass through the identity guards. `test/database` raw-insert tests ("additional keys stripping", "blocks that exist in the db but not in the config") define transcoder behaviour.
- **Owner decisions:** D1, D2, D3 in section 5.

**Verification.** Add a lane-shadow mode to the existing shadow harness: every fused call also runs on the exact lane, and the results are compared as serialized JSON including key order, plus the mutations replayed onto the caller's arguments. Run the whole upstream suite in that mode. Record per-test lane hit counters, so a suite cannot "pass" by always falling back.

### S2. HTTP lanes: REST and GraphQL responses as bytes

**What.** For fused operations the handler never creates the result as JS objects. Rust parses the URL and query string (qs semantics), verifies the JWT, fetches the user, runs the operation and returns the response body as bytes; JS builds `new Response(bytes, { headers })`. Three additions:

1. **Speculative auth.** When read access is compiled, the user fetch and the main query go out concurrently and the result is discarded if auth fails. Latency becomes the maximum of the two round trips instead of their sum.
2. **GraphQL document cache.** Cache parse and validate per query string (valid whenever `graphQL.validationRules` is absent), and build the `graphql-http` handler once. This is exact, independent of everything else, and worth an estimated 15-25% of a GraphQL request on its own.
3. **GraphQL plan compile.** A query whose selection set maps to one collection find becomes a fused operation with the projection derived from the selection set, emitted in GraphQL response shape.

**Expected (MongoDB, typical):**

| request                  | TS today | lane floor | latency |
| ------------------------ | -------- | ---------- | ------- |
| `GET /posts?limit=10`    | 2.26 ms  | ~0.40 ms   | 5.6x    |
| `GET /posts/:id`         | 2.58 ms  | ~0.30 ms   | 8x      |
| `GET /posts/count`       | 1.14 ms  | ~0.25 ms   | 4.5x    |
| GraphQL `Posts` limit 10 | 2.96 ms  | ~0.45 ms   | 6.5x    |

JS-thread CPU drops from about 2.2 ms to about 0.04 ms per request: roughly 50x throughput per process until the database saturates. On SQLite the same requests have no network floor, so 10x latency is reachable.

- **Effort:** medium, on top of S1; the document cache is days.
- **Risk:** medium. Headers, CORS, `mergeHeaders`, i18n-dependent error messages, cookie refresh. Anything unusual (custom auth strategies, custom endpoints, an error) leaves the lane.
- **Tests touched:** `collections-rest`, `collections-graphql`, `auth`, `access-control`, unmodified.
- **Owner decisions:** D1, D3.

### S3. Rust MongoDB driver behind a facade

**What.** The `mongodb` crate on tokio, with its own pool built from the same URL and `connectOptions`, serves the fused lanes and the "db lane" below. Mongoose stays exactly as it is for everything else.

- **`payload.db.collections` / `versions` / `globals` / `connection`** stay real mongoose objects. Upstream tests use them directly (`insertMany`, `find`, `.collection.insertOne`, `.collection.indexes()`, the reset and snapshot helpers through `Model.db.collections`), so they must keep working, and they do: the Rust driver is an additional client, not a replacement.
- **Spies and middleware:** per-call identity guards on the Model methods, plus an init-time check of schema hooks and plugins. A spied model or a schema with user middleware uses the live path, so the 4 `queryPath` tests see the mongoose calls they assert on.
- **Command shapes stay upstream's.** `test/joins/int.spec.ts` reads `system.profile` and asserts the count is an `aggregate` on that collection reading index keys only; the Rust driver must send the same commands, not merely equivalent ones.
- **Transactions.** A session that user code can reach (`req.transactionID` set by the caller, or any hook running inside the operation) stays on mongoose. Rust owns a transaction only when the operation starts it itself and no JS runs inside it. Sharing one server session between the two drivers is technically possible (same `lsid` and `txnNumber`) but would require advancing the Node driver's private session state machine; not recommended.
- **Unsupported setups** (`autoEncryption`, proxy or function-valued TLS options, the cosmosdb variant, `mongoose.set('debug')`, command-monitoring listeners) create no Rust client; everything runs as today.
- **Db lane for hooked collections.** When hooks keep the operation in JS, `payload.db.find` can still do its I/O and BSON decode in Rust and hand back `JSON.parse`d documents. That removes js-bson (1.86 -> 0.57 ms per 100 documents) and the driver and mongoose CPU (28% of a TS profile is `mongodb` + `mongoose`, 8% `bson`): about 1.5-2x on multi-document reads with hooks.

- **Effort:** large (3-5 weeks with S1's MongoDB transcoder).
- **Risk:** medium-high operationally: two pools, topology and failover behaviour, write-concern and read-preference parity.
- **Owner decisions:** D3, D4.

### S4. Rust PostgreSQL engine

`payload.db.find` of 100 posts is 5.8 ms where the server needs 1.5 ms: 3.7 ms is drizzle query building, node-postgres row parsing and Payload's read transform, all removable.

- **Statement generation in Rust** (RUST_POSTGRES_PLAN.md, reusing the SQL crates), cached per plan key as **named prepared statements** (saves the 0.23 ms planning per call).
- **tokio-postgres with pipelining** for fused lanes: `find` and its `count` in one flush; a `create`'s 10 statements in one flush instead of 10 round trips.
- **Rows straight to document JSON** in Rust, no JS row objects.
- **Option A (Rust builds SQL, node-postgres executes) is still needed** for transactions shared with user code and for `payload.db.drizzle` users. `payload.db.drizzle`, `pool`, `tables`, `execute`, push and migrations stay upstream.
- **Expected:** find limit 100: 8.7 -> ~1.9 ms (4.4x Local, ~6x REST). findByID 1.2 -> ~0.25 ms (4-5x). create 6.1 -> ~0.7-0.9 ms on this server (6-8x); on a server with a real fsync per commit the floor is the fsync.
- **A lead to measure:** the lateral `json_agg` subqueries are most of the 1.3 ms server time. Two pipelined statements (parent rows, then child rows `WHERE _parent_id = ANY($1)`) may be faster at 100 rows; SQL text is not user-visible in the fused lane.
- **Effort:** large (the plan's 5 modules, plus the driver). **Risk:** medium; SQL text and parameter parity is checkable by the existing shadow method. **Owner decisions:** D3, D4.

### S5. Config compilation and plan caches

- **Per-collection plans in Rust** for transform, afterRead, select, defaults and population, built once from the immutable sanitized config. This is S1's substance.
- **Query plan cache** keyed on (collection, where shape, select, sort, locale, depth, flags): the validated paths and the MongoDB filter template or prepared SQL are reused, only values are bound. This removes `validateQueryPaths` and `buildQuery` per call, where the Rust port is currently 7-20x slower than TS (6.6-166 µs), and most of the 25-70 µs fixed overhead per operation.
- **Generated JS for the non-fused path:** where hooks keep an operation in JS, emit specialised JS per fields array (straight-line property code instead of a generic traversal). The afterRead plan work showed the direction; expected 1.2-1.5x on hook-heavy reads.
- **Effort:** medium. **Risk:** low-medium (cache key completeness; a missed dimension is a wrong result, so the key is derived from the same inputs the planner reads).

### S6. Compiling user functions to a Rust-interpreted IR

"Compile to Rust" at runtime means compiling to a small expression IR interpreted in Rust (tens of nanoseconds per node), not generating Rust source.

**Common shapes** (templates in this repo): `() => true`; `({ req: { user } }) => Boolean(user)`; `authenticatedOrPublished` returning `true` or `{ _status: { equals: 'published' } }`; role checks through an imported helper (`checkRole(['admin'], user)`); owner constraints (`{ customer: { equals: user.id } }`); field hooks that trim or slugify; `beforeChange` hooks stamping dates or authors.

**Analysis:**

1. `Function.prototype.toString` and a Rust parser (oxc) produce the AST and the free identifiers.
2. **Free identifiers are resolved soundly through the in-process inspector** (`node:inspector` `Session`, `Runtime.getProperties` on the function's `[[Scopes]]`). Verified here on Node 24: it returns the module and closure scopes with their values synchronously, in 0.09 ms per function. It resolved an imported `checkRole` to its function, exposed a closure-captured `field = "tenant"` of an access factory, and showed a module that shadows the global `Boolean`, which source text alone cannot detect. Helpers are analysed recursively. Not yet verified: bundled Next.js production output, where imports become member reads on a captured module object.
3. **Accepted subset:** parameter destructuring; reads on `req.user`, `data`, `siblingData`, `value`, `originalDoc`, `id`, `doc`; literals, object and array literals; `=== !== && || ?? ! ?:`, optional chaining, `typeof`; `Boolean` / `String` / `Number`; `some` / `includes` / `every` over inert arrays with arrow callbacks in the subset; string `trim` / `toLowerCase` / `slice` / `replace` with ECMAScript regex semantics (the `regress` crate); template literals; `new Date()` / `Date.now()`; `if` / `return` chains.
4. **Rejected:** `await` of anything, `this`, calls into `req.payload`, loops, assignments to captured bindings, anything unresolved. A rejected function simply keeps its operation on the exact lane.
5. **Guard mode:** for the first N calls, and sampled afterwards, the real JS function runs as the authority and the compiled result is compared; a mismatch de-optimises that function permanently and logs it.

- **Expected:** no speedup by itself; it is what makes S1/S2 apply to real configs instead of only access-free ones. Without it, any collection with `access.read` is unfused for REST and GraphQL.
- **Effort:** medium (3-4 weeks for access functions, hooks later). **Risk:** medium; unsoundness is bounded by the guard mode.
- **Tests touched:** `access-control`, `hooks`, `fields`, unmodified; a new differential corpus of function shapes.
- **Owner decision:** D5.

### S7. Fused writes

A write is fusable when the collection has no uncompiled hooks or custom validators on the write path. Rust then runs beforeValidate, validation (built-in validators are already ported), beforeChange, the driver writes, afterRead and population.

- **MongoDB create:** 7.8 -> ~2.0-2.5 ms (3-4x). The floor is the majority-acknowledged commit (1.4-2.0 ms measured). Result population runs in parallel with nothing else waiting on it.
- **Single-statement writes without a transaction** (a create with no versions and no hooks is one atomic `insertOne`): 7.8 -> ~1.7 ms (4.5x). Same end state, different command stream: decision D6.
- **PostgreSQL:** see S4. **SQLite:** fsync-bound, 1.0-1.3x (see the durability note in section 4).
- **Failure handling:** a failure before the first write (validation, access) re-runs on the exact lane for the upstream error. A failure after a write rolls the Rust-owned transaction back first, then re-runs.
- **Auth operations:** `login` and `resetPassword` are 90-180 ms of password hashing: 1.0x, and not changeable without changing stored hashes.
- **Effort:** large. **Risk:** higher than reads (not idempotent). Sequence it after the read lanes are proven.

### S8. Startup

Import is 530-890 ms of a 600-1,000 ms start. Ranked:

1. **Lazy-load what a production start never uses.** Loaded eagerly today: `prettier`, `lodash`, `json-schema-to-typescript`, `js-yaml`, `prompts`, `commander`, `pino-pretty`, `undici` (110 files), `zod` (104 files) and the SQL adapters' schema tooling. The SQLite adapter import alone is 500-800 ms. Expected: -150 to -400 ms.
2. **Enable Node's compile cache** (`module.enableCompileCache()` from Payload's entry): measured -24% (967 -> 735 ms).
3. **Ship bundled dist entries** (one file per package entry instead of 1,027 for `payload`): module resolution is a visible share of the profile (`package_json_reader` 4.9% of a whole bench process). Estimated import 150-250 ms.
4. **Lazy mongoose.** With the Rust driver serving Payload's own queries, build mongoose models (and load mongoose, 394 files with its driver) on first access to `payload.db.collections`. This removes most of `getPayload` on wide configs (280 ms at 200 collections). Index creation must still happen at init, through the Rust driver.
5. **Fix the Rust engine's own regressions:** wide-200 `getPayload` is 94 -> 282 ms on SQLite and 280 -> 372 ms on MongoDB (schema JSON round trip and per-collection decode).

- **Expected:** typical start 600 -> ~170-250 ms (2.5-3.5x); wide-200 838 -> ~250 ms.
- **Not viable:** a V8 startup snapshot (native addon, ESM and the user's config make it impractical). Caching the sanitized config would save 13 ms.
- **Effort:** small to medium. **Risk:** low for 1, 2 and 5; medium for 3 and 4 (decisions D7, D8).

### S9. Throughput

- **Parallelism for free with S1/S2:** fused operations run on tokio threads, so one Node process uses all cores for Payload work. The JS thread costs about 20-60 µs per request, which puts the ceiling of a single process at roughly 15-40k simple reads per second, against 400-1,000 today, until the database saturates. This is the metric where 10x holds on every database.
- **Batched completions:** resolve all operations that completed in one loop turn with a single thread-safe-function wakeup.
- **Request coalescing:** identical in-flight fused reads (same plan key, binds and user) share one round trip; each caller gets its own parse of the shared bytes. Exact in the sense that each caller could have legitimately observed that snapshot: decision D9.
- **Population batching:** one `$in` / `ANY` query per related collection and depth level, issued concurrently, in Rust. Upstream's per-request dataloader stays for the JS path.
- **Per-request access cache:** a compiled access result is a pure function of the captured inputs, so it is computed once per request and reused across population.
- **The perf suite measures none of this.** It needs concurrency scenarios (e.g. 64 concurrent `find limit 10`, reporting requests per second and JS-thread CPU per request), added under `test/__rs/perf`.

### S10. Cheap fixes visible in the numbers (no architecture change)

- **SQLite result path:** results come back as a JSON string, are parsed, then walked again by a generic decoder (`deserializeFromEngine`: `Object.entries` per object, a tuple per value). Emit the final shape directly and list the rare non-JSON values by path. Expected: SQLite multi-document reads from 0.34-0.73x to above 1.5x.
- **`REST POST /media` on SQLite is 0.17x** (84.8 vs 14.7 ms): looks like extra commits or an upstream fallback. `count where` on PostgreSQL is 0.29x (0.17 -> 0.58 ms) with the Rust core only. Both look like bugs.
- **MongoDB live path:** `awaitValue` and `mapWith` are 20% of self time in the Rust-engine profile taken here.
- **Count the commits per SQLite write** with the existing statement trace: `update by id` is 43 ms against 28 ms for `create`, which suggests a second fsync'd commit; each one avoided is about 14 ms.

### S11. Node-API overhead on the paths that stay live

One `JSON.parse` instead of per-property creation; external Latin-1 strings for ASCII payloads; generated argument encoders writing into a shared buffer; no persistent references per document. Worth 1.1-1.3x on hooked paths; unnecessary on fused paths.

## 4. Storage: additive auxiliary data only

The owner's rule: existing documents and rows keep exactly their current shape and meaning. Only additive data that Payload maintains itself and that users never see is allowed (extra indexes, internal shadow fields or collections, precomputed auxiliary data). Everything in sections 3, 6 and 7 works with no storage change at all; the items below are optional extras, with gains stated **on top of** that plan. None is in the recommended work packages.

**What the tests fix** (so auxiliary data must tolerate documents that lack it and must never be trusted blindly):

- Raw documents are inserted through the driver and then read through Payload: `test/database/int.spec.ts` (unknown keys, unknown blocks, localized blocks as `{ en: [...] }`, the relationship v2 -> v3 migration asserting raw `ObjectId` values) and `test/localization/localizeStatus.int.spec.ts` (old-format version documents). Such documents have no auxiliary data, so every read must fall back to the canonical data when it is missing or stale.
- `test/sizes-to-variants` reads raw documents and a collection's index list (mostly `toContain` on keys and names, plus index creation and drop by name): extra indexes must not collide with names Payload or the migrations use.
- `test/joins/int.spec.ts` asserts on the profiled `aggregate` command of a count: auxiliary data must not change which command a canonical query sends.
- The reset and snapshot helpers clear and restore only what is reachable through the mongoose connection's registered collections and `payload.db.tables`. An auxiliary table or collection outside them survives a reset holding stale data. Each auxiliary record therefore has to carry a validity stamp of its source (e.g. the row's `updated_at` plus a content hash) that is checked on read.
- Users read documents directly through `payload.db.collections[slug]` and `payload.db.drizzle`. A shadow field inside an existing document or row would be visible there, so auxiliary data belongs in separate collections or tables, not in the existing ones.

### Allowed (additive), ranked by extra gain

| #   | auxiliary data                                                                                                                                                                                            | relies on                     | extra gain on top of section 3                                                                                                                                                                                                      | maintenance and verification                                                                                                                                                                                                             | verdict                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **PostgreSQL read projection:** a shadow table per collection holding each document as one `jsonb` value (normalized tables stay the source of truth for where, sort, joins and for `payload.db.drizzle`) | shadow table + validity stamp | multi-document reads: server time 1.3 ms -> est. 0.2-0.3 ms, so find limit 100 ~1.9 -> ~0.8 ms: **~2.4x Local, up to ~4x REST**; findByID ~1.2x. The 0.2-0.3 ms is an estimate: measure a single-table `jsonb` scan before deciding | written in the same transaction as the row (+5-10% per write); a raw write through drizzle leaves the stamp stale and the read falls back; backfill in batches; verify by comparing relational read vs projection read over whole tables | the only auxiliary structure with a real multiplier. Open problem: drizzle push and generated-schema tests must not see or drop the shadow tables |
| A2  | **SQLite read projection:** the same as A1                                                                                                                                                                | shadow table + stamp          | est. 1.5-2x on array-heavy multi-document reads (fewer per-row child-table lookups); not measured                                                                                                                                   | as A1                                                                                                                                                                                                                                    | optional, after A1 proves out                                                                                                                     |
| A3  | **Auxiliary indexes** chosen from the plan cache's observed query shapes (sort fields, `{ parent, latest }` on versions, filtered counts)                                                                 | extra indexes                 | workload-dependent: nothing at 100-1k documents; at 10k+ an index-backed sort or filter can be 2-5x for that query. Not measured here                                                                                               | every index costs each write; verify with `explain` before and after; names must not collide with the migration tests'                                                                                                                   | per-deployment tuning, not a general multiplier                                                                                                   |
| A4  | **MongoDB latest-draft shadow collection** (the latest version per document, keyed by parent)                                                                                                             | shadow collection + stamp     | draft reads est. 1.3-2x (one keyed lookup instead of a versions aggregate)                                                                                                                                                          | written with every version write; missing or stale entries fall back to the versions collection                                                                                                                                          | weak                                                                                                                                              |
| A5  | **MongoDB precomputed population** (shadow copies of related documents)                                                                                                                                   | shadow collection             | depth >= 1 reads save one batched round trip per level (~0.2 ms of ~0.75 ms): <= 1.3x; concurrent batched queries or `$lookup` already get most of it with no auxiliary data                                                        | fan-out on every related write; populated documents still need the related collection's access and hooks applied                                                                                                                         | not worth it                                                                                                                                      |
| A6  | **MongoDB per-locale shadow copies**                                                                                                                                                                      | shadow collection             | ~0-5%: an inclusion projection (`title.de`, `title.en`) already avoids transferring other locales                                                                                                                                   | doubles localized storage                                                                                                                                                                                                                | not worth it                                                                                                                                      |

### Not allowed under the rule

- **Storing MongoDB ids and dates in output form**, or any other rewrite of existing fields (including a different layout for localized values): changes the stored format. It would also gain about nothing: BSON -> JSON transcoding in Rust is ~0.1 ms per 100 documents, off the JS thread.
- **Shadow fields inside existing documents or rows** (e.g. the latest draft inline on the main document, a `jsonb` column on the main table): additive, but visible to users reading through mongoose or drizzle. Use separate shadow collections or tables (A1, A4) instead.

### Separate from the data model: SQLite durability default

SQLite writes are 27-43 ms because every commit fsyncs under the default rollback journal. WAL with `synchronous=NORMAL` (the adapter's existing `wal` option) would bring them to an estimated 1-3 ms, **10-20x on SQLite writes**. It does not change stored documents, but it changes durability on power loss and the files on disk, so it is a user-facing default and an owner decision, not something the engine may switch silently.

## 5. Decisions the owner has to make

- **D1. Tick exactness on fused lanes.** Today the engine preserves the number of microtask ticks. A fused operation returns identical results, errors and database effects, but settles after a different number of ticks, so its interleaving with concurrent user promises changes. Without accepting this, S1/S2/S7 are impossible.
- **D2. In-place mutation of caller arguments** (e.g. `where` sanitization). Recommended: replay the mutations after the call (the SQLite engine already returns a mutation list). The alternative is to waive it.
- **D3. A second connection pool** (Rust driver) beside mongoose's or pg's: more connections, and Payload's own queries no longer pass through the Node drivers, so command-monitoring listeners and APM auto-instrumentation of `mongodb` / `pg` do not see them. Recommended: an environment switch to force the Node driver.
- **D4. Transactions owned by Rust** are invisible in `payload.db.sessions` while they run (no JS runs inside them).
- **D5. Compiled functions.** Assumptions: captured bindings are not reassigned after startup, the function is deterministic given its inputs, intrinsics are unpatched. Also: opening an in-process inspector session at init, and whether guard-mode sampling stays on in production.
- **D6. Dropping the transaction around single-statement writes** and pipelining or merging statements: same end state, different command stream in database logs.
- **D7. Bundled dist files:** deep imports into `payload/dist/...` (not public API) would break.
- **D8. Lazy mongoose models:** `payload.db.collections[slug]` becomes an accessor property that builds the model on first read (visible only through `Object.getOwnPropertyDescriptor`).
- **D9. Request coalescing** of identical concurrent reads.
- **D10. Auxiliary data** (section 4): whether any of A1-A4 is worth its write cost and operational surface, and the SQLite durability default.

## 6. Recommended work packages (parallel, disjoint files)

| WP                              | scope                                                                                                                                                                                                  | files                                                                                                                         | target on the perf suite                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Fused read core + SQLite** | lane classification, guards, argument capture, plan cache, mutation replay, lane-shadow mode, the `FusedBackend` trait (published first as a contract), SQLite backend on the existing Rust SQL engine | new `crates/payload-fuse*`, `packages/engine-rs/src/fuse/`, dispatch in `packages/engine-rs/src/ops/index.ts`                 | SQLite minimal + typical, Local reads: findByID >= 10x, find limit 100 >= 5x, geometric mean of the read category >= 4x; lane-shadow 0 diffs over the upstream suite       |
| **B. MongoDB driver lane**      | `mongodb` crate client and pool, BSON -> JSON transcoder plans, db lane for hooked collections, guards for spies and middleware                                                                        | new `crates/payload-mongo-driver*`, `packages/engine-rs/src/mongo-fast/`, one hook in `packages/db-mongodb/src/index.ts`      | MongoDB typical: find limit 100 <= 1.4 ms (>= 3x), findByID <= 0.22 ms, hooks shape multi-document reads >= 1.5x; the 4 `queryPath` tests pass                             |
| **C. HTTP lanes**               | GraphQL document cache and one-time handler (first, independent), REST byte responses, speculative auth, GraphQL plan compile                                                                          | `packages/next/src/routes/`, `packages/graphql/src/`, `packages/payload/src/auth/strategies/`                                 | step 1: GraphQL scenarios >= 1.2x with no other change; with A/B: REST `GET` list / id / count >= 4x on MongoDB and >= 8x on SQLite                                        |
| **D. Function compiler**        | oxc analysis, inspector scope resolution, IR and interpreter, guard mode, differential corpus                                                                                                          | new `crates/payload-fn-ir`, `packages/engine-rs/src/compile/`                                                                 | complex shape (query-constraint access, field access): reads with `overrideAccess: false` reach the same multiples as A/B; >= 90% of the template access functions compile |
| **E. Startup and regressions**  | lazy imports, compile cache, bundling trial, the SQLite result decoder (S10), wide-200 regressions, the two outliers, concurrency scenarios in the perf suite                                          | import sites in `packages/payload`, `packages/db-*`, `packages/drizzle`; `packages/engine-rs/src/adapter/`; `test/__rs/perf/` | startup typical >= 2x on all three databases, wide-200 >= 1.5x; SQLite multi-document reads >= 1.5x; no scenario below 0.9x                                                |

The PostgreSQL engine (S4) and fused writes (S7) follow once A's contract is proven; S4 can start in parallel as a sixth package (`crates/payload-pg*`, `packages/db-postgres`, `packages/drizzle/src/postgres`) if an agent is available, with find limit 100 <= 2.2 ms and create >= 3x as targets.

## 7. What can and cannot reach 10x

| surface                                         | MongoDB    | PostgreSQL                 | SQLite                                                   |
| ----------------------------------------------- | ---------- | -------------------------- | -------------------------------------------------------- |
| Local API reads, latency                        | 2-3.5x     | 4-5x                       | **6-15x**                                                |
| REST / GraphQL reads, latency                   | 4.5-8x     | ~6x                        | **>= 10x**                                               |
| Reads, throughput and JS-thread CPU per request | **10-50x** | **10-50x**                 | **10-50x**                                               |
| Writes, latency                                 | 3-4.5x     | 3-8x (commit cost decides) | 1.0-1.3x (10-20x only with the WAL default of section 4) |
| Operations with uncompiled hooks                | 1.5-2x     | 1.5-2x                     | 1.5-3x                                                   |
| Login, password reset                           | 1.0x       | 1.0x                       | 1.0x                                                     |
| Startup                                         | 2.5-3.5x   | 2.5-3.5x                   | 2.5-3.5x                                                 |

All multiples in this table are projections from the measured floors in section 2, not results.
