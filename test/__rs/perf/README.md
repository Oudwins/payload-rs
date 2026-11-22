# Performance suite: the Rust engine vs upstream TypeScript

Measures every user-facing API surface of Payload with both engines, on the packed dist builds
and the release addon (what users install), for several config shapes, collection sizes and
databases.

```sh
cargo build -p payload-node --release          # the addon under test (target/release)
pnpm build:core                                # dist builds the tarballs are packed from
node test/__rs/perf/run.mjs                    # full matrix (hours)
node test/__rs/perf/run.mjs --quick            # minimal + complex, 100 / 1000 posts, short timing
node test/__rs/perf/run.mjs --reuse --databases mongodb --shapes typical --sizes 1000 --verbose
```

Output (`--out`, default `.rs-runs/perf/out`): `report.md` (every number), `report.html` (one
diverging speedup chart per cell, the same tables), `results.json`, raw per-process results in
`cells/`.

## What is measured

| surface   | scenarios (scenarios.mjs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| startup   | fresh processes against an existing schema: import of payload + adapters, `buildConfig` (sanitization), `getPayload` (adapter init, connect, models); median of `--startup-runs`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Local API | find (limit 10 / 100, depth 0 / 2, equals / like / and-or + relationship path, sort, select, last page, all locales, drafts, access control with `overrideAccess: false`, join field), count (with / without where), findByID (depth 0 / 2), findDistinct, create, validate, update by id (incl. a localized update), update many, delete by id, delete many, duplicate, findVersions, countVersions, findVersionByID, restoreVersion, findGlobal, updateGlobal, findGlobalVersions, restoreGlobalVersion, create upload / find uploads, jobs queue / runByID, login, auth (JWT), forgotPassword, resetPassword, unlock |
| REST      | `GET /posts` (list, depth 2, where), `GET /posts/:id`, `GET /posts/count`, `POST /posts`, `PATCH /posts/:id`, `DELETE /posts/:id`, `GET /posts/versions`, `GET /posts/versions/:id`, `POST /media` (multipart upload), `GET /media`, `POST` / `GET /payload-preferences/:key`, `GET /globals/settings`, `POST /users/login`, `GET /users/me`, `POST /users/refresh-token`, `GET /access`, through `@payloadcms/next/routes` with Fetch `Request`s, authenticated                                                                                                                                                        |
| GraphQL   | `Posts` list (with and without a relationship), `Post` by id, `versionsPosts`, `updatePost`, `createPost`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| seeding   | posts per second of `payload.create` (8 concurrent) while seeding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Config shapes (configs.mjs): `minimal` (flat), `typical` (a blog: lexical rich text, select / date
/ checkbox, unique slug, relationships, array, group), `complex` (typical plus localization in 3
locales, versions with drafts, blocks with nested arrays, tabs, a join field, query-constraint
access control, field access, custom validation), `hooks` (typical with every collection hook and
four field hooks on every field), `wide-<n>` (startup only: n collections). Hooks, validation and
access control are therefore measured inside the operations that run them, by comparing shapes.

Sizes: posts per collection (`--sizes`, default 100 / 1000 / 10000; authors size / 20, 20
categories). Databases: mongodb (rs0 on :27018), sqlite (a file per cell), postgres (:5433, a
database per cell; db-postgres itself is upstream TS, the core is Rust).

## Method

- One fresh process and one fresh database per (database, shape, size, engine) cell, cells strictly
  one after another; the engine order alternates between cells. `ts` = `PAYLOAD_ENGINE=ts`, `rs` =
  the flag unset (the default). `NODE_ENV=production`; SQL schemas are pushed before measuring.
- Per scenario: `gc()`, warmup runs (the first records the result fingerprint and hook calls), then
  timed iterations until at least `--min-iterations` and `--min-time-ms` (capped by
  `--max-iterations` / `--max-time-ms`). Per-iteration setup (e.g. creating the document a delete
  removes) and teardown (deleting what a create made, so the size stays fixed) are not timed.
- Reported: median, p95, mean, min, max per scenario; speedup = TS median / Rust median.
- Correctness guards (the run fails): an rs process that did not map the engine addon or a ts
  process that did (`/proc/self/maps`), a scenario that errors on one engine only, and ts / rs
  differences in the result fingerprint (keys, array lengths, pagination counters, deterministic
  values) or in the number of hook calls.
- Seed data is deterministic (seeded PRNG); fresh documents of each scenario come from its own
  index range, so both engines create the same data.

Not covered: the admin UI's React server components and form state (rendering, not an engine
API), image processing (sharp is not installed: uploads are text files, so storage and the upload
pipeline are measured, resizing is not), email delivery (`disableEmail`). Machine load from other
processes distorts results: run nothing else meanwhile.
