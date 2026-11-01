/**
 * Settling for the in-process differential harnesses (test/__rs/core-*): before a run is
 * snapshotted (and before the other engine's run starts), the work it left behind must be done.
 * A rejected `Promise.all` leaves its sibling fields running; on SQLite their database calls
 * complete within a turn or two, on MongoDB they wait for network I/O, so a fixed number of turns
 * lets one run's tail (callback events, Rust executor tasks) leak into the next run.
 *
 * `trackDatabaseIO(payload)` counts in-flight `payload.db.*` calls (the wrapper returns the
 * adapter's own promise, so callers observe the same value and settlement; both engines run on
 * the same wrapped adapter). `settleRun` then waits until there is no in-flight database call and
 * neither the Rust executor counters nor the caller's activity counter changed for a few
 * macrotask turns.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'

type Any = any

const DB_METHODS = [
  'beginTransaction',
  'commitTransaction',
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
  'rollbackTransaction',
  'updateGlobal',
  'updateGlobalVersion',
  'updateMany',
  'updateOne',
  'updateVersion',
  'upsert',
]

const inFlightByDb = new WeakMap<object, { count: number }>()

/**
 * `RS_ORDERED_IO=true` (network databases such as MongoDB): the settlement of every top-level
 * tracked call is delivered in call order, each one macrotask turn after the previous delivery and
 * after its own I/O settled, with the adapter's own value or error. Concurrent work that queries
 * the database (slug uniqueness checks, access functions, population) then interleaves as a
 * function of the call order instead of the order network responses arrive, identically for both
 * engines. Calls made while another tracked call runs (an adapter method calling `this.<method>`)
 * are not delayed.
 */
const isOrderedIO = process.env.RS_ORDERED_IO === 'true'
const realSetImmediate = globalThis.setImmediate
const ioScope = new AsyncLocalStorage<true>()
let ioDeliveryTail: Promise<unknown> = Promise.resolve()

const callOrdered = (original: Function, self: unknown, args: unknown[]): unknown => {
  if (!isOrderedIO || ioScope.getStore()) {
    return original.apply(self, args)
  }
  const raw = ioScope.run(true, () => original.apply(self, args))
  if (!raw || typeof (raw as Any).then !== 'function') {
    return raw
  }
  const settled = Promise.resolve(raw).then(
    (value: unknown) => ({ isOk: true as const, value }),
    (error: unknown) => ({ error, isOk: false as const }),
  )
  const delivered = ioDeliveryTail.then(async () => {
    const outcome = await settled
    await new Promise((resolve) => realSetImmediate(resolve))
    return outcome
  })
  ioDeliveryTail = delivered
  return delivered.then((outcome) =>
    outcome.isOk ? outcome.value : Promise.reject(outcome.error),
  )
}

/**
 * Wraps the data methods of `payload.db` once to count in-flight calls (and, with
 * `RS_ORDERED_IO=true`, to deliver their results in call order).
 */
export const trackDatabaseIO = (payload: Any): void => {
  const db = payload?.db
  if (!db || inFlightByDb.has(db)) {
    return
  }
  const state = { count: 0 }
  inFlightByDb.set(db, state)
  for (const method of DB_METHODS) {
    const original = db[method]
    if (typeof original !== 'function') {
      continue
    }
    db[method] = function (this: unknown, ...args: unknown[]) {
      const result: Any = callOrdered(original, this, args)
      if (result && typeof result.then === 'function') {
        state.count++
        const done = () => {
          state.count--
        }
        result.then(done, done)
      }
      return result
    }
  }
}

const SETTLE_QUIET_TURNS = 3
const SETTLE_MAX_TURNS = 5000

/**
 * Waits until no tracked database call is in flight and the Rust executor counters and
 * `activity()` (e.g. the recorder's event count) stayed unchanged for a few macrotask turns.
 */
export const settleRun = async ({
  activity,
  payload,
}: {
  activity?: () => number
  payload?: Any
}): Promise<void> => {
  const runtime = getCoreRuntime()
  const signature = () => {
    const { awaits, entries, tasks } = runtime.stats()
    return `${awaits}:${entries}:${tasks}:${activity?.() ?? 0}`
  }
  const inFlight = () => (payload?.db && inFlightByDb.get(payload.db)?.count) || 0
  let last = signature()
  let quiet = 0
  for (let turn = 0; turn < SETTLE_MAX_TURNS && quiet < SETTLE_QUIET_TURNS; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setImmediate(resolve))
    const now = signature()
    quiet = inFlight() === 0 && now === last ? quiet + 1 : 0
    last = now
  }
}
