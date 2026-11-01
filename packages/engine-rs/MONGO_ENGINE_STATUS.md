# MongoDB engine status

Owner: mongoadapter (this file, `packages/engine-rs/src/mongo-adapter/**`, `test/__rs/mongo-adapter/**`,
the `PAYLOAD_ENGINE` switch in `packages/db-mongodb/src/index.ts`). Contract:
`MONGO_ENGINE_CONTRACT.md`; interface decisions: `.rs-baseline/mongo-coordination.md`.

## Pieces

| piece                                            | where                                                              | state                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS glue `withRustMongoEngine`                    | `src/mongo-adapter/index.ts`                                       | done: wraps the 24 data methods, engine created after upstream `init`, per-call host object table, mutations applied in place, error rebuild                                                                                                    |
| host executor                                    | `src/mongo-adapter/host.ts`                                        | done: `model` (+ `chain`, `post: toObject`, `fnOptions`), `getSession` (upstream copy, original `req`), `modelInfo`, `adapterCall`, `logError`; resolves `{ok: tree}`, rejects `{error: {handle, isObject, name?, message?, code?, keyValue?}}` |
| typed values                                     | `src/mongo-adapter/codec.ts` + `src/serialize.ts` (`BsonBoundary`) | done: `$oid`, `$regex`, `$decimal`, `$binary {base64, subType}`, `$buffer`, `$hostObject`                                                                                                                                                       |
| errors                                           | `src/mongo-adapter/errors.ts`                                      | done: `rethrow`, `HostError`, `ValidationError` exactly upstream's `{ collection, errors, global }`, `BSONError` with the adapter's bson class, rest via SQLite `rebuildError`                                                                  |
| loopback engine                                  | `src/mongo-adapter/loopback.ts` (`PAYLOAD_RS_MONGO_LOOPBACK=true`) | done: upstream methods on stand-in models, every DB call a host op through the real glue                                                                                                                                                        |
| native `MongoEngine` (napi)                      | `crates/payload-node/src/mongo_engine.rs` (mongoengine)            | not in the addon yet                                                                                                                                                                                                                            |
| mongoose models from the Rust schema description | `src/mongo-schema` (mongoschema)                                   | not wired: upstream models are kept                                                                                                                                                                                                             |
| `PAYLOAD_ENGINE=rs` switch in db-mongodb         | `packages/db-mongodb/src/index.ts`                                 | waiting for `/tmp/rs-phase-f-done` (needs the engine-rs `index.ts` export); package dependency + symlink done                                                                                                                                   |

## How to run

```sh
# glue alone (loopback engine), per-test comparison with the TS baseline
node test/__rs/mongo-adapter/runSuites.mjs --jobs 4 --tag <tag> \
  --baseline-dir /tmp/rs-mongo-runs/rsmbase/results     # or --baseline .rs-baseline/mongodb-all.json
# native engine (once the addon has MongoEngine)
node test/__rs/mongo-adapter/runSuites.mjs --native --addon /tmp/mongoadapter-addon/payload-engine.node ...
# recompute against a newer baseline without re-running
node test/__rs/mongo-adapter/runSuites.mjs --resummarize --tag <tag> --baseline .rs-baseline/mongodb-all.json
# shadow differential (reference TS adapter vs candidate on a second database)
PAYLOAD_RS_MONGO_LOOPBACK=true node test/__rs/mongo-harness/runSuites.mjs --shadow \
  --candidate test/__rs/mongo-adapter/candidate.ts <files>
# codec round trip
node --experimental-strip-types test/__rs/mongo-adapter/codecCheck.mts
```

`test/__rs/mongo-adapter/vitest.config.ts` = mongo-harness config with `databaseAdapter.js` aliased to
`databaseAdapter.ts` (the harness adapter wrapped by `withRustMongoEngine`, imported by path).
Stats: `PAYLOAD_RS_MONGO_ENGINE_STATS_FILE` (calls per method, host ops per op, engines).

## Results

RESULTS_PLACEHOLDER

## Known gaps / differences

- Configs that build their own `mongooseAdapter(...)` (not through `test/databaseAdapter.js`) are not
  wrapped until the db-mongodb switch lands.
- Loopback only (glue-irrelevant): `getSession` runs before the upstream method instead of where
  upstream awaits it; `Model.buildQuery` and `buildSearchParams` relationship subqueries run
  in-process on the real models.
- `hasReq` is `Boolean(req)`: `handleError`'s `stripLocaleFromPath` reads
  `req.payload.config.localization`; the engine uses its own config, so a truthy `req` without
  `payload` would strip where upstream does not (no suite does this).
- Mutations are applied when the call settles; upstream mutates the caller's `data` synchronously
  during the call (only observable by code reading the args concurrently).
