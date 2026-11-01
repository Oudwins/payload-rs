/**
 * JSON encoding of JS values that keeps what JSON.stringify loses. TS twin of
 * crates/payload-sql-read/src/encoding.rs:
 * - `{"$undefined": true}`: `undefined` (own property, array item or root)
 * - `{"$num": "NaN" | "Infinity" | "-Infinity"}`: non-finite numbers
 * - `{"$date": "<ISO string>" | "Invalid Date"}`: Date instances
 * - `{"$obj": {...}}`: a plain object whose only key is one of the markers
 * - `{"$cycle": true}`: a reference back to an ancestor
 * Objects/arrays are encoded as trees (shared references are duplicated).
 * Functions and symbols are encoded as `$undefined` (built-ins such as `{}.constructor` can reach
 * results through inherited keys).
 * Own `__proto__` keys are kept as own keys (`defineProperty`, not assignment), and strings are
 * left as-is: `JSON.stringify` writes lone surrogates as `\udXXX` escapes, which
 * payload_sql_read::json decodes losslessly.
 */
/** `CreateDataProperty`: an own enumerable property even for the key `__proto__`. */
export const defineOwn = (target: Record<string, unknown>, key: string, value: unknown) => {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true })
}

const markers = new Set(['$cycle', '$date', '$num', '$obj', '$ref', '$undefined'])

export const encodeTree = (value: unknown, stack: object[] = []): unknown => {
  switch (typeof value) {
    case 'bigint':
      return Number(value)
    case 'function':
    case 'symbol':
    case 'undefined':
      return { $undefined: true }
    case 'number':
      return Number.isFinite(value) ? value : { $num: String(value) }
    case 'object': {
      if (value === null) {
        return null
      }
      if (value instanceof Date) {
        return { $date: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() }
      }
      if (stack.includes(value)) {
        return { $cycle: true }
      }
      stack.push(value)
      try {
        if (Array.isArray(value)) {
          return Array.from(value, (item) => encodeTree(item, stack))
        }
        const out: Record<string, unknown> = {}
        const keys = Object.keys(value)
        for (const key of keys) {
          defineOwn(out, key, encodeTree((value as Record<string, unknown>)[key], stack))
        }
        return keys.length === 1 && markers.has(keys[0]!) ? { $obj: out } : out
      } finally {
        stack.pop()
      }
    }
    default:
      return value
  }
}

/** Wraps an encoded tree in the `{ objects, root }` graph envelope read by `decode_graph`. */
export const asGraph = (encoded: unknown) => ({ objects: [], root: encoded })

/** Inverse of `encodeTree` (also decodes the output of `payload_sql_read::transform_json`). */
export const decodeTree = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(decodeTree)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  const entries = Object.entries(value)
  if (entries.length === 1) {
    const [key, inner] = entries[0]!
    switch (key) {
      case '$cycle':
      case '$undefined':
        return undefined
      case '$date':
        return new Date(inner === 'Invalid Date' ? Number.NaN : (inner as string))
      case '$num':
        return Number(inner)
      case '$obj':
        return Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).map(([k, v]) => [k, decodeTree(v)]),
        )
      default:
        break
    }
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, decodeTree(v)]))
}
