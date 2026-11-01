/**
 * Micro-benchmarks for RUST_CORE_DESIGN.md (interop strategy costs) and an end-to-end afterRead
 * comparison (TS reference vs Rust core runtime) without a database.
 *
 *   PAYLOAD_CORE_RUNTIME_ADDON=/path/to/release/libdev_addon.dylib pnpm tsx test/__rs/core-runtime/bench.mts
 */
import {
  afterRead as afterReadRS,
  getCoreRuntime,
} from '../../../packages/engine-rs/src/runtime/index.js'
import { upstreamAfterRead as afterReadTS } from '../../../packages/payload/src/fields/hooks/afterRead/index.js'

const b = getCoreRuntime()
const results: Record<string, string> = {}
const ns = (total: number, n: number) => `${(total / n).toFixed(1)} ns/op`
const time = (fn: () => void) => {
  const start = process.hrtime.bigint()
  fn()
  return Number(process.hrtime.bigint() - start)
}
const timeAsync = async (fn: () => Promise<unknown>) => {
  const start = process.hrtime.bigint()
  await fn()
  return Number(process.hrtime.bigint() - start)
}

const microOnly = process.env.BENCH_E2E_ONLY !== '1'
const N = microOnly ? 1_000_000 : 1
const obj: Record<string, unknown> = { title: 'x', other: 1 }

// warm up
for (let i = 0; i < 1000; i++) {
  b.noop()
}
results['JS -> Rust sync call (noop)'] = ns(
  time(() => {
    for (let i = 0; i < N; i++) b.noop()
  }),
  N,
)
results['Rust -> JS sync call (napi_call_function)'] = ns(
  b.benchCallJs(() => undefined, N),
  N,
)
results['napi_get_property'] = ns(b.benchGetProperty(obj, 'title', N), N)
results['napi_set_property'] = ns(b.benchSetProperty(obj, 'other', N), N)
results['napi reference create+read+delete'] = ns(b.benchPersist(obj, N), N)

const A = microOnly ? 200_000 : 1
results['Rust task: JS await (Promise.then resume)'] = ns(await b.benchSequentialAwaits(1, A), A)
results['JS baseline: await in async fn'] = ns(
  await timeAsync(async () => {
    for (let i = 0; i < A; i++) await 1
  }),
  A,
)
results['Rust: spawn task (async fn call, sync completion)'] = ns(b.benchSpawnSyncTasks(A), A)
const asyncNoop = async () => undefined
results['JS baseline: async fn call (sync completion)'] = ns(
  time(() => {
    const arr = []
    for (let i = 0; i < A; i++) arr.push(asyncNoop())
  }),
  A,
)

const tsfn = (n: number, async: boolean) =>
  new Promise<number>((resolve) => {
    b.benchTsfn((done, elapsed) => {
      if (done) {
        if (async) {
          void Promise.resolve().then(done)
        } else {
          done()
        }
      } else {
        resolve(elapsed!)
      }
    }, n)
  })
const T = microOnly ? 20_000 : 1
await tsfn(microOnly ? 1000 : 1, false)
results['ThreadsafeFunction round trip (worker -> JS sync -> worker)'] = ns(await tsfn(T, false), T)
results['ThreadsafeFunction round trip (worker -> JS await -> worker)'] = ns(await tsfn(T, true), T)

// Strategy A: sync the whole doc across the boundary around each callback.
const makeDoc = (fields: number) => {
  const doc: Record<string, unknown> = { id: 1 }
  for (let i = 0; i < fields; i++) {
    doc[`f${i}`] = i % 3 === 0 ? `value ${i}` : i % 3 === 1 ? i : { nested: [i, { a: `x${i}` }] }
  }
  return doc
}
for (const size of [20, 200]) {
  const doc = makeDoc(size)
  const S = microOnly ? 20_000 : 1
  const total = time(() => {
    for (let i = 0; i < S; i++) {
      JSON.parse(b.benchJsonRoundTrip(JSON.stringify(doc)))
    }
  })
  results[
    `Strategy A sync-back per callback (doc ${size} fields, ${JSON.stringify(doc).length} B)`
  ] = ns(total, S)
}

// Strategy C: Rust-owned doc exposed to JS through a Proxy.
b.benchProxyLoad(JSON.stringify(makeDoc(20)))
const proxy = new Proxy({}, { get: (_t, key) => b.benchProxyGet(String(key)) }) as Record<
  string,
  unknown
>
const plain = makeDoc(20)
let sink: unknown
results['Strategy C proxy property read'] = ns(
  time(() => {
    for (let i = 0; i < N; i++) sink = proxy.f3
  }),
  N,
)
results['JS baseline: plain property read'] = ns(
  time(() => {
    for (let i = 0; i < N; i++) sink = plain[`f${i & 7}`]
  }),
  N,
)
void sink

// End-to-end afterRead (no DB). TS and Rust batches alternate within one process so both see
// the same machine load. Each round is measured as main-thread CPU time
// (`process.threadCpuUsage`, all of afterRead runs on the JS thread), which is far less
// sensitive to other processes than wall time; the table reports the median and best round per
// engine and the ratio of the medians (wall-time medians for reference).
type Case = { fields: any[]; makeDoc: () => Record<string, unknown>; name: string; select?: any }
const makeFields = (withHooks: boolean): any[] => {
  const hook = withHooks ? { afterRead: [({ value }: any) => value] } : undefined
  const leaf = (name: string) => ({ name, type: 'text', ...(hook ? { hooks: hook } : {}) })
  return [
    { name: 'id', type: 'text' },
    ...Array.from({ length: 20 }, (_, i) => leaf(`t${i}`)),
    { name: 'group', type: 'group', fields: Array.from({ length: 10 }, (_, i) => leaf(`g${i}`)) },
    { name: 'rows', type: 'array', fields: [leaf('a'), leaf('b'), leaf('c')] },
    {
      type: 'tabs',
      tabs: [
        { name: 'tab', fields: [leaf('x'), leaf('y')] },
        { label: 'u', fields: [leaf('z')] },
      ],
    },
  ]
}
const makeRawDoc = () => {
  const doc: Record<string, unknown> = { id: 1 }
  for (let i = 0; i < 20; i++) doc[`t${i}`] = `text ${i}`
  doc.group = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`g${i}`, `g ${i}`]))
  doc.rows = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, a: 'a', b: 'b', c: 'c' }))
  doc.tab = { x: 'x', y: 'y' }
  doc.z = 'z'
  return doc
}
// A wider "typical" doc: mixed leaf types, defaults present in the data, hidden and access-
// controlled fields (overrideAccess), a collapsible, nested arrays and blocks. Array rows and
// blocks carry the `id` field sanitization adds (with its `defaultValue` function).
const rowID = { name: 'id', type: 'text', defaultValue: () => 'generated' }
const typicalFields: any[] = [
  { name: 'id', type: 'number' },
  { name: 'title', type: 'text' },
  { name: 'slug', type: 'text', index: true },
  { name: 'status', type: 'select', defaultValue: 'draft', options: ['draft', 'published'] },
  { name: 'featured', type: 'checkbox', defaultValue: false },
  { name: 'secret', type: 'text', hidden: true },
  { name: 'internal', type: 'text', access: { read: () => false } },
  {
    type: 'collapsible',
    label: 'meta',
    fields: [
      { name: 'metaTitle', type: 'text' },
      { name: 'metaDescription', type: 'textarea' },
    ],
  },
  {
    name: 'sections',
    type: 'array',
    fields: [
      { name: 'heading', type: 'text' },
      { name: 'body', type: 'textarea' },
      {
        name: 'items',
        type: 'array',
        fields: [{ name: 'label', type: 'text' }, { name: 'n', type: 'number' }, rowID],
      },
      rowID,
    ],
  },
  {
    name: 'layout',
    type: 'blocks',
    blocks: [
      {
        slug: 'hero',
        fields: [{ name: 'headline', type: 'text' }, { name: 'sub', type: 'text' }, rowID],
      },
      {
        slug: 'cta',
        fields: [{ name: 'label', type: 'text' }, { name: 'url', type: 'text' }, rowID],
      },
    ],
  },
  { name: 'updatedAt', type: 'date' },
  { name: 'createdAt', type: 'date' },
]
const makeTypicalDoc = () => ({
  id: 7,
  title: 'Title',
  slug: 'title',
  status: 'published',
  featured: true,
  secret: 'x',
  internal: 'y',
  metaTitle: 'm',
  metaDescription: 'd',
  sections: Array.from({ length: 4 }, (_, i) => ({
    id: `s${i}`,
    heading: `h${i}`,
    body: 'b',
    items: Array.from({ length: 3 }, (_, j) => ({ id: `i${i}${j}`, label: 'l', n: j })),
  })),
  layout: [
    { id: 'b1', blockType: 'hero', headline: 'H', sub: 'S' },
    { id: 'b2', blockType: 'cta', label: 'L', url: '/u' },
    { id: 'b3', blockType: 'hero', headline: 'H2', sub: 'S2' },
  ],
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
})
const cases: Case[] = [
  { name: '67 field visits, no hooks', fields: makeFields(false), makeDoc: makeRawDoc },
  {
    name: '67 field visits, sync hook on every leaf',
    fields: makeFields(true),
    makeDoc: makeRawDoc,
  },
  {
    name: '67 field visits, no hooks, select',
    fields: makeFields(false),
    makeDoc: makeRawDoc,
    select: { t1: true, group: { g1: true }, rows: { a: true }, tab: true },
  },
  {
    name: 'typical doc (defaults, hidden, access, arrays, blocks)',
    fields: typicalFields,
    makeDoc: makeTypicalDoc,
  },
]
const req: any = {
  context: {},
  payload: { blocks: {}, config: { defaultDepth: 0, localization: false, maxDepth: 10 } },
  user: null,
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const rounds = Number(process.env.BENCH_ROUNDS ?? 15)
const perRound = Number(process.env.BENCH_DOCS ?? 1000)
const e2e: Record<string, Record<string, string>> = {}
for (const c of cases) {
  const collection: any = { fields: c.fields, flattenedFields: c.fields, slug: 'bench' }
  const run = (afterRead: any) => (doc: any) =>
    afterRead({
      collection,
      context: req.context,
      depth: 0,
      doc,
      draft: false,
      fallbackLocale: null,
      global: null,
      locale: 'en',
      overrideAccess: true,
      req,
      select: c.select,
      showHiddenFields: false,
    })
  const engines = { RS: run(afterReadRS), TS: run(afterReadTS) }
  const samples: Record<'RS' | 'TS', number[]> = { RS: [], TS: [] }
  const wall: Record<'RS' | 'TS', number[]> = { RS: [], TS: [] }
  for (const fn of Object.values(engines)) {
    await Promise.all(Array.from({ length: 300 }, c.makeDoc).map(fn)) // warm up
  }
  for (let r = 0; r < rounds; r++) {
    for (const name of r % 2 ? (['RS', 'TS'] as const) : (['TS', 'RS'] as const)) {
      const docs = Array.from({ length: perRound }, c.makeDoc)
      const cpuStart = process.threadCpuUsage()
      const total = await timeAsync(async () => {
        for (const doc of docs) await engines[name](doc)
      })
      const cpu = process.threadCpuUsage(cpuStart)
      samples[name].push((cpu.user + cpu.system) / perRound)
      wall[name].push(total / perRound / 1000)
    }
  }
  const ts = median(samples.TS)
  const rs = median(samples.RS)
  e2e[c.name] = {
    'TS cpu µs/doc': ts.toFixed(1),
    'RS cpu µs/doc': rs.toFixed(1),
    'RS/TS': (rs / ts).toFixed(2),
    'TS best': Math.min(...samples.TS).toFixed(1),
    'RS best': Math.min(...samples.RS).toFixed(1),
    'wall TS/RS': `${median(wall.TS).toFixed(1)}/${median(wall.RS).toFixed(1)}`,
  }
}

if (process.env.BENCH_E2E_ONLY !== '1') {
  console.table(results)
}
console.table(e2e)
