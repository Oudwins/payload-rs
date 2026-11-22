'use strict'
/**
 * The one place the engine addon is located and loaded. Every loader of @payloadcms/engine-rs
 * (`src/**`) and payload's `fields/validations.ts` (synchronously, through `require`) go through
 * this file, so a process loads exactly one addon instance.
 *
 * Plain CommonJS (no TypeScript, no build step): the same file runs from the monorepo sources, from
 * `dist`, and from `require()` in payload.
 *
 * Resolution order:
 * 1. `PAYLOAD_ENGINE_ADDON` (a path, relative to the working directory).
 * 2. `payload-engine.node` next to this file (a local `build:native`).
 * 3. The prebuilt addon of this platform: the optional dependency
 *    `@payloadcms/engine-rs-<platform>` (see `platformPackageName`).
 */
const fs = require('node:fs')
const path = require('node:path')

const ADDON_FILE = 'payload-engine.node'

/** napi-rs style platform suffix (`linux-x64-gnu`, `darwin-arm64`, `win32-x64-msvc`, ...). */
function platformSuffix() {
  const { arch, platform } = process
  if (platform === 'linux') {
    return `linux-${arch}-${isMusl() ? 'musl' : 'gnu'}`
  }
  if (platform === 'win32') {
    return `win32-${arch}-msvc`
  }
  return `${platform}-${arch}`
}

function isMusl() {
  const report = typeof process.report?.getReport === 'function' ? process.report.getReport() : null
  return !report?.header?.glibcVersionRuntime
}

function platformPackageName() {
  return `@payloadcms/engine-rs-${platformSuffix()}`
}

function engineAddonPath() {
  const fromEnv = process.env.PAYLOAD_ENGINE_ADDON
  if (fromEnv) {
    return path.resolve(process.cwd(), fromEnv)
  }
  const local = path.join(__dirname, ADDON_FILE)
  if (fs.existsSync(local)) {
    return local
  }
  const packageName = platformPackageName()
  try {
    return require.resolve(`${packageName}/${ADDON_FILE}`)
  } catch {
    throw new Error(
      `@payloadcms/engine-rs: no engine addon for ${process.platform}-${process.arch}: ${packageName} is not installed (it is an optional dependency of @payloadcms/engine-rs; reinstall without --no-optional) and there is no local build at ${local} (pnpm --filter @payloadcms/engine-rs build:native)`,
    )
  }
}

let addon
let addonPath

/** The engine addon, loaded once per process. */
function loadEngineAddon() {
  if (!addon) {
    addonPath = engineAddonPath()
    addon = require(addonPath)
  }
  return addon
}

/** The path `loadEngineAddon` loaded (or would load). */
function loadedEngineAddonPath() {
  return addonPath ?? engineAddonPath()
}

/**
 * The addon for the core runtime bindings: `PAYLOAD_CORE_RUNTIME_ADDON` (a standalone build of one
 * core crate, e.g. `payload-core-runtime`'s `dev_addon` example or a mutant build) when set, else
 * the engine addon.
 */
function loadCoreRuntimeAddon() {
  const fromEnv = process.env.PAYLOAD_CORE_RUNTIME_ADDON
  return fromEnv ? require(path.resolve(process.cwd(), fromEnv)) : loadEngineAddon()
}

function coreRuntimeAddonPath() {
  const fromEnv = process.env.PAYLOAD_CORE_RUNTIME_ADDON
  return fromEnv ? path.resolve(process.cwd(), fromEnv) : loadedEngineAddonPath()
}

module.exports = {
  coreRuntimeAddonPath,
  engineAddonPath,
  loadCoreRuntimeAddon,
  loadedEngineAddonPath,
  loadEngineAddon,
  platformPackageName,
  platformSuffix,
}
