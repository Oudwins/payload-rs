/**
 * One measurement process of the performance suite, run by run.mjs inside the installed perf app
 * (so payload & co. are the packed dist builds and the engine is the packaged release addon).
 *
 *   node --expose-gc bench.mjs <spec.json>
 *
 * spec: { mode: 'scenarios' | 'startup' | 'prepare', database, location, shape, size, surfaces,
 *         out, minIterations, minTimeMs, maxIterations, maxTimeMs, warmup, throughputConcurrency }
 *
 * - `scenarios`: getPayload, seed `size` posts (timed: the bulk create), then every scenario of the
 *   selected surfaces (scenarios.mjs): warmup, then iterations until both `minIterations` and
 *   `minTimeMs` are reached (capped by `maxIterations` / `maxTimeMs`); the first warmup iteration
 *   also records the result fingerprint and the hook calls it made. The `throughput` surface
 *   runs last, once per concurrency level (`measureThroughput`). Started by run.mjs with an IPC
 *   channel, the process is driven instead: after seeding it reports its scenario list (`ready`)
 *   and measures the scenario of each `run` message (`done`), in the order run.mjs picks, until
 *   `finish`. Every scenario entry records the heap and RSS after it (`memoryAfter`).
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
import { PerformanceObserver } from 'node:perf_hooks'

import { authorCount, buildConfigInput, categoryCount, createRandom, postData } from './configs.mjs'
import { fingerprint, scenarios, throughputScenarios } from './scenarios.mjs'
import { summarize } from './stats.mjs'

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const now = () => Number(process.hrtime.bigint()) / 1e6
const result = { spec, startedAt: new Date().toISOString() }
let scenarioNumber = 0

/**
 * GC pauses while a scenario's timed loop runs (`gc` performance entries; the observer callback
 * runs between iterations, so the entries are collected when the loop ends).
 */
const gcEntries = []
new PerformanceObserver((list) => gcEntries.push(...list.getEntries())).observe({
  entryTypes: ['gc'],
})

const tImport0 = now()
const { buildConfig, getPayload } = await import('payload')
const { lexicalEditor } = await import('@payloadcms/richtext-lexical')
const db = await createAdapter(spec)
const tImport1 = now()

const hookCounter = {}
const tConfig0 = now()
const config = await buildConfig(
  buildConfigInput({
    db,
    editor: lexicalEditor(),
    hookCounter,
    shape: spec.shape,
    uploadDir: spec.uploadDir,
  }),
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
  const selected = [...scenarios, ...throughputScenarios(spec.throughputConcurrency)].filter(
    (scenario) =>
      spec.surfaces.includes(scenario.surface) &&
      (!scenario.shapes || scenario.shapes.includes(spec.shape)) &&
      (!spec.categories?.length || spec.categories.includes(scenario.category)) &&
      (!spec.scenarioPattern || new RegExp(spec.scenarioPattern, 'i').test(scenario.name)),
  )
  const runScenario = async (scenario) => {
    const entry = await (scenario.surface === 'throughput' ? measureThroughput : measure)(
      ctx,
      scenario,
    )
    const memory = process.memoryUsage()
    entry.memoryAfter = {
      external: memory.external,
      heapUsed: memory.heapUsed,
      position: result.scenarios.length,
      rss: memory.rss,
    }
    result.scenarios.push(entry)
    if (spec.verbose) {
      console.log(
        `${scenario.surface} ${scenario.name}: ${entry.error ? `ERROR ${entry.error.message}` : entry.throughput ? `${entry.throughput.requestsPerSecond.toFixed(0)} req/s, p50 ${entry.stats.medianMs.toFixed(2)} ms` : `${entry.stats.medianMs.toFixed(3)} ms (n=${entry.stats.n})`}`,
      )
    }
  }
  if (process.send) {
    // driven by run.mjs over IPC: it interleaves the scenarios of the ts and rs processes of one
    // round and picks their order; `run` measures one scenario, `finish` ends the process
    await new Promise((resolve) => {
      process.on('message', async (message) => {
        if (message.type === 'run') {
          await runScenario(selected[message.index])
          process.send({ type: 'done' })
        } else if (message.type === 'finish') {
          process.removeAllListeners('message')
          resolve()
        }
      })
      process.send({
        scenarios: selected.map(({ isMutating, name, surface }) => ({ isMutating, name, surface })),
        type: 'ready',
      })
    })
  } else {
    for (const scenario of selected) {
      await runScenario(scenario)
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
  const media = []
  for (let index = 0; index < 20; index++) {
    media.push(
      (
        await payload.create({
          collection: 'media',
          data: { alt: `media ${index}` },
          file: textFile(`seed-${index}.txt`),
          overrideAccess: true,
        })
      ).id,
    )
  }
  if (spec.shape === 'complex') {
    for (let index = 0; index < 5; index++) {
      await payload.updateGlobal({
        data: { postsPerPage: index },
        overrideAccess: true,
        slug: 'settings',
      })
    }
  }
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

  let { token, user } = await payload.login({ collection: 'users', data: credentials })
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
    ids: { authors, categories, media, posts: readable },
    textFile,
    /** Fresh document indexes: per scenario from its own base, so ts and rs create equal data. */
    nextIndex: () => counter.base + counter.next++,
    /** A new session for the REST / GraphQL scenarios (after one that ended the sessions). */
    relogin: async () => {
      ;({ token, user } = await payload.login({ collection: 'users', data: credentials }))
    },
    startScenario: (number) => {
      counter.base = number * 100_000
      counter.next = 0
    },
    payload,
    random,
    /** `body`: JSON, or a FormData (multipart, e.g. an upload; fetch sets the boundary). */
    rest: async (method, slug, { auth = true, body, query } = {}) => {
      const headers = auth ? authHeaders() : new Headers()
      const isForm = body instanceof FormData
      if (body && !isForm) {
        headers.set('Content-Type', 'application/json')
      }
      const url = `http://localhost:3000/api/${slug.join('/')}${qs.stringify(query ?? {}, { addQueryPrefix: true })}`
      const response = await handlers[method](
        new Request(url, {
          body: isForm ? body : body ? JSON.stringify(body) : undefined,
          headers,
          method,
        }),
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
    get user() {
      return user
    },
  }
}

async function measure(ctx, scenario) {
  const entry = { category: scenario.category, name: scenario.name, surface: scenario.surface }
  ctx.startScenario(++scenarioNumber)
  globalThis.gc?.()
  const durations = []
  const cpuMicros = []
  let iteration = 0
  const once = async () => {
    const state = scenario.setup ? await scenario.setup(ctx, iteration) : undefined
    const cpu0 = process.cpuUsage()
    const t0 = now()
    const value = await scenario.run(ctx, state)
    const elapsed = now() - t0
    const cpu = process.cpuUsage(cpu0)
    if (scenario.teardown) {
      await scenario.teardown(ctx, state, value)
    }
    iteration++
    return { cpu: cpu.user + cpu.system, elapsed, value }
  }
  try {
    for (const key of Object.keys(hookCounter)) {
      delete hookCounter[key]
    }
    const first = await once()
    entry.fingerprint = fingerprint(first.value, 0, { isCountVariable: scenario.isCountVariable })
    entry.hookCalls = { ...hookCounter }
    entry.result = describeResult(first.value)
    for (let index = 1; index < spec.warmup; index++) {
      await once()
    }
    globalThis.gc?.()
    await new Promise((resolve) => setImmediate(resolve))
    gcEntries.length = 0
    const heapBefore = process.memoryUsage().heapUsed
    const started = now()
    while (
      durations.length < spec.maxIterations &&
      now() - started < spec.maxTimeMs &&
      (durations.length < spec.minIterations || now() - started < spec.minTimeMs)
    ) {
      const { cpu, elapsed } = await once()
      durations.push(elapsed)
      cpuMicros.push(cpu)
    }
    entry.wallMs = now() - started
    await new Promise((resolve) => setImmediate(resolve))
    entry.gc = {
      count: gcEntries.length,
      // per kind: minor (scavenge), major (mark-sweep-compact), incremental, weak callbacks
      byKind: Object.fromEntries(
        Object.entries(
          Object.groupBy(gcEntries, (gcEntry) => String(gcEntry.detail?.kind ?? gcEntry.kind)),
        ).map(([kind, entries]) => [
          kind,
          { count: entries.length, ms: entries.reduce((sum, e) => sum + e.duration, 0) },
        ]),
      ),
      ms: gcEntries.reduce((sum, gcEntry) => sum + gcEntry.duration, 0),
    }
    entry.heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore
  } catch (error) {
    entry.error = {
      message: String(error?.message ?? error).slice(0, 1000),
      name: error?.name,
      stack: String(error?.stack ?? '').slice(0, 2000),
    }
  }
  entry.stats = summarize(durations)
  entry.cpu = summarize(cpuMicros.map((micros) => micros / 1000))
  if (spec.isSamplesKept) {
    entry.samples = durations.map((value) => Math.round(value * 1000) / 1000)
    entry.cpuSamples = cpuMicros.map((micros) => Math.round(micros) / 1000)
  }
  return entry
}

/**
 * `scenario.concurrency` callers issue `scenario.run` back to back until at least
 * `minIterations` requests per caller and `minTimeMs` (capped by `maxTimeMs`), after a warmup burst
 * of two requests per caller. The first request (alone) records the fingerprint and hook calls.
 * Reported (`throughput`): requests per second over the wall time, process CPU time per request
 * (`process.cpuUsage`: every thread, JS, engine and database threads) and JS-thread time per
 * request (the event loop's active time, `performance.eventLoopUtilization`, which includes the
 * time the JS thread waits synchronously on a native call); `stats` / `samples` are the
 * per-request latencies under load. Posts a request created are deleted afterwards (untimed).
 */
async function measureThroughput(ctx, scenario) {
  const entry = { category: scenario.category, name: scenario.name, surface: scenario.surface }
  ctx.startScenario(++scenarioNumber)
  const { concurrency } = scenario
  const created = []
  let next = 0
  const request = async () => {
    const value = await scenario.run(ctx, next++)
    if (scenario.created) {
      created.push(scenario.created(value))
    }
    return value
  }
  const latencies = []
  try {
    for (const key of Object.keys(hookCounter)) {
      delete hookCounter[key]
    }
    const first = await request()
    entry.fingerprint = fingerprint(first, 0)
    entry.hookCalls = { ...hookCounter }
    entry.result = describeResult(first)
    await Promise.all(
      Array.from({ length: concurrency }, async () => [await request(), await request()]),
    )
    globalThis.gc?.()
    const cpu0 = process.cpuUsage()
    const loop0 = performance.eventLoopUtilization()
    const started = now()
    entry.startedAt = new Date().toISOString()
    let isDone = false
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (!isDone) {
          const t0 = now()
          await request()
          latencies.push(now() - t0)
          const elapsed = now() - started
          if (
            elapsed >= spec.maxTimeMs ||
            (latencies.length >= spec.minIterations * concurrency && elapsed >= spec.minTimeMs)
          ) {
            isDone = true
          }
        }
      }),
    )
    entry.wallMs = now() - started
    const cpu = process.cpuUsage(cpu0)
    const loop = performance.eventLoopUtilization(loop0)
    entry.throughput = {
      concurrency,
      cpuMsPerRequest: (cpu.user + cpu.system) / 1000 / latencies.length,
      eventLoopUtilization: loop.utilization,
      jsThreadMsPerRequest: loop.active / latencies.length,
      requests: latencies.length,
      requestsPerSecond: latencies.length / (entry.wallMs / 1000),
    }
  } catch (error) {
    entry.error = {
      message: String(error?.message ?? error).slice(0, 1000),
      name: error?.name,
      stack: String(error?.stack ?? '').slice(0, 2000),
    }
  } finally {
    for (const id of created) {
      await ctx.payload.delete({ collection: 'posts', id, overrideAccess: true })
    }
  }
  entry.stats = summarize(latencies)
  if (spec.isSamplesKept) {
    entry.samples = latencies.map((value) => Math.round(value * 1000) / 1000)
  }
  return entry
}

/** Size of a result (JSON bytes) and the documents it carries, for per-document costs. */
function describeResult(value) {
  const body =
    value && typeof value === 'object' && 'json' in value && 'status' in value ? value.json : value
  let bytes = NaN
  try {
    bytes = Buffer.byteLength(JSON.stringify(body) ?? '')
  } catch {
    // circular or BigInt: no size
  }
  const docs = Array.isArray(body?.docs)
    ? body.docs.length
    : Array.isArray(body?.data && Object.values(body.data)[0]?.docs)
      ? Object.values(body.data)[0].docs.length
      : body && typeof body === 'object'
        ? 1
        : 0
  return { bytes, docs }
}

function isAddonLoaded() {
  try {
    return fs.readFileSync('/proc/self/maps', 'utf8').includes('payload-engine.node')
  } catch {
    return null
  }
}

/** A small text file for the upload scenarios (no image processing: sharp is not installed). */
function textFile(name) {
  const data = Buffer.from(`perf upload ${name}\n`.repeat(64))
  return { data, mimetype: 'text/plain', name, size: data.length }
}
