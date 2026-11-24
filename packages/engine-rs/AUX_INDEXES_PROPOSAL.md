# Proposal: auxiliary MongoDB indexes on observed where / sort paths (RUST_PERF_PLAN.md §4, A3)

Status: **measured, not built.** Adding indexes is additive storage (§4) and needs the owner's
approval (D10). This note gives the numbers that approval needs.

## Question

After the fused read lanes, most MongoDB `where` and `sort` scenarios of the perf suite are
collection scans: server time is the floor. What would the Rust engine gain if it maintained extra
indexes on the paths it sees in `where` and `sort`, and what would they cost (write overhead per
create / update, storage, build time) at 1k and 10k documents?

## Method

- Perf suite (`test/__rs/perf/run.mjs`), MongoDB rs0 on :27038, shape `typical`, sizes 1000 and
  10000, Local API, categories read, create, update, partial-update, delete; engines `ts` and `rs`;
  worktree-local pnpm store, installed packages verified against the packed tarballs.
- Extra indexes on `posts`: the paths of the suite's `where` / `sort` scenarios that have no index
  today. Existing: `_id`, `createdAt`, `updatedAt`, `title`, `slug`, `stage`, `publishedAt`.

  | index                                     | serves                                                                                       |
  | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
  | `{ views: -1, createdAt: -1 }`            | `sort: '-views'` (+ the `-createdAt` fallback sort), `views` ranges, `count where views > n` |
  | `{ author: 1, views: -1, createdAt: -1 }` | `sort: ['author', '-views']`, `author exists`, `findDistinct author`                         |
  | `{ 'tags.tag': 1 }`                       | array sub-field equality                                                                     |
  | `{ categories: 1 }`                       | hasMany `in`                                                                                 |
  | `{ 'seo.title': 1 }`                      | group sub-field `like` (a case-insensitive regex, so an index scan at best)                  |

- Runs: 3 without the indexes, 2 with them created after seeding, 1 with them created before
  seeding (to measure the seed's write cost). Medians per scenario are taken over the runs. The
  machine is shared, so run-to-run noise is large: the same scenario's median varies by up to 2.5x
  between runs at 1k, and typically by 1.2-1.6x. Only effects well above that are reported as
  real. The measurement hook (indexes created in `bench.mjs` right after `seed()`, or before it)
  is not committed.

## Gains (rs, medians; ts / rs is the suite's speedup)

| scenario (Local, `typical`)                                          | 1k rs → rs+idx (ms)     | 10k rs → rs+idx (ms)     | 10k ts / rs: no idx → idx |
| -------------------------------------------------------------------- | ----------------------- | ------------------------ | ------------------------- |
| find sort `-views` limit 50                                          | 2.23 → 1.55 (1.44x)     | 6.54 → 1.60 (**4.1x**)   | 1.07 → 4.39               |
| find sort by two fields                                              | 2.40 → 1.52 (1.58x)     | 7.24 → 1.57 (**4.6x**)   | 1.02 → 4.69               |
| find where array sub-field (`tags.tag`)                              | 1.22 → 0.78 (1.57x)     | 5.35 → 1.05 (**5.1x**)   | 1.05 → 5.36               |
| find where range (`views`)                                           | 1.11 → 0.92 (1.21x)     | 3.58 → 1.02 (**3.5x**)   | 0.98 → 3.43               |
| find where hasMany in (`categories`)                                 | 1.43 → 1.04 (1.38x)     | 4.74 → 1.33 (**3.6x**)   | 1.00 → 3.57               |
| count where (`views > 5000`)                                         | 0.54 → 0.28 (1.9x)      | 3.04 → 1.07 (**2.8x**)   | 0.96 → 2.73               |
| findDistinct author                                                  | 1.98 → 1.60 (1.24x)     | 6.22 → 2.72 (**2.3x**)   | 0.96 → 2.19               |
| find where group sub-field (regex)                                   | 1.42 → 1.28 (noise)     | 6.31 → 4.57 (1.38x)      | 1.05 → 1.45               |
| **find where exists (`author`)**                                     | 1.23 → 1.80 (**0.69x**) | 3.81 → 11.43 (**0.33x**) | 1.00 → 0.33               |
| **find where and/or + relationship path**                            | 2.65 → 2.53 (noise)     | 7.88 → 10.11 (**0.78x**) | 0.95 → 0.74               |
| everything else (id / indexed / select / page / populate / findByID) | within noise            | within noise             |                           |

Read-category geomean, ts / rs: 1k 1.51 → 1.72 (rs 1.14x faster), 10k 1.43 → 1.82 (rs 1.27x
faster). Where an index matches, the gain is 1.2-1.6x at 1k and 2.3-5x at 10k, and it grows with
the collection: these are scans becoming index range scans or index-ordered sorts.

**Regressions are real and planner-driven.** With `{ author: 1, views: -1, createdAt: -1 }`
present, `author: { exists: true }` (Payload sends `$and: [{ author: { $exists: true } },
{ author: { $ne: null } }]` plus the `-createdAt` sort) is planned on that index and then sorted in
memory: 3x slower at 10k. The and/or + relationship-path query regresses by about 1.3x the same way.
An index chosen per query shape has to be checked with `explain` against **every** query shape on
the collection, not only the one it was added for.

## Costs

| cost                                               | 1k posts                                                                                                                              | 10k posts                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| storage (5 indexes)                                | +0.17 MB (data 1.17 MB)                                                                                                               | +0.94 MB (data 11.7 MB, existing indexes 1.0 MB): +8% of data, about 2x the index size |
| build on a populated collection                    | 110-140 ms per index, ~0.6 s for 5 (fixed cost dominates)                                                                             | 115-140 ms per index, ~0.6 s for 5                                                     |
| seed, 8 concurrent creates (indexes present)       | rs 3.33 s vs 2.77-3.25 s, ts 2.52 s vs 2.50-2.99 s: within noise                                                                      | rs 27.8 s vs 24.9-30.1 s, ts 24.9 s vs 21.1-24.6 s: about +7-11%                       |
| create / update / partial-update / delete per call | ±5-10%, inside run-to-run noise (create 0.99x, update 1.03x, partial-update 1.08x / 0.98x, delete 0.89x / 1.04x geomeans at 1k / 10k) | same                                                                                   |

Each index adds one B-tree insert per write and one more per array element for multikey paths
(`tags.tag`, `categories`). At these sizes that cost hides inside the noise of a ~6-8 ms write.
The seed's +7-11% at 10k is the better estimate of steady write throughput.

## Proposal

1. Do not add a fixed set of indexes. The gain only exists for deployments whose queries match
   them, and a wrong index makes other queries 3x slower.
2. If the owner wants it, offer it as **opt-in per-deployment tuning**:
   - The engine records the `where` / `sort` shapes it serves (the fused lane already builds the
     exact filter and sort). Above a collection size threshold (10k documents) it proposes indexes
     for the hot shapes.
   - Every proposal is verified with `explain` on **all** recorded shapes of the collection, so a
     candidate that turns another shape into an in-memory sort, like the `author` compound above,
     is rejected.
   - Indexes are created with `createIndex` in the background, with names in their own namespace
     (`payload_aux_*`), so `test/sizes-to-variants` and the migrations never see a collision.
3. Expected gain: nothing measurable at 1k (1.1-1.6x on the matched scenarios, inside noise).
   At 10k, 2.3-5x on each matched sort or filter and about +1.3x on the read-category geomean of
   this suite. Expected cost: about 8% of data size in storage and about +7-11% write throughput
   cost at 10k.
4. The same indexes would help upstream TypeScript equally (the gain is server time). They are a
   database tuning lever, not an engine speedup: they move rs/ts only because rs would maintain
   them.

Decision needed (D10 / A3): whether Payload may create and own auxiliary indexes at all, opt-in,
with the `explain`-based safety check above.
