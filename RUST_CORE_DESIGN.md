# Rust core engine ↔ user TS code: interop design

Scope: how the Rust core engine (collection/global operations and the field hook traversals
`beforeValidate`, `beforeChange`, `afterChange`, `afterRead`, `beforeDuplicate`) calls user JS
(hooks, access, `validate`, `defaultValue`, editor hooks) while behaving exactly like upstream.
This document compares strategies with measurements, picks one, and reports a working prototype:
`fields/hooks/afterRead` ported to Rust and verified differentially against the TS reference.

Code:

| path                                                | what                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `crates/payload-core-runtime/src/js.rs`             | raw Node-API wrappers, `Local`/`Val`/`Persist`/slot table                               |
| `crates/payload-core-runtime/src/executor.rs`       | JS-microtask-driven executor for Rust `async` code                                      |
| `crates/payload-core-runtime/src/host.rs`           | JS host helpers + JS-semantic property operations                                       |
| `crates/payload-core-runtime/src/config.rs`         | field descriptors decoded once from the live config                                     |
| `crates/payload-core-runtime/src/after_read.rs`     | port of `afterRead/{index,traverseFields,promise}.ts`                                   |
| `crates/payload-core-runtime/src/bench.rs`          | micro-benchmarks used below                                                             |
| `crates/payload-node/src/runtime.rs`                | `coreRuntimeBinding()` export of the main addon                                         |
| `crates/payload-core-runtime/examples/dev_addon.rs` | standalone addon exposing only the runtime                                              |
| `packages/engine-rs/src/runtime/index.ts`           | loads the binding, installs host helpers, `afterRead`                                   |
| `crates/payload-core-hooks-{validate,change,after}` | beforeValidate, beforeChange, afterChange/beforeDuplicate                               |
| `packages/engine-rs/src/runtime/*/`                 | their TS glue (host helpers, leaf `promise()` bodies)                                   |
| `packages/engine-rs/src/runtime/hooks.ts`           | entry payload's hook modules load under `PAYLOAD_ENGINE`                                |
| `test/__rs/core-runtime/`                           | differential suites, adversarial config, benchmarks                                     |
| `test/__rs/core-hooks-*/`                           | differential suites of the other traversals                                             |
| `test/__rs/dispatch/`                               | upstream int suite runner, traversal benchmark, exit probe, harness engine guard        |
| `crates/payload-core-query/src/live/`               | query validation (`validateQueryPaths`, `sanitizeJoinQuery`, ...) on live JS objects    |
| `crates/payload-node/src/core_query.rs`             | `coreQueryBinding()` export (needs `coreRuntimeBinding` of the same addon file)         |
| `crates/payload-core-query/examples/query_addon.rs` | standalone addon exporting every core binding (runtime, query, hook traversals)         |
| `test/__rs/core-query/`                             | query glue (`glue.ts`), live differential (`live/`), replay recorder, upstream redirect |

## 1. What "exact" means here (read from the TS)

Semantics the engine must reproduce, all observable by user code:

1. **Sync prefix of async functions.** `promise()` (one per field) is an `async` function.
   Calling it runs synchronously up to the first `await`. Fields with no hooks, access or default
   value never await, so nested `traverseFields` calls (arrays, blocks, groups, tabs) happen
   synchronously and push their own promises _before_ the parent's promise is pushed.
2. **Batches.** `afterRead` splices `fieldPromises`, awaits `Promise.all`, then does the same
   for `populationPromises`, and repeats until both are empty (100 iterations max, then a
   specific `Error`). Promises pushed by a hook continuation land in the next batch.
3. **Shared JS arrays.** `fieldPromises`/`populationPromises` are handed to rich text editor
   hooks (lexical pushes into them and calls the TS `traverseFields`), so they must be real JS
   arrays holding real promises.
4. **Await points and tick counts.** Each field hook is awaited (one microtask even for a sync
   return). Per-locale hooks run as `Promise.all(entries.map(async ...))`. `access.read` is
   awaited only when `overrideAccess` is falsy (`overrideAccess ? true : await ...`).
   `getDefaultValue` is its own async function, so a default costs extra ticks. Concurrent
   `afterRead` calls (the find operation runs `Promise.all(docs.map(afterRead))`) interleave
   through the shared microtask queue.
5. **Identity.** `data`/`originalDoc` are the root doc and `siblingData` is the actual sibling
   object. `field` is the config object, except for tabs, which are fresh `{ ...tab, type: 'tab' }`
   copies per traversal. `siblingFields` is the array being traversed. `req`/`context` are the
   request's objects. `blockData` is the row. `path`/`schemaPath`/`indexPath` arrays are created
   once per field and shared by all hooks of that field. Object default values are deep copied.
   The returned doc is the input object.
6. **Mutation visibility.** Hooks mutate `siblingData`, other fields' values, `req.context`, or
   objects stashed earlier, at any time (also after awaits). Later reads must see those mutations
   in exactly the interleaving the TS code produces.
7. **Arg objects.** The hook/access args are object literals with a fixed key order and own
   `undefined` properties (`blockData`, `findMany`). `access.read` is called as a method
   (`this === field.access`). Hooks and defaults are called with `this === undefined`.
8. **Errors.** A throw before the first await is a rejection, not a synchronous throw; the other
   fields keep running; `Promise.all` rejects with the first rejection _in time_; the user's
   error object propagates unchanged. Engine errors (`MissingEditorProp`, unsanitized editor,
   infinite loop) have specific classes/messages. Module code is strict: writing to a primitive
   or frozen object throws `TypeError`, and so does reading through `null`.
9. **Quirks.** These include `row || {}` letting a truthy primitive become a sibling doc,
   `req.payload.blocks[blockType]` reaching `Object.prototype` (e.g. `constructor`), and
   `getBlockSelect` being called before the `if (block)` check (TypeError for unknown blocks with
   a select).

## 2. Strategies

### A. Rust owns the data, sync back around every callback

The doc lives in Rust (`serde_json`-like values). Before each user call, the doc (or the relevant
subtrees) is materialized as JS. Afterwards, JS is serialized back and diffed or replaced.

- **Mutation:** only visible at sync points. A hook that stashes `siblingData` (or `req.context`
  objects) and mutates it after its own await, while another field is running, writes into a
  stale JS copy. That is lost or overwrites Rust-side changes. Not fixable without proxies.
- **Identity:** every sync point creates new JS objects. `siblingData === previous siblingData`,
  stashed references, shared default objects and `doc === returned doc` all break. Non-JSON
  values put into docs by hooks (Dates, class instances, functions, cycles) do not survive.
- **Ordering/microtasks:** possible to emulate, but sync points add their own awaits/ticks.
- **Cost (measured, release):** one JSON round trip per callback (`JSON.stringify` → Rust parse
  - serialize → `JSON.parse`) costs **9.1 µs** for a 20-field/371 B doc and **99 µs** for a
    200-field/4.2 KB doc. A doc with 60 hooked fields would spend 0.5–6 ms just syncing, versus
    ~35 µs for the whole TS traversal.
- **Verdict:** rejected. It is neither exact nor fast.

### B. Rust drives the JS objects through Node-API handles on the JS thread (chosen)

The doc stays a JS object graph. Rust holds persistent handles and performs exactly the property
reads/writes/deletes/calls the TS performs, in the same order. Async control flow is Rust
`async` code run by a custom single-threaded executor whose only wake-up source is JS promise
reactions:

- `spawn(fut)` = calling a JS async function. The future is polled synchronously until it first
  suspends, and a native promise (`napi_create_promise`) is returned. It is resolved/rejected
  when the body returns/throws.
- `await_js(v)` = the JS `await` operator. It calls a JS async function compiled by the binding,
  `async (v, token) => { let r; try { r = await v } catch (e) { resume(token, false, e); return }
  resume(token, true, r) }`: V8's own Await (PromiseResolve with one `constructor` read, then
  PerformPromiseThen without SpeciesConstructor; thenables get the NewPromiseResolveThenableJob).
  `resume` re-polls the task synchronously inside that reaction job, which is where the TS `await`
  continuation runs. (Phase J; it was `Promise.resolve(v).then(...)`, whose `.then` read
  `constructor` a second time and `Symbol.species`.) Proof: test/__rs/core-runtime/semantics.mjs.
- `call(fut).await` = calling a nested async function from inside an engine task without native
  recursion (the task's driver runs the callee's synchronous prefix, then resumes the caller with
  the callee's promise); nesting costs heap, and an emulated stack limit (per-level frame bytes vs
  V8's measured limit) throws V8's RangeError at a depth no shallower than TS.
- Concurrency is only composed in JS (`Promise.all` over spawned task promises), never with Rust
  combinators. The resulting microtask graph is therefore isomorphic to the TS one.

Fidelity:

- **Mutation/identity:** exact by construction (same objects).
- **Ordering:** exact as long as the port awaits exactly where TS awaits and makes exactly the
  same `async` calls. This is a reviewable, line-by-line porting rule, and it is verified by
  differential tests (section 4).
- **Errors:** user throws are kept as the original JS value (`Thrown(Val)`). Engine errors are
  created by JS host factories (same class/message; only the stack differs). Strict-mode
  semantics come from host helpers (see probes).

Cost: every JS-observable step is a napi call (≈ 13–66 ns), every await ≈ 168 ns (vs 28 ns in
JS), every async call ≈ 237 ns (vs 12 ns in JS). See section 5.

### C. Hybrid: Rust-owned doc exposed to JS through Proxy views

The doc lives in Rust. Hooks receive `Proxy` objects whose traps read/write Rust storage.

- **Identity:** each Rust node can map to one cached proxy, so `===` is stable. But the proxy is
  not the doc the TS code returned. `structuredClone`, `util.types.isProxy`, `Object.freeze`,
  property descriptors, getters, class instances and Dates stored by hooks all need extra
  emulation. `Array.isArray(proxy)` works for array targets, but `napi_is_array`/V8 fast paths
  treat it differently.
- **Mutation:** visible immediately (good), but every hook access pays a trap.
- **Cost (measured):** a proxy property read with a native trap is **120.7 ns** vs **32 ns** for
  a plain read (the plain loop is not fully optimized away). Every hook-side access is ~4x
  slower, and lexical / user code doing deep traversal or `JSON.stringify` on `siblingData`
  takes that cost on every node.
- **Verdict:** rejected for the traversals. Too many observable differences for an "exact"
  port, and it moves cost onto user code. It could be useful for read-only DB rows that no user
  code ever touches (see 6).

### D. (for completeness) Rust engine on a worker thread, JS callbacks via ThreadsafeFunction

- **Ordering:** each callback is a cross-thread hop scheduled through libuv. Microtask
  interleaving with other JS work (concurrent requests, other docs of the same find) cannot match
  the TS order, and synchronous-prefix semantics are lost.
- **Data:** it still needs A or C for the doc.
- **Cost (measured):** a worker → JS → worker round trip is **6.2 µs** (sync JS) and **6.4 µs**
  (JS awaits once). That is ~100x a direct napi call per hook.
- **Verdict:** rejected for anything that calls user code. ThreadsafeFunctions remain right for
  pure Rust work (SQL on `payload-sqlite` workers) that the JS thread awaits as a promise.

### Comparison

| strategy                | mutation/identity | call order | microtask interleaving | per-callback overhead (measured)              |
| ----------------------- | ----------------- | ---------- | ---------------------- | --------------------------------------------- |
| A sync-back             | broken            | emulable   | extra ticks            | 9–99 µs (doc size dependent)                  |
| B napi handles (chosen) | exact             | exact      | exact (verified)       | ~0.2 µs await + napi ops (~2.5 µs/hook total) |
| C proxies               | mostly            | exact      | exact                  | +90 ns per user property access               |
| D worker + TSFN         | needs A/C         | no         | no                     | 6.2–6.4 µs                                    |

## 3. The chosen runtime (B) in detail

**Values.** `Local` is a napi handle valid only within the current synchronous segment (the
callback that is running). It is never held across an `.await`. `Val` survives awaits:
booleans and numbers are copied, objects/functions/symbols are `napi_ref`s, and strings/bigints
go through a JS slot table. The probe showed `napi_create_reference` rejects strings, numbers
and bigints under the napi version napi-rs registers. After each await the port re-reads
locals from `Val`s.

**JS-semantic operations** (`host.rs`):

- `get` uses `napi_get_property` for objects and functions, which matches `[[Get]]`
  (prototype chain, getters, proxies). For primitives and nullish values it uses the host
  `(o, k) => o[k]`, so the TypeError messages match V8's.
- `set` always goes through the host's strict-mode setter. The probe showed
  `napi_set_property` on a frozen object returns `napi_ok` and silently ignores the write,
  whereas module code would throw.
- `delete` uses napi and falls back to the host's strict `delete` when napi returns `false` on a
  non-configurable property, which throws the exact TypeError.
- Spreads, `Object.values`/`entries`, `parseInt(String(depth))`, `getSelectMode`,
  `getBlockSelect`, `deepCopyObjectSimple`, Payload error classes, and relationship/virtual
  population are delegated to the TS implementations, called at the same point.

**Config** (`config.rs`). Descriptors are decoded once per JS fields array, block and tab, and
cached in a JS `WeakMap` keyed by the config object. External values own the Rust descriptor.
Shared field arrays/blocks therefore get one descriptor (the "one decoded config graph"
contract), and descriptors keep a reference to their JS object. Everything passed to user code
(`field`, `siblingFields`, blocks, `defaultValue`, hook arrays, `access`, `editor`) is the real
config object, read when used. Only branch conditions are snapshotted (type, `'name' in field`,
hidden, localized, virtual, presence of hooks/access/default). The config is treated as
immutable after sanitization, like everywhere else in the engine.

**Porting rules** (binding for the remaining traversals and operations):

1. One Rust `async fn` per TS `async` function. Call it through `spawn` wherever TS calls it,
   and await its promise with `await_js` wherever TS awaits it. Never inline an async callee: that
   removes ticks (mutant M2 below).
2. `await_js` exactly where TS has `await`, including on synchronous values. Never "skip the
   await if not a promise" (mutant M1).
3. Concurrency only through JS `Promise.all`/`Promise.allSettled` over task promises, in the same
   order (iteration order matters; mutant M3).
4. Arrays/objects that user code can see (promise arrays, args, paths) are real JS objects,
   created at the same point, with the same key order.
5. No `Local` across an await. Persist with `Val`.
6. A fast path may replace a task only where the TS `async` function provably completes without
   awaiting (decided from the decoded config plus per-call flags). It must perform the same
   operations in the same order and push the same number of promises, settled the same way.
   Bulk host helpers may perform JS-observable operations for the engine, but only ones the TS
   performs at that point, and control flow stays in Rust.

**Executor robustness.** If a resume arrives while the task is being polled, the task is
re-polled instead of losing the wake-up. A value-conversion failure in `resume` is delivered to
the task as a rejection, not dropped. (The first version dropped such wake-ups, which showed up
as a hang under a mutant. The differential harness now also reports hangs per run as a 10 s
timeout outcome.)

**I/O.** Database work stays in `payload-sqlite` worker threads. The engine awaits it as a JS
promise (`await_js` on the promise the async napi call returns), so DB completion interleaves
with hooks exactly as the TS adapter's promises do.

### Fast paths (exact by construction, verified by traced differential runs)

A JS `async` function that finishes without awaiting returns an already-settled promise, and its
only observable effects are the operations its synchronous body performs. The engine therefore
does not need a Rust task for a field whose `promise()` provably never awaits. It must still
perform the same doc operations, in the same order, and push the same number of promises,
created at the same point and settled the same way (the count matters: `Promise.all` over
already-settled promises takes one reaction job per element, which shifts microtask
interleaving between documents and hooks).

- **Plain leaves** (`config::Leaf`, decided once per field descriptor): leaf types (not
  array/blocks/group/row/collapsible/tab(s)/point/richText/relationship/upload/join), no
  `afterRead` hooks, no string `virtual`, `access.read` only with a truthy `overrideAccess`,
  `localized` only under a localized parent. A non-data field (`ui`, unnamed) is plain unless the
  `locale === 'all'` check could read it. For such a field `promise()` reads the sibling doc
  only in the hidden check, `stripUnselectedFields`, the hoisting check
  (`typeof siblingDoc[name] === 'object' && siblingDoc[name] !== null`) and the default value
  check, and maybe deletes (hidden, unselected). `FieldsDesc::plan` splits a fields array into runs
  of plain leaves and other fields (cached per fields array and per
  `overrideAccess`/parent-localized combination).
- **`leafRun`** (host): one call per run performs exactly those reads/deletes per field (with the
  runtime bits: `flattenLocales`, `showHiddenFields`, `fieldDepth === 0`, whether a field named
  `id` gets the path `'id'`, select mode) and pushes a fresh fulfilled promise (from an
  `async () => {}`), or a rejected one if a getter/proxy/strict delete threw (from an
  `async (e) => { throw e }`), with the real `fieldPromises.push`. When a field's default value
  applies (`typeof siblingDoc[name] === 'undefined'` and a `defaultValue`), `leafRun` stops
  there; the engine runs the rest of that `promise()` (`getDefaultValue`, still its own task as
  porting rule 1 requires) as the field's task, pushes its promise and resumes the run.
- **`leafRows`** (host): an array field whose row fields are all plain leaves iterates its rows
  like `forEach` (length read once, holes skipped, `row || {}`) and runs `leafRun` per row in one
  call, handing back `[rowIndex, fieldIndex, siblingDoc, length]` when a default value applies
  (sanitized arrays always have the row `id` field with a `defaultValue` function).
- **Unnamed row/collapsible/group**: `promise()` touches no data and only calls `traverseFields`,
  so the engine traverses the children inline and pushes a settled promise (`pushSettled`;
  rejected if the nested traversal threw).
- **Hooked plain leaves** (`hooked_leaf`, flag `HOOKED`): a plain leaf except for its hooks
  (data field, `afterRead` hooks). `FieldsDesc::plan` puts hooked leaves into runs
  (`Segment::Run(start, end, hooked)`), and `leafRun` calls **upstream's own `promise()`**
  (`afterRead/promise.ts`, imported by the glue) for such a field, with the args literal
  `traverseFields` builds (the `afterReadArgs` values, the traversal's `blockData`, `fields`,
  parent paths, `fieldDepth`, `parentIsLocalized`, `select`, `selectMode`, `triggerAccessControl`
  / `triggerHooks` `true`), and pushes its promise; a rows array whose fields are all plain or
  hooked leaves still goes through `leafRows`, which passes the row paths
  (`path + '.' + rowIndex`, `schemaPath`) and the rows' `fieldDepth` / `parentIsLocalized` /
  `selectMode`. No copy of upstream code and no Rust task, native promise or resume per hooked
  field remains: V8 runs upstream's function, hooks loop included.
- **`executor::await_call(helper, args)`**: `await f(...)` where the host helper builds the args,
  makes the call and passes the result to `awaitValue` (one napi call instead of three). A
  synchronous throw completes the await with that error without a tick, exactly like a throw
  inside `await f()`. Used for field hooks, editor hooks and `access.read`.
- **Args array**: the `afterRead` destructuring is done by the host (`afterReadArgs`, same pattern
  and `flattenLocales = true` default) inside the task, so a throw there rejects like the TS
  `async function`. The resulting array (with derived `depth`/`currentDepth` and the two promise
  arrays) is passed whole to the helpers that build hook/population args.
- **Cheaper primitives**: `js::call` passes args without allocating, ASCII property keys are
  created with `node_api_create_property_key_latin1` instead of a cache over napi handles, string
  field names are recreated from their UTF-16 copy, ASCII strings are created as Latin-1, and
  `getFieldPaths` no longer allocates intermediate vectors.

### Tail awaits (`executor::spawn_tail`)

Most engine `async` functions end with `await x; return v` where `x` is a native promise
(`await Promise.all(promises)` in every `traverseFields`; `await traverseFields(...)` /
`await Promise.all(rows)` at the end of every container `promise()`; `await traverseFields(...);
return data` in the `beforeValidate`/`afterChange`/`beforeDuplicate` entries). For such a body that
reaches its tail in the first, synchronous poll (it never suspended), the function's promise is
`(async (p, v) => { await p; return v })(x, v)` (the binding's compiled `thenReturn`) instead of a
task promise plus an await/resume round trip:

- `await x` of a native promise is one `PerformPromiseThen(x, resume)` (PromiseResolve returns `x`
  itself), so the function resumes in the reaction job of `x` and resolves its promise with `v`
  there. `then(() => v)` performs the same single reaction on `x` and resolves its result with `v`
  in that same job (a thenable `v` goes through the same `ResolvePromise` path); a rejection of `x`
  rejects both in that job. Promises created and reaction jobs queued are the same, in the same
  order, so the microtask interleaving is unchanged.
- A body that suspended before its tail is an ordinary task (deferred created once it suspends)
  and its tail is a real `await_js`.

The body returns `Tail::Await(x, v)` / `Tail::Return(v)`; mutation test:
`mutant-tail-skip-tick` (feature of payload-core-runtime: return `x` itself, one tick less).

### Leaf fields of the other traversals run upstream's own `promise()` in JS

For beforeValidate, beforeChange, afterChange and beforeDuplicate, every field whose type is not
`array`, `blocks`, `collapsible`, `group`, `richText`, `row`, `tab` or `tabs` (`is_leaf` in each
crate: no subfield traversal, no editor hooks) is a leaf. Each crate's `traverse_fields` hands
every run of consecutive leaves to one host call (`beforeValidateLeaves`, `beforeChangeLeaves`,
`afterChangeLeaves`, `beforeDuplicateLeaves`) that does `promises.push(promise({...}))` per field,
in field order, into the traversal's own promises array; container fields stay Rust tasks between
them. `promise` there is **upstream's exported `promise` of
`packages/payload/src/fields/hooks/<traversal>/promise.ts` itself** (imported by the glue in
`packages/engine-rs/src/runtime/*/`), called with the args object upstream's `traverseFields`
builds: same keys in the same order, with the traversal-constant values read from a context array
the crate builds once per call (`[id, collection, context, ...]`) and the per-call ones
(`blockData`, parent paths, `parentIsLocalized`, `siblingData`/`siblingDoc`, ...) passed by the
crate. No copy of upstream code is involved, so a leaf is upstream by construction (reads,
writes, awaits, `for...of`, V8 messages, module-private helpers such as beforeChange's
`hasInvalidFieldValueShape`); the differential suites check the dispatch around it (argument
plumbing, order, promise count). Tab traversals (`field.tabs` copies) keep the ported path.

A `traverseFields` call whose fields array contains only leaves (rows of arrays/blocks of leaf
fields, groups and collapsibles of leaves, collections without containers) calls **upstream's
exported `traverseFields`** of the same module (`beforeValidateLeafTraversal`,
`beforeChangeLeafTraversal`, `afterChangeLeafTraversal`, `beforeDuplicateLeafTraversal`: one
host call with the args literal of the crate's call), where the crate would spawn its
`traverse_fields`. The crates keep the field promises of container fields (arrays, blocks,
groups, collapsibles, rows, tabs, rich text) and every traversal that contains one. Mutation
test: BV `M13` (the leaf promises are pushed and `Promise.all` is returned without
`traverseFields`' own async function).

Nothing here changes what user code can observe: the same objects, the same property operations
in the same order (checked with recording proxies, see section 4), the same calls with the same
args and `this`, the same number of promises settling at the same microtask.

### afterRead: plan traversal (phase K, the default)

Profiles of the read operations (perf suite, `find limit 100` on db-postgres) showed the Rust
traversal spending ~45 µs per typical document in Node-API crossings (TS: ~22 µs for the whole
afterRead): every JS-observable step of a container field's `promise()` was a crossing, and so
were the per-document task, its ~18 persistent references and the promise loop. Since V8 performs
those steps far faster than any crossing, the traversal now splits like this:

- **Rust decides.** `config.rs` classifies every field once per fields array and per
  `overrideAccess` / parent-localized combination (`fast_kind`): a plain leaf (the `Leaf`
  classification of the fast paths above, hooked leaves included), a relationship / upload / join,
  a named group, an array, an unnamed row / collapsible / group, or `UPSTREAM`. A fast kind is a
  data field without a virtual path, without read access to await (or `overrideAccess`) and not
  localized under a non-localized parent (no value hoisting, no `locale: 'all'` hook runs), or a
  passthrough container. `FieldsDesc::js_plan(variant)` hands the host a plan object (`fields`, the
  `keys` / `flags` leaf table, `kinds`, `isArray`, a `children` cache), created once.
- **The host executes.** `packages/engine-rs/src/runtime/afterReadPlan.ts`: `traverse` pushes one
  promise per field (`fieldPromises.push(...)`, `push` read before the field runs); `UPSTREAM`
  fields call upstream's own `promise()` with upstream's args literal (`hookedLeaf`), every other
  field runs `fastField`, an `async` function containing exactly the branches of upstream's
  `promise()` the classification leaves reachable, in upstream's order, with upstream's awaits
  (field hooks loop, default value step): hidden check, `stripUnselectedFields`, the hoisting
  reads, the group `{}` fill, the hooks, the default value, `relationshipPopulationPromise`, then
  the rows / group / passthrough traversal with the same plans (nested plans come from Rust through
  the binding's `afterReadPlan(fields, variant)` and are cached on the parent plan). Path strings
  come from upstream's `getFieldPaths`, segment arrays are built like upstream's (fresh arrays,
  shared by the hooks of one field). Real `forEach` / `Object.values` / `Array.isArray` calls, so
  patched built-ins and proxies of arrays behave as upstream.
- **afterRead itself** is a synchronous Rust entry: the args destructuring (host, upstream's
  pattern), `depth` / `currentDepth`, `(collection?.fields || global?.fields)`, `getSelectMode`,
  the root traversal (one host call), and then the host's `afterReadLoop(c)`: the rest of
  upstream's body verbatim (`while` loop over the spliced promise arrays, the 100-iteration error,
  `return incomingDoc`) as an `async` function whose promise is returned. Upstream's promise is
  that of one async function that reaches the same loop synchronously, so it settles in the same
  microtask; a throw in the synchronous part rejects (host `rejected`). No Rust task, persistent
  reference or resume per document remains.

What the plans skip is config work only (args literals, `getFieldPaths` / segment arrays nobody
reads, `fieldAffectsData` / `fieldShouldBeLocalized` / `stripUnselectedFields` calls the config
decides). `PAYLOAD_RS_AFTER_READ_TRAVERSAL=rust` selects the Rust traversal of the sections above
(also still used by `afterReadTraverseFields`, the rich text editors' entry). Mutation checks of
the plan path against the core-runtime suites: dropping the hoisting-check reads (traced runs
only) 277 diffs in `hooks`; skipping the await tick of a synchronous field hook result 45 (`hooks`)
and 986 (`synthetic`) diffs.

## 4. Prototype: `afterRead` in Rust, differential verification

`after_read.rs` ports `afterRead/index.ts`, `traverseFields.ts`, `promise.ts`,
`getFieldPaths`, `stripUnselectedFields`, `fieldShouldBeLocalized`, `fieldAffectsData` and
`getDefaultValue`. Relationship/join/upload population (`relationshipPopulationPromise`) and
virtual fields (`virtualFieldPopulationPromise`) are pushed onto `populationPromises` by calling
the TS implementations at the same point. That is the "Host callback" option: nested docs are
populated by the TS operations, which call TS `afterRead`.

Harness (`test/__rs/core-runtime/differential.ts` + `suite.ts`):

- Wraps every field `afterRead` hook, field `access.read`, function `defaultValue` and rich text
  editor `afterRead` hook in the sanitized config. Each call is recorded with a content snapshot
  of its args taken at call time: key order, values, `siblingData` content, identity numbers of
  data/siblingData/rows, config objects by path, `$req`/`$context`/`$payload`, and `this`. Each
  sync return, async settle and rejection is also recorded, which captures microtask order.
- For every collection/global × variant × doc set, it runs TS `afterRead` and then Rust
  `afterRead` on fresh copies of the same raw DB docs (`payload.db.find`, plus a synthetic empty
  doc), sequentially and concurrently (`Promise.all`, `findMany: true`).
- It compares the output docs (with identity structure), `doc === result`, the event logs,
  `req.context` after the run (hooks log internal steps there), and rejections: class, message,
  and whether the error is the very object user code threw. When each doc's `afterRead` promise
  settles is an event too.
- **Traced runs.** Every run is repeated with the input docs wrapped in recording proxies (every
  non-array object; arrays stay plain because `napi_is_array` and `Array.isArray` differ on
  proxies). Each `get`/`set`/`delete`/`has`/`ownKeys`/`getOwnPropertyDescriptor`/
  `defineProperty` on the doc graph is logged, in order, into the same event log as the
  callbacks. Any skipped, extra or reordered read or write, as a getter or a proxy in user data
  would see it, is a diff. Harness snapshots are taken with tracing off.
- Variants:
  - `base` (overrideAccess), `access`, `hidden`, `depth2` (population + draft)
  - `select-include`, `select-exclude`
  - when localized: `all`, `flatten-fallback`, `flatten-fallback-list`, `flatten-no-fallback`,
    `no-flatten`
  - extra select/blocks variants for the synthetic config
- Generated ObjectIds (24-hex strings that are not in the input, e.g. row-id defaults) are
  canonicalized by order of first appearance.

Results (`RS_CORE_RUNTIME_DB=/tmp/rs-runtime-perf.db TZ=UTC test/__rs/core-runtime/run.sh`, via
the `payload-node` debug addon (`PAYLOAD_ENGINE_ADDON`) and the release dev addon; half of the
runs are traced):

| config                                           | runs | docs | callback/settle events | doc trace events | rejections compared | diffs |
| ------------------------------------------------ | ---- | ---- | ---------------------- | ---------------- | ------------------- | ----- |
| `test/hooks/config.ts`                           | 564  | 648  | 1200                   | 6732             | 0                   | **0** |
| `test/fields/config.ts`                          | 1936 | 3564 | 13068                  | 106266           | 0                   | **0** |
| `test/__rs/core-runtime/config.ts` (adversarial) | 1628 | 1984 | 67824                  | 336918           | 612                 | **0** |

The fields config covers lexical (editor hooks pushing into `fieldPromises`/`populationPromises`
and calling TS `traverseFields`), blocks, block references, tabs, localization, uploads (URL
hooks) and relationships at depth 2. The adversarial config adds:

- hooks with 0–6 microtasks, `setImmediate`, thenables, and promise-of-promise
- `siblingData` stashed in `req.context` and mutated later by another field
- hidden/denied/default combinations; async and object defaults
- localized hooks per locale (`locale: 'all'`)
- sync/async/access throws with a custom error class
- edge shapes: null group, primitive/hole rows, unknown/`constructor`/null block rows, string
  groups, malformed points, a frozen group (strict TypeError), shared sub-objects, raw localized
  maps
- virtual fields and hasMany relationships
- a `plain` collection aimed at the fast paths: runs of plain leaves, hidden/access/default/
  localized-under-localized plain leaves, unnamed row/collapsible/group (nested), arrays whose
  rows are all plain with and without defaults, hooked plain leaves (hidden, with a default,
  three hooks), a tick-count probe hook, select include/exclude variants, and edge docs with a
  throwing getter, a read-counting getter, a frozen doc (strict delete of a hidden field),
  `null`/primitive/hole rows, and non-object values

**Mutation testing** (is the harness sensitive enough?). Deliberately wrong builds of the
current code (diffs; in parentheses those from untraced runs):

| mutant                                                                  | adversarial | fields     | hooks    |
| ----------------------------------------------------------------------- | ----------- | ---------- | -------- |
| M1: skip the await tick when a hook/awaited value is not a promise      | 1022 (463)  | 264 (116)  | 69 (16)  |
| M2: inline `getDefaultValue` (no own promise, fewer ticks)              | 1166 (572)  | 541 (203)  | 22 (10)  |
| M3: process sibling fields (plan segments) in reverse order             | 1442 (672)  | 1344 (420) | 306 (48) |
| M4: `leafRun` skips the default-check read for fields without a default | 786 (22)    | 954 (0)    | 274 (0)  |
| M5: `leafRun` always does the second hoisting read                      | 86 (0)      | 354 (0)    | 12 (0)   |
| M6: hooked fields classified as plain leaves (hooks not run)            | 1328 (664)  | 160 (80)   | 90 (45)  |
| M7: no promise pushed for unnamed containers                            | 0           | 80 (40)    | 0        |
| M8: `leafRows` visits array holes                                       | 48 (24)     | 0          | 0        |

M4 and M5 change only how often a doc property is read, so only traced runs see them. M7 is
seen through the lexical editor hook, which receives `fieldPromises` and whose args snapshot
lists the promises; the synthetic config has no rich text field. (Promise.all over N already
settled promises queues N contiguous reaction jobs, so the count alone rarely moves other
events.) M1 is caught even by the upstream configs: the uploads URL hooks change key insertion
order.

Reproduce:

```sh
export CARGO_TARGET_DIR=$PWD/target/shared
cargo build -p payload-node            # or: cargo build -p payload-core-runtime --example dev_addon
cp target/shared/debug/libpayload_node.dylib /tmp/payload-node.node
PAYLOAD_ENGINE_ADDON=/tmp/payload-node.node test/__rs/core-runtime/run.sh   # hooks fields synthetic
cargo build --release -p payload-core-runtime --example dev_addon
cp target/shared/release/examples/libdev_addon.dylib /tmp/dev-addon.node
PAYLOAD_CORE_RUNTIME_ADDON=/tmp/dev-addon.node pnpm tsx test/__rs/core-runtime/bench.mts
```

`run.sh` runs the specs one at a time, each on a fresh SQLite file (`RS_CORE_RUNTIME_DB`,
default `/tmp/rs-core-runtime.db`), and runs all of them even when one fails. Running the three spec files
in parallel vitest workers against one `SQLITE_URL` deadlocks on the shared database (observed as
a 90 s timeout in the hooks suite; every suite passes when run alone).

## 5. Performance (release build, Apple Silicon, Node 24.22.1)

| operation                                             | cost            |
| ----------------------------------------------------- | --------------- |
| JS → Rust sync call                                   | 13.2 ns         |
| Rust → JS sync call (`napi_call_function`)            | 59.8 ns         |
| `napi_get_property` / `napi_set_property`             | 57.0 / 65.7 ns  |
| napi reference create + read + delete                 | 61.3 ns         |
| Rust task JS await (resume via reaction)              | 141.9 ns        |
| JS `await` (baseline)                                 | 28.4 ns         |
| Rust spawn (async call, sync completion)              | 206.9 ns        |
| JS async fn call (baseline)                           | 11.8 ns         |
| ThreadsafeFunction round trip (sync JS / awaiting JS) | 6157 / 6435 ns  |
| Strategy A sync-back per callback, 371 B / 4.2 KB doc | 9.1 / 99.3 µs   |
| Strategy C proxy read / plain read                    | 120.7 / 32.0 ns |

(Re-measured with the current build; `await`/`spawn` got cheaper with the allocation-free
`js::call` and without the per-spawn handle scope.)

End to end, without a DB (`test/__rs/core-runtime/bench.mts`; `BENCH_E2E_ONLY=1` skips the
micro benchmarks): TS and Rust batches of 1000 docs alternate within one process, 15 rounds per
case, each round measured as main-thread CPU time (`process.threadCpuUsage`; all of `afterRead`
runs on the JS thread) so that other jobs on a shared machine distort less; wall time is
reported too (it matched CPU time for the runs below, load average ~4 on 12 cores). The ratio
is of the medians. Cases:

- **67 visits**: one doc with 67 field visits (20 texts, a group of 10, 10 array rows × 3, named +
  unnamed tabs), `overrideAccess: true`.
- **select**: the same with `select: { t1, group: { g1 }, rows: { a }, tab }`.
- **typical**: 12 mixed fields (number/text/select/checkbox/date, two with default values, a
  hidden one, one with `access.read`), a collapsible, an array of 4 rows with a nested array of 3,
  3 blocks; array rows and blocks carry the sanitized row `id` field with its `defaultValue`.

| afterRead, CPU µs/doc (median)    | before: TS | before: Rust  | after: TS | after: Rust  |
| --------------------------------- | ---------- | ------------- | --------- | ------------ |
| 67 visits, no hooks               | 23.2       | 74.3 (3.20x)  | 23.5      | 12.2 (0.52x) |
| 67 visits, sync hook on each leaf | 34.4       | 189.8 (5.52x) | 33.6      | 91.0 (2.71x) |
| 67 visits, no hooks, select       | 27.1       | 89.7 (3.31x)  | 28.0      | 17.3 (0.62x) |
| typical doc                       | 37.8       | 99.9 (2.64x)  | 38.7      | 20.8 (0.54x) |

"before" is the prototype build, "after" the current one, each measured in its own process
against TS (same bench script, back to back).

Where the time went before, and what removed it (sampling profiles of the release build):

- One Rust task per field (`spawn`: boxed ~740 B future, native promise, deferred) even for
  fields whose `promise()` never awaits. Plain leaves now cost a few JS property reads inside one
  host call per run of fields, and arrays of plain rows one call per array.
- ~16 napi property reads plus a persistent reference per arg at `afterRead` entry, and the 12- to
  28-key args objects for population/editor/access calls built with napi property sets. Now one
  host destructuring call and helpers that read the args array in JS.
- Three napi calls per hook (`hookArgs`, the call, `awaitValue`) plus the assignment after the
  await; now one call (`callLeafHook`/`callFieldHook`) and the assignment in the reaction job.
- Key lookups through a SipHash map over slot-table handles, field names through the slot table
  (thread-local + `RefCell` + two napi calls each), `getFieldPaths` allocations, an allocation
  per `napi_call_function`, a handle scope per spawn.

**Hooked leaves in JS** (`hookedLeaf`, see the fast paths). Same bench, release dev addon,
measured on the shared machine (load average 4 for the first run, 35-40 for the others):

| afterRead, CPU µs/doc (median)    | TS   | Rust, hooked leaf task (before) | Rust, `hookedLeaf` per field | Rust, hooked leaves in runs |
| --------------------------------- | ---- | ------------------------------- | ---------------------------- | --------------------------- |
| 67 visits, sync hook on each leaf | 35.2 | 91.0 (2.71x)                    | 51.1 (1.36x)                 | 35.5 (1.01x)                |

(1.12x in a rerun at load 37, where the no-hook cases measured 0.55-0.62x.)

**All five traversals** (`test/__rs/dispatch/bench.int.spec.ts`: a real payload instance, a
sanitized 88-leaf document with a group, a collapsible, 2 array rows with 2 nested rows each and 2
blocks; `plain` has no field hooks, `hooked` a synchronous hook of every traversal on every leaf;
release `payload-node`, TS and Rust batches alternating, CPU µs per document, machine load 35-43):

| traversal       | TS (plain) | Rust before | Rust now     | TS (hooked) | Rust before | Rust now     |
| --------------- | ---------- | ----------- | ------------ | ----------- | ----------- | ------------ |
| beforeValidate  | 98-143     | 3.12x       | 216 (1.51x)  | 97-189      | 6.39x       | 269 (1.42x)  |
| beforeChange    | 1509-2150  | 1.58x       | 2342 (1.09x) | 1776-2179   | 1.58x       | 2305 (1.06x) |
| afterChange     | 73-114     | 1.80x       | 185 (1.63x)  | 87-163      | 6.43x       | 203 (1.25x)  |
| afterRead       | 81-124     | 0.56x       | 85 (0.69x)   | 98-143      | 0.97x       | 146 (1.02x)  |
| beforeDuplicate | 64-112     | 3.40x       | 162 (1.44x)  | 108-110     | 4.93x       | 155 (1.41x)  |

"before" is the port with one Rust task per field (hooked afterRead leaves already in JS); "now"
runs leaf `promise()` bodies in JS (section 3). beforeChange is dominated by validation
(`deepMergeWithSourceArrays` of the doc per field and the validators), identical work in both.

**Conclusion.** afterRead is at or below TS cost. In the other traversals the remaining overhead
(1.1-1.6x on this document) is in the container fields that are still Rust tasks: each array row,
block, group and collapsible is a spawned `traverseFields` task with its own native promise,
`Promise.all` and resume, plus a descriptor lookup and path strings per traversal.

**Tail awaits and leaf-only traversals** (section 3; same benchmark, release `payload-node`,
2026-11-01, two back-to-back runs at machine load 11-19; RS/TS ratio of the medians, TS µs/doc in
parentheses):

| traversal       | plain: before | plain: now            | hooked: before | hooked: now            |
| --------------- | ------------- | --------------------- | -------------- | ---------------------- |
| beforeValidate  | 1.29          | 1.31 / 1.32 (73 / 88) | 1.37           | 1.30 / 1.34 (88 / 129) |
| beforeChange    | 1.07          | 1.05 / 1.08           | 1.04           | 1.03 / 1.10            |
| afterChange     | 1.35          | 1.19 / 1.46 (86 / 76) | 1.26           | 1.22 / 1.20 (99 / 126) |
| afterRead       | 0.67          | 0.61 / 0.66           | 0.91           | 0.87 / 0.87            |
| beforeDuplicate | 1.33          | 1.16 / 1.32           | 1.30           | 1.30 / 1.11            |

("before" is the previous build measured the same day at load ~5.) Run-to-run noise on this shared
machine is about ±0.15, so only beforeValidate is clearly still above 1.2x for hooked docs. What
remains is the Rust side of the container `promise()`s and of the traversals that contain
containers (in the benchmark document: the root, the two `rows` rows, and the group, collapsible,
`rows`, `nested` and `layout` field promises): every JS-observable read or call of those bodies is
a Node-API crossing (CPU profiles attribute ~25-35 µs per document to the native frames and the
napi trampolines, against ~5 µs for the same work in V8). beforeValidate's container bodies are the
heaviest (sanitization reads, fallback/`isRestoringVersion` checks, hooks/access/`onFieldAccess`
probes before every subfield traversal).

**Phase F (leaves call upstream's own functions).** With the leaf copies replaced by upstream's
`promise()` / `traverseFields` (section 3) and afterRead's hooked leaves calling upstream's
`promise()`, `test/__rs/dispatch/bench.int.spec.ts` with the release build, RS/TS (CPU µs/doc RS
vs TS), at machine load ~44 and then ~12:

| traversal       | plain, load 44     | plain, load 12     | hooked, load 44    | hooked, load 12    |
| --------------- | ------------------ | ------------------ | ------------------ | ------------------ |
| beforeValidate  | 1.33 (167 / 125)   | 1.34 (96 / 72)     | 1.50 (207 / 138)   | 1.33 (125 / 94)    |
| beforeChange    | 1.26 (2478 / 1965) | 1.14 (1294 / 1139) | 1.04 (1930 / 1847) | 1.01 (1450 / 1434) |
| afterChange     | 1.35 (125 / 92)    | 1.29 (96 / 74)     | 1.24 (203 / 164)   | 1.29 (128 / 99)    |
| afterRead       | 0.75 (64 / 86)     | 0.68 (48 / 70)     | 1.19 (162 / 137)   | 1.20 (99 / 83)     |
| beforeDuplicate | 1.43 (106 / 74)    | 1.31 (77 / 59)     | 1.35 (153 / 113)   | 1.27 (97 / 76)     |

The leaves now do exactly upstream's work, so their cost equals TS; what is above 1.0 is the
container part that runs in Rust (Node-API crossings, see above). afterRead's hooked leaves lost
the speed of the previous `hookedLeaf`, which skipped parts of `promise()` (it was a reduced
copy, exact only for the fields the decoded config classified as hooked plain leaves); calling
upstream's `promise()` is exact by construction instead (hooked afterRead went from 0.87 to 1.20).
The numbers carry the ±0.15 noise noted above.

Operations (release build, synthetic suites, summed test durations TS vs RS in separate
processes, two rounds at load ~30 then ~12): read operations 12.5 / 8.3 s and 6.1 / 10.4 s, write
operations 9.1 / 9.3 s and 9.9 / 7.7 s, global/auth operations 20.6 / 18.4 s and 15.5 / 15.0 s.
Process-to-process noise on this shared machine is larger than the TS/RS difference: no
operation family is measurably slower or faster than TS. Debug builds (what the differential
runs use) are 1.5-2.5x slower; the checked-in `payload-engine.node` should be a release build.

Optimization roadmap status:

1. Batch descriptor-driven no-callback subtrees: done as plain-leaf runs, plain array rows and
   inline unnamed containers (above), including select, hidden, `id` and default value handling.
2. Build hook/access/population args through JS helpers everywhere: done.
3. Materialize DB rows straight into JS objects from Rust instead of JSON + `JSON.parse`: not
   done (belongs to the adapter/data path, not to this crate).
4. Internalized keys for engine-side names: done (now created directly, no cache).

## 6. Integration

- `payload-node` exports `coreRuntimeBinding()` (`crates/payload-node/src/runtime.rs`).
  `packages/engine-rs/src/runtime/index.ts` loads it from `PAYLOAD_CORE_RUNTIME_ADDON`, else
  `PAYLOAD_ENGINE_ADDON`, else `packages/engine-rs/payload-engine.node`, and checks its
  `apiVersion` (crates/payload-core-runtime `binding::API_VERSION`, the host-helper contract of
  the runtime and of the field hook crates built into the same addon) at load: an addon built
  from other sources fails there with "rebuild it" instead of at the first missing or changed
  helper. The operation bindings carry their own versions (RUST_OPS_DESIGN.md). It installs the host
  helpers once and exports `afterRead(args)`, a drop-in with the upstream signature. Host
  helpers and the bit layouts they share with the crate (`leaf_flags`, `leaf_run_bits`, the
  `afterReadArgs` indices) are defined next to each other in that file and in `config.rs` /
  `after_read.rs`; changing one side means changing the other.
- **Dispatch (done).** `packages/payload/src/fields/hooks/{afterRead,beforeValidate,beforeChange,
  afterChange,beforeDuplicate}/index.ts` select the engine once at module load:
  `PAYLOAD_CORE_ENGINE=rs|ts` if set, else `PAYLOAD_ENGINE === 'rs'`. Each module also exports
  upstream's function itself as `upstream<Name>` (e.g. `upstreamAfterRead`), whatever the flags:
  unset, the hook export _is_ that function (same body and `name`; only the `export const`
  binding replaces upstream's `export async function`/`export const ... = async` form). Set, it
  is a forwarder to `packages/engine-rs/src/runtime/hooks.ts`, which each module starts loading
  with a dynamic `import()` at module load (payload has no `@payloadcms/engine-rs` dependency; the
  relative specifier is a variable so neither `tsc` nor bundlers follow it). The forwarder calls
  the Rust function directly (no extra tick) and turns a synchronous throw (addon load failure,
  stats file write) into a rejected promise, as calling upstream's async function would; a call
  made before the import settled waits for it and is counted (`deferredCalls`, 0 in every suite
  run).
- **Rich text sub-fields.** payload re-exports the TS `traverseFields` of four traversals
  (`afterReadTraverseFields`, `beforeValidateTraverseFields`, `beforeChangeTraverseFields`,
  `afterChangeTraverseFields`) for editor hooks. `packages/richtext-lexical/src/hooks.ts` selects
  them under the same flags (same dynamic import): set, its block/link sub-field traversals call
  the Rust entries (`hooks.ts` exports, counted in the stats file). The beforeValidate entry
  destructures in Rust; the other three are destructured by their TS drop-in with upstream's
  pattern and defaults and passed positionally (`afterChangeTraverseFields`,
  `beforeChangeTraverseFields`, `afterReadTraverseFields` of the bindings). Arguments the port
  does not model run upstream's own `traverseFields` instead: non-string paths, a non-number
  `fieldDepth`, and for afterRead a falsy `triggerAccessControl`/`triggerHooks` (the engine's own
  traversals always pass `true`). afterRead's is synchronous; before the engine module has loaded,
  lexical's forwarder runs upstream's function (counted as deferred). `packages/payload/src/fields/validations.ts` does the same for the default validators
  (`export let` bindings reassigned to forwarders into `packages/engine-rs/src/validate`).
  `PAYLOAD_RS_CORE_STATS_FILE` makes `hooks.ts` write per-traversal call counts.
- **Query validation (live).** `crates/payload-core-query/src/live` ports `validateQueryPaths`,
  `validateSearchParam`, `validateSortQuery`, `sanitizeJoinQuery`, `getLocalizedPaths`,
  `getFieldByPath`, `combineQueries`, `prefixWherePaths` and `sanitizeWhereQuery` on live JS values
  with the same executor rules. `coreQueryBinding()` (payload-node, or the `query_addon` example)
  must come from the same addon file as `coreRuntimeBinding()` (shared executor and slot table);
  its `init(host)` installs the helpers of `packages/engine-rs/src/query/index.ts` once per process (a
  second `init` replaces them for every user of that addon instance). Destructuring patterns
  (`const { joinPath } = join`, the args of each export) and argument-dependent expressions
  (`getFieldByPath`'s `` `${localizedPath ? `${localizedPath}.` : ''}${segment}` `` in its first
  iteration, `incomingPath.replace(/__/g, '.')` for a non-string path) run as host code, so V8's
  messages and ToString calls happen where upstream's do. The Rust read operations call it
  directly (`getCoreOps()` installs this host first); `test/__rs/core-query/glue.ts` re-exports
  the module for the harnesses, and `test/__rs/core-query/vitest.upstream.config.ts` redirects
  payload's query utilities to it for the upstream suites.
- `engine-rs` imports `relationshipPopulationPromise`, `virtualFieldPopulationPromise` and the
  `afterRead` types from payload sources by relative path, because they are not exported (and
  engine-rs has no installed `payload` link). Exporting them from `payload/internal` would make
  that clean.
- The remaining traversals (`beforeValidate`, `beforeChange`, `afterChange`, `beforeDuplicate`)
  and the operations follow the same rules. Operations are mostly sequential awaits of user hooks
  and DB calls, so the executor model maps directly. DB calls are awaited as the promises the
  `payload-sqlite` binding returns.

### Upstream int suites with the Rust core engine

`node test/__rs/dispatch/runSuites.mjs --all --addon <payload-node.node> --jobs 4` runs every
baseline file that ran sqlite tests (107 files, `storage-*` excluded) with `PAYLOAD_ENGINE=rs`
(Rust SQL engine, Rust traversals, Rust validators) and compares each test's status with
`.rs-baseline/sqlite-all.json` (`--mode core`: Rust traversals and validators on the TS SQL
adapter; `--mode sql`: the SQL engine only). Result (2026-11-01, debug addon, TZ=UTC): every
baseline-passing test passes (3302 passed / 80 failed / 126 skipped vs baseline 3269 / 77 / 162;
the extra passes are the baseline's environmental `select`/`uploads` failures, the 80 failures
are the baseline's own: `plugin-import-export` 71, `plugin-cloud-storage` 3, `kv` 1, and the 5
`cli` ones reran green alone, see below). 68,690 traversal calls were served by Rust, 0 waited for
the dynamic import. `test/cli` failed 5 tests in the parallel run on files another process
deleted (`test/cli/generated`, shared with concurrent runs) and passes 64/64 alone. Core mode on
hooks, fields, localization, versions, validate, relationships, joins and lexical: 996/0/27, equal.

Rerun after the tail-await / leaf-traversal / rich text wiring changes (2026-11-01, debug addon,
`node test/__rs/adapter/runSuites.mjs --jobs 4` over the same 107 files): 3285 passed / 86 failed /
137 skipped vs baseline 3269 / 77 / 162. The only baseline-passing tests that did not pass were
environmental and pass when their file runs alone: `test/cli` (2, shared `generated` folder),
`test/file-versioning` int + rename (9, shared media folders / a 90 s timeout at load ~50), and
`test/create-payload-app` (11 skipped: its package packing step failed with the disk nearly full;
the file makes 0 engine calls). `test/lexical/lexical.int.spec.ts` alone through
`test/__rs/dispatch/runSuites.mjs`: 124/124, with lexical's sub-field traversals served by Rust
(`afterReadTraverseFields` 580, `beforeChangeTraverseFields` 75, `afterChangeTraverseFields` 75
calls, 0 deferred).

### MongoDB

The core engine on `@payloadcms/db-mongodb` (TS mongoose adapter, `PAYLOAD_CORE_ENGINE=rs`) is
verified in RUST_OPS_DESIGN.md section 8: upstream suites (`test/__rs/core-mongo/runSuites.mjs`),
the in-process field hook and query differentials on a Mongo-backed payload
(`test/__rs/core-mongo/runDifferentials.sh`), the operation shadow / trace harnesses with
`RS_CORE_DB=mongodb`, and MongoDB-shaped inputs (`test/__rs/core-mongo/objectid/`). No core-crate
change was needed. Network I/O makes the TS reference nondeterministic wherever upstream runs
database work concurrently, so these harnesses deliver database results in call order
(`RS_ORDERED_IO`, `test/__rs/dispatch/settle.ts`) and wait for in-flight database calls before a
run is snapshotted.

### Differential harnesses: the reference is upstream TS

The four harnesses (`core-runtime`, `core-hooks-{before-validate,before-change,after}`) import the
`upstream<Name>` exports and upstream's `traverseFields` modules, never the dispatching exports,
and `test/__rs/dispatch/engineGuard.ts` checks every run: a TS run must not call the Rust core
engine at all, and a Rust run must. The count is `stats().entries + tasks`, where `entries` is
every Node-API entry into any core crate of the addon (`js::set_env`: every export of the runtime,
field hook, query and operation bindings, every native of the default validators, resume
callbacks and native callbacks; GC finalizers use `set_env_uncounted`, and `stats` itself is
taken back). So a reference run that reaches Rust in any way fails: nested dispatch such as
relationship population reaching a Rust `afterRead`, or the Rust validators payload's
`validations.ts` installs when `PAYLOAD_ENGINE`/`PAYLOAD_CORE_ENGINE` is set (checked:
`PAYLOAD_CORE_ENGINE=rs` on the beforeChange synthetic suite fails with "the TS reference run
called the Rust core engine 4 times"). The `run.sh` scripts unset
`PAYLOAD_ENGINE`/`PAYLOAD_CORE_ENGINE`. Each harness also compares the exported `traverseFields`
(TS vs the Rust entry) on the same inputs. The live query harness refuses to start when a TS
reference function is the Rust port (e.g. under `vitest.upstream.config.ts`).

## 7. Known gaps

- The config is decoded once (per fields array / block / tab object). Mutating field configs
  after the first `afterRead` (adding hooks, flipping `hidden`, changing `name`, adding a
  `defaultValue`) is not seen; upstream would see it. The fast-path plans and the `leafRun`
  key/flag arrays are derived from the same snapshot. Hook arrays, access functions and default
  values _are_ read live when used. Config reads themselves are not replayed one for one (a
  getter on a field config object would see fewer reads).
- (fixed in phase J) row / locale-row / fallback-locale / point checks call the current
  `Array.isArray`; proxies of arrays are iterated through their traps.
- Engine-created errors have Rust-side stacks (class and message identical).
- `for...of` over hook arrays and `fallbackLocale` arrays is done by index with a live length.
  This matches arrays with the default iterator, not a patched `Symbol.iterator`.
- (fixed in phase J) `await` is V8's own Await (see section 2B).
- Promises the engine pushes for fields that complete synchronously come from host
  `async` functions (`fulfilled`/`rejected`); `async_hooks`/`PromiseHook` observers would see a
  different creation context than upstream's `promise()` (same count, same states).
- (fixed in phase J) task fields are pushed with the real `fieldPromises.push`, looked up before
  `promise()` runs like the TS member call. Row iteration still runs natively (a patched
  `Array.prototype.forEach` on real arrays is not called; proxies of arrays go through their
  traps).
- `req.payload.blocks[blockType] ?? ...` returning a falsy non-nullish value is treated as "no
  block". The TS passes that falsy value to `getBlockSelect`.
- `oxlint` flags the relative `packages/*/src` imports in `packages/engine-rs/src/runtime` and
  the harness (`payload/no-relative-monorepo-imports`). They become package imports once
  engine-rs is linked by `pnpm install` and the two population helpers are exported.
- No Rust unit tests inside the crate (behaviour is verified end to end through the binding);
  `rustfmt`/`clippy` are not installed in this environment (no repo rustfmt config either), so
  Rust formatting follows the existing 2-space style by hand.
- Rich text sub-fields: other editors than lexical (and `recursivelyPopulateFieldsForGraphQL` in
  richtext-lexical, outside its hooks) still import payload's TS `*TraverseFields`. The
  afterRead entry does not model `triggerAccessControl`/`triggerHooks = false` and the entries do
  not model non-string paths: those calls run upstream's `traverseFields` (exact, but TS; the
  beforeValidate drop-in now destructures in TS like the others, checked by
  `test/__rs/core-hooks-before-validate/entry.int.spec.ts` with Symbol/number/nullish/object
  paths and a throwing getter). Path strings reach Rust as UTF-8 (a lone surrogate in a parent
  path would not round-trip).
- Live query port: a non-string path that has its own working `split` (getLocalizedPaths /
  getFieldByPath) or `replace` (exported validateSearchParam) raises an engine error after calling
  it, where upstream would continue with the returned value. Without such a method the V8
  TypeError is upstream's.
- Leaf-only traversals iterate the live fields array (`fields.forEach`, like upstream); the
  ported traversals iterate the decoded descriptors (see the first item).
- (fixed in phase J) tail awaits are a real async-function tail (no species reads).
- Nesting depth: nested fields run through `executor::call` (no native recursion). The emulated
  overflow charges 512 bytes per field level (TS: ~690): afterRead nested groups overflow at 1,870
  levels vs TS 1,423 (test/__rs/core-runtime/depth.int.spec.ts). User JS called at depth sees the
  real (shallow) native stack, so a hook recursing near V8's limit at a deep level gets more room
  than in TS.
- The dispatch (payload's hook modules and richtext-lexical's hooks) loads `hooks.ts` with a
  dynamic `import()` of a relative source path: it works where payload runs from source (vitest,
  `pnpm dev`), not from a published `dist` build (engine-rs is private). A call before that import
  settles waits for it (extra microtask ticks; afterRead's synchronous `traverseFields` runs
  upstream's instead); none happened in the suite runs (`deferredCalls` 0).
- Process exit: `Slot`/`Persist` drops during thread-local teardown skip their napi calls
  (`env()` uses `try_with`, the env cleanup hook clears it, slots use `SLOTS.try_with`).
  `test/__rs/dispatch/exitProbe.mts` checks natural exit, `process.exit()` and exit with Rust
  tasks still suspended (all exit 0).
