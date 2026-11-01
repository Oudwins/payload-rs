#!/usr/bin/env node
/**
 * Proves the Rust engine works in a real install: packs payload, translations, drizzle,
 * db-sqlite, engine-rs, ui and richtext-lexical with `pnpm pack` (the `script:pack` /
 * test/packed flow), installs the tarballs into a temp app outside the repo, and runs the Local
 * API scenario (`scenario.mjs`) twice with `PAYLOAD_ENGINE` unset (reference) and twice with
 * `PAYLOAD_ENGINE=rs` (candidate). Every candidate run is compared with every reference run
 * (`compare.mjs`).
 *
 *   node test/__rs/packaging/run.mjs [--addon file] [--work dir] [--keep] [--skip-build]
 *     [--no-simulate]
 *
 * --addon        addon to ship in the engine-rs tarball (default: packages/engine-rs/payload-engine.node)
 * --work         scratch dir (default /tmp/rs-packaging; deleted at the end unless --keep)
 * --skip-build   do not rebuild stale dist files
 * --no-simulate  do not apply missing pendingEdits.mjs edits: fail, but still install and run the
 *                unedited tarballs to show what breaks
 * --reuse        rerun the scenario against the app a previous `--keep` run installed (implies --keep)
 *
 * Build: engine-rs dist via packages/engine-rs/scripts/buildDist.mjs; for the other packages
 * every src file newer than its dist file is recompiled with that package's .swcrc (what its
 * `build:swc` does). A stale `'use client'` file aborts: those need the package's full build.
 *
 * Fails when: a run exits non-zero or records no steps; runs disagree on the step list; any
 * module resolved from the monorepo; a candidate did not load the engine-rs dist modules, the
 * packaged addon, or made no Rust engine / ops / ops-write / ops-global / field-hook calls; a
 * reference loaded engine-rs ops or runtime modules; a candidate differs from any reference
 * (see compare.mjs); or the negative control (a mutated candidate) is not detected.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compareRuns } from './compare.mjs'
import { getPendingEdits } from './pendingEdits.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const rootURL = pathToFileURL(root).href

const argv = process.argv.slice(2)
const options = {
  addon: path.join(root, 'packages/engine-rs/payload-engine.node'),
  isKeep: argv.includes('--keep') || argv.includes('--reuse'),
  isReuse: argv.includes('--reuse'),
  isSimulate: !argv.includes('--no-simulate'),
  isSkipBuild: argv.includes('--skip-build'),
  work: '/tmp/rs-packaging',
}
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--addon') {
    options.addon = path.resolve(argv[++i])
  } else if (argv[i] === '--work') {
    options.work = path.resolve(argv[++i])
  }
}
if (!options.work.startsWith('/tmp/') || options.work.startsWith(root)) {
  throw new Error(`--work must be under /tmp and outside the repo: ${options.work}`)
}

/** Packed in this order; `dir` is under packages/. */
const packages = [
  { dir: 'translations', name: '@payloadcms/translations' },
  { dir: 'payload', name: 'payload' },
  { dir: 'drizzle', name: '@payloadcms/drizzle' },
  { dir: 'engine-rs', name: '@payloadcms/engine-rs' },
  { dir: 'db-sqlite', name: '@payloadcms/db-sqlite' },
  { dir: 'ui', name: '@payloadcms/ui' },
  { dir: 'richtext-lexical', name: '@payloadcms/richtext-lexical' },
]

/** Scenario steps that are written to throw. */
const expectedErrorSteps = new Set([
  'login wrong password',
  'not found',
  'validation error (custom validate)',
  'validation error (required title)',
])

const failures = []
const fail = (message) => {
  failures.push(message)
  console.error(`FAIL ${message}`)
}

const engineManifest = readJson(path.join(root, 'packages/engine-rs/package.json'))
const pendingEdits = getPendingEdits({
  engineExports: engineManifest.exports,
  engineVersion: engineManifest.version,
})
const editResults = []

if (!options.isReuse) {
  fs.rmSync(options.work, { force: true, recursive: true })
}
const packedDir = path.join(options.work, 'packed')
const appDir = path.join(options.work, 'app')
fs.mkdirSync(packedDir, { recursive: true })
fs.mkdirSync(appDir, { recursive: true })

try {
  if (options.isReuse) {
    if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
      throw new Error(`--reuse: no installed app in ${appDir}`)
    }
    fs.copyFileSync(path.join(here, 'scenario.mjs'), path.join(appDir, 'scenario.mjs'))
  } else {
    if (!options.isSkipBuild) {
      build()
    }
    install(pack())
  }
  verify()
} catch (error) {
  fail(error instanceof Error ? error.stack : String(error))
} finally {
  if (!options.isKeep) {
    fs.rmSync(options.work, { force: true, recursive: true })
  }
}

console.log('\npending edits (RUST_PORT.md "Packaging"):')
for (const result of editResults) {
  console.log(`  ${result.status.padEnd(9)} ${result.id}: ${result.description}`)
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\npackaging: OK')

// ------------------------------------------------------------------------------------------

function build() {
  run('node', [path.join(root, 'packages/engine-rs/scripts/buildDist.mjs')], { cwd: root })
  const swcPath = path.join(root, 'node_modules/@swc/core/index.js')
  const swcModule = fs.existsSync(swcPath) ? swcPath : undefined
  if (!swcModule) {
    throw new Error('@swc/core not found in the repo root node_modules')
  }
  for (const { dir } of packages) {
    if (dir === 'engine-rs') {
      continue
    }
    const packageDir = path.join(root, 'packages', dir)
    const stale = listFiles(path.join(packageDir, 'src')).filter((file) => {
      if (
        !/\.(ts|tsx|js|jsx)$/.test(file) ||
        file.endsWith('.d.ts') ||
        /\.spec\.[^/]+$/.test(file)
      ) {
        return false
      }
      const out = distFileFor(packageDir, file)
      return !fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(file).mtimeMs
    })
    if (stale.length === 0) {
      continue
    }
    const clientFiles = stale.filter((file) =>
      /^\s*['"]use client['"]/.test(fs.readFileSync(file, 'utf8')),
    )
    if (clientFiles.length > 0) {
      throw new Error(`stale client files need \`pnpm build:${dir}\`: ${clientFiles.join(', ')}`)
    }
    console.log(`rebuilding ${stale.length} stale dist file(s) of ${dir}`)
    const script = `
      const swc = require(${JSON.stringify(swcModule)})
      const fs = require('node:fs')
      const path = require('node:path')
      const jobs = JSON.parse(process.argv[1])
      for (const [file, out] of jobs) {
        const { code } = swc.transformFileSync(file, { configFile: ${JSON.stringify(path.join(packageDir, '.swcrc'))}, sourceMaps: false })
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, code)
      }`
    run(
      'node',
      ['-e', script, JSON.stringify(stale.map((file) => [file, distFileFor(packageDir, file)]))],
      {
        cwd: packageDir,
      },
    )
  }
}

function distFileFor(packageDir, file) {
  return path
    .join(packageDir, 'dist', path.relative(path.join(packageDir, 'src'), file))
    .replace(/\.[jt]sx?$/, '.js')
}

function pack() {
  const tarballs = {}
  for (const { dir, name } of packages) {
    const before = new Set(fs.readdirSync(packedDir))
    run('pnpm', ['pack', '--pack-destination', packedDir], {
      cwd: path.join(root, 'packages', dir),
      isQuiet: true,
    })
    const created = fs
      .readdirSync(packedDir)
      .filter((file) => !before.has(file) && file.endsWith('.tgz'))
    if (created.length !== 1) {
      throw new Error(`pnpm pack of ${dir} produced ${created.join(', ') || 'nothing'}`)
    }
    const tarball = path.join(packedDir, created[0])
    console.log(
      `packed ${name} -> ${path.basename(tarball)} (${(fs.statSync(tarball).size / 1e6).toFixed(1)} MB)`,
    )
    tarballs[name] = tarball
    const edits = pendingEdits[name] ?? []
    const isEngine = name === '@payloadcms/engine-rs'
    if (edits.length === 0 && !isEngine) {
      continue
    }
    const extractDir = path.join(options.work, 'extract', dir)
    fs.mkdirSync(extractDir, { recursive: true })
    run('tar', ['-xzf', tarball, '-C', extractDir])
    const packageDir = path.join(extractDir, 'package')
    for (const edit of edits) {
      const status = edit.apply(packageDir, { isDryRun: !options.isSimulate })
      editResults.push({ description: edit.description, id: edit.id, status })
      if (status === 'missing') {
        fail(`pending edit not in the packed package: ${edit.id}`)
      }
    }
    if (isEngine) {
      checkEngineTarball(packageDir)
    }
    run('tar', ['-czf', tarball, '-C', extractDir, 'package'])
    fs.rmSync(extractDir, { force: true, recursive: true })
  }
  return tarballs
}

function checkEngineTarball(packageDir) {
  const manifest = readJson(path.join(packageDir, 'package.json'))
  const shipped = path.join(packageDir, 'payload-engine.node')
  if (!fs.existsSync(path.join(packageDir, 'dist/index.js'))) {
    throw new Error('engine-rs tarball has no dist/index.js')
  }
  if (fs.existsSync(path.join(packageDir, 'src'))) {
    throw new Error('engine-rs tarball ships src/')
  }
  if (JSON.stringify(manifest.exports).includes('/src/')) {
    throw new Error(`engine-rs tarball exports point at src: ${JSON.stringify(manifest.exports)}`)
  }
  fs.copyFileSync(options.addon, shipped)
  console.log(
    `engine-rs tarball ships addon ${options.addon} (sha256 ${sha256(shipped).slice(0, 16)})`,
  )
}

function install(tarballs) {
  const fileSpec = (tarball) => `file:${tarball}`
  const rootManifest = readJson(path.join(root, 'package.json'))
  const reactVersion = readJson(
    path.join(root, 'packages/ui/node_modules/react/package.json'),
  ).version
  const reactDomVersion = readJson(
    path.join(root, 'packages/ui/node_modules/react-dom/package.json'),
  ).version
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'rs-packaging-app',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@payloadcms/db-sqlite': fileSpec(tarballs['@payloadcms/db-sqlite']),
          '@payloadcms/richtext-lexical': fileSpec(tarballs['@payloadcms/richtext-lexical']),
          payload: fileSpec(tarballs.payload),
          react: reactVersion,
          'react-dom': reactDomVersion,
        },
        engines: rootManifest.engines,
      },
      null,
      2,
    ),
  )
  const overrides = Object.entries(tarballs)
    .map(([name, tarball]) => `  '${name}': '${fileSpec(tarball)}'`)
    .join('\n')
  fs.writeFileSync(path.join(appDir, 'pnpm-workspace.yaml'), `overrides:\n${overrides}\n`)
  run(
    'pnpm',
    ['install', '--ignore-scripts', '--prefer-offline', '--config.confirmModulesPurge=false'],
    {
      cwd: appDir,
    },
  )
  fs.copyFileSync(path.join(here, 'scenario.mjs'), path.join(appDir, 'scenario.mjs'))
}

function verify() {
  const runs = [
    { engine: 'ts', label: 'reference 1' },
    { engine: 'ts', label: 'reference 2' },
    { engine: 'rs', label: 'candidate 1' },
    { engine: 'rs', label: 'candidate 2' },
  ].map((spec, index) => ({ ...spec, ...runScenario(spec, index) }))

  const references = runs.filter((entry) => entry.engine === 'ts')
  const candidates = runs.filter((entry) => entry.engine === 'rs')
  if (runs.some((entry) => !entry.output)) {
    return
  }

  const stepNames = (entry) => JSON.stringify(entry.output.steps.map((step) => step.name))
  for (const entry of runs) {
    if (entry.output.steps.length === 0) {
      fail(`${entry.label}: no steps`)
    }
    if (stepNames(entry) !== stepNames(runs[0])) {
      fail(`${entry.label}: step list differs from ${runs[0].label}`)
    }
    // The scenario itself must work: only the steps written to throw may throw (in any run).
    for (const step of entry.output.steps) {
      const isExpectedError = expectedErrorSteps.has(step.name)
      if (isExpectedError !== 'error' in step) {
        fail(
          `${entry.label}: step "${step.name}" ${isExpectedError ? 'did not throw' : `threw ${JSON.stringify(step.error).slice(0, 300)}`}`,
        )
      }
    }
    // One instance per package: engine-rs must share payload's / drizzle's modules (error
    // classes, symbols, state), which a second copy of either would break.
    const roots = new Map()
    for (const url of entry.output.resolvedURLs) {
      const match =
        /^(file:.*\/node_modules\/(payload|@payloadcms\/[^/]+|drizzle-orm|jose))\//.exec(url)
      if (match) {
        roots.set(match[2], (roots.get(match[2]) ?? new Set()).add(match[1]))
      }
    }
    for (const [name, packageRoots] of roots) {
      if (packageRoots.size > 1) {
        fail(
          `${entry.label}: ${name} was loaded from ${packageRoots.size} places: ${[...packageRoots].join(', ')}`,
        )
      }
    }
    if (!roots.has('@payloadcms/engine-rs') || !roots.has('payload')) {
      fail(`${entry.label}: did not load payload and @payloadcms/engine-rs from the install`)
    }
    const fromRepo = entry.output.resolvedURLs.filter((url) => url.startsWith(rootURL))
    if (fromRepo.length > 0) {
      fail(
        `${entry.label}: resolved ${fromRepo.length} module(s) from the monorepo, e.g. ${fromRepo[0]}`,
      )
    }
  }

  const engineModule = (entry, sub) =>
    entry.output.resolvedURLs.some(
      (url) => url.includes('/@payloadcms/engine-rs/') && url.endsWith(sub),
    )
  const engineModules = [
    '/dist/ops/index.js',
    '/dist/ops-write/index.js',
    '/dist/ops-global/index.js',
    '/dist/runtime/hooks.js',
    '/dist/query/index.js',
  ]
  for (const entry of references) {
    const loaded = engineModules.filter((sub) => engineModule(entry, sub))
    if (loaded.length > 0) {
      fail(`${entry.label}: PAYLOAD_ENGINE unset but loaded engine-rs ${loaded.join(', ')}`)
    }
  }
  for (const entry of candidates) {
    const missing = engineModules.filter((sub) => !engineModule(entry, sub))
    if (missing.length > 0) {
      fail(`${entry.label}: did not load engine-rs ${missing.join(', ')}`)
    }
    const stats = entry.stats
    const checks = {
      'core field hooks': sum(stats.core?.calls),
      'ops (read)': sum(stats.ops?.calls),
      'ops-global/auth': sum(stats.opsGlobal?.calls),
      'ops-write':
        typeof stats.opsWrite?.calls === 'number'
          ? stats.opsWrite.calls
          : sum(stats.opsWrite?.calls),
      'sql engine calls': sum(stats.engine?.calls),
      'sql engines (native)': stats.engine?.engines?.native ?? 0,
    }
    console.log(`${entry.label} engine stats: ${JSON.stringify(checks)}`)
    for (const [name, count] of Object.entries(checks)) {
      if (!(count > 0)) {
        fail(`${entry.label}: no ${name} served by the Rust engine`)
      }
    }
    if ((stats.engine?.engines?.loopback ?? 0) > 0) {
      fail(`${entry.label}: used the loopback (TS stand-in) engine`)
    }
  }

  let totalCompared = 0
  for (const candidate of candidates) {
    const result = compareRuns({ candidate, references })
    totalCompared += result.compared
    console.log(
      `${candidate.label} vs ${references.map((entry) => entry.label).join(' + ')}: ${result.compared} leaves, ${result.nondeterministic.length} nondeterministic, ${result.mismatches.length} mismatches`,
    )
    if (candidate === candidates[0]) {
      console.log(`  nondeterministic: ${result.nondeterministic.join(' ')}`)
    }
    for (const mismatch of result.mismatches.slice(0, 40)) {
      fail(`${candidate.label}: ${describeMismatch(candidate.output, mismatch)}`)
    }
    if (result.mismatches.length > 40) {
      fail(`${candidate.label}: ... and ${result.mismatches.length - 40} more mismatches`)
    }
  }
  if (totalCompared === 0) {
    fail('compared nothing')
  }

  // Negative control: a candidate with one changed deterministic leaf must not pass.
  const mutated = structuredClone(candidates[0].output)
  const createAuthor = mutated.steps.find((step) => step.name === 'create author')
  if (typeof createAuthor?.value?.name !== 'string') {
    fail('negative control: "create author" returned no document to mutate')
  } else {
    createAuthor.value.name = `${createAuthor.value.name}?`
    if (
      compareRuns({ candidate: { label: 'mutated', output: mutated }, references }).mismatches
        .length === 0
    ) {
      fail('negative control: a mutated candidate passed the comparison')
    }
  }
}

function runScenario({ engine, label }, index) {
  const dbFile = path.join(options.work, `run-${index}.db`)
  const outFile = path.join(options.work, `run-${index}.json`)
  const statsDir = path.join(options.work, `stats-${index}`)
  fs.rmSync(outFile, { force: true })
  fs.rmSync(statsDir, { force: true, recursive: true })
  fs.mkdirSync(statsDir, { recursive: true })
  const env = { ...process.env, TZ: 'UTC' }
  for (const key of Object.keys(env)) {
    if (/^PAYLOAD_|^NODE_OPTIONS$/.test(key)) {
      delete env[key]
    }
  }
  if (engine === 'rs') {
    Object.assign(env, {
      PAYLOAD_ENGINE: 'rs',
      PAYLOAD_RS_CORE_STATS_FILE: path.join(statsDir, 'core.json'),
      PAYLOAD_RS_ENGINE_STATS_FILE: path.join(statsDir, 'engine.json'),
      PAYLOAD_RS_OPS_STATS_DIR: statsDir,
    })
  }
  const result = spawnSync(process.execPath, ['scenario.mjs', dbFile, outFile], {
    cwd: appDir,
    encoding: 'utf8',
    env,
    timeout: 300_000,
  })
  for (const file of fs
    .readdirSync(options.work)
    .filter((name) => name.startsWith(`run-${index}.db`))) {
    fs.rmSync(path.join(options.work, file), { force: true })
  }
  if (result.status !== 0) {
    fail(`${label} exited ${result.status ?? result.signal}:\n${result.stdout}\n${result.stderr}`)
    return {}
  }
  const output = readJson(outFile)
  const statsFiles = fs.readdirSync(statsDir)
  if (engine === 'ts' && statsFiles.length > 0) {
    fail(`${label}: reference run wrote engine stats ${statsFiles.join(', ')}`)
  }
  const stats = {
    core: readJsonIfExists(path.join(statsDir, 'core.json')),
    engine: readJsonIfExists(path.join(statsDir, 'engine.json')),
    ops: readJsonIfExists(
      path.join(statsDir, statsFiles.find((name) => /^ops-\d+\.json$/.test(name)) ?? 'none'),
    ),
    opsGlobal: readJsonIfExists(
      path.join(statsDir, statsFiles.find((name) => /^ops-global-\d+\.json$/.test(name)) ?? 'none'),
    ),
    opsWrite: readJsonIfExists(path.join(statsDir, 'engine.json.ops-write.json')),
  }
  const addonLoads = output.resolvedURLs.filter((url) => url.endsWith('.node'))
  if (
    engine === 'rs' &&
    !addonLoads.some((url) => url.includes('/@payloadcms/engine-rs/payload-engine.node'))
  ) {
    fail(
      `${label}: the packaged addon was not resolved (resolved addons: ${addonLoads.join(', ') || 'none'})`,
    )
  }
  console.log(
    `${label}: ${output.steps.length} steps, ${output.resolvedURLs.length} modules resolved`,
  )
  return { output, stats }
}

function describeMismatch(output, mismatch) {
  const stepIndex = /^\$\[(\d+)\]/.exec(mismatch.path)?.[1]
  const stepName =
    stepIndex === undefined ? '' : ` [step "${output.steps[Number(stepIndex)]?.name}"]`
  return `${mismatch.path}${stepName}: ${mismatch.problem ?? 'differs'} candidate=${truncate(mismatch.candidate)} reference=${truncate(mismatch.reference ?? JSON.stringify(mismatch.references))}`
}

function truncate(value) {
  const text = String(value)
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

function sum(record) {
  return record && typeof record === 'object'
    ? Object.values(record).reduce((total, count) => total + (Number(count) || 0), 0)
    : 0
}

function run(command, args, { cwd, isQuiet = false } = {}) {
  execFileSync(command, args, { cwd, stdio: ['ignore', isQuiet ? 'ignore' : 'inherit', 'inherit'] })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readJsonIfExists(file) {
  return fs.existsSync(file) ? readJson(file) : undefined
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((entry) => (entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []))
}
