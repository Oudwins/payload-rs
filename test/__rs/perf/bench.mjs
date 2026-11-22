/**
 * One measurement process of the performance suite, run by run.mjs inside the installed perf app
 * (so payload & co. are the packed dist builds and the engine is the packaged release addon).
 *
 *   node --expose-gc bench.mjs <spec.json>
 *
 * spec: { mode: 'scenarios' | 'startup' | 'prepare', database, location, shape, size, surfaces,
 *         out, minIterations, minTimeMs, maxIterations, maxTimeMs, warmup }
 *
 * - `scenarios`: getPayload, seed `size` posts (timed: the bulk create), then every scenario of the
 *   selected surfaces (scenarios.mjs): warmup, then iterations until both `minIterations` and
 *   `minTimeMs` are reached (capped by `maxIterations` / `maxTimeMs`); the first warmup iteration
 *   also records the result fingerprint and the hook calls it made.
 * - `startup`: the phases of a cold start in this fresh process: importing payload and the
 *   adapters, `buildConfig` (sanitization), `getPayload` (adapter init, connect, models / schema).
 * - `prepare`: getPayload and, for SQL databases, push the schema (so `startup` runs measure a
 *   production start against an existing schema).
 *
 * The engine is whatever PAYLOAD_ENGINE selects (run.mjs sets `ts` or leaves it unset). The result
 * records whether the engine addon is mapped into this process (/proc/self/maps), so a ts run
 * that loaded Rust, or an rs run that did not, is caught.
 */
import fs from 'node:fs'
import os from 'node:os'

import { authorCount, buildConfigInput, categoryCount, createRandom, postData } from './configs.mjs'
import { fingerprint, scenarios } from './scenarios.mjs'

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const now = () => Number(process.hrtime.bigint()) / 1e6
const result = { spec, startedAt: new Date().toISOString() }
let scenarioNumber = 0

const tImport0 = now()
const { buildConfig, getPayload } = await import('payload')
const { lexicalEditor } = await import('@payloadcms/richtext-lexical')
const db = await createAdapter(spec)
const tImport1 = now()

const hookCounter = {}
const tConfig0 = now()
const config = await buildConfig(
  buildConfigInput({ db, editor: lexicalEditor(), hookCounter, shape: spec.shape }),
)
const tConfig1 = now()
const payload = await getPayload({ config })
const tInit1 = now()
result.startup = {
  buildConfigMs: tConfig1 - tConfig0,
  getPayloadMs: tInit1 - tConfig1,
  importMs: tImport1 - tImport0,
  totalMs: tInit1 - tImport0,
}

if (spec.mode === 'prepare' || spec.mode === 'scenarios') {
  if (spec.database === 'mongodb') {
    // a fresh database: wait for mongoose to create every collection (a first insert in a
    // transaction would otherwise race with it: WriteConflict "namespace already in use")
    const models = [
      ...Object.values(payload.db.collections),
      ...Object.values(payload.db.versions),
      payload.db.globals,
    ].filter(Boolean)
    await Promise.all(models.map((model) => model.init()))
  } else {
    const { pushDevSchema } = await import('@payloadcms/drizzle')
    await pushDevSchema(payload.db)
  }
}

if (spec.mode === 'scenarios') {
  const ctx = await seed()
  result.scenarios = []
  for (const scenario of scenarios) {
    if (!spec.surfaces.includes(scenario.surface)) {
      continue
    }
    if (scenario.shapes && !scenario.shapes.includes(spec.shape)) {
      continue
    }
    result.scenarios.push(await measure(ctx, scenario))
    if (spec.verbose) {
      const last = result.scenarios.at(-1)
      console.log(
        `${scenario.surface} ${scenario.name}: ${last.error ? `ERROR ${last.error.message}` : `${last.stats.medianMs.toFixed(3)} ms (n=${last.stats.n})`}`,
      )
    }
  }
}

result.addonLoaded = isAddonLoaded()
result.memory = process.memoryUsage()
result.environment = {
  cpu: os.cpus()[0]?.model,
  cpus: os.cpus().length,
  engine: process.env.PAYLOAD_ENGINE ?? '(unset: default)',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
}
fs.writeFileSync(spec.out, JSON.stringify(result, null, 2))
await payload.destroy?.()
process.exit(0)

// ------------------------------------------------------------------------------------------

async function createAdapter({ database, location }) {
  if (database === 'mongodb') {
    const { mongooseAdapter } = await import('@payloadcms/db-mongodb')
    return mongooseAdapter({ url: location })
  }
  if (database === 'sqlite') {
    const { sqliteAdapter } = await import('@payloadcms/db-sqlite')
    return sqliteAdapter({ client: { url: `file:${location}` } })
  }
  if (database === 'postgres') {
    const { postgresAdapter } = await import('@payloadcms/db-postgres')
    return postgresAdapter({ pool: { connectionString: location } })
  }
  throw new Error(`unknown database ${database}`)
}

/** Seeds deterministic data; returns the scenario context. */
async function seed() {
  const random = createRandom(42)
  const t0 = now()
  const categories = []
  for (let index = 0; index < categoryCount; index++) {
    categories.push(
      (
        await payload.create({
          overrideAccess: true,
          collection: 'categories',
          data: { title: `category ${index}` },
        })
      ).id,
    )
  }
  const authors = []
  for (let index = 0; index < authorCount(spec.size); index++) {
    authors.push(
      (
        await payload.create({
          overrideAccess: true,
          collection: 'authors',
          data: { name: `author ${index}`, bio: `bio of author ${index}` },
        })
      ).id,
    )
  }
  const credentials = { email: 'perf@payloadcms.com', password: 'perf-password' }
  await payload.create({
    overrideAccess: true,
    collection: 'users',
    data: { ...credentials, name: 'Perf' },
  })
  await payload.updateGlobal({
    overrideAccess: true,
    data: { postsPerPage: 10, siteName: 'perf' },
    slug: 'settings',
  })
  const tPosts = now()
  const datas = Array.from({ length: spec.size }, (_, index) =>
    postData({ authorIDs: authors, categoryIDs: categories, index, random, shape: spec.shape }),
  )
  const posts = new Array(spec.size)
  const concurrency = 8
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < datas.length) {
        const index = next++
        posts[index] = (
          await payload.create({ overrideAccess: true, collection: 'posts', data: datas[index] })
        ).id
      }
    }),
  )
  const tDone = now()
  result.seed = {
    postsCreateMs: tDone - tPosts,
    postsPerSecond: spec.size / ((tDone - tPosts) / 1000),
    totalMs: tDone - t0,
  }

  const { token, user } = await payload.login({ collection: 'users', data: credentials })
  const { GRAPHQL_POST, REST_DELETE, REST_GET, REST_PATCH, REST_POST } =
    await import('@payloadcms/next/routes')
  const qs = await import('qs-esm')
  const handlers = {
    DELETE: REST_DELETE(config),
    GET: REST_GET(config),
    PATCH: REST_PATCH(config),
    POST: REST_POST(config),
  }
  const graphqlHandler = GRAPHQL_POST(config)
  const authHeaders = () => new Headers({ Authorization: `JWT ${token}` })
  // posts the complex shape's read access shows (stage not archived): by-id reads through
  // REST / GraphQL (access applied) target these
  const readable = posts.filter((_, index) => datas[index].stage !== 'archived')
  const counter = { base: 0, next: 0 }
  return {
    authHeaders,
    credentials,
    graphql: async (query, variables) => {
      const headers = authHeaders()
      headers.set('Content-Type', 'application/json')
      const response = await graphqlHandler(
        new Request('http://localhost:3000/api/graphql', {
          body: JSON.stringify({ query, variables }),
          headers,
          method: 'POST',
        }),
      )
      const json = await response.json()
      if (json.errors) {
        throw new Error(`graphql: ${JSON.stringify(json.errors).slice(0, 500)}`)
      }
      return { json, status: response.status }
    },
    idType: payload.db.defaultIDType === 'number' ? 'Int' : 'String',
    ids: { authors, categories, posts: readable },
    /** Fresh document indexes: per scenario from its own base, so ts and rs create equal data. */
    nextIndex: () => counter.base + counter.next++,
    startScenario: (number) => {
      counter.base = number * 100_000
      counter.next = 0
    },
    payload,
    random,
    rest: async (method, slug, { auth = true, body, query } = {}) => {
      const headers = auth ? authHeaders() : new Headers()
      if (body) {
        headers.set('Content-Type', 'application/json')
      }
      const url = `http://localhost:3000/api/${slug.join('/')}${qs.stringify(query ?? {}, { addQueryPrefix: true })}`
      const response = await handlers[method](
        new Request(url, { body: body ? JSON.stringify(body) : undefined, headers, method }),
        { params: Promise.resolve({ slug }) },
      )
      const json = await response.json()
      if (response.status >= 400) {
        throw new Error(
          `${method} /api/${slug.join('/')}: ${response.status} ${JSON.stringify(json).slice(0, 500)}`,
        )
      }
      return { json, status: response.status }
    },
    shape: spec.shape,
    size: spec.size,
    titles: [datas[0].title],
    user,
  }
}

async function measure(ctx, scenario) {
  const entry = { name: scenario.name, surface: scenario.surface }
  ctx.startScenario(++scenarioNumber)
  globalThis.gc?.()
  const durations = []
  let iteration = 0
  const once = async () => {
    const state = scenario.setup ? await scenario.setup(ctx, iteration) : undefined
    const t0 = now()
    const value = await scenario.run(ctx, state)
    const elapsed = now() - t0
    if (scenario.teardown) {
      await scenario.teardown(ctx, state, value)
    }
    iteration++
    return { elapsed, value }
  }
  try {
    for (const key of Object.keys(hookCounter)) {
      delete hookCounter[key]
    }
    const first = await once()
    entry.fingerprint = fingerprint(first.value)
    entry.hookCalls = { ...hookCounter }
    for (let index = 1; index < spec.warmup; index++) {
      await once()
    }
    const started = now()
    while (
      durations.length < spec.maxIterations &&
      now() - started < spec.maxTimeMs &&
      (durations.length < spec.minIterations || now() - started < spec.minTimeMs)
    ) {
      durations.push((await once()).elapsed)
    }
  } catch (error) {
    entry.error = {
      message: String(error?.message ?? error).slice(0, 1000),
      name: error?.name,
      stack: String(error?.stack ?? '').slice(0, 2000),
    }
  }
  entry.stats = summarize(durations)
  return entry
}

function summarize(durations) {
  const sorted = [...durations].sort((a, b) => a - b)
  const at = (q) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN
  return {
    maxMs: sorted.at(-1) ?? NaN,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1),
    medianMs: at(0.5),
    minMs: sorted[0] ?? NaN,
    n: sorted.length,
    p95Ms: at(0.95),
  }
}

function isAddonLoaded() {
  try {
    return fs.readFileSync('/proc/self/maps', 'utf8').includes('payload-engine.node')
  } catch {
    return null
  }
}
