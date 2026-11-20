#!/usr/bin/env node
/**
 * Proves the Rust engine works in a real install, and that the default path does not need it:
 * packs payload, translations, drizzle, db-sqlite, db-mongodb, ui, richtext-lexical and engine-rs
 * with `pnpm pack` exactly as the monorepo sources produce them (no edits to the tarballs, except
 * the addon file when `--addon` names another build), and
 * installs them into an app under .rs-runs/packaging/work in three phases:
 *
 * 1. Without `@payloadcms/engine-rs` (what every user who never opts in gets). The install must
 *    not contain engine-rs at all; the Local API scenario (`scenario.mjs`) runs twice per
 *    database (sqlite, mongodb) with `PAYLOAD_ENGINE` unset (references).
 * 2. `pnpm add @payloadcms/engine-rs` (opting in). Every package that loads it must resolve the
 *    same installed copy. The scenario runs once more per database with the flag unset (an
 *    installed engine changes nothing) and twice with `PAYLOAD_ENGINE=rs` (candidates).
 * 3. A second app with payload, db-sqlite, richtext-lexical and engine-rs only (no db-mongodb:
 *    engine-rs's optional peer stays uninstalled). The sqlite scenario runs once with
 *    `PAYLOAD_ENGINE=rs` and must load no MongoDB module (db-mongodb, mongoose, engine-rs's
 *    mongo-adapter / mongo-live) and equal the sqlite references.
 *
 * Every candidate is compared with every reference of its database (`compare.mjs`).
 *
 *   node test/__rs/packaging/run.mjs [--addon file] [--work dir] [--keep] [--skip-build]
 *     [--database sqlite|mongodb] [--mongodb-url mongodb://.../?...]
 *
 * --addon        addon the engine-rs tarball ships. `pnpm pack` must have packed
 *                packages/engine-rs/payload-engine.node (checked); a different --addon then replaces
 *                that one file in the tarball (reported), nothing else is touched
 * --work         scratch dir under .rs-runs/ (default .rs-runs/packaging/work; deleted at the end
 *                unless --keep). Modules resolved from the monorepo outside it are failures.
 * --skip-build   do not rebuild stale dist files / the engine-rs dist
 * --database     run one database only (default: both)
 * --mongodb-url  server for the mongodb runs; each run uses its own database
 *                `packaging_pk_<n>`, dropped afterwards (default: the rs0 test server)
 * --reuse        rerun the scenarios against the app a previous `--keep` run installed (implies --keep)
 *
 * The package manager is `pnpm`, or `node $RS_PACKAGING_PNPM` when that names a pnpm.cjs (e.g. a
 * pnpm 10 with NPM_CONFIG_USERCONFIG pointing at a public-registry npmrc while the mirror is down).
 *
 * Fails when: a packed manifest makes engine-rs a dependency or a required peer; a packed dist
 * still points into the monorepo's engine-rs sources; the phase-1 install contains engine-rs; a
 * run exits non-zero or records no steps; runs disagree on the step list; a step throws that
 * should not (or the reverse); any module resolved from the monorepo or a Payload package from
 * two places; a flag-unset run resolved anything of engine-rs (module or addon); a candidate did
 * not load the engine-rs dist modules, the packaged addon, or made no Rust engine / ops /
 * ops-write / ops-global / field-hook calls; a candidate differs from any reference
 * (`compare.mjs`); or the negative controls (a changed value, swapped row ids, a stale
 * timestamp) are not detected.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { compareRuns } from './compare.mjs'
import { rebuildStaleDist } from './rebuildStale.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const rootURL = pathToFileURL(root).href
const engineName = '@payloadcms/engine-rs'
let scenarioIndex = 0

const argv = process.argv.slice(2)
const options = {
  addon: path.join(root, 'packages/engine-rs/payload-engine.node'),
  databases: ['sqlite', 'mongodb'],
  isKeep: argv.includes('--keep') || argv.includes('--reuse'),
  isReuse: argv.includes('--reuse'),
  isSkipBuild: argv.includes('--skip-build'),
  mongodbURL:
    'mongodb://payload:payload@localhost:27018/?authSource=admin&directConnection=true&replicaSet=rs0',
  work: path.join(root, '.rs-runs/packaging/work'),
}
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--addon') {
    options.addon = path.resolve(argv[++i])
  } else if (argv[i] === '--work') {
    options.work = path.resolve(argv[++i])
  } else if (argv[i] === '--database') {
    options.databases = [argv[++i]]
  } else if (argv[i] === '--mongodb-url') {
    options.mongodbURL = argv[++i]
  }
}
if (!options.work.startsWith(path.join(root, '.rs-runs') + path.sep)) {
  throw new Error(`--work must be under ${path.join(root, '.rs-runs')}: ${options.work}`)
}
const workURL = pathToFileURL(options.work).href
const pnpmCommand = process.env.RS_PACKAGING_PNPM
  ? [process.execPath, [process.env.RS_PACKAGING_PNPM]]
  : ['pnpm', []]

/** Packed in this order; `dir` is under packages/. */
const packages = [
  { dir: 'translations', name: '@payloadcms/translations' },
  { dir: 'payload', name: 'payload' },
  { dir: 'drizzle', name: '@payloadcms/drizzle' },
  { dir: 'db-sqlite', name: '@payloadcms/db-sqlite' },
  { dir: 'db-mongodb', name: '@payloadcms/db-mongodb' },
  { dir: 'ui', name: '@payloadcms/ui' },
  { dir: 'richtext-lexical', name: '@payloadcms/richtext-lexical' },
  { dir: 'engine-rs', name: engineName },
]
/** Packages whose dist dispatches to engine-rs at runtime. */
const dispatchingPackages = [
  'payload',
  '@payloadcms/db-sqlite',
  '@payloadcms/db-mongodb',
  '@payloadcms/richtext-lexical',
]

/** Scenario steps that are written to throw. */
const expectedErrorSteps = new Set([
  'create note anonymous (access denied)',
  'delete note as user (access denied)',
  'find notes anonymous (access denied)',
  'findByID note as other user (not found)',
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

if (!options.isReuse) {
  fs.rmSync(options.work, { force: true, recursive: true })
}
const packedDir = path.join(options.work, 'packed')
const appDir = path.join(options.work, 'app')
const sqliteOnlyAppDir = path.join(options.work, 'app-sqlite-only')
fs.mkdirSync(packedDir, { recursive: true })
fs.mkdirSync(appDir, { recursive: true })

try {
  const runs = []
  let tarballs
  if (options.isReuse) {
    if (!fs.existsSync(path.join(appDir, 'node_modules', engineName))) {
      throw new Error(`--reuse: no installed app with ${engineName} in ${appDir}`)
    }
    fs.copyFileSync(path.join(here, 'scenario.mjs'), path.join(appDir, 'scenario.mjs'))
    for (const database of options.databases) {
      for (const label of ['reference 1', 'reference 2', 'reference 3 (engine installed)']) {
        runs.push(runScenario({ database, engine: 'ts', label }))
      }
    }
  } else {
    if (!options.isSkipBuild) {
      build()
    }
    tarballs = pack()
    installWithoutEngine(tarballs)
    for (const database of options.databases) {
      runs.push(runScenario({ database, engine: 'ts', label: 'reference 1' }))
      runs.push(runScenario({ database, engine: 'ts', label: 'reference 2' }))
    }
    installEngine(tarballs)
    for (const database of options.databases) {
      runs.push(runScenario({ database, engine: 'ts', label: 'reference 3 (engine installed)' }))
    }
  }
  for (const database of options.databases) {
    runs.push(runScenario({ database, engine: 'rs', label: 'candidate 1' }))
    runs.push(runScenario({ database, engine: 'rs', label: 'candidate 2' }))
  }
  if (options.databases.includes('sqlite') && !options.isReuse) {
    installSqliteOnly(tarballs)
    runs.push(
      runScenario({
        app: sqliteOnlyAppDir,
        database: 'sqlite',
        engine: 'rs',
        label: 'candidate 3 (sqlite-only install)',
      }),
    )
  }
  for (const database of options.databases) {
    verify(runs.filter((entry) => entry.database === database))
  }
} catch (error) {
  fail(error instanceof Error ? error.stack : String(error))
} finally {
  if (!options.isKeep) {
    fs.rmSync(options.work, { force: true, recursive: true })
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\npackaging: OK')

// ------------------------------------------------------------------------------------------

function build() {
  run('node', [path.join(root, 'packages/engine-rs/scripts/buildDist.mjs')], { cwd: root })
  rebuildStaleDist({
    dirs: packages.map(({ dir }) => dir).filter((dir) => dir !== 'engine-rs'),
  })
}

function pack() {
  const tarballs = {}
  for (const { dir, name } of packages) {
    const before = new Set(fs.readdirSync(packedDir))
    runPnpm(['pack', '--pack-destination', packedDir], {
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
    checkTarball({ name, tarball })
  }
  return tarballs
}

/** The packed manifest and dist, exactly as `pnpm pack` produced them. */
function checkTarball({ name, tarball }) {
  const extractDir = path.join(options.work, 'extract', path.basename(tarball, '.tgz'))
  fs.mkdirSync(extractDir, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', extractDir])
  const packageDir = path.join(extractDir, 'package')
  const manifest = readJson(path.join(packageDir, 'package.json'))
  try {
    for (const field of ['dependencies', 'optionalDependencies']) {
      if (manifest[field]?.[engineName]) {
        fail(`packed ${name}: ${engineName} is in ${field}`)
      }
    }
    if (
      manifest.peerDependencies?.[engineName] &&
      !manifest.peerDependenciesMeta?.[engineName]?.optional
    ) {
      fail(`packed ${name}: ${engineName} is a required peer dependency`)
    }
    if (dispatchingPackages.includes(name) && !manifest.peerDependencies?.[engineName]) {
      fail(`packed ${name}: no optional ${engineName} peer, so pnpm cannot link it when opted in`)
    }
    if (name !== engineName) {
      for (const file of listFiles(path.join(packageDir, 'dist')).filter((file) =>
        file.endsWith('.js'),
      )) {
        // a relative specifier into the monorepo's engine-rs (comments may name its sources)
        if (/['"](?:\.\.\/)+engine-rs\//.test(fs.readFileSync(file, 'utf8'))) {
          fail(`packed ${name}: ${path.relative(packageDir, file)} points into engine-rs sources`)
        }
      }
      return
    }
    if (manifest.types?.includes('/src/') || JSON.stringify(manifest.exports).includes('/src/')) {
      fail(`packed ${name}: manifest points at src: ${JSON.stringify(manifest.exports)}`)
    }
    if (fs.existsSync(path.join(packageDir, 'src'))) {
      fail(`packed ${name}: ships src/`)
    }
    if (!fs.existsSync(path.join(packageDir, 'dist/index.js'))) {
      fail(`packed ${name}: no dist/index.js`)
    }
    const shipped = path.join(packageDir, 'payload-engine.node')
    const repoAddon = path.join(root, 'packages/engine-rs/payload-engine.node')
    if (!fs.existsSync(shipped) || sha256(shipped) !== sha256(repoAddon)) {
      fail(`packed ${name}: does not ship packages/engine-rs/payload-engine.node`)
    } else if (sha256(options.addon) !== sha256(shipped)) {
      // --addon: the packed manifest and dist stay as packed, only the addon file is replaced
      fs.copyFileSync(options.addon, shipped)
      run('tar', ['-czf', tarball, '-C', extractDir, 'package'])
      console.log(
        `  addon replaced by --addon ${options.addon} (sha256 ${sha256(shipped).slice(0, 16)})`,
      )
    } else {
      console.log(`  ships the repo addon (sha256 ${sha256(shipped).slice(0, 16)})`)
    }
  } finally {
    fs.rmSync(extractDir, { force: true, recursive: true })
  }
}

function installWithoutEngine(tarballs) {
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
          '@payloadcms/db-mongodb': fileSpec(tarballs['@payloadcms/db-mongodb']),
          '@payloadcms/db-sqlite': fileSpec(tarballs['@payloadcms/db-sqlite']),
          // engine-rs's `@payloadcms/drizzle` peer: in a registry install pnpm auto-installs it at
          // the root with db-sqlite's exact version (one copy); with file: tarballs it would fetch
          // the published version from the registry instead, so the app names the packed one
          '@payloadcms/drizzle': fileSpec(tarballs['@payloadcms/drizzle']),
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
  // No override for engine-rs: pnpm applies overrides to peer specs too, which would install the
  // optional peer. Opting in (`installEngine`) adds it as an app dependency instead.
  const overrides = Object.entries(tarballs)
    .filter(([name]) => name !== engineName)
    .map(([name, tarball]) => `  '${name}': '${fileSpec(tarball)}'`)
    .join('\n')
  fs.writeFileSync(path.join(appDir, 'pnpm-workspace.yaml'), `overrides:\n${overrides}\n`)
  runPnpm(
    ['install', '--ignore-scripts', '--prefer-offline', '--config.confirmModulesPurge=false'],
    {
      cwd: appDir,
    },
  )
  const store = path.join(appDir, 'node_modules/.pnpm')
  const installed = fs.readdirSync(store).filter((entry) => entry.includes('engine-rs'))
  if (installed.length > 0 || fs.existsSync(path.join(appDir, 'node_modules', engineName))) {
    fail(`the install without opting in contains engine-rs: ${installed.join(', ')}`)
  } else {
    console.log('install without opting in: no @payloadcms/engine-rs anywhere in node_modules')
  }
  fs.copyFileSync(path.join(here, 'scenario.mjs'), path.join(appDir, 'scenario.mjs'))
}

/** Opting in: `pnpm add @payloadcms/engine-rs`; every dispatching package must see that copy. */
function installEngine(tarballs) {
  runPnpm(
    [
      'add',
      `${engineName}@file:${tarballs[engineName]}`,
      '--ignore-scripts',
      '--prefer-offline',
      '--config.confirmModulesPurge=false',
    ],
    { cwd: appDir },
  )
  const script = `
    import { createRequire } from 'node:module'
    import fs from 'node:fs'
    const out = {}
    for (const name of ${JSON.stringify(dispatchingPackages)}) {
      const own = createRequire(import.meta.resolve(name))
      try {
        out[name] = fs.realpathSync(own.resolve('${engineName}/package.json'))
      } catch (error) {
        out[name] = 'unresolved: ' + error.code
      }
    }
    out.app = fs.realpathSync(createRequire(process.cwd() + '/')
      .resolve('${engineName}/package.json'))
    console.log(JSON.stringify(out))`
  const resolved = JSON.parse(
    execFileSync('node', ['--input-type=module', '-e', script], { cwd: appDir, encoding: 'utf8' }),
  )
  const copies = new Set(Object.values(resolved))
  if (copies.size !== 1 || [...copies][0].startsWith('unresolved')) {
    fail(`opted-in packages do not share one ${engineName}: ${JSON.stringify(resolved)}`)
  } else {
    console.log(`opted in: every dispatching package resolves ${[...copies][0]}`)
  }
}

/**
 * Phase 3: payload, db-sqlite, richtext-lexical and engine-rs, without db-mongodb (engine-rs's
 * optional peer): the install must not contain db-mongodb or mongoose.
 */
function installSqliteOnly(tarballs) {
  fs.mkdirSync(sqliteOnlyAppDir, { recursive: true })
  const appManifest = readJson(path.join(appDir, 'package.json'))
  const { '@payloadcms/db-mongodb': _mongodb, ...dependencies } = appManifest.dependencies
  fs.writeFileSync(
    path.join(sqliteOnlyAppDir, 'package.json'),
    JSON.stringify(
      {
        ...appManifest,
        name: 'rs-packaging-app-sqlite-only',
        dependencies: { ...dependencies, [engineName]: `file:${tarballs[engineName]}` },
      },
      null,
      2,
    ),
  )
  fs.copyFileSync(
    path.join(appDir, 'pnpm-workspace.yaml'),
    path.join(sqliteOnlyAppDir, 'pnpm-workspace.yaml'),
  )
  runPnpm(
    ['install', '--ignore-scripts', '--prefer-offline', '--config.confirmModulesPurge=false'],
    {
      cwd: sqliteOnlyAppDir,
    },
  )
  const store = fs.readdirSync(path.join(sqliteOnlyAppDir, 'node_modules/.pnpm'))
  const mongo = store.filter((entry) => /db-mongodb|^mongoose@|^mongodb@/.test(entry))
  if (mongo.length > 0) {
    fail(`the sqlite-only install contains ${mongo.join(', ')}`)
  } else {
    console.log('sqlite-only install: engine-rs without db-mongodb / mongoose / mongodb')
  }
  fs.copyFileSync(path.join(here, 'scenario.mjs'), path.join(sqliteOnlyAppDir, 'scenario.mjs'))
}

function verify(runs) {
  const database = runs[0]?.database
  const references = runs.filter((entry) => entry.engine === 'ts')
  const candidates = runs.filter((entry) => entry.engine === 'rs')
  if (runs.some((entry) => !entry.output)) {
    return
  }
  const stepNames = (entry) => JSON.stringify(entry.output.steps.map((step) => step.name))
  for (const entry of runs) {
    const label = `${database} ${entry.label}`
    if (entry.output.steps.length === 0) {
      fail(`${label}: no steps`)
    }
    if (stepNames(entry) !== stepNames(runs[0])) {
      fail(`${label}: step list differs from ${runs[0].label}`)
    }
    for (const step of entry.output.steps) {
      const isExpectedError = expectedErrorSteps.has(step.name)
      if (isExpectedError !== 'error' in step) {
        fail(
          `${label}: step "${step.name}" ${isExpectedError ? 'did not throw' : `threw ${JSON.stringify(step.error).slice(0, 300)}`}`,
        )
      }
    }
    // One instance per package: engine-rs must share payload's / drizzle's modules (error
    // classes, symbols, state), which a second copy of either would break.
    const roots = new Map()
    for (const url of entry.output.resolvedURLs) {
      const match =
        /^(file:.*\/node_modules\/(payload|@payloadcms\/[^/]+|drizzle-orm|jose|mongoose))\//.exec(
          url,
        )
      if (match) {
        roots.set(match[2], (roots.get(match[2]) ?? new Set()).add(match[1]))
      }
    }
    for (const [name, packageRoots] of roots) {
      if (packageRoots.size > 1) {
        fail(
          `${label}: ${name} was loaded from ${packageRoots.size} places: ${[...packageRoots].join(', ')}`,
        )
      }
    }
    if (!roots.has('payload')) {
      fail(`${label}: did not load payload from the install`)
    }
    const fromRepo = entry.output.resolvedURLs.filter(
      (url) => url.startsWith(rootURL) && !url.startsWith(workURL),
    )
    if (fromRepo.length > 0) {
      fail(`${label}: resolved ${fromRepo.length} module(s) from the monorepo, e.g. ${fromRepo[0]}`)
    }
  }

  const engineModule = (entry, sub) =>
    entry.output.resolvedURLs.some((url) => url.includes(`/${engineName}/`) && url.endsWith(sub))
  for (const entry of references) {
    const engineURLs = entry.output.resolvedURLs.filter(
      (url) => url.includes(`/${engineName}/`) || url.endsWith('/payload-engine.node'),
    )
    if (engineURLs.length > 0) {
      fail(
        `${database} ${entry.label}: PAYLOAD_ENGINE unset but resolved ${engineURLs.length} engine-rs module(s), e.g. ${engineURLs[0]}`,
      )
    }
  }
  // the db adapters load `/adapter` + `/sqlite` (sqlite) or `/mongodb` (mongodb), not the root
  const engineModules = [
    '/dist/ops/index.js',
    '/dist/ops-write/index.js',
    '/dist/ops-global/index.js',
    '/dist/runtime/hooks.js',
    '/dist/query/index.js',
    ...(database === 'sqlite'
      ? ['/dist/adapter/index.js', '/dist/sqlite/libsql.js']
      : ['/dist/mongo-adapter/index.js']),
  ]
  for (const entry of candidates.filter((candidate) => candidate.app === sqliteOnlyAppDir)) {
    const mongoURLs = entry.output.resolvedURLs.filter((url) =>
      /\/(db-mongodb|mongoose|mongodb)\/|\/engine-rs\/dist\/(mongo-adapter|mongo-live)\//.test(url),
    )
    if (mongoURLs.length > 0) {
      fail(
        `${database} ${entry.label}: loaded ${mongoURLs.length} MongoDB module(s), e.g. ${mongoURLs[0]}`,
      )
    }
  }
  for (const entry of candidates) {
    const label = `${database} ${entry.label}`
    const missing = engineModules.filter((sub) => !engineModule(entry, sub))
    if (missing.length > 0) {
      fail(`${label}: did not load engine-rs ${missing.join(', ')}`)
    }
    if (
      !entry.output.resolvedURLs.some((url) => url.endsWith(`/${engineName}/payload-engine.node`))
    ) {
      fail(`${label}: the packaged addon was not resolved`)
    }
    const stats = entry.stats
    const dataEngine = database === 'sqlite' ? stats.engine : stats.mongoEngine
    const checks = {
      'core field hooks': sum(stats.core?.calls),
      'ops (read)': sum(stats.ops?.calls),
      'ops-global/auth': sum(stats.opsGlobal?.calls),
      'ops-write':
        typeof stats.opsWrite?.calls === 'number'
          ? stats.opsWrite.calls
          : sum(stats.opsWrite?.calls),
      // mongodb: the live engine (MONGO_ENGINE_CONTRACT.md stage 1b); stage-1 calls must be 0
      [`${database} engine calls`]:
        database === 'sqlite' ? sum(dataEngine?.calls) : sum(dataEngine?.liveCalls),
      [`${database} engines (${database === 'sqlite' ? 'native' : 'live'})`]:
        database === 'sqlite'
          ? (dataEngine?.engines?.native ?? 0)
          : (dataEngine?.engines?.live ?? 0),
    }
    if (
      database === 'mongodb' &&
      (sum(dataEngine?.calls) > 0 || (dataEngine?.engines?.native ?? 0) > 0)
    ) {
      fail(
        `${label}: the stage-1 MongoDB engine served calls (no stage-1 fallback on PAYLOAD_ENGINE=rs)`,
      )
    }
    console.log(`${label} engine stats: ${JSON.stringify(checks)}`)
    for (const [name, count] of Object.entries(checks)) {
      if (!(count > 0)) {
        fail(`${label}: no ${name} served by the Rust engine`)
      }
    }
    if ((dataEngine?.engines?.loopback ?? 0) > 0) {
      fail(`${label}: used the loopback (TS stand-in) engine`)
    }
  }

  let totalCompared = 0
  for (const candidate of candidates) {
    const result = compareRuns({ candidate, references })
    totalCompared += result.compared
    console.log(
      `${database} ${candidate.label} vs ${references.map((entry) => entry.label).join(' + ')}: ${result.compared} leaves, ${result.nondeterministic.length} nondeterministic, ${result.mismatches.length} mismatches`,
    )
    for (const mismatch of result.mismatches.slice(0, 40)) {
      fail(`${database} ${candidate.label}: ${describeMismatch(candidate.output, mismatch)}`)
    }
    if (result.mismatches.length > 40) {
      fail(
        `${database} ${candidate.label}: ... and ${result.mismatches.length - 40} more mismatches`,
      )
    }
  }
  if (totalCompared === 0) {
    fail(`${database}: compared nothing`)
  }
  negativeControls({ candidate: candidates[0], database, references })
}

/** Mutated candidates that must not pass: a changed value, swapped row ids, a stale timestamp. */
function negativeControls({ candidate, database, references }) {
  const controls = {
    'changed value': (steps) => {
      const createAuthor = steps.find((step) => step.name === 'create author')
      createAuthor.value.name = `${createAuthor.value.name}?`
    },
    'swapped array row ids': (steps) => {
      const tags = steps.find((step) => step.name === 'update post (de)').value.tags
      ;[tags[0].id, tags[1].id] = [tags[1].id, tags[0].id]
    },
    'one id for every array row': (steps) => {
      const tags = steps.find((step) => step.name === 'create post (en)').value.tags
      tags[1].id = tags[0].id
    },
    'stale updatedAt': (steps) => {
      const created = steps.find((step) => step.name === 'create author').value
      steps.find((step) => step.name === 'update author bio (de)').value.updatedAt =
        created.updatedAt
    },
  }
  for (const [name, mutate] of Object.entries(controls)) {
    const mutated = structuredClone(candidate.output)
    try {
      mutate(mutated.steps)
    } catch (error) {
      fail(`${database} negative control "${name}": cannot apply (${error.message})`)
      continue
    }
    const { mismatches } = compareRuns({
      candidate: { label: 'mutated', output: mutated },
      references,
    })
    if (mismatches.length === 0) {
      fail(`${database} negative control "${name}": the mutated candidate passed`)
    }
  }
}

function runScenario({ app = appDir, database, engine, label }) {
  const index = scenarioIndex++
  const outFile = path.join(options.work, `run-${index}.json`)
  const statsDir = path.join(options.work, `stats-${index}`)
  const dbFile = path.join(options.work, `run-${index}.db`)
  const mongoDatabase = `packaging_pk_${process.pid}_${index}`
  const location = database === 'sqlite' ? dbFile : withDatabase(options.mongodbURL, mongoDatabase)
  fs.rmSync(outFile, { force: true })
  fs.rmSync(statsDir, { force: true, recursive: true })
  fs.mkdirSync(statsDir, { recursive: true })
  const env = { ...process.env, TZ: 'UTC' }
  for (const key of Object.keys(env)) {
    if (/^PAYLOAD_|^NODE_OPTIONS$/.test(key)) {
      delete env[key]
    }
  }
  // stats files are offered to every run: a flag-unset run must not write any
  Object.assign(env, {
    PAYLOAD_RS_CORE_STATS_FILE: path.join(statsDir, 'core.json'),
    PAYLOAD_RS_ENGINE_STATS_FILE: path.join(statsDir, 'engine.json'),
    PAYLOAD_RS_MONGO_ENGINE_STATS_FILE: path.join(statsDir, 'mongo-engine.json'),
    PAYLOAD_RS_OPS_STATS_DIR: statsDir,
  })
  if (engine === 'rs') {
    env.PAYLOAD_ENGINE = 'rs'
  }
  const result = spawnSync(process.execPath, ['scenario.mjs', database, location, outFile], {
    cwd: app,
    encoding: 'utf8',
    env,
    timeout: 300_000,
  })
  for (const file of fs
    .readdirSync(options.work)
    .filter((name) => name.startsWith(`run-${index}.db`))) {
    fs.rmSync(path.join(options.work, file), { force: true })
  }
  if (database === 'mongodb') {
    dropMongoDatabase(location)
  }
  if (result.status !== 0) {
    fail(
      `${database} ${label} exited ${result.status ?? result.signal}:\n${result.stdout}\n${result.stderr}`,
    )
    return { app, database, engine, label }
  }
  const output = readJson(outFile)
  const statsFiles = fs.readdirSync(statsDir)
  if (engine === 'ts' && statsFiles.length > 0) {
    fail(`${database} ${label}: flag-unset run wrote engine stats ${statsFiles.join(', ')}`)
  }
  const stats = {
    core: readJsonIfExists(path.join(statsDir, 'core.json')),
    engine: readJsonIfExists(path.join(statsDir, 'engine.json')),
    mongoEngine: readJsonIfExists(path.join(statsDir, 'mongo-engine.json')),
    ops: readJsonIfExists(
      path.join(statsDir, statsFiles.find((name) => /^ops-\d+\.json$/.test(name)) ?? 'none'),
    ),
    opsGlobal: readJsonIfExists(
      path.join(statsDir, statsFiles.find((name) => /^ops-global-\d+\.json$/.test(name)) ?? 'none'),
    ),
    opsWrite: readJsonIfExists(path.join(statsDir, 'engine.json.ops-write.json')),
  }
  console.log(
    `${database} ${label}: ${output.steps.length} steps, ${output.resolvedURLs.length} modules resolved`,
  )
  return { app, database, engine, label, output, stats }
}

function withDatabase(url, database) {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.href
}

/** Drops a run's database through the app's own mongoose (the scenario drops it too). */
function dropMongoDatabase(url) {
  const script = `
    import { createRequire } from 'node:module'
    const mongoose = createRequire(import.meta.resolve('@payloadcms/db-mongodb'))('mongoose')
    const connection = await mongoose.createConnection(${JSON.stringify(url)}).asPromise()
    await connection.dropDatabase()
    await connection.close()`
  const result = spawnSync('node', ['--input-type=module', '-e', script], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.status !== 0) {
    fail(`could not drop ${url}: ${result.stderr}`)
  }
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

function runPnpm(args, options) {
  run(pnpmCommand[0], [...pnpmCommand[1], ...args], options)
}

function run(command, args, { cwd, isQuiet = false } = {}) {
  if (!isQuiet) {
    execFileSync(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
    return
  }
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status ?? result.signal}:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`,
    )
  }
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
