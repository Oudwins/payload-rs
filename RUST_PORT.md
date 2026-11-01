# Payload → Rust engine port

Goal: move Payload's engine into Rust while every user-facing TypeScript API
(`buildConfig`, `getPayload`, the Local API, REST, GraphQL, adapters like
`sqliteAdapter(...)`, hooks, access functions, `payload.db.drizzle`) keeps
working exactly as it does upstream.

Upstream base: see `UPSTREAM.md`.

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
| `ts`     | upstream TypeScript implementation (reference)                  |
| `rs`     | Rust implementation (default once a module is ported)           |
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

```sh
pnpm build:engine-rs                           # build the native addon
PAYLOAD_ENGINE=rs pnpm test:int:sqlite <suite>
PAYLOAD_ENGINE=shadow pnpm test:int:sqlite <suite>
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
