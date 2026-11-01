/**
 * Deep comparison used by the shadow adapter.
 *
 * The comparison is intentionally strict: it distinguishes `undefined` from a
 * missing key, checks object key order (user visible through
 * `JSON.stringify`/`Object.keys`), compares array lengths and element order,
 * class names of non-plain objects and Error name/message/data/status.
 *
 * Only the normalisations listed in `NORMALISATIONS` are applied. Each one
 * covers a value that is legitimately nondeterministic between two otherwise
 * identical adapter runs.
 */

export type Difference = {
  /** Value produced by the candidate (serialised for the report) */
  candidate: unknown
  kind: 'extraKey' | 'keyOrder' | 'length' | 'missingKey' | 'type' | 'value'
  /** JSON-path like location, e.g. `docs[0].title` */
  path: string
  /** Value produced by the reference (serialised for the report) */
  reference: unknown
}

export type CompareOptions = {
  /**
   * Decides whether two differing timestamps (ms since epoch) were both
   * generated as "now" by the same shadowed operation: the reference value
   * inside the reference's execution window and the candidate value inside the
   * candidate's window of that same operation. `precisionMs` is the
   * resolution of both values (1, or 1000 for SQLite's second-precision
   * `CURRENT_TIMESTAMP` format): a value `t` stands for `[t, t + precisionMs)`.
   * Without it, every differing timestamp is a divergence.
   */
  isNowPair?: (reference: number, candidate: number, precisionMs: number) => boolean
  /** Stop after this many differences. Default 25. */
  maxDifferences?: number
}

/**
 * Documented normalisations. Anything not listed here must be identical.
 */
export const NORMALISATIONS = {
  beginTransaction:
    'beginTransaction() ids are random (uuid v4 in drizzle). Only null vs non-null is compared; the candidate id is mapped to the reference id for every later call that carries req.transactionID.',
  clock:
    "`globalThis.Date` is wrapped: clock readings (`Date.now()`, `new Date()`) made by the reference half of a shadowed call are replayed in order to the candidate half of the same call (see clock.ts), so 'now' stamps and the sort ties they create are identical for a TS candidate. Readings past the tape and native clocks use the real clock (see `timestamps`).",
  databaseState:
    "Database files are compared as sqlite_master (type, name, tbl_name, sql; ordered by type, name; `rootpage` is left out because it is a physical page number) plus every table's rows (including sqlite_sequence) in rowid order, read through each adapter's own client. Row values use the same comparison as results (including the timestamp rule). No row reordering is applied.",
  errors:
    'Thrown errors are compared by constructor name, `name`, `message`, `status` and `data`; stack traces and `cause` are ignored.',
  negativeZero: 'Numbers are compared with === plus NaN === NaN (so -0 equals 0, as in JSON).',
  tableAliases:
    'Strings are compared after replacing drizzle random table aliases (toSnakeCase(uuid()) from getTableAlias, visible in SQL error messages) with <alias:N>, numbered per string.',
  timestamps:
    "Two differing timestamps (any key, any depth, results and DB rows) are accepted only when both are valid Dates, or both are strings in exactly `Date#toISOString()` format (YYYY-MM-DDTHH:mm:ss.sssZ), or both are strings in exactly SQLite's `CURRENT_TIMESTAMP` format (YYYY-MM-DD HH:MM:SS, UTC, second precision; round-tripping through Date), and the reference value lies inside the reference's execution window and the candidate value inside the candidate's execution window of the same shadowed call or mirrored raw statement (±1 ms, at the value's precision; wall clock or faked Date clock; windows of other processes sharing `crossProcessFile` count too). Those are values legitimately stamped with 'now' (drizzle upsertRow/createGlobal/updateJobs `new Date()`, SQLite defaults strftime('%Y-%m-%dT%H:%M:%fZ', 'now') and CURRENT_TIMESTAMP). Format differences, stale values and values not generated during the same call are divergences.",
} as const

const TABLE_ALIAS = /[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}/g

/** Replaces random drizzle table aliases by `<alias:N>` (numbered per string). */
export const normaliseAliases = (value: string) => {
  const seen = new Map<string, string>()
  return value.replace(TABLE_ALIAS, (match) => {
    if (!seen.has(match)) {
      seen.set(match, `<alias:${seen.size + 1}>`)
    }
    return seen.get(match)!
  })
}

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

/** Exactly the `Date#toISOString()` format for years 0000-9999. */
const ISO_STRING = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** SQLite `CURRENT_TIMESTAMP` / `datetime('now')`: UTC, second precision. */
const SQLITE_DATETIME_STRING = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

type Timestamp = { format: 'date' | 'iso' | 'sqliteDatetime'; precisionMs: number; time: number }

/**
 * Milliseconds of a valid Date, of a string in exact toISOString() format, or
 * of a string in exact SQLite `CURRENT_TIMESTAMP` format (round-tripping).
 */
const toTimestamp = (value: unknown): Timestamp | undefined => {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? undefined : { format: 'date', precisionMs: 1, time }
  }
  if (typeof value === 'string' && ISO_STRING.test(value)) {
    const time = Date.parse(value)
    return !Number.isNaN(time) && new Date(time).toISOString() === value
      ? { format: 'iso', precisionMs: 1, time }
      : undefined
  }
  if (typeof value === 'string' && SQLITE_DATETIME_STRING.test(value)) {
    const time = Date.parse(`${value.replace(' ', 'T')}.000Z`)
    return !Number.isNaN(time) &&
      new Date(time).toISOString().slice(0, 19).replace('T', ' ') === value
      ? { format: 'sqliteDatetime', precisionMs: 1000, time }
      : undefined
  }
  return undefined
}

/** Fields of an Error that take part in the comparison. */
export const errorShape = (error: unknown) => {
  if (!(error instanceof Error)) {
    return { thrown: toReportValue(error) }
  }
  const e = error as { data?: unknown; status?: unknown } & Error
  return {
    name: e.name,
    class: e.constructor?.name,
    data: e.data,
    message: e.message,
    status: e.status,
  }
}

/**
 * Converts a value into something JSON.stringify can write losslessly enough
 * for a report: undefined -> {$undefined: true}, Dates -> {$date}, Errors ->
 * errorShape, functions -> {$function: name}, bigint -> {$bigint}, buffers ->
 * {$bytes: base64}.
 */
export const toReportValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value === undefined) {
    return { $undefined: true }
  }
  if (typeof value === 'function') {
    return { $function: value.name || 'anonymous' }
  }
  if (typeof value === 'bigint') {
    return { $bigint: value.toString() }
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { $number: String(value) }
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return { $circular: true }
  }
  seen.add(value)
  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() }
  }
  if (value instanceof Error) {
    return toReportValue(errorShape(value), seen)
  }
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') }
  }
  if (value instanceof ArrayBuffer) {
    return { $bytes: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) {
    return value.map((item) => toReportValue(item, seen))
  }
  const out: Record<string, unknown> = {}
  if (!isPlainObject(value)) {
    out.$class = value.constructor?.name
  }
  for (const key of Object.keys(value)) {
    out[key] = toReportValue((value as Record<string, unknown>)[key], seen)
  }
  return out
}

const formatPath = (path: string, key: number | string) =>
  typeof key === 'number'
    ? `${path}[${key}]`
    : /^[A-Z_$][\w$]*$/i.test(key)
      ? path
        ? `${path}.${key}`
        : key
      : `${path}[${JSON.stringify(key)}]`

/**
 * Returns the list of differences between `reference` and `candidate`
 * (empty when equal under the documented normalisations).
 */
export function compareValues(
  reference: unknown,
  candidate: unknown,
  options: CompareOptions = {},
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
    if (out.length >= max) {
      return
    }
    if (a === b) {
      return
    }
    if (
      typeof a === 'string' &&
      typeof b === 'string' &&
      normaliseAliases(a) === normaliseAliases(b)
    ) {
      return
    }
    if (typeof a === 'number' && typeof b === 'number') {
      if (!(Number.isNaN(a) && Number.isNaN(b))) {
        push('value', path, a, b)
      }
      return
    }

    if (options.isNowPair && typeof a === typeof b && a instanceof Date === b instanceof Date) {
      const ta = toTimestamp(a)
      const tb = toTimestamp(b)
      if (
        ta !== undefined &&
        tb !== undefined &&
        ta.format === tb.format &&
        options.isNowPair(ta.time, tb.time, ta.precisionMs)
      ) {
        return
      }
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
      if (ta !== tb && !(Number.isNaN(ta) && Number.isNaN(tb))) {
        push('value', path, a, b)
      }
      return
    }

    if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') {
      // primitives (string, boolean, bigint, symbol) or functions
      if (typeof a === 'function' && typeof b === 'function') {
        return
      }
      push('value', path, a, b)
      return
    }

    // cycle guard
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
    const setB = new Set(keysB)
    const setA = new Set(keysA)
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
