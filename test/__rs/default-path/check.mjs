#!/usr/bin/env node
/**
 * Static proof that the default path (PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE unset) never reaches
 * `@payloadcms/engine-rs`: for every workspace package (except engine-rs itself) the module graph
 * reachable from its entry points is walked twice, over `src` (the monorepo `exports`) and over
 * `dist` (the published `publishConfig.exports`). Fails when engine-rs or its addon is reachable
 * through anything a bundler or Node follows statically:
 *
 * - `import` / `export ... from` declarations (type-only ones are erased and skipped)
 * - `import('literal')`, `require('literal')`, `createRequire(...)('literal')`
 * - `new URL('literal', import.meta.url)` (asset references bundlers emit)
 *
 * Workspace packages are followed through their package.json `exports` / `imports` (every
 * condition except `types`), so a package's graph includes the payload / drizzle / ui modules it
 * loads. Third-party packages are leaves. A dynamic import with a non-literal specifier is opaque
 * to bundlers and Node's static graph; every such call in a module that mentions
 * `@payloadcms/engine-rs` must carry `webpackIgnore: true` (otherwise webpack builds a context
 * module) and is listed as a guarded runtime-only load.
 *
 * Manifests: `@payloadcms/engine-rs` must not be a dependency / optionalDependency /
 * bundleDependency of any package; as a peer it must be optional. With `--upstream <ref>` the
 * install-relevant manifest fields of every package are compared with upstream payload at that
 * commit (fetched from GitHub); the only allowed difference is the optional engine-rs peer.
 *
 *   node test/__rs/default-path/check.mjs [--upstream ec35164] [--only payload,db-sqlite]
 *     [--allow-stale-dist] [--self-test] [--json out.json]
 *
 * `dist` must be built from the current `src` (a dist file older than its source fails, unless
 * `--allow-stale-dist`); packages without a dist are reported and skipped for the dist walk.
 * `--self-test` runs the walker on synthetic packages under .rs-runs/packaging and requires it to catch each
 * kind of engine-rs reference (negative control), then deletes them.
 */
import { parseSync } from '@swc/core'
import fs from 'node:fs'
import { builtinModules } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const engineName = '@payloadcms/engine-rs'
const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

// ------------------------------------------------------------------------------------------

/**
 * @param {{ root: string, only?: string[], allowStaleDist?: boolean, upstreamRef?: string, upstreamManifests?: Map<string, object>, isQuiet?: boolean }} args
 */
function check({
  allowStaleDist = false,
  isQuiet = false,
  only,
  root,
  upstreamManifests: givenUpstreamManifests,
  upstreamRef,
}) {
  const log = isQuiet ? () => {} : (line) => console.log(line)
  const failures = []
  const fail = (message) => {
    failures.push(message)
    if (!isQuiet) {
      console.error(`FAIL ${message}`)
    }
  }
  const packagesDir = path.join(root, 'packages')
  const engineDir = path.join(packagesDir, 'engine-rs')
  const workspace = new Map()
  for (const dir of fs.readdirSync(packagesDir)) {
    const manifestFile = path.join(packagesDir, dir, 'package.json')
    if (fs.existsSync(manifestFile)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      workspace.set(manifest.name, { dir: path.join(packagesDir, dir), manifest })
    }
  }
  const parsed = new Map()
  const report = {}

  const upstreamManifests =
    givenUpstreamManifests ??
    (upstreamRef ? fetchUpstreamManifests({ root, upstreamRef, workspace }) : undefined)

  for (const [name, { dir, manifest }] of workspace) {
    if (dir === engineDir || (only && !only.includes(path.basename(dir)))) {
      continue
    }
    const entry = (report[name] = {})
    checkManifest({ fail, manifest, name })
    if (upstreamManifests) {
      entry.manifest = compareManifest({
        fail,
        manifest,
        name,
        upstream: upstreamManifests.get(name),
      })
    }
    for (const mode of ['src', 'dist']) {
      const entries = entryFiles({ dir, manifest, mode })
      if (entries.length === 0) {
        entry[mode] = { skipped: 'no entry points' }
        continue
      }
      if (mode === 'dist' && !fs.existsSync(path.join(dir, 'dist'))) {
        entry[mode] = { skipped: 'no dist (not built)' }
        continue
      }
      const graph = walk({ engineDir, entries, mode, parsed, workspace })
      const stale = mode === 'dist' ? staleDistFiles({ graph, workspace }) : []
      entry[mode] = {
        engineReferences: graph.engineReferences,
        externals: [...graph.externals].sort(),
        guardedRuntimeLoads: graph.guardedLoads,
        modules: graph.modules.size,
        staleDist: stale.length,
        unresolved: graph.unresolved,
      }
      for (const reference of graph.engineReferences) {
        fail(`${name} (${mode}): ${reference}`)
      }
      for (const load of graph.unguardedLoads) {
        fail(`${name} (${mode}): engine-rs dynamic import without webpackIgnore: ${load}`)
      }
      if (stale.length > 0 && !allowStaleDist) {
        fail(
          `${name} (dist): ${stale.length} dist file(s) older than their source, e.g. ${path.relative(root, stale[0])} (rebuild, or --allow-stale-dist)`,
        )
      }
      log(
        `${name.padEnd(40)} ${mode.padEnd(4)} ${String(graph.modules.size).padStart(5)} modules, ${String(graph.externals.size).padStart(3)} external packages, engine-rs reachable: ${graph.engineReferences.length > 0 ? 'YES' : 'no'}${graph.guardedLoads.length > 0 ? `, ${graph.guardedLoads.length} guarded runtime-only engine-rs load(s)` : ''}${stale.length > 0 ? `, ${stale.length} stale dist file(s)` : ''}`,
      )
    }
  }

  log(failures.length === 0 ? '\ndefault path: OK' : `\n${failures.length} failure(s)`)
  return { failures, report }
}

/** `@payloadcms/engine-rs` must never be installed for a package's users. */
function checkManifest({ fail, manifest, name }) {
  for (const field of ['dependencies', 'optionalDependencies']) {
    if (manifest[field]?.[engineName]) {
      fail(`${name}: ${engineName} is in ${field}`)
    }
  }
  for (const field of ['bundleDependencies', 'bundledDependencies']) {
    if ((manifest[field] ?? []).includes?.(engineName)) {
      fail(`${name}: ${engineName} is in ${field}`)
    }
  }
  if (
    manifest.peerDependencies?.[engineName] &&
    !manifest.peerDependenciesMeta?.[engineName]?.optional
  ) {
    fail(`${name}: ${engineName} is a required peer dependency`)
  }
}

const comparedManifestFields = [
  'name',
  'type',
  'main',
  'module',
  'types',
  'browser',
  'bin',
  'files',
  'sideEffects',
  'imports',
  'exports',
  'publishConfig',
  'dependencies',
  // published too (pnpm keeps it in the packed manifest): engine-rs must not appear here either
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'engines',
]

/** Install-relevant fields equal upstream's, except for the optional engine-rs peer. */
function compareManifest({ fail, manifest, name, upstream }) {
  if (!upstream) {
    return 'not in upstream'
  }
  const differences = []
  for (const field of comparedManifestFields) {
    let actual = manifest[field]
    if (field === 'peerDependencies' || field === 'peerDependenciesMeta') {
      actual = withoutKey(actual, engineName)
    }
    if (JSON.stringify(actual) !== JSON.stringify(upstream[field])) {
      differences.push(field)
    }
  }
  for (const field of differences) {
    fail(`${name}: package.json "${field}" differs from upstream`)
  }
  return differences.length === 0
    ? 'equal to upstream (ignoring the optional engine-rs peer)'
    : differences
}

function withoutKey(record, key) {
  if (!record || !(key in record)) {
    return record
  }
  const { [key]: _removed, ...rest } = record
  return Object.keys(rest).length > 0 ? rest : undefined
}

function fetchUpstreamManifests({ root, upstreamRef, workspace }) {
  const cacheDir = path.join(root, '.rs-runs', 'packaging', `defaultpath-upstream-${upstreamRef}`)
  fs.mkdirSync(cacheDir, { recursive: true })
  const manifests = new Map()
  for (const [name, { dir }] of workspace) {
    const relative = path.relative(root, path.join(dir, 'package.json'))
    const cached = path.join(cacheDir, relative.replaceAll('/', '_'))
    if (!fs.existsSync(cached)) {
      const url = `https://raw.githubusercontent.com/payloadcms/payload/${upstreamRef}/${relative}`
      const response = spawnCurl(url)
      if (response === undefined) {
        continue
      }
      fs.writeFileSync(cached, response)
    }
    manifests.set(name, JSON.parse(fs.readFileSync(cached, 'utf8')))
  }
  return manifests
}

function spawnCurl(url) {
  const { spawnSync } = process.getBuiltinModule('node:child_process')
  const result = spawnSync('curl', ['-sfL', '--max-time', '30', url], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout : undefined
}

/** Files of the package's entry points in this mode (patterns expanded). */
function entryFiles({ dir, manifest, mode }) {
  const exportsField =
    mode === 'dist' ? (manifest.publishConfig?.exports ?? manifest.exports) : manifest.exports
  const main = mode === 'dist' ? (manifest.publishConfig?.main ?? manifest.main) : manifest.main
  const targets = new Set()
  if (exportsField) {
    const entries =
      typeof exportsField === 'string' ||
      !Object.keys(exportsField).every((key) => key.startsWith('.'))
        ? [['.', exportsField]]
        : Object.entries(exportsField)
    for (const [subpath, target] of entries) {
      for (const file of conditionTargets(target)) {
        if (subpath.includes('*')) {
          for (const expanded of expandPattern(path.join(dir, file))) {
            targets.add(expanded)
          }
        } else {
          targets.add(path.join(dir, file))
        }
      }
    }
  } else if (main) {
    targets.add(path.join(dir, main))
  }
  for (const binFile of Object.values(
    typeof manifest.bin === 'string' ? { bin: manifest.bin } : (manifest.bin ?? {}),
  )) {
    targets.add(path.join(dir, binFile))
  }
  return [...targets].filter((file) => isCodeFile(file) && fs.existsSync(file))
}

/** Every target of a conditional export, except `types`. */
function conditionTargets(target) {
  if (target === null || target === undefined) {
    return []
  }
  if (typeof target === 'string') {
    return [target]
  }
  if (Array.isArray(target)) {
    return target.flatMap((item) => conditionTargets(item))
  }
  return Object.entries(target).flatMap(([condition, value]) =>
    condition === 'types' ? [] : conditionTargets(value),
  )
}

function expandPattern(pattern) {
  const [before, after] = pattern.split('*')
  const baseDir = path.dirname(before)
  if (!fs.existsSync(baseDir)) {
    return []
  }
  return listFiles(baseDir).filter((file) => file.startsWith(before) && file.endsWith(after))
}

/** The reachable module graph from `entries`. */
function walk({ engineDir, entries, mode, parsed, workspace }) {
  const modules = new Set()
  const externals = new Set()
  const engineReferences = []
  const guardedLoads = []
  const unguardedLoads = []
  const unresolved = []
  const queue = [...entries]
  const isEngine = (file) => file === engineDir || file.startsWith(engineDir + path.sep)
  while (queue.length > 0) {
    const file = queue.pop()
    if (modules.has(file)) {
      continue
    }
    modules.add(file)
    if (isEngine(file)) {
      engineReferences.push(`reaches ${file}`)
      continue
    }
    if (!isCodeFile(file)) {
      continue
    }
    const info = parseModule({ file, parsed })
    for (const load of info.engineDynamicLoads) {
      ;(load.isIgnored ? guardedLoads : unguardedLoads).push(`${file}: ${load.text}`)
    }
    for (const { kind, specifier } of info.edges) {
      if (specifier === engineName || specifier.startsWith(`${engineName}/`)) {
        engineReferences.push(`${file}: ${kind} '${specifier}'`)
        continue
      }
      const resolved = resolveSpecifier({ file, mode, specifier, workspace })
      if (resolved.builtin) {
        continue
      }
      if (resolved.external) {
        externals.add(resolved.external)
        continue
      }
      if (resolved.files.length === 0) {
        unresolved.push(`${file}: ${kind} '${specifier}'`)
        continue
      }
      for (const target of resolved.files) {
        if (isEngine(target)) {
          engineReferences.push(`${file}: ${kind} '${specifier}' -> ${target}`)
        } else if (!modules.has(target)) {
          queue.push(target)
        }
      }
    }
  }
  return { engineReferences, externals, guardedLoads, modules, unguardedLoads, unresolved }
}

function isCodeFile(file) {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !file.endsWith('.d.ts')
}

/** Static edges of a module, plus its non-literal dynamic imports of engine-rs. */
function parseModule({ file, parsed }) {
  const cached = parsed.get(file)
  if (cached) {
    return cached
  }
  const source = fs.readFileSync(file, 'utf8')
  const isTypeScript = /\.[cm]?tsx?$/.test(file)
  let program
  try {
    program = parseSync(source, {
      comments: false,
      syntax: isTypeScript ? 'typescript' : 'ecmascript',
      target: 'esnext',
      ...(isTypeScript ? { tsx: file.endsWith('.tsx') } : { jsx: true }),
    })
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message ?? error}`)
  }
  const edges = []
  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      const isTypeOnly =
        node.typeOnly ||
        (node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.isTypeOnly))
      if (!isTypeOnly) {
        edges.push({ kind: 'import', specifier: node.source.value })
      }
    } else if (node.type === 'ExportAllDeclaration' && !node.typeOnly) {
      edges.push({ kind: 'export *', specifier: node.source.value })
    } else if (node.type === 'ExportNamedDeclaration' && node.source && !node.typeOnly) {
      const isTypeOnly =
        node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.isTypeOnly)
      if (!isTypeOnly) {
        edges.push({ kind: 'export from', specifier: node.source.value })
      }
    }
  }
  visit(program, (node) => {
    if (node.type === 'CallExpression') {
      const argument = node.arguments?.[0]?.expression
      const literal = stringLiteral(argument)
      if (node.callee?.type === 'Import') {
        if (literal !== undefined) {
          edges.push({ kind: 'import()', specifier: literal })
        }
      } else if (
        (node.callee?.type === 'Identifier' && node.callee.value === 'require') ||
        (node.callee?.type === 'CallExpression' &&
          node.callee.callee?.type === 'Identifier' &&
          node.callee.callee.value === 'createRequire')
      ) {
        if (literal !== undefined) {
          edges.push({ kind: 'require()', specifier: literal })
        }
      }
    } else if (
      node.type === 'NewExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.value === 'URL' &&
      isImportMetaUrl(node.arguments?.[1]?.expression)
    ) {
      const literal = stringLiteral(node.arguments?.[0]?.expression)
      if (literal !== undefined && (literal.startsWith('.') || literal.startsWith('/'))) {
        edges.push({ kind: 'new URL()', specifier: literal })
      }
    }
  })
  const engineDynamicLoads = source.includes(engineName)
    ? [...source.matchAll(/\bimport\(\s*((?:\/\*[\s\S]*?\*\/\s*)*)([^'"`\s)][^)]*)\)/g)].map(
        (match) => ({
          isIgnored: /webpackIgnore:\s*true/.test(match[1]),
          text: match[0].replace(/\s+/g, ' '),
        }),
      )
    : []
  const info = { edges, engineDynamicLoads }
  parsed.set(file, info)
  return info
}

function stringLiteral(node) {
  if (node?.type === 'StringLiteral') {
    return node.value
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.cooked ?? node.quasis[0]?.raw
  }
  return undefined
}

function isImportMetaUrl(node) {
  return (
    node?.type === 'MemberExpression' &&
    node.object?.type === 'MetaProperty' &&
    node.property?.value === 'url'
  )
}

function visit(node, callback) {
  if (Array.isArray(node)) {
    for (const item of node) {
      visit(item, callback)
    }
    return
  }
  if (node === null || typeof node !== 'object') {
    return
  }
  if (typeof node.type === 'string') {
    callback(node)
  }
  for (const key of Object.keys(node)) {
    if (key !== 'span') {
      visit(node[key], callback)
    }
  }
}

/**
 * Resolves a specifier like a bundler / Node would: relative files (in `src`, `.js` maps to its
 * TypeScript source), `#imports`, workspace packages through their exports, everything else a
 * leaf (`external`).
 */
function resolveSpecifier({ file, mode, specifier, workspace }) {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0])) {
    return { builtin: true, files: [] }
  }
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const base = specifier.startsWith('/') ? specifier : path.resolve(path.dirname(file), specifier)
    return { files: resolveFile({ base, mode }) }
  }
  if (specifier.startsWith('#')) {
    const owner = ownerPackage({ file, workspace })
    const importsField =
      mode === 'dist'
        ? (owner?.manifest.publishConfig?.imports ?? owner?.manifest.imports)
        : owner?.manifest.imports
    const targets = owner && importsField ? matchSubpath(importsField, specifier) : []
    return {
      files: targets.flatMap((target) =>
        target.startsWith('.')
          ? resolveFile({ base: path.join(owner.dir, target), mode })
          : resolveSpecifier({ file, mode, specifier: target, workspace }).files,
      ),
    }
  }
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subpath = `.${specifier.slice(name.length)}`
  const target = workspace.get(name)
  if (!target) {
    return { external: name, files: [] }
  }
  const exportsField =
    mode === 'dist'
      ? (target.manifest.publishConfig?.exports ?? target.manifest.exports)
      : target.manifest.exports
  if (!exportsField) {
    const main =
      mode === 'dist'
        ? (target.manifest.publishConfig?.main ?? target.manifest.main)
        : target.manifest.main
    return {
      files: resolveFile({
        base: path.join(target.dir, subpath === '.' ? main || 'index.js' : subpath),
        mode,
      }),
    }
  }
  const map =
    typeof exportsField === 'string' ||
    !Object.keys(exportsField).every((key) => key.startsWith('.'))
      ? { '.': exportsField }
      : exportsField
  return {
    files: matchSubpath(map, subpath).flatMap((relative) =>
      resolveFile({ base: path.join(target.dir, relative), mode }),
    ),
  }
}

/** Targets (all conditions except `types`) of `subpath` in an exports / imports map. */
function matchSubpath(map, subpath) {
  if (map[subpath] !== undefined) {
    return conditionTargets(map[subpath])
  }
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*')
    if (star === -1) {
      continue
    }
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= key.length - 1
    ) {
      const middle = subpath.slice(prefix.length, subpath.length - suffix.length)
      return conditionTargets(value).map((target) => target.replaceAll('*', middle))
    }
  }
  return []
}

function resolveFile({ base, mode }) {
  const candidates = [base]
  if (mode === 'src') {
    const withoutExtension = base.replace(/\.(?:[cm]?js|jsx)$/, '')
    if (withoutExtension !== base) {
      candidates.push(
        ...['.ts', '.tsx', '.mts', '.cts'].map((extension) => withoutExtension + extension),
      )
    }
  }
  candidates.push(`${base}.js`, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.js'))
  if (mode === 'src') {
    candidates.push(path.join(base, 'index.ts'), path.join(base, 'index.tsx'))
  }
  const found = candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  )
  return found ? [found] : []
}

function ownerPackage({ file, workspace }) {
  let owner
  for (const entry of workspace.values()) {
    if (file.startsWith(entry.dir + path.sep) && (!owner || entry.dir.length > owner.dir.length)) {
      owner = entry
    }
  }
  return owner
}

/** Dist modules in the graph whose source is newer. */
function staleDistFiles({ graph, workspace }) {
  const stale = []
  for (const file of graph.modules) {
    const owner = ownerPackage({ file, workspace })
    if (!owner) {
      continue
    }
    const distDir = path.join(owner.dir, 'dist') + path.sep
    if (!file.startsWith(distDir)) {
      continue
    }
    const relative = file.slice(distDir.length).replace(/\.js$/, '')
    const source = ['.ts', '.tsx', '.js', '.jsx']
      .map((extension) => path.join(owner.dir, 'src', relative + extension))
      .find((candidate) => fs.existsSync(candidate))
    if (source && fs.statSync(source).mtimeMs > fs.statSync(file).mtimeMs) {
      stale.push(file)
    }
  }
  return stale
}

function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((entry) => (entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []))
}

/**
 * Negative control: synthetic packages that reach engine-rs in each supported way must fail, a
 * guarded runtime-only load must pass, and a missing webpackIgnore must fail.
 */
function selfTest() {
  const scratch = path.join(repoRoot, '.rs-runs', 'packaging')
  fs.mkdirSync(scratch, { recursive: true })
  const root = fs.mkdtempSync(path.join(scratch, 'defaultpath-selftest-'))
  const writePackage = (dir, manifest, files) => {
    const packageDir = path.join(root, 'packages', dir)
    for (const [file, content] of Object.entries({
      'package.json': JSON.stringify(manifest),
      ...files,
    })) {
      fs.mkdirSync(path.dirname(path.join(packageDir, file)), { recursive: true })
      fs.writeFileSync(path.join(packageDir, file), content)
    }
  }
  const pkg = (name, extra = {}) => ({
    name,
    exports: { '.': { import: './src/index.ts', types: './src/index.ts' } },
    ...extra,
  })
  writePackage('engine-rs', pkg(engineName), { 'src/index.ts': 'export const x = 1\n' })
  const cases = {
    'static import': ["import { x } from '@payloadcms/engine-rs'\nexport { x }\n", true],
    'export from': ["export { x } from '@payloadcms/engine-rs/sqlite'\n", true],
    'literal import()': ["export const load = () => import('@payloadcms/engine-rs/ops')\n", true],
    'createRequire addon': [
      "import { createRequire } from 'node:module'\nexport const a = createRequire(import.meta.url)('@payloadcms/engine-rs/payload-engine.node')\n",
      true,
    ],
    'relative path into engine-rs': ["export * from '../../engine-rs/src/index.js'\n", true],
    'transitive through another workspace package': ["export * from 'transitive'\n", true],
    'unguarded variable import()': [
      "const s = '@payloadcms/engine-rs'\nexport const load = () => import(s)\n",
      true,
    ],
    'guarded runtime-only import()': [
      "const s = '@payloadcms/engine-rs'\nexport const load = () => process.env.PAYLOAD_ENGINE === 'rs' ? import(/* @vite-ignore */ /* webpackIgnore: true */ s) : undefined\n",
      false,
    ],
    'type-only import': [
      "import type { x } from '@payloadcms/engine-rs'\nexport type X = typeof x\n",
      false,
    ],
    'hard dependency': ['export const a = 1\n', true, { dependencies: { [engineName]: '1.0.0' } }],
    'required peer': [
      'export const a = 1\n',
      true,
      { peerDependencies: { [engineName]: '1.0.0' } },
    ],
    'optional peer': [
      'export const a = 1\n',
      false,
      {
        peerDependencies: { [engineName]: '1.0.0' },
        peerDependenciesMeta: { [engineName]: { optional: true } },
      },
    ],
  }
  // vs upstream (`upstream` = the manifest upstream has): only the optional engine-rs peer may differ
  const upstreamCases = {
    'vs upstream: optional peer only': [
      false,
      {
        peerDependencies: { [engineName]: '1.0.0' },
        peerDependenciesMeta: { [engineName]: { optional: true } },
      },
    ],
    'vs upstream: engine-rs devDependency (published manifest)': [
      true,
      {
        devDependencies: { [engineName]: '1.0.0' },
        peerDependencies: { [engineName]: '1.0.0' },
        peerDependenciesMeta: { [engineName]: { optional: true } },
      },
    ],
  }
  writePackage('transitive', pkg('transitive'), {
    'src/index.ts': "export { x } from '@payloadcms/engine-rs'\n",
  })
  let isOk = true
  try {
    for (const [label, [source, shouldFail, extra]] of Object.entries(cases)) {
      const dir = `case-${label.replace(/\W+/g, '-')}`
      writePackage(dir, pkg(dir, extra), { 'src/index.ts': source })
      const { failures } = check({ isQuiet: true, only: [dir], root })
      const didFail = failures.length > 0
      const isExpected = didFail === shouldFail
      isOk &&= isExpected
      console.log(
        `${isExpected ? 'ok  ' : 'FAIL'} ${label}: ${didFail ? `fails (${failures[0]})` : 'passes'}`,
      )
    }
    for (const [label, [shouldFail, extra]] of Object.entries(upstreamCases)) {
      const dir = `case-${label.replace(/\W+/g, '-')}`
      writePackage(dir, pkg(dir, extra), { 'src/index.ts': 'export const a = 1\n' })
      const { failures } = check({
        isQuiet: true,
        only: [dir],
        root,
        upstreamManifests: new Map([[dir, pkg(dir)]]),
      })
      const didFail = failures.length > 0
      const isExpected = didFail === shouldFail
      isOk &&= isExpected
      console.log(
        `${isExpected ? 'ok  ' : 'FAIL'} ${label}: ${didFail ? `fails (${failures[0]})` : 'passes'}`,
      )
    }
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
  console.log(isOk ? '\nself-test: OK' : '\nself-test: FAILED')
  return isOk
}

// Runs after every module-level declaration above is initialized.
main()

function main() {
  if (argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1)
  }

  const result = check({
    allowStaleDist: argv.includes('--allow-stale-dist'),
    only: option('--only')?.split(','),
    root: repoRoot,
    upstreamRef: option('--upstream'),
  })
  if (option('--json')) {
    fs.writeFileSync(option('--json'), JSON.stringify(result.report, null, 2))
  }
  process.exit(result.failures.length > 0 ? 1 : 0)
}
