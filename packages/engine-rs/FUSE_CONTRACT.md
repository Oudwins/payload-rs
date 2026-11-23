# Fused read lanes: contract (Rust core ⇄ backends ⇄ TS dispatch)

Binding interface of the fused read lanes (RUST_PERF_PLAN.md S1, work package A):

| part                           | where                                                          |
| ------------------------------ | -------------------------------------------------------------- |
| core (backend-agnostic)        | `crates/payload-fuse`                                          |
| SQLite backend                 | `crates/payload-fuse-sqlite`                                   |
| napi binding                   | `crates/payload-node/src/fuse.rs` (`fuseBinding()`)            |
| TS dispatch, plans, guards     | `packages/engine-rs/src/fuse/`, called from `src/ops/index.ts` |
| SQLite target lookup (adapter) | `getFusedSqliteTarget` in `packages/engine-rs/src/adapter`     |

A backend (MongoDB: work package B) implements [`FusedBackend`](#the-fusedbackend-trait) and a TS
target lookup; everything else is shared. Breaking changes are written here first.

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
- the collection read access is only reached with `overrideAccess` truthy. Compiled access
  functions (work package D) plug in here: `fuse/compiled.ts` `isCompiledAccess(fn)` returns
  `false` until D provides its registry, so every user function is non-eligible.

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
- options the v1 core does not implement send the call to the exact lane: `includeLockStatus`,
  `draft` with drafts, `joins` with values, `data` (findByID), `disableErrors` misses,
  population (`depth && currentDepth <= depth` with relationship fields in the plan), `locale`
  `'all'` with localized blocks.

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
