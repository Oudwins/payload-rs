# PostgreSQL verification for the Rust port (`test/__rs/pg-harness`)

Shared infrastructure for running the upstream int suite against PostgreSQL
(`@payloadcms/db-postgres` over `packages/drizzle/src/postgres` + node-postgres) without touching
the shared, generated `test/databaseAdapter.js`. Porting plan: `RUST_POSTGRES_PLAN.md`.

## Server

Upstream runs `ghcr.io/payloadcms/postgis-vector:latest` (test/docker-compose.yml, profile
`postgres`): PostgreSQL 17.5 (`postgres:17-bookworm`), PostGIS 3.5.3, pgvector, user/password
`payload`/`payload`, database `payload`, published on `localhost:5433`, `LANG=en_US.utf8`, server
time zone UTC. No docker here: the same major versions come from nixpkgs (PostgreSQL 17.11, PostGIS
3.6.4, pgvector 0.8.6), ~600 MB in the nix store.

One-time setup (binaries are kept alive by the `/tmp/rs-pg-bin` gc root):

```sh
nix build --impure --out-link /tmp/rs-pg-bin --expr \
  'let pkgs = (builtins.getFlake "nixpkgs").legacyPackages.aarch64-darwin; in pkgs.postgresql_17.withPackages (p: [p.postgis p.pgvector])'
echo payload > /tmp/rs-pg-pw
/tmp/rs-pg-bin/bin/initdb -D /tmp/rs-pg-data -U payload --pwfile=/tmp/rs-pg-pw \
  --auth-host=scram-sha-256 --auth-local=trust -E UTF8 \
  --locale-provider=icu --icu-locale=en-US --locale=en_US.UTF-8
rm /tmp/rs-pg-pw
```

Start (also after a reboot; idempotent check with `pg_isready -h localhost -p 5433`):

```sh
/tmp/rs-pg-bin/bin/pg_ctl -D /tmp/rs-pg-data -l /tmp/rs-pg.log -w -o "-p 5433 -k /tmp \
  -c listen_addresses=localhost -c shared_buffers=128MB -c max_connections=300 \
  -c timezone=UTC -c log_timezone=UTC -c fsync=off -c synchronous_commit=off \
  -c full_page_writes=off -c wal_level=minimal -c max_wal_senders=0 \
  -c max_wal_size=256MB -c min_wal_size=32MB -c log_min_messages=warning" start
# first start only:
PGPASSWORD=payload /tmp/rs-pg-bin/bin/psql -h localhost -p 5433 -U payload -d postgres -c 'CREATE DATABASE payload'
```

Stop: `/tmp/rs-pg-bin/bin/pg_ctl -D /tmp/rs-pg-data stop -m fast`.

Differences to the docker image, all deliberate or harmless for the int suite:

- Collation: ICU `en-US` instead of glibc `en_US.utf8` (macOS libc collations sort like `C`, which
  would change `ORDER BY` on text). ICU and glibc ≥ 2.28 both follow CLDR/ISO 14651 and agree for
  the data the suite sorts; byte-exact equality of every collation corner case is not guaranteed.
- `fsync`, `synchronous_commit`, `full_page_writes` off and `wal_level=minimal` (speed and disk;
  no replica). Docker runs `wal_level=replica` with a streaming replica on :5434 for
  `postgres-read-replica(s)`, which this setup does not provide.
- Minor versions (17.11 vs 17.5, PostGIS 3.6 vs 3.5). Extensions are created by the adapter
  (`CREATE EXTENSION IF NOT EXISTS postgis` / `vector`) like on the image; `payload` is superuser.

## Databases

Every run needs its **own database** (`PAYLOAD_DROP_DATABASE=true`: the adapter drops its schema on
connect):

```sh
node packages/engine-rs/scripts/pg/pgDatabases.mjs list
node packages/engine-rs/scripts/pg/pgDatabases.mjs create <name> [--schema custom]
node packages/engine-rs/scripts/pg/pgDatabases.mjs drop <name> '/^myprefix_/'
```

`payload`, `postgres` and the templates are never dropped.

## Running one file

```sh
node packages/engine-rs/scripts/pg/pgDatabases.mjs create mydb_1
PAYLOAD_DATABASE=postgres POSTGRES_URL=postgres://payload:payload@localhost:5433/mydb_1 TZ=UTC \
  pnpm test:int --config test/__rs/pg-harness/vitest.config.ts test/hooks/int.spec.ts
node packages/engine-rs/scripts/pg/pgDatabases.mjs drop mydb_1
```

- `vitest.config.ts` aliases `databaseAdapter.js` to `databaseAdapter.ts`, both the relative
  imports (`../databaseAdapter.js`) and the absolute ones some suites build with
  `path.resolve(dirname, '../databaseAdapter.js')` (test/database/postgres-vector, up-down-migration,
  pg-replica, postgres-relationships-v2-v3-migration, test/uuid-v7/config.ts), and sets
  `PAYLOAD_RS_SKIP_ADAPTER_CODEGEN=true`.
- `databaseAdapter.ts` builds exactly the upstream entry of test/dbAdapters.ts for
  `PAYLOAD_DATABASE` (args.ts): `postgres`, `postgres-uuid` (`idType: 'uuid'`), `postgres-uuidv7`
  (`idType: 'uuidv7'`), `postgres-custom-schema` (`schemaName: 'custom'`; the database needs a
  `custom` schema, like upstream CI's `CREATE SCHEMA custom;`). `postgresAdapter` is imported from
  `@payloadcms/db-postgres`. `POSTGRES_URL` is required.
- Child processes (the `cli` fixture etc.): `databaseAdapter.ts` adds
  `--import test/__rs/pg-harness/childProcessLoader.mjs` to `NODE_OPTIONS`; a synchronous
  `module.registerHooks` resolve hook maps every import of `test/databaseAdapter.js` made by a test
  module (relative or absolute) to the harness adapter.

## Running many files

```sh
node test/__rs/pg-harness/runSuites.mjs [--engine ts|rs] [--core ts] \
  [--database postgres|postgres-uuid|postgres-uuidv7|postgres-custom-schema] \
  [--config <vitest config>] [--jobs 1] [--tag mytag] [--baseline .rs-baseline/postgres-all.json] \
  [--rerun-failed] [--write-baseline <file>] [--resume] [files or dirs...]
```

One vitest process per file, database `<tag>_<n>` created before the file (plus schema `custom`
for postgres-custom-schema) and dropped (`WITH (FORCE)`) after it, `TZ=UTC`, `DATABASE_URL` /
`POSTGRES_REPLICA_URL` / engine variables cleared. Use `--jobs 1`. Every file waits while /tmp has
less than 3 GB free (resumes at 5 GB). Writes `<out>/summary.{json,md}`, per-file vitest JSON in
`<out>/results/`, logs in `<out>/logs/` (default out `/tmp/rs-pg-runs/<tag>`). `--rerun-failed`
re-runs every file with a failure alone and records `reproduced` / `flaky` per test.
`--engine rs` sets `PAYLOAD_ENGINE=rs`; today this only switches the Rust core engine (operations,
hooks, validation), because db-postgres has no Rust SQL engine yet.

## TS baseline

- `.rs-baseline/postgres-all.json`: per-test vitest JSON of the TS engine on PostgreSQL
  (repo-relative file names), the `--baseline` input of comparison runs.
- `.rs-baseline/postgres-rerun.json`: vitest JSON of the files re-run alone (second `--baseline`,
  so either outcome of a flaky test is accepted).
- Variants, same runner with `--database`: `.rs-baseline/postgres-uuid.json`,
  `postgres-uuidv7.json`, `postgres-custom-schema.json`, each with a `-rerun.json` (written by
  `node packages/engine-rs/scripts/pg/writeRerunBaseline.mjs /tmp/rs-pg-runs/<tag> <out>`).
  Compare a variant run with its own files, e.g.
  `--database postgres-uuid --baseline .rs-baseline/postgres-uuid.json --baseline .rs-baseline/postgres-uuid-rerun.json`.
- `.rs-baseline/postgres-summary.md`: per-file results, failing tests with their cause
  (environmental vs to investigate), comparison with the SQLite and MongoDB baselines, variant
  columns and the variant tests whose status differs from `postgres`. Regenerate with
  `node packages/engine-rs/scripts/pg/analyzeBaseline.mjs --summary /tmp/rs-pg-runs/<tag>/summary.json [--variant postgres-uuid /tmp/rs-pg-runs/<uuid tag>/summary.json ...]`.
  When the `postgres` run directory is gone, rebuild its summary from the committed files first:
  `node packages/engine-rs/scripts/pg/summaryFromBaselines.mjs --out /tmp/rs-pg-runs/rsp_base/summary.json`
  (keeps the causes of `.rs-baseline/postgres-summary.md`).
