/**
 * Live differential (TS vs Rust query validation, see ./harness.ts) on the synthetic config
 * (../config.ts): the generated corpus under request contexts that make the `cq-adv*` access
 * functions take microtasks / macrotasks, throw, return `where`s or mutate the `where` while the
 * validation is suspended, plus hand-written adversarial inputs (inherited keys, getters,
 * proxies, frozen objects, own `__proto__` keys, class instances, odd constraints, caller
 * `policies` / `errors`, object locales, odd sorts and joins).
 *
 *   PAYLOAD_CORE_RUNTIME_ADDON=<query addon> test/__rs/core-query/live/run.sh synthetic
 */
import type { Payload } from 'payload'

import { vi } from 'vitest'

import type { Case, ReqVariant } from './harness.js'

import { registerLiveDifferential } from './harness.js'

vi.mock(
  import('../../../../packages/payload/src/utilities/getEntityPermissions/getEntityPermissions.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapGetEntityPermissions } = await import('./record.js')
    return { ...mod, getEntityPermissions: wrapGetEntityPermissions(mod.getEntityPermissions) }
  },
)

vi.mock(
  import('../../../../packages/payload/src/auth/executeAccess.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapExecuteAccess } = await import('./record.js')
    return { ...mod, executeAccess: wrapExecuteAccess(mod.executeAccess) }
  },
)

import { test } from '../../../__helpers/int/vitest.js'

const modes = ['ticks', 'immediate', 'throw', 'mutate', 'where']

const variants = (_payload: Payload, base: ReqVariant[]): ReqVariant[] => [
  ...base,
  ...modes.flatMap((mode) =>
    base.slice(0, 2).map((v) => ({ ...v, context: () => ({ mode }), name: `${v.name}/${mode}` })),
  ),
  {
    context: () => ({ mode: 'ticks' }),
    // `${req.locale}` / `req.locale.length` reads on an object locale
    locale: {
      length: 2,
      reads: 0,
      toString() {
        this.reads++
        return 'es'
      },
    },
    name: 'object-locale',
  },
]

/** `where` inputs the generated corpus cannot express. */
const adversarialWheres = (): [string, string, () => unknown][] => {
  const getterReads: string[] = []
  return [
    ['cq-posts', 'inherited hidden key', () => Object.create({ secret: { equals: 'x' } })],
    ['cq-posts', 'inherited valid key', () => Object.create({ title: { equals: 'x' } })],
    [
      'cq-posts',
      'getter constraint',
      () =>
        Object.defineProperty({}, 'title', {
          enumerable: true,
          get() {
            getterReads.push('title')
            return { equals: getterReads.length }
          },
        }),
    ],
    [
      'cq-posts',
      'throwing getter',
      () =>
        Object.defineProperty({}, 'title', {
          enumerable: true,
          get() {
            throw new Error('getter threw')
          },
        }),
    ],
    [
      'cq-posts',
      'non-enumerable key',
      () => Object.defineProperty({ title: { equals: 1 } }, 'secret', { value: { equals: 1 } }),
    ],
    ['cq-posts', 'symbol key', () => ({ [Symbol('s')]: { equals: 1 }, title: { equals: 1 } })],
    ['cq-authors', 'frozen join rewrite', () => Object.freeze({ posts: { equals: 1 } })],
    ['cq-authors', 'join rewrite', () => ({ posts: { equals: 1 }, name: { equals: 'x' } })],
    [
      'cq-posts',
      'proxy throwing ownKeys',
      () =>
        new Proxy(
          { title: { equals: 1 } },
          {
            ownKeys() {
              throw new TypeError('no keys')
            },
          },
        ),
    ],
    ['cq-posts', 'null where', () => null],
    ['cq-posts', 'string where', () => 'title'],
    ['cq-posts', 'string constraint', () => ({ title: 'abc' })],
    [
      'cq-posts',
      'number/bool/null constraints',
      () => ({ title: 5, secret: true, internal: null }),
    ],
    [
      'cq-posts',
      'odd and items',
      () => ({ and: [null, 1, 'x', undefined, [{ title: { equals: 1 } }]] }),
    ],
    ['cq-posts', 'sparse or', () => ({ or: [, { title: { equals: 1 } }] })],
    ['cq-posts', 'own __proto__ key', () => JSON.parse('{"__proto__":{"equals":"x"}}')],
    [
      'cq-posts',
      'own __proto__ operator',
      () => ({ title: JSON.parse('{"__proto__":1,"equals":2}') }),
    ],
    [
      'cq-posts',
      'class instance nested query',
      () => ({
        authors: {
          contains: new (class Q {
            name = { equals: 'x' }
          })(),
        },
      }),
    ],
    [
      'cq-posts',
      'null-prototype nested query',
      () => ({
        authors: { contains: Object.assign(Object.create(null), { name: { equals: 'x' } }) },
      }),
    ],
    [
      'cq-posts',
      'nested has-many where',
      () => ({ authors: { equals: { 'team.title': { exists: true } } } }),
    ],
    [
      'cq-posts',
      'contains plain object',
      () => ({ title: { contains: { a: 1 } }, author: { like: [{ a: 1 }] } }),
    ],
    [
      'cq-posts',
      'deep relationship hop',
      () => ({ 'author.team.title': { equals: 'x' }, 'authors.name': { in: ['x'] } }),
    ],
    [
      'cq-adv',
      'adv hop',
      () => ({ 'target.title': { equals: 'x' }, 'targets.title': { equals: 'y' } }),
    ],
    ['cq-adv', 'adv join', () => ({ 'owned.title': { equals: 'x' }, owned: { exists: true } })],
    [
      'cq-adv',
      'adv plain',
      () => ({ plain: { equals: 1 }, title: { equals: 2 }, 'group.inner': { exists: true } }),
    ],
    [
      'cq-adv',
      'adv secret hop',
      () => ({ 'target.secret': { equals: 'x' }, 'targets.owner.title': { equals: 1 } }),
    ],
    [
      'cq-adv',
      'adv nested has-many',
      () => ({ targets: { contains: { title: { equals: 'x' } } } }),
    ],
  ]
}

const extraCases = (payload: Payload, variants: ReqVariant[]): Case[] => {
  const cases: Case[] = []
  const collection = (slug: string) => payload.collections[slug]!.config
  const settings = payload.config.globals.find((g) => g.slug === 'cq-settings')!
  for (const req of variants) {
    for (const [slug, label, where] of adversarialWheres()) {
      for (const overrideAccess of [false, true]) {
        cases.push({
          fn: 'validateQueryPaths',
          make: ({ req: r }) => {
            const inputs = { where: where() }
            r.context.where = inputs.where
            return {
              args: [
                { collectionConfig: collection(slug), overrideAccess, req: r, where: inputs.where },
              ],
              inputs,
            }
          },
          name: `adv ${slug} ${label} override=${overrideAccess} ${req.name}`,
          req,
        })
      }
    }
    // caller policies / errors, including shapes that make the TS throw
    const policyShapes: [string, () => any][] = [
      ['empty', () => ({ collections: {}, globals: {} })],
      ['no globals', () => ({ collections: {} })],
      [
        'prefilled',
        () => ({
          collections: {
            'cq-authors': {
              fields: { name: { read: { permission: true } } },
              read: { where: { name: { equals: 'x' } } },
            },
            'cq-posts': {
              fields: {
                title: true,
                group: { fields: { inner: { read: { permission: false } } } },
              },
              read: true,
            },
          },
          globals: { 'cq-settings': { fields: {} } },
        }),
      ],
    ]
    for (const [shape, policies] of policyShapes) {
      for (const where of [
        () => ({ title: { equals: 1 }, 'group.inner': { exists: true } }),
        () => ({ 'author.name': { equals: 'x' } }),
        () => ({ 'authors.name': { equals: 'x' } }),
      ]) {
        cases.push({
          fn: 'validateQueryPaths',
          make: ({ req: r }) => {
            const inputs = { errors: [] as unknown[], policies: policies(), where: where() }
            return {
              args: [
                {
                  collectionConfig: collection('cq-posts'),
                  errors: inputs.errors,
                  overrideAccess: false,
                  policies: inputs.policies,
                  req: r,
                  where: inputs.where,
                },
              ],
              inputs,
            }
          },
          name: `policies ${shape} ${req.name}`,
          req,
        })
        cases.push({
          fn: 'validateQueryPaths',
          make: ({ req: r }) => {
            const inputs = {
              policies: policies(),
              where: { label: { equals: 1 }, locked: { exists: true } },
            }
            return {
              args: [
                {
                  globalConfig: settings,
                  overrideAccess: false,
                  policies: inputs.policies,
                  req: r,
                  where: inputs.where,
                },
              ],
              inputs,
            }
          },
          name: `global policies ${shape} ${req.name}`,
          req,
        })
      }
    }
    // odd sorts
    for (const sort of [
      () => ({ replace: () => 'title' }),
      () => [undefined],
      () => 5,
      () => [''],
      () => ['title', 'title', '-internal', 'author.bio'],
      () => 'group.teamTitle',
    ]) {
      cases.push({
        fn: 'validateSortQuery',
        make: ({ req: r }) => {
          const inputs = { sort: sort() }
          return {
            args: [
              {
                collectionConfig: collection('cq-posts'),
                overrideAccess: false,
                req: r,
                sort: inputs.sort,
              },
            ],
            inputs,
          }
        },
        name: `odd sort ${String(sort)} ${req.name}`,
        req,
      })
    }
    // odd joins
    for (const joins of [
      () => 'abc',
      () => Object.freeze({ posts: { where: { title: { equals: 1 } } } }),
      () => ({ posts: Object.freeze({}) }),
      () => ({ posts: { where: null, sort: '-title' } }),
      () => ({ owned: { where: { 'owner.title': { equals: 1 } } } }),
    ]) {
      for (const slug of ['cq-authors', 'cq-adv']) {
        cases.push({
          fn: 'sanitizeJoinQuery',
          make: ({ req: r }) => {
            const inputs = { joins: joins() }
            return {
              args: [
                {
                  collectionConfig: collection(slug),
                  joins: inputs.joins,
                  overrideAccess: false,
                  req: r,
                },
              ],
              inputs,
            }
          },
          name: `odd joins ${slug} ${String(joins)} ${req.name}`,
          req,
        })
      }
    }
    // the exported validateSearchParam called directly
    for (const [path, operator, value] of [
      ['title', 'equals', 'x'],
      ['author.name', 'like', 'x'],
      ['authors', 'contains', { name: { equals: 'x' } }],
      ['_id', 'equals', 1],
      ['nope', 'exists', true],
    ] as const) {
      cases.push({
        fn: 'validateSearchParam',
        make: ({ req: r }) => {
          const inputs = {
            constraint: { [path]: { [operator]: value } },
            errors: [] as unknown[],
            policies: { collections: {}, globals: {} },
          }
          return {
            args: [
              {
                collectionConfig: collection('cq-posts'),
                constraint: inputs.constraint,
                errors: inputs.errors,
                fields: collection('cq-posts').flattenedFields,
                operator,
                overrideAccess: false,
                path,
                policies: inputs.policies,
                req: r,
                val: structuredClone(value),
              },
            ],
            inputs,
          }
        },
        name: `vsp ${path} ${operator} ${req.name}`,
        req,
      })
    }
  }
  return cases
}

test.suite(
  'core-query live: synthetic',
  { config: '../config.ts', resetBetweenTests: false },
  () => {
    registerLiveDifferential({
      extraCases,
      minCases: 1000,
      minHostCalls: 200,
      name: 'synthetic',
      variants,
    })
  },
)
