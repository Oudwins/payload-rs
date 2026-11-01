/**
 * TS twin of crates/payload-core-query/src/graph.rs.
 *
 * - `encodeData(value)`: `{ objects, root }` graph that keeps object identity. Objects referenced
 *   more than once are stored in `objects` (ids in first-encounter order of a depth-first,
 *   key-ordered walk) and referenced as `{ $ref: id }`. Markers: `$undefined`, `$num`, `$date`,
 *   `$obj` (escape).
 * - `ConfigIndex` / `encodeCfg(value, index)`: config values as trees where objects of the config
 *   graph are `{ $cfg: path }` (path from the config root as serialized by `serializeForEngine`)
 *   and functions are `{ $fn: id }`.
 */
import type { FunctionRegistry } from '../../../packages/engine-rs/src/serialize.js'

const markers = new Set(['$cfg', '$date', '$fn', '$num', '$obj', '$ref', '$undefined'])

const isContainer = (v: unknown): v is object =>
  typeof v === 'object' && v !== null && !(v instanceof Date)

export const encodeData = (root: unknown): { objects: unknown[]; root: unknown } => {
  const counts = new Map<object, number>()
  const count = (v: unknown) => {
    if (!isContainer(v)) {
      return
    }
    const seen = counts.get(v) ?? 0
    counts.set(v, seen + 1)
    if (seen) {
      return
    }
    const children = Array.isArray(v) ? Array.from(v) : Object.keys(v).map((k) => (v as any)[k])
    children.forEach(count)
  }
  count(root)

  const objects: unknown[] = []
  const ids = new Map<object, number>()

  const encode = (v: unknown): unknown => {
    switch (typeof v) {
      case 'bigint':
        return Number(v)
      case 'function':
      case 'symbol':
      case 'undefined':
        return { $undefined: true }
      case 'number':
        return Number.isFinite(v) ? v : { $num: String(v) }
      case 'object': {
        if (v === null) {
          return null
        }
        if (v instanceof Date) {
          return { $date: Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString() }
        }
        if ((counts.get(v) ?? 0) > 1) {
          let id = ids.get(v)
          if (id === undefined) {
            id = objects.push(null) - 1
            ids.set(v, id)
            objects[id] = container(v)
          }
          return { $ref: id }
        }
        return container(v)
      }
      default:
        return v
    }
  }

  const container = (v: object): unknown => {
    if (Array.isArray(v)) {
      return Array.from(v, encode)
    }
    // null prototype: an own `__proto__` key stays a plain key
    const out: Record<string, unknown> = Object.create(null)
    const keys = Object.keys(v)
    for (const key of keys) {
      out[key] = encode((v as any)[key])
    }
    return keys.length === 1 && markers.has(keys[0]!) ? { $obj: out } : out
  }

  return { objects, root: encode(root) }
}

export type ConfigIndex = {
  paths: WeakMap<object, (number | string)[]>
  registry: FunctionRegistry
}

/** Depth-first index of every object in the serialized config root (first visit wins). */
export const indexConfig = (root: unknown, registry: FunctionRegistry): ConfigIndex => {
  const paths = new WeakMap<object, (number | string)[]>()
  const visit = (v: unknown, path: (number | string)[]) => {
    if (!isContainer(v) || typeof v === 'function' || paths.has(v)) {
      return
    }
    paths.set(v, path)
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, [...path, i]))
    } else {
      for (const key of Object.keys(v)) {
        visit((v as any)[key], [...path, key])
      }
    }
  }
  visit(root, [])
  return { paths, registry }
}

const fnID = (registry: FunctionRegistry, fn: Function) => {
  const existing = registry.functions.indexOf(fn)
  return existing === -1 ? registry.functions.push(fn) - 1 : existing
}

export const encodeCfg = (
  v: unknown,
  index: ConfigIndex | undefined,
  stack: object[] = [],
): unknown => {
  switch (typeof v) {
    case 'bigint':
      return Number(v)
    case 'function':
      return index ? { $fn: fnID(index.registry, v) } : { $undefined: true }
    case 'number':
      return Number.isFinite(v) ? v : { $num: String(v) }
    case 'object': {
      if (v === null) {
        return null
      }
      if (v instanceof Date) {
        return { $date: v.toISOString() }
      }
      const path = index?.paths.get(v)
      if (path) {
        return { $cfg: path }
      }
      if (stack.includes(v)) {
        return { $undefined: true }
      }
      stack.push(v)
      try {
        if (Array.isArray(v)) {
          return Array.from(v, (item) => encodeCfg(item, index, stack))
        }
        const out: Record<string, unknown> = Object.create(null)
        const keys = Object.keys(v)
        for (const key of keys) {
          out[key] = encodeCfg((v as any)[key], index, stack)
        }
        return keys.length === 1 && markers.has(keys[0]!) ? { $obj: out } : out
      } finally {
        stack.pop()
      }
    }
    case 'symbol':
    case 'undefined':
      return { $undefined: true }
    default:
      return v
  }
}

export const encodeError = (e: any) => ({
  data: e && typeof e === 'object' && 'data' in e ? encodeData(e.data) : undefined,
  message: String(e?.message ?? e),
  name: String(e?.name ?? 'Error'),
})
