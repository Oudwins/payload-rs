/**
 * TS stand-in for the native `SqliteEngine`, enabled with `PAYLOAD_RS_ENGINE_LOOPBACK=true`.
 *
 * It speaks the exact wire format of ENGINE_CONTRACT.md: the raw schema comes from the Rust
 * `buildRawSchema`; `call` decodes `argsJson`, runs the upstream `@payloadcms/drizzle` method on
 * the drizzle instance behind `connId` and returns the tree-encoded result, or rejects with the
 * JSON `EngineError`. Running the upstream suites through it verifies the TS glue (argument
 * reduction, connection mapping, result decoding, error reconstruction) independently of the
 * Rust data methods.
 */
import type { NativeSqliteEngine } from '../native.js'
import type { FunctionRegistry } from '../serialize.js'

import { getNativeEngine } from '../native.js'
import { decodeGraph, encodeTree } from './encode.js'
import { describeError } from './errors.js'

type AnyObject = Record<PropertyKey, any>

export type LoopbackEngine = {
  /** The drizzle instance (client or transaction) behind a connection id. */
  registerConnection: (connId: number, db: unknown) => void
} & NativeSqliteEngine

export const createLoopbackEngine = ({
  adapter,
  callFunction,
  graphJson,
  methods,
  optionsJson,
  registry,
}: {
  adapter: AnyObject
  callFunction: (id: number, argJson: string) => string
  graphJson: string
  methods: Record<string, (this: unknown, args: unknown) => Promise<unknown>>
  optionsJson: string
  registry: FunctionRegistry
}): LoopbackEngine => {
  // the wire format of `SqliteEngine.rawSchema()` (with `undefinedProperties`)
  const native = getNativeEngine()
  const rawSchema = native.SqliteEngine
    ? native.SqliteEngine.create(graphJson, optionsJson, callFunction).rawSchema()
    : native.buildRawSchema(graphJson, optionsJson, callFunction)
  const connections = new Map<number, unknown>()
  let attachedClient: number | undefined

  return {
    attachClient: (clientId) => {
      attachedClient = clientId
    },
    call: async (method, argsJson, connId, contextJson) => {
      const upstream = methods[method]
      if (!upstream) {
        throw new Error(
          JSON.stringify({ name: 'Error', message: `Unknown engine method ${method}` }),
        )
      }
      if (attachedClient === undefined) {
        throw new Error(JSON.stringify({ name: 'Error', message: 'No client attached' }))
      }
      const db = connections.get(connId)
      if (!db) {
        throw new Error(JSON.stringify({ name: 'Error', message: `Unknown connection ${connId}` }))
      }
      const args = decodeGraph(argsJson, registry) as AnyObject
      // the reduced req carries no transactionID: `getTransaction` resolves to `drizzle`
      const view = Object.create(adapter, {
        drizzle: { configurable: true, enumerable: true, value: db, writable: true },
      })
      // the one mutation the native engine reports (ENGINE_CONTRACT.md `withMutations`)
      const isCreatedAtUnset = method === 'updateGlobal' && !args.data?.createdAt
      let result: unknown
      try {
        result = await upstream.call(view, args)
      } catch (error) {
        const described = describeError({ encode: (value) => encodeTree(value, registry), error })
        throw new Error(JSON.stringify(described ?? { name: 'Error', message: String(error) }))
      }
      const tree = encodeTree(result, registry)
      if (JSON.parse(contextJson ?? '{}').withMutations !== true) {
        return JSON.stringify(tree)
      }
      const mutations =
        isCreatedAtUnset && args.data.createdAt
          ? [[['data', 'createdAt'], encodeTree(args.data.createdAt, registry)]]
          : []
      return JSON.stringify({ mutations, result: tree })
    },
    rawSchema: () => rawSchema,
    // the upstream methods read the live schema from the adapter themselves
    registerConnection: (connId, db) => {
      connections.set(connId, db)
    },
    setLiveSchema: () => {},
  }
}
