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

## Packaging

How the engine reaches a real install (`npm i payload @payloadcms/db-sqlite ...`) with no API
change. Users set `PAYLOAD_ENGINE=rs` and nothing else. Verified by
`node test/__rs/packaging/run.mjs`. That script packs the packages, installs them into an app
under `/tmp`, and runs a Local API scenario twice with `PAYLOAD_ENGINE` unset and twice with
`PAYLOAD_ENGINE=rs`. Each `rs` run is diffed exactly against both TS runs. See
`packages/engine-rs/README.md`.

### What breaks in a built install today

1. **`@payloadcms/engine-rs` exported `src/*.ts`.** `@payloadcms/db-sqlite` imports it statically
   (`withRustEngine`, `isRustEngineAdapter`, `createClient`), so every sqlite user loads it, even
   with `PAYLOAD_ENGINE` unset. Node refuses `.ts` under `node_modules`
   (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). It was also `private`, so `script:pack --all`
   and the release skip it, and db-sqlite's dependency on it cannot be installed. Fixed in
   engine-rs: `dist` build, `publishConfig.exports`, `files`. `private` is still to do (see below).
2. **engine-rs imports payload / drizzle internals by monorepo path.** `../../../payload/src/**`
   (121 modules) and `../../../drizzle/src/**` (4 modules, including the
   `InternalBlockTableNameIndex` symbol) are not in an install, and neither package exports them.
   The identity of these modules matters: error classes, symbols and the hook modules' state are
   shared. Fixed in the engine-rs build: these paths are rewritten to `payload/internal/*` and
   `@payloadcms/drizzle/internal/*`. Those packages must export that subpath (edit B). Two more
   imports are rewritten the same way: payload's `jose` file, imported by path, and
   `bson-objectid` resolved through `payload/package.json`.
3. **payload / richtext-lexical import engine-rs by monorepo path.** In `dist`,
   `'../../../../engine-rs/src/ops/index.js'` resolves to `node_modules/engine-rs/src/...`. That
   path does not exist: the package is scoped and ships no `src`. `validations.ts`'s default
   addon `'../../../engine-rs/payload-engine.node'` breaks the same way. With `PAYLOAD_ENGINE=rs`,
   `import 'payload'` throws `Cannot find module '../../../engine-rs/payload-engine.node'`
   (edit A).
4. With `PAYLOAD_ENGINE` unset, a sqlite install also fails without edit B:
   `ERR_PACKAGE_PATH_NOT_EXPORTED './internal/errors/APIError.js'`. The cause is that db-sqlite
   always loads engine-rs's adapter module.

### Edit A: dispatch by package name (core / validate / lexical owners)

Each line keeps its `import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)` and only
changes the string:

| old specifier                                     | new specifier                                 | files (line)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'../../../../engine-rs/src/ops/index.js'`        | `'@payloadcms/engine-rs/ops'`                 | `packages/payload/src/collections/operations/`: count.ts:126, countVersions.ts:120, docAccess.ts:78, find.ts:410, findByID.ts:420, findDistinct.ts:371, findVersionByID.ts:291, findVersions.ts:289                                                                                                                                                                                                                                                         |
| `'../../../engine-rs/src/ops/index.js'`           | `'@payloadcms/engine-rs/ops'`                 | `packages/payload/src/auth/executeAccess.ts:66`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `'../../../../engine-rs/src/ops-write/index.js'`  | `'@payloadcms/engine-rs/ops-write'`           | `packages/payload/src/collections/operations/`: create.ts:749, delete.ts:597, deleteByID.ts:376, duplicate.ts:39, restoreVersion.ts:490, update.ts:572, updateByID.ts:430, validate.ts:233                                                                                                                                                                                                                                                                  |
| `'../../../../engine-rs/src/ops-global/index.js'` | `'@payloadcms/engine-rs/ops-global'`          | `packages/payload/src/globals/operations/`: countGlobalVersions.ts:110, docAccess.ts:61, findOne.ts:300, findVersionByID.ts:206, findVersions.ts:210, restoreVersion.ts:292, update.ts:695, validate.ts:224; `packages/payload/src/auth/operations/`: access.ts:33, auth.ts:62, forgotPassword.ts:305, init.ts:43, login.ts:437, logout.ts:121, me.ts:125, refresh.ts:215, registerFirstUser.ts:141, resetPassword.ts:333, unlock.ts:166, verifyEmail.ts:91 |
| `'../../../../../engine-rs/src/runtime/hooks.js'` | `'@payloadcms/engine-rs/runtime/hooks'`       | `packages/payload/src/fields/hooks/`: afterChange/index.ts:35, afterRead/index.ts:44, beforeChange/index.ts:44, beforeDuplicate/index.ts:26, beforeValidate/index.ts:33                                                                                                                                                                                                                                                                                     |
| `'../../engine-rs/src/runtime/hooks.js'`          | `'@payloadcms/engine-rs/runtime/hooks'`       | `packages/richtext-lexical/src/hooks.ts:29`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `'../../../engine-rs/payload-engine.node'`        | `'@payloadcms/engine-rs/payload-engine.node'` | `packages/payload/src/fields/validations.ts:1118` (the `createRequire(import.meta.url)` default)                                                                                                                                                                                                                                                                                                                                                            |

The line numbers are from `32d3954` plus the working tree on 2026-11-01. Check them with
`grep -rn "engine-rs/src\|engine-rs/payload-engine" packages/payload/src packages/richtext-lexical/src`.
The result must be empty afterwards.

### Edit B: manifests, then `pnpm install`

- `packages/payload/package.json`:
  - add `"@payloadcms/engine-rs": "workspace:*"` to `dependencies`.
  - add `"./internal/*": { "import": "./dist/*", "default": "./dist/*" }` to
    `publishConfig.exports`. The dev `exports` stays as it is, because engine-rs `src` keeps its
    relative imports.
- `packages/drizzle/package.json`: add the same `"./internal/*"` entry to
  `publishConfig.exports`.
- `packages/richtext-lexical/package.json`: add `"@payloadcms/engine-rs": "workspace:*"` to
  `dependencies`.
- Run `pnpm install`. It links `@payloadcms/engine-rs` into `packages/payload/node_modules` and
  `packages/richtext-lexical/node_modules`, which edit A needs in the monorepo. It also records
  the new engine-rs dependencies (`@payloadcms/drizzle`, `jose`, optional peer `@libsql/client`)
  in the lockfile. Until then, `--frozen-lockfile` reports the lockfile as outdated.

engine-rs depends on `@payloadcms/drizzle` and peer-depends on `payload`. They are not
peer-resolved, so pnpm keeps one engine-rs instance whether payload, db-sqlite or
richtext-lexical pulls it in. That instance shares payload's and drizzle's modules: `run.mjs`
fails if any Payload package resolves from more than one place. `jose` is pinned to payload's
version (`buildDist.mjs` checks this), so `jose/jwt/decode` is the same file payload loads.

### Release (release owner)

- Remove `"private": true` from `packages/engine-rs/package.json`. Add `'engine-rs'` to
  `tools/releaser/src/lib/publishList.ts` ahead of its dependents (payload, db-sqlite,
  richtext-lexical) and after `drizzle`. `publishList.spec.ts` fails if only one of the two
  changes lands.
- `test/setupProd.ts`: add `'@payloadcms/engine-rs': 'payloadcms-engine-rs-*'` to
  `tgzToPkgNameMap`. Also make the overrides cover transitive packed packages. Otherwise
  `prepare-run-test-against-prod` installs db-sqlite's `@payloadcms/engine-rs` from the registry.
- The addon: the tarball ships the one `payload-engine.node` for the build machine. Releasing
  needs napi per-platform packages, i.e. optional dependencies plus a loader that picks
  `process.platform` / `process.arch`. Every loader must agree on one path: `native.ts`,
  `sqlite/native.ts`, the bindings in `runtime/`, `ops*/`, `query/` and `validate/`, plus
  payload's `validations.ts`.

### Not covered yet

- Next.js. `next dev` externalizes payload, db-sqlite and drizzle but bundles richtext-lexical.
  `next build` bundles payload too (`payload/build-config`). A bundled payload cannot share its
  internals with an external engine-rs: there would be two payload instances. So with
  `PAYLOAD_ENGINE=rs`, `withPayload` will have to externalize payload, drizzle, db-sqlite and
  engine-rs, or let the bundler see literal engine-rs imports. Under pnpm, the bundled
  richtext-lexical's runtime `import('@payloadcms/engine-rs/runtime/hooks')` from `.next/` only
  resolves when engine-rs is hoisted. A simpler design: payload's exported `*TraverseFields`
  dispatch, and richtext-lexical drops its own dispatch. This is unverified.
- npm / yarn hoisted layouts are expected to work (single top-level copies) but have not been
  run.
- `PAYLOAD_ENGINE_ADDON` / `PAYLOAD_CORE_RUNTIME_ADDON` are resolved by each loader relative to
  its own module, not the cwd. Pass absolute paths.
