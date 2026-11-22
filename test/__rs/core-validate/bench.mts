/**
 * Per-call cost of the default validators: upstream `validations.ts` (TS) vs Rust-backed
 * validators. 100k calls per case (`BENCH_CALLS`), rounds alternating between the sides; prints
 * the fastest round's ns per call (`BENCH_ROUNDS`, default 7: the minimum is the estimate least
 * inflated by machine load) and each Rust side's ratio to TS. Time is the process CPU time
 * (user + system).
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/x.node pnpm tsx test/__rs/core-validate/bench.mts [case...]
 *   BENCH_ADDONS=/tmp/old.node,/tmp/new.node pnpm tsx test/__rs/core-validate/bench.mts
 *
 * Without `BENCH_ADDONS` the Rust side is `packages/engine-rs/src/validate/validations.ts`
 * (`BENCH_RS_MODULE`: another drop-in); with it, each addon's `validateBinding` is measured in
 * the same process. PAYLOAD_ENGINE must be `ts` and PAYLOAD_CORE_ENGINE unset (the reference is TS).
 */
import { createRequire } from 'node:module'
import path from 'node:path'

import { validateJSONSchema } from '../../../packages/payload/src/fields/validateJSONSchema.js'
import { translations as languages } from '../../../packages/translations/src/exports/all.js'
import { initI18n } from '../../../packages/translations/src/utilities/init.js'

if (process.env.PAYLOAD_ENGINE !== 'ts' || process.env.PAYLOAD_CORE_ENGINE) {
  console.error('set PAYLOAD_ENGINE=ts, unset PAYLOAD_CORE_ENGINE: the reference must be TS')
  process.exit(1)
}

const ts = await import('../../../packages/payload/src/fields/validations.js')
const sides: [string, typeof ts][] = [['TS', ts]]
if (process.env.BENCH_ADDONS) {
  const require = createRequire(new URL('../../../packages/payload/package.json', import.meta.url))
  const ObjectIdImport = require('bson-objectid')
  const ObjectId = 'default' in ObjectIdImport ? ObjectIdImport.default : ObjectIdImport
  for (const addon of process.env.BENCH_ADDONS.split(',')) {
    const binding = require(path.resolve(addon)).validateBinding({ ObjectId, validateJSONSchema })
    sides.push([path.basename(addon), binding])
  }
} else {
  const rs = await import(
    process.env.BENCH_RS_MODULE ?? '../../../packages/engine-rs/src/validate/validations.js'
  )
  sides.push(['RS', rs as any])
}
if (sides.slice(1).some(([, m]) => (m.text as unknown) === ts.text)) {
  console.error('a Rust side is the TS module')
  process.exit(1)
}

const i18n = await initI18n({
  config: {
    fallbackLanguage: 'en',
    supportedLanguages: { en: languages.en },
    translations: {},
  } as any,
  context: 'api',
  language: 'en',
})

const req = { payload: { collections: {}, config: { collections: [] }, db: {} }, t: i18n.t } as any
const opts = (extra: Record<string, unknown>) => ({ req, required: false, ...extra }) as any
// A request shaped like a running Payload's: sanitized config defaults, collections, db.
const sanitizedReq = {
  payload: {
    collections: { posts: { config: { slug: 'posts' }, customIDType: undefined } },
    config: { collections: [{ slug: 'posts' }], defaultMaxTextLength: 40000 },
    db: { defaultIDType: 'number' },
  },
  t: i18n.t,
} as any
const sanitizedOpts = (extra: Record<string, unknown>) =>
  ({ req: sanitizedReq, required: false, ...extra }) as any

type Case = { async?: boolean; name: string; run: (m: typeof ts) => unknown }

const cases: Case[] = [
  { name: 'text', run: (m) => m.text('hello', opts({ required: true })) },
  { name: 'text maxLength', run: (m) => m.text('hello', opts({ maxLength: 10, minLength: 2 })) },
  { name: 'text hasMany', run: (m) => m.text(['a', 'bb'], opts({ hasMany: true, maxRows: 5 })) },
  { name: 'text undefined', run: (m) => m.text(undefined, opts({})) },
  { name: 'number', run: (m) => m.number(42, opts({ max: 100, min: 0 })) },
  { name: 'number hasMany', run: (m) => m.number([1, 2, 3], opts({ hasMany: true, max: 10 })) },
  { name: 'checkbox', run: (m) => m.checkbox(true, opts({})) },
  { name: 'code', run: (m) => m.code('x', opts({ required: true })) },
  { name: 'password', run: (m) => m.password('secret', opts({ required: true })) },
  { name: 'textarea', run: (m) => m.textarea('hello', opts({ maxLength: 10 })) },
  { name: 'email', run: (m) => m.email('a@b.co', opts({ required: true })) },
  { name: 'date', run: (m) => m.date(new Date(0) as any, opts({ name: 'd', siblingData: {} })) },
  {
    name: 'radio',
    run: (m) => m.radio('c', opts({ options: [{ label: 'A', value: 'a' }, 'b', 'c'] })),
  },
  { name: 'point', run: (m) => m.point([1, 2], opts({})) },
  { name: 'array', run: (m) => m.array([1, 2], opts({ maxRows: 4, minRows: 1 })) },
  { name: 'text error', run: (m) => m.text('hello world', opts({ maxLength: 3 })) },
  {
    name: 'select',
    async: true,
    run: (m) => m.select('a', opts({ options: ['a', 'b', 'c'] })),
  },
  {
    name: 'select hasMany',
    async: true,
    run: (m) => m.select(['a', 'b'], opts({ hasMany: true, options: ['a', 'b', 'c'] })),
  },
  {
    name: 'relationship',
    async: true,
    run: (m) => m.relationship('abc', opts({ relationTo: 'posts' })),
  },
  { name: 'json', async: true, run: (m) => m.json('{}', opts({})) },
  { name: 'text sanitized', run: (m) => m.text('hello', sanitizedOpts({ required: true })) },
  {
    name: 'relationship poly',
    async: true,
    run: (m) =>
      m.relationship(
        { relationTo: 'posts', value: 5 } as any,
        sanitizedOpts({ relationTo: ['posts'] }),
      ),
  },
]

const N = Number(process.env.BENCH_CALLS ?? 100_000)
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 7)
const selected = process.argv.slice(2)

const measure = async (c: Case, m: typeof ts): Promise<number> => {
  const start = process.cpuUsage()
  if (c.async) {
    for (let i = 0; i < N; i++) {
      await c.run(m)
    }
  } else {
    for (let i = 0; i < N; i++) {
      c.run(m)
    }
  }
  const used = process.cpuUsage(start)
  return ((used.user + used.system) * 1000) / N
}

const rows: string[] = []
let compared = 0
for (const c of cases) {
  if (selected.length && !selected.includes(c.name)) {
    continue
  }
  const results = []
  for (const [, m] of sides) {
    results.push(await c.run(m))
  }
  if (results.some((result) => result !== results[0])) {
    console.error(`${c.name}: results differ`, results)
    process.exit(1)
  }
  const best = sides.map(() => Infinity)
  for (const [, m] of sides) {
    await measure(c, m)
  }
  for (let round = 0; round < ROUNDS; round++) {
    for (const [i, [, m]] of sides.entries()) {
      best[i] = Math.min(best[i]!, await measure(c, m))
    }
  }
  compared++
  const tsTime = best[0]!
  rows.push(
    `| ${c.name.padEnd(18)} | ${best.map((t) => t.toFixed(0).padStart(7)).join(' | ')} | ${best
      .slice(1)
      .map((t) => `${(t / tsTime).toFixed(2)}x`.padStart(7))
      .join(' | ')} |`,
  )
}
const names = sides.map(([name]) => name)
console.log(
  `| case               | ${names.map((n) => `${n} ns`.padStart(7)).join(' | ')} | ${names
    .slice(1)
    .map((n) => `/${n}`.padStart(7))
    .join(' | ')} |`,
)
console.log(rows.join('\n'))
if (!compared) {
  console.error('no case ran')
  process.exit(1)
}
