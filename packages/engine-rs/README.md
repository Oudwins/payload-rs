# @payloadcms/engine-rs

Rust implementation of the Payload engine (SQL engine, field hooks, validators, collection /
global / auth operations), loaded as a Node addon. It has no API of its own: users keep using
`payload`, `@payloadcms/db-sqlite` and `@payloadcms/richtext-lexical` as upstream and select the
engine with `PAYLOAD_ENGINE=rs` (see `RUST_PORT.md` at the repo root).

## Layout

```
payload-engine.node   the napi addon (crates/payload-node), git-ignored
src/                  TS glue, run from source inside the monorepo
dist/                 build output for packed / published installs (scripts/buildDist.mjs)
scripts/              build and verification scripts
```

## Entry points

| export                  | module                 | used by                                    |
| ----------------------- | ---------------------- | ------------------------------------------ |
| `.`                     | `index`                | `@payloadcms/db-sqlite` (`withRustEngine`) |
| `./adapter`             | `adapter/index`        |                                            |
| `./sqlite`              | `sqlite/libsql`        | `@payloadcms/db-sqlite` (`createClient`)   |
| `./shadow`              | `shadow/index`         | `PAYLOAD_ENGINE=shadow` harness            |
| `./runtime`             | `runtime/index`        |                                            |
| `./runtime/hooks`       | `runtime/hooks`        | payload field hooks, richtext-lexical      |
| `./ops`                 | `ops/index`            | payload collection read operations         |
| `./ops-write`           | `ops-write/index`      | payload collection write operations        |
| `./ops-global`          | `ops-global/index`     | payload global and auth operations         |
| `./query`               | `query/index`          | `./ops`                                    |
| `./validate`            | `validate/validations` | harnesses                                  |
| `./validate/native`     | `validate/native`      |                                            |
| `./payload-engine.node` | the addon              | payload `fields/validations`               |

In the monorepo every export points at `src/*.ts`. `publishConfig.exports` points at `dist/*.js`.
`pnpm pack` / `pnpm publish` apply it.

## Building

```sh
pnpm --filter @payloadcms/engine-rs build:native   # cargo build -p payload-node -> payload-engine.node
pnpm --filter @payloadcms/engine-rs build          # src -> dist (scripts/buildDist.mjs)
```

In the monorepo the glue imports payload and drizzle internals by relative path
(`../../../payload/src/...`). That way they are the same module instances payload itself runs.
`buildDist.mjs` compiles `src` with swc and rewrites every specifier that leaves the package to
the same file of the installed package:

- `payload/src/<p>.js` becomes `payload/internal/<p>.js`
- `drizzle/src/<p>.js` becomes `@payloadcms/drizzle/internal/<p>.js`
- payload's `jose` file becomes `jose/jwt/decode`
- `new URL('../../../payload/package.json', import.meta.url)` becomes `import.meta.resolve('payload')`

Any other escape, for example into `test/`, fails the build. So does an import of an undeclared
package, or a `payload/internal/*` path with no source. `--list` prints every payload / drizzle
internal that the dist imports.

The tarball ships `dist/` and `payload-engine.node`, and no `src/`. The addon is built for the
platform that ran the build: only macOS arm64 so far, with no per-platform packages yet.

## Verifying a packed install

```sh
node test/__rs/packaging/run.mjs --addon <fresh payload-engine.node>
```

This script packs payload, translations, drizzle, engine-rs, db-sqlite, ui and richtext-lexical and
installs them into an app under `/tmp`. It then runs a Local API scenario twice with
`PAYLOAD_ENGINE` unset and twice with `PAYLOAD_ENGINE=rs`, and compares the outputs. Until the
edits listed in `RUST_PORT.md` ("Packaging") land, it applies them to the packed tarballs and
reports them as `simulated`. `--no-simulate` shows what breaks without them.
