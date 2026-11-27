# Payload → Rust engine port

Goal: move Payload's engine into Rust while every user-facing TypeScript API
(`buildConfig`, `getPayload`, the Local API, REST, GraphQL, adapters like
`sqliteAdapter(...)`, hooks, access functions, `payload.db.drizzle`) keeps
working exactly as it does upstream.

Upstream base: see `UPSTREAM.md`.

## Status (2026-11-22, linux x64, Node 24.22.2, MongoDB 8.2.11, PostgreSQL 17.11)

**The Rust engine is the default** (`PAYLOAD_ENGINE` unset; `ts` selects upstream). Install the
packages built from this tree in place of upstream's; nothing else changes.

| part                                                        | state                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MongoDB adapter (`@payloadcms/db-mongodb`)                  | every `payload.db.*` method, model building, queries, joins, transforms, versions / drafts, localization, transactions: Rust on the live JS objects (mongoose stays the driver: `payload.db.collections` / `connection` are public API)                                                                                                                                |
| MongoDB driver lane (WP B)                                  | reads outside transactions on a Rust `mongodb` client (`crates/payload-mongo-driver`, `packages/engine-rs/MONGO_DRIVER_CONTRACT.md`): upstream planning and mongoose casting in JS, I/O + BSON decode + read transform in Rust, one `JSON.parse`; mongoose opened next to the Rust client (`PAYLOAD_MONGO_DRIVER=lazy`: on first touch); transactions stay on mongoose |
| SQLite adapter (`@payloadcms/db-sqlite`)                    | Rust SQL engine on Rust libSQL connections                                                                                                                                                                                                                                                                                                                             |
| core (operations, field hooks, validators, query utilities) | Rust for every database, Postgres included (db-postgres itself is upstream TS)                                                                                                                                                                                                                                                                                         |
| Postgres SQL engine                                         | not ported (`RUST_POSTGRES_PLAN.md`)                                                                                                                                                                                                                                                                                                                                   |
| prebuilt addons                                             | linux-x64-gnu built and verified here; CI workflow for the other platforms written, not yet run. A local build links against the build machine's glibc (here 2.44, nix): release addons must come from the workflow (ubuntu-22.04, glibc 2.35)                                                                                                                         |
| stage-1 MongoDB JSON engine                                 | removed (the live engine is the only one); release addon 15.0 -> 13.0 MB; MongoDB suite after the removal: 3330 / 164 / 422, equal to the TS baseline                                                                                                                                                                                                                  |

Verified on this machine (per test, against TS baselines recorded here with `PAYLOAD_ENGINE=ts`):

| check                                                                                      | result                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MongoDB TS baseline (135 files)                                                            | 3330 / 164 / 422 (failures: storage emulators, import-export localstack, next's agent upgrade gate in test/hmr, 2 uploads paste-url network tests)                    |
| MongoDB `PAYLOAD_ENGINE=rs`, committed tree before the default flip                        | every file equal to the baseline except load errors identical to it; cli / schedules-autocron first-run flakes, solo reruns clean                                     |
| MongoDB shadow (serial, 76,806 calls)                                                      | 38 divergences, all the server's `$clusterTime` / `operationTime` copied onto write-conflict errors (normalised now); rerun of those files: **0 divergences**         |
| MongoDB flag unset (default = Rust)                                                        | equal to the baseline (cli first-run flake, solo rerun clean); create-payload-app 11/11 after adding engine-rs to the publish list                                    |
| MongoDB glue self-tests, parity goldens on Rust                                            | 26/26, 503/503                                                                                                                                                        |
| MongoDB `cosmosdb` variant (no join aggregations, no transactions, bigint ids), flag unset | equal to its TS baseline (one race test of plugin-ecommerce on the non-transactional adapter: solo rerun clean)                                                       |
| SQLite flag unset                                                                          | **135/135 files identical** to the TS baseline, 52,668 engine calls                                                                                                   |
| PostgreSQL flag unset (Rust core, upstream adapter)                                        | equal to the TS baseline (one cli test failed in the TS run only; a TS rerun passes it)                                                                               |
| packaging (`test/__rs/packaging/run.mjs`, release addon)                                   | OK: clean install from tarballs, platform package addon, default and `rs` runs equal to `ts` runs for sqlite and mongodb, sqlite-only install loads no MongoDB module |
| Next.js (`nextDev.mjs`, dev and `--prod`, sqlite and mongodb)                              | OK: 0 mismatches, nothing of engine-rs in `.next`                                                                                                                     |
| `default-path/check.mjs --upstream ec35164`, `--self-test`, `switch.int.spec.ts`           | OK, OK, 9/9                                                                                                                                                           |

Performance (test/__rs/perf, full matrix: 4 config shapes x 100 / 1k / 10k posts x 3 databases,
startup with up to 200 collections; geometric mean of TS median / Rust median, > 1 = Rust faster):

| database                    | Local API | REST  | GraphQL | startup (typical / wide-200) |
| --------------------------- | --------- | ----- | ------- | ---------------------------- |
| MongoDB                     | 0.69x     | 0.72x | 0.75x   | 0.93x / 0.86x                |
| SQLite                      | 0.94x     | 1.03x | 0.91x   | 0.93x / 0.80x                |
| PostgreSQL (Rust core only) | 0.87x     | 0.94x | 0.92x   | 0.96x / 0.96x                |

The Rust engine is not faster than upstream yet. MongoDB attribution (typical / 1k, `--engines
ts,rs,db-rs,core-rs`): the live Mongo engine alone 0.75x, the Rust core alone 0.94x. The cost is
per returned document and field, independent of the collection size (`find limit 100`: 4.3 ms TS,
12.2 ms with the Rust Mongo engine, at every size): the live transform crosses Node-API once per
field in both directions (JS `fields.some(native.traverseField)` -> Rust -> JS `get` / `forIn` /
`forOf` helpers -> Rust callbacks), about 40% of the CPU profile. Single-document SQLite operations
are faster (findByID 1.4-1.8x, findGlobal 2.2x); multi-document reads are slower on every database.

Read path, phase K (2026-11-23, release addon, 13th-gen Intel E-cores 16-31 shared with other
jobs; 1000 posts, shapes typical / complex / hooks, categories read / locale / versions / globals,
TS and Rust cells of the same run; geometric means of TS median / Rust median):

| database                                         | read before | read after | globals | locale | versions |
| ------------------------------------------------ | ----------- | ---------- | ------- | ------ | -------- |
| PostgreSQL (Rust core, upstream db-postgres)     | 0.76x       | 0.98x      | 0.96x   | 0.97x  | 0.95x    |
| MongoDB, Rust core on the TS adapter (`core-rs`) | 0.94x (doc) | 0.99x      | 0.91x   | 0.99x  | 0.95x    |
| MongoDB, default (Rust adapter + Rust core)      | 0.46x       | 0.52x      | 0.81x   | 0.55x  | 0.67x    |

Multi-document reads are now faster than TS (PostgreSQL typical `find limit 100` 1.13x, `limit 200`
1.15x, hooks shape 1.08x, REST / GraphQL lists 1.05-1.10x; MongoDB `core-rs` `find limit 100`
1.25x); single-document operations are 0.84-1.01x (per-operation Node-API overhead of the ported
operation and query-validation code, ~25-70 µs). What changed: afterRead runs from Rust-decoded
plans in the host (RUST_CORE_DESIGN.md "afterRead: plan traversal"), the per-document arrows of the
read operations run in the host (RUST_OPS_DESIGN.md section 2), cheaper string slots, and a V8
artifact that had made db-postgres's own `payload.db.find` 25% slower in Rust-engine processes
(the `{ id }` literal shape of drizzle's documents falling out of the transition tree, see
`reservedLiteralShapes` in packages/engine-rs/src/runtime/index.ts). The database layer bounds what
the core can gain: TS `payload.db.find` of 100 typical posts is ~6.0 ms of a ~9.2 ms `payload.find`
on PostgreSQL, so even a zero-cost core would be ~1.5x there.

Write path (2026-11-23; write categories, typical / complex / hooks at 1k posts, TS median / Rust
median, geometric means, before -> after the validation merge elision and the JS field
traversals of RUST_CORE_DESIGN.md section 3): PostgreSQL 0.89x -> 0.93x (validation 0.63x ->
0.97x, create 0.89x -> 0.95x, update 0.89x -> 0.95x), MongoDB 0.72x -> 0.75x (validation 0.67x ->
0.94x; the Rust core alone on the TS adapter, `--engines ts,core-rs`: 0.98x). The core is about
10-15% of a write's CPU time in TS; the rest is the database adapter and I/O, which bounds what
any core change can gain end to end.

Optimization round 1 (2026-11-23: Mongo transform fast path, afterRead plans, write-path merge
elision and JS traversals; see the read / write path paragraphs above) merged and verified on all
three databases: MongoDB suite 3330 / 164 / 422 (= baseline), SQLite 134/135 identical (the other
file: create-payload-app failed -> passed), PostgreSQL = baseline, shadow 0 divergences over 22,508
calls, packaging OK. Open: the MongoDB parity goldens' bulk-update trace steps fail in about 2 of 3
runs (interleaving of upstream's concurrent per-document work; to be settled against TS runs).
Next: RUST_PERF_PLAN.md (fused lanes, Rust drivers, compiled functions) with the owner decisions in
its section 0.

MongoDB driver lane (WP B, 2026-11-23; `packages/engine-rs/MONGO_DRIVER_CONTRACT.md`): reads
outside transactions run on a Rust `mongodb` client and mongoose is lazy. MongoDB, typical /
complex / hooks at 1k posts, TS and Rust cells of the same run, TS median / Rust median, geometric
means before (round 1) -> after: all 0.93x -> 1.21x (`--reuse` rerun 1.15x), read 0.95x -> 1.37x,
globals 0.84x -> 1.22x, versions 0.86x -> 1.30x, create / update / partial-update / delete
unchanged (0.94x / 0.94x / 0.97x / 0.89x: writes run in mongoose transactions; the Rust core on
the TS adapter, `core-rs`, is 1.05x / 1.04x / 1.02x / 0.99x there). Typical: find limit 100 1.41x ->
1.91x (2.44 ms), find limit 10 0.98x -> 1.68x, findByID depth 0 0.82x -> 2.90x (0.134 ms), count
0.68x -> 1.41x, `GET /posts/:id` 0.78x -> 1.55x; hooks shape multi-document reads 1.23x -> 1.53-1.74x.
`getPayload` (typical) 55.5 -> 41.0 ms (mongoose not connected at startup). Verified: MongoDB suite
equal to the baseline (130/135 files clean; the others: cli's test title embeds the checkout path,
hmr, storage / import-export emulators), shadow over fields / relationships / localization /
versions / joins / hooks / auth 21,756 calls 0 divergences (the lane reports its driver operations
to the shadow trace), cosmosdb variant over fields / relationships / joins / versions equal to TS,
glue self-tests 33/33, parity goldens 503/503 in 3 of 3 runs (TS: 2 of 3, the bulk-update steps).

Optimization round 2 (2026-11-23), merged and verified together: WP-B's driver lane (mongoose
now opens at `connect` next to the Rust client by default; lazy mongoose is opt-in with
`PAYLOAD_MONGO_DRIVER=lazy`, because `connection.db`, `getClient()` and `readyState` are missing
until mongoose has opened), WP-C's HTTP lanes (`RUST_HTTP_LANES.md`: GraphQL handler built once per
schema, cached parse / specified-rule validation, synchronous HS256 check for Payload-issued
tokens with jose as the authority, cached endpoint path matchers; shared code, so TS gains as
much as Rust), WP-D's function compiler (`packages/engine-rs/FN_COMPILE_CONTRACT.md`; every user
function is called through `callUserFunction`, gets `skipCompilation` as its opt-out; compiled
functions are only verified so far, used once the fused lanes land), WP-E's lazy imports of
modules a production start does not use and SQLite results as JSON with patches, and the perf
suite's throughput scenarios. Verification on the merged tree: MongoDB suite 3330 / 164 / 422 (=
baseline), SQLite 134/135 identical, PostgreSQL 131/135 clean (= baseline), shadow 8/8 files
22,519 calls 0 divergences (after fixing the driver lane's transaction check, which had delayed
`queryDrafts`' synchronous sort mutation by a tick), parity goldens 503/503 in 3 of 3 runs, glue
33/33, driver lane 4/4, HTTP lanes 11/11, fn-compile corpus and call sites 39/39, packaging and
default-path check OK. Perf (`.rs-runs/perf/round2`, typical / complex / hooks at 1k posts, every
surface; TS median / Rust median, geometric means): MongoDB 1.11x (throughput 2.23x), SQLite
1.10x (REST 1.22x, globals 1.53x, multi-document reads 0.96x), PostgreSQL 1.04x. Against the TS
engine of pass 1 (before the shared HTTP gains): MongoDB GraphQL 1.52x, REST 1.21x, SQLite REST
1.40x.

Optimization round 3 (2026-11-24), WP-A's fused read lanes for SQLite
(`packages/engine-rs/FUSE_CONTRACT.md`, crates `payload-fuse` / `payload-fuse-sqlite`): `find`,
`findByID` and `count` of a collection whose read path holds no user JS run as one native call
whose result text is parsed once (`fusedOperationText`), with statement templates and a direct
request decoder; anything ineligible stays on the exact lane, `PAYLOAD_RS_FUSE=shadow` compares
every fused call with it. Perf (SQLite, typical at 1k posts): Local 3.10x geomean, `findByID` 9.7x,
`find` where-equals 10.1x, `find` limit 10 6.2x, limit 100 3.2x, REST 1.40x, GraphQL 1.29x;
complex / hooks shapes stay about 1.0x (mostly ineligible: population, user hooks). Verification
on the merged tree: MongoDB 3330 / 164 / 422 (= baseline), SQLite 134/135 identical with the fused
lanes on and under `--fuse shadow` (2,195 fused hits, 0 lane differences), PostgreSQL 131/135 (=
baseline), shadow 8/8 files 22,519 calls 0 divergences, parity goldens 503/503 in 7 of 8 runs (the
known `update many over several docs` ordering race: upstream processes the documents with
`Promise.all`, TS flakes on it too), glue 33/33, driver lane 4/4, HTTP lanes 11/11, fn-compile 39/39,
packaging and default-path check OK. The fused lanes made the core read operations import
`native.ts`, which set the engine-loaded marker db-sqlite's `connect` reads; the marker now lives in
the sqlite adapter module (`switch.int.spec.ts` 9/9). Next: the fused lanes on MongoDB (over
`payload-mongo-driver`), fused population, Mongo write overhead.

Optimization round 4 (2026-11-24/25, MongoDB focus), all merged and verified together.

What was merged:

- **Fused MongoDB reads** (WP-A, `crates/payload-fuse-mongo`, FUSE_CONTRACT.md §8-9):
  - `find` / `findByID` / `count` as one native call on the Rust driver, with no mongoose query.
  - Population that reproduces upstream's dataloader.
  - Compiled read access and field read access that reads only `req` (WP-C).
  - Raw json / rich text subtrees converted in parallel on the driver's threads.
- **Write path on the mongoose-backed lane** (WP-G):
  - In-transaction reads stay on the driver lane.
  - Collection writes use upstream's db-mongodb methods.
  - The max-versions check is skipped after a create with a generated id.
  - A registry of Payload's own field functions.
- **Fused MongoDB writes, on by default** (WP-G executor, WP-I write-side library, WP-H / WP-J / WP-K drivers; FUSED_WRITES.md):
  - create, updateByID, deleteByID, update-many and delete-many run in Rust: beforeValidate, validation, beforeChange, the db-mongodb transform, mongoose casting, the version write.
  - They run inside a Rust-owned transaction (D4), and the result goes through the fused read.
  - A write lane-shadow replays clock and ObjectId readings and compares raw BSON, results, errors and the caller's data.
  - GraphQL writes reach the lane (WP-C).
- **Exact-lane afterRead plan kinds** for localized fields, tabs, blocks and localized containers (WP-C).
- **Auth compile guards:** they no longer snapshot arguments past a compiled function's parameters (WP-A). Auth went from 0.68x to 1.06x.
- **Fixes:**
  - The JWT verify cache.
  - The engine-loaded marker moved to the sqlite adapter module.
  - The perf runner's `--fuse` option.
- **Parity spec:** its concurrent bulk-update steps now require the golden's entries in any order (owner decision, RUST_PERF_PLAN.md §0).

Perf, MongoDB typical shape at 1k posts, Local API, ts / rs medians, fused writes off -> on:

| write          | off   | on    |
| -------------- | ----- | ----- |
| create         | 1.14x | 1.70x |
| update         | 0.98x | 2.00x |
| partial update | 0.97x | 2.24x |
| delete         | 0.97x | 1.66x |
| update many    | 0.99x | 2.33x |
| delete many    | 1.00x | 1.50x |

- GraphQL writes: 1.5-1.9x.
- Complex reads: `find` limit 10 1.84x, limit 200 2.56x.
- Reads: complex `findByID` 4.6x, typical depth 1 2.4x.
- Overall MongoDB geomeans before fused writes (WP-A): Local 1.21x, REST 1.21x, GraphQL 1.18x.
- The full pass on this tree is in `.rs-runs/perf/round9`.

Verification on the merged tree (round 9):

| check                                                 | result                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| MongoDB                                               | 3330 / 164 / 422, = baseline (6,715 fused read hits); the same with read and write lane-shadow, 0 differences |
| SQLite                                                | 134/135 identical, with the fused lanes and under `--fuse shadow`                                             |
| PostgreSQL                                            | 131/135, = baseline                                                                                           |
| shadow                                                | 8/8 files, 22,511 calls, 0 divergences                                                                        |
| parity                                                | 503/503 in 3 of 3 runs                                                                                        |
| fused-write corpus                                    | 12/12                                                                                                         |
| fused lane suites                                     | 41/41                                                                                                         |
| glue / driver lane / HTTP lanes / fn-compile / switch | 33/33, 4/4, 18/18, 39/39, 9/9                                                                                 |
| packaging and default-path check                      | OK                                                                                                            |

Round 4, continued (2026-11-26), verified as round 10:

- **Drafts (WP-L):** fused writes cover drafts for published creates, `draft: true` creates and updates, publishing over a latest draft, a per-locale `_status`, and deletes.
- **Per-document field access (WP-M):** compiled field read access that reads the document runs per document inside the fused afterRead, with upstream's tick order. This clears the REST depth-2 write guard on `users.sessions`.
- **Verification:** MongoDB = baseline, with and without both lane-shadows. SQLite and PostgreSQL = baselines. Shadow and parity 3/3 clean. Corpus 14/14, lane suites 64/64. The only failures were load flakes that pass on rerun: a cloud-storage timeout, plugin-ecommerce's 500 ms settlement, and auth's 1 s `waitFor` under serial shadow.

Not built (owner decision D10): auxiliary MongoDB indexes (`AUX_INDEXES_PROPOSAL.md`).

Still ineligible for fused writes:

- drafts and autosave;
- REST writes at the default depth 2 (document-reading field access on `users.sessions`);
- user hooks (the hooks shape);
- uploads, json fields, timezone dates.

WP-N (2026-11-26), the slowest MongoDB scenarios of round 9:

- **Causes found.**
  - payload's JS `executeAccess` was the Rust port. For its JS callers (entity permissions,
    llm instructions) the crossings and engine task cost far more than the TS function: auth
    (JWT) and `GET /access`.
  - The compile guard decided sampling with two addon calls per guarded call.
  - Every Rust-to-JS call of the engine's own helpers, and every await of the executor, went
    through the guard trampoline (an argument array built through Node-API, a JS frame, a WeakMap
    lookup).
  - The global, jobs and upsert writes and `findDistinct` ran on their live ports.
  - In a transaction, `findGlobal` and the counts fell back to their live ports (the session was
    in the cast query's options): every global update read the current global through the live
    `findGlobal`.
- **Fixed.**
  - JS `executeAccess` is upstream's.
  - The guard's sampling policy runs in JS.
  - `js::call_unguarded` is used for the engine's helpers; user functions and adapter methods
    still go through the guard.
  - `upstreamMethods` (was `upstreamWriteMethods`) adds those writes and `findDistinct`; the glue
    spec asserts it.
  - The lane takes the session for those reads like it does for `findOne` / `find`.
- **Measured, not kept.**
  - Upstream's `getBuildQueryPlugin` for the `Model.buildQuery` statics: neutral.
  - Upstream's TS operations for the ineligible (exact-lane) writes: neutral.
  - TS traversals under the Rust operations: neutral.
  - The exact lane's remaining cost is spread thin; no single part of it dominates.
- **Perf**: MongoDB, 1k posts, `ts / rs` medians of 3 processes per engine, interleaved (5 for
  hooks), round 9 tree -> this tree:
  - typical:
    - auth (JWT) 0.80 -> 1.06, `GET /access` 0.86 -> 1.15;
    - updateGlobal 0.91 -> 0.98, `POST /globals/settings` 0.88 -> 0.98, `updateSetting` 0.91 -> 0.99;
    - jobs queue 0.90 -> 0.96, findDistinct 0.90 -> 0.92, duplicate 1.00 -> 1.03;
    - delete by id 1.76 -> 2.05, `DELETE /posts/:id` 1.67.
  - complex:
    - auth 0.76 -> 1.24, `/access` 1.00 -> 1.25;
    - delete 0.90 -> 1.01, `DELETE` 0.90 -> 1.00;
    - updateGlobal 0.97 -> 1.09, `POST /globals` 0.93 -> 1.09, `updateSetting` 0.94 -> 1.13;
    - partial updates 1.00-1.11 -> 1.09-1.19, logout 0.89 -> 1.09, duplicate 1.03 -> 1.10;
    - countVersions 1.48, findByID draft 1.48, findByID depth 2 1.18.
  - hooks:
    - auth 0.83 -> 1.19;
    - writes 0.91-0.98 -> 0.97-1.00.
- **Still below TS.**
  - `find where and/or + relationship path`: typical 0.85, hooks 0.81. The fused read lane
    guards `mongo:where:relationship-path` (a Rust sub-query would be needed).
  - typical logout 0.88, findDistinct 0.92-0.95 (upstream's method, the Rust core operation
    around it).

WP-Q (2026-11-26), the read scenarios WP-N left below TS:

- **Relationship paths on the fused MongoDB read lane.**
  - Upstream's `buildSearchParam` resolves a one-hop relationship path with a sub-query:
    `SubModel.find(SubModel.buildQuery(...)).lean().select({ _id: true })`, then `$in` of the
    ids. It uses no lookup.
  - The fused encoder now re-states that branch. The reads carry the cast sub-queries and the
    path of the `$in` array each one fills. The native call runs them one after the other, before
    the count and the find, as upstream does.
  - Covered: hasMany, paths in groups and arrays, `and` / `or`, several operators on one path.
  - Still on the exact lane: two or more hops, joins, related collections with custom ids, and
    the fused writes' own reads. Polymorphic relationships have no hop (`related.value`) and stay
    behind the `where` guard.
  - Shadow mode traces the Node driver calls too, so the exact lane's sub-queries are compared.
  - The fused lane's array casts read mongoose 9's `embeddedSchemaType`. `caster` no longer
    exists, so every hasMany cast had been refused as `mongo:error`.
- **findDistinct on the driver lane.** Upstream's statements, with its two `Model.aggregate`
  calls on the Rust client (`mongoDriverAggregateRaw`, driver API 2). The documents are decoded
  by the driver's js-bson.
- **Harness counters**, `--fuse shadow --fuse-writes shadow`:
  - `mongo:where:relationship-path` 24 -> 0 (1 `...:custom-id`);
  - `mongo:error` 19 -> 0;
  - fused read hits 7,768 -> 7,809;
  - 0 lane-shadow differences.
- **Perf**: MongoDB, 1k posts, `ts / rs`, rust-engine-port HEAD -> this tree. Medians of 3
  interleaved processes (5 for hooks).
  - `find where and/or + relationship path`: typical 0.86 -> 1.37, complex 0.91 -> 1.34, hooks
    0.89 -> 0.87. The hooks shape has collection hooks, so it is not fused-eligible.
  - `findDistinct`: typical 0.97 -> 1.18, complex 0.96 -> 1.45, hooks 0.96 -> 1.17.
  - logout and jobs queue (5 rounds): typical 0.96 -> 1.00 and 0.98 -> 0.98, complex 0.95 ->
    0.97 and 1.17 -> 0.98, hooks 0.93 -> 0.95 and 0.93 -> 0.93, all within noise.
    `jobs.queue` is one upstream `payload.db.create` plus `jobAfterRead`, and no single part of
    either profile stands out.
- **Verification:**
  - MongoDB `--engine default` = baseline. Two 90 s timeouts under machine load (cli
    `migrate:reset --help`, file-versioning PDFs and videos) passed when rerun alone.
  - The same run with read and write lane-shadow: 3330 / 164 / 422, 0 differences.
  - Shadow 8/8 files, 0 divergences. Parity 503/503 in 3 of 3 runs.
  - SQLite `--fuse shadow` = baseline, 0 lane differences.
  - Glue / driver lane / HTTP lanes / fn-compile / switch: 33/33, 4/4, 18/18, 39/39, 9/9.
  - Corpus 21/21; lane suites 75/75 with and without `--fuse shadow`.
  - Packaging and the default-path check: OK.

WP-Y (2026-11-27), JS-thread time per request under concurrent load (MongoDB throughput
scenarios):

- **Causes found** (`--cpu-prof`-style inspector profiles of the timed window, x64):
  - Fused create: the Rust prepare (`fuseWritePrepare`) ran on the JS thread and decoded the
    whole write plan from JSON per call: about 0.9 of 1.3 ms.
  - Compiled functions on lanes (`evaluateOnLane`) crossed their argument snapshot object by
    object through Node-API: 20-60 µs per call. Every collection access is a `withBaseAccess`
    wrapper whose spread makes the snapshot copy the whole argument (a create's `data`, the
    request's user).
  - Guard sampling: each compiled function of an operation sampled on its own lane counter, so
    REST writes (about a dozen compiled access functions) ran about 5% of their operations on the
    exact lane, and the call-site guard did not even verify the call the lane left to it.
  - Fused writes built their result read twice (guards, then run); fused Mongo calls decoded
    their BSON requests on the JS thread.
- **Fixed**:
  - Creates run `prepare_create` in the driver, inside the fused write (the plan registered once).
  - `fnIrEvaluateText`: the snapshot as one typed JSON text, read by a one-pass parser
    (`lanes::from_typed_text`, tested equal to `from_typed`).
  - payload's `withBaseAccess` registers its wrappers (internal `WeakMap` on `globalThis`); lanes
    evaluate the wrapped access function on `{ ...args, slug }` when there is no `baseAccess`,
    for wrappers verified on their first calls.
  - Lane samples mark the function due and the call-site guard verifies that call
    (`fnIrTakeVerify`); functions halfway due are verified on any JS call, so one operation's
    functions are sampled together (each still verified at least once per 256 lane calls).
  - The guards' result read is reused (by id; creates take the ObjectId in the guards outside the
    shadow); requests are decoded on the driver runtime.
- **Perf** (`--surfaces throughput`, 1k posts, 3 interleaved rounds, Rust req/s / TS req/s,
  cores 22-31; tput-writes report -> this tree; JS-thread ms per request rs at x64):

| scenario                 | typical x8   | typical x64  | complex x64 | rs JS ms x64 (typical) |
| ------------------------ | ------------ | ------------ | ----------- | ---------------------- |
| findByID                 | 6.27 -> 7.25 | 6.66 -> 6.83 | 6.84        | 0.079 -> 0.057         |
| find limit 10            | 6.61 -> 6.28 | 5.89 -> 6.23 | 5.54        | 0.175 -> 0.131         |
| REST GET /posts limit 10 | 4.52 -> 6.01 | 3.86 -> 5.65 | 5.89        | 0.617 -> 0.379         |
| create (Local)           | 3.86 -> 8.84 | 2.92 -> 9.69 | 10.03       | 1.629 -> 0.366         |
| update scalar field      | 5.21 -> 6.71 | 7.06 -> 7.41 | 5.46        | 0.452 -> 0.278         |
| REST POST /posts         | 2.14 -> 5.85 | 2.15 -> 5.73 | 6.21        | 2.833 -> 0.882         |
| REST PATCH /posts/:id    | 3.70 -> 5.61 | 4.71 -> 6.91 | 6.03        | 1.541 -> 0.869         |

Typical geomean 6.70x [6.60-6.79]; cores 24-29 give the same picture (5.4-8.9x).

- **Not JS-bound any more**: find, findByID and update run below an event-loop utilization of 1;
  the driver runtime's 2 worker threads (`PAYLOAD_MONGO_DRIVER_THREADS`) are saturated. With 4
  threads (same tree, one process, x64): find limit 10 4,701 -> 8,463 req/s, update 1,581 ->
  2,834, findByID 16,393 -> 20,180, create 2,323 -> 3,025 (about 11x, 14x, 9x and 12x TS).
- Single-request latency (local / rest / graphql surfaces, this tree vs the base app, rs, 2
  alternating rounds): typical 1.08x / 1.09x / 1.31x, complex 1.13x / 1.10x / 1.13x faster;
  scenarios slower in both rounds were within noise in 4-6-round reruns.
- **Verification**:
  - MongoDB `--engine default` = baseline (3330 / 164 / 422; cli path, emulators, hmr), 8,701
    fused read hits.
  - The same with `--fuse shadow --fuse-writes shadow`: one write lane-shadow record (the exact
    lane's transaction aborted by the server during collections-rest's load-time hook
    timeouts); collections-rest alone: clean, 0 differences. auth's locking tests and
    create-payload-app timed out under load and passed solo.
  - Shadow 8/8 files, 22,527 calls, 0 divergences. Parity 503/503 in 3 of 3 runs.
  - Glue / driver lane / HTTP lanes / fn-compile / switch: 33/33, 4/4, 18/18, 39/39, 9/9.
  - Corpus 37/37; lane suites 101/101 with and without `--fuse shadow --fuse-writes shadow`.
  - SQLite `--fuse shadow`: 134/135 identical, 0 lane differences (create-payload-app: failed ->
    passed, as before). PostgreSQL 131/135 (= baseline). Packaging and default-path check: OK.

Remaining: making the engine faster than upstream (above); Postgres SQL engine; prebuilt addons for
the other platforms (needs the CI workflow to run); the upstream JS helpers the Rust core still
calls (`RUST_OPS_DESIGN.md` section 7).

## Layout

```
Cargo.toml                 cargo workspace
crates/payload-engine      pure Rust engine (no Node dependency)
crates/payload-node        napi-rs bindings (cdylib → .node addon)
packages/engine-rs         TS glue: loads the addon, serializes the sanitized
                           config, JS function registry for callbacks
test/__rs                  port-specific verification suites
```

The TypeScript packages keep their public surface and delegate internals to
the addon. `PAYLOAD_ENGINE` selects the implementation while porting:

| value    | behaviour                                                       |
| -------- | --------------------------------------------------------------- |
| `ts`     | upstream TypeScript implementation (the reference)              |
| `rs`     | Rust implementation (the default: also selected when unset)     |
| `shadow` | run both, return TS result, record every divergence (diff mode) |

## Porting order

1. **SQL database engine** (`@payloadcms/drizzle` + `@payloadcms/db-sqlite`):
   raw schema building, where → SQL, read/write transforms, upsert, all
   adapter operations. Pure data in / data out, so it is verified with:
   - `test/__rs/schema.int.spec.ts`: Rust raw schema deep-equals the TS raw
     schema for every test config in `test/*/config.ts`.
   - `shadow` mode: every `payload.db.*` call in the whole int suite is run
     against both engines (separate database files) and results are diffed.
   - the upstream int suite run with `PAYLOAD_ENGINE=rs`.
2. **Query/field utilities** (sanitize/validate where, select, sort, default
   validators, field paths).
3. **Field traversals and operations** (beforeValidate/beforeChange/
   afterChange/afterRead, collection/global operations) calling back into JS
   for hooks and access functions.

## Integration contract (binding for all modules)

- **No in-band markers.** Internal values (raw SQL, raw constraints, distinct
  symbol, `$inc` expressions) are typed Rust values (enum variants), never
  JSON objects or magic strings that user data could forge. JSON encodings
  with `$`-keys exist only at the TS↔Rust serialization boundary
  (`serializeForEngine` format: `$fn`, `$ref`, `$undefined`, `$num`, `$obj`
  escape), and are decoded into typed values immediately.
- **One Rust type per shape.** `RowToInsert` lives in `payload-sql-write` and
  is consumed directly by `payload-sql-upsert`; the find crate's
  `QueryBuilder` is implemented on top of `payload-sql-query`; read/find/upsert
  share `RawSchema` from `payload-engine`. No module re-defines another's type.
- **One decoded config graph per adapter instance.** The engine decodes the
  serialized config once at init and keeps it (and the `RawSchema` built from
  it) alive for the adapter's lifetime; identity-keyed side tables
  (`block_table_name_index`) are only valid against that graph. Never
  re-decode the config per call.
- **One connection model.** All engine SQL runs on `payload-sqlite` worker
  connections (by `ConnId`), the same connections that back the TS
  `createClient` used by `payload.db.drizzle`, so ordering and transactions are
  shared. Calls must preserve libsql's observable ordering, including across
  a client connection and its transaction connections.
- **Process TZ.** Date handling must match V8 in the process time zone; tests
  record and set `TZ` explicitly.

## Verification

Upstream int tests are assertion based: they check selected properties, not
full outputs, so they cannot prove a 1:1 port alone. The port therefore adds
differential checks (exact deep equality against the TS reference) on top of
the upstream suite. Baseline results for the TS engine live in
`.rs-baseline/` (generated, git-ignored).

Run (Node 24, see `.nvmrc`):

Build requirements: Rust, cmake, libclang (`LIBCLANG_PATH`); MongoDB 8.2 replica set `rs0` on
:27018 (test/__rs/README-mongo.md), PostgreSQL 17 + PostGIS + pgvector on :5433
(test/__rs/pg-harness/README.md).

```sh
pnpm --filter @payloadcms/engine-rs build:native   # build the addon (debug; build:native:release)
pnpm build:core
pnpm test:int:sqlite <suite>                       # the default: Rust
PAYLOAD_ENGINE=ts pnpm test:int:sqlite <suite>     # upstream TS
PAYLOAD_ENGINE=shadow pnpm test:int:sqlite <suite>
# whole suite against a TS baseline (per test)
node test/__rs/mongo-harness/runSuites.mjs --engine ts --write-baseline .rs-baseline/mongodb-all.json
node test/__rs/mongo-harness/runSuites.mjs --engine default --rerun-failed --baseline .rs-baseline/mongodb-all.json
node test/__rs/mongo-harness/runSuites.mjs --shadow --candidate rs --baseline .rs-baseline/mongodb-all.json
```

## SQLite build: the `libsqlite3-sys` patch

Every SQLite connection of the port (`crates/payload-sqlite` and the engine crates'
`rusqlite` code, which run on the same handles) must behave like the reference runtime,
`@libsql/client@0.14.0` -> `libsql@0.4.7` -> libsql rev `20147731` (feature `encryption`), i.e.
the libSQL 3.45.1 amalgamation compiled through SQLite3 Multiple Ciphers 1.8.1. The root
`Cargo.toml` therefore has

```toml
[patch.crates-io]
libsqlite3-sys = { path = "crates/payload-sqlite/libsqlite3-sys" }
```

`crates/payload-sqlite/libsqlite3-sys` is a stand-in that keeps libsqlite3-sys 0.35's API
(`src/error.rs` copied verbatim, `SQLITE_STATIC` / `SQLITE_TRANSIENT`, two redeclared
auto-extension functions) on top of `libsql-ffi = "=0.4.1"` with `multiple-ciphers`, which
builds exactly that amalgamation.

What this means for maintenance:

- **It applies to the whole workspace, silently.** Every `rusqlite = { features = ["bundled"] }`
  (payload-sqlite, payload-sql-find, payload-sql-query, payload-sql-upsert) links libsql-ffi, not
  the SQLite that `bundled` normally builds. A new crate that depends on `rusqlite` or
  `libsqlite3-sys` gets it too. Do not add another SQLite (a second `links = "sqlite3"` crate
  fails to resolve).
- **Build requirements.** Every build, including the napi release builds for every target
  platform, needs `cmake` and libclang (bindgen 0.66, run by libsql-ffi's build script), plus a
  crates.io download of libsql-ffi 0.4.1 and bindgen. So far it has only been built and tested
  on macOS (arm64). Linux and Windows release targets, cross-compilation and CI images must be
  verified before shipping the addon.
- **Pinned versions.** The shim claims version `0.35.0` and mirrors 0.35's feature list with
  no-op features, because `rusqlite` 0.37 requires exactly that. Upgrading `rusqlite` (which
  moves to another libsqlite3-sys) will fail resolution or bind against mismatched declarations
  until the shim is updated: bump its version, re-copy `error.rs` from the new libsqlite3-sys,
  and add any API the new rusqlite uses. Changing the reference (`@libsql/client` / `libsql`
  version) means moving `libsql-ffi` to the version that libsql revision uses, and checking its
  cmake options against the reference build.
- **Verification after any change.** `cargo test -p payload-sqlite` (includes a test that the
  reference build is linked: `sqlite_version()`, the libSQL source id and
  `sqlite3mc_version()`), and the differential suite against `@libsql/client`
  (`test/__rs/sqlite/client.int.spec.ts`: compile options, function and module lists, extension
  functions, encryption). `PRAGMA compile_options` differs from the reference only in its
  `COMPILER=` entry.

## Packaging

The Rust engine is the default. A Payload project gets it by installing these packages instead of
upstream's (same names, versions and public TS API); nothing else changes.

### Engine selection

`packages/payload/src/utilities/engineSelection.ts` (exported from `payload/internal`) is the one
rule every dispatch site uses (payload's operations / field hooks / validators, richtext-lexical's
hooks, db-sqlite, db-mongodb; `withPayload` inlines the same rule):

| `PAYLOAD_ENGINE` | database adapters (sqlite, mongodb) | core (operations, hooks, validators) |
| ---------------- | ----------------------------------- | ------------------------------------ |
| unset (default)  | Rust                                | Rust                                 |
| `rs`             | Rust                                | Rust                                 |
| `ts`             | upstream TS                         | upstream TS                          |
| `shadow`         | sqlite differential mode            | upstream TS                          |

`PAYLOAD_CORE_ENGINE=rs|ts` overrides the core's selection (`PAYLOAD_OPS_GLOBAL_ENGINE` the global /
auth operations'). Outside Node.js (the browser bundle of `fields/validations.ts`, edge runtimes) the
default is `ts`: there is no addon to load. db-postgres has no Rust SQL engine yet: with the default it
runs upstream's adapter under the Rust core.

Every harness reference in `test/__rs` sets `PAYLOAD_ENGINE=ts` explicitly (unset is Rust); the
differential specs that build their reference through the public factories fail unless it is set
(`test/__rs/requireTsEngine.ts`). The runners take `--engine ts|rs|default` (`default`: the flag
unset, checked like `rs`).

### How engine-rs is loaded

- `@payloadcms/engine-rs` is a regular dependency of payload, db-sqlite, db-mongodb and
  richtext-lexical (`test/__rs/default-path/check.mjs` requires exactly that set, and that no package
  has it as a peer / optional / dev dependency).
- No package imports it statically: every dispatch site loads it, when the selection is Rust, by a
  runtime `import()` of a computed specifier carrying `/* @vite-ignore */ /* webpackIgnore: true */`,
  so bundlers neither trace nor bundle it or its addon, and `PAYLOAD_ENGINE=ts` evaluates nothing of
  it. Resolution is package-local (`createRequire(<package.json>).resolve(...)`): from where the
  dispatching package is installed, located from `import.meta.url` only when the nearest package.json
  above it is that package's, otherwise in `node_modules` from the working directory up (bundled
  Next.js chunks).
- The addon is located and loaded in exactly one place, `packages/engine-rs/addon.cjs` (plain
  CommonJS, the same file from src, dist and payload's synchronous `require` in
  `fields/validations.ts` through `@payloadcms/engine-rs/addon`), so a process has one addon instance:
  1. `PAYLOAD_ENGINE_ADDON` (a path, relative to the working directory); core bindings honour
     `PAYLOAD_CORE_RUNTIME_ADDON` first (standalone crate builds, mutants);
  2. `payload-engine.node` next to `addon.cjs` (a local `build:native`);
  3. `@payloadcms/engine-rs-<platform>` (napi-rs suffixes: `linux-x64-gnu`, `linux-arm64-gnu`,
     `linux-x64-musl`, `linux-arm64-musl`, `darwin-arm64`, `darwin-x64`, `win32-x64-msvc`), an
     optional dependency of the published engine-rs selected by npm's `os` / `cpu` / `libc`.
     An unsupported platform throws at the first Rust call with the platform package name and the
     `PAYLOAD_ENGINE=ts` escape hatch.
- `config.db.init` is synchronous and the engine module asynchronous: once the module has loaded,
  the adapter object's `init` is exactly `withRustEngine(obj).init` / `withRustMongoEngine(obj).init`;
  before that, the built adapter's `init` installs the engine when payload awaits it (before
  `connect` and any data method); a consumer wrapper of `init` is kept
  (`test/__rs/default-path/switch.int.spec.ts`).
- `withPayload` (packages/next) keeps the server-only Payload packages external in production too
  unless `PAYLOAD_ENGINE=ts`, so the engine (loaded by Node) shares payload's / drizzle's module
  instances with the app.
- engine-rs has no dependency on a workspace package: `payload` is a peer, `@payloadcms/drizzle`
  (sqlite only), `@payloadcms/db-mongodb` (mongodb only) and `@libsql/client` optional peers, `jose`
  its only dependency. pnpm reports the cyclic workspace peer db-mongodb <-> engine-rs as a warning.
- It is in the releaser's publish list (`tools/releaser/src/lib/publishList.ts`, before payload), so
  every local-tarball flow (`pnpm script:pack`, test/create-payload-app, `test/setupProd.ts`) packs it.

### engine-rs in an install

- `pnpm --filter @payloadcms/engine-rs build` (`scripts/buildDist.mjs`; also `prepack`, so
  `pnpm pack` runs it) compiles `src` to `dist`. In the monorepo the glue imports payload and
  drizzle internals by relative path into their `src`; the build rewrites each to the same compiled
  file of the installed peer, reached as a sibling package (`<up>/../../payload/dist/<p>.js`,
  `<up>/../drizzle/dist/<p>.js`, `<up>/../db-mongodb/dist/<p>.js`). Node resolves that to the real
  path payload's own imports load, so error classes, symbols and module state are shared, without
  `./internal/*` exports. payload's `jose` file becomes `jose/jwt/decode` (same pinned version), a
  `<package>/package.json` URL becomes `import.meta.resolve('<name>')`. Any other escape fails the
  build.
- The tarball ships `addon.cjs`, `dist/` and (from a plain `pnpm pack`) the local
  `payload-engine.node`, no `src/`; `publishConfig` points `main` / `exports` at `dist`; no `types`.
  The addon is built by `build:native` (honours `CARGO_TARGET_DIR`; `build:native:release` for an
  optimized build), not by `build`; `build` (and so `pack`) **fails** when the addon is missing,
  older than any Rust input (`crates/**` .rs / .toml / .c / .h / .js helpers, `Cargo.toml`,
  `Cargo.lock`), or lacks an export the glue calls. `--allow-stale-addon` only warns (glue-only
  iteration; never for a pack).
- Addon API check: `src/native.ts` `engineAddonExports` lists every addon export some engine-rs
  loader (or payload's `validations.ts`) calls; `assertEngineAddon` (run by `getNativeEngine()`
  and by buildDist on the emitted dist) throws "does not match @payloadcms/engine-rs: it lacks
  ..." for an addon built from an older tree. Each binding additionally checks its own
  `apiVersion`; the live MongoDB glue requires every `mongoLive*Binding` (no stage-1 fallback).

### Release (prebuilt addons)

- `.github/workflows/engine-rs-prebuild.yml`: builds `cargo build -p payload-node --release`
  natively per platform (linux x64 / arm64 gnu on ubuntu-22.04, x64 / arm64 musl in
  `node:24-alpine`, darwin arm64 / x64, win32 x64), smoke-loads each addon, then packs every
  tarball with the release packer. Publishing is not part of it.
- `node packages/engine-rs/scripts/release/packRelease.mjs --addons <dir> [--out dir]
  [--packages a,b]` (`<dir>/<platform>/payload-engine.node`): one `@payloadcms/engine-rs-<platform>`
  tarball per addon (`os` / `cpu` / `libc`, the addon only), engine-rs packed with its addon
  removed and the platform packages as exact-version `optionalDependencies`, and every package of
  the publish list as `pnpm pack` produces it; `release.json` lists them.
- Requirements for every build: Rust (edition 2024), cmake and libclang (libsql-ffi's build script,
  see the libsqlite3-sys section).

### Verification

- `node test/__rs/packaging/run.mjs [--addon file] [--keep]`: packs translations, payload,
  drizzle, db-sqlite, db-mongodb, ui and richtext-lexical with `pnpm pack`, and engine-rs plus this
  platform's package with the release packer (`--addon`: the addon the platform package ships), and
  installs them into an app under `.rs-runs/packaging/work` that depends on payload, the adapters and
  richtext-lexical only (engine-rs arrives as their dependency, the addon as its optional
  dependency; modules resolved from the monorepo are failures). Every dispatching package must
  resolve one engine-rs copy, which must resolve the platform package. The scenario runs twice per
  database with `PAYLOAD_ENGINE=ts` (references: nothing of engine-rs may resolve, no stats), twice
  with the flag unset and once with `PAYLOAD_ENGINE=rs` (candidates: equal to every reference, the
  engine-rs dist entries of the adapter and the platform package's addon resolved, Rust calls in
  every part). A second app without db-mongodb runs the sqlite scenario with the flag unset and
  must load no MongoDB module.
- `node test/__rs/packaging/nextDev.mjs [--database sqlite|mongodb] [--prod]` (after `run.mjs
  --keep`): the same install under `next dev` (Turbopack), or `next build` + `next start` with
  `--prod`: two runs with `PAYLOAD_ENGINE=ts`, one unset; outputs compared, Rust calls required
  (including `afterReadTraverseFields` forwarded by the bundled richtext-lexical), no engine-rs
  code or `.node` file in `.next`, and every Rust run must see one payload instance.
- test/create-payload-app (upstream suite): packs the publish list (engine-rs included) and installs
  it into fresh Next.js / TanStack projects, which then build.
- `node test/__rs/default-path/check.mjs --upstream ec35164` and `--self-test` (see above);
  `node test/__rs/packaging/lockfileCheck.mjs [--self-test]`.

### Not covered yet

- The prebuild workflow has not run (it needs a push); only linux-x64-gnu has been built and
  verified (this machine). macOS arm64 was verified for the debug addon before the default flip.
- npm / yarn layouts have not been run (pnpm only).
- A consumer that replaces the adapter's `init` without calling the previous one, before the
  engine module has loaded, gets the upstream adapter (the engine is installed through that
  function); once loaded, `init` is synchronous and this cannot happen.
