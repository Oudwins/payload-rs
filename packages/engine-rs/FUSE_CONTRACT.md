# Fused read lanes: contract (Rust core ⇄ backends ⇄ TS dispatch)

Binding interface of the fused read lanes (RUST_PERF_PLAN.md S1, work package A):

| part                           | where                                                          |
| ------------------------------ | -------------------------------------------------------------- |
| core (backend-agnostic)        | `crates/payload-fuse`                                          |
| population (dataloader)        | `crates/payload-fuse/src/populate.rs`, `src/fuse/populate.ts`  |
| SQLite backend                 | `crates/payload-fuse-sqlite`                                   |
| MongoDB backend                | `crates/payload-fuse-mongo`, `src/fuse/mongo.ts`               |
| napi binding                   | `crates/payload-node/src/fuse.rs` (`fuseBinding()`)            |
| TS dispatch, plans, guards     | `packages/engine-rs/src/fuse/`, called from `src/ops/index.ts` |
| SQLite target lookup (adapter) | `getFusedSqliteTarget` in `packages/engine-rs/src/adapter`     |
| MongoDB target lookup          | `registerFusedMongoTarget`, called by the driver lane          |

A backend implements [`FusedBackend`](#6-the-fusedbackend-trait) and a TS target lookup;
everything else is shared. Breaking changes are written here first.

## 1. What a fused call is

A read operation (`find`, `findByID`, `count`) whose whole path contains no user JS runs as one
synchronous native call: the core builds the `payload.db.<method>` arguments the exact lane would
pass, runs them on the backend, applies upstream's `afterRead` field traversal (hidden fields,
select, locale hoisting, default values, depth-0 relationship normalization, rich text) and the
operation's own result shaping in Rust, and returns the final result as JSON text in upstream's
key order. JS materializes it with one `JSON.parse`.

The **exact lane** (the tick-exact Rust engine, `crates/payload-core-ops`) stays the fallback for
everything else and is the authority on errors: a fused call only has to be right on success. Any
anomaly (an error from the database, a value the core cannot reproduce, a branch the core does not
implement) is a **bail**: the fused result is discarded and the operation runs on the exact lane
with the caller's untouched arguments. Reads are idempotent, so a bail only costs the second read.

Owner decisions this relies on (RUST_PERF_PLAN.md section 0): D1 (a fused call settles after a
different number of microtask ticks; results, errors, database effects and the order of everything
inside the operation are unchanged), D2 (argument mutations are replayed; the v1 lanes only run
when the exact lane would not mutate the caller's arguments, see guards).

## 2. Eligibility (decided once per collection config object, re-verified per call)

`fuse/plan.ts` builds a **collection plan** the first time a collection is read, cached in a
`WeakMap` keyed by `collection.config`. A plan is either `ineligible` (with a reason, for the stats)
or eligible with:

- `volatile`: `[object, key, expected]` triples of every config property the decision depends on
  (hook arrays and their lengths, `access.read`, editor hooks, ...). The per-call guard compares
  them (`object[key] === expected`), so a hook pushed or replaced at runtime sends the call to the
  exact lane and rebuilds the plan.
- `fields`: the field plan (JSON) registered once in the native registry (`registerPlan`), id in
  the request.

A collection is eligible for reads when:

- no collection hooks on the read path: `beforeOperation`, `beforeRead`, `afterRead`,
  `afterOperation` are empty;
- no field `hooks.afterRead`, no string `virtual` (also nothing `sanitizeWhereQuery` /
  `sanitizeSelect` would rewrite), no function `defaultValue` other than the array row `id`
  default of sanitization (applied only to rows without an `id`: the core bails then);
- field `access.read` is allowed only while `overrideAccess` is truthy (per call);
- `richText` fields use lexical whose `afterRead` editor hook is recognised by its marker
  (`Symbol.for('payload.engine-rs.lexicalAfterRead')`, set by `@payloadcms/richtext-lexical`) and
  has no feature-level `afterRead` hooks; the node types with node hooks or sub fields are listed in
  the plan, and a document holding one of them bails (custom features fall off the lane);
- no join fields (v1), no drafts (`versions.drafts`, v1), no `select` config function;
- without `overrideAccess` the collection read access must be compiled by the function compiler
  (FN_COMPILE_CONTRACT.md): it runs in the lane only while call-site guards are installed (payload's
  `init` installs sampled guards with the Rust core) and `fnIrLaneShouldVerify` does not ask for
  the call; its result is `true` (no constraint) or a where constraint combined like
  `executeAccess`' result; falsy, a bail, a de-optimised function or field `access.read` run the
  exact lane. `where` paths are then `id` only and no `sort` (field permission checks).

## 3. Guards (per call)

- the arguments are inert: `args`, `req`, `where`, `sort`, `select`, `populate`, `joins` are plain
  objects / arrays (`req` may also be a `PayloadRequest` built from a web `Request`: a plain
  `Request` whose `locale`, `fallbackLocale`, `payload`, `payloadAPI`, `transactionID`, `user`,
  `query` are absent or own data properties) (prototype `Object.prototype`, `Array.prototype` or `null`, no accessors, no
  symbol keys, no proxies: `util.types.isProxy`), values are JSON-like (strings, finite numbers,
  booleans, null; `Date`s only where the encoder accepts them);
- no `req.transactionID` (a transaction user code may share stays on the exact lane);
- `payload.db` is the backend's adapter and the backend says a call made now would run on it
  (SQLite: `getFusedSqliteTarget`: the engine-backed data methods are installed and pristine, no
  replaced internal adapter property, the drizzle session has a no-op logger and the Rust client
  with its original `execute`, the live schema was accepted);
- the `where` is accepted by the conservative validator (`fuse/where.ts`): every path resolves to
  a non-hidden, non-virtual field through groups, tabs, arrays and one string relationship hop,
  operators are valid, `like` / `contains` values are not objects; anything else (the exact lane
  would throw a `QueryError` or rewrite the query) runs on the exact lane;
- options the core does not implement send the call to the exact lane: `includeLockStatus`,
  `draft` with drafts, `joins` with values, `data` (findByID), `disableErrors` misses, `locale`
  `'all'` with localized blocks;
- `req` is a plain object, a web `Request` carrying Payload's properties, or Payload's own
  `isolateObjectProperty` proxy of either (the proxies are recorded in a `globalThis` `WeakMap`,
  `Symbol.for('payload.isolateObjectProperty')`);
- population (`depth && currentDepth <= depth` with relationship fields in the plan) only with
  `overrideAccess: true`, `req.i18n` set, no `transactionID`, a fresh payload dataloader and, with
  localization, one locale and a fallback the nested finds' `createPayloadRequest` keeps (section 9); the text lane (`fusedOperationText`) does not populate.

## 4. Request (JS → native)

Repeated query shapes reuse their statements: `crates/payload-fuse-sqlite/src/templates.rs` keys
the `payload.db` arguments with `where` leaf values of safe classes as slots, builds the template
from sentinels once, verifies that every sentinel comes back as one whole bound parameter, and
binds the call's values (`PAYLOAD_RS_FUSE_TEMPLATES=off` disables it).

`fuseBinding().run(backend, conn, requestJson) → string` (synchronous for SQLite).

```jsonc
{
  "op": "find" | "findByID" | "count",
  "plan": 3,                 // registerPlan id
  "db": { ... },             // the payload.db.<method> args the exact lane passes, in the
                             // serializeForEngine tree format, req reduced to
                             // { fallbackLocale, locale, payloadAPI }
  "method": "find" | "findOne" | "count",
  "depth": 0, "currentDepth": 1,
  "locale": "en" | null, "fallbackLocale": ... , "localization": false | { "locales": [...] },
  "showHiddenFields": false, "overrideAccess": true, "flattenLocales": true,
  "select": { ... } | null,  // sanitized select (upstream's sanitizeSelect / resolveSelect)
  "selectMode": "include" | "exclude" | null,
  "auth": false,             // auth collection: `{ ...doc, collection: slug }`
  "slug": "posts",
  "context": { "blocksAsJSON": false, "limitedBoundParameters": false } // adapter flags at call time
}
```

## 5. Result (native → JS)

- success: JSON text of the operation's result (`find`: the paginated result, `findByID`: the
  document, `count`: `{ totalDocs }`), key order as upstream produces it. JS returns
  `Promise.resolve(JSON.parse(text))` (a native promise; tick count differs, D1).
- bail: text starting with `!` followed by the reason (`!populate`, `!db:DrizzleQueryError`,
  `!value:undefined`, ...). JS counts it and runs the exact lane.

**Materialization rules** (bail when violated): every value is representable in JSON and comes
back from `JSON.parse` identical to what upstream returns: no own `undefined` properties, no
`NaN` / `Infinity`, no `bigint`, no `Date` objects, no `__proto__` keys. `-0` is written as `-0`.
Integer-like keys are fine (JSON.parse orders them like any JS object).

### Text results (RUST_HTTP_LANES.md 3.1 / 3.2)

`fusedOperationText({ operation, operationArgs })` (exported from `src/fuse` and the `ops`
entry) runs the same guards and core with `"canonical": true` in the request and returns the
result text instead of materializing it, or `undefined` (nothing observable ran; the caller runs
the exact operation). Canonical text is `JSON.stringify(JSON.parse(text))` byte for byte: `-0` is
written as `0`, an integer-like key bails (JS would order it first), spliced json / rich text
values must already be canonical (`scan::is_canonical`). In shadow mode it checks that invariant
and returns `undefined`. `findGlobal` is not fused yet (`undefined`).

## 6. The FusedBackend trait

```rust
// crates/payload-fuse/src/backend.rs
pub trait FusedBackend {
  /// "sqlite", "mongodb": stats and bail reasons.
  fn name(&self) -> &'static str;
  /// Runs `job` with a read session on the backend connection `conn` (the id the TS target
  /// lookup returned) and returns its result. Blocks until the job finished. All reads of one
  /// fused operation run in that one job, in order.
  fn run(&self, conn: u32, job: Job) -> FuseResult<String>;
}

pub type Job = Box<dyn FnOnce(&mut dyn ReadSession) -> FuseResult<String> + Send>;

pub trait ReadSession {
  /// `payload.db.find(args)`: the paginated result exactly as the TS adapter returns it.
  fn find(&mut self, args: &JsVal) -> FuseResult<JsVal>;
  /// `payload.db.findOne(args)`: the document or `null`.
  fn find_one(&mut self, args: &JsVal) -> FuseResult<JsVal>;
  /// `payload.db.count(args)`: `{ totalDocs }`.
  fn count(&mut self, args: &JsVal) -> FuseResult<JsVal>;
  /// Optional: `find` / `findOne` plus the operation's per-document work (auth `collection` key,
  /// `afterRead` of `read`) written directly as the result JSON; `None` = not available for this
  /// call (the core then runs `find` / `find_one` and its own `afterRead` on the `JsVal` trees).
  fn find_json(&mut self, args: &JsVal, one: bool, read: &DirectRead<'_>) -> Option<FuseResult<String>> { None }
}
```

The core entry is `payload_fuse::run(backend: &dyn FusedBackend, conn, request_json) -> String`
(result JSON or `!<reason>`); `payload_fuse::register_plan(json)` registers collection plans.

The SQLite backend implements `find_json` for collections whose fields the drizzle read transform
maps one to one (`crates/payload-fuse-sqlite/src/fast.rs`: no localized fields, blocks, joins,
points, hasMany text / number / select): the engine's own statements (same SQL, same order, cached
prepared statements), rows decoded straight into the document shape (`tplan.rs`: the transform
compiled once per `flattenedFields`), the plan's `afterRead` rules applied to that tree, json /
rich text values validated (`scan.rs`, `JSON.parse` grammar plus lexical's node traversal) and
spliced as stored. `PAYLOAD_RS_FUSE_SQLITE_FAST=off` forces the generic path (engine methods plus
the core's `afterRead`).

- `args` is the argument object the exact lane passes to `payload.db.<method>`, decoded from the
  `serializeForEngine` tree format (`payload_engine::js::decode_graph_typed`), `req` reduced as in
  section 4. Results are `JsVal` trees equal to what the TS adapter method returns (same keys, key
  order, values); typed values (`JsVal::date`, bigint, BSON) are allowed and make the core bail
  at materialization unless the core can write them.
- Any database error is `Err(Bail::Db(name))`: the exact lane reruns the operation and throws the
  adapter's real error.
- A backend must not call JS. SQLite: the job runs inside one `payload-sqlite` queue job on the
  connection's worker (statements in queue order with every JS client statement, no interleaving
  inside the operation: a valid serialization of the stepped engine's interleaving).
- An async backend (MongoDB on tokio) may run `payload_fuse::run` on its own thread and resolve a
  promise instead; the JS dispatch accepts `string | Promise<string>` from `run`.

## 7. Lane-shadow mode

`PAYLOAD_RS_FUSE=shadow` (verification only): every call that passes the guards runs the fused
lane, then the exact lane on the real arguments (whose result is returned to the caller), and
compares:

- the results serialized with key order, own `undefined`, `-0`, `NaN`, `Date`s, class names and
  shared identities (`fuse/shadow.ts` `canonical`);
- the caller's arguments after the exact lane against a snapshot taken before both lanes (the
  fused lane performs no mutation, so they must be equal; v1 runs only where upstream does not
  mutate).

Counters (`PAYLOAD_RS_FUSE_STATS_DIR=<dir>`: `fuse-<pid>.json`, throttled + at exit):
`hits[op]` (fused results returned or compared), `bails[reason]`, `ineligible[reason]`,
`guards[reason]`, `diffs` (shadow, with the first differing path per case written to
`fuse-diffs-<pid>.jsonl`). A suite run proves the lane ran by non-zero `hits` per file that
reads. `PAYLOAD_RS_FUSE=off` disables the lanes; unset (or `on`) is the default.

## 8. The MongoDB backend

`registerFusedMongoTarget` (src/fuse/mongo.ts) runs when the driver lane is installed
(MONGO_DRIVER_CONTRACT.md); per call its lookup requires the adapter's read methods to still be
the driver lane's, a driver client, no tracing / lane verify mode, no mongoose setting the lane
refuses. The target's `encode` turns the `payload.db.find` / `findOne` / `count` args into the
reads the driver lane would send, without mongoose:

- upstream's planning: `buildSortParam` (no relationship sort: `sortAggregation` stays empty),
  `buildProjectionFromSelect`, `sanitizeQueryValue`, and `parseParams` / `buildAndOrConditions` /
  `buildSearchParam` re-stated synchronously without their sub-query branches (relationship /
  join hops, nested relationship queries, `near` / geo / `all` / `not_like` run the exact lane);
- mongoose's casting (`cast.js`) re-stated for the cases where it is the identity (a string on a
  String path, a finite number on a Number path, an ObjectId on an ObjectId path, a valid Date on
  a Date path, a boolean on a Boolean path, `null` / `undefined`, Mixed paths, prefix paths of
  sub-schemas and arrays) or converts 24-digit hex strings on ObjectId paths; setters other than
  `_id`'s `resetId`, embedded discriminators in a path, `strictQuery` and anything else run the
  exact lane. The projection mongoose executes with (`_optionsForExec`: schema-level projections,
  embedded discriminator keys) is computed by mongoose once per model and projection (a query
  that is never executed) and cached;
- mongoose-paginate-v2's count / find decisions (estimated count for an empty filter, custom
  counts, `skip` / `limit`, collation) and result `meta`.

The reads (js-bson, the driver lane's `ReadArgs` plus `op` and `meta`) and the request go to
`fuseRunMongo(client, transformPlan, requestJson, reads) -> Promise<string>`: on the driver
runtime it runs the count and find (both in flight), decodes and transforms the documents (the
driver crate's `transform_read`) into the core's values and runs the core (`afterRead`,
population, result JSON). Documents are converted in chunks of 32 on the runtime's workers while
the cursor still yields, like the driver lane's transform. Guided by the collection plan, a raw
(still undecoded) json value or rich text without node types that have `afterRead` work is not
converted: it becomes a raw leaf (`payload_fuse::RawLeaves`, an empty object identified by its
address in the job's table, written as the driver lane's JSON text of the subtree). The traversal
never reaches into one, because only plan leaves become raw. Canonical text converts everything.
Shadow mode also runs the exact lane traced and compares its driver
operations (filter, sort, projection, skip, limit, hint, collation as js-bson serializes them)
with the fused reads.

## 9. Population (depth >= 1)

Upstream populates through the request dataloader (`relationshipPopulationPromise`,
`batchAndLoadDocs`): the loads of one level form one batch in load order (a repeated key is served
from the cache: the same object), grouped by everything in the key but the id (first appearance
order) into one nested `payload.find({ where: { id: { in } }, pagination: false })` each, one after
the other, each nested find populating the next level before it returns. The core reproduces it
(`populate.rs`): `afterRead` records the loads (paths of the slots, the dataloader keys), the
batches run depth first through `ReadSession::populate_find` (SQLite: the engine's `find`; MongoDB:
the cast `{ $and: [{ _id: { $in } }] }` with the collection's sort and projection), the nested
documents get their own `afterRead`, documents are matched to keys by id, missing ones keep the
id, trashed ones become `null`, hasMany arrays drop `null`s.

The request carries `"pop": { draft, joins, locale, req, related: { [slug]: { plan, select,
selectMode, sort, trash, numberID, auth, backend } } }` for the collections the levels can reach
(an unlisted one bails). A populated result is `#` plus `{ r, x, p, k, n }`: the result with each
document written once (`p`: the other paths that hold the same object), documents only the
dataloader holds (`x`, e.g. trashed ones), the dataloader entries in cache insertion order (`k`:
`[slug, id, depth, currentDepth, path | null]`) and the nested finds (`n`: their depth). JS
(`fuse/populate.ts`) restores the shared objects, primes `req.payloadDataLoader` with
`createDataloaderCacheKey` keys and those objects (the cache upstream leaves: same keys, same
order, same objects), and replays the nested finds' `req` mutations (`req.transactionID = null`,
`createPayloadRequest({ depth, ... })`). Shadow mode compares the keys, the cached objects' places
in the result and the `req` state with what the exact lane left.
