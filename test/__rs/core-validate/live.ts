/**
 * Live-value differential for the Rust validators (crates/payload-core-validate/live): scenarios
 * where callbacks mutate the caller's objects while a validator awaits, `ObjectId` / class
 * instances / getters as values, concurrent validators, and V8 error messages. Each scenario
 * builds fresh objects and runs once against upstream `validations.ts` and once against
 * `packages/engine-rs/src/validate/validations.ts`; the result (or error class + message), the
 * result shape (sync / promise / sync throw), the microtask tick it settled on, every host call
 * (with its tick) and the final state of the mutated objects must be identical.
 *
 * Scenarios marked `control` also run upstream with the mutation switched off and must give a
 * different outcome there, proving they exercise reads made after the await.
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/x.node TZ=UTC pnpm tsx test/__rs/core-validate/live.ts
 *
 * Exits 1 on any mismatch, on an insensitive control, or when no scenario ran.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The reference must be the TS module: with the dispatch flags set, payload's validations.ts
// would export the Rust validators too and the comparison would be Rust against Rust.
if (process.env.PAYLOAD_ENGINE || process.env.PAYLOAD_CORE_ENGINE) {
  console.error('live.ts: unset PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE (the reference must be TS)')
  process.exit(1)
}

import * as upstream from '../../../packages/payload/src/fields/validations.js'
import { translations as languages } from '../../../packages/translations/src/exports/all.js'
import { initI18n } from '../../../packages/translations/src/utilities/init.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const rs = await import('../../../packages/engine-rs/src/validate/validations.js')
if ((upstream.text as unknown) === rs.text || upstream.select === rs.validationsModule.select) {
  console.error('live.ts: both sides are the same validators')
  process.exit(1)
}

const ObjectIdImport = createRequire(
  path.resolve(dirname, '../../../packages/payload/package.json'),
)('bson-objectid')
const ObjectId = 'default' in ObjectIdImport ? ObjectIdImport.default : ObjectIdImport
const OID = '507f1f77bcf86cd799439011'

const i18n = await initI18n({
  config: {
    fallbackLanguage: 'en',
    supportedLanguages: { en: languages.en },
    translations: {},
  } as any,
  context: 'api',
  language: 'en',
})

type Module = typeof upstream
type Ctx = {
  /** The mutation of `control` scenarios is applied only when this is true. */
  isMutating: boolean
  log: (...entry: unknown[]) => void
  req: (extra?: Record<string, unknown>) => any
}
type Scenario = {
  control?: true
  name: string
  run: (fns: Module, ctx: Ctx) => { call: () => unknown; state?: () => unknown }
}

const DB: Record<string, unknown[]> = {
  media: [OID, 'm1', 'm2'],
  posts: [1, 2, 3, 'abc'],
}

const collectionConfigs = [{ slug: 'posts' }, { slug: 'media' }]

const scenarios: Scenario[] = [
  {
    // review-core-query-validate-sol.md item 2: `select` reads `value` after `await filterOptions`.
    name: 'select: filterOptions mutates the value array (same object as siblingData) after an await',
    control: true,
    run: (fns, { isMutating, req }) => {
      const siblingData = { colors: ['a', 'b'] }
      const options = ['a', 'b', 'c']
      return {
        call: () =>
          fns.select(siblingData.colors, {
            data: { siblingData },
            filterOptions: async ({ siblingData: sibling }: any) => {
              await null
              if (isMutating) {
                sibling.colors.push('zzz')
              }
              return options
            },
            hasMany: true,
            options,
            req: req(),
            siblingData,
          } as any),
        state: () => siblingData,
      }
    },
  },
  {
    name: 'select: a microtask queued by filterOptions makes a duplicate before the validator resumes',
    control: true,
    run: (fns, { isMutating, req }) => {
      const value = ['a', 'b']
      return {
        call: () =>
          fns.select(value, {
            filterOptions: ({ options }: any) => {
              queueMicrotask(() => {
                if (isMutating) {
                  value.push('a')
                }
              })
              return options
            },
            hasMany: true,
            options: ['a', 'b'],
            req: req(),
            siblingData: {},
          } as any),
        state: () => value,
      }
    },
  },
  {
    name: 'select: filterOptions result array mutated after it is returned',
    control: true,
    run: (fns, { isMutating, req }) => {
      const allowed = ['a', 'b']
      return {
        call: () =>
          fns.select('a', {
            filterOptions: () => {
              queueMicrotask(() => {
                if (isMutating) {
                  allowed.shift()
                }
              })
              return allowed
            },
            options: ['a', 'b'],
            req: req(),
            siblingData: {},
          } as any),
        state: () => allowed,
      }
    },
  },
  {
    name: 'select: filterOptions mutates option objects (option.value read after the await)',
    control: true,
    run: (fns, { isMutating, req }) => {
      const options = [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ]
      return {
        call: () =>
          fns.select(['a'], {
            filterOptions: async () => {
              await Promise.resolve()
              if (isMutating) {
                options[0]!.value = 'x'
              }
              return options
            },
            options,
            req: req(),
            siblingData: {},
          } as any),
        state: () => options,
      }
    },
  },
  {
    name: 'relationship: filterOptions pushes an id into the value array',
    control: true,
    run: (fns, { isMutating, req }) => {
      const siblingData = { rel: [1, 2] }
      return {
        call: () =>
          fns.relationship(siblingData.rel, {
            data: {},
            filterOptions: ({ siblingData: sibling }: any) => {
              if (isMutating) {
                sibling.rel.push(9)
              }
              return true
            },
            relationTo: 'posts',
            req: req(),
            siblingData,
          } as any),
        state: () => siblingData,
      }
    },
  },
  {
    name: 'relationship: filterOptions adds a collection to relationTo while it is iterated',
    control: true,
    run: (fns, { isMutating, req }) => {
      const relationTo = ['posts']
      const value = [
        { relationTo: 'posts', value: 1 },
        { relationTo: 'media', value: 'm1' },
      ]
      return {
        call: () =>
          fns.relationship(
            value as any,
            {
              filterOptions: ({ relationTo: collection }: any) => {
                if (isMutating && collection === 'posts') {
                  relationTo.push('media')
                }
                return true
              },
              relationTo,
              req: req(),
              siblingData: {},
            } as any,
          ),
        state: () => relationTo,
      }
    },
  },
  {
    name: 'relationship: find mutates the value rows before the validator resumes',
    control: true,
    run: (fns, { isMutating, req }) => {
      const value = [{ relationTo: 'posts', value: 1 }]
      return {
        call: () =>
          fns.relationship(
            value as any,
            {
              filterOptions: () => ({ id: { exists: true } }),
              relationTo: ['posts'],
              req: req({
                onFind: () => {
                  if (isMutating) {
                    value[0]!.value = 77
                  }
                },
              }),
              siblingData: {},
            } as any,
          ),
        state: () => value,
      }
    },
  },
  {
    name: 'upload: the option filter object is mutated after it is returned (where identity)',
    run: (fns, { req }) => {
      const where: Record<string, unknown> = { id: { not_in: [2] } }
      return {
        call: () =>
          fns.upload(
            [1, 2] as any,
            {
              filterOptions: () => {
                queueMicrotask(() => {
                  where.marker = true
                })
                return where
              },
              relationTo: 'posts',
              req: req(),
              siblingData: {},
            } as any,
          ),
        state: () => where,
      }
    },
  },
  {
    name: 'blocks: rows mutated during filterOptions (slugs were read before the await)',
    run: (fns, { req }) => {
      const value = [{ blockType: 'a' }, { blockType: 'b' }]
      return {
        call: () =>
          fns.blocks(value, {
            filterOptions: async () => {
              await null
              value[0]!.blockType = 'zzz'
              return ['a', 'b']
            },
            req: req(),
            siblingData: {},
          } as any),
        state: () => value,
      }
    },
  },
  {
    name: 'blocks: allowed list mutated after filterOptions returned',
    control: true,
    run: (fns, { isMutating, req }) => {
      const allowed = ['a', 'b']
      return {
        call: () =>
          fns.blocks([{ blockType: 'a' }, { blockType: 'b' }], {
            filterOptions: () => {
              queueMicrotask(() => {
                if (isMutating) {
                  allowed.pop()
                }
              })
              return allowed
            },
            req: req(),
            siblingData: {},
          } as any),
        state: () => allowed,
      }
    },
  },
  {
    name: 'validateBlocksFilterOptions: result arrays and identity of allowedBlockSlugs',
    run: (fns, { req }) => {
      const allowed = ['a']
      return {
        call: async () => {
          const result = await fns.validateBlocksFilterOptions({
            data: {},
            filterOptions: () => allowed,
            req: req(),
            siblingData: {},
            value: [{ blockType: 'a' }, { blockType: 'c' }, { blockType: '' }],
          } as any)
          return { ...result, isSameAllowed: result.allowedBlockSlugs === allowed }
        },
      }
    },
  },
  ...['number', 'text', 'ObjectID'].flatMap((defaultIDType): Scenario[] => [
    {
      name: `relationship (${defaultIDType} ids): ObjectId instances and duck-typed ObjectIds`,
      run: (fns, { req }) => ({
        call: () =>
          fns.relationship(
            [
              new ObjectId(OID),
              { id: 'm1m1m1m1m1m1', toHexString: () => 'm1m1m1m1m1m1' },
              'm2',
            ] as any,
            {
              filterOptions: () => true,
              relationTo: 'media',
              req: req({ defaultIDType }),
              siblingData: {},
            } as any,
          ),
      }),
    },
    {
      name: `relationship (${defaultIDType} ids): polymorphic ObjectId value`,
      run: (fns, { req }) => ({
        call: () =>
          fns.relationship(
            [{ relationTo: 'media', value: new ObjectId(OID) }] as any,
            {
              filterOptions: () => true,
              relationTo: ['media', 'posts'],
              req: req({ defaultIDType }),
              siblingData: {},
            } as any,
          ),
      }),
    },
  ]),
  {
    name: 'relationship: getters on value rows are read in TS order and count',
    run: (fns, { log, req }) => {
      const row = {
        get relationTo() {
          log('get relationTo')
          return 'posts'
        },
        get value() {
          log('get value')
          return 1
        },
      }
      return {
        call: () =>
          fns.relationship(
            [row] as any,
            {
              filterOptions: () => true,
              relationTo: ['posts'],
              req: req(),
              siblingData: {},
            } as any,
          ),
      }
    },
  },
  {
    name: 'date: instance with its own toString, and String(value) of a class instance',
    run: (fns, { req }) => {
      const date = new Date(0)
      date.toString = () => 'not a date'
      return {
        call: () =>
          [
            date,
            new (class Day {
              toString = () => 'Monday'
            })(),
          ].map((value) => {
            try {
              return fns.date(value as any, { name: 'd', req: req(), siblingData: {} } as any)
            } catch (err) {
              return `!${(err as Error).name}:${(err as Error).message}`
            }
          }),
      }
    },
  },
  {
    name: 'concurrent: a relationship filterOptions mutates a select value awaited at the same time',
    run: (fns, { req }) => {
      const shared = { tags: ['a'] }
      return {
        call: () =>
          Promise.all([
            fns.select(shared.tags, {
              filterOptions: async ({ options }: any) => {
                await null
                await null
                return options
              },
              hasMany: true,
              options: ['a', 'b'],
              req: req(),
              siblingData: shared,
            } as any),
            fns.relationship(
              [1] as any,
              {
                filterOptions: async () => {
                  await null
                  shared.tags.push('nope')
                  return true
                },
                relationTo: 'posts',
                req: req(),
                siblingData: shared,
              } as any,
            ),
          ]),
        state: () => shared,
      }
    },
  },
  ...(
    [
      ['select: filterOptions returns null', () => null],
      ['select: filterOptions returns an object', () => ({})],
      ['select: filterOptions returns a string', () => 'ab'],
      [
        'select: filterOptions throws',
        () => {
          throw new RangeError('select boom')
        },
      ],
    ] as const
  ).map(([name, filterOptions]): Scenario => ({
    name,
    run: (fns, { req }) => ({
      call: () =>
        fns.select(['a'], { filterOptions, options: ['a'], req: req(), siblingData: {} } as any),
    }),
  })),
  {
    name: 'select: null option with a string value (option.value on null)',
    run: (fns, { req }) => ({
      call: () => fns.select('b', { options: [null, 'b'], req: req(), siblingData: {} } as any),
    }),
  },
  {
    name: 'radio: null option (option.value on null) and options not an array',
    run: (fns, { req }) => ({
      call: () =>
        [[null, 'b'], { some: 1 }, undefined].map((options) => {
          try {
            return fns.radio('b', { options, req: req() } as any)
          } catch (err) {
            return `!${(err as Error).name}:${(err as Error).message}`
          }
        }),
    }),
  },
  {
    name: 'relationship: find errors are logged with the original error (docs not an array, no loader)',
    run: (fns, { req }) => ({
      call: () =>
        Promise.all([
          fns.relationship(
            [1] as any,
            {
              filterOptions: () => true,
              relationTo: ['posts', 'baddocs', 'constructor', '__proto__'],
              req: req(),
              siblingData: {},
            } as any,
          ),
          fns.relationship(
            [{ relationTo: 'posts', value: 1 }] as any,
            {
              filterOptions: () => true,
              relationTo: ['posts'],
              req: { ...req(), payloadDataLoader: undefined },
              siblingData: {},
            } as any,
          ),
          fns.upload(
            1 as any,
            {
              filterOptions: () => true,
              relationTo: 'constructor',
              req: req(),
              siblingData: {},
            } as any,
          ),
        ]),
    }),
  },
  {
    name: 'destructuring errors: missing options / req, validateBlocksFilterOptions without args',
    run: (fns) => ({
      call: async () => {
        const out: unknown[] = []
        for (const [name, args] of [
          ['text', ['a']],
          ['text', ['a', {}]],
          ['select', ['a']],
          ['relationship', [1, { req: null }]],
          ['validateBlocksFilterOptions', []],
          ['point', []],
          ['richText', [{}, { editor: () => {} }]],
          ['richText', [{}, {}]],
        ] as const) {
          try {
            out.push(await (fns as any)[name](...args))
          } catch (err) {
            out.push(`!${(err as Error).name}:${(err as Error).message}`)
          }
        }
        return out
      },
    }),
  },
  {
    // phase-d review: `siblingData?.[`${name}_tz`]` must not evaluate the template (ToString of
    // `name`) when siblingData is nullish.
    name: 'date: nullish siblingData short-circuits the `${name}_tz` template',
    run: (fns, { log, req }) => ({
      call: () =>
        [
          [Symbol('d'), undefined],
          [Symbol('d'), null],
          [{ toString: () => (log('name.toString'), 'd') }, undefined],
          [{ toString: () => (log('name.toString'), 'd') }, { d_tz: 'UTC' }],
          [Symbol('d'), {}],
        ].map(([name, siblingData]) => {
          try {
            return fns.date(
              new Date(0) as any,
              {
                name,
                req: req(),
                required: true,
                siblingData,
                timezone: true,
              } as any,
            )
          } catch (err) {
            return `!${(err as Error).name}:${(err as Error).message}`
          }
        }),
    }),
  },
  {
    // Object / array literals are CreateDataProperty (no setter runs); `.push` is [[Set]].
    name: 'literals with setters on Object.prototype / Array.prototype',
    run: (fns, { log, req }) => ({
      call: async () => {
        const keys = ['label', 'maxLength', 'stringValue', 'count', 'min', 'and', 'in', 'id']
        const keys2 = ['where', 'collection', 'allBlockSlugs', 'invalidBlockSlugs', 'value']
        const installed: [object, string][] = []
        let isLogging = false
        // Null-prototype descriptors: a `value` accessor on Object.prototype would leak into them.
        const install = (target: object, key: string) => {
          Object.defineProperty(target, key, {
            __proto__: null,
            configurable: true,
            set(this: object, v: unknown) {
              // `log` itself pushes onto arrays: record only writes made outside it.
              if (!isLogging) {
                isLogging = true
                log('setter', key, typeof v)
                isLogging = false
              }
              Object.defineProperty(this, key, {
                __proto__: null,
                configurable: true,
                enumerable: true,
                value: v,
                writable: true,
              } as PropertyDescriptor)
            },
          } as PropertyDescriptor)
          installed.push([target, key])
        }
        try {
          for (const key of [...keys, ...keys2]) {
            install(Object.prototype, key)
          }
          install(Array.prototype, '0')
          install(Array.prototype, '1')
          return [
            fns.text('hello', { maxLength: 2, req: req() } as any),
            fns.array([1], { minRows: 3, req: req() } as any),
            fns.number(5, { max: 1, req: req() } as any),
            await fns.relationship(
              [1, 2] as any,
              {
                filterOptions: () => ({ title: { equals: 'x' } }),
                relationTo: 'posts',
                req: req(),
                siblingData: {},
              } as any,
            ),
            await fns.validateBlocksFilterOptions({
              filterOptions: ['a'],
              req: req(),
              value: [{ blockType: 'a' }, { blockType: 'b' }],
            } as any),
            await fns.select(
              ['a', 'a'] as any,
              { hasMany: true, options: ['a'], req: req() } as any,
            ),
          ]
        } finally {
          for (const [target, key] of installed) {
            delete (target as any)[key]
          }
        }
      },
    }),
  },
  {
    // `.push` is Array.prototype.push: `Set(O, len, v)` then `Set(O, 'length', len + 1)`, so a
    // setter that defines nothing still grows the length; a getter-only index makes it throw.
    name: '.push with an index setter that defines nothing / a getter-only index',
    run: (fns, { log, req }) => ({
      call: async () => {
        const quietReq = () => ({
          ...req(),
          t: (key: string, vars?: unknown) => i18n.t(key as any, vars as any),
        })
        // No array writes while the index accessors are installed: results go into an object.
        let results: Record<string, unknown> = {}
        const capture = async (key: string, f: () => unknown) => {
          try {
            results[key] = await f()
          } catch (err) {
            results[key] = `!${(err as Error).name}:${(err as Error).message}`
          }
        }
        const runAll = async () => {
          await capture('select', () =>
            fns.select(
              ['a', 'a'] as any,
              { hasMany: true, options: ['a'], req: quietReq() } as any,
            ),
          )
          await capture('relationship', () =>
            fns.relationship(
              1 as any,
              {
                filterOptions: {},
                relationTo: 'posts',
                req: {
                  ...quietReq(),
                  payloadDataLoader: {
                    find: (args: any) => {
                      results.find = `${args.where.and[0].id.in.length} ${args.where.and.length}`
                      return Promise.resolve({ docs: [] })
                    },
                  },
                },
                siblingData: {},
              } as any,
            ),
          )
          await capture('blocks', () =>
            fns
              .validateBlocksFilterOptions({
                filterOptions: ['a'],
                req: quietReq(),
                value: [{ blockType: 'b' }],
              } as any)
              .then((r: any) => `${r.invalidBlockSlugs.length} ${r.allBlockSlugs.length}`),
          )
        }
        const proto = Array.prototype as any
        Object.defineProperty(proto, '0', { configurable: true, get() {}, set() {} })
        try {
          await runAll()
        } finally {
          delete proto['0']
        }
        const before = results
        results = {}
        Object.defineProperty(proto, '1', { configurable: true, get: () => 'getter' })
        try {
          await runAll()
        } finally {
          delete proto['1']
        }
        log('done')
        return [before, results]
      },
    }),
  },
  {
    // `event === 'onChange'` and isValidID's `type === 'number'` compare UTF-16 code units.
    name: 'string literals against non-Latin-1 strings with the same low bytes',
    run: (fns, { req }) => ({
      call: async () => {
        const out: unknown[] = []
        out.push(
          await fns.relationship(
            'x' as any,
            {
              event: 'ůnChange',
              filterOptions: {},
              relationTo: 'posts',
              req: req(),
              siblingData: {},
            } as any,
          ),
        )
        const request = req()
        request.payload.collections.posts.customIDType = 'nŵmber'
        out.push(
          await fns.relationship(
            5 as any,
            { event: 'onChange', relationTo: 'posts', req: request } as any,
          ),
        )
        request.payload.collections.posts.customIDType = 'Ŵext'
        out.push(
          await fns.relationship(
            'abc' as any,
            { event: 'onChange', relationTo: 'posts', req: request } as any,
          ),
        )
        return out
      },
    }),
  },
  {
    // map / filter read the length before ArraySpeciesCreate's `constructor` read.
    name: 'a constructor getter that resizes the array during .map / .filter',
    run: (fns, { log, req }) => ({
      call: async () => {
        const rows: any[] = [{ blockType: 'a' }, { blockType: 'b' }]
        Object.defineProperty(rows, 'constructor', {
          get() {
            log('constructor', rows.length)
            if (rows.length < 4) {
              rows.push({ blockType: 'c' })
            }
            return Array
          },
        })
        const values: any[] = [1, 2]
        Object.defineProperty(values, 'constructor', {
          get() {
            log('values constructor', values.length)
            values.length = 1
            return undefined
          },
        })
        return [
          await fns
            .validateBlocksFilterOptions({ filterOptions: ['a'], req: req(), value: rows } as any)
            .then((r: any) => [r.allBlockSlugs, r.invalidBlockSlugs]),
          await fns.relationship(
            values as any,
            { event: 'onChange', relationTo: 'posts', req: req() } as any,
          ),
        ]
      },
    }),
  },
  {
    // Array.isArray throws for a revoked proxy, where the TS calls it.
    name: 'revoked proxies as the value and as relationTo (revoked by a getter between rows)',
    run: (fns, { log, req }) => ({
      call: async () => {
        const out: unknown[] = []
        const capture = async (f: () => unknown) => {
          try {
            out.push(await f())
          } catch (err) {
            out.push(`!${(err as Error).name}:${(err as Error).message}`)
          }
        }
        const revokedValue = Proxy.revocable({ relationTo: 'posts', value: 1 }, {})
        revokedValue.revoke()
        await capture(() =>
          fns.relationship(revokedValue.proxy as any, { relationTo: ['posts'], req: req() } as any),
        )
        await capture(() => fns.text(revokedValue.proxy as any, { req: req() } as any))
        await capture(() =>
          fns.json(revokedValue.proxy as any, { jsonSchema: {}, req: req() } as any),
        )
        const relationTo = Proxy.revocable(['posts'], {})
        const rows = [
          {
            get relationTo() {
              log('row 1 relationTo')
              relationTo.revoke()
              return 'posts'
            },
            value: 1,
          },
          { relationTo: 'posts', value: 2 },
        ]
        await capture(() =>
          fns.relationship(
            rows as any,
            { event: 'onChange', relationTo: relationTo.proxy, req: req() } as any,
          ),
        )
        const live = Proxy.revocable({ relationTo: 'posts', value: 'x' }, {})
        await capture(() =>
          fns.relationship(
            live.proxy as any,
            { event: 'onChange', relationTo: ['posts'], req: req() } as any,
          ),
        )
        return out
      },
    }),
  },
  {
    // Patched iteration builtins are called exactly like the TS calls them.
    name: 'patched Array.prototype iterator / methods and %ArrayIteratorPrototype%.return',
    run: (fns, { log, req }) => ({
      call: async () => {
        const proto = Array.prototype as any
        const iteratorProto = Object.getPrototypeOf([][Symbol.iterator]())
        const names = ['some', 'filter', 'map', 'push', 'includes', 'indexOf', 'find', 'forEach']
        let isLogging = false
        const originals = new Map<PropertyKey, unknown>(
          [...names, Symbol.iterator].map((key) => [key, proto[key]]),
        )
        const run = async () => [
          fns.text(['a', 'bbb'] as any, { hasMany: true, maxLength: 2, req: req() } as any),
          fns.text('abc', { maxLength: 2, req: req() } as any),
          fns.text('ab', { maxLength: 2, req: req() } as any),
          fns.number([1, 'x'] as any, { hasMany: true, req: req() } as any),
          fns.radio('b', { options: ['a', { value: 'b' }], req: req() } as any),
          await fns.select(
            ['a', 'a', 'b'] as any,
            {
              hasMany: true,
              options: ['a', 'b'],
              req: req(),
            } as any,
          ),
          await fns.relationship(
            [1, 9] as any,
            {
              filterOptions: () => true,
              relationTo: ['posts'],
              req: req(),
              siblingData: {},
            } as any,
          ),
          await fns.validateBlocksFilterOptions({
            filterOptions: ['a'],
            req: req(),
            value: [{ blockType: 'a' }, { blockType: 'b' }, {}],
          } as any),
        ]
        try {
          for (const [key, original] of originals) {
            proto[key] = function (this: unknown, ...args: unknown[]) {
              // `log` itself uses array methods: record only calls made outside it.
              if (!isLogging) {
                isLogging = true
                log('Array.prototype', String(key), Array.isArray(this))
                isLogging = false
              }
              return Reflect.apply(original as Function, this, args)
            }
          }
          const withMethods = await run()
          for (const [key, original] of originals) {
            proto[key] = original
          }
          iteratorProto.return = function () {
            log('ArrayIterator return')
            return {}
          }
          return [withMethods, await run()]
        } finally {
          for (const [key, original] of originals) {
            proto[key] = original
          }
          delete iteratorProto.return
        }
      },
    }),
  },
  {
    name: 'exports: names, lengths and the validations object',
    run: (fns) => ({
      call: () =>
        Object.entries(fns)
          .filter(([, value]) => typeof value === 'function')
          .map(([key, value]) => [key, (value as Function).name, (value as Function).length])
          // A module namespace lists its keys sorted.
          .sort(([a], [b]) => (String(a) < String(b) ? -1 : 1))
          .concat([Object.keys(fns.validations)]),
    }),
  },
]

// ---------------------------------------------------------------------------------------------

let tick = 0

const runScenario = async (scenario: Scenario, fns: Module, isMutating: boolean) => {
  const log: unknown[] = []
  const record = (...entry: unknown[]) => log.push([...entry, tick])
  const req = ({
    defaultIDType = 'number',
    onFind,
  }: { defaultIDType?: string; onFind?: () => void } = {}) => {
    const request: any = {
      payload: {
        collections: Object.fromEntries(
          collectionConfigs.map((config) => [
            config.slug,
            { config, customIDType: config.slug === 'media' ? 'text' : undefined },
          ]),
        ),
        config: { collections: collectionConfigs },
        db: { defaultIDType },
        logger: {
          error: ({ err, msg }: any) => record('logger.error', msg, err?.name, err?.message),
        },
      },
      payloadDataLoader: {
        find: (args: any) => {
          record('find', args.collection, JSON.stringify(args.where), args.overrideAccess)
          if (args.collection === 'baddocs') {
            return Promise.resolve({ docs: 5 })
          }
          const docs = DB[args.collection]
          if (!docs) {
            throw new Error(`unknown collection ${String(args.collection)}`)
          }
          const ids = docs.filter((id) => args.where.and[0].id.in.includes(id))
          onFind?.()
          return Promise.resolve({ docs: ids.map((id) => ({ id })) })
        },
      },
      t: (key: string, vars?: unknown) => {
        record('t', key, vars === undefined ? 'none' : JSON.stringify(vars))
        return i18n.t(key as any, vars as any)
      },
      user: { id: 'u1' },
    }
    return request
  }
  const { call, state } = scenario.run(fns, { isMutating, log: record, req })
  tick = 0
  let running = true
  const ticker = (async () => {
    while (running && tick < 1000) {
      await null
      tick++
    }
  })()
  let shape = 'sync'
  let result: unknown
  try {
    const returned = call()
    if (returned instanceof Promise) {
      shape = 'promise'
    }
    try {
      result = await returned
    } catch (err) {
      result = `!${(err as Error)?.name}:${(err as Error)?.message}`
    }
  } catch (err) {
    shape = 'syncThrow'
    result = `!${(err as Error)?.name}:${(err as Error)?.message}`
  }
  const settledTick = tick
  running = false
  await ticker
  const encode = (v: unknown) =>
    JSON.stringify(v, (_key, inner) =>
      typeof inner === 'bigint'
        ? `${inner}n`
        : inner instanceof ObjectId
          ? `ObjectId(${inner})`
          : inner,
    )
  return encode({ log, result, settledTick, shape, state: state?.() })
}

let compared = 0
let mismatches = 0
let insensitive = 0
const verbose = process.env.RS_CORE_VALIDATE_VERBOSE === '1'
for (const scenario of scenarios) {
  const ts = await runScenario(scenario, upstream, true)
  const rust = await runScenario(scenario, rs.validationsModule, true)
  compared++
  const isMatch = ts === rust
  let isSensitive = true
  if (scenario.control) {
    isSensitive = (await runScenario(scenario, upstream, false)) !== ts
  }
  if (!isMatch) {
    mismatches++
  }
  if (!isSensitive) {
    insensitive++
  }
  console.log(
    `${isMatch ? 'ok  ' : 'FAIL'} ${scenario.name}${isSensitive ? '' : ' (control: mutation has no effect)'}`,
  )
  if ((!isMatch || verbose) && ts !== undefined) {
    console.log(`  ts   ${ts}`)
    if (!isMatch) {
      console.log(`  rust ${rust}`)
    }
  }
}
console.log(
  `live differential (TZ=${process.env.TZ}): ${compared} scenarios, ${mismatches} mismatches, ${insensitive} insensitive controls`,
)
process.exitCode = compared === 0 || mismatches > 0 || insensitive > 0 ? 1 : 0
