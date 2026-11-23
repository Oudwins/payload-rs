/**
 * Differential corpus of the function compiler (crates/payload-fn-ir,
 * packages/engine-rs/src/compile): every case is compiled, then evaluated in Rust and called as
 * the real JS function on each argument set. Whenever the compiled evaluation returns a value it
 * must equal the JS result exactly (key order, `-0`, `NaN`, `undefined` properties); a bail is
 * always allowed (the real function then runs), but the `bails` column records how often.
 */
import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'
import {
  compileFunction,
  evaluateCompiled,
  installCompileGuards,
} from '../../../packages/engine-rs/src/compile/index.js'
import { getFnIr } from '../../../packages/engine-rs/src/compile/native.js'
import * as helpers from './helpers.js'
import { asyncIsAdmin, checkRole, isAdmin, roles, slugify, tenantField } from './helpers.js'

type Case = {
  args: unknown[][]
  /** `false`: the function must not compile (with this reason, when a string). */
  compiles?: false | string
  fn: Function
  name: string
}

const req = (user: unknown, extra: Record<string, unknown> = {}) => ({
  context: {},
  fallbackLocale: 'en',
  locale: 'en',
  payload: { find: () => ({ docs: [] }) },
  query: {},
  t: (key: string) => key,
  user,
  ...extra,
})

const admin = { id: 1, collection: 'users', roles: ['admin'] }
const editor = { id: 'abc', collection: 'users', roles: ['editor'] }
const users = [null, undefined, admin, editor, { id: 3 }, { id: 4, roles: [] }]
const accessArgs = users.map((user) => [{ id: undefined, data: undefined, req: req(user) }])

// A webpack / turbopack style module object: getters on a `Module`-tagged object, called as
// `(0, ns.fn)(...)`. The function is created where the namespace is a closure variable.
const webpackNamespace = (() => {
  const ns: Record<string, unknown> = {}
  Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' })
  Object.defineProperty(ns, '__esModule', { value: true })
  Object.defineProperty(ns, 'checkRole', { enumerable: true, get: () => checkRole })
  return ns
})()
// eslint-disable-next-line no-new-func
const bundledAccess = new Function(
  '_access_checkRole__WEBPACK_IMPORTED_MODULE_0__',
  `return ({ req: { user } }) => { if (user) return (0, _access_checkRole__WEBPACK_IMPORTED_MODULE_0__.checkRole)(['admin'], user); return false }`,
)(webpackNamespace) as Function
// Turbopack: a null-prototype namespace with getters, members read with string keys.
const turbopackNamespace = (() => {
  const ns = Object.create(null) as Record<string, unknown>
  Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' })
  Object.defineProperty(ns, 'checkRole', { enumerable: true, get: () => checkRole })
  Object.defineProperty(ns, 'roles', { enumerable: true, get: () => roles })
  return ns
})()
// eslint-disable-next-line no-new-func
const turbopackAccess = new Function(
  '__TURBOPACK__imported__module__access__',
  `return ({ req }) => (0, __TURBOPACK__imported__module__access__["checkRole"])([__TURBOPACK__imported__module__access__["roles"].editor], req.user)`,
)(turbopackNamespace) as Function
// esbuild / rollup scope hoisting: helpers are plain variables of the bundle's scope.
// eslint-disable-next-line no-new-func
const hoistedAccess = new Function(`
  function checkRole2(allRoles = [], user) {
    return Boolean(user && allRoles.some((role) => user.roles?.includes(role)))
  }
  var isAdmin2 = (user) => checkRole2(["admin"], user);
  return ({ req: { user } }) => isAdmin2(user) || (user ? { owner: { equals: user.id } } : false)
`)() as Function

const factory =
  (field: string) =>
  ({ req: { user } }: any) =>
    user ? { [field]: { equals: user.id } } : false

const cases: Case[] = [
  { name: 'anyone', fn: () => true, args: [[]] },
  { name: 'authenticated', fn: ({ req: { user } }: any) => Boolean(user), args: accessArgs },
  {
    name: 'authenticatedOrPublished',
    fn: ({ req: { user } }: any) => {
      if (user) {
        return true
      }
      return { _status: { equals: 'published' } }
    },
    args: accessArgs,
  },
  {
    name: 'adminOrSelf (imported helper)',
    fn: ({ req: { user } }: any) => {
      if (user) {
        if (checkRole(['admin'], user)) {
          return true
        }
        return { id: { equals: user.id } }
      }
      return false
    },
    args: accessArgs,
  },
  {
    name: 'isDocumentOwner (req.user?.id)',
    fn: ({ req }: any) => {
      if (req.user && checkRole(['admin'], req.user)) {
        return true
      }
      if (req.user?.id) {
        return { customer: { equals: req.user.id } }
      }
      return false
    },
    args: accessArgs,
  },
  {
    name: 'namespace import',
    fn: ({ req }: any) => helpers.checkRole(['editor'], req.user),
    args: accessArgs,
  },
  { name: 'bundled (webpack namespace)', fn: bundledAccess, args: accessArgs },
  { name: 'bundled (turbopack namespace)', fn: turbopackAccess, args: accessArgs },
  { name: 'bundled (scope hoisting)', fn: hoistedAccess, args: accessArgs },
  { name: 'closure factory', fn: factory(tenantField), args: accessArgs },
  {
    name: 'function declaration helper',
    fn: ({ req }: any) => isAdmin(req.user),
    args: accessArgs,
  },
  {
    name: 'captured object member',
    fn: ({ req }: any) => req.user?.roles?.includes(roles.editor) ?? false,
    args: accessArgs,
  },
  {
    name: 'async with await of an async helper',
    fn: async ({ req }: any) => {
      const ok = await asyncIsAdmin(req.user)
      return ok ? true : { owner: { equals: req.user?.id ?? null } }
    },
    args: accessArgs,
  },
  {
    name: 'method shorthand',
    fn: {
      read({ req }: any) {
        return !!req.user
      },
    }.read,
    args: accessArgs,
  },
  {
    name: 'field access with doc / siblingData',
    fn: ({ doc, req, siblingData }: any) =>
      req.user?.id === doc?.owner || siblingData?.public === true,
    args: [
      [{ doc: { owner: 1 }, req: req(admin), siblingData: {} }],
      [{ doc: { owner: 2 }, req: req(admin), siblingData: { public: true } }],
      [{ doc: undefined, req: req(null), siblingData: undefined }],
    ],
  },
  {
    name: 'slug hook (regexp replace, imported)',
    fn: ({ value, data }: any) =>
      typeof value === 'string' ? slugify(value) : slugify(String(data?.title ?? '')),
    args: [
      [{ value: 'Hello World!' }],
      [{ value: undefined, data: { title: 'Ünïcode Títle 2' } }],
      [{ value: 42, data: {} }],
    ],
  },
  {
    name: 'trim hook',
    fn: ({ value }: any) => value?.trim(),
    args: [[{ value: '  a b  ' }], [{ value: ' ﻿x ' }], [{ value: undefined }], [{ value: 1 }]],
  },
  {
    name: 'validator (value, options)',
    fn: (value: any, { siblingData }: any) => {
      if (!value && siblingData?.required) {
        return 'This field is required'
      }
      if (typeof value === 'string' && value.length > 10) {
        return `Too long: ${value.length} > 10`
      }
      return true
    },
    args: [
      ['', { req: req(null), siblingData: { required: true } }],
      ['short', { req: req(null), siblingData: {} }],
      ['way too long string', { req: req(null), siblingData: {} }],
      ['😀😀😀😀😀😀', { req: req(null), siblingData: {} }],
    ],
  },
  {
    name: 'numbers and coercion',
    fn: (a: any, b: any) => [
      a + b,
      a - b,
      a * b,
      a / b,
      a % b,
      a == b,
      a < b,
      `${a}${b}`,
      typeof a,
      -a,
      +b,
    ],
    args: [
      [1, 2],
      [0.1, 0.2],
      ['3', 4],
      [-0, 0],
      [null, undefined],
      [true, '1'],
      [1e21, 7],
      ['', ' '],
      ['b', 'a'],
      [NaN, NaN],
    ],
  },
  {
    name: 'object literal key order and spread',
    fn: ({ data }: any) => ({ z: 1, ...data, 10: 'ten', a: data?.a, 2: 'two' }),
    args: [[{ data: { b: 1, 1: 'one', a: 0 } }], [{ data: undefined }], [{ data: { z: 9 } }]],
  },
  {
    name: 'array methods',
    fn: ({ data }: any) => ({
      every: data.items.every((i: any) => i.n > 0),
      filtered: data.items.filter((i: any) => i.n % 2 === 0).map((i: any) => i.n),
      found: data.items.find((i: any) => i.n === 3) ?? null,
      idx: data.items.findIndex((i: any) => i.n === 3),
      joined: data.items.map((i: any) => i.n).join('-'),
      keys: Object.keys(data.items[0] ?? {}),
      bool: data.flags.filter(Boolean),
    }),
    args: [
      [{ data: { flags: [0, 1, '', 'x', null], items: [{ n: 1 }, { n: 2 }, { n: 3 }] } }],
      [{ data: { flags: [], items: [] } }],
    ],
  },
  {
    name: 'switch on operation',
    fn: ({ operation, req }: any) => {
      switch (operation) {
        case 'create':
          return Boolean(req.user)
        case 'update':
        case 'delete':
          return checkRole(['admin'], req.user)
        default:
          return true
      }
    },
    args: ['create', 'update', 'delete', 'read'].flatMap((operation) =>
      [null, admin, editor].map((user) => [{ operation, req: req(user) }]),
    ),
  },
  {
    name: 'let reassignment',
    fn: ({ req }: any) => {
      let result: any = false
      if (req.user) {
        result = { owner: { equals: req.user.id } }
      }
      if (checkRole(['admin'], req.user)) {
        result = true
      }
      return result
    },
    args: accessArgs,
  },
  {
    name: 'reads req.locale and req.context',
    fn: ({ req }: any) => (req.context?.skip ? true : { locale: { equals: req.locale } }),
    args: [[{ req: req(null) }], [{ req: req(null, { context: { skip: 1 }, locale: 'de' }) }]],
  },
  {
    name: 'throws for some inputs',
    fn: ({ req }: any) => {
      if (!req.user) {
        throw new Error('nope')
      }
      return true
    },
    args: accessArgs,
  },
  // Rejected shapes.
  {
    name: 'req.payload call',
    compiles: 'reads req.payload.find',
    fn: async ({ req }: any) => (await req.payload.find({})).docs.length > 0,
    args: accessArgs,
  },
  {
    name: 'payload config read through req (withBaseAccess shape)',
    fn: async (args: any) => {
      const accessArgs = { ...args, slug: 'posts' }
      const { baseAccess } = args.req.payload.config
      if (!baseAccess?.collections?.read) {
        return checkRole(['admin'], accessArgs.req.user) || { slug: { equals: accessArgs.slug } }
      }
      return false
    },
    args: users.map((user) => [
      {
        id: undefined,
        req: { ...req(user), payload: { config: { admin: {}, baseAccess: undefined } } },
      },
    ]),
  },
  {
    name: 'this',
    compiles: 'this',
    fn: function (this: any) {
      return this?.x
    },
    args: [[]],
  },
  {
    name: 'loop',
    compiles: 'loop',
    fn: (a: any[]) => {
      for (const x of a) {
        if (x) return x
      }
      return null
    },
    args: [[[1]]],
  },
  {
    name: 'mutates data',
    compiles: 'assignment to a property or pattern',
    fn: ({ data }: any) => {
      data.x = 1
      return data
    },
    args: [[{ data: {} }]],
  },
  { name: 'Date', compiles: 'new expression', fn: () => new Date().getTime(), args: [[]] },
  {
    name: 'opt-out',
    compiles: 'opted out (skipCompilation)',
    fn: (args: any) => {
      args.skipCompilation?.()
      return true
    },
    args: [[{ skipCompilation: () => {} }]],
  },
]

const strictEqual = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b)
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return a === b
  }
  if (
    Array.isArray(a) !== Array.isArray(b) ||
    Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)
  ) {
    return false
  }
  const ka = Reflect.ownKeys(a)
  const kb = Reflect.ownKeys(b)
  return (
    ka.length === kb.length &&
    ka.every((k, i) => k === kb[i] && strictEqual((a as any)[k], (b as any)[k]))
  )
}

const runJs = async (fn: Function, args: unknown[]) => {
  try {
    return { ok: true as const, value: await fn(...args) }
  } catch (error) {
    return { error, ok: false as const }
  }
}

test.suite('fn-compile corpus', {}, () => {
  for (const c of cases) {
    test(`should evaluate "${c.name}" exactly like JS`, async () => {
      const compiled = compileFunction(c.fn, c.name)
      if (c.compiles !== undefined) {
        expect(compiled.ok).toBe(false)
        if (typeof c.compiles === 'string' && !compiled.ok) {
          expect(compiled.reason).toBe(c.compiles)
        }
        return
      }
      expect(compiled).toMatchObject({ ok: true })
      for (const args of c.args) {
        const js = await runJs(c.fn, args)
        const rs = evaluateCompiled(c.fn, args)
        if (!rs.ok) {
          // Bails are allowed; a JS throw must bail.
          if (process.env.FN_COMPILE_CORPUS_VERBOSE) {
            process.stdout.write(
              `[corpus] ${c.name}: bail (${rs.reason}) js ${js.ok ? 'ok' : 'threw'}\n`,
            )
          }
          continue
        }
        expect(js.ok, `${c.name}: JS threw but Rust returned ${JSON.stringify(rs.value)}`).toBe(
          true,
        )
        if (js.ok && !strictEqual(rs.value, js.value)) {
          throw new Error(
            `${c.name} ${JSON.stringify(args.map((a) => ((a as any)?.req ? { ...(a as any), req: '<req>' } : a)))}: compiled ${JSON.stringify(rs.value)} !== js ${JSON.stringify(js.value)}`,
          )
        }
      }
    })
  }

  test('should not bail on the template shapes', () => {
    for (const name of [
      'authenticated',
      'adminOrSelf (imported helper)',
      'bundled (webpack namespace)',
      'bundled (turbopack namespace)',
      'bundled (scope hoisting)',
    ]) {
      const c = cases.find((x) => x.name === name)!
      for (const args of c.args) {
        expect(evaluateCompiled(c.fn, args)).toMatchObject({ ok: true })
      }
    }
  })

  test('should de-optimise a function whose captured binding was reassigned (guard mode)', async () => {
    const config = {
      collections: [
        { access: { read: () => helpers.readsMutable() === 1 }, fields: [], hooks: {}, slug: 'c' },
      ],
      globals: [],
    }
    process.env.PAYLOAD_FN_COMPILE_GUARD ??= 'all'
    const result = installCompileGuards(config)
    expect(result).toEqual({ compiled: 1, total: 1 })
    const read = config.collections[0]!.access.read
    expect(read()).toBe(true)
    helpers.bumpMutable()
    const errors: string[] = []
    const write = process.stderr.write
    process.stderr.write = ((chunk: string) => errors.push(String(chunk))) as typeof write
    try {
      expect(read()).toBe(false)
    } finally {
      process.stderr.write = write
    }
    expect(errors.join('')).toContain('MISMATCH')
    const compiled = compileFunction(read)
    expect(compiled.ok && getFnIr().fnIrIsActive(compiled.id)).toBe(false)
  })
})
