#!/usr/bin/env node
/**
 * Performance evaluation of the Rust engine against upstream TypeScript, over every user-facing
 * API surface (README.md): startup, the Local API, the REST endpoints, the GraphQL endpoint, with
 * the hooks / validation / access-control load of each config shape, for several collection sizes
 * and databases.
 *
 *   node test/__rs/perf/run.mjs [--databases mongodb,sqlite,postgres] [--shapes minimal,typical,...]
 *     [--sizes 100,1000,10000] [--surfaces local,rest,graphql,throughput]
 *     [--throughput-concurrency 8,64] [--categories read,partial-update,...]
 *     [--scenarios <regex>] [--startup-shapes ...] [--startup-runs 5] [--engines ts,rs]
 *     [--addon file] [--out dir] [--reuse] [--quick] [--min-time-ms 1000] [--min-iterations 10]
 *     [--max-iterations 300] [--max-time-ms 5000] [--no-samples] [--no-startup] [--no-scenarios]
 *     [--db-prefix perf] [--fuse on|off|shadow] [--processes 3] [--order shuffle|suite]
 *     [--cpus 0-7] [--verbose]
 *   node test/__rs/perf/run.mjs --list      # the scenario catalogue (markdown), nothing runs
 *
 * `--engines ts` or `--engines rs` alone measures one engine (absolute numbers, no comparison).
 * `--fuse <mode>` sets `PAYLOAD_RS_FUSE` for the bench processes (the fused read lanes,
 * packages/engine-rs/FUSE_CONTRACT.md); the bench environment drops every other `PAYLOAD_*`.
 *
 * Install: packs the packages (release layout: engine-rs plus this platform's addon package, the
 * addon being `--addon`, default the release build target/release/libpayload_node.so) and installs
 * them into .rs-runs/perf/app, so every measurement runs the packed dist builds as users get them.
 * `--reuse` keeps an existing app (the bench files are copied again).
 *
 * Each (database, shape, size) runs `--processes` rounds. A round starts one fresh process per
 * engine, each on its own fresh database, seeded one after the other; then the processes take turns
 * scenario by scenario (only one measures at a time, the engine that goes first alternates), so
 * both engines see the same machine state. The scenario order is shuffled per round (`--order
 * shuffle`, the default; read-only scenarios before mutating ones before throughput, as in the
 * catalogue), equal for every engine of the round, so no number depends on one fixed predecessor.
 * A cell (database, shape, size, engine) pools the samples of its processes and keeps each
 * process's numbers (`processes`) for the spread. `--cpus <list>` pins every bench process
 * (taskset). Engines: `ts` = PAYLOAD_ENGINE=ts (upstream), `rs` = PAYLOAD_ENGINE unset (the
 * default). NODE_ENV=production.
 *
 * Fails (exit 1) when a process crashes, an rs process did not map the engine addon or a ts
 * process did, a scenario errors (on one engine or on both), or ts and rs fingerprints of a scenario
 * differ (checked per round), or the installed perf app does not match the packed builds.
 * The app is installed from its own pnpm store (.rs-runs/perf/pnpm-store) and verified file by file
 * against the tarballs and `--addon` before anything runs (also with `--reuse`).
 * Writes <out>/results.json (everything, incl. every timed sample), <out>/scenarios.csv (one row
 * per database x shape x size x engine x scenario with every statistic), <out>/samples.csv (one row
 * per timed iteration), <out>/startup.csv, <out>/report.md and <out>/report.html (interactive
 * charts with filters), and the raw per-process results in <out>/cells/.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { packRelease } from '../../../packages/engine-rs/scripts/release/packRelease.mjs'
import { rebuildStaleDist } from '../packaging/rebuildStale.mjs'
import { writeReports } from './report.mjs'
import { createRandom } from './configs.mjs'
import { categories, scenarios, throughputScenarios } from './scenarios.mjs'
import { median, summarize } from './stats.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const list = (name, fallback) => option(name, fallback).split(',').filter(Boolean)
const isQuick = argv.includes('--quick')
const throughputConcurrency = list('--throughput-concurrency', '8,64').map(Number)
const catalogue = [...scenarios, ...throughputScenarios(throughputConcurrency)]

if (process.argv.includes('--list')) {
  printCatalogue()
  process.exit(0)
}

const options = {
  addon: path.resolve(option('--addon', path.join(root, 'target/release/libpayload_node.so'))),
  /** CPUs every bench process is pinned to (taskset list, e.g. `0-7`); empty: not pinned. */
  cpus: option('--cpus', ''),
  databases: list('--databases', 'mongodb,sqlite,postgres'),
  /** Prefix of the per-cell database names (shared servers: one prefix per user of the server). */
  dbPrefix: option('--db-prefix', 'perf'),
  engines: list('--engines', 'ts,rs'),
  fuse: option('--fuse', ''),
  maxIterations: Number(option('--max-iterations', isQuick ? 50 : 300)),
  maxTimeMs: Number(option('--max-time-ms', isQuick ? 1500 : 5000)),
  minIterations: Number(option('--min-iterations', isQuick ? 5 : 10)),
  minTimeMs: Number(option('--min-time-ms', isQuick ? 300 : 1000)),
  mongodbServer: option(
    '--mongodb-server',
    'mongodb://payload:payload@localhost:27018/?authSource=admin&directConnection=true&replicaSet=rs0',
  ),
  /** Scenario order of each round: `shuffle` (seeded by the round) or `suite` (catalogue order). */
  order: option('--order', 'shuffle'),
  out: path.resolve(option('--out', path.join(root, '.rs-runs/perf/out'))),
  /** Rounds per (database, shape, size): processes per engine. */
  processes: Number(option('--processes', isQuick ? 1 : 3)),
  shapes: list('--shapes', isQuick ? 'minimal,complex' : 'minimal,typical,complex,hooks'),
  sizes: list('--sizes', isQuick ? '100,1000' : '100,1000,10000').map(Number),
  startupRuns: Number(option('--startup-runs', isQuick ? 3 : 5)),
  startupShapes: list(
    '--startup-shapes',
    isQuick ? 'minimal,complex,wide-50' : 'minimal,typical,complex,hooks,wide-10,wide-50,wide-200',
  ),
  categories: list('--categories', ''),
  /** Prefix of the per-cell database names (shared servers: one prefix per user / agent). */
  isSamplesKept: !argv.includes('--no-samples'),
  scenarioPattern: option('--scenarios', ''),
  surfaces: list('--surfaces', 'local,rest,graphql,throughput'),
  /** Concurrent callers of each throughput scenario (one scenario per level). */
  throughputConcurrency,
  warmup: Number(option('--warmup', 3)),
}
for (const category of options.categories) {
  if (!categories.includes(category)) {
    throw new Error(`--categories: unknown category ${category} (${categories.join(', ')})`)
  }
}
/**
 * `--engines` values: `ts` (upstream), `rs` (the default selection), and for attributing a
 * difference to a layer `db-rs` (Rust database engine, TS core), `core-rs` (TS database
 * adapter, Rust core), `rs-fused-off` / `rs-fused-writes` (`PAYLOAD_RS_FUSE_WRITES` off / on,
 * the fused MongoDB writes, packages/engine-rs/FUSED_WRITES.md), `rs-threads-<n>` (the default
 * selection with `PAYLOAD_MONGO_DRIVER_THREADS=<n>`, the MongoDB driver runtime's workers). Only ts
 * and rs cells are paired for the fingerprint checks and the report.
 */
const engineEnv = (engine) => {
  const threads = /^rs-threads-([1-9]\d*)$/.exec(engine)?.[1]
  return threads ? { PAYLOAD_MONGO_DRIVER_THREADS: threads } : engineVariants[engine]
}
const engineVariants = {
  'core-rs': { PAYLOAD_CORE_ENGINE: 'rs', PAYLOAD_ENGINE: 'ts' },
  'db-rs': { PAYLOAD_CORE_ENGINE: 'ts' },
  'rs-fused-off': { PAYLOAD_RS_FUSE_WRITES: 'off' },
  'rs-fused-writes': { PAYLOAD_RS_FUSE_WRITES: 'on' },
  rs: {},
  ts: { PAYLOAD_ENGINE: 'ts' },
}
if (!['shuffle', 'suite'].includes(options.order)) {
  throw new Error(`--order: shuffle or suite, not ${options.order}`)
}
for (const engine of options.engines) {
  if (!engineEnv(engine)) {
    throw new Error(
      `--engines: unknown engine ${engine} (${Object.keys(engineVariants).join(', ')}, rs-threads-<n>)`,
    )
  }
}
const isReuse = argv.includes('--reuse')
const isStartup = !argv.includes('--no-startup')
const isScenarios = !argv.includes('--no-scenarios')
const isVerbose = argv.includes('--verbose')

const appDir = path.join(root, '.rs-runs/perf/app')
const packedDir = path.join(root, '.rs-runs/perf/packed')
const cellsDir = path.join(options.out, 'cells')
fs.mkdirSync(cellsDir, { recursive: true })
const failures = []
const fail = (message) => {
  failures.push(message)
  console.error(`FAIL ${message}`)
}

if (!isReuse || !fs.existsSync(path.join(appDir, 'node_modules/payload'))) {
  install()
}
verifyInstall()
for (const file of ['bench.mjs', 'configs.mjs', 'scenarios.mjs', 'stats.mjs']) {
  fs.copyFileSync(path.join(here, file), path.join(appDir, file))
}

const cells = []
let cellIndex = 0
for (const database of options.databases) {
  if (isStartup) {
    for (const shape of options.startupShapes) {
      for (const engine of orderedEngines()) {
        cells.push(runStartup({ database, engine, shape }))
      }
    }
  }
  if (isScenarios) {
    for (const shape of options.shapes) {
      for (const size of options.sizes) {
        cells.push(...(await runScenarios({ database, shape, size })))
      }
    }
  }
}

checkCells(cells)
const results = {
  cells,
  createdAt: new Date().toISOString(),
  failures,
  options: { ...options, addon: path.relative(root, options.addon) },
}
fs.writeFileSync(path.join(options.out, 'results.json'), JSON.stringify(results))
writeReports({ outDir: options.out, results })
console.log(`\nreport: ${path.join(options.out, 'report.md')}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('perf: OK')

// ------------------------------------------------------------------------------------------

/** Alternates ts-first / rs-first between cells (thermal and cache order effects). */
function orderedEngines() {
  cellIndex++
  return cellIndex % 2 === 0 ? [...options.engines].reverse() : options.engines
}

function install() {
  const dirs = [
    'translations',
    'payload',
    'drizzle',
    'db-sqlite',
    'db-mongodb',
    'db-postgres',
    'ui',
    'graphql',
    'next',
    'richtext-lexical',
  ]
  execFileSync('node', [path.join(root, 'packages/engine-rs/scripts/buildDist.mjs')], {
    cwd: root,
    stdio: 'inherit',
  })
  rebuildStaleDist({ dirs })
  const platform = createRequire(import.meta.url)(path.join(root, 'packages/engine-rs/addon.cjs'))
    .platformPackageName()
    .slice('@payloadcms/engine-rs-'.length)
  const addonsDir = path.join(root, '.rs-runs/perf/addons')
  fs.rmSync(addonsDir, { force: true, recursive: true })
  fs.mkdirSync(path.join(addonsDir, platform), { recursive: true })
  fs.copyFileSync(options.addon, path.join(addonsDir, platform, 'payload-engine.node'))
  const { tarballs } = packRelease({
    addons: { [platform]: path.join(addonsDir, platform, 'payload-engine.node') },
    outDir: packedDir,
    packageDirs: dirs,
  })
  fs.rmSync(appDir, { force: true, recursive: true })
  fs.mkdirSync(appDir, { recursive: true })
  const version = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version
  const fileSpec = (name) => `file:${tarballs[name]}`
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'rs-perf-app',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@payloadcms/db-mongodb': fileSpec('@payloadcms/db-mongodb'),
          '@payloadcms/db-postgres': fileSpec('@payloadcms/db-postgres'),
          '@payloadcms/db-sqlite': fileSpec('@payloadcms/db-sqlite'),
          '@payloadcms/drizzle': fileSpec('@payloadcms/drizzle'),
          '@payloadcms/graphql': fileSpec('@payloadcms/graphql'),
          '@payloadcms/next': fileSpec('@payloadcms/next'),
          '@payloadcms/richtext-lexical': fileSpec('@payloadcms/richtext-lexical'),
          graphql: '16.8.1',
          next: version('test/node_modules/next/package.json'),
          payload: fileSpec('payload'),
          'qs-esm': JSON.parse(
            fs.readFileSync(path.join(root, 'packages/payload/package.json'), 'utf8'),
          ).dependencies['qs-esm'],
          react: version('packages/ui/node_modules/react/package.json'),
          'react-dom': version('packages/ui/node_modules/react-dom/package.json'),
        },
      },
      null,
      2,
    ),
  )
  const overrides = Object.entries(tarballs)
    .map(([name, tarball]) => `  '${name}': 'file:${tarball}'`)
    .join('\n')
  fs.writeFileSync(path.join(appDir, 'pnpm-workspace.yaml'), `overrides:\n${overrides}\n`)
  // a store of its own: the shared store can hand back another checkout's files for the same
  // `file:` tarball names (pnpm 11 reads pnpm_config_*, not npm_config_*)
  execFileSync(
    'pnpm',
    ['install', '--ignore-scripts', '--prefer-offline', '--config.confirmModulesPurge=false'],
    {
      cwd: appDir,
      env: { ...process.env, pnpm_config_store_dir: path.join(root, '.rs-runs/perf/pnpm-store') },
      stdio: 'inherit',
    },
  )
}

/**
 * Every file of every packed tarball must be installed in the perf app byte for byte, and the
 * installed addon must be `--addon`: an install that linked other files (another checkout's
 * build) or a `--reuse` app older than the addon fails the run before anything is measured.
 */
function verifyInstall() {
  const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const pnpmDir = path.join(appDir, 'node_modules/.pnpm')
  const installedDir = (name) => {
    const direct = path.join(appDir, 'node_modules', name)
    const nested = fs.existsSync(direct)
      ? direct
      : fs
          .readdirSync(pnpmDir)
          .map((entry) => path.join(pnpmDir, entry, 'node_modules', name))
          .find((dir) => fs.existsSync(path.join(dir, 'package.json')))
    return nested && fs.realpathSync(nested)
  }
  const mismatches = []
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-perf-verify-'))
  try {
    for (const tarball of fs.readdirSync(packedDir).filter((file) => file.endsWith('.tgz'))) {
      const dir = path.join(unpacked, tarball)
      fs.mkdirSync(dir)
      execFileSync('tar', ['-xzf', path.join(packedDir, tarball), '-C', dir])
      const packageDir = path.join(dir, 'package')
      const { name } = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
      const installed = installedDir(name)
      if (!installed) {
        mismatches.push(`${name}: not installed`)
        continue
      }
      const files = fs
        .readdirSync(packageDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(packageDir, path.join(entry.parentPath, entry.name)))
      const differing = files.filter((file) => {
        const target = path.join(installed, file)
        return !fs.existsSync(target) || sha256(target) !== sha256(path.join(packageDir, file))
      })
      if (differing.length > 0) {
        mismatches.push(
          `${name}: ${differing.length} of ${files.length} files differ from ${tarball} (${differing.slice(0, 5).join(', ')})`,
        )
      }
      if (
        files.includes('payload-engine.node') &&
        sha256(path.join(installed, 'payload-engine.node')) !== sha256(options.addon)
      ) {
        mismatches.push(
          `${name}: the installed addon is not --addon ${options.addon}${isReuse ? ' (rebuilt after the app was installed? run without --reuse)' : ''}`,
        )
      }
    }
  } finally {
    fs.rmSync(unpacked, { force: true, recursive: true })
  }
  if (mismatches.length > 0) {
    throw new Error(
      `the perf app ${appDir} does not match the packed builds in ${packedDir}:\n${mismatches.join('\n')}`,
    )
  }
  console.log('perf app: every installed file matches the packed tarballs and --addon')
}

/** A fresh database for one cell: `{ location, drop }`. */
function createDatabase(database, name) {
  if (database === 'mongodb') {
    const url = new URL(options.mongodbServer)
    url.pathname = `/${name}`
    return { drop: () => dropMongo(url.href), location: url.href }
  }
  if (database === 'sqlite') {
    const file = path.join(options.out, `${name}.db`)
    const drop = () => {
      for (const entry of fs
        .readdirSync(options.out)
        .filter((entry) => entry.startsWith(`${name}.db`))) {
        fs.rmSync(path.join(options.out, entry), { force: true })
      }
    }
    drop()
    return { drop, location: file }
  }
  const pgScript = path.join(root, 'packages/engine-rs/scripts/pg/pgDatabases.mjs')
  execFileSync('node', [pgScript, 'drop', name], { stdio: 'ignore' })
  execFileSync('node', [pgScript, 'create', name], { stdio: 'ignore' })
  return {
    drop: () => execFileSync('node', [pgScript, 'drop', name], { stdio: 'ignore' }),
    location: `postgres://payload:payload@localhost:5433/${name}`,
  }
}

function dropMongo(url) {
  const script = `import mongoose from 'mongoose'
const connection = await mongoose.createConnection(${JSON.stringify(url)}).asPromise()
await connection.dropDatabase()
await connection.close()`
  const dbMongodb = fs.realpathSync(path.join(appDir, 'node_modules/@payloadcms/db-mongodb'))
  execFileSync('node', ['--input-type=module', '-e', script], { cwd: dbMongodb, stdio: 'ignore' })
}

/**
 * The spec file, environment and command line of one bench process (`uploadDir`: the media
 * collection's files, one directory per process, removed afterwards).
 */
function benchProcess({ engine, label, spec: specInput }) {
  const specFile = path.join(cellsDir, `${label}.spec.json`)
  const uploadDir = path.join(options.out, 'uploads', label)
  const spec = { ...specInput, uploadDir }
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2))
  const env = { ...process.env, NODE_ENV: 'production', TZ: 'UTC' }
  for (const key of Object.keys(env)) {
    if (/^PAYLOAD_|^NODE_OPTIONS$|^DATABASE_URL$/.test(key)) {
      delete env[key]
    }
  }
  Object.assign(env, engineEnv(engine))
  if (options.fuse) {
    env.PAYLOAD_RS_FUSE = options.fuse
  }
  const node = [process.execPath, '--expose-gc', 'bench.mjs', specFile]
  const [command, ...args] = options.cpus ? ['taskset', '-c', options.cpus, ...node] : node
  return { args, command, env, spec, uploadDir }
}

function spawnBench(input) {
  const { args, command, env, spec, uploadDir } = benchProcess(input)
  const { label } = input
  const started = Date.now()
  const child = spawnSync(command, args, {
    cwd: appDir,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: isVerbose ? ['ignore', 'inherit', 'pipe'] : 'pipe',
    timeout: 3_600_000,
  })
  fs.rmSync(uploadDir, { force: true, recursive: true })
  if (child.status !== 0) {
    fail(`${label} exited ${child.status ?? child.signal}: ${(child.stderr ?? '').slice(-3000)}`)
    return undefined
  }
  const output = JSON.parse(fs.readFileSync(spec.out, 'utf8'))
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`)
  return output
}

function runStartup({ database, engine, shape }) {
  const label = `startup-${database}-${shape}-${engine}`
  const { drop, location } = createDatabase(
    database,
    `${options.dbPrefix}_${process.pid}_${label.replaceAll('-', '_')}`,
  )
  const base = { database, location, shape, size: 0, surfaces: [] }
  const runs = []
  try {
    // first start creates the schema / collections (not measured)
    spawnBench({
      engine,
      label: `${label}-prepare`,
      spec: { ...base, mode: 'prepare', out: path.join(cellsDir, `${label}-prepare.json`) },
    })
    for (let index = 0; index < options.startupRuns; index++) {
      const output = spawnBench({
        engine,
        label: `${label}-${index}`,
        spec: { ...base, mode: 'startup', out: path.join(cellsDir, `${label}-${index}.json`) },
      })
      if (output) {
        runs.push(output)
      }
    }
  } finally {
    drop()
  }
  return {
    addonLoaded: runs.map((run) => run.addonLoaded),
    database,
    engine,
    kind: 'startup',
    runs: runs.map((run) => run.startup),
    shape,
  }
}

/**
 * `options.processes` rounds of one (database, shape, size). A round starts one bench process per
 * engine (fresh database each, seeded one after the other), then drives them over IPC scenario by
 * scenario, one process measuring at a time, the engine going first alternating; the fingerprints
 * of the round are compared. Returns one cell per engine pooling its rounds (`poolCell`).
 */
async function runScenarios({ database, shape, size }) {
  const outputs = Object.fromEntries(options.engines.map((engine) => [engine, []]))
  for (let round = 0; round < options.processes; round++) {
    const driven = []
    try {
      for (const engine of orderedEngines()) {
        driven.push(await startDriven({ database, engine, round, shape, size }))
      }
      const listed = JSON.stringify(driven[0].scenarios)
      for (const other of driven.slice(1)) {
        if (JSON.stringify(other.scenarios) !== listed) {
          throw new Error(`${other.label}: a different scenario list than ${driven[0].label}`)
        }
      }
      for (const [position, index] of scenarioOrder(driven[0].scenarios, round).entries()) {
        for (const bench of position % 2 === 0 ? driven : [...driven].reverse()) {
          await bench.request({ index, type: 'run' })
        }
      }
      for (const bench of driven) {
        outputs[bench.engine][round] = await bench.finish()
      }
    } catch (error) {
      fail(`${database} ${shape} ${size} round ${round}: ${error.message}`)
      for (const bench of driven) {
        bench.kill()
      }
    } finally {
      for (const bench of driven) {
        bench.drop()
      }
    }
    checkRound({
      database,
      outputs: Object.fromEntries(
        Object.entries(outputs).map(([engine, rounds]) => [engine, rounds[round]]),
      ),
      round,
      shape,
      size,
    })
  }
  return options.engines.map((engine) =>
    poolCell({ database, engine, outputs: outputs[engine], shape, size }),
  )
}

/**
 * One bench process in driven mode (bench.mjs over IPC), started and seeded: resolves once it
 * reported its scenario list. `request` sends a message and waits for the reply, `finish` ends the
 * process and reads its output.
 */
async function startDriven({ database, engine, round, shape, size }) {
  const label = `${database}-${shape}-${size}-${engine}-p${round}`
  const { drop, location } = createDatabase(
    database,
    `${options.dbPrefix}_${process.pid}_${label.replaceAll('-', '_')}`,
  )
  const { args, command, env, spec, uploadDir } = benchProcess({
    engine,
    label,
    spec: {
      database,
      location,
      maxIterations: options.maxIterations,
      maxTimeMs: options.maxTimeMs,
      minIterations: options.minIterations,
      minTimeMs: options.minTimeMs,
      mode: 'scenarios',
      out: path.join(cellsDir, `${label}.json`),
      shape,
      size,
      categories: options.categories,
      // pooled by poolCell; dropped from results.json there when --no-samples
      isSamplesKept: true,
      scenarioPattern: options.scenarioPattern,
      surfaces: options.surfaces,
      throughputConcurrency: options.throughputConcurrency,
      verbose: isVerbose,
      warmup: options.warmup,
    },
  })
  const started = Date.now()
  const child = spawn(command, args, {
    cwd: appDir,
    env,
    stdio: ['ignore', isVerbose ? 'inherit' : 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-3000)
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3_600_000)
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve(code ?? signal)
    }),
  )
  const next = () =>
    Promise.race([
      new Promise((resolve) => child.once('message', resolve)),
      exited.then((status) => {
        throw new Error(`${label} exited ${status}: ${stderr}`)
      }),
    ])
  const cleanUp = () => {
    fs.rmSync(uploadDir, { force: true, recursive: true })
    drop()
  }
  try {
    const ready = await next()
    return {
      drop: cleanUp,
      engine,
      finish: async () => {
        child.send({ type: 'finish' })
        const status = await exited
        if (status !== 0) {
          fail(`${label} exited ${status}: ${stderr}`)
          return undefined
        }
        console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`)
        return JSON.parse(fs.readFileSync(spec.out, 'utf8'))
      },
      kill: () => child.kill('SIGKILL'),
      label,
      request: (message) => {
        child.send(message)
        return next()
      },
      scenarios: ready.scenarios,
    }
  } catch (error) {
    child.kill('SIGKILL')
    cleanUp()
    throw error
  }
}

/**
 * The indexes of `listed` in the order a round measures them: read-only scenarios, then mutating
 * ones, then throughput (as in the catalogue); within the first two groups shuffled with the round
 * as the seed (`--order shuffle`), or the catalogue order (`--order suite`).
 */
function scenarioOrder(listed, round) {
  const indexes = listed.map((_, index) => index)
  const groups = [
    indexes.filter((index) => listed[index].surface !== 'throughput' && !listed[index].isMutating),
    indexes.filter((index) => listed[index].surface !== 'throughput' && listed[index].isMutating),
    indexes.filter((index) => listed[index].surface === 'throughput'),
  ]
  if (options.order === 'suite') {
    return groups.flat()
  }
  const random = createRandom(round + 1)
  const shuffle = (values) => {
    const shuffled = [...values]
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1))
      ;[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]]
    }
    return shuffled
  }
  return [...shuffle(groups[0]), ...shuffle(groups[1]), ...groups[2]]
}

/**
 * One cell (database, shape, size, engine) from its rounds' outputs: per scenario the pooled
 * samples' statistics, the medians of the per-process GC, heap and throughput numbers, and
 * `processes`, each process's own numbers (by round) for the spread.
 */
function poolCell({ database, engine, outputs, shape, size }) {
  const runs = outputs.map((output, round) => ({ output, round })).filter(({ output }) => output)
  const first = runs[0]?.output
  const catalogueIndex = (entry) =>
    catalogue.findIndex(
      (scenario) => scenario.surface === entry.surface && scenario.name === entry.name,
    )
  const scenarios = (first?.scenarios ?? [])
    .toSorted((a, b) => catalogueIndex(a) - catalogueIndex(b))
    .map((listed) => {
      const entries = runs
        .map(({ output, round }) => ({
          entry: output.scenarios.find(
            (entry) => entry.surface === listed.surface && entry.name === listed.name,
          ),
          round,
        }))
        .filter(({ entry }) => entry)
      const measured = entries.map(({ entry }) => entry).filter((entry) => !entry.error)
      const medianOf = (valueOf) => median(measured.map(valueOf))
      const samples = measured.flatMap((entry) => entry.samples ?? [])
      const cpuSamples = measured.flatMap((entry) => entry.cpuSamples ?? [])
      const throughput = measured[0]?.throughput && {
        concurrency: measured[0].throughput.concurrency,
        cpuMsPerRequest: medianOf((entry) => entry.throughput.cpuMsPerRequest),
        eventLoopUtilization: medianOf((entry) => entry.throughput.eventLoopUtilization),
        jsThreadMsPerRequest: medianOf((entry) => entry.throughput.jsThreadMsPerRequest),
        requests: measured.reduce((sum, entry) => sum + entry.throughput.requests, 0),
        requestsPerSecond: medianOf((entry) => entry.throughput.requestsPerSecond),
      }
      return {
        category: listed.category,
        ...(measured[0]?.cpu && { cpu: summarize(cpuSamples) }),
        error: entries.find(({ entry }) => entry.error)?.entry.error,
        fingerprint: listed.fingerprint,
        gc: measured[0]?.gc && {
          byKind: measured[0].gc.byKind,
          count: medianOf((entry) => entry.gc.count),
          ms: medianOf((entry) => entry.gc.ms),
        },
        heapDeltaBytes: medianOf((entry) => entry.heapDeltaBytes),
        hookCalls: listed.hookCalls,
        name: listed.name,
        processes: entries.map(({ entry, round }) => ({
          cpuMedianMs: entry.cpu?.medianMs,
          error: entry.error?.message,
          gcMs: entry.gc?.ms,
          heapUsedAfter: entry.memoryAfter?.heapUsed,
          medianMs: entry.stats.medianMs,
          n: entry.stats.n,
          p95Ms: entry.stats.p95Ms,
          position: entry.memoryAfter?.position,
          requestsPerSecond: entry.throughput?.requestsPerSecond,
          round,
          rssAfter: entry.memoryAfter?.rss,
        })),
        result: listed.result,
        stats: summarize(samples),
        surface: listed.surface,
        ...(throughput && { throughput }),
        wallMs: measured.reduce((sum, entry) => sum + (entry.wallMs ?? 0), 0),
        ...(options.isSamplesKept && {
          ...(measured[0]?.cpuSamples && { cpuSamples }),
          samples,
        }),
      }
    })
  const seedOf = (key) => median(runs.map(({ output }) => output.seed?.[key]))
  return {
    addonLoaded: runs.map(({ output }) => output.addonLoaded),
    database,
    engine,
    environment: first?.environment,
    kind: 'scenarios',
    processes: runs.length,
    scenarios,
    seed: first?.seed && {
      postsCreateMs: seedOf('postsCreateMs'),
      postsPerSecond: seedOf('postsPerSecond'),
      totalMs: seedOf('totalMs'),
    },
    shape,
    size,
    startup: first?.startup,
  }
}

/** Engine identity of every process. */
function checkCells(cells) {
  for (const cell of cells) {
    const name = `${cell.kind} ${cell.database} ${cell.shape}${cell.size !== undefined ? ` ${cell.size}` : ''} ${cell.engine}`
    for (const loaded of cell.addonLoaded) {
      if (loaded === false && cell.engine !== 'ts') {
        fail(`${name}: the engine addon was not loaded`)
      }
      if (loaded === true && cell.engine === 'ts') {
        fail(`${name}: PAYLOAD_ENGINE=ts loaded the engine addon`)
      }
    }
  }
}

/** The ts and rs processes of one round: errors on one side only, fingerprint equality. */
function checkRound({ database, outputs: { rs, ts }, round, shape, size }) {
  if (!rs || !ts) {
    return
  }
  for (const tsScenario of ts.scenarios) {
    const rsScenario = rs.scenarios.find(
      (scenario) => scenario.surface === tsScenario.surface && scenario.name === tsScenario.name,
    )
    const where = `${database} ${shape} ${size} round ${round} ${tsScenario.surface} "${tsScenario.name}"`
    if (!rsScenario) {
      fail(`${where}: missing in rs`)
      continue
    }
    if (Boolean(tsScenario.error) !== Boolean(rsScenario.error)) {
      fail(
        `${where}: error on one engine only: ts ${tsScenario.error?.message ?? 'ok'} / rs ${rsScenario.error?.message ?? 'ok'}`,
      )
      continue
    }
    if (tsScenario.error) {
      // a scenario that measures nothing (a bug of the scenario or of the config shape)
      fail(`${where}: errors on both engines: ${tsScenario.error.message}`)
      continue
    }
    if (JSON.stringify(tsScenario.fingerprint) !== JSON.stringify(rsScenario.fingerprint)) {
      const differences = fingerprintDifferences(tsScenario.fingerprint, rsScenario.fingerprint)
      const reportPath = writeMismatch({
        differences,
        name: `${database}-${shape}-${size}-r${round}-${tsScenario.surface}-${tsScenario.name}`,
        outputs: { rs, ts },
        rsScenario,
        tsScenario,
      })
      fail(
        `${where}: result fingerprints differ (${reportPath}): ${differences.slice(0, 10).join('; ')}`,
      )
    }
    if (JSON.stringify(tsScenario.hookCalls) !== JSON.stringify(rsScenario.hookCalls)) {
      fail(
        `${where}: hook calls differ: ts ${JSON.stringify(tsScenario.hookCalls)} / rs ${JSON.stringify(rsScenario.hookCalls)}`,
      )
    }
  }
}

/** The paths where two fingerprints differ, with each side's value (`-`: absent). */
function fingerprintDifferences(ts, rs, at = '') {
  if (
    ts &&
    rs &&
    typeof ts === 'object' &&
    typeof rs === 'object' &&
    Array.isArray(ts) === Array.isArray(rs)
  ) {
    return [...new Set([...Object.keys(ts), ...Object.keys(rs)])]
      .toSorted()
      .flatMap((key) => fingerprintDifferences(ts[key], rs[key], at ? `${at}.${key}` : key))
  }
  if (JSON.stringify(ts) === JSON.stringify(rs)) {
    return []
  }
  const show = (value) => (value === undefined ? '-' : JSON.stringify(value).slice(0, 200))
  return [`${at || '(root)'}: ts ${show(ts)} / rs ${show(rs)}`]
}

/**
 * A fingerprint mismatch's report, <out>/mismatches/<name>.json: both engines' full fingerprints
 * and first responses (bench.mjs `firstResultsPath`) and the differing paths. Returns its path.
 */
function writeMismatch({ differences, name, outputs, rsScenario, tsScenario }) {
  const key = `${tsScenario.surface} ${tsScenario.name}`
  const firstResultOf = (output) => {
    try {
      return JSON.parse(fs.readFileSync(output.firstResultsPath, 'utf8'))[key]
    } catch (error) {
      return { unavailable: String(error) }
    }
  }
  const reportPath = path.join(
    options.out,
    'mismatches',
    `${name.replaceAll(/[^\w.-]+/g, '_')}.json`,
  )
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        differences,
        rs: { fingerprint: rsScenario.fingerprint, firstResult: firstResultOf(outputs.rs) },
        ts: { fingerprint: tsScenario.fingerprint, firstResult: firstResultOf(outputs.ts) },
      },
      null,
      2,
    ),
  )
  return reportPath
}

/** The scenario catalogue as markdown, grouped by category. */
function printCatalogue() {
  const shapesOf = (scenario) => (scenario.shapes ? scenario.shapes.join(', ') : 'all')
  let md = `${catalogue.length} scenarios (plus startup and seeding)\n`
  for (const category of categories) {
    const rows = catalogue.filter((scenario) => scenario.category === category)
    md += `\n### ${category} (${rows.length})\n\n| surface | scenario | shapes |\n| --- | --- | --- |\n`
    for (const scenario of rows) {
      md += `| ${scenario.surface} | ${scenario.name} | ${shapesOf(scenario)} |\n`
    }
  }
  console.log(md)
}
