#!/usr/bin/env node
/**
 * Packs the npm tarballs of a release: the Payload packages (as `pnpm pack` produces them from the
 * built monorepo), `@payloadcms/engine-rs` without an addon, and one `@payloadcms/engine-rs-<platform>`
 * package per prebuilt addon (napi-rs layout: `os` / `cpu` / `libc` select the one npm, pnpm and yarn
 * install; `addon.cjs` loads it).
 *
 *   node packages/engine-rs/scripts/release/packRelease.mjs --addons <dir> [--out <dir>]
 *     [--packages payload,db-mongodb,...] [--pnpm <pnpm.cjs>]
 *
 * --addons    directory with `<platform>/payload-engine.node` per platform (the CI build matrix
 *             artifacts, e.g. `linux-x64-gnu/payload-engine.node`); every platform found becomes a
 *             platform package and an optional dependency of engine-rs
 * --out       output directory (default .rs-runs/release); tarballs plus `release.json`
 * --packages  package directories under packages/ (default: every package of the releaser's
 *             publish list, tools/releaser/src/lib/publishList.ts, plus engine-rs)
 *
 * Requires built dists (`pnpm build:all`, or `build:core` for the core packages). engine-rs's own
 * `prepack` (buildDist) checks the addon in packages/engine-rs: one of the `--addons` addons for
 * this machine's platform is copied there first, so the dist check runs against a release addon.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const engineDir = path.resolve(here, '../..')
const root = path.resolve(engineDir, '../..')
const engineName = '@payloadcms/engine-rs'

/** napi-rs platform suffixes (`addon.cjs` `platformSuffix`) and the npm fields selecting each. */
export const platforms = {
  'darwin-arm64': { cpu: ['arm64'], os: ['darwin'], rustTarget: 'aarch64-apple-darwin' },
  'darwin-x64': { cpu: ['x64'], os: ['darwin'], rustTarget: 'x86_64-apple-darwin' },
  'linux-arm64-gnu': {
    cpu: ['arm64'],
    libc: ['glibc'],
    os: ['linux'],
    rustTarget: 'aarch64-unknown-linux-gnu',
  },
  'linux-arm64-musl': {
    cpu: ['arm64'],
    libc: ['musl'],
    os: ['linux'],
    rustTarget: 'aarch64-unknown-linux-musl',
  },
  'linux-x64-gnu': {
    cpu: ['x64'],
    libc: ['glibc'],
    os: ['linux'],
    rustTarget: 'x86_64-unknown-linux-gnu',
  },
  'linux-x64-musl': {
    cpu: ['x64'],
    libc: ['musl'],
    os: ['linux'],
    rustTarget: 'x86_64-unknown-linux-musl',
  },
  'win32-arm64-msvc': { cpu: ['arm64'], os: ['win32'], rustTarget: 'aarch64-pc-windows-msvc' },
  'win32-x64-msvc': { cpu: ['x64'], os: ['win32'], rustTarget: 'x86_64-pc-windows-msvc' },
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const option = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const addonsDir = option('--addons')
  if (!addonsDir) {
    throw new Error('--addons <dir> is required (a directory of <platform>/payload-engine.node)')
  }
  const result = packRelease({
    addons: findAddons({ dir: path.resolve(addonsDir) }),
    outDir: path.resolve(option('--out') ?? path.join(root, '.rs-runs/release')),
    packageDirs: option('--packages')?.split(','),
    pnpm: option('--pnpm'),
  })
  console.log(JSON.stringify(result, null, 2))
}

/** `{ <platform>: <addon file> }` for every `<dir>/<platform>/payload-engine.node`. */
export function findAddons({ dir }) {
  const addons = {}
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry, 'payload-engine.node')
    if (fs.existsSync(file)) {
      if (!platforms[entry]) {
        throw new Error(`${file}: unknown platform ${entry} (one of ${Object.keys(platforms)})`)
      }
      addons[entry] = file
    }
  }
  if (Object.keys(addons).length === 0) {
    throw new Error(`no <platform>/payload-engine.node under ${dir}`)
  }
  return addons
}

/**
 * Packs everything into `outDir` and writes `release.json` (`{ tarballs: { <name>: <file> } }`).
 * Returns that record.
 */
export function packRelease({ addons, outDir, packageDirs, pnpm }) {
  fs.rmSync(outDir, { force: true, recursive: true })
  fs.mkdirSync(outDir, { recursive: true })
  const runPnpm = (args, cwd) =>
    pnpm
      ? execFileSync(process.execPath, [pnpm, ...args], { cwd, stdio: 'pipe' })
      : execFileSync('pnpm', args, { cwd, stdio: 'pipe' })
  const tarballs = {}
  for (const [platform, addon] of Object.entries(addons)) {
    const { file, name } = packPlatformPackage({ addon, outDir, platform })
    tarballs[name] = file
  }
  const { file: engineTarball } = packEngine({
    addons,
    optionalDependencies: Object.keys(addons),
    outDir,
    runPnpm,
  })
  tarballs[engineName] = engineTarball
  for (const dir of packageDirs ?? publishListDirs()) {
    if (dir === 'engine-rs') {
      continue
    }
    const file = pnpmPack({ cwd: path.join(root, 'packages', dir), outDir, runPnpm })
    tarballs[readJson(path.join(root, 'packages', dir, 'package.json')).name] = file
  }
  const record = { tarballs, version: engineVersion() }
  fs.writeFileSync(path.join(outDir, 'release.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** `@payloadcms/engine-rs-<platform>`: the addon and a manifest npm installs only on `platform`. */
export function packPlatformPackage({ addon, outDir, platform }) {
  const { rustTarget: _rustTarget, ...selectors } = platforms[platform]
  const engine = readJson(path.join(engineDir, 'package.json'))
  const name = `${engineName}-${platform}`
  const stage = path.join(outDir, '.stage', platform, 'package')
  fs.mkdirSync(stage, { recursive: true })
  fs.copyFileSync(addon, path.join(stage, 'payload-engine.node'))
  fs.writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version: engine.version,
        description: `The ${platform} build of the ${engineName} addon`,
        license: engine.license,
        ...selectors,
        files: ['payload-engine.node'],
        main: './payload-engine.node',
        exports: {
          './payload-engine.node': './payload-engine.node',
          './package.json': './package.json',
        },
      },
      null,
      2,
    )}\n`,
  )
  const file = path.join(outDir, `${name.replace('@', '').replace('/', '-')}-${engine.version}.tgz`)
  execFileSync('tar', ['-czf', file, '-C', path.dirname(stage), 'package'])
  return { file, name }
}

/**
 * `@payloadcms/engine-rs` as published: `pnpm pack` of the package (its prepack builds and checks
 * dist), then the addon removed (it comes from the platform packages), `private` removed and the
 * platform packages added as exact-version optional dependencies.
 */
export function packEngine({ addons, optionalDependencies, outDir, runPnpm }) {
  const local = path.join(engineDir, 'payload-engine.node')
  // a copy first: the host addon may be the local file itself
  const hostAddon = addons[hostPlatform()]
  const hostCopy = path.join(outDir, '.stage', 'host-payload-engine.node')
  fs.mkdirSync(path.dirname(hostCopy), { recursive: true })
  if (hostAddon) {
    fs.copyFileSync(hostAddon, hostCopy)
  }
  const savedLocal = fs.existsSync(local) ? `${local}.release-saved` : undefined
  if (savedLocal) {
    fs.renameSync(local, savedLocal)
  }
  try {
    if (hostAddon) {
      // buildDist checks the addon next to the package (exports the glue calls, newer than sources)
      fs.copyFileSync(hostCopy, local)
    } else if (savedLocal) {
      fs.copyFileSync(savedLocal, local)
    }
    const packed = pnpmPack({ cwd: engineDir, outDir, runPnpm })
    const extract = path.join(outDir, '.stage', 'engine-rs')
    fs.mkdirSync(extract, { recursive: true })
    execFileSync('tar', ['-xzf', packed, '-C', extract])
    const packageDir = path.join(extract, 'package')
    fs.rmSync(path.join(packageDir, 'payload-engine.node'), { force: true })
    const manifestFile = path.join(packageDir, 'package.json')
    const { private: _private, ...manifest } = readJson(manifestFile)
    manifest.files = manifest.files.filter((file) => file !== 'payload-engine.node')
    for (const exports of [manifest.exports, manifest.publishConfig?.exports]) {
      if (exports) {
        delete exports['./payload-engine.node']
      }
    }
    manifest.optionalDependencies = Object.fromEntries(
      optionalDependencies
        .sort()
        .map((platform) => [`${engineName}-${platform}`, manifest.version]),
    )
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    execFileSync('tar', ['-czf', packed, '-C', extract, 'package'])
    return { file: packed }
  } finally {
    fs.rmSync(local, { force: true })
    if (savedLocal) {
      fs.renameSync(savedLocal, local)
    }
  }
}

function pnpmPack({ cwd, outDir, runPnpm }) {
  const before = new Set(fs.readdirSync(outDir))
  runPnpm(['pack', '--pack-destination', outDir], cwd)
  const created = fs
    .readdirSync(outDir)
    .filter((file) => !before.has(file) && file.endsWith('.tgz'))
  if (created.length !== 1) {
    throw new Error(`pnpm pack in ${cwd} produced ${created.join(', ') || 'nothing'}`)
  }
  return path.join(outDir, created[0])
}

/** `addon.cjs`'s platform suffix for this process. */
function hostPlatform() {
  return createRequire(import.meta.url)(path.join(engineDir, 'addon.cjs'))
    .platformPackageName()
    .slice(`${engineName}-`.length)
}

/** Package directories of tools/releaser/src/lib/publishList.ts, in publish order. */
function publishListDirs() {
  const source = fs.readFileSync(path.join(root, 'tools/releaser/src/lib/publishList.ts'), 'utf8')
  const list = source.slice(source.indexOf('packagePublishList'), source.indexOf(']'))
  return [...list.matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1])
}

function engineVersion() {
  return readJson(path.join(engineDir, 'package.json')).version
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
