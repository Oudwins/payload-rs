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

Not yet ported: write operations, global operations, auth operations (plan in section 6).

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

| part                                                                                                                                                                                                                                                                                                                                                  | implementation                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| control flow, branches, loops over hooks/docs, every `await`, `Promise.all` fan-out                                                                                                                                                                                                                                                                   | Rust                                                                                                               |
| `executeAccess`, `buildBeforeOperation`, `buildAfterOperation`, `sanitizeSortQuery`                                                                                                                                                                                                                                                                   | Rust (JS helpers only for literals, errors, and `fields.find` by name)                                             |
| collection hooks, access functions                                                                                                                                                                                                                                                                                                                    | user JS, called live by Rust (args literal built by a helper with upstream key order)                              |
| `afterRead` field traversal                                                                                                                                                                                                                                                                                                                           | Rust (`payload_core_runtime::after_read::after_read`); `PAYLOAD_OPS_AFTER_READ=ts` uses TS instead                 |
| `payload.db.*`                                                                                                                                                                                                                                                                                                                                        | whatever adapter is installed, called through JS (`payload.db[method]` read, then called with `this = payload.db`) |
| query/select/join utilities (`combineQueries`, `sanitizeWhereQuery`, `appendNonTrashedFilter`, `sanitizeSelect`/`resolveSelect`, `validateQueryPaths`, `validateSortQuery`, `sanitizeJoinQuery`, `appendVersionToQueryKey`, `getQueryDrafts{Select,Sort}`, `buildVersionCollectionFields`, `getFieldByPath`, `getLocalizedPaths`, `prefixWherePaths`) | upstream JS, called at the same point with the same arguments                                                      |
| `replaceWithDraftIfAvailable`, `checkFileAccess`, `markHistoricalFileURLs`, `sanitizeInternalFields`, `prefetchVersionForInheritedReadAccess`, `getEntityPermissions`, `sanitizePermissions`, `relationshipPopulationPromise` (findDistinct)                                                                                                          | upstream JS                                                                                                        |
| Payload error classes (`Forbidden`, `NotFound`, `APIError`, `QueryError`)                                                                                                                                                                                                                                                                             | constructed by JS helpers (same class, message, status, data)                                                      |
| synchronous segments without user callbacks: `docs.map((doc) => ({ ...doc, collection }))`, lock-status filtering/assignment, `markHistoricalFileURLs` / `sanitizeInternalFields` maps, findDistinct path trimming and value renaming                                                                                                                 | JS helpers (one call per segment, same operations in the same order)                                               |

Why the query utilities are JS and not `crates/payload-core-query`: that crate works on decoded
Rust values (`payload_sql_read::Val`), not on the caller's JS objects. The operations hand the
same `where` object to `sanitizeWhereQuery` (which mutates it in place), to hooks
(`query: fullWhere`) and to the adapter, and `combineQueries` returns the caller's object when
access is `true`. Converting to Rust values and back would break that identity and the in-place
mutation the caller observes (the harness compares the args object after the operation). The
crate becomes usable here once it can operate on JS handles (or for adapter-internal use, where
no JS identity is observable).

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
- `for (const hook of hooks)`: the iterable is read once, iterated by index with a live length;
  non-arrays are collected with `[...v]`. `(await hook(...)) || docRef` and
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
common::sanitize_sort_query(fields: Local, sort: Local) -> JsResult<Local>
common::ReadHooks { collection_config, hook_name, find_many, override_access, query, req }.run(HookTarget)
binding::create_binding(env)  // { init(host), find, findByID, count, countVersions, findDistinct,
                              //   findVersions, findVersionByID, docAccess, executeAccess, sanitizeSortQuery }
```

`init(host)` takes the object of `createOpsHost()` (helpers by name), an optional `afterRead`
override and `mutant` (section 5, 0 in normal use).

## 4. Dispatch (proposed lines for `packages/payload`, not applied: files not owned)

`payload` cannot import `@payloadcms/engine-rs` (engine-rs depends on payload). The binding is
therefore registered on a global symbol by engine-rs and looked up synchronously by payload, so the
dispatch adds no await and no tick.

1. New file `packages/payload/src/utilities/rustEngine.ts` (payload side, 6 lines):

```ts
/** Set by `@payloadcms/engine-rs/ops` when `PAYLOAD_ENGINE=rs`; read synchronously per call. */
export const getRustOperations = (): Record<string, (args: any) => Promise<any>> | undefined =>
  process.env.PAYLOAD_ENGINE === 'rs'
    ? (globalThis as any)[Symbol.for('payload.engine-rs.operations')]
    : undefined
```

2. In each operation file, rename the upstream function (`findOperation` → `findOperationTS`) and
   export a dispatcher with the upstream name and generics, e.g. `find.ts`:

```ts
export const findOperation = <
  TSlug extends CollectionSlug,
  TSelect extends SelectFromCollectionSlug<TSlug>,
>(
  incomingArgs: Arguments,
): Promise<PaginatedDocs<TransformCollectionWithSelect<TSlug, TSelect>>> =>
  (getRustOperations()?.find ?? findOperationTS)(incomingArgs) as any
```

Same one-liner for `findByID.ts` (`findByID`), `count.ts` (`count`), `countVersions.ts`
(`countVersions`), `findDistinct.ts` (`findDistinct`), `findVersions.ts` (`findVersions`),
`findVersionByID.ts` (`findVersionByID`), `docAccess.ts` (`docAccess`), and in
`auth/executeAccess.ts` (`executeAccess`, called with two arguments).

3. engine-rs side (`packages/engine-rs/src/ops/register.ts`, imported by the sqlite adapter's
   `withRustEngine` or by `getPayload` when `PAYLOAD_ENGINE=rs`):

```ts
;(globalThis as any)[Symbol.for('payload.engine-rs.operations')] = {
  count: countOperation,
  countVersions: countVersionsOperation,
  docAccess: docAccessOperation,
  executeAccess,
  find: findOperation,
  findByID: findByIDOperation,
  findDistinct: findDistinctOperation,
  findVersionByID: findVersionByIDOperation,
  findVersions: findVersionsOperation,
}
```

plus a `./ops` export in `packages/engine-rs/package.json`.

Until that lands, `test/__rs/core-ops/vitest.config.ts` performs the same switch for every
importer with a `resolveId` plugin (upstream module → `test/__rs/core-ops/wrap/<op>.ts`).

The Rust operations call `afterRead` in Rust and the TS query utilities; nested operations they
trigger (population through `req.payloadDataLoader`, lock status `payload.find`, the findDistinct
virtual-field `payload.findDistinct`) go through the dispatched upstream exports, so they are Rust
as well once dispatched.

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
  A diff is re-checked with a second TS branch; if TS differs from itself (hook side effects,
  time) the case is counted as `unstable`, otherwise as a diff. `summarize.mjs` fails on any
  diff, on any rs/ts outcome difference, on a missing report and when a suite compared zero cases.

Mutation switches (`RS_OPS_MUTANT=n`, read by the glue into `init({ mutant })`, 0 otherwise)
prove the harness sees the deviations that matter:

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

2026-11-01, debug addon, TZ=UTC, SQLite (TS drizzle adapter unless noted),
`PAYLOAD_ENGINE_ADDON=<copy of target/shared/debug/libpayload_node.dylib> test/__rs/core-ops/run.sh <suites>`:

| suite                            | ts pass/fail/skip | rs pass/fail/skip | Rust op calls (rs) | shadow cases compared | diffs | unstable | events compared | rejections compared |
| -------------------------------- | ----------------- | ----------------- | ------------------ | --------------------- | ----- | -------- | --------------- | ------------------- |
| sort                             | 44/0/0            | 44/0/0            | 306                | 287                   | 0     | 0        | 1,887           | 0                   |
| select                           | 115/0/0           | 115/0/0           | 147                | 136                   | 0     | 0        | 950             | 0                   |
| fields                           | 221/0/13          | 221/0/13          | 767                | 744                   | 0     | 0        | 4,661           | 14                  |
| relationships                    | 69/0/5            | 69/0/5            | 772                | 665                   | 0     | 0        | 4,870           | 0                   |
| localization                     | 158/0/0           | 158/0/0           | 253                | 223                   | 0     | 0        | 1,712           | 0                   |
| access-control                   | 84/0/0            | 84/0/0            | 168                | 157                   | 0     | 0        | 1,808           | 27                  |
| joins                            | 115/0/8           | 115/0/8           | 598                | 483                   | 0     | 0        | 8,612           | 37                  |
| versions                         | 153/0/0           | 153/0/0           | 373                | 363                   | 0     | 0        | 2,531           | 11                  |
| core-ops synthetic (adversarial) | 5/0/0             | 5/0/0             | 4,874              | 2,683                 | 0     | 0        | 115,320         | 756                 |

- `rs`: per-test outcomes identical to `ts` in every suite (0 changed).
- `shadow`: one upstream test (`access-control` "should reuse the version lookup when inherited
  read access returns a boolean") fails only in shadow mode because it counts
  `payload.db.findVersions` calls with a spy, and shadow mode runs every operation three times.
- With `PAYLOAD_ENGINE=rs` (Rust SQL engine adapter), `rs` vs `ts` outcomes are identical for sort
  (44), versions (153) and relationships (69/0/5).
- Synthetic per operation: find 840, findByID 598, count 92, countVersions 46, findDistinct 506,
  findVersions 278, findVersionByID 276, docAccess 47 cases.
- Mutants (synthetic suite, shadow): M1 668 diffs, M2 643, M3 1,586, M4 679, M5 1,307 (M1-M3/M5
  measured before the per-event microtask `gap` was added to the log, M4 after; the first M4
  variant, "no tick when access returns a non-promise", never fires because sanitized collection
  access is always wrapped async by `withBaseAccess`).

Known gaps:

- The upstream int suites run with Rust operations only through the vitest alias config; payload
  itself is not switched (section 4 lines not applied).
- `Array.prototype.map` over `docs` ignores a patched `Symbol.species`/`map`; non-array `docs`
  give V8's TypeError for `null`/`undefined` and `<expr>.map is not a function` otherwise
  (an object with its own `map` method is rejected as unsupported).
- Engine-created errors have Rust/host stacks; class, message, status and data are identical.
- Concurrent operations: each operation's own event order is compared; interleaving between
  concurrent top-level operations is not (the shadow runs branches sequentially).
- Write operations, globals, auth: not ported (section 6).
