#!/usr/bin/env node
/**
 * Builds `packages/engine-rs/dist` for a packed / published install (RUST_PORT.md, "Packaging").
 *
 * In the monorepo the glue imports payload and drizzle internals by relative path
 * (`../../../payload/src/x.js`), so they are the module instances payload itself runs. In an
 * install those paths do not exist. Every specifier that leaves the package is rewritten to the
 * same compiled file of the installed package, reached as a sibling of this package:
 *
 *   <packages>/payload/src/<p>.js       -> <up>/../../payload/dist/<p>.js
 *   <packages>/drizzle/src/<p>.js       -> <up>/../drizzle/dist/<p>.js
 *   <packages>/db-mongodb/src/<p>.js    -> <up>/../db-mongodb/dist/<p>.js
 *   <packages>/payload/node_modules/jose/dist/webapi/util/decode_jwt.js -> jose/jwt/decode
 *   new URL('<rel>/<package>/package.json', import.meta.url)         -> import.meta.resolve('<name>')
 *
 * (`<up>` climbs from the dist file to the package root.) `payload`, `@payloadcms/drizzle` and
 * `@payloadcms/db-mongodb` (optional: mongo only) are peer dependencies, so a package manager places them next to `@payloadcms/engine-rs`: pnpm links
 * peers into the package's own `node_modules` directory, npm / yarn hoist all three to the top
 * level (engine-rs is a direct dependency of an app that opts in). Node resolves the relative
 * specifier to the real path payload's own relative imports load, so error classes, symbols and
 * module state stay shared, and neither package has to export its internals.
 *
 * Any other specifier that leaves the package (e.g. into `test/`) fails the build. Relative
 * specifiers inside the package keep their shape (dist mirrors src), including the addon path
 * `../payload-engine.node`. After emitting, every import of every dist file is checked: relative
 * ones must exist in dist (or be the addon), or be one of the sibling payload / drizzle paths
 * with an existing source; bare ones must be builtins or a declared dependency / peer dependency.
 *
 * The addon (`payload-engine.node`, shipped through `files`) is not built here
 * (`build:native`). The build fails when the addon is missing, older than any Rust input
 * (crates/ sources, the JS helpers compiled into it, Cargo.toml / Cargo.lock), or lacks an
 * export the glue calls (`assertEngineAddon` of the emitted dist/native.js), so `build` followed
 * by `pnpm pack` (whose `prepack` runs `build`) cannot ship a stale addon. `--allow-stale-addon`
 * downgrades that to a warning (glue-only iteration in the monorepo; never for a pack).
 *
 *   node packages/engine-rs/scripts/buildDist.mjs [--list] [--allow-stale-addon] [--addon file]
 *
 * --list               also print every payload / drizzle internal module the dist imports
 * --allow-stale-addon  only warn when the addon is missing, stale, or lacks an export
 * --addon              check this file instead of payload-engine.node (the check's own tests)
 */
import { transformSync } from '@swc/core'
import fs from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = path.resolve(packageDir, '..')
const srcDir = path.join(packageDir, 'src')
const distDir = path.join(packageDir, 'dist')
const isList = process.argv.includes('--list')
const isAllowStaleAddon = process.argv.includes('--allow-stale-addon')
const addonOption = process.argv.indexOf('--addon')
const addonFile =
  addonOption === -1
    ? path.join(packageDir, 'payload-engine.node')
    : path.resolve(process.argv[addonOption + 1])

const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
const declaredPeers = new Set(Object.keys(packageJson.peerDependencies ?? {}))
const declaredDependencies = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
])

const payloadPackageJson = path.join(packagesDir, 'payload', 'package.json')
const joseDecodeJwt = path.join(
  packagesDir,
  'payload',
  'node_modules',
  'jose',
  'dist',
  'webapi',
  'util',
  'decode_jwt.js',
)

const errors = []
const internals = new Set()

/**
 * Install layout the sibling specifiers are computed in: this package is
 * `node_modules/@payloadcms/engine-rs`, its peers `node_modules/payload` and
 * `node_modules/@payloadcms/drizzle`.
 */
const installRoot = '/node_modules'
const installedPackage = path.posix.join(installRoot, '@payloadcms/engine-rs')

/**
 * Workspace packages whose internals the glue imports: each must be a peer dependency, so it is
 * installed as a sibling (`installed`) of this package.
 */
const siblings = [
  { dir: 'payload', name: 'payload' },
  { dir: 'drizzle', name: '@payloadcms/drizzle' },
  { dir: 'db-mongodb', name: '@payloadcms/db-mongodb' },
].map(({ dir, name }) => ({
  installed: path.posix.join(installRoot, name),
  name,
  packageJson: path.join(packagesDir, dir, 'package.json'),
  src: path.join(packagesDir, dir, 'src') + path.sep,
}))

/**
 * The specifier, from the dist file compiled from `sourceFile`, for a resolved file outside this
 * package, or undefined.
 */
const externalSpecifier = (resolved, sourceFile) => {
  const sibling = siblings.find(({ src }) => resolved.startsWith(src))
  if (sibling) {
    return siblingSpecifier(sourceFile, sibling.installed, resolved.slice(sibling.src.length))
  }
  if (resolved === joseDecodeJwt) {
    assertJoseDecodeJwt()
    return 'jose/jwt/decode'
  }
  return undefined
}

/** `<rel>/<installedRoot>/dist/<file>` relative to the installed dist file of `sourceFile`. */
const siblingSpecifier = (sourceFile, installedRoot, file) => {
  const installedDistFile = path.posix.join(
    installedPackage,
    'dist',
    toPosix(path.relative(srcDir, sourceFile)),
  )
  return path.posix.relative(
    path.posix.dirname(installedDistFile),
    path.posix.join(installedRoot, 'dist', toPosix(file)),
  )
}

/** The monorepo source of a sibling specifier in the dist file `distFile`, or undefined. */
const siblingSource = (distFile, specifier) => {
  const installed = path.posix.join(
    path.posix.dirname(
      path.posix.join(installedPackage, toPosix(path.relative(packageDir, distFile))),
    ),
    specifier,
  )
  for (const sibling of siblings) {
    const prefix = `${sibling.installed}/dist/`
    if (installed.startsWith(prefix)) {
      return { file: installed.slice(prefix.length), name: sibling.name, sourceDir: sibling.src }
    }
  }
  return undefined
}

const sourceFiles = listFiles(srcDir).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.d.ts') && !/\.(spec|test)\.ts$/.test(file),
)
if (sourceFiles.length === 0) {
  throw new Error(`no sources under ${srcDir}`)
}

fs.rmSync(distDir, { force: true, recursive: true })

for (const file of sourceFiles) {
  const fileDir = path.dirname(file)
  const relative = path.relative(packageDir, file)
  let source = fs.readFileSync(file, 'utf8')

  source = source.replace(
    /new URL\(\s*(['"])(\.\.?\/[^'"\n]*)\1\s*,\s*import\.meta\.url\s*\)/g,
    (match, _quote, specifier) => {
      const resolved = path.resolve(fileDir, specifier)
      const sibling = siblings.find(({ packageJson }) => packageJson === resolved)
      if (sibling) {
        if (!declaredPeers.has(sibling.name)) {
          errors.push(
            `${relative}: ${sibling.name} is not a peer dependency of ${packageJson.name}`,
          )
        }
        return `import.meta.resolve('${sibling.name}')`
      }
      if (!isInside(packageDir, resolved)) {
        errors.push(`${relative}: ${match} leaves the package`)
      }
      return match
    },
  )

  source = source.replace(/(['"])(\.\.?\/[^'"\n]*)\1/g, (match, quote, specifier) => {
    const resolved = path.resolve(fileDir, specifier)
    if (isInside(packageDir, resolved)) {
      return match
    }
    const replacement = externalSpecifier(resolved, file)
    if (replacement === undefined) {
      errors.push(`${relative}: '${specifier}' resolves outside the package (${resolved})`)
      return match
    }
    return `${quote}${replacement}${quote}`
  })

  const { code } = transformSync(source, {
    filename: file,
    jsc: {
      parser: { syntax: 'typescript' },
      target: 'esnext',
    },
    module: { type: 'es6' },
    sourceMaps: false,
    swcrc: false,
  })

  const out = path.join(distDir, path.relative(srcDir, file)).replace(/\.ts$/, '.js')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, code)
}

for (const file of listFiles(distDir)) {
  checkImports(file)
}

if (errors.length > 0) {
  fs.rmSync(distDir, { force: true, recursive: true })
  console.error(`engine-rs dist build failed:\n  ${errors.join('\n  ')}`)
  process.exit(1)
}

console.log(`engine-rs: ${sourceFiles.length} modules -> ${path.relative(process.cwd(), distDir)}`)
await checkAddon()
if (isList) {
  console.log([...internals].sort().join('\n'))
}

function checkImports(file) {
  const code = fs.readFileSync(file, 'utf8')
  const relative = path.relative(packageDir, file)
  const specifiers = [
    ...code.matchAll(/(?:^|[\s;}])(?:import|export)\s[^'"]*?\sfrom\s*(['"])([^'"]+)\1/g),
    ...code.matchAll(/(?:^|[\s;])import\s*(['"])([^'"]+)\1/g),
    ...code.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g),
  ].map((match) => match[2])

  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), specifier)
      if (isInside(packageDir, resolved)) {
        if (!fs.existsSync(resolved)) {
          errors.push(`${relative}: '${specifier}' does not exist in dist`)
        }
        continue
      }
      const sibling = siblingSource(file, specifier)
      if (!sibling) {
        errors.push(`${relative}: '${specifier}' leaves the package`)
        continue
      }
      internals.add(`${sibling.name}/dist/${sibling.file}`)
      checkSource(relative, specifier, sibling.sourceDir, sibling.file)
      continue
    }
    if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
      continue
    }
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]
    if (!declaredDependencies.has(name)) {
      errors.push(`${relative}: '${specifier}' is not a declared dependency of ${packageJson.name}`)
    }
  }
}

/** A sibling `<package>/dist/a/b.js` must be compiled from `packages/<package>/src/a/b.ts(x)`. */
function checkSource(relative, specifier, sourceDir, file) {
  const base = path.join(sourceDir, file).replace(/\.js$/, '')
  if (!['.ts', '.tsx', '.js'].some((extension) => fs.existsSync(base + extension))) {
    errors.push(`${relative}: '${specifier}' has no source under ${sourceDir}`)
  }
}

/** `jose/jwt/decode` must be the file payload's copy resolves, with the version payload pins. */
function assertJoseDecodeJwt() {
  const joseDir = path.join(packagesDir, 'payload', 'node_modules', 'jose')
  const jose = JSON.parse(fs.readFileSync(path.join(joseDir, 'package.json'), 'utf8'))
  const target = path.resolve(joseDir, jose.exports['./jwt/decode'].default)
  if (target !== joseDecodeJwt) {
    errors.push(`jose/jwt/decode resolves to ${target}, not ${joseDecodeJwt}`)
  }
  const payloadJose = createRequire(payloadPackageJson)('./package.json').dependencies.jose
  if (packageJson.dependencies?.jose !== payloadJose) {
    errors.push(
      `engine-rs must depend on jose@${payloadJose} (payload's), not ${packageJson.dependencies?.jose}`,
    )
  }
}

/**
 * The shipped addon must exist, be newer than every Rust input it is built from, and have every
 * export the emitted glue calls (`assertEngineAddon` of dist/native.js, the check the glue itself
 * runs at load).
 */
async function checkAddon() {
  const addon = addonFile
  const rootDir = path.resolve(packagesDir, '..')
  let problem
  if (!fs.existsSync(addon)) {
    problem = `${path.relative(rootDir, addon)} is missing (run build:native)`
  } else {
    const addonTime = fs.statSync(addon).mtimeMs
    const newer = [
      path.join(rootDir, 'Cargo.lock'),
      path.join(rootDir, 'Cargo.toml'),
      ...listFiles(path.join(rootDir, 'crates')).filter((file) => /\.(rs|toml|c|h|js)$/.test(file)),
    ].find((file) => fs.existsSync(file) && fs.statSync(file).mtimeMs > addonTime)
    if (newer) {
      problem = `${path.relative(rootDir, addon)} is older than ${path.relative(rootDir, newer)} (run build:native)`
    } else {
      try {
        const { assertEngineAddon } = await import(
          pathToFileURL(path.join(distDir, 'native.js')).href
        )
        assertEngineAddon({ addon: createRequire(import.meta.url)(addon), addonPath: addon })
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error)
      }
    }
  }
  if (!problem) {
    console.log(`engine-rs: addon ${path.relative(rootDir, addon)} is current`)
    return
  }
  if (!isAllowStaleAddon) {
    console.error(`engine-rs addon check failed: ${problem} (--allow-stale-addon to only warn)`)
    process.exit(1)
  }
  console.warn(`engine-rs: warning: ${problem}`)
}

function isInside(dir, file) {
  const relative = path.relative(dir, file)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((entry) => (entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []))
}

function toPosix(file) {
  return file.split(path.sep).join('/')
}
