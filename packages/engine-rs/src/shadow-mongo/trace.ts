/**
 * Event trace of one adapter call (one half of a shadow pair, or one adapter call of a parity
 * step), for what results and final argument states cannot show:
 *
 * - call order: every MongoDB driver operation the call makes (`Collection.prototype` methods of
 *   the driver mongoose uses: method, collection name, described arguments), in issue order;
 * - mutation timing: the state of the call's arguments at the moment of every driver operation
 *   (`args`, a fingerprint of the described arguments), plus the state right after the call
 *   returned its promise (the synchronous prefix up to upstream's first `await`, `firstAwait`);
 * - clock reads: every clock / uuid / ObjectId counter reading (`read`), in order relative to the
 *   driver operations (shadow: replay.ts reports them; parity: `withClockTrace`).
 *
 * Events are attributed to the call through an AsyncLocalStorage context, so concurrent calls
 * keep separate traces.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type TraceEvent =
  | { args: unknown; collection: unknown; op: string; state?: string }
  | { read: string }

export type TraceLog = {
  /** Describes driver operation arguments (comparable tree). */
  describe: (args: unknown[]) => unknown
  events: TraceEvent[]
  /** Fingerprint of the traced call's arguments now (mutation timing). */
  fingerprint?: () => string
}

const traceContext = new AsyncLocalStorage<TraceLog>()

/** Driver `Collection` methods that reach the server (or build the cursor that does). */
export const TRACED_DRIVER_METHODS = [
  'aggregate',
  'bulkWrite',
  'count',
  'countDocuments',
  'createIndex',
  'createIndexes',
  'deleteMany',
  'deleteOne',
  'distinct',
  'drop',
  'dropIndex',
  'dropIndexes',
  'estimatedDocumentCount',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'indexes',
  'insertMany',
  'insertOne',
  'listIndexes',
  'rename',
  'replaceOne',
  'updateMany',
  'updateOne',
] as const

const patchedPrototypes = new WeakSet<object>()

/**
 * Wraps the driver's `Collection.prototype` methods (idempotent per driver copy). Outside a traced
 * call the wrappers only forward (same `this`, same arguments, same return value).
 */
export const installDriverTrace = (driverCollectionClass: unknown) => {
  const proto = (driverCollectionClass as { prototype?: Record<string, unknown> } | undefined)
    ?.prototype
  if (!proto || patchedPrototypes.has(proto)) {
    return
  }
  patchedPrototypes.add(proto)
  for (const method of TRACED_DRIVER_METHODS) {
    const original = proto[method]
    if (typeof original !== 'function') {
      continue
    }
    const traced = {
      [method](this: { collectionName?: unknown }, ...args: unknown[]) {
        const log = traceContext.getStore()
        if (log) {
          log.events.push({
            args: log.describe(args),
            collection: this?.collectionName,
            op: method,
            state: log.fingerprint?.(),
          })
        }
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      },
    }[method]!
    Object.defineProperty(traced, 'length', {
      value: (original as (...a: unknown[]) => unknown).length,
    })
    proto[method] = traced
  }
}

const DRIVER_FRAME = /[\\/]node_modules[\\/]mongodb[\\/]lib[\\/]/

/**
 * Whether the code calling `reader` is the MongoDB driver: its connection pool / topology
 * monitoring stamps `new Date()` a number of times that depends on the pool's state, not on the
 * adapter (same rule as replay.ts).
 */
const isReadByDriver = (reader: (...args: never[]) => unknown) => {
  const holder: { stack?: string } = {}
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 1
  try {
    Error.captureStackTrace(holder, reader)
  } finally {
    Error.stackTraceLimit = limit
  }
  return DRIVER_FRAME.test(holder.stack ?? '')
}

/** Records a generated-value reading (clock, uuids, incs) in the current traced call. */
export const traceRead = (channel: string) => {
  traceContext.getStore()?.events.push({ read: channel })
}

/** Runs `fn` with `log` as the current traced call. */
export const runTraced = <T>(log: TraceLog, fn: () => T): T => traceContext.run(log, fn)

/** Whether a traced call is running in the current async context. */
export const isTracing = () => traceContext.getStore() !== undefined

/**
 * Parity goldens (faked `Date`): while `fn` runs, `globalThis.Date` is a subclass of the Date in
 * place (the fake) whose clock readings (`Date.now()`, argument-less `new Date()`, `Date()`) are
 * reported to the current traced call. Readers resolving the global at call time (upstream TS
 * and the engine's `clock` module) go through it; the values are the fake's.
 */
export const withClockTrace = async <T>(fn: () => Promise<T>): Promise<T> => {
  const BaseDate = globalThis.Date
  const read = (reader: (...args: never[]) => unknown) => {
    if (traceContext.getStore() && !isReadByDriver(reader)) {
      traceRead('clock')
    }
  }
  function Date(this: unknown, ...args: unknown[]) {
    if (!new.target) {
      read(Date)
      return (BaseDate as unknown as () => string)()
    }
    if (!args.length) {
      read(Date)
    }
    return Reflect.construct(BaseDate, args, new.target)
  }
  Object.setPrototypeOf(Date, BaseDate)
  Object.defineProperty(Date, 'length', { value: BaseDate.length })
  Date.prototype = BaseDate.prototype
  Date.now = function now() {
    read(now)
    return BaseDate.now()
  }
  globalThis.Date = Date as unknown as DateConstructor
  try {
    return await fn()
  } finally {
    globalThis.Date = BaseDate
  }
}
