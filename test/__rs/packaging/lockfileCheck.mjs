#!/usr/bin/env node
/**
 * Offline check that `pnpm-lock.yaml` satisfies every workspace manifest the way
 * `pnpm install --frozen-lockfile` decides it (pnpm's `satisfiesPackageManifest`, with this repo's
 * lockfile settings `autoInstallPeers: true`, `excludeLinksFromLockfile: false`): for each importer,
 * the lockfile specifiers must equal the manifest's dependencies + devDependencies +
 * optionalDependencies + peerDependencies (every peer, optional ones included: pnpm installs the
 * peers of workspace projects as prod dependencies), after the workspace `overrides`; each
 * dependency field must list exactly the manifest's names with the same specifiers (peers not
 * already declared count as `dependencies`); `workspace:` versions must link the named workspace
 * package; `dependenciesMeta` and `publishDirectory` must match; and every importer must belong to a
 * workspace package and vice versa. Used because the registry mirror is down (no `pnpm install`).
 *
 *   node test/__rs/packaging/lockfileCheck.mjs [--lockfile file] [--manifests-from <git-ref>]
 *     [--self-test]
 *
 * --manifests-from  read the manifests from a git ref instead of the working tree
 * --self-test       the negative controls: a lockfile without engine-rs entries, a dropped
 *                   importer, a changed specifier and a wrong link must each fail
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

if (argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1)
}
const lockfileText = fs.readFileSync(
  option('--lockfile') ?? path.join(root, 'pnpm-lock.yaml'),
  'utf8',
)
const problems = checkLockfile({
  lockfileText,
  readManifest: manifestReader(option('--manifests-from')),
})
for (const problem of problems) {
  console.error(`FAIL ${problem}`)
}
console.log(
  problems.length === 0
    ? 'lockfile: OK (every importer satisfies its manifest)'
    : `${problems.length} problem(s)`,
)
process.exit(problems.length === 0 ? 0 : 1)

// ------------------------------------------------------------------------------------------

function checkLockfile({ lockfileText, readManifest }) {
  const problems = []
  const lockfile = parseLockfile(lockfileText)
  if (
    lockfile.settings.autoInstallPeers !== 'true' ||
    lockfile.settings.excludeLinksFromLockfile !== 'false'
  ) {
    problems.push(`unexpected lockfile settings ${JSON.stringify(lockfile.settings)}`)
  }
  const workspace = workspaceDirs({ readManifest })
  const overrides = workspaceOverrides()
  for (const dir of workspace) {
    if (!lockfile.importers[dir]) {
      problems.push(`${dir}: no importer in the lockfile`)
    }
  }
  for (const [dir, importer] of Object.entries(lockfile.importers)) {
    const manifest = readManifest(dir === '.' ? 'package.json' : `${dir}/package.json`)
    if (!manifest) {
      problems.push(`${dir}: importer without a workspace package`)
      continue
    }
    const applyOverrides = (record) =>
      record &&
      Object.fromEntries(
        Object.entries(record).map(([name, spec]) => [
          name,
          name in overrides ? overrides[name] : spec,
        ]),
      )
    const pkg = {
      dependencies: applyOverrides(manifest.dependencies),
      devDependencies: applyOverrides(manifest.devDependencies),
      optionalDependencies: applyOverrides(manifest.optionalDependencies),
      peerDependencies: applyOverrides(manifest.peerDependencies),
    }
    const declared = { ...pkg.devDependencies, ...pkg.dependencies, ...pkg.optionalDependencies }
    const expectedSpecifiers = { ...pkg.peerDependencies, ...declared }
    const dependencies = {
      ...omit(pkg.peerDependencies ?? {}, Object.keys(declared)),
      ...pkg.dependencies,
    }
    const specifiers = {}
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, entry] of Object.entries(importer[field] ?? {})) {
        specifiers[name] = entry.specifier
      }
    }
    for (const name of new Set([...Object.keys(specifiers), ...Object.keys(expectedSpecifiers)])) {
      if (specifiers[name] !== expectedSpecifiers[name]) {
        problems.push(
          `${dir}: specifier of ${name} is ${specifiers[name] ?? 'missing'} in the lockfile, ${expectedSpecifiers[name] ?? 'absent'} in package.json`,
        )
      }
    }
    const fields = {
      dependencies: Object.keys(dependencies).filter((name) => !pkg.optionalDependencies?.[name]),
      devDependencies: Object.keys(pkg.devDependencies ?? {}).filter(
        (name) => !pkg.optionalDependencies?.[name] && !pkg.dependencies?.[name],
      ),
      optionalDependencies: Object.keys(pkg.optionalDependencies ?? {}),
    }
    for (const [field, names] of Object.entries(fields)) {
      const locked = importer[field] ?? {}
      const lockedNames = Object.keys(locked)
      if (lockedNames.length !== names.length) {
        problems.push(
          `${dir}: ${field} has ${lockedNames.length} entries in the lockfile, ${names.length} expected (${diffNames(lockedNames, names)})`,
        )
      }
      for (const name of names) {
        if (!locked[name]) {
          problems.push(`${dir}: ${name} is not in the lockfile's ${field}`)
          continue
        }
        const { specifier, version } = locked[name]
        if (specifier.startsWith('workspace:')) {
          const target = workspace.find(
            (other) => readManifest(`${other}/package.json`)?.name === name,
          )
          const link = target && `link:${path.posix.relative(dir, target)}`
          if (version !== link) {
            problems.push(
              `${dir}: ${name} is ${version} in the lockfile, ${link ?? 'no workspace package'} expected`,
            )
          }
        }
      }
    }
    if ((importer.publishDirectory ?? undefined) !== manifest.publishConfig?.directory) {
      problems.push(`${dir}: publishDirectory differs`)
    }
    if (
      JSON.stringify(manifest.dependenciesMeta ?? {}) !==
      JSON.stringify(importer.dependenciesMeta ?? {})
    ) {
      problems.push(`${dir}: dependenciesMeta differs`)
    }
  }
  return problems
}

/**
 * The `importers` (dependency fields with `specifier` / `version`, `publishDirectory`,
 * `dependenciesMeta` presence) and `settings` of a v9 lockfile: a line-based reader for this
 * fixed layout (two-space indentation, one key per line).
 */
function parseLockfile(text) {
  const lines = text.split('\n')
  const settings = {}
  const importers = {}
  let section
  let importer
  let field
  let dependency
  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    const indent = line.length - line.trimStart().length
    const [rawKey, ...rest] = line.trim().split(': ')
    const key = unquote(rawKey.replace(/:$/, ''))
    const value = rest.join(': ')
    if (indent === 0) {
      section = key
      continue
    }
    if (section === 'settings' && indent === 2) {
      settings[key] = value
    }
    if (section !== 'importers') {
      continue
    }
    if (indent === 2) {
      importer = importers[key] = {}
    } else if (indent === 4) {
      field = key
      if (value) {
        importer[field] = unquote(value)
      } else {
        importer[field] = {}
      }
    } else if (indent === 6) {
      dependency = importer[field][key] = {}
    } else if (indent === 8 && dependency) {
      dependency[key] = unquote(value)
    }
  }
  for (const entry of Object.values(importers)) {
    if (entry.dependenciesMeta) {
      // compared structurally: rebuild { name: { key: value } } from the generic reader
      entry.dependenciesMeta = Object.fromEntries(
        Object.entries(entry.dependenciesMeta).map(([name, meta]) => [
          name,
          Object.fromEntries(
            Object.entries(meta).map(([metaKey, metaValue]) => [
              metaKey,
              metaValue === 'true' ? true : metaValue === 'false' ? false : metaValue,
            ]),
          ),
        ]),
      )
    }
  }
  return { importers, settings }
}

/** Workspace project dirs (relative, posix) from pnpm-workspace.yaml `packages` globs. */
function workspaceDirs({ readManifest }) {
  const globs = []
  let inPackages = false
  for (const line of fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n')) {
    if (/^packages:/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages && /^\s+-\s/.test(line)) {
      globs.push(unquote(line.replace(/^\s+-\s+/, '').trim()))
    } else if (inPackages && /^\S/.test(line)) {
      inPackages = false
    }
  }
  const dirs = ['.']
  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const base = glob.slice(0, -2)
      for (const entry of fs.readdirSync(path.join(root, base))) {
        const dir = `${base}/${entry}`
        if (readManifest(`${dir}/package.json`)) {
          dirs.push(dir)
        }
      }
    } else if (readManifest(`${glob}/package.json`)) {
      dirs.push(glob)
    }
  }
  return dirs
}

/** Name-only `overrides` of pnpm-workspace.yaml (selectors with `>` never apply to importers). */
function workspaceOverrides() {
  const text = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
  const catalog = {}
  const overrides = {}
  let section
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, '')
      continue
    }
    const match = /^\s+('[^']+'|"[^"]+"|[^:\s]+):\s*(.+)$/.exec(line)
    if (!match) {
      continue
    }
    const key = unquote(match[1])
    const value = unquote(match[2].replace(/\s+#.*$/, '').trim())
    if (section === 'catalog') {
      catalog[key] = value
    } else if (section === 'overrides' && !key.includes('>')) {
      overrides[key] = value
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === 'catalog:') {
      overrides[name] = catalog[name]
    }
  }
  return overrides
}

function manifestReader(ref) {
  const cache = new Map()
  return (relative) => {
    if (!cache.has(relative)) {
      let text
      try {
        text = ref
          ? execFileSync('git', ['show', `${ref}:${relative}`], {
              cwd: root,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            })
          : fs.readFileSync(path.join(root, relative), 'utf8')
      } catch {
        text = undefined
      }
      cache.set(relative, text === undefined ? undefined : JSON.parse(text))
    }
    return cache.get(relative)
  }
}

function selfTest() {
  const lockfileText = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
  const readManifest = manifestReader()
  const cases = {
    'the current lockfile': { expectFailure: false, text: lockfileText },
    'no engine-rs entries (the lockfile before this change)': {
      expectFailure: true,
      text: lockfileText
        .replace(/\n {2}packages\/engine-rs:\n(?: {4,}.*\n)+/, '\n')
        .replaceAll(
          / {6}'@payloadcms\/engine-rs':\n {8}specifier: workspace:\*\n {8}version: link:\.\.\/engine-rs\n/g,
          '',
        ),
    },
    'a dropped importer': {
      expectFailure: true,
      text: lockfileText.replace(/\n {2}packages\/email-resend:\n(?: {4,}.*\n)+/, '\n'),
    },
    'a changed specifier': {
      expectFailure: true,
      text: lockfileText.replace(
        /( {2}packages\/engine-rs:\n(?:.*\n)*? {6}jose:\n {8}specifier: )6\.2\.12/,
        '$16.2.11',
      ),
    },
    'a wrong workspace link': {
      expectFailure: true,
      text: lockfileText.replace(
        /( {2}packages\/payload:\n(?:.*\n)*? {6}'@payloadcms\/engine-rs':\n {8}specifier: workspace:\*\n {8}version: )link:\.\.\/engine-rs/,
        '$1link:../drizzle',
      ),
    },
  }
  let isOk = true
  for (const [name, { expectFailure, text }] of Object.entries(cases)) {
    if (expectFailure && text === lockfileText) {
      console.error(`self-test "${name}": the mutation did not apply`)
      isOk = false
      continue
    }
    const problems = checkLockfile({ lockfileText: text, readManifest })
    const isPass = expectFailure ? problems.length > 0 : problems.length === 0
    console.log(
      `self-test "${name}": ${problems.length} problem(s)${problems[0] ? `, e.g. ${problems[0]}` : ''} -> ${isPass ? 'ok' : 'WRONG'}`,
    )
    isOk &&= isPass
  }
  console.log(isOk ? 'lockfile self-test: OK' : 'lockfile self-test: FAILED')
  return isOk
}

function omit(record, keys) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))
}

function diffNames(actual, expected) {
  const extra = actual.filter((name) => !expected.includes(name))
  const missing = expected.filter((name) => !actual.includes(name))
  return `extra: ${extra.join(', ') || '-'}; missing: ${missing.join(', ') || '-'}`
}

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, '$2')
}
