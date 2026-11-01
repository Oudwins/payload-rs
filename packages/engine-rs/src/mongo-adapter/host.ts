/**
 * The host side of `MongoEngine.call` (MONGO_ENGINE_CONTRACT.md "Host ops"; the Rust side is
 * crates/payload-mongo-engine/src/host.rs): runs the database calls the engine asks for on the
 * adapter's real mongoose models, on the JS thread.
 *
 * Requests (JSON; values in the tree encoding the engine emits):
 * - `{ op: 'model', model, method, args, chain?, post?, fnOptions? }`: `model` is resolved when the
 *   op runs (`adapter.collections[slug]` / `adapter.versions[slug]` / `adapter.globals`), so user
 *   replacements and spies apply like upstream; `Model[method](...args)`, then every
 *   `[name, args]` of `chain` (`lean`, `select`, ...), awaited once. `post: 'toObject'` maps the
 *   hydrated result documents through `doc.toObject()`. `fnOptions: [{ arg, key, call }]` assigns
 *   `args[arg][key] = () => Promise.resolve(<call's query, not awaited>)` after decoding (upstream's
 *   `useCustomCountFn`, assigned after the other options); functions never cross in-band.
 * - `{ op: 'getSession' }`: upstream `getSession(adapter, req)` on the call's original `req`.
 * - `{ op: 'modelInfo', model }`: `{ collectionName, modelName }` of the model at op time.
 * - `{ op: 'adapterCall', method, args, fromCallArgs? }`: `adapter[method]({ ...args, req })`
 *   through the adapter object (user overrides apply), `req` = the call's original `req` (own key,
 *   also `undefined`); keys listed in `fromCallArgs` are taken from the call's original args (same
 *   objects, so the inner call's mutations land on the caller's), in `args` key order.
 * - `{ op: 'logError', msg }`: `adapter.payload.logger.error(msg)`.
 *
 * Answers: the op's promise resolves with `{"ok": <tree>}` (the result; host values the engine has
 * no representation for are `{ $hostObject: n }`) or rejects with an `Error` whose message is
 * `{"error": { handle, isObject, name?, message?, code?, keyValue? }}`: `handle` is the host object
 * id of the thrown value (rethrowing it rethrows that value), `isObject` =
 * `typeof error === 'object' && error !== null`, and each of `name` / `message` / `code` /
 * `keyValue` is present (as a tree) when that property is `in` the error (what upstream
 * `handleError` reads). Rejection keeps upstream's `Promise.all` timing.
 */
import type { FunctionRegistry } from '../serialize.js'
import type { BsonClasses, HostObjects } from './codec.js'

import { deserializeFromEngine } from '../serialize.js'
import { addHostObject, createArgsBoundary, createResultBoundary, encodeMongoTree } from './codec.js'

type AnyObject = Record<PropertyKey, any>

export type ModelRef = { kind: 'collections' | 'globals' | 'versions'; slug?: string }

export type ModelOpRequest = {
  args?: unknown[]
  chain?: [string, unknown[]][]
  fnOptions?: { arg: number; call: ModelOpRequest; key: string }[]
  method: string
  model: ModelRef
  op: 'model'
  post?: 'toObject'
}

export type HostOpRequest =
  | { args: unknown; fromCallArgs?: string[]; method: string; op: 'adapterCall' }
  | { model: ModelRef; op: 'modelInfo' }
  | { msg: string; op: 'logError' }
  | { op: 'getSession' }
  | ModelOpRequest

/** Host ops run in this process, per op name. */
export const hostOpStats: Record<string, number> = {}

/** Cumulative milliseconds (see `getRustMongoEngineStats`). */
export const hostTimings = {
  argsEncode: 0,
  callWall: 0,
  /** Host op request decoding + result encoding (synchronous parts). */
  hostCodec: 0,
  /** Host op wall time (decode, database call, encode). */
  hostWall: 0,
  resultDecode: 0,
}

export const createHostExecutor = ({
  adapter,
  args: callArgs,
  classes,
  hostObjects,
  registry,
}: {
  adapter: AnyObject
  /** The caller's original arguments (`req` for `getSession` / `adapterCall`). */
  args: unknown
  classes: BsonClasses
  hostObjects: HostObjects
  registry: FunctionRegistry
}): ((opJson: string) => Promise<string>) => {
  const argsBoundary = createArgsBoundary({ classes, hostObjects })
  const resultBoundary = createResultBoundary({ classes, hostObjects })
  const decode = (tree: unknown) => deserializeFromEngine(tree, registry, argsBoundary)
  const encode = (value: unknown) =>
    JSON.stringify(encodeMongoTree({ hostObjectID: resultBoundary.hostObjectID, registry, value }))
  const req =
    typeof callArgs === 'object' && callArgs !== null ? (callArgs as AnyObject).req : undefined

  const buildModelQuery = (request: ModelOpRequest): any => {
    const Model = resolveModel({ adapter, model: request.model })
    const args = decode(request.args ?? []) as AnyObject[]
    for (const { arg, call, key } of request.fnOptions ?? []) {
      args[arg]![key] = () => Promise.resolve(buildModelQuery(call))
    }
    let query = Model[request.method](...args)
    for (const [name, chainArgs] of request.chain ?? []) {
      query = query[name](...(decode(chainArgs) as unknown[]))
    }
    return query
  }

  const run = async (request: HostOpRequest): Promise<unknown> => {
    switch (request.op) {
      case 'adapterCall': {
        const args = decode(request.args) as AnyObject
        // `fromCallArgs` keys are the caller's own objects (upstream `upsert` passes its `data` /
        // `where` to `this.updateOne`, whose mutations land on them); `req` as an own key, like
        // upstream's object literal
        const fromCallArgs = new Set(request.fromCallArgs ?? [])
        const forwarded: AnyObject = {}
        for (const key of Object.keys(args)) {
          forwarded[key] = fromCallArgs.has(key) ? (callArgs as AnyObject)?.[key] : args[key]
        }
        forwarded.req = req
        return adapter[request.method](forwarded)
      }
      case 'getSession':
        return getSession(adapter, req)
      case 'logError':
        return adapter.payload.logger.error(request.msg)
      case 'model': {
        const result = await buildModelQuery(request)
        if (request.post === 'toObject') {
          return Array.isArray(result) ? result.map((doc) => doc.toObject()) : result.toObject()
        }
        return result
      }
      case 'modelInfo': {
        const Model = resolveModel({ adapter, model: request.model })
        return { collectionName: Model.collection.name, modelName: Model.modelName }
      }
      default:
        throw new Error(`Unknown host op ${JSON.stringify((request as AnyObject).op)}`)
    }
  }

  return async (opJson) => {
    const start = performance.now()
    let encoded: string
    try {
      const request = JSON.parse(opJson) as HostOpRequest
      hostOpStats[request.op] = (hostOpStats[request.op] ?? 0) + 1
      const value = await run(request)
      const encodeStart = performance.now()
      encoded = encode(value)
      hostTimings.hostCodec += performance.now() - encodeStart
    } catch (error) {
      throw new Error(describeHostError({ encode, error, hostObjects }))
    } finally {
      hostTimings.hostWall += performance.now() - start
    }
    return `{"ok":${encoded}}`
  }
}

/**
 * The model of a host op, read at op time like upstream reads `adapter.collections[slug]` etc.
 * A missing model fails like upstream's property access on it would (TypeError).
 */
const resolveModel = ({ adapter, model }: { adapter: AnyObject; model: ModelRef }): any => {
  switch (model.kind) {
    case 'collections':
      return adapter.collections[model.slug!]
    case 'globals':
      return adapter.globals
    case 'versions':
      return adapter.versions[model.slug!]
    default:
      throw new Error(`Unknown model kind ${JSON.stringify(model.kind)}`)
  }
}

/** The `{"error": ...}` rejection message of a thrown value. */
const describeHostError = ({
  encode,
  error,
  hostObjects,
}: {
  encode: (value: unknown) => string
  error: unknown
  hostObjects: HostObjects
}): string => {
  const handle = addHostObject(hostObjects, error)
  const isObject = typeof error === 'object' && error !== null
  let json = `{"handle":${handle},"isObject":${isObject}`
  if (isObject) {
    for (const key of ['name', 'message', 'code', 'keyValue']) {
      if (key in error) {
        let value: string
        try {
          value = encode((error as AnyObject)[key])
        } catch {
          // a getter that throws / an unencodable value: upstream reads it, the engine sees undefined
          value = '{"$undefined":true}'
        }
        json += `,${JSON.stringify(key)}:${value}`
      }
    }
  }
  return `{"error":${json}}}`
}

/**
 * Upstream `@payloadcms/db-mongodb` `utilities/getSession.ts` (engine-rs does not import the
 * adapter package): awaits a promise `transactionID` and drops a session that is no longer in a
 * transaction, both observable.
 */
const getSession = async (db: AnyObject, req?: AnyObject): Promise<unknown> => {
  if (!req) {
    return
  }

  let transactionID = req.transactionID

  if (transactionID instanceof Promise) {
    transactionID = await req.transactionID
  }

  if (transactionID) {
    const session = db.sessions[transactionID]

    if (session && !session.inTransaction()) {
      delete db.sessions[transactionID]
      return undefined
    }

    return session
  }
}
