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
