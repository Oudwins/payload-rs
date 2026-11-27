# Performance suite: the Rust engine vs upstream TypeScript

Measures every user-facing API surface of Payload with both engines, on the packed dist builds
and the release addon (what users install), for several config shapes, collection sizes and
databases.

```sh
cargo build -p payload-node --release          # the addon under test (target/release)
pnpm build:core                                # dist builds the tarballs are packed from
node test/__rs/perf/run.mjs                    # full matrix (hours)
node test/__rs/perf/run.mjs --quick            # minimal + complex, 100 / 1000 posts, short timing, 1 round
node test/__rs/perf/run.mjs --reuse --databases mongodb --shapes typical --sizes 1000 --verbose
```

## What is measured

`node test/__rs/perf/run.mjs --list` prints the full catalogue (146 scenarios). By category:

| category         | Local API                                                                                                                                                                                                                                                                                                                                                                                                                                         | REST                                                                                                                                                                                                                           | GraphQL                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| read             | find: limit 10 / 100 / 200 unpaginated, depth 0 / 1 / 2, populate; where: equals, not_equals, in, like, contains, ranges, exists, and/or with a relationship path, array and group sub-fields, hasMany in, date ranges; sort (one / two fields), select (top level / nested), page 2 / last page, access control (`overrideAccess: false`), joins (+ join pagination); count (with / without where), findByID (depth 0 / 2, select), findDistinct | `GET /posts` (limit 10 / 100, depth 2, where, select + sort), `GET /posts/:id`, `GET /posts/count`                                                                                                                             | `Posts` (10 / 100, with a relationship, where + sort), `Post` by id |
| create           | create (full / title only / depth 1 result / as draft), duplicate                                                                                                                                                                                                                                                                                                                                                                                 | `POST /posts`, `POST /posts/:id/duplicate`                                                                                                                                                                                     | `createPost`                                                        |
| update           | whole document, depth 1 result, update many (10 by where)                                                                                                                                                                                                                                                                                                                                                                                         | `PATCH /posts/:id` (whole document), `PATCH /posts?where` (bulk)                                                                                                                                                               |                                                                     |
| partial-update   | one scalar, a relationship, a hasMany relationship, a group sub-field, an array (replace rows / append a row), rich text, blocks, a tab field                                                                                                                                                                                                                                                                                                     | `PATCH /posts/:id` (one field)                                                                                                                                                                                                 | `updatePost` (one field)                                            |
| locale           | update in de / one field in fr, find in de with fallback, fr without fallback, all locales, findByID all locales, where on a localized field                                                                                                                                                                                                                                                                                                      | `PATCH ?locale=de`, `GET ?locale=de`                                                                                                                                                                                           | `Posts(locale: de)`                                                 |
| versions         | save draft, publish, find drafts, findByID draft, findVersions (by parent / all), countVersions, findVersionByID, restoreVersion, findGlobalVersions, restoreGlobalVersion                                                                                                                                                                                                                                                                        | save draft (`?draft=true`), `GET /posts/versions`, `GET /posts/versions/:id`, restore (`POST /posts/versions/:id`), `GET /globals/settings/versions`                                                                           | `versionsPosts`                                                     |
| delete           | by id, many (5 by where)                                                                                                                                                                                                                                                                                                                                                                                                                          | `DELETE /posts/:id`, `DELETE /posts?where` (bulk)                                                                                                                                                                              | `deletePost`                                                        |
| globals          | findGlobal (depth 0 / 1), updateGlobal (a field / a relationship)                                                                                                                                                                                                                                                                                                                                                                                 | `GET` / `POST /globals/settings`                                                                                                                                                                                               | `Setting`, `updateSetting`                                          |
| auth             | login, auth (JWT), forgotPassword, resetPassword, unlock                                                                                                                                                                                                                                                                                                                                                                                          | login, me, refresh-token, logout                                                                                                                                                                                               | `meUser`                                                            |
| uploads          | create upload, find uploads, update upload metadata                                                                                                                                                                                                                                                                                                                                                                                               | `POST /media` (multipart), `GET /media`                                                                                                                                                                                        |                                                                     |
| jobs             | jobs.queue, jobs.runByID                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                                                                                                                                                |                                                                     |
| validation       | validate create data, validate an update of a stored document, validate invalid data                                                                                                                                                                                                                                                                                                                                                              |                                                                                                                                                                                                                                |                                                                     |
| custom-endpoints |                                                                                                                                                                                                                                                                                                                                                                                                                                                   | root (`/perf/ping` without a payload call, `/perf/echo` JSON body, `/perf/latest-posts` find depth 1), collection (`/posts/perf-stats` count, `/posts/:id/touch` update), global (`/globals/settings/perf-summary` findGlobal) |                                                                     |
| meta             |                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `GET /access`, `POST` / `GET /payload-preferences/:key`                                                                                                                                                                        |                                                                     |
| throughput       | find limit 10, findByID, create; each with 8 and 64 concurrent callers (`--throughput-concurrency`)                                                                                                                                                                                                                                                                                                                                               | `GET /posts` limit 10, 8 and 64 concurrent callers                                                                                                                                                                             |                                                                     |

**Throughput** scenarios issue their request back to back from every caller for the measuring
time and report requests per second, the per-request latency under load (p50 / p95 / p99),
process CPU time per request (all threads: JS, engine and database) and JS-thread time per
request (event loop active time, including synchronous waits on native calls); their speedup is
Rust req/s / TS req/s. Each entry records when its timed window began (`startedAt`, ISO), to line
a slow round up with the database server's own metrics.

Plus **startup** (fresh processes against an existing schema: import of payload + adapters,
`buildConfig`, `getPayload`; median of `--startup-runs`; up to 200 collections) and **seeding**
throughput (`payload.create`, 8 concurrent).

Per scenario and engine: every timed sample (wall ms and CPU ms), min / p25 / median / p75 / p90 /
p95 / p99 / max / mean / stddev / coefficient of variation, CPU per iteration (user + system), GC
pauses (count, ms, per kind) during the timed loop, heap delta, result size (JSON bytes) and
documents returned, the result fingerprint and the hook calls of one iteration.

Config shapes (configs.mjs): `minimal` (flat), `typical` (a blog: lexical rich text, select / date
/ checkbox, unique slug, relationships, array, group), `complex` (typical plus localization in 3
locales, versions with drafts, blocks with nested arrays, tabs, a join field, query-constraint
access control, field access, custom validation), `hooks` (typical with every collection hook and
four field hooks on every field), `wide-<n>` (startup only: n collections). Every shape has custom
endpoints, an upload collection, a jobs task and a global.

Sizes: posts per collection (`--sizes`, default 100 / 1000 / 10000; authors size / 20, 20
categories). Databases: mongodb (rs0 on :27018), sqlite (a file per cell), postgres (:5433, a
database per cell; db-postgres itself is upstream TS, the core is Rust).

## Outputs

`--out` (default `.rs-runs/perf/out`):

- `report.html`: interactive (filters by database, shape, size, surface, category and scenario
  text; summary by surface / category; speedup per scenario; latency distributions per engine;
  scaling with the collection size; CPU and GC; startup; throughput; a sortable table of every
  statistic)
- `report.md`: the same numbers as tables, plus a throughput table per cell
- `scenarios.csv` (one row per database x shape x size x engine x scenario, every statistic;
  throughput rows add concurrency, requests per second, CPU / JS-thread ms per request),
  `samples.csv` (one row per timed iteration), `startup.csv`, `seed.csv`
- `results.json` (everything) and the raw per-process results in `cells/`

One engine alone works too (`--engines ts` or `--engines rs`: absolute numbers, no speedups);
`--engines ts,rs,db-rs,core-rs` attributes a difference to the database engine or the core;
`rs-threads-<n>` is the default selection with `PAYLOAD_MONGO_DRIVER_THREADS=<n>` (the MongoDB
driver runtime's workers), e.g. `--engines ts,rs-threads-2,rs-threads-4` (only `ts` and `rs` cells
are paired in the report).
`--categories`, `--scenarios <regex>`, `--surfaces`, `--shapes`, `--sizes`, `--databases` select a
subset. On shared servers, `--mongodb-server <url>` selects the MongoDB server and `--db-prefix
<prefix>` (default `perf`) the name prefix of every database a run creates. `--processes <n>`
(rounds), `--order shuffle|suite` and `--cpus <list>` control the method below.

## Method

- **Rounds.** Each (database, shape, size) runs `--processes` rounds (default 3, `--quick` 1). A
  round starts one fresh process per engine, each on its own fresh database, seeded one after the
  other (the engine that starts first alternates between rounds). `ts` = `PAYLOAD_ENGINE=ts`, `rs` =
  the flag unset (the default). `NODE_ENV=production`; SQL schemas are pushed before measuring.
- **Interleaved engines.** run.mjs drives the processes of a round over IPC, scenario by scenario:
  the ts process measures scenario k, then the rs process does (the engine going first alternates
  per scenario), while the other process idles. Both engines of a scenario are measured seconds
  apart, so a transient load (another process, a database checkpoint, a slow window of a shared
  server) hits both or shows up as the spread between rounds, instead of biasing one engine's
  whole cell.
- **Order.** `--order shuffle` (default) shuffles the scenarios per round, with the round as the
  seed and the same order for every engine of the round: read-only scenarios first, then the
  mutating ones (each group shuffled), then throughput, so reads still see the seeded data. No
  scenario's number depends on one fixed predecessor; `--order suite` keeps the catalogue order.
- `--cpus <list>` pins every bench process with `taskset` (e.g. `--cpus 0-7`; MongoDB and other
  servers are not pinned by the suite). The CPU set changes the Rust engine's numbers more than
  TypeScript's: an operation hands work between the JS thread and the engine's worker threads
  several times, and each hand-off to a sleeping thread on another core pays a wake-up. Measured
  (`find limit 10 depth 2`, complex, 1k posts, one process, 2000 iterations): TS 4.0-4.1 ms on
  every set; Rust 3.8-4.4 ms on some sets and placements and 5.5-6.6 ms on others, switching
  within a process when the scheduler moves threads. Compare runs only with the same `--cpus`,
  and read a Rust-only slowdown of populate-heavy reads with a wide interval as placement, not as
  engine work, until a focused A/B confirms it.
- **Warm-up of the exact lane.** A scenario a variant runs on the exact lane (a guarded fused
  write) starts with colder JS in a process whose seeding, setups and teardowns ran fused (`rs`)
  than in one where they ran in JS (`rs-fused-off`, `ts`): V8 still compiles the exact write path
  during the timed iterations, so with the default `--warmup 3` such scenarios measure 5-10%
  slower and use more CPU (the compiler threads) than in the other variant, and approach it with
  `--warmup 100` (FUSED_WRITES.md section 13, WP-X). Read an `rs` < `rs-fused-off` result of a
  guarded scenario as warm-up, not as fused-dispatch work, unless a larger `--warmup` keeps it.
- Per scenario: `gc()`, warmup runs (the first records the result fingerprint and hook calls), then
  timed iterations until at least `--min-iterations` and `--min-time-ms` (capped by
  `--max-iterations` / `--max-time-ms`). Per-iteration setup (e.g. creating the document a delete
  removes) and teardown (deleting what a create made, so the size stays fixed) are not timed.
- **Reported.** A cell (database, shape, size, engine) pools the samples of its rounds: median,
  p95, mean, min, max, CPU, the median of the per-process GC / heap / throughput numbers, and
  `processes` (each round's own median, p95, n, CPU, req/s, position in the order, heap / RSS after
  the scenario). Speedup (> 1: Rust faster) with several rounds = geometric mean of the per-round
  speedups (TS median / Rust median of the same round; throughput: Rust req/s / TS req/s), with a
  95% confidence interval (t interval of the log speedups over the rounds). A scenario is
  **confidently slower** (faster) when the whole interval lies below (above) 1; report.md lists
  the confidently slower ones. With one round: TS median / Rust median. Summaries add the per-round
  geomeans and their interval, and the counts of confidently faster / slower scenarios. In
  report.md, `(a–b)` after a latency is the range of the per-process medians.
- `results.json` keeps the old layout (one cell per database x shape x size x engine, the same
  scenario fields), plus `processes` per scenario and per cell; `scenarios.csv` adds the interval,
  the per-round speedups and the per-process median range; `samples.csv` adds the round of each
  sample (`process`).
- Correctness guards (the run fails): an rs process that did not map the engine addon or a ts
  process that did (`/proc/self/maps`), a scenario that errors (on one engine, or on both: it measures nothing), and ts / rs
  differences in the result fingerprint (keys, array lengths, pagination counters, deterministic
  values) or in the number of hook calls; an installed perf app that differs from the packed
  tarballs or from `--addon` (checked file by file before anything runs, also with `--reuse`; the
  app installs from its own pnpm store, `.rs-runs/perf/pnpm-store`).
- Seed data is deterministic (seeded PRNG); fresh documents of each scenario come from its own
  index range, so both engines create the same data.

Not covered: the admin UI's React server components and form state (rendering, not an engine
API), image processing (sharp is not installed: uploads are text files, so storage and the upload
pipeline are measured, resizing is not), email delivery (`disableEmail`). Machine load from other
processes distorts results: run nothing else meanwhile (the interleaving spreads it over both
engines, it does not remove it; a wide interval is the sign).
