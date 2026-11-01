/**
 * Differential check: the mongoose models built by the Rust port of db-mongodb's model building
 * (`createMongoInitRS`, crates/payload-mongo-schema) must be identical to the ones upstream
 * `init` (packages/db-mongodb/src/init.ts) builds, for every loadable `test/<suite>/config.ts`
 * plus test/__rs/mongo-schema/syntheticConfigs.ts, in four adapter variants.
 *
 * Both sides run on unopened connections of the same mongoose; nothing touches the database.
 * Compared exactly: everything reachable from each model's schema (`paths` with their SchemaType
 * instances, options, validators, defaults, getters/setters, `childSchemas`, `obj`, `_indexes`,
 * `options`, `virtuals`, `plugins`, `methods`, `statics`, hooks, discriminators, ...; own keys in
 * order, property descriptors, prototypes, function sources), `schema.indexes()`, model / collection
 * names, discriminator models, the connection's model and collection registration order, the
 * `getBuildQueryPlugin` calls (arguments, which plugin ends up on which schema) and thrown errors.
 * Identity: objects of the config must be the very same objects on both sides; objects created
 * during the build must be shared between the same places on both sides (a bijection); schema
 * `$id`s must agree relative to the first schema created by each build (same creation order).
 *
 * Run:
 *   PAYLOAD_DATABASE=mongodb PAYLOAD_ENGINE_ADDON=/tmp/mongoschema-addon/payload-engine.node \
 *   MONGODB_URL='mongodb://payload:payload@localhost:27018/rs_mongoschema?authSource=admin&directConnection=true&replicaSet=rs0' \
 *     pnpm vitest run --project int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-schema/schema.int.spec.ts
 * Optional: RS_MONGO_SCHEMA_SUITES=fields,blocks limits the suites.
 */
import type { SanitizedConfig } from 'payload'

import mongoose from 'mongoose'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { traverseFields } from 'payload'
import { fieldAffectsData } from 'payload/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'

import type { MongoSchemaDeps } from '../../../packages/engine-rs/src/mongo-schema/index.js'

import { init as initTS } from '../../../packages/db-mongodb/src/init.js'
import { getBuildQueryPlugin } from '../../../packages/db-mongodb/src/queries/getBuildQueryPlugin.js'
import {
  applyMongoModelsDescription,
  createMongoInitRS,
  describeMongoModelsRS,
  isMongoSchemaCacheEnabled,
} from '../../../packages/engine-rs/src/mongo-schema/index.js'
import { syntheticConfigs } from './syntheticConfigs.js'

const recorder = vi.hoisted(() => ({
  calls: undefined as { args: unknown[]; plugin: unknown }[] | undefined,
}))

vi.mock(
  '../../../packages/db-mongodb/src/queries/getBuildQueryPlugin.js',
  async (importOriginal) => {
    const original = await importOriginal<any>()
    return {
      ...original,
      getBuildQueryPlugin: (...args: unknown[]) => {
        const plugin = original.getBuildQueryPlugin(...args)
        recorder.calls?.push({ args, plugin })
        return plugin
      },
    }
  },
)

const dirname = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.resolve(dirname, '../..')
const require = (await import('node:module')).createRequire(
  path.resolve(testDir, '../packages/db-mongodb/package.json'),
)
const paginate = (await import(pathToFileURL(require.resolve('mongoose-paginate-v2')).href)).default

const deps: MongoSchemaDeps = { getBuildQueryPlugin, mongoose, paginate }

const onlySuites = process.env.RS_MONGO_SCHEMA_SUITES?.split(',').filter(Boolean)
const suites = fs
  .readdirSync(testDir)
  .filter((dir) => fs.existsSync(path.join(testDir, dir, 'config.ts')))
  .filter((dir) => !onlySuites || onlySuites.includes(dir))
  .sort()

type AnyObject = Record<PropertyKey, any>

/** `payload` as `BasePayload.init` sets it up before `db.init()`. */
const buildPayloadLike = (config: SanitizedConfig, db: AnyObject) => {
  const collections: Record<string, { config: unknown; customIDType: string | undefined }> = {}
  for (const collection of config.collections) {
    let customIDType: string | undefined = undefined
    traverseFields({
      callback: ({ field }) => {
        if (
          ['array', 'blocks', 'group'].includes(field.type) ||
          (field.type === 'tab' && 'name' in field)
        ) {
          return true
        }
        if (!fieldAffectsData(field)) {
          return
        }
        if (field.name === 'id') {
          customIDType = field.type
          return true
        }
      },
      config,
      fields: collection.fields,
      parentIsLocalized: false,
    })
    collections[collection.slug] = { config: collection, customIDType }
  }
  const blocks = (config.blocks ?? []).reduce<AnyObject>((out, block) => {
    out[block.slug] = block
    return out
  }, {})
  return { blocks, collections, config, db }
}

const sharedTransform = (_doc: unknown, ret: unknown) => ret
const sharedSchemaOptions = {
  collation: { locale: 'en', strength: 2 },
  toJSON: { transform: sharedTransform, virtuals: true },
}
const connectionPlugin = function connectionPlugin(schema: AnyObject) {
  schema.add({ connectionPluginField: String })
}

type Variant = {
  afterCreateConnection?: (adapter: AnyObject) => void
  autoPluralization: boolean
  collectionsSchemaOptions: (config: SanitizedConfig) => AnyObject
  indexSortableFields?: boolean
  name: string
  rsFirst: boolean
  useBigIntForNumberIDs: boolean
}

const variants: Variant[] = [
  {
    name: 'default',
    autoPluralization: true,
    collectionsSchemaOptions: () => ({}),
    rsFirst: false,
    useBigIntForNumberIDs: false,
  },
  {
    name: 'bigint-noPluralization',
    autoPluralization: false,
    collectionsSchemaOptions: () => ({}),
    rsFirst: true,
    useBigIntForNumberIDs: true,
  },
  {
    name: 'schemaOptions-connectionPlugin',
    afterCreateConnection: (adapter) => {
      adapter.connection.plugin(connectionPlugin)
    },
    autoPluralization: true,
    collectionsSchemaOptions: (config) =>
      Object.fromEntries(config.collections.map((c) => [c.slug, sharedSchemaOptions])),
    rsFirst: false,
    useBigIntForNumberIDs: false,
  },
  {
    name: 'indexSortableFields',
    autoPluralization: true,
    collectionsSchemaOptions: () => ({}),
    indexSortableFields: true,
    rsFirst: true,
    useBigIntForNumberIDs: false,
  },
]

/** The adapter state `init` reads and writes (`mongooseAdapter` defaults). */
const createAdapter = (config: SanitizedConfig, variant: Variant) => {
  const adapter: AnyObject = {
    afterCreateConnection: variant.afterCreateConnection,
    autoPluralization: variant.autoPluralization,
    collections: {},
    collectionsSchemaOptions: variant.collectionsSchemaOptions(config),
    connection: undefined,
    globals: undefined,
    useBigIntForNumberIDs: variant.useBigIntForNumberIDs,
    versions: {},
  }
  adapter.payload = buildPayloadLike(config, adapter)
  return adapter
}

type Build = {
  adapter: AnyObject
  calls: { args: unknown[]; plugin: unknown }[]
  error?: unknown
  /** `$id` of a schema created just before the build. */
  idBase: number
}

const runBuild = async (
  adapter: AnyObject,
  init: (this: AnyObject) => Promise<void> | void,
): Promise<Build> => {
  const calls: Build['calls'] = []
  const idBase = (new mongoose.Schema() as AnyObject).$id
  recorder.calls = calls
  let error: unknown
  try {
    await init.call(adapter)
  } catch (e) {
    error = e
  } finally {
    recorder.calls = undefined
  }
  return { adapter, calls, error, idBase }
}

const modelInfo = (model: AnyObject | null | undefined): unknown => {
  if (!model) {
    return model
  }
  return {
    baseModelName: model.baseModelName,
    collectionName: model.collection?.collectionName,
    discriminators: model.discriminators
      ? Object.entries<AnyObject>(model.discriminators).map(([name, d]) => [
          name,
          {
            collectionName: d.collection?.collectionName,
            indexes: d.schema.indexes(),
            modelName: d.modelName,
            schema: d.schema,
          },
        ])
      : model.discriminators,
    indexes: model.schema.indexes(),
    modelName: model.modelName,
    schema: model.schema,
  }
}

const snapshot = (build: Build) => {
  const { adapter } = build
  const connection = adapter.connection
  return {
    calls: build.calls,
    collections: Object.entries<AnyObject>(adapter.collections).map(([slug, m]) => [
      slug,
      modelInfo(m),
    ]),
    connectionCollections: connection ? Object.keys(connection.collections) : connection,
    connectionModels: connection ? Object.keys(connection.models) : connection,
    error: build.error
      ? {
          class: (build.error as Error).constructor,
          message: (build.error as Error).message,
          name: (build.error as Error).name,
          status: (build.error as AnyObject).status,
        }
      : undefined,
    globals: modelInfo(adapter.globals),
    versions: Object.entries<AnyObject>(adapter.versions).map(([slug, m]) => [slug, modelInfo(m)]),
  }
}

/** Objects of the input (config, payload-like) and module-level values: identical on both sides. */
const collectShared = (roots: unknown[]): Set<object> => {
  const shared = new Set<object>()
  const pending = [...roots]
  while (pending.length) {
    const v = pending.pop()
    if ((typeof v !== 'object' && typeof v !== 'function') || v === null || shared.has(v)) {
      continue
    }
    shared.add(v)
    if (v === mongoose) {
      continue
    }
    for (const key of Reflect.ownKeys(v)) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)
      if (descriptor && 'value' in descriptor) {
        pending.push(descriptor.value)
      }
    }
  }
  return shared
}

type Context = {
  ab: Map<object, object>
  ba: Map<object, object>
  diffs: string[]
  idBase: [number, number]
  objects: number
  shared: Set<object>
}

const describeValue = (v: unknown): string => {
  if (typeof v === 'function') {
    return `[function ${v.name}]`
  }
  if (typeof v === 'object' && v !== null) {
    return `[object ${v.constructor?.name}]`
  }
  return typeof v === 'bigint' ? `${v}n` : (JSON.stringify(v) ?? String(v))
}

const MAX_DIFFS = 25

/** Exact structural comparison with identity rules (see the file comment). */
const compare = (a: unknown, b: unknown, at: string, ctx: Context): void => {
  // iterative: schema graphs are deep
  const stack: [unknown, unknown, string][] = [[a, b, at]]
  const diff = (message: string) => {
    if (ctx.diffs.length < MAX_DIFFS) {
      ctx.diffs.push(message)
    }
  }
  while (stack.length && ctx.diffs.length < MAX_DIFFS) {
    const [x, y, p] = stack.pop()!
    if (Object.is(x, y)) {
      continue
    }
    const tx = typeof x
    if (tx !== typeof y || x === null || y === null || (tx !== 'object' && tx !== 'function')) {
      diff(`${p}: ${describeValue(x)} !== ${describeValue(y)}`)
      continue
    }
    const ox = x as AnyObject
    const oy = y as AnyObject
    if (ctx.shared.has(ox) || ctx.shared.has(oy)) {
      diff(`${p}: not the same object (${describeValue(x)} / ${describeValue(y)}; config object)`)
      continue
    }
    const px = ctx.ab.get(ox)
    const py = ctx.ba.get(oy)
    if (px !== undefined || py !== undefined) {
      if (px !== oy || py !== ox) {
        diff(`${p}: object identity differs (shared in one build only)`)
      }
      continue
    }
    ctx.ab.set(ox, oy)
    ctx.ba.set(oy, ox)
    ctx.objects++
    // prototypes created by each build (model / subdocument classes) are compared like any object
    stack.push([Object.getPrototypeOf(ox), Object.getPrototypeOf(oy), `${p}<proto>`])
    if (
      tx === 'function' &&
      Function.prototype.toString.call(ox) !== Function.prototype.toString.call(oy)
    ) {
      diff(`${p}: function source differs (${ox.name} / ${oy.name})`)
      continue
    }
    if (ox instanceof Date && ox.getTime() !== oy.getTime()) {
      diff(`${p}: date ${ox.toISOString()} !== ${oy.toISOString()}`)
    }
    if (ox instanceof RegExp && String(ox) !== String(oy)) {
      diff(`${p}: ${String(ox)} !== ${String(oy)}`)
    }
    if (ox instanceof Map || ox instanceof Set) {
      stack.push([Array.from(ox as Map<unknown, unknown>), Array.from(oy), `${p}<entries>`])
    }
    const keysX = Reflect.ownKeys(ox)
    const keysY = Reflect.ownKeys(oy)
    if (keysX.length !== keysY.length || keysX.some((k, i) => k !== keysY[i])) {
      diff(`${p}: keys [${keysX.map(String).join(', ')}] !== [${keysY.map(String).join(', ')}]`)
      continue
    }
    for (let i = keysX.length - 1; i >= 0; i--) {
      const key = keysX[i]!
      const dx = Object.getOwnPropertyDescriptor(ox, key)!
      const dy = Object.getOwnPropertyDescriptor(oy, key)!
      const kp = `${p}.${String(key)}`
      if (
        dx.enumerable !== dy.enumerable ||
        dx.configurable !== dy.configurable ||
        dx.writable !== dy.writable ||
        'value' in dx !== 'value' in dy
      ) {
        diff(`${kp}: property descriptor differs`)
        continue
      }
      if ('value' in dx) {
        let vx = dx.value
        let vy = dy.value
        if (
          (key === '$id' || key === '$originalSchemaId') &&
          typeof vx === 'number' &&
          typeof vy === 'number'
        ) {
          vx -= ctx.idBase[0]
          vy -= ctx.idBase[1]
        }
        stack.push([vx, vy, kp])
      } else {
        stack.push([dx.get, dy.get, `${kp}<get>`], [dx.set, dy.set, `${kp}<set>`])
      }
    }
  }
}

const report = {
  compared: [] as string[],
  configObjectsChecked: 0,
  errorsMatched: [] as string[],
  failedToLoad: [] as { error: string; suite: string }[],
  hostCalls: 0,
  matched: [] as string[],
  mismatched: [] as string[],
  models: 0,
  objectsCompared: 0,
  ops: 0,
  tamperedDetected: 0,
  variants: 0,
}

const dropConnections = (...builds: Build[]) => {
  for (const build of builds) {
    const index = mongoose.connections.indexOf(build.adapter.connection)
    if (index !== -1) {
      mongoose.connections.splice(index, 1)
    }
  }
}

const compareBuilds = (ts: Build, rs: Build, shared: Set<object>) => {
  const ctx: Context = {
    ab: new Map(),
    ba: new Map(),
    diffs: [],
    idBase: [ts.idBase, rs.idBase],
    objects: 0,
    shared,
  }
  if (ts.adapter.connection === rs.adapter.connection) {
    ctx.diffs.push('both builds share one connection (self-comparison)')
  }
  compare(snapshot(ts), snapshot(rs), '$', ctx)
  report.objectsCompared += ctx.objects
  return ctx
}

const runSuite = async (label: string, config: SanitizedConfig) => {
  const failures: string[] = []
  for (const variant of variants) {
    const originalIndexSortableFields = config.indexSortableFields
    if (variant.indexSortableFields !== undefined) {
      config.indexSortableFields = variant.indexSortableFields
    }
    try {
      const tsAdapter = createAdapter(config, variant)
      const rsAdapter = createAdapter(config, variant)
      const shared = collectShared([
        tsAdapter.payload.config,
        tsAdapter.payload.blocks,
        rsAdapter.payload.blocks,
        tsAdapter.collectionsSchemaOptions,
        rsAdapter.collectionsSchemaOptions,
        mongoose,
        paginate,
        connectionPlugin,
      ])
      const builds: Build[] = []
      const order = variant.rsFirst ? ['rs', 'ts'] : ['ts', 'rs']
      for (const side of order) {
        builds.push(
          side === 'ts'
            ? await runBuild(tsAdapter, initTS as any)
            : await runBuild(rsAdapter, createMongoInitRS(deps)),
        )
      }
      const [ts, rs] = variant.rsFirst ? [builds[1]!, builds[0]!] : [builds[0]!, builds[1]!]
      const ctx = compareBuilds(ts, rs, shared)
      report.variants++
      report.models +=
        Object.keys(ts.adapter.collections).length +
        Object.keys(ts.adapter.versions).length +
        (ts.adapter.globals ? 1 : 0)
      report.configObjectsChecked += shared.size
      if (ts.error) {
        report.errorsMatched.push(`${label}/${variant.name}: ${(ts.error as Error).message}`)
      }
      if (ctx.diffs.length) {
        failures.push(`${variant.name}:\n  ${ctx.diffs.join('\n  ')}`)
      }
      dropConnections(ts, rs)
    } finally {
      config.indexSortableFields = originalIndexSortableFields
    }
  }
  return failures
}

/** Builds the RS side from a tampered description: the comparison must notice. */
const runTampered = async (
  config: SanitizedConfig,
  tamper: (ops: any[]) => void,
): Promise<number> => {
  const variant = variants[0]!
  const tsAdapter = createAdapter(config, variant)
  const rsAdapter = createAdapter(config, variant)
  const shared = collectShared([tsAdapter.payload.config, mongoose, paginate])
  const ts = await runBuild(tsAdapter, initTS as any)
  const rs = await runBuild(rsAdapter, function (this: AnyObject) {
    this.connection ??= mongoose.createConnection()
    const description = describeMongoModelsRS({
      adapter: this as any,
      isCacheEnabled: isMongoSchemaCacheEnabled({ connection: this.connection, mongoose }),
    })
    tamper(description.ops)
    applyMongoModelsDescription({ adapter: this as any, deps, description })
  })
  const ctx = compareBuilds(ts, rs, shared)
  dropConnections(ts, rs)
  return ctx.diffs.length
}

describe('Rust mongoose models match db-mongodb init', () => {
  it('finds test suites to compare', () => {
    expect(
      suites.length,
      `no test/<suite>/config.ts matches RS_MONGO_SCHEMA_SUITES=${onlySuites}`,
    ).toBeGreaterThan(0)
  })

  afterAll(() => {
    console.log(
      `[rs-mongo-schema] suites: ${suites.length}, compared: ${report.compared.length}, matched: ${report.matched.length}, mismatched: ${report.mismatched.length} ${JSON.stringify(report.mismatched)}, variants: ${report.variants}, models: ${report.models}, objects compared: ${report.objectsCompared}, shared (config) objects: ${report.configObjectsChecked}, tampered descriptions detected: ${report.tamperedDetected}, errors matched: ${JSON.stringify(report.errorsMatched)}, failed to load: ${report.failedToLoad.length} ${JSON.stringify(report.failedToLoad)}`,
    )
  })

  for (const suite of suites) {
    it(suite, { timeout: 600000 }, async () => {
      let config: SanitizedConfig
      try {
        const mod = await import(pathToFileURL(path.join(testDir, suite, 'config.ts')).href)
        config = await mod.default
        if (!config?.collections) {
          throw new Error('default export is not a sanitized config')
        }
      } catch (error) {
        report.failedToLoad.push({ error: String((error as Error)?.message ?? error), suite })
        return
      }
      report.compared.push(suite)
      const failures = await runSuite(suite, config)
      if (failures.length) {
        report.mismatched.push(suite)
      } else {
        report.matched.push(suite)
      }
      expect(failures, suite).toStrictEqual([])
    })
  }

  it('synthetic configs', { timeout: 600000 }, async () => {
    const configs = await syntheticConfigs()
    for (const [name, config] of Object.entries(configs)) {
      report.compared.push(`synthetic:${name}`)
      const failures = await runSuite(`synthetic:${name}`, config)
      if (failures.length) {
        report.mismatched.push(`synthetic:${name}`)
      } else {
        report.matched.push(`synthetic:${name}`)
      }
      expect(failures, name).toStrictEqual([])
    }
    // the throwing dbName must have been compared as an error with partial state
    expect(report.errorsMatched.some((e) => e.includes('dbName threw'))).toBe(true)
  })

  it('detects tampered descriptions', { timeout: 600000 }, async () => {
    const { corners } = await syntheticConfigs()
    const tampers: [string, (ops: any[]) => void][] = [
      [
        'drop last index',
        (ops) => {
          const i = ops.findLastIndex((op) => op.op === 'index')
          ops.splice(i, 1)
        },
      ],
      [
        'swap two adds',
        (ops) => {
          const i = ops.findIndex((op) => op.op === 'add')
          const j = ops.findIndex(
            (op, k) => k > i && op.op === 'add' && op.schema === ops[i].schema,
          )
          ;[ops[i], ops[j]] = [ops[j], ops[i]]
        },
      ],
      [
        'copy a config default instead of passing it',
        (ops) => {
          for (const op of ops) {
            if (op.op === 'add' && JSON.stringify(op).includes('"default"')) {
              const text = JSON.stringify(op.definition)
              if (text.includes('"k":"input"')) {
                op.definition = JSON.parse(
                  text.replace(
                    /\{"k":"input","path":\[[^\]]*\]\}/,
                    '{"k":"value","value":["a","b"]}',
                  ),
                )
                return
              }
            }
          }
        },
      ],
      [
        'unshare localized options',
        (ops) => {
          const text = JSON.stringify(ops)
          const replaced = text.replace(/\{"k":"seen","id":0\}/, '{"k":"obj","entries":[]}')
          ops.splice(0, ops.length, ...JSON.parse(replaced))
        },
      ],
    ]
    for (const [name, tamper] of tampers) {
      const diffs = await runTampered(corners, tamper)
      expect(diffs, name).toBeGreaterThan(0)
      report.tamperedDetected++
    }
  })

  it('compared every loadable config', () => {
    expect(report.compared.length).toBeGreaterThan(2)
    expect(report.models).toBeGreaterThan(0)
    expect(report.objectsCompared).toBeGreaterThan(1000)
  })
})
