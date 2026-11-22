# Rust operations: design, status, dispatch, verification

Scope: `packages/payload/src/collections/operations/*.ts`, `globals/operations/*.ts`,
`auth/operations/*.ts` and `auth/executeAccess.ts` in Rust on the core runtime
(`payload-core-runtime`, strategy B of RUST_CORE_DESIGN.md), with exact upstream behaviour while
the TS API stays unchanged.

## 1. Status

Ported (crate `crates/payload-core-ops`), verified differentially (section 5):

| TS (packages/payload/src/...)                                               | Rust                              |
| --------------------------------------------------------------------------- | --------------------------------- |
| `collections/operations/find.ts` (incl. lock status)                        | `find.rs`                         |
| `collections/operations/findByID.ts` (incl. lock status)                    | `find_by_id.rs`                   |
| `collections/operations/count.ts`, `countVersions.ts`                       | `count.rs`                        |
| `collections/operations/findDistinct.ts`                                    | `find_distinct.rs`                |
| `collections/operations/findVersions.ts`                                    | `find_versions.rs`                |
| `collections/operations/findVersionByID.ts`                                 | `find_version_by_id.rs`           |
| `collections/operations/docAccess.ts`                                       | `doc_access.rs`                   |
| `auth/executeAccess.ts`                                                     | `common.rs` `execute_access`      |
| `collections/operations/utilities/buildBeforeOperation.ts`                  | `common.rs`                       |
| `collections/operations/utilities/buildAfterOperation.ts`                   | `common.rs`                       |
| `collections/operations/utilities/sanitizeSortQuery.ts`                     | `common.rs` `sanitize_sort_query` |
| `utilities/getVersionsConfig.ts` (`hasVersionsEnabled`, `hasDraftsEnabled`) | `common.rs`                       |
| `utilities/appendNonTrashedFilter.ts`                                       | `utilities.rs`                    |
| `versions/drafts/appendVersionToQueryKey.ts`                                | `utilities.rs`                    |
| `utilities/getSelectMode.ts`                                                | `utilities.rs`                    |
| `versions/drafts/getQueryDraftsSelect.ts`, `getQueryDraftsSort.ts`          | `utilities.rs`                    |
| `utilities/sanitizeInternalFields.ts`                                       | `utilities.rs`                    |
| lock-status blocks of `find.ts` / `findByID.ts`                             | `utilities.rs`                    |

The query utilities (`combineQueries`, `sanitizeWhereQuery`, `prefixWherePaths`,
`validateQueryPaths`, `validateSortQuery`, `sanitizeJoinQuery`, `getFieldByPath`,
`getLocalizedPaths`) are the live port of `crates/payload-core-query` (`live`), called directly
from Rust (`query.rs`).

Write operations (`crates/payload-core-ops-write`): `create`, `update` (bulk), `updateByID`,
`utilities/update.ts` (`updateDocument`), `delete` (bulk), `deleteByID`, `duplicate`,
`restoreVersion`, `validate` and `utilities/runValidationLifecycle.ts`
(`validation_lifecycle.rs`: the beforeValidate/beforeChange field traversals are the Rust ports,
the collection/global `beforeValidate`/`beforeChange` hook loops are Rust `for...of` loops; the
global `validate` calls the same port). Global and auth operations
(`crates/payload-core-ops-global`): global `findOne`, `update`, `findVersions`,
`findVersionByID`, `countGlobalVersions`, `restoreVersion`, `docAccess`, `validate`; auth
`login`, `logout`, `me`, `refresh`, `forgotPassword`, `resetPassword`, `registerFirstUser`,
`unlock`, `verifyEmail`, `access`, `auth`, `init`, `applyUserReadAccess`. Both are built on this
crate's `host` and `common` (`executeAccess`, `buildBeforeOperation` / `buildAfterOperation`).

## 2. Architecture

```
crates/payload-core-ops            Rust operations (strategy B: JS objects driven through Node-API)
crates/payload-node/src/ops.rs     `coreOpsBinding()` export of the main addon
packages/engine-rs/src/ops/        TS glue: binding loader, JS helpers, drop-in exports
  index.ts                         getCoreOps(), findOperation, findByIDOperation, ... (upstream signatures)
  host.ts                          createOpsHost(): the JS helpers the crate calls by name
test/__rs/core-ops/                dispatch wrappers + differential harness (section 5)
```

The binding shares the core runtime's thread-local executor and host, so `getCoreOps()` calls
`getCoreRuntime()` first and loads the same addon file (`PAYLOAD_CORE_RUNTIME_ADDON`, else
`PAYLOAD_ENGINE_ADDON`, else `packages/engine-rs/payload-engine.node`).

Each operation is one spawned Rust task (`executor::spawn`) whose promise is returned directly
by the drop-in export (the export is a plain function, not an `async` wrapper, so awaiting it
costs the same ticks as awaiting the TS `async` function).

### What runs where

| part                                                                                                                                                                                                                                                                                                                          | implementation                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| control flow, branches, loops over hooks/docs, every `await`, `Promise.all` fan-out                                                                                                                                                                                                                                           | Rust                                                                                                               |
| `executeAccess`, `buildBeforeOperation`, `buildAfterOperation`, `sanitizeSortQuery`, `docAccess` (operation list, `unlock` / `readVersions`, result lookup)                                                                                                                                                                   | Rust                                                                                                               |
| query utilities: `combineQueries`, `sanitizeWhereQuery`, `prefixWherePaths`, `validateQueryPaths`, `validateSortQuery`, `sanitizeJoinQuery`, `getFieldByPath`, `getLocalizedPaths`                                                                                                                                            | Rust (`payload_core_query::live`, via `query.rs`)                                                                  |
| `appendNonTrashedFilter`, `appendVersionToQueryKey`, `getSelectMode`, `getQueryDraftsSelect`, `getQueryDraftsSort`, `sanitizeInternalFields`, lock-status filtering and marking, findDistinct path trimming / relationship paths / virtual path / value renaming / population loop, auth-doc and version-row `docs.map` loops | Rust (`utilities.rs`, the operation files)                                                                         |
| collection hooks, access functions                                                                                                                                                                                                                                                                                            | user JS, called live by Rust (args literal built by a helper with upstream key order)                              |
| `afterRead` field traversal                                                                                                                                                                                                                                                                                                   | Rust (`payload_core_runtime::after_read::after_read`); `PAYLOAD_OPS_AFTER_READ=ts` uses TS instead                 |
| `payload.db.*`                                                                                                                                                                                                                                                                                                                | whatever adapter is installed, called through JS (`payload.db[method]` read, then called with `this = payload.db`) |
| `sanitizeSelect`/`resolveSelect`, `buildVersionCollectionFields`, `getEntityPermissions`, `sanitizePermissions`, `replaceWithDraftIfAvailable`, `checkFileAccess`, `markHistoricalFileURLs`, `prefetchVersionForInheritedReadAccess`, `relationshipPopulationPromise`                                                         | upstream JS (called with the TS argument literal)                                                                  |
| Payload error classes (`Forbidden`, `NotFound`, `APIError`, `QueryError`)                                                                                                                                                                                                                                                     | constructed by JS helpers (same class, message, status, data)                                                      |
| object literals, spreads (`{ ...doc, collection }`, `{ ...where, and: [...] }`), destructuring patterns                                                                                                                                                                                                                       | JS helpers (one expression each)                                                                                   |
| `Array.isArray`, `Array.prototype.map/filter/find`, `for...of`, `for...in`, `new Date(v).getTime()`                                                                                                                                                                                                                           | the JS built-ins, driven from Rust (below)                                                                         |

Per-document arrows (phase K): the `result.docs.map(async (doc) => ...)` arrows of find (the
afterRead call, the collection beforeRead / afterRead hook loops) and findVersions (the version
fallback and beforeRead hooks, `data.version = await afterRead(...)`, the afterRead hooks) are
upstream's arrow bodies in host helpers (`findAfterReadAll`, `findBeforeReadHooksAll`,
`findAfterReadHooksAll`, `findVersions*All`; `<expr>.map` errors from `mapWith`), one host call
for all documents instead of one Rust task per document; `afterRead` there is the Rust one (or the
`PAYLOAD_OPS_AFTER_READ` override). The Rust per-document paths remain for the mutant builds
(M1, M2, M5). The control flow around them, the awaits of their `Promise.all` and everything else
of the operations stay in Rust.

The query utilities come from `crates/payload-core-query/src/live` (strategy B on the same
runtime): they work on the caller's `where` / `joins` objects, so `sanitizeWhereQuery`'s in-place
mutation, `combineQueries` returning the caller's object and the identity of the `where` handed to
hooks and adapters are upstream's. `getCoreOps()` installs that port's host
(`getCoreQueryBinding()` of `packages/engine-rs/src/query/index.ts`; production code, the test
tree only re-exports it). Their async entries are spawned as their own tasks
(`validate_query_paths`, `spawn(validate_sort_query_body(..))`, `spawn(sanitize_join_query_body(..))`),
like calling the TS `async` function. The decoded-value modules of that crate (`sort.rs`,
`select.rs`, `where_query.rs`) are not used: they work on copies.

### Exactness rules applied (in addition to RUST_CORE_DESIGN.md section 3)

- Destructuring patterns (`const { collection: { config }, ..., pagination = true } = args`) run in
  a JS helper with the upstream pattern (defaults, getter order, V8's TypeErrors), returning an
  array.
- Every object literal that leaves the operation (hook args, access args, `payload.db.*` args,
  `afterRead` args, nested `payload.find` args, empty results) is built by a helper with the
  upstream key order and property-read order (e.g. `context: req.context` is read inside the
  literal, `select: typeof select?.version === 'object' ? ...` inside the afterRead literal).
- Callee before arguments: `payload.db.queryDrafts(...)` reads `payload.db` and `queryDrafts`
  before the args literal is built. A non-callable throws V8's `TypeError: <expr> is not a
  function` (`hook`, `access`, `payload.db.find`, ...).
- `for (const x of <expr>)` (`host::ForOf`): plain arrays (`napi_is_array`) are iterated by index
  with a live length (what the array iterator does); anything else, including proxies of arrays,
  through the host generator `forOf(v, expr)`, which reads `Symbol.iterator` once (V8's
  `<expr> is not iterable` with the TS source text) and runs a real `for...of`, stepped by Rust
  between awaits. A throwing loop body closes the iterator (`generator.return()`, its errors
  ignored), like `IteratorClose` on a throw completion. `for...in` is the generator `forIn`.
- `Array.isArray(v)` is `host::is_array`: `napi_is_array`, else the JS `Array.isArray` for objects
  (true for proxies of arrays, throws for revoked proxies).
- `<expr>.map(async (x) => ...)`, `.filter(...)`, `.find(...)`: `host::map_array` /
  `host::with_callback` read `map` from the value and call it with a native callback that runs the
  Rust closure (the arrow's body) for each element, so holes, proxies, patched `map` /
  `Symbol.species` and V8's errors (`Cannot read properties of undefined (reading 'map')`,
  `<expr>.map is not a function`) are upstream's. The callback is only valid while the call it was
  passed to runs (a later call throws an engine error).
- Literals that evaluate a ported utility in the middle (`select: getQueryDraftsSelect({ select })`
  in the `queryDrafts` args, `where: appendVersionToQueryKey(where)`) get a native callback
  `evaluate(i)` so the utility runs at its position in the literal's evaluation order.
- `(await hook(...)) || docRef` and
  `obj.version = (await hook({ doc: obj.version })) || obj.version` re-read `obj.version` after
  the await, as the TS does. `hookResult !== undefined` for before/afterOperation.
- `result.docs = await Promise.all(result.docs.map(async (doc) => ...))`: each async arrow is a
  spawned task whose synchronous prefix runs during the map; the `afterRead` arrow returns
  `afterRead`'s promise without awaiting it (the task resolves its native promise with that
  promise, which V8 resolves through the same thenable job as an `async` arrow's `return`).
- `try { ... } catch { ... }` around lock status: an `async` block whose `Err` selects the catch
  branch; nothing is rethrown.
- Upstream quirks kept: findVersionByID destructures its args before `beforeOperation`, so
  args returned by that hook only reach `checkFileAccess` (`args.collection`) and
  `afterOperation`; findDistinct's virtual-field branch returns without `afterOperation`;
  `typeof relatedAccess === 'object'` treats `null` as a where; findVersions'
  `collectionConfig.hooks.afterRead?.length` has no `?.` on `hooks`.

## 3. Rust API

```rust
// crates/payload-core-ops
find::find(args: Local) -> JsResult<Local /* promise */>
find_by_id::find_by_id(args) / count::count(args) / count::count_versions(args)
find_distinct::find_distinct(args) / find_versions::find_versions(args)
find_version_by_id::find_version_by_id(args) / doc_access::doc_access(args)
common::execute_access(AccessArgs, access: Val) -> JsResult<Local>
common::execute_access_body(AccessArgs, access: Val) -> impl Future  // inline in an existing task
common::build_before_operation(args, collection, operation: &'static str, override_access) -> JsResult<Local>
common::build_after_operation(args, collection, operation, override_access, result) -> JsResult<Local>
common::hook_operation(operation) -> Option<&'static str>  // operationToHookOperation[op] (None = undefined)
common::sanitize_sort_query(fields: Local, sort: Local) -> JsResult<Local>
common::ReadHooks { collection_config, hook_name, find_many, override_access, query, req }.run(HookTarget)
query::{combine_queries, sanitize_where_query, prefix_where_paths, validate_query_paths(QueryPaths),
        validate_sort_query, sanitize_join_query, get_field_by_path_with_relationships,
        get_localized_paths_override_access}
utilities::{append_non_trashed_filter, append_version_to_query_key, get_select_mode,
            get_query_drafts_select, get_query_drafts_sort, sanitize_internal_fields,
            lock_duration_ms, apply_find_lock_status, reset_find_lock_status, lock_status_of,
            apply_lock_status}
host::{ForOf::{new, of, next, close}, ForIn, loop_body, is_array, map_array, with_callback,
       iterable / element (index loops, kept for the write / global crates), call, call_fn, ...}
binding::create_binding(env)  // { init(host), find, findByID, count, countVersions, findDistinct,
                              //   findVersions, findVersionByID, docAccess, executeAccess, sanitizeSortQuery }
```

`init(host)` takes the object of `createOpsHost()` (helpers by name) and an optional `afterRead`
override. The operation exports and `executeAccess` never throw synchronously: anything thrown
before the task starts rejects the returned promise (upstream's are `async` functions).

Each operation binding carries `apiVersion` (the host-helper contract with its TS glue:
`payload_core_ops::binding::API_VERSION`, `payload_core_ops_write::binding::API_VERSION`,
`payload_core_ops_global::binding::API_VERSION`), which `getCoreOps()` / `getCoreOpsWrite()` /
`getOpsGlobal()` check at load: an addon built from other sources (including the checked-in
`packages/engine-rs/payload-engine.node` until it is refreshed) fails there with "... API
version ..., expected ...; rebuild it" before any operation or user hook runs, instead of at the
first missing helper. The core runtime binding has its own (RUST_CORE_DESIGN.md section 6).

## 4. Dispatch (applied)

`payload` cannot import `@payloadcms/engine-rs` (engine-rs depends on payload). Each operation
file selects the engine once at module load, like the field-hook modules
(`packages/payload/src/fields/hooks/*/index.ts`):

- `PAYLOAD_CORE_ENGINE=rs|ts` if set, else `PAYLOAD_ENGINE === 'rs'`.
- The upstream function is renamed `<op>TS` (body unchanged, exported: the differential harness
  imports it as the reference) and `<op>` is exported as `isRustOperations ? dispatcher : <op>TS`,
  so with the flags unset payload runs the upstream function itself.
- Selected, the module starts `import('../../../../engine-rs/src/ops/index.js')` at load; the
  dispatcher calls the loaded drop-in directly (no extra tick). A call made before the import
  finished waits for it and is counted (`recordDeferredCall`; 0 in every suite run).

Files: `collections/operations/{find,findByID,count,countVersions,findDistinct,findVersions,
findVersionByID,docAccess,create,update,updateByID,delete,deleteByID,duplicate,restoreVersion,
validate}.ts`, `globals/operations/*.ts`, `auth/operations/*.ts` (selector
`PAYLOAD_OPS_GLOBAL_ENGINE`, then the same flags), and `auth/executeAccess.ts`: its upstream
function is exported as `executeAccessTS` (named `executeAccess`, as upstream) and `executeAccess`
forwards to the Rust `executeAccess` of `packages/engine-rs/src/ops` when selected, so every TS
caller (globals and auth helpers, uploads, `getAccessResults`, the query port's join access, ...)
runs the Rust one.

`packages/engine-rs/src/ops/index.ts`: `getCoreOps()` (core runtime, query port host from
`packages/engine-rs/src/query`, ops binding from one addon), the drop-ins,
`PAYLOAD_RS_OPS_STATS_DIR=<dir>` (each process writes `ops-<pid>.json` with calls per operation
and deferred calls), `getOpsCallCount()`. `packages/engine-rs/src/ops-write/index.ts`
(`getCoreOpsWrite()`) and `packages/engine-rs/src/ops-global/index.ts` (`getOpsGlobal()`, which
also initializes the write binding for the shared validation lifecycle) are the same for their
crates.

Nested operations the Rust operations trigger (population through `req.payloadDataLoader`, lock
status `payload.find`, the findDistinct virtual-field `payload.findDistinct`) go through the
dispatched exports, so they are Rust as well.

## 5. Verification

`test/__rs/core-ops/run.sh <suites>` runs each upstream int suite three times through
`test/__rs/core-ops/vitest.config.ts` (one suite at a time, fresh SQLite file, TZ=UTC):

- `PAYLOAD_OPS=ts`: upstream operations (reference outcomes, same config).
- `PAYLOAD_OPS=rs`: every read operation is the Rust one (including nested ones). Per-test
  outcomes must equal the `ts` run; the number of Rust operation calls is reported (a suite with 0
  calls fails).
- `PAYLOAD_OPS=shadow`: every top-level operation call runs the real TS operation (returned to the
  test), then a TS branch and a Rust branch on fresh clones of the args taken before the real call
  (data values deep-cloned, `collection` shared, `req` cloned with its own `context`/`query` and a
  fresh dataloader; REST requests get a copy-on-write view). Inside a branch, nested operations run
  the branch's implementation (AsyncLocalStorage), so the Rust branch is Rust end to end.
  The branches' event logs are compared exactly: every collection hook (beforeOperation,
  beforeRead, afterRead, afterOperation), collection `read`/`readVersions` access, field
  `access.read`, field `afterRead` hook, nested operation and `payload.db.*` call
  (`find`, `findOne`, `count`, `queryDrafts`, `findVersions`, `countVersions`, `findDistinct`), in
  call order, with an args snapshot taken at call time and `this`; the sync return or the async
  settlement of each call, logged from a reaction on the returned promise (so microtask order
  shows up); the outcome (result, or error class/name/message/status/data/isPublic); `req.context`
  and the args object afterwards. Snapshots keep key order, own `undefined`, class names, Dates,
  and object identity (numbered per branch by first appearance); config objects, `req`,
  `context`, `payload`, `db` and the args object are compared by role. Dates within a day of "now"
  (lock-status queries) compare as `recent`.
  The request's own properties are compared too (one level: `locale`, `transactionID`, `user`,
  ...). A diff is re-checked with a second TS branch; if TS differs from itself (hook side
  effects, time) the case is counted as `unstable`, otherwise as a diff. (The write and
  global/auth harnesses are stricter, section 6: a case is only accepted when the Rust log equals
  one of the TS runs.)
  Engine guard: the reference is the upstream `<op>TS` function (never the dispatcher); the TS
  branch must make 0 Rust operation calls and the Rust branch at least one (counted per branch
  through AsyncLocalStorage), otherwise the case counts as `engineMismatch`.
- `run.sh` unsets `PAYLOAD_ENGINE` / `PAYLOAD_CORE_ENGINE` (`RS_OPS_SQL_ENGINE=rs` runs every mode on
  the Rust SQL adapter with TS field hooks).
- The synthetic suite records every operation outcome (result or error class / message / status /
  data, dates and generated row ids normalized, plus the `req.context` hook log) in `ts` and `rs`
  mode; `summarize.mjs` compares them.

`summarize.mjs` fails on any diff, any rs/ts per-test outcome difference, any synthetic outcome
difference, a missing report of a requested mode, a suite that compared zero cases or ran no
test, and any `engineMismatch`.

Mutation switches prove the harness sees the deviations that matter. They are compiled only with
the `payload-core-ops/mutants` cargo feature (`host::mutant(n)` is a constant `false` otherwise;
the shipped addon rejects `init({ mutant })`); `RS_OPS_MUTANT=n` selects one in a feature build:

| mutant | deviation                                                                              |
| ------ | -------------------------------------------------------------------------------------- |
| 1      | collection read hooks: no `await` tick when the hook returns a non-promise             |
| 2      | find: `afterRead` of the docs one after another instead of `Promise.all`               |
| 3      | `afterOperation` hooks skipped                                                         |
| 4      | find: the `executeAccess` body inlined into the operation task (no own async function) |
| 5      | find `afterRead` collection hooks get args without `findMany: true`                    |

Results: see section 7.

## 6. Write, global and auth operations: verification

Same framework and porting rules as the read operations (sections 2-3).

**Write operations** (`test/__rs/core-ops-write/run.sh <suites>`, `shadow.ts`):

- `ts` / `rs` / `shadow` modes as in section 5, on the TS SQLite adapter (transactions off). In
  shadow mode each top-level write call runs a TS branch and a Rust branch on cloned args, each
  isolated by a SQLite savepoint (rolled back) plus a copy-on-write snapshot of the upload folders,
  then the real TS call. The logs record every collection/field hook and access call, nested
  operation, `payload.db.*` call (including `beginTransaction` / `commitTransaction` /
  `rollbackTransaction`), settlement order, microtask gaps, outcome, `req.context`, request state
  and args afterwards.
- **Nondeterminism is only accepted when checked:** a case whose Rust log differs from the TS log
  is re-run in TS up to `RS_OPS_TS_RERUNS` (default 3) times; it is counted `unstable` only when
  the Rust log equals one of those TS logs, otherwise it is a diff.
- **Transactions** (`PAYLOAD_RS_SQLITE_TRANSACTIONS=true`: `transactionOptions: {}`, so
  `initTransaction` starts real transactions; with `RS_OPS_WRITE_SINGLE_TX=true` the harness also
  sets `bulkOperationsSingleTransaction`, so bulk `update` runs `processDocument` sequentially
  with a per-document `initTransaction` / `commitTransaction` / `killTransaction` and bulk
  `delete` runs `deleteDocumentIndividually`). Writes on transaction connections cannot be
  rolled back with a savepoint, so these runs use the cross-process trace modes:
  `MODES="trace-ts trace-ts2 trace-rs"` runs the suite in three processes (TS, TS again, Rust);
  every top-level write call runs once for real with the selected implementation and is logged
  like a shadow branch; `trace-compare.mjs` compares the Rust run call by call with the TS run,
  and a differing call is `unstable` only when it equals the same call of the second TS run.
- Per-test outcomes of `rs` / `trace-rs` must equal `ts`; any diff, a missing report or trace, zero
  cases compared, a Rust branch that ran no Rust operation or a TS branch that ran one fail the run.
- The synthetic suite (`test/__rs/core-ops-write/synthetic`) drives every write operation through
  a matrix of contexts (hook throws in every hook kind, falsy and replacing hooks, thenables,
  access false/where/async/throw, per-document failures in bulk update/delete), including
  `validate` under every context for new and existing documents and `validateOperation` itself
  with `onValidationData`, `skipMutationHooks` and `validationOperation: 'create' | 'update'`,
  the auth `beforeValidation` (`ensureUsernameOrEmail`) and unique-constraint `validateData`.

**Global and auth operations** (`test/__rs/core-ops-global/run.sh <suites>`, `trace.ts`,
`compare.mjs`): cross-process trace differential (`ts`, `ts2`, `rs` processes). A candidate case
that differs from `ts` is counted as not a diff only when it equals the same case of another
reference run (`ts2`), or equals a reference once record ids are numbered per case by first
appearance (`idOrder`: ids of documents created concurrently, e.g. `Promise.all(payload.create)`
racing password hashing on the thread pool), or when the multiset of the test's case logs equals
a reference run's (`reordered`: concurrent calls settling in another interleaving). The synthetic
suite calls `countGlobalVersions` through the Local API's `global` option (with and without a
`where`) and `findGlobalVersionByID` with beforeRead hooks returning `{ version: doc }` (context
`beforeReadWrapsVersion`), so the lookup reaches its afterRead traversal and afterRead hook loop
under every context. Loops of the global/auth crate pass their TS source text to `ForOf::of`
(V8's `<expr> is not iterable`).

## 7. Results and known gaps

2026-11-01 (phase F), debug addon built from this tree (copied out of `target/shared`), TZ=UTC,
SQLite, reference sides with `PAYLOAD_ENGINE` / `PAYLOAD_CORE_ENGINE` unset. Read operations
(`test/__rs/core-ops/run.sh`; TS SQL adapter, the reference never runs Rust):

| suite                            | ts pass/fail/skip | rs pass/fail/skip | Rust op calls (rs) | shadow cases compared | diffs | unstable | engine mismatch | events compared | rejections compared |
| -------------------------------- | ----------------- | ----------------- | ------------------ | --------------------- | ----- | -------- | --------------- | --------------- | ------------------- |
| sort                             | 44/0/0            | 44/0/0            | 306                | 287                   | 0     | 0        | 0               | 2,174           | 0                   |
| select                           | 115/0/0           | 115/0/0           | 147                | 136                   | 0     | 0        | 0               | 1,086           | 0                   |
| fields                           | 221/0/13          | 221/0/13          | 767                | 744                   | 0     | 0        | 0               | 5,405           | 14                  |
| relationships                    | 69/0/5            | 69/0/5            | 772                | 665                   | 0     | 0        | 0               | 5,535           | 0                   |
| localization                     | 158/0/0           | 158/0/0           | 253                | 223                   | 0     | 0        | 0               | 1,935           | 0                   |
| access-control                   | 84/0/0            | 84/0/0            | 168                | 157                   | 0     | 0        | 0               | 1,965           | 27                  |
| joins                            | 115/0/8           | 115/0/8           | 598                | 483                   | 0     | 0        | 0               | 9,095           | 37                  |
| versions                         | 153/0/0           | 153/0/0           | 373                | 363                   | 0     | 0        | 0               | 2,894           | 11                  |
| core-ops synthetic (adversarial) | 6/0/0             | 6/0/0             | 5,813              | 3,071                 | 0     | 0        | 0               | 138,856         | 879                 |

- `rs`: per-test outcomes identical to `ts` in every suite (0 changed); synthetic: 5,937 recorded
  operation outcomes, identical in `ts` and `rs`.
- `shadow`: one upstream test (`access-control` "should reuse the version lookup when inherited
  read access returns a boolean") fails only in shadow mode because it counts
  `payload.db.findVersions` calls with a spy, and shadow mode runs every operation three times.
- Synthetic per operation: find 996, findByID 782, count 92, countVersions 46, findDistinct 506,
  findVersions 324, findVersionByID 276, docAccess 49 cases (now including a custom-ID collection
  with a custom lock duration, GraphQL requests, an auth collection with `maxLoginAttempts`, and
  proxies of the sort array and of every collection hook list).
- Mutants (`payload-core-ops/mutants` build, synthetic, shadow): M1 1,593 diffs, M2 1,576, M3 1,757,
  M4 863, M5 1,506; the same build with no mutant selected: 0 diffs.
  Write operations (`test/__rs/core-ops-write/run.sh`, TS SQL adapter; `trace-*` rows with
  `transactionOptions: {}`):

| suite                                                                              | ts / rs pass/fail/skip | shadow compared | diffs | unstable (Rust log = a TS rerun) |
| ---------------------------------------------------------------------------------- | ---------------------- | --------------- | ----- | -------------------------------- |
| write synthetic (adversarial)                                                      | 10/0/0                 | 932             | 0     | 0                                |
| hooks                                                                              | 44/0/1                 | 78              | 0     | 0                                |
| validate                                                                           | 112/0/0                | 219             | 0     | 0                                |
| versions                                                                           | 153/0/0                | 849             | 0     | 3                                |
| localization                                                                       | 158/0/0                | 281             | 0     | 0                                |
| auth                                                                               | 117/0/0                | 157 (2 skipped) | 0     | 0                                |
| trash                                                                              | 102/0/5                | 520             | 0     | 0                                |
| fields                                                                             | 221/0/13               | 824             | 0     | 0                                |
| uploads                                                                            | 155/0/0                | 285             | 0     | 1                                |
| collections-rest                                                                   | 125/0/2                | 551             | 0     | 0                                |
| trace, transactions: synthetic / hooks / trash                                     | equal outcomes         | 932 / 78 / 520  | 0     | 0                                |
| trace, transactions + `bulkOperationsSingleTransaction`: synthetic / hooks / trash | equal outcomes         | 932 / 78 / 520  | 0     | 0                                |

- Per-test outcomes of `rs` equal `ts` in every suite. Shadow-only failures (shadow runs each
  operation three or more times): validate (10 tests counting hook calls), versions "createVersion
  also fails" (one-shot mock), uploads and collections-rest (one each, stateful hooks).
- The transaction traces really run transactions: in the synthetic suite the Rust run made 751
  `beginTransaction` / 599 `commitTransaction` / 152 `rollbackTransaction` calls, and 929 / 725 / 220
  with `bulkOperationsSingleTransaction` (per-document transactions of bulk update and
  `deleteDocumentIndividually` of bulk delete, including the per-document kill on a failing hook).
- Before the harness let operations settle (`settleBranch`), 5 slug-uniqueness creates in `fields`
  differed: work a rejected create leaves running kept logging while the comparison ran. With the
  settle step they compare equal (not classified away). The uploads suite is not used for
  cross-process traces: its media folders, temp file names, multipart boundaries and local
  server ports differ between processes (shadow mode covers it in one process).
- Sensitivity (harness-side host mutants, synthetic, shadow): M7 lifecycle hook args without
  `originalDoc` 148 diffs, M8 `onDataProcessed` not updating `processedData` 23, M9 no
  `beforeValidation` callback 2 (plus M1-M6 of phase E).

Global and auth operations (`test/__rs/core-ops-global/run.sh`, processes ts, ts2, rs):

| suite                                                                         | cases      | equal | diffs | unstable (= ts2) | id order | reordered |
| ----------------------------------------------------------------------------- | ---------- | ----- | ----- | ---------------- | -------- | --------- |
| global/auth synthetic (adversarial)                                           | 1067       | 1067  | 0     | 0                | 0        | 0         |
| globals                                                                       | 21         | 21    | 0     | 0                | 0        | 0         |
| versions                                                                      | 485        | 485   | 0     | 0                | 0        | 0         |
| auth                                                                          | 234        | 158   | 0     | 25               | 6        | 45        |
| access-control                                                                | 26         | 26    | 0     | 0                | 0        | 0         |
| login-with-username                                                           | 2          | 2     | 0     | 0                | 0        | 0         |
| auth-api-key                                                                  | 8          | 6     | 0     | 0                | 2        | 0         |
| auth/api-key                                                                  | 6          | 3     | 0     | 0                | 3        | 0         |
| auth/{custom-strategy,first-user,forgot-password-localized,jwt,removed-token} | 1+1+4+6+16 | all   | 0     | 0                | 0        | 0         |
| validate                                                                      | 81         | 81    | 0     | 0                | 0        | 0         |
| localization                                                                  | 66         | 66    | 0     | 0                | 0        | 0         |

- `countGlobalVersions` now has 69 compared cases (2 before) and `findVersionByID` 103, with the
  afterRead traversal and hook loop reached under the whole context matrix.
- auth's `reordered` / `unstable` / `idOrder` cases are the concurrent-login lockout test (101
  logins racing password hashing) and the email-reservation test (concurrent creates); each was
  checked against both reference runs as described in section 6.

- Payload dispatch (`PAYLOAD_ENGINE=rs`: Rust SQL engine + Rust field hooks + validators + Rust
  read operations), `PAYLOAD_RS_OPS_STATS_DIR=... node test/__rs/adapter/runSuites.mjs --jobs 3`
  over all 135 files of `.rs-baseline/sqlite-all.json` (machine load 30-80): 126/135 identical to the
  baseline, 11,304 read-operation calls served by Rust (find 8,745, findByID 2,274, count 84,
  findVersionByID 76, findVersions 60, findDistinct 47, docAccess 10, countVersions 8), 0 deferred.
  The 9 others: `select` (+37) and `uploads` (+1) pass tests the baseline failed; `hooks`, `lexical`,
  `live-preview`, `versions` failed with another module's newer TS glue than the run's addon
  (`beforeChangeTraverseFields is not a function`) and pass 44/44, 124/124, 18/18, 153/153 with an
  addon rebuilt from the same tree; `cli` (3) and `validate` (1) are ENOENT on fixture folders shared
  with concurrent runs; `queues` "should recover a job after its worker process is killed" also
  fails on the pure TS engine under the same load (worker start timeout).

- Full upstream suite with `PAYLOAD_ENGINE=rs` (phase F, `node test/__rs/adapter/runSuites.mjs
  --jobs 3` over all 135 baseline files, machine load 25-45): 132/135 identical to the baseline,
  52,779 SQL engine calls, 15,064 write-operation calls served by Rust, 0 deferred. `select` (+37)
  and `uploads` (+1) differ only from the stale baseline: a fresh TS run of both files
  (`--engine ts`) has the same per-test outcome as the Rust run for all 115 + 155 tests. `cli` (6,
  ENOENT on the `generated` folder shared with concurrent runs) passes 64/64 rerun alone.

Performance (release build): no operation family is measurably slower or faster than TS on the
synthetic suites; numbers and caveats in RUST_CORE_DESIGN.md section 5 (phase F). The
differential runs above use debug builds.

Known gaps:

- The dynamic import of `packages/engine-rs/src/ops/index.js` is a relative source path: it works
  where payload runs from source (vitest, dev), not from a published dist build, and the glue
  imports payload internals (error classes) by relative source path, so they are the same module
  instances only in that setup.
- Still upstream JS called from Rust: `sanitizeSelect`/`resolveSelect`,
  `buildVersionCollectionFields`, `getEntityPermissions`, `sanitizePermissions`,
  `replaceWithDraftIfAvailable`, `checkFileAccess`, `markHistoricalFileURLs`,
  `prefetchVersionForInheritedReadAccess`, `relationshipPopulationPromise`.
- `sanitizeSortQuery` has its live port here (`common.rs`); payload-core-query's `sort.rs` is the
  decoded-value version (not usable on live values).
- `for (const x of <plain array>)` iterates by index (a patched `Array.prototype[Symbol.iterator]`
  is not observed); proxies and other iterables use the real iterator.
- Engine-created errors have Rust/host stacks; class, message, status and data are identical.
- Concurrent operations: each operation's own event order is compared; interleaving between
  concurrent top-level operations is not (the shadow runs branches sequentially).
- The dispatch modules (`collections/`, `globals/`, `auth/operations/*.ts`, `auth/executeAccess.ts`)
  use the same relative dynamic import: inside a Next bundle or a dist build they fail to resolve.
- `host::with_callback` (native callback for `map`/`filter`/`find`) raises an engine error if a
  patched built-in calls the callback re-entrantly or after it returned; upstream has no such
  failure mode.
- Write operations: synchronous stretches without user callbacks (status bookkeeping, spreads,
  argument objects, destructuring) and the upstream utilities (uploads, versions, auth crypto,
  locked documents, `validateUniqueConstraints`, `ensureUsernameOrEmail`) are JS helpers; the
  runValidationLifecycle hook loops and traversals are Rust. Value-only changes to timestamps /
  ids / tokens are invisible to the harnesses (they are canonicalized).
- Cross-process traces (transaction runs, global/auth) compare per-call logs; ids of concurrently
  created documents and random API key fragments are compared after numbering by first
  appearance (`idOrder`), so a Rust bug that only swapped such ids within one call would not be
  seen there (the in-process shadow runs compare them raw).

## 8. MongoDB: the Rust core on the TS mongoose adapter

2026-11-01 (phase G), debug addon from this tree, TZ=UTC, replica set `rs0` on localhost:27018,
every run on its own database (dropped afterwards). The Rust core (operations, field hooks,
validators, query validation; `PAYLOAD_CORE_ENGINE=rs`) runs unchanged on
`@payloadcms/db-mongodb`; the reference sides have `PAYLOAD_ENGINE` / `PAYLOAD_CORE_ENGINE` unset.
No change to the core crates was needed: the core works on live JS values, so ObjectId instances,
`_id` paths and mongo error classes reach the same upstream JS helpers (`isValidID`,
`isNestedRelationshipQuery`, `sanitizeInternalFields`, `checkDocumentLockStatus`'s
`db.name === 'mongoose'` branch) in the same order.

**What is different on MongoDB, and how the harnesses handle it**

- Database calls complete in network order. Upstream runs per-document work concurrently
  (`Promise.all` in bulk update / delete, since `bulkOperationsSingleTransaction` defaults to
  `false` on mongodb; slug uniqueness checks; access functions that query; population racing a
  hook's `setImmediate`), so the TS reference differs from itself: 42 of 45 differing bulk-update
  trace calls had `trace-ts` != `trace-ts2`. `RS_OPS_ORDERED_IO=true` (core-ops-write
  `shadow.ts`) and `RS_ORDERED_IO=true` (`test/__rs/dispatch/settle.ts`, used by the in-process
  harnesses and the live query harness; set by `test/__rs/core-mongo/runDifferentials.sh`) deliver
  each top-level `payload.db.*` result in call order, one macrotask turn after the previous
  delivery and after its own I/O, with the adapter's own value / error. Both engines run on the
  same wrapper, so the interleaving becomes a function of the call order. Calls made inside
  another call (`this.updateOne` in `upsert`) are not delayed.
- Rejected `Promise.all` siblings keep querying after a run settled: the in-process harnesses now
  wait (`settleRun`) until no tracked database call is in flight and neither the Rust executor
  counters nor the recorder changed for three turns (before, one turn was enough on SQLite and the
  next TS run tripped the engine guard on MongoDB).
- Where a case still differs, `core-runtime` and the live query harness rerun the TS/Rust pair up
  to 4 times and count it `unstable` only when a Rust run equals a TS run (entries record whether
  TS differed from itself). With ordered I/O the last runs had 0 unstable cases.
- Writes cannot be rolled back with a savepoint, so write shadow mode is not used; the
  cross-process trace modes are (`RS_CORE_DB=mongodb RS_OPS_ORDERED_IO=true
  MODES="trace-ts trace-ts2 trace-rs" test/__rs/core-ops-write/run.sh ...`).
- `test/__rs/core-mongo/objectid/` adds MongoDB-shaped inputs: ObjectId instances as ids (findByID,
  update / delete by id), in `where` (`equals` / `in` / `not_in` / `contains` / `like`, `id`, `_id`,
  `poly.value`, nested relationship queries), as relationship data (single, hasMany, polymorphic,
  custom text / number id targets, wrong id types, NaN), geo `near` / `within` / `intersects`,
  `_id` / `-id` / relationship / localized sorts, joins with an ObjectId `where`, `findDistinct`,
  `count`, bulk update / delete, duplicate, access returning a where with an ObjectId.

**Results**

Upstream int suites (`node test/__rs/core-mongo/runSuites.mjs --all --jobs 2 --addon ...`; every
file runs once with the TS engine and once with `PAYLOAD_CORE_ENGINE=rs`, each on its own
database; files hit by a mid-run mongod restart and a disk-full window were rerun alone):
112 files, TS 3,105 passed / 76 failed / 397 skipped, core 3,105 / 76 / 397, 0 per-test
differences, 97,579 Rust operation calls and 4,934 Rust field-hook entries, 0 deferred. The core
results also equal `.rs-baseline/mongodb-all.json` test by test (93 per-file results compared).
The 76 failures are the same on both sides and environmental: plugin-import-export 71 and
plugin-cloud-storage 3 (no LocalStack on :4566), kv 1, hmr 1 (Next dev reload poll). The suites
that spawn child processes were not run (`/tmp/rs-phase-f-done` absent).

| harness (MongoDB)                                                                      | compared                                                         | diffs | unstable |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----- | -------- |
| read ops shadow: core-ops synthetic / objectid                                         | 3,071 / 66 cases                                                 | 0     | 0        |
| read ops `ts` vs `rs` outcomes: core-ops synthetic                                     | 5,937 outcomes                                                   | 0     | -        |
| objectid outcomes, TS vs `PAYLOAD_CORE_ENGINE=rs` (`compareOutcomes.mjs`)              | 58 outcomes (6 errors)                                           | 0     | -        |
| write traces (ordered I/O): synthetic                                                  | 932 calls                                                        | 0     | 0        |
| write traces, `bulkOperationsSingleTransaction=true` (real mongoose sessions)         | 932 calls (929 begin / 725 commit / 220 rollback)                | 0     | 0        |
| write traces: objectid / hooks / trash                                                 | 20 / 79 / 520 calls                                              | 0     | 0        |
| write traces: versions                                                                 | 850 calls                                                        | 0     | 0        |
| write traces: localization / validate / collections-rest / auth                        | 288 / 220 / 551 / 157 calls; see below                           | -     | -        |
| global / auth traces: synthetic / globals                                              | 1,067 / 21 cases                                                 | 0     | 0        |
| field hooks (afterRead, beforeValidate, beforeChange, afterChange, beforeDuplicate)     | all 18 spec files of core-runtime / core-hooks-*                 | 0     | 0        |
| live query validation: synthetic, access-control, joins, localization, relationships, versions | 158,788 cases                                            | 0     | 0        |

- localization (4), validate (5), collections-rest (21), auth (55): every differing call has
  `trace-ts` != `trace-ts2` except one auth call, because the tests generate per-process inputs
  (`Date.now()` in unique values, timestamped multipart temp paths, `randomBytes` ids and salts,
  random API keys, `Math.random()` points) or read a document whose stored key order differs
  between runs (auth preferences, TS adapter `findOne` result, varying across all three runs).
  Cross-process traces cannot judge these suites; their per-test outcomes are equal in all three
  processes, and the upstream comparison above covers them.
- Sensitivity: write-operation mutant M7 (lifecycle hook args without `originalDoc`) against the
  ordered-I/O TS traces: 146 diffs.
- Without ordered I/O the synthetic write trace had 45 diffs (TS differing from itself), the live
  access-control harness 26 and the beforeChange `fields` harness 117 (slug fields); all are 0
  with it.
