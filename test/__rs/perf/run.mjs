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
 *     [--db-prefix perf] [--verbose]
 *   node test/__rs/perf/run.mjs --list      # the scenario catalogue (markdown), nothing runs
 *
 * `--engines ts` or `--engines rs` alone measures one engine (absolute numbers, no comparison).
 *
 * Install: packs the packages (release layout: engine-rs plus this platform's addon package, the
 * addon being `--addon`, default the release build target/release/libpayload_node.so) and installs
 * them into .rs-runs/perf/app, so every measurement runs the packed dist builds as users get them.
 * `--reuse` keeps an existing app (the bench files are copied again).
 *
 * Each (database, shape, size, engine) cell is one fresh process on a fresh database, cells run one
 * at a time (no concurrent load), the engine order alternates between cells. Engines: `ts` =
 * PAYLOAD_ENGINE=ts (upstream), `rs` = PAYLOAD_ENGINE unset (the default). NODE_ENV=production.
 *
 * Fails (exit 1) when a cell crashes, an rs process did not map the engine addon or a ts process
 * did, a scenario errors on one engine only, or ts and rs fingerprints of a scenario differ.
 * Writes <out>/results.json (everything, incl. every timed sample), <out>/scenarios.csv (one row
 * per database x shape x size x engine x scenario with every statistic), <out>/samples.csv (one row
 * per timed iteration), <out>/startup.csv, <out>/report.md and <out>/report.html (interactive
 * charts with filters), and the raw per-process results in <out>/cells/.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { packRelease } from '../../../packages/engine-rs/scripts/release/packRelease.mjs'
import { rebuildStaleDist } from '../packaging/rebuildStale.mjs'
import { writeReports } from './report.mjs'
import { categories, scenarios, throughputScenarios } from './scenarios.mjs'

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
  databases: list('--databases', 'mongodb,sqlite,postgres'),
  /** Prefix of the per-cell database names (shared servers: one prefix per user of the server). */
  dbPrefix: option('--db-prefix', 'perf'),
  engines: list('--engines', 'ts,rs'),
  maxIterations: Number(option('--max-iterations', isQuick ? 50 : 300)),
  maxTimeMs: Number(option('--max-time-ms', isQuick ? 1500 : 5000)),
  minIterations: Number(option('--min-iterations', isQuick ? 5 : 10)),
  minTimeMs: Number(option('--min-time-ms', isQuick ? 300 : 1000)),
  mongodbServer: option(
    '--mongodb-server',
    'mongodb://payload:payload@localhost:27018/?authSource=admin&directConnection=true&replicaSet=rs0',
  ),
  out: path.resolve(option('--out', path.join(root, '.rs-runs/perf/out'))),
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
 * adapter, Rust core) and `rs-fused-off` (the default without the fused MongoDB writes,
 * packages/engine-rs/FUSED_WRITES.md). Only ts and rs cells are paired for the fingerprint checks
 * and the report.
 */
const engineVariants = {
  'core-rs': { PAYLOAD_CORE_ENGINE: 'rs', PAYLOAD_ENGINE: 'ts' },
  'db-rs': { PAYLOAD_CORE_ENGINE: 'ts' },
  'rs-fused-off': { PAYLOAD_RS_FUSE_WRITES: 'off' },
  rs: {},
  ts: { PAYLOAD_ENGINE: 'ts' },
}
for (const engine of options.engines) {
  if (!engineVariants[engine]) {
    throw new Error(
      `--engines: unknown engine ${engine} (${Object.keys(engineVariants).join(', ')})`,
    )
  }
}
const isReuse = argv.includes('--reuse')
const isStartup = !argv.includes('--no-startup')
const isScenarios = !argv.includes('--no-scenarios')
const isVerbose = argv.includes('--verbose')

const appDir = path.join(root, '.rs-runs/perf/app')
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
for (const file of ['bench.mjs', 'configs.mjs', 'scenarios.mjs']) {
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
        for (const engine of orderedEngines()) {
          cells.push(runScenarios({ database, engine, shape, size }))
        }
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
  const packedDir = path.join(root, '.rs-runs/perf/packed')
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
  execFileSync(
    'pnpm',
    ['install', '--ignore-scripts', '--prefer-offline', '--config.confirmModulesPurge=false'],
    { cwd: appDir, stdio: 'inherit' },
  )
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

function spawnBench({ engine, label, spec: specInput }) {
  const specFile = path.join(cellsDir, `${label}.spec.json`)
  // the media collection's files: one directory per process, removed afterwards
  const uploadDir = path.join(options.out, 'uploads', label)
  const spec = { ...specInput, uploadDir }
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2))
  const env = { ...process.env, NODE_ENV: 'production', TZ: 'UTC' }
  for (const key of Object.keys(env)) {
    if (/^PAYLOAD_|^NODE_OPTIONS$|^DATABASE_URL$/.test(key)) {
      delete env[key]
    }
  }
  Object.assign(env, engineVariants[engine])
  const started = Date.now()
  const child = spawnSync(process.execPath, ['--expose-gc', 'bench.mjs', specFile], {
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

function runScenarios({ database, engine, shape, size }) {
  const label = `${database}-${shape}-${size}-${engine}`
  const { drop, location } = createDatabase(
    database,
    `${options.dbPrefix}_${process.pid}_${label.replaceAll('-', '_')}`,
  )
  try {
    const output = spawnBench({
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
        isSamplesKept: options.isSamplesKept,
        scenarioPattern: options.scenarioPattern,
        surfaces: options.surfaces,
        throughputConcurrency: options.throughputConcurrency,
        verbose: isVerbose,
        warmup: options.warmup,
      },
    })
    return {
      addonLoaded: output ? [output.addonLoaded] : [],
      database,
      engine,
      environment: output?.environment,
      kind: 'scenarios',
      scenarios: output?.scenarios ?? [],
      seed: output?.seed,
      shape,
      size,
      startup: output?.startup,
    }
  } finally {
    drop()
  }
}

/** Engine identity, errors on one side only, fingerprint equality. */
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
  const scenarioCells = cells.filter((cell) => cell.kind === 'scenarios')
  for (const tsCell of scenarioCells.filter((cell) => cell.engine === 'ts')) {
    const rsCell = scenarioCells.find(
      (cell) =>
        cell.engine === 'rs' &&
        cell.database === tsCell.database &&
        cell.shape === tsCell.shape &&
        cell.size === tsCell.size,
    )
    if (!rsCell) {
      continue
    }
    for (const tsScenario of tsCell.scenarios) {
      const rsScenario = rsCell.scenarios.find(
        (scenario) => scenario.surface === tsScenario.surface && scenario.name === tsScenario.name,
      )
      const where = `${tsCell.database} ${tsCell.shape} ${tsCell.size} ${tsScenario.surface} "${tsScenario.name}"`
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
      if (JSON.stringify(tsScenario.fingerprint) !== JSON.stringify(rsScenario.fingerprint)) {
        fail(
          `${where}: result fingerprints differ: ts ${JSON.stringify(tsScenario.fingerprint).slice(0, 400)} / rs ${JSON.stringify(rsScenario.fingerprint).slice(0, 400)}`,
        )
      }
      if (JSON.stringify(tsScenario.hookCalls) !== JSON.stringify(rsScenario.hookCalls)) {
        fail(
          `${where}: hook calls differ: ts ${JSON.stringify(tsScenario.hookCalls)} / rs ${JSON.stringify(rsScenario.hookCalls)}`,
        )
      }
    }
  }
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
