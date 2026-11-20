/**
 * Deep comparison of the MongoDB shadow adapter (over `toComparable` trees, see comparable.ts).
 *
 * Strict: `undefined` vs missing key, key order, array length and order, class names, Error
 * name/message/data/status. Unlike the SQLite shadow's compare (../shadow/compare.ts) no string
 * is rewritten (no drizzle table-alias rule: MongoDB has no aliases, and the rule would equate
 * snake-cased UUIDs). `-0` differs from `0` (`Object.is`); functions are compared through their
 * `toComparable` spelling, never equal by type alone. The only tolerance is `isNowPair`
 * (timestamps stamped by lifecycle operations whose clock is not replayed, as Dates or as their
 * ISO strings in read results, see NORMALISATIONS in index.ts).
 */
import type { Difference } from '../shadow/compare.js'

import { errorShape, toReportValue } from '../shadow/compare.js'

export type { Difference }

export type MongoCompareOptions = {
  /**
   * Whether two differing Date values (ms since epoch) were both stamped as "now" by the same
   * operation whose clock readings are not replayed. Without it, every differing Date differs.
   */
  isNowPair?: (reference: number, candidate: number) => boolean
  /**
   * Like `isNowPair` at second resolution (ObjectId time bytes): ObjectIds (`{ $oid }` or 24-hex
   * strings) differing only in their time bytes are equal when it holds for those times.
   */
  isNowSecondPair?: (reference: number, candidate: number) => boolean
  /** Stop after this many differences. Default 25. */
  maxDifferences?: number
}

/** `Date.prototype.toISOString()` output (what db-mongodb's read transform makes of a Date). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/

/** Whether two ObjectId hex strings differ only in their time bytes, inside the windows. */
const isNowObjectIdPair = (a: string, b: string, options: MongoCompareOptions) =>
  options.isNowSecondPair !== undefined &&
  OBJECT_ID_HEX.test(a) &&
  OBJECT_ID_HEX.test(b) &&
  a.slice(8) === b.slice(8) &&
  options.isNowSecondPair(parseInt(a.slice(0, 8), 16), parseInt(b.slice(0, 8), 16))

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const describeType = (value: unknown): string => {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  if (value instanceof Date) {
    return 'Date'
  }
  if (value instanceof Error) {
    return 'Error'
  }
  if (typeof value === 'object') {
    return isPlainObject(value) ? 'object' : `instance:${value.constructor?.name ?? 'unknown'}`
  }
  return typeof value
}

const formatPath = (path: string, key: number | string) =>
  typeof key === 'number'
    ? `${path}[${key}]`
    : /^[A-Z_$][\w$]*$/i.test(key)
      ? path
        ? `${path}.${key}`
        : key
      : `${path}[${JSON.stringify(key)}]`

/** Differences between two comparable trees (empty when equal). */
export function compareMongoValues(
  reference: unknown,
  candidate: unknown,
  options: MongoCompareOptions = {},
): Difference[] {
  const max = options.maxDifferences ?? 25
  const out: Difference[] = []
  const seen = new WeakMap<object, object>()

  const push = (kind: Difference['kind'], path: string, a: unknown, b: unknown) => {
    if (out.length < max) {
      out.push({ candidate: toReportValue(b), kind, path, reference: toReportValue(a) })
    }
  }

  const walk = (a: unknown, b: unknown, path: string) => {
    if (out.length >= max || Object.is(a, b)) {
      return
    }
    if (typeof a === 'number' && typeof b === 'number') {
      push('value', path, a, b)
      return
    }
    const typeA = describeType(a)
    const typeB = describeType(b)
    if (typeA !== typeB) {
      push('type', path, a, b)
      return
    }
    if (typeA === 'Date') {
      const ta = (a as Date).getTime()
      const tb = (b as Date).getTime()
      if (Number.isNaN(ta) && Number.isNaN(tb)) {
        return
      }
      if (ta !== tb && !(options.isNowPair && options.isNowPair(ta, tb))) {
        push('value', path, a, b)
      }
      return
    }
    if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') {
      // the same stamps read back through db-mongodb's read transform (`toISOString()`)
      if (
        options.isNowPair &&
        typeof a === 'string' &&
        typeof b === 'string' &&
        ISO_DATE.test(a) &&
        ISO_DATE.test(b) &&
        options.isNowPair(Date.parse(a), Date.parse(b))
      ) {
        return
      }
      if (typeof a === 'string' && typeof b === 'string' && isNowObjectIdPair(a, b, options)) {
        return
      }
      push('value', path, a, b)
      return
    }
    if (seen.get(a) === b) {
      return
    }
    seen.set(a, b)
    if (typeA === 'Error') {
      walk(errorShape(a), errorShape(b), path)
      return
    }
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
      if (Buffer.compare(new Uint8Array(a), new Uint8Array(b)) !== 0) {
        push('value', path, a, b)
      }
      return
    }
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
      if (Buffer.compare(a, b) !== 0) {
        push('value', path, a, b)
      }
      return
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        push('length', path, a, b)
      }
      const n = Math.min(a.length, b.length)
      for (let i = 0; i < n; i++) {
        walk(a[i], b[i], formatPath(path, i))
      }
      return
    }
    const objA = a as Record<string, unknown>
    const objB = b as Record<string, unknown>
    const keysA = Object.keys(objA)
    const keysB = Object.keys(objB)
    const setA = new Set(keysA)
    const setB = new Set(keysB)
    for (const k of keysA) {
      if (!setB.has(k)) {
        push('missingKey', formatPath(path, k), objA[k], undefined)
      }
    }
    for (const k of keysB) {
      if (!setA.has(k)) {
        push('extraKey', formatPath(path, k), undefined, objB[k])
      }
    }
    const commonA = keysA.filter((k) => setB.has(k))
    const commonB = keysB.filter((k) => setA.has(k))
    if (commonA.join('\u0000') !== commonB.join('\u0000')) {
      push('keyOrder', path || '$', commonA, commonB)
    }
    for (const k of commonA) {
      walk(objA[k], objB[k], formatPath(path, k))
    }
  }

  walk(reference, candidate, '')
  return out
}

/**
 * Order-insensitive comparison of two arrays of comparable trees: equal when they hold the same
 * elements (each compared strictly with `compareMongoValues`) with the same multiplicity, in any
 * order (`isSame`: strict equality by default). Used only where upstream's own order is nondeterministic (see index.ts
 * `NONDETERMINISTIC_ORDER`).
 */
export function compareAsMultiset(
  reference: unknown[],
  candidate: unknown[],
  options: MongoCompareOptions = {},
  isSame: (reference: unknown, candidate: unknown) => boolean = (a, b) =>
    compareMongoValues(a, b, { ...options, maxDifferences: 1 }).length === 0,
): Difference[] {
  if (reference.length !== candidate.length) {
    return [
      {
        candidate: toReportValue(candidate),
        kind: 'length',
        path: '$unordered',
        reference: toReportValue(reference),
      },
    ]
  }
  const unmatched = [...candidate]
  for (let i = 0; i < reference.length; i++) {
    const index = unmatched.findIndex((item) => isSame(reference[i], item))
    if (index === -1) {
      return [
        {
          candidate: toReportValue(unmatched),
          kind: 'value',
          path: `$unordered[${i}]`,
          reference: toReportValue(reference[i]),
        },
      ]
    }
    unmatched.splice(index, 1)
  }
  return []
}
