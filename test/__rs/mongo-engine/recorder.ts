/**
 * Records the data methods of `@payloadcms/db-mongodb` during upstream int runs (TS engine) for
 * the Rust replay in crates/payload-mongo-engine/tests/replay.rs.
 *
 * One *call* = one adapter data method call (`find`, `create`, ...): its arguments without `req`
 * and the call context exactly as packages/engine-rs/src/mongo-adapter/index.ts sends them
 * (`withoutReq`, `callContextJson`), the session upstream's
 * `getSession` resolves, every mongoose model call the method makes (`ops`, in call order, with
 * arguments / chain / `useCustomCountFn` call / result or thrown error) in exactly the request
 * shape of MONGO_ENGINE_CONTRACT.md "Host ops", the result or error, and the caller's
 * `data` / `versionData` after the call (upstream mutates it).
 *
 * Values use the typed tree encoding (MONGO_ENGINE_CONTRACT.md "Values"). Objects that are not
 * plain data (sessions, mongoose documents, other BSON types) are `{ $hostObject: n }` with ids per
 * call (1, 2, ...), like the host's per-call table.
 *
 * Output (PAYLOAD_RS_MONGO_ENGINE_RECORD_DIR): `<label>-<pid>/config-<n>.json` per adapter
 * (`{ graph, options }`, the `MongoEngine.create` input) and `<label>-<pid>/calls.ndjson`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { buildMongoEngineInput } from '../../../packages/engine-rs/src/mongo-adapter/index.js'
import { createFunctionRegistry } from '../../../packages/engine-rs/src/serialize.js'

type AnyObject = Record<PropertyKey, any>

type ModelRef = { kind: string; slug?: string }

type Op = {
  args?: unknown
  chain?: unknown[]
  error?: unknown
  fnOptions?: { arg: number; call: Op; key: string }[]
  method: string
  model?: ModelRef
  op: string
  post?: string
  result?: unknown
}

type CallRecord = {
  args: unknown
  config: number
  /** config functions the engine calls through `callFunction` (`join.getForeignPath`) */
  fnCalls?: { arg: unknown; id: number; result: unknown }[]
  context: unknown
  dataAfter?: unknown
  error?: unknown
  method: string
  mutatedKey?: string
  ops: Op[]
  result?: unknown
  session: unknown
}

type Store = {
  call: CallRecord
  /** the paginate op whose `useCustomCountFn` is running */
  fnOptionOf?: Op
  hostObjects: Map<object, number>
  /** inside a model call (mongoose-internal model calls are not recorded) */
  inModel: boolean
}

const als = new AsyncLocalStorage<Store>()

const recordDir = process.env.PAYLOAD_RS_MONGO_ENGINE_RECORD_DIR
export const isRecording = Boolean(recordDir)

const MAX_CALL_BYTES = Number(process.env.PAYLOAD_RS_MONGO_ENGINE_MAX_CALL_BYTES || 200_000)
const MAX_CALLS_PER_METHOD = Number(process.env.PAYLOAD_RS_MONGO_ENGINE_MAX_CALLS_PER_METHOD || 400)

export const dataMethods = [
  'count',
  'countGlobalVersions',
  'countVersions',
  'create',
  'createGlobal',
  'createGlobalVersion',
  'createVersion',
  'deleteMany',
  'deleteOne',
  'deleteVersions',
  'find',
  'findDistinct',
  'findGlobal',
  'findGlobalVersions',
  'findOne',
  'findVersions',
  'queryDrafts',
  'updateGlobal',
  'updateGlobalVersion',
  'updateJobs',
  'updateMany',
  'updateOne',
  'updateVersion',
  'upsert',
]

const versionDataMethods = new Set([
  'createGlobalVersion',
  'createVersion',
  'updateGlobalVersion',
  'updateVersion',
])

const reservedKeys = new Set([
  '$bigint',
  '$binary',
  '$buffer',
  '$date',
  '$decimal',
  '$fn',
  '$hostObject',
  '$num',
  '$obj',
  '$oid',
  '$ref',
  '$regex',
  '$undefined',
])

const hostObject = (store: Store | undefined, value: object) => {
  if (!store) {
    return { $hostObject: 0 }
  }
  let id = store.hostObjects.get(value)
  if (id === undefined) {
    id = store.hostObjects.size + 1
    store.hostObjects.set(value, id)
  }
  return { $hostObject: id }
}

/** Typed tree encoding (as `encode_value` writes it). */
export const encode = (value: unknown, store = als.getStore(), seen: object[] = []): unknown => {
  switch (typeof value) {
    case 'bigint':
      return { $bigint: value.toString() }
    case 'function':
    case 'symbol':
      return hostObject(store, value as object)
    case 'number':
      if (!Number.isFinite(value)) {
        return { $num: String(value) }
      }
      return Object.is(value, -0) ? { $num: '-0' } : value
    case 'object': {
      if (value === null) {
        return null
      }
      if (value instanceof Date) {
        return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() }
      }
      if (value instanceof RegExp) {
        return { $regex: { source: value.source, flags: value.flags } }
      }
      const bsonType = (value as AnyObject)._bsontype
      if (typeof bsonType === 'string') {
        switch (bsonType) {
          case 'Binary': {
            const binary = value as AnyObject
            const bytes: Uint8Array = binary.buffer.subarray(0, binary.position)
            return {
              $binary: {
                base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
                  'base64',
                ),
                subType: binary.sub_type,
              },
            }
          }
          case 'Decimal128':
            return { $decimal: String(value) }
          case 'ObjectId':
            return { $oid: (value as AnyObject).toHexString() }
          default:
            return hostObject(store, value)
        }
      }
      if (value instanceof Uint8Array) {
        return {
          $buffer: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
        }
      }
      if (seen.includes(value)) {
        throw new Error('recorder: circular value')
      }
      if (Array.isArray(value)) {
        return Array.from(value, (item) => encode(item, store, [...seen, value]))
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        return hostObject(store, value)
      }
      const out: AnyObject = {}
      const keys = Object.keys(value)
      for (const key of keys) {
        out[key] = encode((value as AnyObject)[key], store, [...seen, value])
      }
      return keys.length === 1 && reservedKeys.has(keys[0]!) ? { $obj: out } : out
    }
    case 'undefined':
      return { $undefined: true }
    default:
      return value
  }
}

/** `{ handle, isObject, name?, message?, code?, keyValue? }` of a thrown value (host.ts
 * `describeHostError`: a key is present iff it is `in` the value). */
const encodeThrown = (store: Store, error: unknown) => {
  const isObject = typeof error === 'object' && error !== null
  const out: AnyObject = {
    handle: (hostObject(store, isObject ? (error as object) : { error }) as AnyObject).$hostObject,
    isObject,
  }
  if (isObject) {
    for (const key of ['name', 'message', 'code', 'keyValue']) {
      if (key in error) {
        out[key] = encode((error as AnyObject)[key], store)
      }
    }
  }
  return out
}

/** The method error: `{ rethrow: n }` for a value a model call threw, else its description. */
const encodeMethodError = (store: Store, error: unknown) => {
  if (typeof error === 'object' && error !== null && store.hostObjects.has(error)) {
    return { rethrow: store.hostObjects.get(error) }
  }
  const e = error as AnyObject
  const out: AnyObject = { message: String(e?.message), name: String(e?.name) }
  if (e?.name === 'ValidationError' && e?.data) {
    out.data = encode(
      {
        ...e.data,
        errors: (e.data.errors ?? []).map(({ message: _m, ...rest }: AnyObject) => rest),
      },
      store,
    )
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// output

const callCounts = new Map<string, number>()
const writtenCalls = new Set<string>()
let outDir: string | undefined
const configIndexes = new WeakMap<object, number>()
let nextConfigIndex = 0

const output = () => {
  if (!outDir) {
    const label = (process.env.PAYLOAD_RS_MONGO_ENGINE_LABEL || 'run').replace(/[^\w.-]+/g, '_')
    outDir = path.join(recordDir!, `${label}-${process.pid}`)
    fs.mkdirSync(outDir, { recursive: true })
  }
  return outDir
}

const writeConfig = (adapter: AnyObject): number => {
  const existing = configIndexes.get(adapter)
  if (existing !== undefined) {
    return existing
  }
  const index = nextConfigIndex++
  configIndexes.set(adapter, index)
  const wrappers = wrapForeignPaths(adapter.payload.config)
  const registry = createFunctionRegistry()
  const { graphJson, optionsJson } = buildMongoEngineInput({ adapter, registry })
  for (const wrapper of wrappers) {
    wrapper.__rsFunctionID = registry.functions.indexOf(wrapper)
  }
  fs.writeFileSync(
    path.join(output(), `config-${index}.json`),
    `{"options":${optionsJson},"tz":${JSON.stringify(process.env.TZ ?? null)},"graph":${graphJson}}`,
  )
  return index
}

/** Wraps `join.getForeignPath` of every collection (called by the engine through `callFunction`):
 * calls are recorded with the function's registry id in the serialized graph. */
const wrapForeignPaths = (config: AnyObject) => {
  const wrappers: AnyObject[] = []
  for (const collection of config.collections ?? []) {
    for (const joins of Object.values(collection.joins ?? {}) as AnyObject[][]) {
      for (const join of joins) {
        const original = join.getForeignPath
        if (typeof original !== 'function') {
          continue
        }
        if (original.__rsRecorded) {
          wrappers.push(original)
          continue
        }
        const wrapped: AnyObject = function (this: unknown, arg: unknown) {
          const result = original.call(this, arg)
          const store = als.getStore()
          if (store && typeof wrapped.__rsFunctionID === 'number') {
            store.call.fnCalls = [
              ...(store.call.fnCalls ?? []),
              { arg: encode(arg, store), id: wrapped.__rsFunctionID, result: encode(result, store) },
            ]
          }
          return result
        }
        wrapped.__rsRecorded = true
        join.getForeignPath = wrapped
        wrappers.push(wrapped)
      }
    }
  }
  return wrappers
}

const writeCall = (call: CallRecord) => {
  const count = callCounts.get(call.method) ?? 0
  if (count >= MAX_CALLS_PER_METHOD) {
    return
  }
  let line: string
  try {
    line = JSON.stringify(call)
  } catch {
    return
  }
  const key = createHash('sha1').update(line).digest('hex')
  if (writtenCalls.has(key)) {
    return
  }
  writtenCalls.add(key)
  if (line.length > MAX_CALL_BYTES) {
    fs.appendFileSync(
      path.join(output(), 'skipped.ndjson'),
      `${JSON.stringify({ bytes: line.length, method: call.method })}\n`,
    )
    return
  }
  callCounts.set(call.method, count + 1)
  fs.appendFileSync(path.join(output(), 'calls.ndjson'), `${line}\n`)
}

// ---------------------------------------------------------------------------------------------
// calls

const modelNames = (models: AnyObject | undefined) => {
  const out: AnyObject = {}
  for (const [slug, model] of Object.entries(models ?? {})) {
    const name = (model as AnyObject)?.collection?.name
    if (typeof name === 'string') {
      out[slug] = name
    }
  }
  return out
}

/** `withoutReq` of packages/engine-rs/src/mongo-adapter/index.ts */
const withoutReq = (args: AnyObject | undefined): unknown => {
  if (typeof args !== 'object' || args === null || !('req' in args)) {
    return args
  }
  const { req: _req, ...rest } = args
  return rest
}

/** The session upstream's `getSession(adapter, req)` resolves (without its side effects). */
const sessionOf = async (adapter: AnyObject, req: AnyObject | undefined) => {
  if (!req) {
    return undefined
  }
  let transactionID = req.transactionID
  if (transactionID instanceof Promise) {
    transactionID = await transactionID
  }
  if (!transactionID) {
    return undefined
  }
  const session = adapter.sessions?.[transactionID]
  if (session && !session.inTransaction()) {
    return undefined
  }
  return session
}

/** Wraps the data methods of `adapter` (after `init`). */
export const recordAdapter = (adapter: AnyObject) => {
  if (!isRecording || adapter.__rsMongoEngineRecorded) {
    return
  }
  adapter.__rsMongoEngineRecorded = true
  for (const method of dataMethods) {
    const original = adapter[method]
    if (typeof original !== 'function') {
      continue
    }
    adapter[method] = async function (this: AnyObject, args: AnyObject) {
      // models rebuilt after init (re-`init`, `migrateFresh`, tests replacing them) get recorded too
      recordModels(this, 'collections')
      recordModels(this, 'versions')
      if (this.globals) {
        this.globals = recordModel(this.globals, { kind: 'globals' })
      }
      const parent = als.getStore()
      if (parent && parent.inModel) {
        return original.call(this, args)
      }
      const store: Store = {
        call: undefined as never,
        hostObjects: new Map(),
        inModel: false,
      }
      const session = await sessionOf(this, args?.req)
      const mutatedKey = versionDataMethods.has(method) ? 'versionData' : 'data'
      const record: CallRecord = {
        args: encode(withoutReq(args), store),
        config: writeConfig(this),
        // `callContextJson` of packages/engine-rs/src/mongo-adapter/index.ts
        context: {
          adapter: encode(
            {
              allowAdditionalKeys: this.allowAdditionalKeys,
              allowIDOnCreate: this.allowIDOnCreate,
              collation: this.collation,
              disableFallbackSort: this.disableFallbackSort,
              disableIndexHints: this.disableIndexHints,
              useBigIntForNumberIDs: this.useBigIntForNumberIDs,
              useJoinAggregations: this.useJoinAggregations,
              usePipelineInSortLookup: this.usePipelineInSortLookup,
            },
            store,
          ),
          hasReq: Boolean(args?.req),
          models: {
            collections: modelNames(this.collections),
            versions: modelNames(this.versions),
          },
          now: Date.now(),
          withMutations: true,
        },
        method,
        ops: [],
        session: session ? hostObject(store, session) : { $undefined: true },
      }
      store.call = record
      // a nested data method (upsert -> this.updateOne) is an `adapterCall` op of the parent
      const parentOp: Op | undefined = parent
        ? {
            args: encode(withoutReq(args), parent),
            method,
            op: 'adapterCall',
          }
        : undefined
      if (parentOp && parent) {
        parent.call.ops.push(parentOp)
      }
      const finish = () => {
        if (args && typeof args === 'object' && mutatedKey in args) {
          record.mutatedKey = mutatedKey
          try {
            record.dataAfter = encode(args[mutatedKey], store)
          } catch {
            record.dataAfter = { unencodable: true }
          }
        }
      }
      try {
        const result = await als.run(store, () => original.call(this, args))
        record.result = encode(result, store)
        finish()
        if (parentOp && parent) {
          parentOp.result = encode(result, parent)
        }
        writeCall(record)
        return result
      } catch (error) {
        record.error = encodeMethodError(store, error)
        finish()
        if (parentOp && parent) {
          parentOp.error = encodeThrown(parent, error)
        }
        writeCall(record)
        throw error
      }
    }
  }
  recordModels(adapter, 'collections')
  recordModels(adapter, 'versions')
  if (adapter.globals) {
    adapter.globals = recordModel(adapter.globals, { kind: 'globals' })
  }
}

// ---------------------------------------------------------------------------------------------
// mongoose models

const modelMethods = new Set([
  'aggregate',
  'countDocuments',
  'create',
  'deleteMany',
  'deleteOne',
  'distinct',
  'estimatedDocumentCount',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndUpdate',
  'paginate',
  'updateMany',
  'updateOne',
])

const chainMethods = ['lean', 'select', 'sort', 'limit', 'skip', 'collation', 'session']

const proxies = new WeakMap<object, object>()
const proxyTargets = new WeakSet<object>()

const recordModel = (model: AnyObject | undefined, ref: ModelRef) => {
  if (!model) {
    return model
  }
  const cached = proxies.get(model)
  if (cached) {
    return cached
  }
  if (proxyTargets.has(model)) {
    return model
  }
  const proxy = new Proxy(model, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof prop !== 'string' || !modelMethods.has(prop) || typeof value !== 'function') {
        return value
      }
      return (...args: unknown[]) => {
        const store = als.getStore()
        if (!store || store.inModel) {
          // mongoose-internal model calls; `useCustomCountFn`'s count is the fn option
          if (store?.fnOptionOf) {
            const owner = store.fnOptionOf
            store.fnOptionOf = undefined
            owner.fnOptions = [
              {
                arg: 1,
                call: { args: encode(args, store), method: prop, model: ref, op: 'model' },
                key: 'useCustomCountFn',
              },
            ]
          }
          return value.apply(target, args)
        }
        const op: Op = { method: prop, model: ref, op: 'model' }
        if (prop === 'paginate') {
          const options = args[1] as AnyObject | undefined
          const customCount = options?.useCustomCountFn
          op.args = encode(
            [
              args[0],
              options &&
                Object.fromEntries(
                  Object.entries(options).map(([k, v]) =>
                    k === 'useCustomCountFn' ? [k, undefined] : [k, v],
                  ),
                ),
            ],
            store,
          )
          if (typeof customCount === 'function') {
            options!.useCustomCountFn = function (this: unknown, ...fnArgs: unknown[]) {
              const inner = als.getStore()
              if (inner) {
                inner.fnOptionOf = op
              }
              return customCount.apply(this, fnArgs)
            }
          }
        } else {
          op.args = encode(args, store)
        }
        if (prop === 'create') {
          op.post = 'toObject'
        }
        store.call.ops.push(op)
        const inner: Store = { ...store, inModel: true }
        const settle = (promise: PromiseLike<unknown>) =>
          Promise.resolve(promise).then(
            (result) => {
              // hydrated documents cross as `doc.toObject()` (`post: 'toObject'`, the engine asks
              // for it where upstream reads properties of hydrated documents)
              const isDocument = (doc: unknown) =>
                typeof doc === 'object' &&
                doc !== null &&
                typeof (doc as AnyObject).toObject === 'function' &&
                '$__' in (doc as AnyObject)
              let plain = result
              if (Array.isArray(result) && result.some(isDocument)) {
                op.post = 'toObject'
                plain = result.map((doc) => (isDocument(doc) ? (doc as AnyObject).toObject() : doc))
              } else if (isDocument(result)) {
                op.post = 'toObject'
                plain = (result as AnyObject).toObject()
              }
              op.result = encode(plain, store)
              return result
            },
            (error) => {
              op.error = encodeThrown(store, error)
              throw error
            },
          )
        let returned: any
        try {
          returned = als.run(inner, () => value.apply(target, args))
        } catch (error) {
          op.error = encodeThrown(store, error)
          throw error
        }
        if (prop === 'paginate' || prop === 'create') {
          return settle(returned)
        }
        const query = returned as AnyObject
        for (const name of chainMethods) {
          const original = query[name]
          if (typeof original === 'function') {
            query[name] = (...chainArgs: unknown[]) => {
              op.chain = [...(op.chain ?? []), [name, encode(chainArgs, store)]]
              return original.apply(query, chainArgs)
            }
          }
        }
        const originalExec = query.exec
        query.exec = (...execArgs: unknown[]) =>
          settle(als.run(inner, () => originalExec.apply(query, execArgs)))
        return query
      }
    },
  })
  proxies.set(model, proxy)
  proxyTargets.add(proxy)
  return proxy
}

const recordModels = (adapter: AnyObject, kind: 'collections' | 'versions') => {
  const models = adapter[kind]
  if (!models) {
    return
  }
  for (const slug of Object.keys(models)) {
    models[slug] = recordModel(models[slug], { kind, slug })
  }
}
