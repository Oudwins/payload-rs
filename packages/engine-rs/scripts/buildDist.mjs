#!/usr/bin/env node
/**
 * Builds `packages/engine-rs/dist` for a packed / published install (see README.md, "Packaging").
 *
 * In the monorepo the glue imports payload and drizzle internals by relative path
 * (`../../../payload/src/x.js`), so they are the module instances payload itself runs. In an
 * install those paths do not exist, so every specifier that leaves this package is rewritten to
 * the same file of the installed package, resolved through its package name:
 *
 *   <packages>/payload/src/<p>.js                                  -> payload/internal/<p>.js
 *   <packages>/drizzle/src/<p>.js                                  -> @payloadcms/drizzle/internal/<p>.js
 *   <packages>/payload/node_modules/jose/dist/webapi/util/decode_jwt.js -> jose/jwt/decode
 *   new URL('<rel>/payload/package.json', import.meta.url)         -> import.meta.resolve('payload')
 *
 * `payload/internal/*` and `@payloadcms/drizzle/internal/*` are `./dist/*` subpath exports of
 * those packages (pending, see RUST_PORT.md "Packaging"). Node resolves them to the real paths
 * payload's own relative imports load, so error classes, symbols and module state stay shared.
 *
 * Any other specifier that leaves the package (e.g. into `test/`) fails the build. Relative
 * specifiers inside the package keep their shape (dist mirrors src), including the addon path
 * `../payload-engine.node`. After emitting, every import of every dist file is checked: relative
 * ones must exist in dist (or be the addon), bare ones must be builtins, `payload`,
 * `payload/internal/*` with an existing `packages/payload/src` source, `@payloadcms/drizzle/internal/*`
 * likewise, or a declared dependency / peer dependency.
 *
 *   node packages/engine-rs/scripts/buildDist.mjs [--list]
 *
 * --list   also print every payload / drizzle internal module the dist imports
 */
import { transformSync } from '@swc/core'
import fs from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = path.resolve(packageDir, '..')
const srcDir = path.join(packageDir, 'src')
const distDir = path.join(packageDir, 'dist')
const isList = process.argv.includes('--list')

const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
const declaredDependencies = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
])

const payloadSrc = path.join(packagesDir, 'payload', 'src') + path.sep
const drizzleSrc = path.join(packagesDir, 'drizzle', 'src') + path.sep
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

/** The package-name specifier for a resolved file outside this package, or undefined. */
const externalSpecifier = (resolved) => {
  if (resolved.startsWith(payloadSrc)) {
    return `payload/internal/${toPosix(resolved.slice(payloadSrc.length))}`
  }
  if (resolved.startsWith(drizzleSrc)) {
    return `@payloadcms/drizzle/internal/${toPosix(resolved.slice(drizzleSrc.length))}`
  }
  if (resolved === joseDecodeJwt) {
    assertJoseDecodeJwt()
    return 'jose/jwt/decode'
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
      if (resolved === payloadPackageJson) {
        return `import.meta.resolve('payload')`
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
    const replacement = externalSpecifier(resolved)
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
      if (!fs.existsSync(resolved)) {
        errors.push(`${relative}: '${specifier}' does not exist in dist`)
      }
      continue
    }
    if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
      continue
    }
    if (specifier.startsWith('payload/internal/')) {
      internals.add(specifier)
      checkSource(relative, specifier, payloadSrc, 'payload/internal/')
      continue
    }
    if (specifier.startsWith('@payloadcms/drizzle/internal/')) {
      internals.add(specifier)
      checkSource(relative, specifier, drizzleSrc, '@payloadcms/drizzle/internal/')
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

/** `payload/internal/a/b.js` must be compiled from `packages/payload/src/a/b.ts(x)`. */
function checkSource(relative, specifier, sourceDir, prefix) {
  const base = path.join(sourceDir, specifier.slice(prefix.length)).replace(/\.js$/, '')
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
