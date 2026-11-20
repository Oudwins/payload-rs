#!/usr/bin/env node
/**
 * The packed install under `next dev` (Turbopack, the bundler test/hmr uses), with and without
 * `PAYLOAD_ENGINE=rs`. Runs on the app a `run.mjs --keep` run installed (engine-rs opted in):
 * packs @payloadcms/next and @payloadcms/graphql, adds them with `next` to the app, writes a
 * minimal Next.js app (`withPayload`, one route handler running Local API steps with lexical rich
 * text, hooks, localization, relationships and versions) and starts `next dev` per run.
 *
 * In development `withPayload` externalizes payload, the db adapters and drizzle, but bundles
 * richtext-lexical, so this covers both kinds of dispatch site: payload / db-sqlite / db-mongodb
 * loaded by Node, and the bundled richtext-lexical's runtime `import()` of
 * `@payloadcms/engine-rs/runtime/hooks`.
 *
 *   node test/__rs/packaging/nextDev.mjs [--work .rs-runs/packaging/work] [--port 3917]
 *     [--database sqlite|mongodb] [--mongodb-url url] [--skip-build] [--prod]
 *
 * --prod  `next build` + `next start` per run instead of `next dev` (the production bundling,
 *         where `withPayload` bundles payload unless the Rust engine is selected). Every rs run
 *         must see one payload instance: the route compares payload's `ValidationError` it
 *         imports with the one Node loads from the installed payload (what engine-rs uses).
 *
 * The package manager is `pnpm`, or `node $RS_PACKAGING_PNPM` (see run.mjs).
 *
 * Fails when: a server does not start or the route fails; a flag-unset run wrote engine stats;
 * the rs run made no Rust engine / core hook / ops calls; any engine-rs code or its addon ended
 * up in `.next` (it must be loaded by Node at runtime, never bundled); or the rs run's output
 * differs from the flag-unset runs (`compare.mjs`).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareRuns } from './compare.mjs'
import { rebuildStaleDist } from './rebuildStale.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1]
}
const work = path.resolve(option('--work', path.join(root, '.rs-runs/packaging/work')))
const isProd = argv.includes('--prod')
const pnpmCommand = process.env.RS_PACKAGING_PNPM
  ? [process.execPath, [process.env.RS_PACKAGING_PNPM]]
  : ['pnpm', []]
const port = Number(option('--port', '3917'))
const database = option('--database', 'sqlite')
const mongodbURL = option(
  '--mongodb-url',
  'mongodb://payload:payload@localhost:27018/?authSource=admin&directConnection=true&replicaSet=rs0',
)
const appDir = path.join(work, 'app')
const packedDir = path.join(work, 'packed')
if (
  !work.startsWith(path.join(root, '.rs-runs') + path.sep) ||
  !fs.existsSync(path.join(appDir, 'node_modules/@payloadcms/engine-rs'))
) {
  throw new Error(`no opted-in app in ${appDir} (run test/__rs/packaging/run.mjs --keep first)`)
}

const failures = []
const fail = (message) => {
  failures.push(message)
  console.error(`FAIL ${message}`)
}

try {
  if (!argv.includes('--skip-build')) {
    rebuildStaleDist({ dirs: ['next', 'graphql'] })
  }
  installNext()
  writeApp()
  const runs = []
  for (const [engine, label] of [
    ['ts', 'reference 1'],
    ['ts', 'reference 2'],
    ['rs', 'candidate'],
  ]) {
    runs.push(await runNextDev({ engine, index: runs.length, label }))
  }
  checkBundle()
  verify(runs)
} catch (error) {
  fail(error instanceof Error ? error.stack : String(error))
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nnext dev: OK')

// ------------------------------------------------------------------------------------------

function installNext() {
  if (fs.existsSync(path.join(appDir, 'node_modules/@payloadcms/next'))) {
    console.log('next and @payloadcms/next already installed in the app')
    return
  }
  const tarballs = {}
  for (const dir of ['graphql', 'next']) {
    const before = new Set(fs.readdirSync(packedDir))
    execFileSync(pnpmCommand[0], [...pnpmCommand[1], 'pack', '--pack-destination', packedDir], {
      cwd: path.join(root, 'packages', dir),
      stdio: 'ignore',
    })
    const created = fs
      .readdirSync(packedDir)
      .filter((file) => !before.has(file) && file.endsWith('.tgz'))
    if (created.length !== 1) {
      throw new Error(`pnpm pack of ${dir} produced ${created.join(', ') || 'nothing'}`)
    }
    tarballs[`@payloadcms/${dir}`] = path.join(packedDir, created[0])
  }
  const workspaceFile = path.join(appDir, 'pnpm-workspace.yaml')
  fs.writeFileSync(
    workspaceFile,
    fs.readFileSync(workspaceFile, 'utf8') +
      Object.entries(tarballs)
        .map(([name, tarball]) => `  '${name}': 'file:${tarball}'\n`)
        .join(''),
  )
  const nextVersion = JSON.parse(
    fs.readFileSync(path.join(root, 'test/node_modules/next/package.json'), 'utf8'),
  ).version
  execFileSync(
    pnpmCommand[0],
    [
      ...pnpmCommand[1],
      'add',
      `next@${nextVersion}`,
      'graphql@16.8.1',
      ...Object.entries(tarballs).map(([name, tarball]) => `${name}@file:${tarball}`),
      '--ignore-scripts',
      '--prefer-offline',
      '--config.confirmModulesPurge=false',
    ],
    { cwd: appDir, stdio: 'inherit' },
  )
}

function writeApp() {
  const files = {
    'next.config.mjs': `import { withPayload } from '@payloadcms/next/withPayload'
export default withPayload({ typescript: { ignoreBuildErrors: true } })
`,
    'payload.config.js': `import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { BlocksFeature, lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'

const db =
  process.env.PROBE_DATABASE === 'mongodb'
    ? mongooseAdapter({ ensureIndexes: true, url: process.env.PROBE_LOCATION })
    : sqliteAdapter({ client: { url: 'file:' + process.env.PROBE_LOCATION } })

export default buildConfig({
  admin: { importMap: { autoGenerate: false } },
  collections: [
    {
      slug: 'posts',
      versions: { drafts: true },
      hooks: {
        beforeChange: [({ data }) => ({ ...data, marker: 'hooked' })],
      },
      fields: [
        {
          name: 'title',
          type: 'text',
          localized: true,
          required: true,
          hooks: { afterRead: [({ value }) => (typeof value === 'string' ? value + '!' : value)] },
        },
        { name: 'marker', type: 'text' },
        { name: 'content', type: 'richText' },
        { name: 'related', type: 'relationship', relationTo: 'posts' },
      ],
    },
  ],
  db,
  // a block inside rich text: lexical's hooks run payload's traverseFields on its fields, through
  // the bundled richtext-lexical's dispatch
  editor: lexicalEditor({
    features: ({ defaultFeatures }) => [
      ...defaultFeatures,
      BlocksFeature({
        blocks: [
          {
            slug: 'note',
            fields: [
              {
                name: 'text',
                type: 'text',
                hooks: { afterRead: [({ value }) => (typeof value === 'string' ? value + '?' : value)] },
              },
            ],
          },
        ],
      }),
    ],
  }),
  localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'de'] },
  secret: 'next-dev-probe-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})
`,
    'app/layout.js': `export default function RootLayout({ children }) {
  return children
}
`,
    'app/api/probe/route.js': `import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { getPayload, ValidationError } from 'payload'

import config from '../../../payload.config.js'

export const dynamic = 'force-dynamic'

const richText = (text) => ({
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 }],
        direction: 'ltr',
        format: '',
        indent: 0,
        textFormat: 0,
        version: 1,
      },
      {
        type: 'block',
        fields: { id: '6620c0ffee0000000000000a', blockName: '', blockType: 'note', text: 'inner' },
        format: '',
        version: 2,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
})

export async function GET() {
  const startedAt = Date.now()
  const payload = await getPayload({ config })
  if (process.env.PROBE_PUSH === 'true') {
    // next start runs with NODE_ENV=production, where sqlite's connect does not push the schema
    const { pushDevSchema } = await import('@payloadcms/drizzle')
    await pushDevSchema(payload.db)
  }
  const steps = []
  const windows = []
  const step = async (name, run) => {
    const stepStartedAt = Date.now()
    try {
      steps.push({ name, value: await run() })
    } catch (error) {
      steps.push({ name, error: { message: error.message, name: error.name, status: error.status } })
    }
    windows.push([stepStartedAt, Date.now()])
  }
  let first
  await step('create', async () => {
    first = await payload.create({ overrideAccess: true,
      collection: 'posts',
      data: { content: richText('hello'), title: '  First  ' },
    })
    return first
  })
  await step('create related (de)', () =>
    payload.create({ overrideAccess: true, collection: 'posts', data: { related: first.id, title: 'Zweiter' }, locale: 'de' }),
  )
  await step('update draft', () =>
    payload.update({ overrideAccess: true, collection: 'posts', id: first.id, data: { title: 'Draft' }, draft: true }),
  )
  await step('find depth 1 locale all', () =>
    payload.find({ overrideAccess: true, collection: 'posts', depth: 1, locale: 'all', sort: 'createdAt' }),
  )
  await step('findVersions', () =>
    payload.findVersions({ overrideAccess: true, collection: 'posts', depth: 0, sort: 'createdAt' }),
  )
  await step('validation error', () => payload.create({ overrideAccess: true, collection: 'posts', data: { title: '' } }))
  const finishedAt = Date.now()
  if (process.env.PROBE_DATABASE === 'mongodb') {
    await payload.db.connection.dropDatabase()
  }
  // one payload instance: the ValidationError this (possibly bundled) route sees vs the one Node
  // loads from the installed payload, which engine-rs's dist imports
  const installedPayload = await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */
    pathToFileURL(createRequire(process.cwd() + '/').resolve('payload')).href
  )
  return Response.json({
    isOnePayloadInstance: installedPayload.ValidationError === ValidationError,
    finishedAt,
    startedAt,
    steps: JSON.parse(JSON.stringify(steps)),
    windows,
  })
}
`,
  }
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(appDir, file)), { recursive: true })
    fs.writeFileSync(path.join(appDir, file), content)
  }
}

async function runNextDev({ engine, index, label }) {
  const statsDir = path.join(work, `next-stats-${index}`)
  fs.rmSync(statsDir, { force: true, recursive: true })
  fs.mkdirSync(statsDir, { recursive: true })
  fs.rmSync(path.join(appDir, '.next'), { force: true, recursive: true })
  const location =
    database === 'sqlite'
      ? path.join(work, `next-${index}.db`)
      : Object.assign(new URL(mongodbURL), {
          pathname: `/packaging_next_${process.pid}_${index}`,
        }).href
  const env = { ...process.env, TZ: 'UTC' }
  for (const key of Object.keys(env)) {
    if (/^PAYLOAD_|^NODE_OPTIONS$|^__NEXT|^NEXT_/.test(key)) {
      delete env[key]
    }
  }
  Object.assign(env, {
    DISABLE_PAYLOAD_HMR: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    PAYLOAD_RS_CORE_STATS_FILE: path.join(statsDir, 'core.json'),
    PAYLOAD_RS_ENGINE_STATS_FILE: path.join(statsDir, 'engine.json'),
    PAYLOAD_RS_MONGO_ENGINE_STATS_FILE: path.join(statsDir, 'mongo-engine.json'),
    PAYLOAD_RS_OPS_STATS_DIR: statsDir,
    PROBE_DATABASE: database,
    PROBE_LOCATION: location,
    ...(isProd && database === 'sqlite' ? { PROBE_PUSH: 'true' } : {}),
  })
  if (engine === 'rs') {
    env.PAYLOAD_ENGINE = 'rs'
  }
  const nextBin = path.join(appDir, 'node_modules/next/dist/bin/next')
  if (isProd) {
    const build = spawnSync(process.execPath, [nextBin, 'build'], {
      cwd: appDir,
      encoding: 'utf8',
      env: { ...env, NODE_ENV: 'production' },
      timeout: 900_000,
    })
    fs.writeFileSync(
      path.join(work, `next-build-log-${index}.txt`),
      `${build.stdout}\n${build.stderr}`,
    )
    if (build.status !== 0) {
      throw new Error(
        `${label}: next build failed:\n${build.stdout.slice(-3000)}\n${build.stderr.slice(-3000)}`,
      )
    }
  }
  const child = spawn(
    process.execPath,
    [nextBin, isProd ? 'start' : 'dev', '--port', String(port)],
    {
      cwd: appDir,
      env: isProd ? { ...env, NODE_ENV: 'production' } : env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let log = ''
  child.stdout.on('data', (chunk) => (log += chunk))
  child.stderr.on('data', (chunk) => (log += chunk))
  try {
    const deadline = Date.now() + 180_000
    while (!/Ready in|✓ Ready/.test(log)) {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`${label}: next ${isProd ? 'start' : 'dev'} did not start:\n${log}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const response = await fetch(`http://localhost:${port}/api/probe`, {
      signal: AbortSignal.timeout(300_000),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `${label}: /api/probe answered ${response.status}:\n${text.slice(0, 2000)}\n${log.slice(-4000)}`,
      )
    }
    const output = JSON.parse(text)
    fs.writeFileSync(path.join(work, `next-out-${index}.json`), text)
    fs.writeFileSync(path.join(work, `next-log-${index}.txt`), log)
    await new Promise((resolve) => setTimeout(resolve, 600))
    console.log(`${label} (${engine}): ${output.steps.length} steps`)
    return { engine, label, log, output, statsDir }
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) =>
      child.exitCode !== null ? resolve() : child.once('exit', resolve),
    )
    for (const file of fs.readdirSync(work).filter((name) => name.startsWith(`next-${index}.db`))) {
      fs.rmSync(path.join(work, file), { force: true })
    }
  }
}

/** Engine-rs must be loaded by Node at runtime: none of its code or its addon in `.next`. */
function checkBundle() {
  const nextDir = path.join(appDir, '.next')
  const engineMarkers = ['coreOpsBinding', 'coreRuntimeBinding', 'withRustEngine = ']
  let lexicalDispatch = 0
  for (const file of listFiles(nextDir)) {
    if (file.endsWith('.node')) {
      fail(`a native addon was emitted into .next: ${file}`)
      continue
    }
    if (!/\.(js|mjs|cjs)$/.test(file)) {
      continue
    }
    const code = fs.readFileSync(file, 'utf8')
    for (const marker of engineMarkers) {
      if (code.includes(marker)) {
        fail(`engine-rs code ("${marker}") was bundled into ${path.relative(appDir, file)}`)
      }
    }
    if (code.includes('@payloadcms/engine-rs/runtime/hooks')) {
      lexicalDispatch++
    }
  }
  if (lexicalDispatch === 0) {
    fail('the bundled richtext-lexical dispatch (runtime/hooks specifier) is not in .next')
  } else {
    console.log(
      `.next: no engine-rs code or addon; ${lexicalDispatch} chunk(s) carry the runtime-only lexical dispatch`,
    )
  }
}

function verify(runs) {
  const references = runs.filter((entry) => entry.engine === 'ts')
  const candidates = runs.filter((entry) => entry.engine === 'rs')
  for (const entry of references) {
    const written = fs.readdirSync(entry.statsDir)
    if (written.length > 0) {
      fail(
        `${entry.label}: PAYLOAD_ENGINE unset but engine stats were written: ${written.join(', ')}`,
      )
    }
  }
  for (const entry of runs) {
    console.log(`${entry.label}: one payload instance: ${entry.output.isOnePayloadInstance}`)
  }
  for (const entry of candidates) {
    if (entry.output.isOnePayloadInstance !== true) {
      fail(`${entry.label}: the route's payload is not the installed payload engine-rs loads`)
    }
  }
  for (const entry of candidates) {
    const read = (name) =>
      fs.existsSync(path.join(entry.statsDir, name))
        ? JSON.parse(fs.readFileSync(path.join(entry.statsDir, name), 'utf8'))
        : undefined
    const written = fs.readdirSync(entry.statsDir)
    const dataEngine = read(database === 'sqlite' ? 'engine.json' : 'mongo-engine.json')
    const coreCalls = read('core.json')?.calls
    const checks = {
      // payload's traverseFields called by the bundled richtext-lexical, forwarded to Rust
      'lexical afterReadTraverseFields': coreCalls?.afterReadTraverseFields ?? 0,
      'ops-write': read('engine.json.ops-write.json')?.calls ?? 0,
      // mongodb: the live engine (stage-1 calls must be 0, checked below)
      'data engine calls':
        database === 'sqlite' ? sum(dataEngine?.calls) : sum(dataEngine?.liveCalls),
      'data engines (native / live)':
        database === 'sqlite'
          ? (dataEngine?.engines?.native ?? 0)
          : (dataEngine?.engines?.live ?? 0),
      'ops (read)': sum(
        read(written.find((name) => /^ops-\d+\.json$/.test(name)) ?? 'none')?.calls,
      ),
    }
    if (
      database === 'mongodb' &&
      (sum(dataEngine?.calls) > 0 || (dataEngine?.engines?.native ?? 0) > 0)
    ) {
      fail(`${entry.label}: the stage-1 MongoDB engine served calls`)
    }
    console.log(`${entry.label} engine stats: ${JSON.stringify(checks)}`)
    for (const [name, count] of Object.entries(checks)) {
      if (!(count > 0)) {
        fail(`${entry.label}: no ${name} served by the Rust engine under next dev`)
      }
    }
    const result = compareRuns({ candidate: entry, references })
    console.log(
      `${entry.label} vs references: ${result.compared} leaves, ${result.nondeterministic.length} nondeterministic, ${result.mismatches.length} mismatches`,
    )
    for (const mismatch of result.mismatches.slice(0, 20)) {
      fail(
        `${entry.label}: ${mismatch.path}: ${mismatch.problem ?? 'differs'} candidate=${mismatch.candidate} reference=${mismatch.reference ?? JSON.stringify(mismatch.references)}`,
      )
    }
  }
}

function sum(record) {
  return record && typeof record === 'object'
    ? Object.values(record).reduce((total, count) => total + (Number(count) || 0), 0)
    : 0
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((entry) => (entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []))
}
