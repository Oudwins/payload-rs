/**
 * Clock replay for the shadow adapter.
 *
 * Adapters stamp values with "now" (drizzle upsertRow `data.createdAt = new
 * Date().toISOString()`, createGlobal, updateJobs). Two sides reading the
 * clock a millisecond apart produce different values, and through sort ties
 * (e.g. `-createdAt` over documents created concurrently) different result
 * orders. To keep a TS candidate deterministic, `globalThis.Date` is wrapped
 * once: inside the reference half of a shadowed call every `Date.now()` /
 * argument-less `new Date()` reading is recorded on a tape, and the candidate
 * half of the same call reads the tape back in order. Readings beyond the
 * tape, and native clocks (Rust `SystemTime`, SQLite `'now'`), fall back to
 * the real clock and are covered by the timestamp rule in compare.ts.
 *
 * Outside a shadowed call the wrapper behaves exactly like `Date`.
 *
 * `globalThis.crypto.randomUUID()` gets the same treatment: the `uuid`
 * package's `v4()` calls it, e.g. the default `copy` assigning fresh array and
 * block row ids. Without replay two TS runs never produce the same row ids.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

type ClockTape = {
  cursor: number
  isRecording: boolean
  readings: number[]
  uuidCursor: number
  uuids: string[]
}

const tapeContext = new AsyncLocalStorage<ClockTape>()
let isInstalled = false

/** Installs the `Date` wrapper (idempotent). */
export const installClockReplay = () => {
  if (isInstalled) {
    return
  }
  isInstalled = true
  const BaseDate = globalThis.Date
  const baseNow = BaseDate.now

  const now = () => {
    const tape = tapeContext.getStore()
    if (tape && !tape.isRecording && tape.cursor < tape.readings.length) {
      return tape.readings[tape.cursor++]!
    }
    const time = baseNow()
    if (tape?.isRecording) {
      tape.readings.push(time)
    }
    return time
  }

  function Date(this: unknown, ...args: unknown[]) {
    if (!new.target) {
      // `Date()` called as a function returns the current time as a string
      return new BaseDate(now()).toString()
    }
    return Reflect.construct(BaseDate, args.length ? args : [now()], new.target)
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
        const tape = tapeContext.getStore()
        if (tape && !tape.isRecording && tape.uuidCursor < tape.uuids.length) {
          return tape.uuids[tape.uuidCursor++]!
        }
        const uuid = baseRandomUUID()
        if (tape?.isRecording) {
          tape.uuids.push(uuid)
        }
        return uuid
      },
      writable: true,
    })
  }
}

/**
 * Returns runners for the two halves of one shadowed call: the reference
 * records its clock readings, the candidate replays them in order.
 */
export const createClockTapes = () => {
  const readings: number[] = []
  const uuids: string[] = []
  const reference: ClockTape = { cursor: 0, isRecording: true, readings, uuidCursor: 0, uuids }
  const candidate: ClockTape = { cursor: 0, isRecording: false, readings, uuidCursor: 0, uuids }
  return {
    candidate: <T>(fn: () => T) => tapeContext.run(candidate, fn),
    reference: <T>(fn: () => T) => tapeContext.run(reference, fn),
  }
}
