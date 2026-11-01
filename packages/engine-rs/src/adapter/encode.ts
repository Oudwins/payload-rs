/**
 * The two directions of the `serializeForEngine` format the Rust engine implements, used by the
 * TS loopback engine (`loopback.ts`) so it speaks exactly the wire format of the native one:
 * - `decodeGraph`: the `{ objects, root }` graph `serializeForEngine` emits (args, config).
 * - `encodeTree`: the tree form (no `$ref`s) the engine returns, read by `deserializeFromEngine`.
 */
import type { FunctionRegistry } from '../serialize.js'

const reservedKeys = new Set(['$bigint', '$date', '$fn', '$num', '$obj', '$ref', '$undefined'])

type Graph = { objects: unknown[]; root: unknown }

export const decodeGraph = (json: string, registry: FunctionRegistry): unknown => {
  const { objects, root } = JSON.parse(json) as Graph
  const decodedObjects = new Map<number, unknown>()

  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(decode)
    }
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const keys = Object.keys(value)
    if (keys.length === 1) {
      const key = keys[0]!
      const inner = (value as Record<string, unknown>)[key]
      switch (key) {
        case '$bigint':
          return BigInt(inner as string)
        case '$date':
          return new Date(inner === null ? NaN : (inner as string))
        case '$fn':
          return registry.functions[inner as number]
        case '$num':
          return Number(inner)
        case '$obj':
          return decodeEntries(inner as object)
        case '$ref':
          return decodeRef(inner as number)
        case '$undefined':
          return undefined
      }
    }
    return decodeEntries(value)
  }

  const decodeEntries = (value: object, out: Record<string, unknown> = {}) => {
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        configurable: true,
        enumerable: true,
        value: decode((value as Record<string, unknown>)[key]),
        writable: true,
      })
    }
    return out
  }

  // A shared object is decoded once and keeps its identity; containers are registered before
  // their contents are decoded, so cycles resolve to the same object.
  const decodeRef = (id: number) => {
    if (decodedObjects.has(id)) {
      return decodedObjects.get(id)
    }
    const raw = objects[id]
    if (Array.isArray(raw)) {
      const out: unknown[] = []
      decodedObjects.set(id, out)
      for (const item of raw) {
        out.push(decode(item))
      }
      return out
    }
    if (typeof raw === 'object' && raw !== null) {
      const keys = Object.keys(raw)
      const isWrapped = keys.length === 1 && keys[0] === '$obj'
      if (isWrapped || !(keys.length === 1 && reservedKeys.has(keys[0]!))) {
        const out: Record<string, unknown> = {}
        decodedObjects.set(id, out)
        return decodeEntries(isWrapped ? (raw as { $obj: object }).$obj : raw, out)
      }
    }
    const decoded = decode(raw)
    decodedObjects.set(id, decoded)
    return decoded
  }

  return decode(root)
}

/** Tree encoding of a value (shared objects are copied, as the Rust engine returns them). */
export const encodeTree = (value: unknown, registry: FunctionRegistry): unknown => {
  switch (typeof value) {
    case 'bigint':
      return { $bigint: value.toString() }
    case 'function':
      return { $fn: registry.functions.push(value as never) - 1 }
    case 'number':
      return Number.isFinite(value) ? value : { $num: String(value) }
    case 'object': {
      if (value === null) {
        return null
      }
      if (value instanceof Date) {
        return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() }
      }
      if (Array.isArray(value)) {
        return value.map((item) => encodeTree(item, registry))
      }
      const out: Record<string, unknown> = {}
      const keys = Object.keys(value)
      for (const key of keys) {
        Object.defineProperty(out, key, {
          configurable: true,
          enumerable: true,
          value: encodeTree((value as Record<string, unknown>)[key], registry),
          writable: true,
        })
      }
      return keys.length === 1 && reservedKeys.has(keys[0]!) ? { $obj: out } : out
    }
    case 'symbol':
    case 'undefined':
      return { $undefined: true }
    default:
      return value
  }
}
