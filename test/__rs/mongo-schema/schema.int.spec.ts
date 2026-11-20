/**
 * Differential check of the live model building (crates/payload-mongo-schema `live`,
 * `createRustMongoInit` of packages/engine-rs/src/mongo-adapter/init.ts) against upstream
 * db-mongodb `init` (packages/db-mongodb/src/init.ts), for every `test/<suite>/config.ts` plus
 * test/__rs/mongo-schema/syntheticConfigs.ts, in five adapter variants.
 *
 * Both sides run on unopened connections of the same mongoose; nothing touches the database.
 *
 * 1. Operation trace (exact): one shared layer of recording proxies over the config, the
 *    payload-like object and the adapter records every get / set / has / delete / ownKeys /
 *    descriptor read / call (getters run live), interleaved with every mongoose call the build
 *    makes (`Schema.prototype.defaultOptions` / `add` / `index` / `plugin` / `path`,
 *    `SchemaType.prototype.discriminator`, `Connection.prototype.model`, `Model.discriminator`,
 *    `getBuildQueryPlugin`), arguments described deeply (config objects by the path they were first
 *    reached through, build-created objects by order of appearance). Equal traces = the same
 *    callbacks, reads and mongoose calls in the same order (review item 1).
 * 2. Model graphs (exact): everything reachable from the models (`paths`, SchemaTypes, options,
 *    validators, defaults, `obj`, `_indexes`, plugins, statics, discriminators, ...; own keys in
 *    order, property descriptors, prototypes, function sources and the captured variables of every
 *    build-created closure, read through the inspector: review item 6), `schema.indexes()`, names,
 *    the connection's registrations, the `getBuildQueryPlugin` calls and thrown errors (identity for
 *    errors thrown by user code). Config objects must be the very same objects on both sides;
 *    build-created objects a bijection; schema `$id`s relative to each build's first schema.
 * 3. Guards: a config that fails to load fails its test (item 5); the candidate must have reached
 *    the engine; the two builds must not share a connection; negative controls (mutated candidate
 *    results and traces, closures differing only in captured values) must be detected.
 *
 * Run:
 *   PAYLOAD_DATABASE=mongodb PAYLOAD_ENGINE_ADDON=<addon> MONGODB_URL='mongodb://.../<db>?...' \
 *     pnpm vitest run --project int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/mongo-schema/schema.int.spec.ts
 * Optional: RS_MONGO_SCHEMA_SUITES=fields,blocks limits the suites.
 */
import type { SanitizedConfig } from 'payload'

import mongoose from 'mongoose'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import inspector from 'node:inspector'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { types } from 'node:util'
import { traverseFields } from 'payload'
import { fieldAffectsData } from 'payload/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'

import type { MongoSchemaDeps } from '../../../packages/engine-rs/src/mongo-adapter/init.js'

import { init as initTS } from '../../../packages/db-mongodb/src/init.js'
import { getBuildQueryPlugin } from '../../../packages/db-mongodb/src/queries/getBuildQueryPlugin.js'
import { createRustMongoInit } from '../../../packages/engine-rs/src/mongo-adapter/init.js'
import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'
import { buildState, getterError, syntheticConfigs } from './syntheticConfigs.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- mongoose graphs and live configs */
type AnyObject = Record<PropertyKey, any>

const recorder = vi.hoisted(() => ({
  calls: undefined as { args: unknown[]; plugin: unknown }[] | undefined,
  trace: undefined as ((event: string) => void) | undefined,
  describeArgs: undefined as ((args: unknown[]) => string) | undefined,
}))

vi.mock(
  '../../../packages/db-mongodb/src/queries/getBuildQueryPlugin.js',
  async (importOriginal) => {
    const original = await importOriginal<any>()
    return {
      ...original,
      getBuildQueryPlugin: (...args: unknown[]) => {
        recorder.trace?.(`call getBuildQueryPlugin(${recorder.describeArgs?.(args)})`)
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
const initRS = createRustMongoInit(deps)

const onlySuites = process.env.RS_MONGO_SCHEMA_SUITES?.split(',').filter(Boolean)
const suites = fs
  .readdirSync(testDir)
  .filter((dir) => fs.existsSync(path.join(testDir, dir, 'config.ts')))
  .filter((dir) => !onlySuites || onlySuites.includes(dir))
  .sort()

// ------------------------------------------------------------------------------------------------
// operation trace: one shared proxy layer, events go to the running side's trace

type Side = { events: string[]; fresh: Map<object, string> }
let current: Side | undefined

const proxies = new WeakMap<object, any>()
const targets = new WeakMap<object, object>()
const labels = new WeakMap<object, string>()

const unwrap = (v: any) =>
  (typeof v === 'object' || typeof v === 'function') && v !== null ? (targets.get(v) ?? v) : v

const describeValue = (v: unknown): string => {
  switch (typeof v) {
    case 'bigint':
      return `${v}n`
    case 'boolean':
      return String(v)
    case 'number':
      return Object.is(v, -0) ? '-0' : String(v)
    case 'string':
      return JSON.stringify(v)
    case 'symbol':
      return `Symbol(${v.description})`
    case 'undefined':
      return 'undefined'
  }
  if (v === null) {
    return 'null'
  }
  const target = unwrap(v)
  const label = labels.get(target)
  if (label) {
    return `<${label}>`
  }
  if (!current) {
    return '<?>'
  }
  let fresh = current.fresh.get(target)
  if (!fresh) {
    fresh = `new#${current.fresh.size}:${(target as AnyObject).constructor?.name ?? 'null'}`
    current.fresh.set(target, fresh)
  }
  return `<${fresh}>`
}

/** Build-created plain objects / arrays expanded (once per event), everything else by label. */
const describeDeep = (v: unknown, seen = new Set<object>()): string => {
  const head = describeValue(v)
  const target = unwrap(v)
  if (typeof target !== 'object' || target === null || labels.has(target) || seen.has(target)) {
    return head
  }
  const proto = Object.getPrototypeOf(target)
  if (proto !== Object.prototype && proto !== null && !Array.isArray(target)) {
    return head
  }
  seen.add(target)
  const parts = Reflect.ownKeys(target).map((k) => {
    const d = Object.getOwnPropertyDescriptor(target, k)!
    return `${String(k)}${d.enumerable ? '' : '(ne)'}:${'value' in d ? describeDeep(d.value, seen) : '<accessor>'}`
  })
  return `${head}{${parts.join(',')}}`
}

/**
 * Events are kept verbatim up to `EVENT_INLINE_LIMIT` chars; longer ones (deep argument
 * descriptions of huge configs, e.g. test/benchmark-blocks) as a prefix plus the SHA-1 of the whole
 * string, so equal traces still mean equal full events without keeping gigabytes of trace.
 */
const EVENT_INLINE_LIMIT = 2000
const record = (event: string) =>
  current?.events.push(
    event.length <= EVENT_INLINE_LIMIT
      ? event
      : `${event.slice(0, 600)}… #${createHash('sha1').update(event).digest('hex')} (${event.length} chars)`,
  )

const isProxiable = (v: object) => {
  if (types.isProxy(v)) {
    return false
  }
  if (typeof v === 'function') {
    // models / mongoose functions are never part of the config
    return !(v as AnyObject).prototype?.$__setSchema && v !== mongoose.Schema
  }
  if (Array.isArray(v)) {
    return true
  }
  const proto = Object.getPrototypeOf(v)
  return (
    proto === Object.prototype ||
    proto === null ||
    !(proto instanceof Object) ||
    proto.constructor === Object
  )
}

/** The shared recording proxy of a config value (labelled by the path it was first reached through). */
const wrap = (v: any, label: string): any => {
  if ((typeof v !== 'object' && typeof v !== 'function') || v === null) {
    return v
  }
  if (targets.has(v)) {
    return v
  }
  if (!labels.has(v)) {
    labels.set(v, label)
  }
  if (!isProxiable(v)) {
    return v
  }
  const existing = proxies.get(v)
  if (existing) {
    return existing
  }
  const l = () => labels.get(v)!
  const child = (k: PropertyKey) => `${l()}.${String(k)}`
  const proxy: any = new Proxy(v, {
    apply(target, thisArg, args) {
      record(`call ${l()}(${args.map((a) => describeDeep(a)).join(', ')})`)
      return Reflect.apply(target, unwrap(thisArg), args)
    },
    defineProperty(target, k, d) {
      record(`define ${child(k)}`)
      return Reflect.defineProperty(target, k, d)
    },
    deleteProperty(target, k) {
      record(`delete ${child(k)}`)
      return Reflect.deleteProperty(target, k)
    },
    get(target, k, receiver) {
      let value: unknown
      try {
        value = Reflect.get(target, k, receiver === proxy ? target : receiver)
      } catch (error) {
        record(`get ${child(k)} threw ${describeValue(error)}`)
        throw error
      }
      if (typeof k === 'symbol') {
        record(`get ${child(k)}`)
        return value
      }
      const own = Reflect.getOwnPropertyDescriptor(target, k)
      const out =
        own && !own.configurable && !own.writable && 'value' in own ? value : wrap(value, child(k))
      record(`get ${child(k)} -> ${describeValue(value)}`)
      return out
    },
    getOwnPropertyDescriptor(target, k) {
      record(`gopd ${child(k)}`)
      return Reflect.getOwnPropertyDescriptor(target, k)
    },
    has(target, k) {
      const result = Reflect.has(target, k)
      record(`has ${child(k)} -> ${result}`)
      return result
    },
    ownKeys(target) {
      record(`ownKeys ${l()}`)
      return Reflect.ownKeys(target)
    },
    set(target, k, value, receiver) {
      record(`set ${child(k)} = ${describeDeep(value)}`)
      return Reflect.set(target, k, unwrap(value), receiver === proxy ? target : receiver)
    },
  })
  proxies.set(v, proxy)
  targets.set(proxy, v)
  return proxy
}

/** Recording wrappers of the mongoose methods the build calls (installed only during builds). */
const mongooseSpies = (): (() => void) => {
  const restore: (() => void)[] = []
  const spy = (owner: AnyObject, name: string, label: string) => {
    const original = owner[name]
    owner[name] = function (this: unknown, ...args: unknown[]) {
      record(
        `mongoose ${label}.${name}(${args.map((a) => describeDeep(a)).join(', ')}) this=${describeValue(this)}`,
      )
      return Reflect.apply(original, this, args)
    }
    restore.push(() => {
      owner[name] = original
    })
  }
  spy(mongoose.Schema.prototype, 'defaultOptions', 'Schema')
  spy(mongoose.Schema.prototype, 'add', 'Schema')
  spy(mongoose.Schema.prototype, 'index', 'Schema')
  spy(mongoose.Schema.prototype, 'plugin', 'Schema')
  spy(mongoose.Schema.prototype, 'path', 'Schema')
  spy(mongoose.SchemaType.prototype, 'discriminator', 'SchemaType')
  spy((mongoose as AnyObject).Connection.prototype, 'model', 'Connection')
  spy(mongoose.Model, 'discriminator', 'Model')
  return () => restore.reverse().forEach((r) => r())
}

// ------------------------------------------------------------------------------------------------
// closures (review item 6): the captured variables of build-created functions

const session = new inspector.Session()
session.connect()
const post = (method: string, params: AnyObject): AnyObject => {
  let out: AnyObject | undefined
  let err: unknown
  session.post(method, params, (e, r) => {
    err = e
    out = r
  })
  if (err) {
    throw err
  }
  if (!out) {
    throw new Error(`inspector ${method} did not answer synchronously`)
  }
  return out
}

/** `[[Scopes]]` of a function (Global scopes skipped): `[scope description, [name, value][]][]`. */
const closureScopes = (fn: Function): [string, [string, unknown][]][] => {
  const g = globalThis as AnyObject
  g.__rsScopeProbe = fn
  const objectGroup = 'rs-mongo-schema'
  try {
    const { result } = post('Runtime.evaluate', {
      expression: 'globalThis.__rsScopeProbe',
      objectGroup,
    })
    const props = post('Runtime.getProperties', { objectId: result.objectId, ownProperties: true })
    const scopesRef = (props.internalProperties ?? []).find(
      (p: AnyObject) => p.name === '[[Scopes]]',
    )
    if (!scopesRef) {
      return []
    }
    const list = post('Runtime.getProperties', {
      objectId: scopesRef.value.objectId,
      ownProperties: true,
    })
    const out: [string, [string, unknown][]][] = []
    for (const scope of list.result) {
      const description: string = scope.value?.description ?? ''
      if (description.startsWith('Global')) {
        continue
      }
      // the captured bindings as live values, read in-process from the materialized scope object
      // (one call; Runtime.getProperties would serialize a description of every value, e.g. the
      // full source of each module-level function, which made large configs take hours)
      post('Runtime.callFunctionOn', {
        functionDeclaration:
          'function () { globalThis.__rsScopeValue = Object.getOwnPropertyNames(this).map((n) => [n, this[n]]) }',
        objectId: scope.value.objectId,
      })
      out.push([description, g.__rsScopeValue as [string, unknown][]])
    }
    return out
  } finally {
    g.__rsScopeProbe = undefined
    g.__rsScopeValue = undefined
    post('Runtime.releaseObjectGroup', { objectGroup })
  }
}

// ------------------------------------------------------------------------------------------------
// builds

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
/** own non-enumerable and inherited schema options are not spread (review item 2) */
const inheritedSchemaOptions = Object.create(
  { strict: false, timestamps: false },
  {
    collation: { enumerable: false, value: { locale: 'de' } },
    versionKey: { enumerable: true, value: false },
  },
)

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
  {
    name: 'inheritedSchemaOptions-asyncAfterCreateConnection',
    afterCreateConnection: async (adapter) => {
      await null
      adapter.connection.plugin(connectionPlugin)
    },
    autoPluralization: true,
    collectionsSchemaOptions: (config) =>
      Object.fromEntries(config.collections.map((c) => [c.slug, inheritedSchemaOptions])),
    rsFirst: false,
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
  engineEntries: number
  error?: unknown
  events: string[]
  /** `$id` of a schema created just before the build. */
  idBase: number
}

const runBuild = async (
  adapter: AnyObject,
  init: (this: AnyObject) => Promise<void> | void,
): Promise<Build> => {
  const calls: Build['calls'] = []
  const idBase = (new mongoose.Schema() as AnyObject).$id
  const side: Side = { events: [], fresh: new Map() }
  const before = getCoreRuntime().stats().entries
  // the adapter, its payload-like object and their contents through the shared recording layer
  labels.set(adapter, 'adapter')
  labels.set(adapter.payload, 'payload')
  labels.set(adapter.payload.collections, 'payload.collections')
  labels.set(adapter.payload.blocks, 'payload.blocks')
  const proxied = wrap(adapter, 'adapter')
  buildState.adapter = adapter
  buildState.reads = 0
  recorder.calls = calls
  recorder.describeArgs = (args) => args.map((a) => describeDeep(a)).join(', ')
  recorder.trace = record
  current = side
  const restore = mongooseSpies()
  let error: unknown
  try {
    await init.call(proxied)
  } catch (e) {
    error = e
  } finally {
    restore()
    current = undefined
    recorder.calls = undefined
    recorder.trace = undefined
  }
  return {
    adapter,
    calls,
    engineEntries: getCoreRuntime().stats().entries - before,
    error,
    events: side.events,
    idBase,
  }
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

const userErrors = new Set<unknown>([getterError])

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
          // errors thrown by user code (getters, dbName functions) must be the very object
          same: userErrors.has(build.error) ? build.error : undefined,
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
  /** the two builds' connections: their `id` (a process-wide counter) is compared as equal */
  connections: [unknown, unknown]
  ba: Map<object, object>
  diffs: string[]
  idBase: [number, number]
  objects: number
  scopesCompared: number
  shared: Set<object>
}

const describeShort = (v: unknown): string => {
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
      diff(`${p}: ${describeShort(x)} !== ${describeShort(y)}`)
      continue
    }
    const ox = x as AnyObject
    const oy = y as AnyObject
    // config objects (and the shared recording proxies over them) must be the very same object
    if (ctx.shared.has(ox) || ctx.shared.has(oy) || targets.has(ox) || targets.has(oy)) {
      diff(`${p}: not the same object (${describeShort(x)} / ${describeShort(y)}; config object)`)
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
    stack.push([Object.getPrototypeOf(ox), Object.getPrototypeOf(oy), `${p}<proto>`])
    if (tx === 'function') {
      if (Function.prototype.toString.call(ox) !== Function.prototype.toString.call(oy)) {
        diff(`${p}: function source differs (${ox.name} / ${oy.name})`)
        continue
      }
      // same source: the captured variables must correspond too (bijection / identity)
      const sx = closureScopes(ox as Function)
      const sy = closureScopes(oy as Function)
      ctx.scopesCompared++
      if (sx.length !== sy.length) {
        diff(`${p}: closure scope count differs`)
        continue
      }
      for (let i = 0; i < sx.length; i++) {
        const [dx, vx] = sx[i]!
        const [dy, vy] = sy[i]!
        if (dx !== dy || vx.length !== vy.length || vx.some(([n], j) => n !== vy[j]![0])) {
          diff(`${p}<scope ${dx}>: captured variables differ`)
          continue
        }
        for (let j = 0; j < vx.length; j++) {
          stack.push([vx[j]![1], vy[j]![1], `${p}<scope ${dx}>.${vx[j]![0]}`])
        }
      }
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
        if (key === 'id' && ox === ctx.connections[0] && oy === ctx.connections[1]) {
          continue
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
  events: 0,
  failedToLoad: [] as { error: string; suite: string }[],
  matched: [] as string[],
  mismatched: [] as string[],
  models: 0,
  mutantsDetected: 0,
  objectsCompared: 0,
  scopesCompared: 0,
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

const compareTraces = (ts: Build, rs: Build): string | undefined => {
  const n = Math.max(ts.events.length, rs.events.length)
  for (let i = 0; i < n; i++) {
    if (ts.events[i] !== rs.events[i]) {
      return `trace event ${i}:\n  ts: ${ts.events[i]?.slice(0, 600)}\n  rs: ${rs.events[i]?.slice(0, 600)}`
    }
  }
  return undefined
}

const compareBuilds = (ts: Build, rs: Build, shared: Set<object>) => {
  const ctx: Context = {
    ab: new Map(),
    ba: new Map(),
    connections: [ts.adapter.connection, rs.adapter.connection],
    diffs: [],
    idBase: [ts.idBase, rs.idBase],
    objects: 0,
    scopesCompared: 0,
    shared,
  }
  if (ts.adapter.connection === rs.adapter.connection) {
    ctx.diffs.push('both builds share one connection (self-comparison)')
  }
  if (ts.engineEntries !== 0) {
    ctx.diffs.push('the reference build entered the Rust engine')
  }
  if (rs.engineEntries === 0) {
    ctx.diffs.push('the candidate build did not reach the Rust engine')
  }
  if (ts.events.length < 10) {
    ctx.diffs.push(`the reference trace is (nearly) empty (${ts.events.length} events)`)
  }
  const traceDiff = compareTraces(ts, rs)
  if (traceDiff) {
    ctx.diffs.push(traceDiff)
  }
  compare(snapshot(ts), snapshot(rs), '$', ctx)
  report.objectsCompared += ctx.objects
  report.scopesCompared += ctx.scopesCompared
  report.events += ts.events.length
  return ctx
}

const sharedRoots = (config: SanitizedConfig, ts: AnyObject, rs: AnyObject) => [
  config,
  ts.payload.blocks,
  rs.payload.blocks,
  ts.collectionsSchemaOptions,
  rs.collectionsSchemaOptions,
  mongoose,
  paginate,
  connectionPlugin,
  inheritedSchemaOptions,
]

const runSuite = async (label: string, config: SanitizedConfig) => {
  const failures: string[] = []
  for (const variant of variants) {
    const originalIndexSortableFields = Object.getOwnPropertyDescriptor(
      config,
      'indexSortableFields',
    )
    if (variant.indexSortableFields !== undefined) {
      config.indexSortableFields = variant.indexSortableFields
    }
    try {
      const tsAdapter = createAdapter(config, variant)
      const rsAdapter = createAdapter(config, variant)
      const shared = collectShared(sharedRoots(config, tsAdapter, rsAdapter))
      const builds: Build[] = []
      for (const side of variant.rsFirst ? ['rs', 'ts'] : ['ts', 'rs']) {
        builds.push(
          side === 'ts'
            ? await runBuild(tsAdapter, initTS as any)
            : await runBuild(rsAdapter, initRS),
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
      if (originalIndexSortableFields) {
        Object.defineProperty(config, 'indexSortableFields', originalIndexSortableFields)
      } else {
        delete (config as AnyObject).indexSortableFields
      }
    }
  }
  return failures
}

describe('Rust live mongoose model building matches db-mongodb init', () => {
  it('finds test suites to compare', () => {
    expect(
      suites.length,
      `no test/<suite>/config.ts matches RS_MONGO_SCHEMA_SUITES=${onlySuites}`,
    ).toBeGreaterThan(0)
  })

  afterAll(() => {
    console.log(
      `[rs-mongo-schema] ${JSON.stringify({ ...report, compared: report.compared.length, matched: report.matched.length })}`,
    )
  })

  for (const suite of suites) {
    it(suite, { timeout: 3600000 }, async () => {
      let config: SanitizedConfig
      try {
        const mod = await import(pathToFileURL(path.join(testDir, suite, 'config.ts')).href)
        config = await mod.default
        if (!config?.collections) {
          throw new Error('default export is not a sanitized config')
        }
      } catch (error) {
        report.failedToLoad.push({ error: String((error as Error)?.message ?? error), suite })
        // a config that cannot be loaded is not compared: that is a failure, not a pass
        throw new Error(
          `test/${suite}/config.ts failed to load: ${(error as Error)?.message ?? error}`,
        )
      }
      report.compared.push(suite)
      const failures = await runSuite(suite, config)
      ;(failures.length ? report.mismatched : report.matched).push(suite)
      expect(failures, suite).toStrictEqual([])
    })
  }

  it('synthetic configs (review items 1-4)', { timeout: 900000 }, async () => {
    const configs = await syntheticConfigs()
    for (const [name, config] of Object.entries(configs)) {
      report.compared.push(`synthetic:${name}`)
      const failures = await runSuite(`synthetic:${name}`, config)
      ;(failures.length ? report.mismatched : report.matched).push(`synthetic:${name}`)
      expect(failures, name).toStrictEqual([])
    }
    // the throwing dbName and the throwing getter were compared as errors with partial state
    expect(report.errorsMatched.some((e) => e.includes('dbName threw'))).toBe(true)
    expect(report.errorsMatched.some((e) => e.includes('index getter threw'))).toBe(true)
  })

  it('sees the upstream interleaving in user callbacks (review item 1)', async () => {
    const { interleaving } = await syntheticConfigs()
    const adapter = createAdapter(interleaving, variants[0]!)
    const build = await runBuild(adapter, initRS)
    expect(build.error).toBeUndefined()
    expect(adapter.collections.later.collection.collectionName).toBe('later_after_first')
    expect(adapter.versions.later.collection.collectionName).toBe('_later_after_first_versions')
    expect(adapter.versions.globalAfter.collection.collectionName).toBe(
      '_global_after_globals_versions',
    )
    dropConnections(build)
  })

  it('reads getters live like upstream (review item 3)', async () => {
    const { getters } = await syntheticConfigs()
    const adapter = createAdapter(getters, variants[0]!)
    const build = await runBuild(adapter, initRS)
    expect(build.error).toBeUndefined()
    // formatDefaultValue reads `defaultValue` three times: the stored default is the third read
    expect(adapter.collections.counted.schema.path('counter').defaultValue).toBe('read 3')
    // the non-enumerable `indexSortableFields` was read live (review item 4)
    expect(build.events).toContain('get payload.config.indexSortableFields -> true')
    expect(
      adapter.collections.counted.schema.indexes().some(([fields]: any) => 'sortable' in fields),
    ).toBe(true)
    dropConnections(build)
  })

  it('detects deviating candidates (negative controls)', { timeout: 900000 }, async () => {
    const { corners } = await syntheticConfigs()
    const mutants: [string, (build: Build) => void][] = [
      [
        'drop last index',
        (b) => (b.adapter.collections.corners.schema as AnyObject)._indexes.pop(),
      ],
      [
        'a copy of a shared plugin function',
        (b) => {
          // mongoose clones schema definitions; module-level functions (plugins) are kept by reference
          const plugins = (b.adapter.collections.corners.schema as AnyObject).plugins
          const entry = plugins.find((p: AnyObject) => p.fn === paginate)
          entry.fn = new Function('return ' + paginate.toString())()
        },
      ],
      [
        'swap two paths',
        (b) => {
          const paths = (b.adapter.collections.corners.schema as AnyObject).paths
          const entries = Object.entries(paths)
          ;[entries[1], entries[2]] = [entries[2]!, entries[1]!]
          for (const key of Object.keys(paths)) {
            delete paths[key]
          }
          Object.assign(paths, Object.fromEntries(entries))
        },
      ],
      [
        'a closure capturing a different value',
        (b) => {
          const choice = b.adapter.collections.corners.schema.path('choice') as AnyObject
          const make = (n: number) => () => n
          choice.validators[0].validator = b === lastTs ? make(1) : make(100)
        },
      ],
      [
        'an extra config read',
        (b) => b.events.splice(5, 0, 'get payload.config.collections -> <x>'),
      ],
      [
        'a missing mongoose call',
        (b) =>
          b.events.splice(
            b.events.findIndex((e) => e.includes('Schema.index(')),
            1,
          ),
      ],
    ]
    let lastTs: Build | undefined
    for (const [name, mutate] of mutants) {
      const variant = variants[0]!
      const tsAdapter = createAdapter(corners, variant)
      const rsAdapter = createAdapter(corners, variant)
      const shared = collectShared(sharedRoots(corners, tsAdapter, rsAdapter))
      const ts = await runBuild(tsAdapter, initTS as any)
      const rs = await runBuild(rsAdapter, initRS)
      lastTs = ts
      if (name === 'a closure capturing a different value') {
        mutate(ts)
      }
      mutate(rs)
      const ctx = compareBuilds(ts, rs, shared)

      dropConnections(ts, rs)
      expect(ctx.diffs.length, name).toBeGreaterThan(0)
      report.mutantsDetected++
    }
    // self-comparison is clean (the harness itself is deterministic) but flagged as not Rust
    const variant = variants[0]!
    const a = createAdapter(corners, variant)
    const b = createAdapter(corners, variant)
    const ts1 = await runBuild(a, initTS as any)
    const ts2 = await runBuild(b, initTS as any)
    const self = compareBuilds(ts1, ts2, collectShared(sharedRoots(corners, a, b)))
    dropConnections(ts1, ts2)
    expect(self.diffs).toStrictEqual(['the candidate build did not reach the Rust engine'])
  })

  it('compared every loadable config', () => {
    expect(report.failedToLoad).toStrictEqual([])
    expect(report.compared.length).toBeGreaterThan(2)
    expect(report.models).toBeGreaterThan(0)
    expect(report.objectsCompared).toBeGreaterThan(1000)
    expect(report.scopesCompared).toBeGreaterThan(0)
  })
})
