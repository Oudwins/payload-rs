/**
 * TS stand-in for the native `MongoEngine`, enabled with `PAYLOAD_RS_MONGO_LOOPBACK=true`.
 *
 * It speaks the engine's side of the wire format (MONGO_ENGINE_CONTRACT.md): `call` decodes the
 * `argsJson` tree, runs the upstream `@payloadcms/db-mongodb` method on a view of the adapter
 * whose mongoose models are stand-ins, and every database call those make becomes a host op
 * (`model`, `getSession`, `adapterCall`) answered by the TS host executor on the real models.
 * The result is the tree encoding with the argument mutations upstream made. Running the upstream
 * suites through it verifies the TS glue (argument encoding, host executor, sessions, typed values
 * both ways, mutations, error reconstruction) independently of the Rust data methods.
 *
 * Differences to the native engine, glue-irrelevant: `getSession` runs before the upstream method
 * (not where upstream awaits it); relationship subqueries of `buildSearchParams` and the
 * `Model.buildQuery` static run in-process on the real models (`payload.db`).
 */
import type { BsonBoundary, FunctionRegistry } from '../serialize.js'
import type { HostOpRequest, ModelOpRequest, ModelRef } from './host.js'
import type { NativeMongoEngine } from './native.js'

import { deserializeFromEngine } from '../serialize.js'
import { encodeMongoTree, getBsonClasses } from './codec.js'
import { describeMongoError } from './errors.js'

type AnyObject = Record<PropertyKey, any>

type RawModelRequest = {
  args: unknown[]
  chain: [string, unknown[]][]
  method: string
  model: ModelRef
  post?: 'toObject'
}

/** A host object handle on the engine side; as a session it is always in its transaction. */
class HostRef {
  constructor(readonly id: number) {}
  inTransaction() {
    return true
  }
}

/** Set while a function argument runs to learn which model query it makes (`fnOptions`). */
let capture: { query?: object } | undefined

const rawRequests = new WeakMap<object, RawModelRequest>()

const isPlainObject = (value: unknown): value is AnyObject => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export const createLoopbackMongoEngine = ({
  adapter,
  methods,
  registry,
}: {
  adapter: AnyObject
  methods: Record<string, (this: unknown, args: unknown) => Promise<unknown>>
  registry: FunctionRegistry
}): NativeMongoEngine => ({
  call: async (method, argsJson, contextJson, host) => {
    const upstream = methods[method]
    if (!upstream) {
      throw new Error(JSON.stringify({ name: 'Error', message: `Unknown engine method ${method}` }))
    }
    const context = JSON.parse(contextJson) as {
      hasReq: boolean
      models: { collections: Record<string, string>; versions: Record<string, string> }
    }
    const refs = new Map<number, HostRef>()
    const boundary: BsonBoundary = {
      classes: getBsonClasses(adapter),
      hostObject: (id) => {
        let ref = refs.get(id)
        if (!ref) {
          ref = new HostRef(id)
          refs.set(id, ref)
        }
        return ref
      },
      hostObjectID: (value) => (value instanceof HostRef ? value.id : undefined),
    }
    const errorHandles = new WeakMap<object, number>()
    const encode = (value: unknown) =>
      encodeMongoTree({ hostObjectID: boundary.hostObjectID, registry, value })
    const decode = (tree: unknown) => deserializeFromEngine(tree, registry, boundary)

    const encodeRequest = (raw: RawModelRequest): ModelOpRequest => {
      // function-valued options (`useCustomCountFn`) cross as `fnOptions`: the key stays in place
      // as `undefined`, the host assigns the function
      const fnOptions: { arg: number; call: ModelOpRequest; key: string }[] = []
      const args = raw.args.map((arg, index) => {
        if (!isPlainObject(arg) || !Object.values(arg).some((v) => typeof v === 'function')) {
          return arg
        }
        const copy: AnyObject = {}
        for (const key of Object.keys(arg)) {
          if (typeof arg[key] === 'function') {
            fnOptions.push({ arg: index, call: encodeRequest(captureModelQuery(arg[key])), key })
            copy[key] = undefined
          } else {
            copy[key] = arg[key]
          }
        }
        return copy
      })
      return {
        args: encode(args) as unknown[],
        ...(raw.chain.length
          ? { chain: raw.chain.map(([name, chainArgs]) => [name, encode(chainArgs) as unknown[]]) }
          : {}),
        ...(fnOptions.length ? { fnOptions } : {}),
        method: raw.method,
        model: raw.model,
        op: 'model',
        ...(raw.post ? { post: raw.post } : {}),
      }
    }

    const hostOp = async (request: HostOpRequest): Promise<unknown> => {
      let response: string
      try {
        response = await host(JSON.stringify(request))
      } catch (error) {
        const { handle, isObject, ...details } = (
          JSON.parse((error as Error).message) as {
            error: { handle: number; isObject: boolean } & Record<string, unknown>
          }
        ).error
        // what upstream `handleError` reads of the thrown value; rethrown by handle otherwise
        const thrown: AnyObject = isObject ? {} : new HostRef(handle)
        for (const [key, value] of Object.entries(details)) {
          thrown[key] = decode(value)
        }
        errorHandles.set(thrown, handle)
        throw thrown
      }
      return decode((JSON.parse(response) as { ok: unknown }).ok)
    }

    const runModelRequest = async (raw: RawModelRequest) => {
      const result = await hostOp(encodeRequest(raw))
      if (raw.post === 'toObject') {
        for (const doc of Array.isArray(result) ? result : [result]) {
          Object.defineProperty(doc, 'toObject', { configurable: true, value: returnThis })
        }
      }
      return result
    }

    // upstream methods call other data methods through the adapter (`upsert`: `this.updateOne`)
    const adapterCall = (name: string) => (methodArgs: AnyObject) => {
      const { req: _req, ...rest } = methodArgs ?? {}
      // values upstream passes through from its own args are the caller's objects
      const fromCallArgs = Object.keys(rest).filter(
        (key) => typeof rest[key] === 'object' && rest[key] !== null && rest[key] === args?.[key],
      )
      return hostOp({
        args: encode(rest),
        ...(fromCallArgs.length ? { fromCallArgs } : {}),
        method: name,
        op: 'adapterCall',
      })
    }

    const args = decode(JSON.parse(argsJson)) as AnyObject
    const view = createAdapterView({
      adapter,
      adapterCall,
      collectionNames: context.models,
      methods,
      runModelRequest,
    })
    const session = context.hasReq ? await hostOp({ op: 'getSession' }) : undefined
    const sessionKey = 'loopback-session'
    view.sessions = session ? { [sessionKey]: session } : {}
    // what `getSession` / `handleError` read of `req`
    const req = context.hasReq
      ? {
          payload: { config: { localization: adapter.payload.config.localization } },
          transactionID: session ? sessionKey : undefined,
        }
      : undefined
    const callArgs = req ? { ...args, req } : args

    const before = snapshotArgs(args)
    let result: unknown
    try {
      result = await upstream.call(view, callArgs)
    } catch (error) {
      const mutations = diffArgs({ args, before, encode })
      const handle =
        typeof error === 'object' && error !== null ? errorHandles.get(error) : undefined
      if (handle !== undefined) {
        throw new Error(JSON.stringify({ mutations, rethrow: handle }))
      }
      const described = describeMongoError({ encode, error }) ?? {
        name: 'Error',
        message: String(error),
      }
      throw new Error(JSON.stringify({ ...described, mutations }))
    }
    const mutations = diffArgs({ args, before, encode })
    return JSON.stringify({ mutations, result: encode(result) })
  },
  schemaDescription: () => 'null',
})

function returnThis(this: unknown) {
  return this
}

/** Runs `fn` (upstream's `() => Promise.resolve(Model.countDocuments(...))`) to capture its query. */
const captureModelQuery = (fn: Function): RawModelRequest => {
  const previous = capture
  const current: { query?: object } = {}
  capture = current
  try {
    fn()
  } finally {
    capture = previous
  }
  const raw = current.query && rawRequests.get(current.query)
  if (!raw) {
    throw new Error('Loopback MongoEngine: a function argument made no model query')
  }
  return raw
}

const createPendingQuery = (
  raw: RawModelRequest,
  execute: (raw: RawModelRequest) => Promise<unknown>,
): object => {
  let promise: Promise<unknown> | undefined
  const run = () => (promise ??= execute(raw))
  const proxy: object = new Proxy(
    {},
    {
      get: (_target, prop) => {
        switch (prop) {
          case 'catch':
            return (onRejected: (reason: unknown) => unknown) => run().catch(onRejected)
          case 'exec':
            return () => run()
          case 'finally':
            return (onFinally: () => void) => run().finally(onFinally)
          case 'then':
            // a capture: `Promise.resolve(query)` must not run it
            return capture
              ? undefined
              : (
                  onFulfilled: (value: unknown) => unknown,
                  onRejected: (reason: unknown) => unknown,
                ) => run().then(onFulfilled, onRejected)
        }
        if (typeof prop === 'symbol') {
          return undefined
        }
        return (...chainArgs: unknown[]) => {
          raw.chain.push([prop, chainArgs])
          return proxy
        }
      },
    },
  )
  rawRequests.set(proxy, raw)
  if (capture) {
    capture.query = proxy
  }
  return proxy
}

const createModelStandIn = ({
  adapter,
  collectionName,
  model,
  runModelRequest,
}: {
  adapter: AnyObject
  collectionName: string
  model: ModelRef
  runModelRequest: (raw: RawModelRequest) => Promise<unknown>
}) =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        switch (prop) {
          case 'buildQuery': {
            // the schema static (`parseParams`), ported to Rust: runs in-process here
            const real =
              model.kind === 'globals' ? adapter.globals : adapter[model.kind][model.slug!]
            return real.buildQuery.bind(real)
          }
          case 'collection':
            return { name: collectionName }
          case 'then':
            return undefined
        }
        if (typeof prop === 'symbol') {
          return undefined
        }
        return (...args: unknown[]) =>
          createPendingQuery(
            {
              args,
              chain: [],
              method: prop,
              model,
              ...(prop === 'create' ? { post: 'toObject' as const } : {}),
            },
            runModelRequest,
          )
      },
    },
  )

/**
 * The adapter as the upstream methods see it: the real adapter as prototype, the models replaced
 * by stand-ins (collection names from the call context) and the data methods by `adapterCall`
 * host ops.
 */
const createAdapterView = ({
  adapter,
  adapterCall,
  collectionNames,
  methods,
  runModelRequest,
}: {
  adapter: AnyObject
  adapterCall: (method: string) => (args: AnyObject) => Promise<unknown>
  collectionNames: { collections: Record<string, string>; versions: Record<string, string> }
  methods: Record<string, unknown>
  runModelRequest: (raw: RawModelRequest) => Promise<unknown>
}): AnyObject => {
  const standIns = (kind: 'collections' | 'versions') => {
    const out: AnyObject = {}
    for (const [slug, collectionName] of Object.entries(collectionNames[kind])) {
      out[slug] = createModelStandIn({
        adapter,
        collectionName,
        model: { kind, slug },
        runModelRequest,
      })
    }
    return out
  }
  const view = Object.create(adapter) as AnyObject
  for (const method of Object.keys(methods)) {
    view[method] = adapterCall(method)
  }
  view.collections = standIns('collections')
  view.versions = standIns('versions')
  view.globals = adapter.globals
    ? createModelStandIn({
        adapter,
        collectionName: adapter.globals.collection?.name,
        model: { kind: 'globals' },
        runModelRequest,
      })
    : adapter.globals
  return view
}

const snapshotArgs = (args: AnyObject) => {
  const snapshot = new Map<string, string>()
  if (typeof args !== 'object' || args === null) {
    return snapshot
  }
  for (const key of Object.keys(args)) {
    if (key !== 'req') {
      snapshot.set(key, snapshotOf(args[key]))
    }
  }
  return snapshot
}

const snapshotRegistry: FunctionRegistry = { functions: [] }

const snapshotOf = (value: unknown) =>
  JSON.stringify(
    encodeMongoTree({
      hostObjectID: (v) => (v instanceof HostRef ? v.id : undefined),
      onFunction: () => '$function',
      registry: snapshotRegistry,
      value,
    }),
  )

/** `[path, tree]` for every top-level argument upstream changed (`applyMutations` in index.ts). */
const diffArgs = ({
  args,
  before,
  encode,
}: {
  args: AnyObject
  before: Map<string, string>
  encode: (value: unknown) => unknown
}): [string[], unknown][] => {
  const mutations: [string[], unknown][] = []
  if (typeof args !== 'object' || args === null) {
    return mutations
  }
  for (const key of Object.keys(args)) {
    if (key !== 'req' && before.get(key) !== snapshotOf(args[key])) {
      mutations.push([[key], encode(args[key])])
    }
  }
  return mutations
}
