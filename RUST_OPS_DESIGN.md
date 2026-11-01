# Rust collection operations: design, status, dispatch, write-operation plan

Scope: `packages/payload/src/collections/operations/*.ts` (and later the global and auth
operations) in Rust on the core runtime (`payload-core-runtime`, strategy B of
RUST_CORE_DESIGN.md), with exact upstream behaviour while the TS API stays unchanged.

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

Write operations, global operations and auth operations live in `crates/payload-core-ops-write`
and `crates/payload-core-ops-global` (built on this crate's `host`).

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

The query utilities come from `crates/payload-core-query/src/live` (strategy B on the same
runtime): they work on the caller's `where` / `joins` objects, so `sanitizeWhereQuery`'s in-place
mutation, `combineQueries` returning the caller's object and the identity of the `where` handed to
hooks and adapters are upstream's. `getCoreOps()` installs that port's host
(`getCoreQueryBinding()`, `test/__rs/core-query/glue.ts`, owned by the query port; to move to
`packages/engine-rs/src/query`). Their async entries are spawned as their own tasks
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
findVersionByID,docAccess}.ts`. `auth/executeAccess.ts` is not switched (not owned; the Rust
operations use the Rust `executeAccess` internally).

`packages/engine-rs/src/ops/index.ts`: `getCoreOps()` (core runtime, query port host, ops binding
from one addon), the drop-ins, `PAYLOAD_RS_OPS_STATS_DIR=<dir>` (each process writes
`ops-<pid>.json` with calls per operation and deferred calls), `getOpsCallCount()`.

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
  effects, time) the case is counted as `unstable`, otherwise as a diff.
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

## 6. Plan: write operations, globals, auth

Same framework, same rules. New pieces, in order:

1. **Transactions** (`utilities/{initTransaction,commitTransaction,killTransaction}.ts`): called
   through JS helpers at the same points (`const shouldCommit = !args.disableTransaction && (await
   initTransaction(req))`). `try { ... } catch (error) { await killTransaction(req); throw error }`
   becomes an `async` block in the task whose `Err(thrown)` runs the awaited kill helper and
   returns the same `Thrown` (the user's error object, unchanged). `finally` blocks
   (`unlinkTempFiles`, file-operation scopes) run on both paths in the TS order.
2. **Field traversals**: `beforeValidate` (`payload_core_hooks_validate::before_validate::before_validate`),
   `beforeChange` (`payload_core_hooks_change::before_change::before_change`), `afterChange` and
   `beforeDuplicate` (`payload_core_hooks_after::{after_change, before_duplicate}`), `afterRead`
   (`payload_core_runtime::after_read::after_read`): all `fn(args: Local) -> JsResult<Local>`
   returning the traversal's promise, so the operations call them like the TS functions (args
   literal from a helper). payload-core-ops gains dependencies on those crates (no edits to them).
3. **create** (`create.ts`, 736 lines): beforeOperation, `getDuplicateDocumentData` (JS),
   `executeAccess(create)`, `generateFileData` (JS), beforeValidate fields + collection hooks loop,
   beforeChange collection hooks loop + fields, locale filtering
   (`filterAvailableLocales`, `fillEmptyLocalizedSlugs`, `validateLocalWithLocaleKeyedData`: JS),
   the write (`writeDocument` closure → `payload.db.create`, cloud/file creation plans: JS),
   `saveVersion` (JS), `sendVerificationEmail` (JS), afterRead fields + collection hooks,
   afterChange fields + collection hooks, afterOperation, `unlinkTempFiles`, commit. Validation
   errors are the upstream `ValidationError` thrown by `beforeChange` (already Rust).
4. **update / updateByID** (`update.ts`, `updateByID.ts`, shared `utilities/update.ts`
   `updateDocument`): port `updateDocument` once as an `async fn` spawned per doc (update.ts runs
   it under `Promise.all` for bulk updates with `promises`/`errors` arrays: keep the JS arrays and
   the error-collection order), `getLatestCollectionVersion`, `checkDocumentLockStatus`,
   `deleteAssociatedFiles`, autosave/draft/`publishSpecificLocale` branches, `saveVersion`.
5. **delete / deleteByID** (`delete.ts`, `deleteByID.ts`): access (`delete`) + where, lock check,
   beforeDelete hooks, `deleteAssociatedFiles`, `deleteUserPreferences`, `payload.db.deleteOne` /
   `deleteMany`, `deleteCollectionVersions`, afterRead + afterDelete hooks, trash (`deletedAt`
   update path through `updateDocument`).
6. **duplicate** (26 lines: forwards to `createOperation` with `duplicateFromID`), **restoreVersion**
   (`restoreVersion.ts`: findVersionByID-like read, `payload.db.updateOne` / `create`,
   `saveVersion`, afterRead/afterChange).
7. **Globals** (`globals/operations/*`): `findOne`, `findVersions`, `findVersionByID`,
   `countGlobalVersions`, `docAccess`, `update`, `restoreVersion`, `validate`. They mirror the
   collection operations with `global` hooks (`beforeOperation` does not exist for globals; their
   `beforeRead`/`afterRead`/`beforeChange`/`afterChange` loops take `global` instead of
   `collection`). `ReadHooks` gets a `global` variant of the args literal.
8. **Auth** (`auth/operations/*`): `login` (`incrementLoginAttempts`, `authenticateLocalStrategy`,
   JWT signing stay JS: crypto and `jose`), `me`, `refresh`, `logout`, `forgotPassword`,
   `resetPassword`, `verifyEmail`, `unlock`, `registerFirstUser`, `access` (`getAccessResults`).
   The control flow and hook loops (`beforeLogin`, `afterLogin`, `afterMe`, `afterRefresh`,
   `afterLogout`, `afterForgotPassword`) move to Rust; crypto, cookies and email stay JS helpers.

Dispatch for each: the same one-line `getRustOperations()?.<op> ?? <op>TS` in its file
(section 4), registered by engine-rs. Verification: the same three-mode runner over the suites that
exercise them (`hooks`, `fields`, `versions`, `uploads`, `auth`, `globals`, `trash`,
`collections-rest`, `database`), with the db-call log extended to `create`, `updateOne`,
`updateMany`, `deleteOne`, `deleteMany`, `createVersion`, `updateVersion`, `deleteVersions`,
`upsert`, `beginTransaction`/`commitTransaction`/`rollbackTransaction`, and the branches run on
separate database files (write operations are not repeatable on one database: a branch writes).
For writes the shadow branches need isolated DB state: snapshot the SQLite file before the call
(the `sqlite-shadow` harness already keeps two database files in lockstep) and run the TS and Rust
branches each against its own copy.

## 7. Results and known gaps

2026-11-01 (phase E), debug addon, TZ=UTC, SQLite (TS drizzle adapter, TS field hooks: the
reference never runs Rust), `PAYLOAD_ENGINE_ADDON=<copy of target/shared/debug/libpayload_node.dylib>
test/__rs/core-ops/run.sh <suites>`:

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

Known gaps:

- `auth/executeAccess.ts` is not dispatched (not owned); the Rust operations use the Rust
  `executeAccess`, other callers (globals, write operations, auth) the TS one.
- The dynamic import of `packages/engine-rs/src/ops/index.js` is a relative source path: it works
  where payload runs from source (vitest, dev), not from a published dist build, and the glue
  imports payload internals (error classes) by relative source path, so they are the same module
  instances only in that setup.
- `getCoreOps()` installs the query port's host from `test/__rs/core-query/glue.ts` (owned by the
  query port, to move to `packages/engine-rs/src/query`).
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
