/**
 * Generates `fixtures/validations.json` for `crates/payload-core-validate/tests/differential.rs`.
 *
 * Runs the real default validators (`packages/payload/src/fields/validations.ts`) with the real
 * `req.t` (`initI18n`, English) over a corpus of values x field configs x request contexts and
 * records every result (`true`, the message, or the thrown error), plus every host interaction
 * (`filterOptions` calls, `payloadDataLoader.find`, `logger.error`, rich text `validate`).
 * Also records direct outputs of the JS builtins the port re-implements (`Date.parse`, `Number`,
 * `parseFloat`, `String(number)`, the email regex) and of the translations `t` function over
 * every language and crafted translation objects.
 *
 * Run: TZ=UTC pnpm tsx test/__rs/core-validate/generate.ts (or any other `TZ`: the fixture
 * records it, and the Rust test checks it runs in the same process time zone).
 *
 * Shim mode (`RS_CORE_VALIDATE_SHIM=1`, needs `PAYLOAD_ENGINE_ADDON` or the shared addon):
 * instead of writing the fixture, runs every case, plus the `exoticValues` (class instances,
 * `ObjectId`s, getters, proxies, symbols, bigints, ...), through both the upstream module and the
 * Rust-backed drop-in (`packages/engine-rs/src/validate/validations.ts`) and compares the
 * return value or exception (class and message), whether the result was a promise / a
 * synchronous throw, every host call (arguments, identity of `req` / `data` / `siblingData` /
 * option filters, and the microtask tick it happened on, counted by a concurrent ticker) and the
 * tick it settled on. Exits 1 on a mismatch or when nothing was compared. Mutations made while a
 * validator awaits are covered by `live.ts`.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateJSONSchema } from '../../../packages/payload/src/fields/validateJSONSchema.js'
import { username, validations } from '../../../packages/payload/src/fields/validations.js'
import { translations as languages } from '../../../packages/translations/src/exports/all.js'
import { initI18n, t as translate } from '../../../packages/translations/src/utilities/init.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

if (!process.env.TZ) {
  throw new Error('run with an explicit TZ (e.g. TZ=UTC)')
}

// ---------------------------------------------------------------------------------------------
// Deterministic PRNG
let seed = 0x9e3779b9
const rand = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 0x100000000
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))

// ---------------------------------------------------------------------------------------------
// Encoding (the `serializeForEngine` format, without shared references)
const reservedKeys = new Set(['$date', '$fn', '$num', '$obj', '$ref', '$undefined'])
const fnIDs = new Map<Function, number>()

const enc = (v: unknown): unknown => {
  switch (typeof v) {
    case 'bigint':
      return { $bigint: String(v) }
    case 'function': {
      const id = fnIDs.get(v)
      if (id === undefined) {
        throw new Error(`unregistered function ${v.name}`)
      }
      return { $fn: id }
    }
    case 'number':
      return Number.isFinite(v) ? v : { $num: String(v) }
    case 'object': {
      if (v === null) {
        return null
      }
      if (v instanceof Date) {
        return { $date: Number.isNaN(v.getTime()) ? null : v.toISOString() }
      }
      if (Array.isArray(v)) {
        return v.map(enc)
      }
      const out: Record<string, unknown> = {}
      const keys = Object.keys(v)
      for (const key of keys) {
        out[key] = enc((v as Record<string, unknown>)[key])
      }
      return keys.length === 1 && reservedKeys.has(keys[0]!) ? { $obj: out } : out
    }
    case 'symbol':
      return { $symbol: String(v) }
    case 'undefined':
      return { $undefined: true }
    default:
      return v
  }
}
const encStr = (v: unknown) => JSON.stringify(enc(v))

/** Deep clone that keeps functions (so validators can't leak mutations between cases). */
const clone = <T>(v: T): T => {
  if (v instanceof Date) {
    return new Date(v.getTime()) as T
  }
  if (Array.isArray(v)) {
    return v.map(clone) as T
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v)) {
      out[key] = clone((v as Record<string, unknown>)[key])
    }
    return out as T
  }
  return v
}

const strings: string[] = []
const stringIndex = new Map<string, number>()
const intern = (s: string) => {
  let i = stringIndex.get(s)
  if (i === undefined) {
    i = strings.push(s) - 1
    stringIndex.set(s, i)
  }
  return i
}
intern('') // index 0 is reserved for `true`

const errorKey = (err: unknown) => {
  const e = err as Error
  return `!${e?.name}${e?.name === 'Error' ? `:${e.message}` : ''}`
}

// ---------------------------------------------------------------------------------------------
// Host mocks (mirrored by `MockHost` in the Rust test)
let calls: unknown[] = []

const SHIM = process.env.RS_CORE_VALIDATE_SHIM === '1'
/** Microtask ticks since the case started (shim mode). */
let tick = 0
/** The objects a host call must receive as is (shim mode). */
let identity: Record<string, unknown> = {}
let lastFilterResult: unknown
const record = (entry: unknown[]) => calls.push(SHIM ? [...entry, tick] : entry)
const sameAs = (key: string, value: unknown) => (value === identity[key] ? `=${key}` : 'other')

const USER = { id: 'u1', email: 'dev@payloadcms.com' }

const recordFilterOptions = (id: number, args: Record<string, unknown>) => {
  const { req: _req, ...rest } = args
  record(['filterOptions', id, enc(rest)])
  if (SHIM) {
    record([
      'filterOptionsIdentity',
      sameAs('req', args.req),
      sameAs('data', args.data),
      sameAs('siblingData', args.siblingData),
      sameAs('blockData', args.blockData),
      sameAs('options', args.options),
      sameAs('user', args.user),
    ])
  }
}

const registered: Function[] = []
const register = <T extends Function>(fn: T): T => {
  fnIDs.set(fn, registered.push(fn) - 1)
  return fn
}

const wrap = (impl: (args: any) => unknown) => {
  const fn = register(function filterOptions(args: Record<string, unknown>) {
    recordFilterOptions(fnIDs.get(fn)!, args)
    return (lastFilterResult = impl(args))
  })
  return fn
}

// relationship / upload filterOptions
const F_TRUE = wrap(() => true)
const F_FALSE = wrap(() => false)
const F_WHERE = wrap(() => ({ id: { not_in: [2, 'm1'] } }))
let lastThrown: unknown
const F_THROW = wrap(() => {
  throw (lastThrown = new Error('boom'))
})
const F_BY_REL = wrap(({ relationTo }) => (relationTo === 'media' ? false : { id: { equals: 1 } }))
const F_NULL = wrap(() => null)
const F_STR = wrap(() => 'weird')
const F_ASYNC = wrap(async () => (lastFilterResult = { id: { not_in: [3] } }))
// blocks filterOptions
const B_TRUE = wrap(() => true)
const B_LIST = wrap(() => ['a', 'b'])
const B_EMPTY = wrap(() => [])
const B_THROW = wrap(() => {
  throw (lastThrown = new Error('blocks boom'))
})
const B_OBJ = wrap(() => ({}))
// select filterOptions
const S_SUBSET = wrap(({ options }) =>
  options.filter((o: any) => (typeof o === 'string' ? o : o?.value) !== 'b'),
)
const S_STRINGS = wrap(() => ['a', 'c'])
const S_THROW = wrap(() => {
  throw (lastThrown = new Error('select boom'))
})
const S_BAD = wrap(() => 'nope')
const S_DATA = wrap(({ siblingData }) => siblingData?.allow ?? ['a'])
// rich text editor
const R_VALIDATE = register(function validate(value: unknown) {
  record(['richText', enc(value)])
  return value && typeof value === 'object' && 'root' in value
    ? true
    : `rich text invalid ${typeof value}`
})

const DB: Record<string, unknown[]> = {
  media: ['507f1f77bcf86cd799439011', 'm1', 'm2'],
  nums: [1, 2, 3],
  posts: [1, 2, 3, 'abc', 5],
}

const find = (args: Record<string, any>) => {
  if (SHIM) {
    const extra = args.where?.and?.[1]
    record([
      'findIdentity',
      sameAs('req', args.req),
      extra === undefined
        ? 'none'
        : extra === lastFilterResult || extra === identity.filterOptions
          ? 'same'
          : 'other',
    ])
  }
  record([
    'find',
    enc({ collection: args.collection, overrideAccess: args.overrideAccess, where: args.where }),
  ])
  if (
    args.depth !== 0 ||
    args.disableErrors !== true ||
    args.limit !== 0 ||
    args.pagination !== false ||
    !args.req
  ) {
    throw new Error('unexpected find args')
  }
  if (args.collection === 'baddocs') {
    return Promise.resolve({ docs: 'x' })
  }
  if (args.collection === 'nulldocs') {
    return Promise.resolve({ docs: [null] })
  }
  const docs = DB[args.collection]
  if (!docs) {
    throw new Error(`unknown collection ${args.collection}`)
  }
  const [inClause, extra, ...rest] = args.where.and
  if (rest.length) {
    throw new Error('unsupported where')
  }
  let ids = docs.filter((id) => inClause.id.in.includes(id))
  if (extra !== undefined) {
    if (extra?.id?.not_in) {
      ids = ids.filter((id) => !extra.id.not_in.includes(id))
    } else if (extra?.id && 'equals' in extra.id) {
      ids = ids.filter((id) => id === extra.id.equals)
    } else {
      throw new Error('unsupported where')
    }
  }
  return Promise.resolve({ docs: ids.map((id) => ({ id })) })
}

const logger = {
  error: ({ err, msg }: { err: Error; msg: string }) => {
    record(SHIM ? ['log', msg, err?.name, err === lastThrown] : ['log', msg, err?.name])
  },
}

// ---------------------------------------------------------------------------------------------
// Request contexts
const collectionConfigs = [
  { slug: 'posts' },
  { slug: 'media', auth: {} },
  { slug: 'users', auth: { loginWithUsername: { requireEmail: false, requireUsername: false } } },
  { slug: 'users2', auth: { loginWithUsername: { requireEmail: true, requireUsername: false } } },
  { slug: 'users3', auth: { loginWithUsername: true } },
  { slug: 'nums', auth: { loginWithUsername: false } },
]
const customIDTypes: Record<string, string | undefined> = { media: 'text', nums: 'number' }
const collectionsBySlug = Object.fromEntries(
  collectionConfigs.map((config) => [
    config.slug,
    { config, customIDType: customIDTypes[config.slug] },
  ]),
)

const payloads = [
  {
    collections: collectionsBySlug,
    config: { collections: collectionConfigs },
    db: { defaultIDType: 'number' },
  },
  {
    collections: collectionsBySlug,
    config: { collections: collectionConfigs, defaultMaxTextLength: 5 },
    db: { defaultIDType: 'text' },
  },
  { collections: undefined, config: { collections: collectionConfigs }, db: {} },
  {
    collections: collectionsBySlug,
    config: { collections: collectionConfigs, defaultMaxTextLength: '5' },
    db: { defaultIDType: 'ObjectID' },
  },
]

// ---------------------------------------------------------------------------------------------
// Values
const dateTokens = [
  '2024',
  '24',
  '1',
  '01',
  '12',
  '13',
  '31',
  '32',
  '00',
  '0',
  '+',
  '-',
  '275760',
  '+275760',
  '-271821',
  '-000000',
  '+002024',
  '000000',
  'T',
  't',
  'Z',
  'z',
  ':',
  '.',
  ' ',
  '  ',
  '(',
  ')',
  '(comment)',
  '((a)b)',
  'Jan',
  'january',
  'Ju',
  'Sept',
  'FEB',
  'am',
  'PM',
  'UT',
  'UTC',
  'GMT',
  'EST',
  'pdt',
  'x',
  'Mon',
  'Tuesday',
  ',',
  '/',
  '\u00a0',
  '\u2028',
  '\u0000',
  '\n',
  '123456',
  '1234567890',
  '0005',
  '123',
  '999',
  '1000',
  '24',
  '60',
  '59',
  '10',
  '0530',
  '05',
  '+0530',
  '-08:00',
  'é',
  '😀',
  '9999',
  '99',
  '50',
  '49',
]
const randomDateString = () => {
  const n = randInt(1, 9)
  let s = ''
  for (let i = 0; i < n; i++) {
    s += pick(dateTokens)
  }
  return s
}

const numberChars = [
  '0',
  '1',
  '5',
  '9',
  '.',
  'e',
  'E',
  '+',
  '-',
  ' ',
  'x',
  'X',
  'o',
  'b',
  'a',
  'f',
  'Infinity',
  '\u00a0',
  '\n',
  '_',
  'n',
]
const randomNumberString = () => {
  const n = randInt(0, 7)
  let s = ''
  for (let i = 0; i < n; i++) {
    s += pick(numberChars)
  }
  return s
}

const emailChars = [
  'a',
  'Z',
  '0',
  '9',
  '.',
  '..',
  '-',
  '_',
  '+',
  '@',
  '"',
  "'",
  ' ',
  '!',
  '#',
  '~',
  'é',
  'K',
  'com',
  'co',
  'x',
  '\n',
  '`',
  '{',
  '[',
  ']',
  '(',
  '\\',
  '/',
]
const randomEmail = () => {
  const local = Array.from({ length: randInt(0, 4) }, () => pick(emailChars)).join('')
  const domain = Array.from({ length: randInt(0, 5) }, () => pick(emailChars)).join('')
  return rand() < 0.8 ? `${local}@${domain}` : local + domain
}

const randomDouble = () => {
  const kind = randInt(0, 4)
  if (kind === 0) {
    const buf = new DataView(new ArrayBuffer(8))
    buf.setUint32(0, Math.floor(rand() * 0x100000000))
    buf.setUint32(4, Math.floor(rand() * 0x100000000))
    return buf.getFloat64(0)
  }
  if (kind === 1) {
    return randInt(-1000, 1000) / pick([1, 10, 100, 3, 7])
  }
  if (kind === 2) {
    return Number(`${randInt(1, 9999)}e${randInt(-30, 30)}`)
  }
  if (kind === 3) {
    return randInt(-(2 ** 31), 2 ** 31) * 2 ** randInt(-40, 40)
  }
  return rand() * 10 ** randInt(-10, 25)
}

const baseValues: unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  1.5,
  2,
  3,
  4,
  5,
  6,
  10,
  11,
  100,
  -181,
  181,
  91,
  -90.5,
  1e21,
  1e-7,
  NaN,
  Infinity,
  -Infinity,
  2 ** 53,
  0.1 + 0.2,
  '',
  ' ',
  'a',
  'b',
  'c',
  'ab',
  'abc',
  'abcd',
  'abcdef',
  'hello world',
  '  12  ',
  '12',
  '0x1A',
  '0b101',
  '1e3',
  '-5',
  '5.',
  '.5',
  '1_000',
  'abc123',
  'Infinity',
  '-Infinity',
  'NaN',
  '\u00a0',
  '\u2028 7',
  '😀',
  '😀😀a',
  'héllo',
  'true',
  'null',
  '0',
  '1',
  '2',
  '3',
  '10',
  '181',
  '-91',
  '99.999',
  'user@example.com',
  'User.Name+alias@Example.co.uk',
  'user..name@example.com',
  'user@-example.com',
  'user@example-.com',
  'user@ex--ample.com',
  '"user"@example.com',
  'user @example.com',
  'a@b.c',
  'a@b.cd',
  'user@sub.domain.example.com',
  'user@example.com\n',
  'user@123.com',
  'user.@example.com',
  '.user@example.com',
  'u@e.c0m',
  'ü@example.com',
  'a@b@c.com',
  '2024-01-01',
  '2024-01-01T10:00:00Z',
  '2024-01-01T10:00:00',
  '2024-13-01',
  'Jan 1 2024',
  '1 January 2024 10:00 PM GMT+0200',
  '2024-01-01T24:00:00',
  '+275760-09-13T00:00:00Z',
  '+275760-09-13T00:00:00.001Z',
  '-271821-04-20T00:00:00Z',
  '-271821-04-19T23:59:59Z',
  'Tue Mar 01 2022 10:00:00 GMT+0000 (Coordinated Universal Time)',
  '12345',
  '2024/02/30',
  'Feb 30 2024',
  'not a date',
  '10:00',
  '2024-01-01T10:00:00+05:30',
  '2024-01-01 10:00:00.123456',
  '507f1f77bcf86cd799439011',
  '507F1F77BCF86CD799439011',
  '507f1f77bcf86cd79943901g',
  '123456789012',
  'm1',
  'posts',
  'media',
  'blockType',
  [],
  [1],
  [1, 2],
  [1, 2, 3],
  [1, 2, 3, 4],
  [1, 2, 3, 4, 5, 6],
  ['a'],
  ['a', 'b'],
  ['a', 'a'],
  ['a', 'b', 'a', 'c', 'b'],
  ['b', 'a', 'b'],
  [null],
  [undefined],
  ['x', 1],
  [[1]],
  [1, '2'],
  ['', ''],
  [181, 91],
  [-180, 90],
  [180, -90],
  ['10', '20'],
  ['abc', '1'],
  ['1', 'abc'],
  [0, 0],
  ['', '5'],
  [1, 2, 3, 'abc'],
  [NaN, NaN],
  [1, 1, 2, 2, 2],
  ['abc', 'abcdefgh'],
  [true],
  [{}],
  [[]],
  ['😀', 'ab'],
  [3, '3'],
  [10, 5, -2],
  ['5', 7, '11'],
  [1, null, 2],
  ['a', 'c'],
  [{ value: 'a' }],
  {},
  { a: 1 },
  { length: 5 },
  { length: '7' },
  { length: {} },
  { length: 0 },
  { length: -1 },
  { value: 1 },
  { value: 'abc' },
  { toString: 1 },
  { valueOf: 2 },
  { 0: 10, 1: 20 },
  { 0: 'a' },
  { root: {} },
  { root: null },
  { relationTo: 'posts', value: 1 },
  { relationTo: 'posts', value: 4 },
  { relationTo: 'media', value: '507f1f77bcf86cd799439011' },
  { relationTo: 'media', value: 'm2' },
  { relationTo: 'posts', value: null },
  { relationTo: 'other', value: 2 },
  { relationTo: 'constructor', value: 1 },
  { relationTo: 'nums', value: 'x' },
  { relationTo: '', value: 1 },
  { relationTo: 'posts' },
  { blockType: 'a' },
  { $undefined: true },
  { $fn: 1 },
  [
    { relationTo: 'posts', value: 1 },
    { relationTo: 'media', value: 'm1' },
  ],
  [
    { relationTo: 'posts', value: 2 },
    { relationTo: 'media', value: 'zzz' },
  ],
  [
    { relationTo: 'posts', value: 1 },
    { relationTo: 'posts', value: 1 },
    { relationTo: 'posts', value: 9 },
  ],
  [{ relationTo: 'baddocs', value: 1 }],
  [{ value: 1 }, 2],
  [{ blockType: 'a' }, { blockType: 'b' }],
  [{ blockType: 'c' }, { blockType: 'a' }, { blockType: 'c' }],
  [{ blockType: '' }, { blockType: 0 }],
  [{ blockType: 'b' }, null],
  [{ x: 1 }],
  ['a', { blockType: 'c' }],
  [{ blockType: 7 }, { blockType: NaN }],
  [1, 2, 3, 4],
  ['507f1f77bcf86cd799439011', 'm1'],
  ['abc', 5, 1],
  [2, 'm1', 3],
  [{ toString: 1 }],
  [{ a: 1 }, { a: 1 }],
  ['😀'],
]

const values: unknown[] = [
  ...baseValues,
  ...Array.from({ length: 60 }, randomDateString),
  ...Array.from({ length: 20 }, randomNumberString),
  ...Array.from({ length: 10 }, randomEmail),
  ...Array.from({ length: 10 }, randomDouble),
  // `Date`s (Local API data): valid, invalid, and the negative years whose `toString()` text
  // `Date.parse` can't read back.
  new Date(0),
  new Date(NaN),
  new Date(1_700_000_000_000),
  new Date(8.64e15),
  new Date(-8.64e15),
  new Date(-62_198_755_200_000),
  new Date(-62_198_755_200_001),
  new Date('2024-03-10T07:30:00Z'),
  [new Date(0), new Date(NaN)],
]

/**
 * Shim mode only: values `clone` would turn into plain data (class instances, `ObjectId`s,
 * getters, proxies, own `toString` / `valueOf` / `toJSON` methods, symbols, bigints), made fresh
 * for every run. The Rust validators must read them through JS exactly like the TS.
 */
const ObjectIdImport = createRequire(
  path.resolve(dirname, '../../../packages/payload/package.json'),
)('bson-objectid')
const ObjectId = 'default' in ObjectIdImport ? ObjectIdImport.default : ObjectIdImport
const OID = '507f1f77bcf86cd799439011'
class Labelled {
  label = 'x'
  toString() {
    return '7'
  }
}
const exoticValues: (() => unknown)[] = [
  () => new ObjectId(OID),
  () => new ObjectId('m1m1m1m1m1m1'),
  () => [new ObjectId(OID), 'm1'],
  () => [new ObjectId(OID), new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa')],
  () => ({ relationTo: 'media', value: new ObjectId(OID) }),
  () => ({ id: OID, toHexString: () => OID }),
  () => ({ id: Buffer.from('m1m1m1m1m1m1'), toHexString: () => 'not-called' }),
  () => Buffer.from('m1m1m1m1m1m1'),
  () => new Labelled(),
  () => [new Labelled(), 'a'],
  () => ({ toString: () => '12', valueOf: () => 5 }),
  () => ({ toJSON: () => 'json!', value: 'a' }),
  () => [{ toJSON: () => ({ x: 1 }) }],
  () => ({
    get length() {
      record(['getter', 'length'])
      return 3
    },
  }),
  () => ({
    relationTo: 'posts',
    get value() {
      record(['getter', 'value'])
      return 1
    },
  }),
  () => new Proxy(['a', 'b'], {}),
  () => new Proxy({ relationTo: 'posts', value: 2 }, {}),
  () => [1, , 3],
  () => Object.assign(['a', 'a'], { some: () => false }),
  () => new String('abc'),
  () => new Number(5),
  () => Object.create(null),
  () => Symbol('s'),
  () => [Symbol('s')],
  () => 10n,
  () => [10n],
  () => Object.freeze(['a', 'b']),
  () => new Date(0),
  () => ({ toString: () => '2024-01-01' }),
  () => ({ toString: 5 }),
]

// ---------------------------------------------------------------------------------------------
// Field configs
type Config = { options: Record<string, unknown>; payload: number }

const product = (dims: Record<string, unknown[]>): Record<string, unknown>[] => {
  let out: Record<string, unknown>[] = [{}]
  for (const [key, choices] of Object.entries(dims)) {
    const next: Record<string, unknown>[] = []
    for (const base of out) {
      for (const choice of choices) {
        next.push(choice === ABSENT ? base : { ...base, [key]: choice })
      }
    }
    out = next
  }
  return out
}

const ABSENT = Symbol('absent')

const sample = <T>(items: T[], max: number): T[] => {
  if (items.length <= max) {
    return items
  }
  const keep = new Set<number>()
  while (keep.size < max) {
    keep.add(Math.floor(rand() * items.length))
  }
  return [...keep].sort((a, b) => a - b).map((i) => items[i]!)
}

const base = (type: string, extra: Record<string, unknown> = {}) => ({
  name: 'field',
  type,
  id: 'doc1',
  blockData: undefined,
  collectionSlug: undefined,
  data: { title: 'x' },
  event: 'submit',
  operation: 'create',
  path: ['field'],
  preferences: { fields: {} },
  previousValue: undefined,
  siblingData: {},
  ...extra,
})

const configs = (
  type: string,
  dims: Record<string, unknown[]>,
  payloadChoices: number[],
  max = 400,
): Config[] =>
  sample(
    product(dims).flatMap((extra) =>
      payloadChoices.map((payload) => ({ options: base(type, extra), payload })),
    ),
    max,
  )

const REQUIRED = [ABSENT, false, true]
const ROWS = [ABSENT, 1, 2, '2', 'x', 0]
const selectOptions = [
  ['a', 'b', 'c'],
  [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, 'c'],
  [null, 'a'],
  'abc',
  undefined,
  [{ value: 1 }, { value: true }, 3],
]
const relationFilterOptions = [
  ABSENT,
  F_TRUE,
  F_FALSE,
  F_WHERE,
  F_THROW,
  F_BY_REL,
  F_NULL,
  F_STR,
  F_ASYNC,
  { id: { equals: 'abc' } },
  true,
  undefined,
]

const validatorConfigs: Record<string, Config[]> = {
  slug: configs('slug', {}, [0]),
  text: configs(
    'text',
    {
      required: REQUIRED,
      hasMany: [ABSENT, true, 'true'],
      minLength: [ABSENT, 2, '2'],
      maxLength: [ABSENT, 4, '4', 0],
      minRows: [ABSENT, 2, '1'],
      maxRows: [ABSENT, 3],
    },
    [0, 1],
  ),
  password: configs(
    'text',
    {
      required: REQUIRED,
      minLength: [ABSENT, 0, 5, '5', null, undefined],
      maxLength: [ABSENT, 4, '4'],
    },
    [0, 1],
  ),
  confirmPassword: configs(
    'text',
    {
      required: REQUIRED,
      siblingData: [{ password: 'abc' }, { password: 1 }, {}, undefined, null],
    },
    [0],
  ),
  email: configs(
    'email',
    {
      required: REQUIRED,
      collectionSlug: [undefined, 'posts', 'media', 'users', 'users2', 'users3', 'nums', 'missing'],
      siblingData: [{}, { username: 'u' }, null],
    },
    [0, 2],
  ),
  textarea: configs(
    'textarea',
    { required: REQUIRED, minLength: [ABSENT, 0, 5, '5', null], maxLength: [ABSENT, 4, '4'] },
    [0, 1],
  ),
  code: configs('code', { required: REQUIRED }, [0]),
  json: configs(
    'json',
    {
      required: REQUIRED,
      jsonError: [ABSENT, undefined, {}],
      jsonSchema: [
        ABSENT,
        {
          uri: 'a://b/s1.json',
          fileMatch: ['a://b/s1.json'],
          schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
        },
        {
          uri: 'a://b/s2.json',
          fileMatch: ['a://b/s2.json'],
          schema: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        },
      ],
    },
    [0],
  ),
  checkbox: configs('checkbox', { required: REQUIRED }, [0]),
  date: configs(
    'date',
    {
      required: REQUIRED,
      timezone: [ABSENT, true, {}],
      name: ['d', undefined],
      siblingData: [{ d_tz: 'UTC' }, { d_tz: '' }, {}, null, { undefined_tz: 'x' }],
    },
    [0],
  ),
  richText: configs(
    'richText',
    { required: REQUIRED, editor: [ABSENT, R_VALIDATE, { validate: R_VALIDATE }, null] },
    [0],
  ),
  number: configs(
    'number',
    {
      required: REQUIRED,
      hasMany: [ABSENT, true],
      min: [ABSENT, 0, 5, '5'],
      max: [ABSENT, 10, '10', -1],
      minRows: [ABSENT, 2],
      maxRows: [ABSENT, 2],
    },
    [0],
  ),
  array: configs(
    'array',
    { required: REQUIRED, minRows: ROWS, maxRows: [ABSENT, 3, '3', 0, 1] },
    [0],
  ),
  blocks: configs(
    'blocks',
    {
      required: REQUIRED,
      minRows: [ABSENT, 1, 3],
      maxRows: [ABSENT, 2],
      filterOptions: [ABSENT, B_TRUE, B_LIST, B_EMPTY, B_THROW, B_OBJ, ['a', 'c'], 'a', null],
    },
    [0],
  ),
  upload: configs(
    'upload',
    {
      required: [ABSENT, true],
      relationTo: [
        'posts',
        'media',
        'nums',
        ['posts', 'media'],
        ['posts', 'baddocs', 'nulldocs'],
        'missing',
        'constructor',
      ],
      filterOptions: relationFilterOptions,
      event: ['submit', 'onChange'],
      minRows: [ABSENT, 2],
      maxRows: [ABSENT, 3],
      overrideAccess: [ABSENT, true],
    },
    [0, 1, 3],
    700,
  ),
  relationship: configs(
    'relationship',
    {
      required: [ABSENT, true],
      relationTo: [
        'posts',
        'media',
        'nums',
        ['posts', 'media'],
        ['posts', 'baddocs', 'nulldocs'],
        'missing',
        'constructor',
      ],
      filterOptions: relationFilterOptions,
      event: ['submit', 'onChange'],
      minRows: [ABSENT, 2, '2'],
      maxRows: [ABSENT, 3],
      overrideAccess: [ABSENT, false],
    },
    [0, 1, 2, 3],
    700,
  ),
  select: configs(
    'select',
    {
      required: REQUIRED,
      hasMany: [ABSENT, true],
      options: selectOptions,
      filterOptions: [ABSENT, S_SUBSET, S_STRINGS, S_THROW, S_BAD, S_DATA],
      siblingData: [{}, { allow: ['b', 'a'] }],
    },
    [0],
  ),
  radio: configs('radio', { required: REQUIRED, options: selectOptions }, [0]),
  point: configs('point', { required: REQUIRED }, [0]),
  username: configs(
    'text',
    {
      required: REQUIRED,
      collectionSlug: [undefined, 'posts', 'users', 'users2', 'users3', 'missing'],
      siblingData: [{}, { email: 'e@x.com' }, undefined],
    },
    [0, 1, 2],
  ),
}

// ---------------------------------------------------------------------------------------------
const i18n = await initI18n({
  config: {
    fallbackLanguage: 'en',
    supportedLanguages: { en: languages.en },
    translations: {},
  } as any,
  context: 'api',
  language: 'en',
})

const validatorFns: Record<string, Function> = { ...validations, username }

const jsonSchemaResults: Record<string, unknown> = {}

const validatorFixtures = []
let totalCases = 0

if (SHIM) {
  await runShimDifferential()
  process.exit(process.exitCode ?? 0)
}

/** Shim mode: upstream vs Rust-backed module on every case (see the header). */
async function runShimDifferential() {
  // The reference must be the TS module: with the dispatch flags set, payload's validations.ts
  // would export the Rust validators too and the comparison would be Rust against Rust.
  if (process.env.PAYLOAD_ENGINE !== 'ts' || process.env.PAYLOAD_CORE_ENGINE) {
    console.error(
      'generate.ts: set PAYLOAD_ENGINE=ts, unset PAYLOAD_CORE_ENGINE (the reference must be TS)',
    )
    process.exit(1)
  }
  const rs = await import('../../../packages/engine-rs/src/validate/validations.js')
  if (Object.keys(validatorFns).some((name) => validatorFns[name] === (rs as any)[name])) {
    console.error('generate.ts: both sides are the same validators')
    process.exit(1)
  }
  const implementations: Record<string, Function>[] = [
    validatorFns,
    { ...rs.validations, username: rs.username },
  ]
  const verbose = process.env.RS_CORE_VALIDATE_VERBOSE === '1'
  // The first `validateJSONSchema` call loads zod (`await import`), which takes extra ticks for
  // whichever implementation runs first.
  await validateJSONSchema({
    jsonSchema: { fileMatch: [], schema: { type: 'object' }, uri: 'a://warm-up.json' },
    value: {},
  })
  let cases = 0
  let mismatches = 0
  let hostCalls = 0
  // Every corpus value (cloned per run) plus the exotic ones (made per run).
  const shimValues = [...values.map((value) => () => clone(value)), ...exoticValues]
  const only = process.env.RS_CORE_VALIDATE_ONLY?.split(',')
  for (const [name, list] of Object.entries(validatorConfigs)) {
    if (only && !only.includes(name)) {
      continue
    }
    let validatorMismatches = 0
    for (const [configIndex, { options, payload }] of list.entries()) {
      for (const [valueIndex, makeValue] of shimValues.entries()) {
        const outcomes: { key: string }[] = []
        for (const fns of implementations) {
          calls = []
          lastFilterResult = undefined
          lastThrown = undefined
          const caseOptions = clone(options) as Record<string, unknown>
          const p = payloads[payload]!
          const req = {
            payload: { ...clone(p), logger },
            payloadDataLoader: { find },
            t: i18n.t,
            user: USER,
          }
          identity = {
            blockData: caseOptions.blockData,
            data: caseOptions.data,
            filterOptions: caseOptions.filterOptions,
            options: caseOptions.options,
            req,
            siblingData: caseOptions.siblingData,
            user: USER,
          }
          tick = 0
          let running = true
          const ticker = (async () => {
            while (running && tick < 500) {
              await null
              tick++
            }
          })()
          let shape: string
          let result: unknown
          let error: unknown
          try {
            const returned = fns[name]!(makeValue(), { ...caseOptions, req })
            shape = returned instanceof Promise ? 'promise' : 'sync'
            try {
              result = await returned
            } catch (err) {
              error = err
            }
          } catch (err) {
            shape = 'syncThrow'
            error = err
          }
          const settledTick = tick
          running = false
          await ticker
          const e = error as Error | undefined
          const resultKey =
            error !== undefined
              ? `!${e?.name}:${e?.message}`
              : result === true
                ? true
                : typeof result === 'string'
                  ? result
                  : `!nonstring:${typeof result}`
          outcomes.push({
            key: JSON.stringify({ calls, result: resultKey, settledTick, shape }),
          })
          hostCalls += calls.length
        }
        cases++
        const [ts, rust] = outcomes as [(typeof outcomes)[0], (typeof outcomes)[0]]
        if (ts.key !== rust.key) {
          mismatches++
          validatorMismatches++
          if (verbose && validatorMismatches <= 5) {
            console.log(
              `${name} config #${configIndex} ${encStr(options)} value #${valueIndex} ${String(makeValue)} payload ${payload}\n  ts   ${ts.key}\n  rust ${rust.key}`,
            )
          }
        }
      }
    }
    console.log(`${name}: ${list.length * values.length} cases, ${validatorMismatches} mismatches`)
  }
  console.log(
    `shim differential (TZ=${process.env.TZ}): ${cases} cases, ${hostCalls} recorded host calls, ` +
      `${mismatches} mismatches (results compared with error class and message)`,
  )
  if (cases === 0 || hostCalls === 0) {
    console.log('shim differential compared nothing')
    process.exitCode = 1
    return
  }
  process.exitCode = mismatches ? 1 : 0
}

for (const [name, list] of Object.entries(validatorConfigs)) {
  const fn = validatorFns[name]!
  const results: number[][] = []
  const callLogs: Record<string, number> = {}
  for (const [configIndex, { options, payload }] of list.entries()) {
    const row: number[] = []
    for (const [valueIndex, value] of values.entries()) {
      calls = []
      const caseOptions = clone(options)
      const p = payloads[payload]!
      const req = {
        payload: { ...clone(p), logger },
        payloadDataLoader: { find },
        t: i18n.t,
        user: USER,
      }
      if (
        name === 'json' &&
        (caseOptions as any).jsonSchema &&
        value !== undefined &&
        value !== null
      ) {
        const key = `${encStr((caseOptions as any).jsonSchema)}\u0000${encStr(value)}`
        if (!(key in jsonSchemaResults)) {
          jsonSchemaResults[key] = await validateJSONSchema({
            jsonSchema: clone((caseOptions as any).jsonSchema),
            value: clone(value),
          })
        }
      }
      let result: number
      try {
        const r = await fn(clone(value), { ...caseOptions, req })
        result = r === true ? 0 : intern(typeof r === 'string' ? r : `!nonstring:${typeof r}`)
      } catch (err) {
        result = intern(errorKey(err))
      }
      row.push(result)
      if (calls.length) {
        callLogs[`${configIndex}:${valueIndex}`] = intern(JSON.stringify(calls))
      }
      totalCases++
    }
    results.push(row)
  }
  validatorFixtures.push({
    name,
    callLogs,
    options: list.map((c) => enc(c.options)),
    payloads: list.map((c) => c.payload),
    results,
  })
}

// ---------------------------------------------------------------------------------------------
// Builtins
const dateStrings = [
  ...Array.from({ length: 8000 }, randomDateString),
  ...values.filter((v) => typeof v === 'string'),
  ...values
    .filter((v) => v != null && typeof v !== 'string')
    .map((v) => {
      try {
        return String(v)
      } catch {
        return ''
      }
    }),
]
const numberStrings = [
  ...Array.from({ length: 4000 }, randomNumberString),
  ...values.filter((v) => typeof v === 'string'),
]
const doubles = [
  ...Array.from({ length: 40000 }, randomDouble),
  0,
  1e21,
  1e-7,
  123e-20,
  5e-324,
  1.7976931348623157e308,
]
const emails = [
  ...Array.from({ length: 6000 }, randomEmail),
  ...values.filter((v) => typeof v === 'string'),
]
const emailRegex =
  /^(?!.*\.\.)[\w!#$%&'*+/=?^`{|}~-](?:[\w!#$%&'*+/=?^`{|}~.-]*[\w!#$%&'*+/=?^`{|}~-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i

/** Exact IEEE-754 bits (JSON loses `-0` and NaN payloads don't matter but signs do). */
const bits = (n: number) => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, n)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

/**
 * Local date-time strings (no offset: `Date.parse` converts them with the process time zone):
 * every 15 minutes across each day on which the local UTC offset changes (found by scanning),
 * random local times over the whole range, and the hours around the ±8.64e15 ms limits.
 */
const localDateStrings = (() => {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const year = (y: number) =>
    y >= 0 && y <= 9999 ? pad(y, 4) : `${y < 0 ? '-' : '+'}${pad(Math.abs(y), 6)}`
  const iso = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
    `${year(y)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`
  const out: string[] = []
  const offsetOn = (y: number, mo: number, d: number) => {
    const date = new Date(0)
    date.setFullYear(y, mo - 1, d)
    date.setHours(12, 0, 0, 0)
    return date.getTimezoneOffset()
  }
  const years = [
    ...Array.from({ length: 2045 - 1840 }, (_, i) => 1840 + i),
    2100,
    2500,
    3000,
    10000,
    100000,
    275759,
    275760,
    -1,
    0,
    1,
    100,
    1000,
    -271821,
    -100000,
  ]
  for (const y of years) {
    for (let mo = 1; mo <= 12; mo++) {
      const days = new Date(Date.UTC(2000, mo, 0)).getUTCDate()
      for (let d = 1; d <= days; d++) {
        const before = d === 1 ? offsetOn(y, mo, d) : offsetOn(y, mo, d - 1)
        if (before === offsetOn(y, mo, d) && before === offsetOn(y, mo, d + 1)) {
          continue
        }
        for (let q = 0; q < 96; q++) {
          out.push(iso(y, mo, d, Math.floor(q / 4), (q % 4) * 15))
        }
        out.push(iso(y, mo, d, 0, 59, 59), iso(y, mo, d, 1, 59, 59), iso(y, mo, d, 2, 59, 59))
      }
    }
  }
  for (let i = 0; i < 6000; i++) {
    const y = pick([randInt(1800, 2100), randInt(-271821, 275760), randInt(0, 3000)])
    out.push(iso(y, randInt(1, 12), randInt(1, 28), randInt(0, 23), randInt(0, 59), randInt(0, 59)))
  }
  for (let h = 0; h < 24; h++) {
    for (const mi of [0, 30, 59]) {
      out.push(iso(275760, 9, 12, h, mi), iso(275760, 9, 13, h, mi), iso(275760, 9, 14, h, mi))
      out.push(iso(-271821, 4, 19, h, mi), iso(-271821, 4, 20, h, mi), iso(-271821, 4, 21, h, mi))
      out.push(`Sep 13 275760 ${pad(h)}:${pad(mi)}`, `Apr 20 -271821 ${pad(h)}:${pad(mi)}`)
    }
  }
  return out
})()

const dateValues = values
  .flatMap((v) => (Array.isArray(v) ? v : [v]))
  .filter((v) => v instanceof Date)

const primitives = {
  /** `String(date)` of the corpus' valid `Date`s, keyed by time value (`ValidateHost::date_to_string`). */
  dateToString: dateValues
    .filter((d) => !Number.isNaN(d.getTime()))
    .map((d) => [d.getTime(), String(d)]),
  dateParse: [...dateStrings, ...localDateStrings].map((s) => [s, bits(Date.parse(s))]),
  email: emails.map((s) => [s, emailRegex.test(s)]),
  number: numberStrings.map((s) => [s, bits(Number(s)), bits(parseFloat(s))]),
  numberToString: doubles.map((n) => [bits(n), String(n)]),
}

// ---------------------------------------------------------------------------------------------
// t()
const validationSubset = (translations: any) => ({
  fields: { passwordsDoNotMatch: translations.fields?.passwordsDoNotMatch },
  general: {
    row: translations.general?.row,
    rows: translations.general?.rows,
    value: translations.general?.value,
  },
  validation: translations.validation,
})
const translationSets: Record<string, unknown> = {}
for (const [code, language] of Object.entries(languages)) {
  if (language && typeof language === 'object' && 'translations' in language) {
    translationSets[code] = validationSubset((language as any).translations)
  }
}
Object.assign(translationSets, {
  crafted: {
    general: { row: 'Row', rows: '' },
    validation: {
      required:
        'Req {{ count }} {{label}} {{missing}} {{toString}} {{__proto__}} {{constructor}} {{}} {{\n}} {{{x}}} {{a\nb}} }}{{ {{valueOf}}{{count}}',
      requiresAtLeast_few: 'few {{count}}',
      requiresAtLeast_one: 'one {{count}}',
      requiresAtLeast_other: 'other {{count}} {{label}}',
      requiresAtLeast_two: 'two {{ count }}',
      requiresAtLeast_zero: 'zero',
      requiresAtLeast_many: 'many {{count}}',
      empty: '',
      onlyVars: '{{label}}',
    },
    validation_other: 'flat',
  },
  empty: {},
  flat: { validation: 'flat string', general: 'g' },
  numbers: { validation: { required: 5, other: 0, requiresAtLeast: true } },
  nested: { validation: { required: { a: 1 } } },
  nullish: { validation: null, general: 0 },
  arrays: { validation: ['x'], general: { rows: ['r'] } },
  boolean: { validation: true },
})
const tKeys = [
  'validation:required',
  'validation:requiresAtLeast',
  'validation:requiresNoMoreThan',
  'validation:greaterThanMax',
  'validation:shorterThanMax',
  'validation:notValidDate',
  'validation:invalidBlocks',
  'general:rows',
  'general:row',
  'general:value',
  'fields:passwordsDoNotMatch',
  'missing:key',
  'validation',
  'a:b:c',
  '',
  'validation:empty',
  'validation:onlyVars',
  'validation:other',
  'general:rows:x',
  'validation:0',
]
const tVars: unknown[] = [
  undefined,
  {},
  { count: 0 },
  { count: 1 },
  { count: 2 },
  { count: 3 },
  { count: 6 },
  { count: '1' },
  { count: 1.5 },
  { count: NaN },
  { count: -1 },
  { label: 'L', count: 2, missing: null },
  { label: {}, count: [1, 2] },
  { label: { toString: 1 } },
  { max: 1e21, value: 0.1 + 0.2, label: 'Rows' },
  { blocks: 'a, b', maxLength: 5, value: 'v', '': 'empty', valueOf: 'own' },
]
const tCases: unknown[] = []
for (const [set, translations] of Object.entries(translationSets)) {
  for (const key of tKeys) {
    for (const vars of tVars) {
      let result: string
      try {
        const r = translate({
          key: key as any,
          translations: translations as any,
          vars: clone(vars) as any,
        })
        result = typeof r === 'string' ? r : `!nonstring:${typeof r}`
      } catch (err) {
        result = errorKey(err)
      }
      tCases.push([set, key, enc(vars), result])
    }
  }
}

// ---------------------------------------------------------------------------------------------
const fixture = {
  meta: { node: process.version, tz: process.env.TZ, v8: process.versions.v8 },
  jsonSchemaResults,
  payloads: payloads.map(enc),
  primitives,
  strings,
  t: {
    cases: tCases,
    sets: Object.fromEntries(Object.entries(translationSets).map(([k, v]) => [k, enc(v)])),
  },
  translations: enc(i18n.translations),
  user: enc(USER),
  validators: validatorFixtures,
  values: values.map(enc),
}

fs.mkdirSync(path.join(dirname, 'fixtures'), { recursive: true })
const out = path.join(dirname, 'fixtures', 'validations.json')
fs.writeFileSync(out, JSON.stringify(fixture))
console.log(
  `wrote ${out}: ${totalCases} validator cases (${validatorFixtures.length} validators, ${values.length} values), ` +
    `${tCases.length} t cases, ${Object.keys(jsonSchemaResults).length} jsonSchema results, ` +
    `${(fs.statSync(out).size / 1e6).toFixed(1)} MB`,
)
