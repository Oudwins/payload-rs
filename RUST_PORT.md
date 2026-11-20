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

How the engine reaches a real install with no API change, and why users who never opt in get
exactly upstream. Opting in is two steps: install `@payloadcms/engine-rs` next to `payload` and
set `PAYLOAD_ENGINE=rs`.

### The default path (`PAYLOAD_ENGINE` and `PAYLOAD_CORE_ENGINE` unset)

- No package imports `@payloadcms/engine-rs` statically, and nothing of it is evaluated or awaited.
  Every dispatch site loads it only when the flag selects Rust, by a runtime `import()` of a
  computed specifier carrying `/* @vite-ignore */ /* webpackIgnore: true */`, so bundlers see
  neither a literal nor a context module. With the flag unset the exported function is the
  upstream TS one.
- Resolution is package-local at runtime: each site resolves the engine-rs subpath from where its
  own package is installed (`createRequire(<package.json>).resolve(...)`, then `import()` of that
  file URL). The package is located from `import.meta.url` only when the nearest package.json above
  it is that package's (a bundled module's `import.meta.url` is a chunk or a build-time path);
  otherwise it is looked up in `node_modules` from the working directory up. This fixes bundled
  Next.js (Turbopack / webpack chunks under `.next`, e.g. test/hmr, where a bare runtime import
  resolved from the chunk: "Cannot find package '@payloadcms/engine-rs' imported from
  .next/dev/server/chunks/packages_db-mongodb_src_*.js").
- The sites:
  - payload: `@payloadcms/engine-rs/ops` (collection read operations, `auth/executeAccess.ts`),
    `/ops-write` (collection write operations), `/ops-global` (global and auth operations),
    `/runtime/hooks` (`fields/hooks/*/index.ts`): each loads `utilities/importRustEngine.ts` by a
    literal dynamic import, only on the Rust path (never evaluated otherwise). The addon
    `@payloadcms/engine-rs/payload-engine.node` (`fields/validations.ts`, synchronous, through
    `process.getBuiltinModule`, the same package-local resolution inlined).
  - richtext-lexical: `@payloadcms/engine-rs/runtime/hooks` (`hooks.ts`).
  - db-sqlite: `@payloadcms/engine-rs/adapter` and `/sqlite`; db-mongodb:
    `@payloadcms/engine-rs/mongodb`. Neither loads the engine root, so a SQLite-only install never
    reaches the MongoDB engine (whose `mongo-live` imports db-mongodb internals). The load starts
    when the adapter module is evaluated. `config.db.init` is synchronous: once the module has
    loaded, the adapter object's `init` is exactly `withRustEngine(obj).init` /
    `withRustMongoEngine(obj).init` (as before the runtime import); before that, the built
    adapter's `init` installs the engine when payload awaits it (before `connect` and any data
    method) and forwards to the engine's `init` for that and every later call; a consumer wrapper
    of the adapter's `init` is kept (it reaches the engine through the function it wrapped).
  - db-sqlite `connect` picks the Rust libsql client through a function db-sqlite's own rs path
    registers (`setRustEngineClient`): unset, `connect` runs upstream's `createClient` with nothing
    read or awaited first. Only when engine-rs is loaded in the process (its `native.ts` sets
    `globalThis[Symbol.for('@payloadcms/engine-rs')]`) and the adapter's `init` is not drizzle's
    does it ask engine-rs (harnesses that call `withRustEngine` themselves).
- `withPayload` (packages/next): with `PAYLOAD_ENGINE=rs` or `PAYLOAD_CORE_ENGINE=rs`, the
  server-only Payload packages (payload, drizzle, the db adapters, ...) stay external in production
  too (as in development), so the engine, loaded by Node, shares payload's / drizzle's module
  instances (error classes, symbols, module state) with the app. richtext-lexical stays bundled
  (client components) and imports the external payload. Unset: unchanged.
- Manifests: `@payloadcms/engine-rs` is an **optional peer dependency** of payload,
  richtext-lexical, db-sqlite and db-mongodb, and nothing else differs from upstream (no
  devDependency either: published manifests keep devDependencies). Nothing installs it for users
  who do not ask for it; when they do, pnpm links it into each of those packages, npm / yarn hoist
  it. In the monorepo, pnpm (`autoInstallPeers: true`) installs every peer of a workspace project,
  optional ones included, as a dependency, so the four packages link `packages/engine-rs`.
- engine-rs has no dependency on a workspace package: `payload` and `@payloadcms/drizzle` are
  peers, `@payloadcms/db-mongodb` (internals used by `src/mongo-live`) and `@libsql/client`
  optional peers, `jose` (payload's version) its only dependency. pnpm reports the cyclic workspace
  peer db-mongodb <-> engine-rs as a warning; turbo ignores peers (no build cycle).
- `pnpm-lock.yaml` lists the `packages/engine-rs` importer and the auto-installed engine-rs peer
  of the four packages. `node test/__rs/packaging/lockfileCheck.mjs [--self-test]` checks every
  importer against its manifest the way `pnpm install --frozen-lockfile` does (verified also with
  pnpm 10.24 `install --frozen-lockfile --lockfile-only --offline` on a copy of the manifests).

Checked by `node test/__rs/default-path/check.mjs [--upstream ec35164]`: walks the module graph
of every workspace package from its entry points, over `src` (dev exports) and over `dist`
(`publishConfig.exports`), across workspace packages, following import / export declarations,
literal `import()` / `require()` / `createRequire()()` and `new URL(..., import.meta.url)`. It
fails if engine-rs or its addon is reachable, if a non-literal `import()` in a module that names
engine-rs lacks `webpackIgnore`, if a dist file is older than its source, if engine-rs is a
dependency or a required peer anywhere, or (with `--upstream`) if any manifest field users or the
packed tarball see (including `devDependencies`) differs from upstream except for the optional
peer. `--self-test` is the negative control. `test/__rs/default-path/switch.int.spec.ts`: the
adapter switch (unset `connect` timing with a replaced `init`, consumer `init` wrappers kept, the
synchronous `init` once loaded, the Rust client only for the engine adapter), against stubbed
engine modules; the previous implementation fails 6 of its 7 tests.

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
- The tarball ships `dist/` and `payload-engine.node` (`files`), no `src/`; `publishConfig` points
  `main` / `exports` at `dist`; no `types`. The addon is built by `build:native` (honours
  `CARGO_TARGET_DIR`), not by `build`; `build` (and so `pack`) **fails** when the addon is
  missing, older than any Rust input (`crates/**` .rs / .toml / .c / .h / .js helpers,
  `Cargo.toml`, `Cargo.lock`), or lacks an export the glue calls. `--allow-stale-addon` only warns
  (glue-only iteration; never for a pack).
- Addon API check: `src/native.ts` `engineAddonExports` lists every addon export some engine-rs
  loader (or payload's `validations.ts`) calls; `assertEngineAddon` (run by `getNativeEngine()`
  and by buildDist on the emitted dist) throws "does not match @payloadcms/engine-rs: it lacks
  ..." for an addon built from an older tree. Each binding additionally checks its own
  `apiVersion`; the live MongoDB glue requires every `mongoLive*Binding` (no stage-1 fallback on
  `PAYLOAD_ENGINE=rs`).

### Verification

- `node test/__rs/packaging/run.mjs [--addon file] [--keep]`: packs translations, payload,
  drizzle, db-sqlite, db-mongodb, ui, richtext-lexical and engine-rs with `pnpm pack` as is
  (`--addon` only swaps the addon file) and installs them into apps under `.rs-runs/packaging/work`
  (modules resolved from the monorepo outside it are failures). Phase 1 installs without engine-rs
  and must contain no engine-rs at all; the scenario runs twice per database with the flag unset.
  Phase 2 runs `pnpm add @payloadcms/engine-rs`; every dispatching package must resolve the same
  copy; the scenario runs once more unset and twice with `PAYLOAD_ENGINE=rs`. Phase 3 installs
  payload, db-sqlite, richtext-lexical and engine-rs without db-mongodb and runs the sqlite
  scenario with `PAYLOAD_ENGINE=rs` (no MongoDB module may load). Every rs run must equal every
  unset run of its database (`compare.mjs`), load the engine-rs dist entries its adapter uses and
  the packaged addon, and show Rust calls in every part; unset runs must resolve nothing of
  engine-rs and write no stats. `RS_PACKAGING_PNPM=<pnpm.cjs>` selects the package manager (the
  registry mirror being down, a pnpm 10 with a public-registry npmrc was used).
- `node test/__rs/packaging/nextDev.mjs [--database sqlite|mongodb] [--prod]` (after `run.mjs
  --keep`): the same install under `next dev` (Turbopack), or `next build` + `next start` with
  `--prod`: two runs unset, one with `PAYLOAD_ENGINE=rs`; outputs compared, Rust calls required
  (including `afterReadTraverseFields` forwarded by the bundled richtext-lexical), no engine-rs
  code or `.node` file in `.next`, and every rs run must see one payload instance (the route's
  `ValidationError` is the installed payload's, which engine-rs uses).
- `node test/__rs/default-path/check.mjs --upstream ec35164` and `--self-test` (see above);
  `node test/__rs/packaging/lockfileCheck.mjs [--self-test]`.

### Not covered yet

- Release (release owner): remove `"private": true` from engine-rs, add it to
  `tools/releaser/src/lib/publishList.ts` (after drizzle, before its dependents) and to
  `test/setupProd.ts`'s `tgzToPkgNameMap`; per-platform addon packages (napi optional
  dependencies plus a loader on `process.platform` / `process.arch`) instead of the single
  build-machine addon; every addon loader must agree on one path (`native.ts`, `sqlite/native.ts`,
  `runtime/`, `ops*/`, `query/`, `validate/` and payload's `validations.ts`).
- npm / yarn layouts and other platforms than macOS arm64 have not been run.
- `PAYLOAD_ENGINE_ADDON` / `PAYLOAD_CORE_RUNTIME_ADDON` are resolved by each engine-rs loader
  relative to its own module (payload's `validations.ts`: relative to the cwd). Pass absolute
  paths.
- A consumer that replaces the adapter's `init` without calling the previous one, before the
  engine module has loaded, gets the upstream adapter (the engine is installed through that
  function); once loaded, `init` is synchronous and this cannot happen.
