/**
 * Per-call cost of the default validators: upstream `validations.ts` (TS) vs the Rust-backed
 * module (`packages/engine-rs/src/validate/validations.ts`). 100k calls per case after a warmup,
 * alternating TS / Rust rounds; prints the median ns per call of 5 rounds and the RS/TS ratio.
 * Time is the process CPU time (user + system), so machine load does not count.
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/x.node pnpm tsx test/__rs/core-validate/bench.mts [case...]
 *
 * PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE must be unset (the TS side is the upstream module).
 */
import { translations as languages } from '../../../packages/translations/src/exports/all.js'
import { initI18n } from '../../../packages/translations/src/utilities/init.js'

if (process.env.PAYLOAD_ENGINE || process.env.PAYLOAD_CORE_ENGINE) {
  console.error('unset PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE: the reference must be TS')
  process.exit(1)
}

const ts = await import('../../../packages/payload/src/fields/validations.js')
// BENCH_RS_MODULE: another Rust-backed drop-in (e.g. an older build's glue) to measure.
const rs = await import(
  process.env.BENCH_RS_MODULE ?? '../../../packages/engine-rs/src/validate/validations.js'
)
if ((ts.text as unknown) === rs.text) {
  console.error('both sides are the same module')
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
]

const N = 100_000
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

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const rows: string[] = []
let compared = 0
for (const c of cases) {
  if (selected.length && !selected.includes(c.name)) {
    continue
  }
  const tsResult = await c.run(ts)
  const rsResult = await c.run(rs as any)
  if (tsResult !== rsResult) {
    console.error(`${c.name}: results differ`, tsResult, rsResult)
    process.exit(1)
  }
  await measure(c, ts)
  await measure(c, rs as any)
  const tsTimes: number[] = []
  const rsTimes: number[] = []
  for (let round = 0; round < 5; round++) {
    tsTimes.push(await measure(c, ts))
    rsTimes.push(await measure(c, rs as any))
  }
  const t = median(tsTimes)
  const r = median(rsTimes)
  compared++
  rows.push(
    `| ${c.name.padEnd(16)} | ${t.toFixed(0).padStart(7)} | ${r.toFixed(0).padStart(7)} | ${(r / t).toFixed(2).padStart(6)}x |`,
  )
}
console.log('| case             | TS ns   | RS ns   | ratio   |')
console.log('|------------------|---------|---------|---------|')
console.log(rows.join('\n'))
if (!compared) {
  console.error('no case ran')
  process.exit(1)
}
