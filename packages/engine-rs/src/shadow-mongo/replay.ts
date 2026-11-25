/**
 * Replay of generated values for the MongoDB shadow adapter, with exact accounting.
 *
 * Inside the reference half of a pair every clock reading (`Date.now()`, argument-less
 * `new Date()`, `Date()`), `crypto.randomUUID()` result and bson `ObjectId.getInc()` counter is
 * recorded on a tape; the candidate half of the same pair reads the tapes back in order. A
 * candidate that reads a value the reference did not (past the tape), or fewer values than the
 * reference recorded, is reported by `unmatched()`: the candidate does not generate values at the
 * same points as upstream (e.g. an extra clock reading for a context field, or a single reading
 * where upstream stamps twice). Values past the tape fall back to the real source.
 *
 * Readings made by the MongoDB driver itself (the reading frame is in `node_modules/mongodb/lib/`:
 * connection pool / topology monitoring events stamp `new Date()`) are not taped: how many there
 * are depends on the pool's state (a new connection emits more events), not on the adapter, and
 * taping them would shift the adapter's own readings. bson (ObjectId generation) is a separate
 * package and stays taped.
 *
 * Installed once per process (`installReplay`); outside a tape everything behaves like the
 * originals. Under `vi.useFakeTimers()` the faked `Date` replaces the wrapper (the faked clock is
 * deterministic itself; readings are then not counted).
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { traceRead } from './trace.js'

type Channel<T> = { cursor: number; extra: number; values: T[] }

type Tape = {
  clock: Channel<number>
  incs: Channel<number>
  isClockReplayed: boolean
  isRecording: boolean
  /** Values of `bson-objectid` (payload's array / block row ids), whose counter is a closure. */
  objectIds: Channel<string>
  uuids: Channel<string>
}

const tapeContext = new AsyncLocalStorage<Tape>()

// `src/` when the stack is source-mapped (the driver ships its TypeScript sources)
const DRIVER_FRAME = /[\\/]node_modules[\\/]mongodb[\\/](?:lib|src)[\\/]/

/** Whether the code calling `reader` is the MongoDB driver (see the module comment). */
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

/** Reads one value through the tape of the current context (recording, replaying or neither). */
const through = <T>(
  channel: keyof Pick<Tape, 'clock' | 'incs' | 'objectIds' | 'uuids'>,
  base: () => T,
  reader?: (...args: never[]) => unknown,
): T => {
  const tape = tapeContext.getStore()
  if (
    !tape ||
    (channel === 'clock' && !tape.isClockReplayed) ||
    (reader && isReadByDriver(reader))
  ) {
    return base()
  }
  // the reading's position among the call's driver operations (trace.ts)
  traceRead(channel)
  const tapeChannel = tape[channel] as Channel<T>
  if (tape.isRecording) {
    const value = base()
    tapeChannel.values.push(value)
    return value
  }
  if (tapeChannel.cursor < tapeChannel.values.length) {
    return tapeChannel.values[tapeChannel.cursor++]!
  }
  tapeChannel.extra++
  return base()
}

let isInstalled = false

/** Wraps `globalThis.Date` and `crypto.randomUUID` (idempotent). */
export const installReplay = () => {
  if (isInstalled) {
    return
  }
  isInstalled = true
  const BaseDate = globalThis.Date
  const baseNow = BaseDate.now.bind(BaseDate)
  const now = () => through('clock', baseNow, now)

  function Date(this: unknown, ...args: unknown[]) {
    if (!new.target) {
      return new BaseDate(through('clock', baseNow, Date)).toString()
    }
    return Reflect.construct(
      BaseDate,
      args.length ? args : [through('clock', baseNow, Date)],
      new.target,
    )
  }
  Object.setPrototypeOf(Date, BaseDate)
  Object.defineProperty(Date, 'length', { value: BaseDate.length })
  Date.prototype = BaseDate.prototype
  Date.now = now
  globalThis.Date = Date as unknown as DateConstructor

  const webCrypto = globalThis.crypto
  if (typeof webCrypto?.randomUUID === 'function') {
    const baseRandomUUID = webCrypto.randomUUID.bind(webCrypto)
    Object.defineProperty(webCrypto, 'randomUUID', {
      configurable: true,
      value: function randomUUID() {
        return through('uuids', baseRandomUUID, randomUUID)
      },
      writable: true,
    })
  }
}

const patchedObjectIdOwners = new WeakSet<object>()

/**
 * Wraps the static `getInc` of a bson `ObjectId` class (idempotent per class copy). A new
 * ObjectId is `time(Date.now()) + PROCESS_UNIQUE + inc`: with the clock and the counter replayed
 * both sides generate identical ids.
 */
export const installObjectIdReplay = (objectIdClass: unknown) => {
  let owner = objectIdClass as null | Record<string, unknown>
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'getInc')) {
    owner = Object.getPrototypeOf(owner)
  }
  if (!owner || typeof owner.getInc !== 'function' || patchedObjectIdOwners.has(owner)) {
    return
  }
  patchedObjectIdOwners.add(owner)
  const baseGetInc = owner.getInc as (this: unknown) => number
  owner.getInc = function getInc(this: unknown) {
    return through('incs', () => baseGetInc.call(this))
  }
}

/**
 * Wraps `generate` of a `bson-objectid` class (payload's array / block row ids, `baseIDField`;
 * idempotent per class). Its counter is a closure, so the generated value is taped instead (the
 * `objectIds` channel); the clock reading it makes is read outside the tape's value, so the clock
 * channel stays aligned on both halves. Added for the fused writes' lane-shadow (src/fuse-write).
 */
export const installBsonObjectIdReplay = (objectIdClass: unknown) => {
  if (typeof objectIdClass !== 'function') {
    return
  }
  const proto = Reflect.get(objectIdClass, 'prototype')
  if (!proto || typeof proto.generate !== 'function' || patchedObjectIdOwners.has(proto)) {
    return
  }
  patchedObjectIdOwners.add(proto)
  const baseGenerate: (this: unknown, time?: unknown) => string = proto.generate
  proto.generate = function generate(this: unknown, time?: unknown) {
    const seconds = typeof time === 'number' ? time : ~~(Date.now() / 1000)
    return through('objectIds', () => baseGenerate.call(this, seconds))
  }
}

/** The values the reference half recorded, per channel. */
export type RecordedReadings = { clock: number[]; incs: number[]; objectIds: string[] }

export type UnmatchedReads = {
  /** Values the candidate read past the reference's tape. */
  extra: number
  /** Values the reference recorded. */
  recorded: number
  /** Values the candidate read back from the tape. */
  replayed: number
}

/** Runners for the two halves of one pair, and the accounting of their readings. */
export const createReplayTapes = ({
  isClockReplayed = true,
}: { isClockReplayed?: boolean } = {}) => {
  const clock: number[] = []
  const incs: number[] = []
  const objectIds: string[] = []
  const uuids: string[] = []
  const tape = (isRecording: boolean): Tape => ({
    clock: { cursor: 0, extra: 0, values: clock },
    incs: { cursor: 0, extra: 0, values: incs },
    isClockReplayed,
    isRecording,
    objectIds: { cursor: 0, extra: 0, values: objectIds },
    uuids: { cursor: 0, extra: 0, values: uuids },
  })
  const reference = tape(true)
  const candidate = tape(false)
  return {
    candidate: <T>(fn: () => T) => tapeContext.run(candidate, fn),
    /** The values the reference recorded (copies). */
    recorded: (): RecordedReadings => ({
      clock: [...clock],
      incs: [...incs],
      objectIds: [...objectIds],
    }),
    reference: <T>(fn: () => T) => tapeContext.run(reference, fn),
    /** Channels whose readings do not line up 1:1 (empty when every reading matched). */
    unmatched: () => {
      const out: Record<string, UnmatchedReads> = {}
      for (const channel of ['clock', 'incs', 'objectIds', 'uuids'] as const) {
        if (channel === 'clock' && !isClockReplayed) {
          continue
        }
        const read = candidate[channel]
        if (read.extra > 0 || read.cursor !== read.values.length) {
          out[channel] = { extra: read.extra, recorded: read.values.length, replayed: read.cursor }
        }
      }
      return out
    },
  }
}
