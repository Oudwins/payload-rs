/**
 * Imports `specifier` (an `@payloadcms/engine-rs` subpath, an optional peer dependency) the way
 * payload resolves it where it is installed. Loaded (by a literal dynamic import) only by the
 * dispatch sites that selected the Rust engine (`isRustCoreEngine()`, the default), so
 * with the flags unset it is never evaluated.
 *
 * When payload is bundled (e.g. Next.js with payload aliased to its sources), a runtime `import()`
 * would resolve from the emitted chunk instead, where engine-rs is usually not installed, and
 * `import.meta.url` may be the chunk's or a build-time path: it is used only when the nearest
 * package.json above it is payload's; otherwise payload is looked up in the `node_modules`
 * directories from the working directory up. The specifier is computed, so bundlers neither trace
 * nor bundle engine-rs.
 */
export function importRustEngine(specifier: string) {
  return import(/* @vite-ignore */ /* webpackIgnore: true */ resolveRustEngine(specifier))
}

/**
 * `specifier` resolved from the installed payload package (a file URL), or `specifier` itself when
 * payload cannot be located or engine-rs is not installed next to it (Node's own resolution then
 * reports it).
 */
function resolveRustEngine(specifier: string): string {
  const fs = process.getBuiltinModule('node:fs')
  const path = process.getBuiltinModule('node:path')
  const { createRequire } = process.getBuiltinModule('node:module')
  const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url')
  const packageName = 'payload'
  const readName = (manifest: string): string | undefined => {
    try {
      return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string }).name
    } catch {
      return undefined
    }
  }
  let manifest: string | undefined
  if (import.meta.url.startsWith('file:')) {
    for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json')
      if (fs.existsSync(candidate)) {
        manifest = readName(candidate) === packageName ? candidate : undefined
        break
      }
      if (dir === path.dirname(dir)) {
        break
      }
    }
  }
  for (let dir = process.cwd(); !manifest; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', packageName, 'package.json')
    if (fs.existsSync(candidate)) {
      manifest = fs.realpathSync(candidate)
    } else if (dir === path.dirname(dir)) {
      break
    }
  }
  if (!manifest) {
    return specifier
  }
  try {
    return pathToFileURL(createRequire(manifest).resolve(specifier)).href
  } catch {
    return specifier
  }
}
