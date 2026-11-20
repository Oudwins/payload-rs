/**
 * Recording "world" for the live differential: input objects are wrapped in Proxies that log every
 * trap (get / set / has / deleteProperty / ownKeys / getOwnPropertyDescriptor / defineProperty /
 * getPrototypeOf) with a deterministic label of the object, so the TS reference and the Rust port,
 * run on two identically built copies, can be compared operation by operation. After the run the
 * final state of the inputs is described with object identity (shared references, which input
 * object each container is, prototypes, property attributes), so in-place mutation vs replacement
 * (e.g. relationship arrays replaced by `.map()`) is part of the comparison.
 */
import { Types } from 'mongoose'

export type World = ReturnType<typeof createWorld>

const isObjectIdLike = (value: object) => value instanceof Types.ObjectId

const isLeafObject = (value: object) =>
  isObjectIdLike(value) || value instanceof Date || value instanceof Uint8Array

const traceKey = (key: PropertyKey) =>
  typeof key === 'symbol' ? `@@${key.description ?? ''}` : String(key)

export const createWorld = () => {
  const events: string[] = []
  let isActive = false
  /** proxy -> target */
  const targets = new WeakMap<object, object>()
  /** target / leaf / function -> input label */
  const labels = new WeakMap<object, string>()
  const proxies = new Map<object, object>()
  const sentinels = new Map<unknown, string>()

  const unwrap = <T>(value: T): T =>
    (value && (typeof value === 'object' || typeof value === 'function')
      ? (targets.get(value as object) ?? value)
      : value) as T

  /** Short description of a value written by a trap (for set / define events). */
  const shallow = (value: unknown): string => {
    if (value === undefined) {
      return 'undefined'
    }
    if (value === null) {
      return 'null'
    }
    switch (typeof value) {
      case 'bigint':
        return `${value}n`
      case 'function':
        return `fn:${labels.get(value) ?? value.name}`
      case 'number':
        return Object.is(value, -0) ? '-0' : String(value)
      case 'object': {
        const target = unwrap(value)
        if (isObjectIdLike(target)) {
          return `oid:${(target as Types.ObjectId).toHexString()}`
        }
        if (target instanceof Date) {
          return `date:${Number.isNaN(target.getTime()) ? 'Invalid' : target.toISOString()}`
        }
        return `${Array.isArray(target) ? 'arr' : 'obj'}:${labels.get(target) ?? 'new'}`
      }
      case 'string':
        return JSON.stringify(value)
      case 'symbol':
        return `sym:${value.description}`
      default:
        return String(value)
    }
  }

  const log = (label: string, op: string, key?: PropertyKey) => {
    if (isActive) {
      events.push(`${op} ${label}${key === undefined ? '' : ` [${traceKey(key)}]`}`)
    }
  }

  /**
   * Objects a lazy membrane leaves unwrapped: values whose methods need the real receiver
   * (internal slots / private state) and bson / mongoose values.
   */
  const isOpaque = (value: object) =>
    isLeafObject(value) ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof RegExp ||
    value instanceof Promise ||
    value instanceof Error ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    '_bsontype' in value

  /**
   * A recording proxy whose `get` results are wrapped on demand (same label scheme), without
   * touching the target graph: for shared objects that must not be mutated by the wrapping
   * (a live suite's adapter / config / fields). Writes store the unwrapped value.
   */
  const membrane = <T>(value: T, label: string): T => {
    if (!value || typeof value !== 'object') {
      return value
    }
    if (targets.has(value) || isOpaque(value)) {
      return value
    }
    return proxyOf(value, label, true) as T
  }

  const proxyOf = (value: object, label: string, isLazy = false): object => {
    const existing = proxies.get(value)
    if (existing) {
      return existing
    }
    const proxy = new Proxy(value, {
      defineProperty: (target, key, descriptor) => {
        if (isActive) {
          events.push(
            `define ${label} [${traceKey(key)}] = ${'value' in descriptor ? shallow(descriptor.value) : 'accessor'}`,
          )
        }
        return Reflect.defineProperty(target, key, descriptor)
      },
      deleteProperty: (target, key) => {
        log(label, 'delete', key)
        return Reflect.deleteProperty(target, key)
      },
      get: (target, key, receiver) => {
        log(label, 'get', key)
        const result = Reflect.get(target, key, receiver)
        if (!isLazy) {
          return result
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        // proxy invariant: non-configurable, non-writable data properties report their value
        if (
          descriptor &&
          !descriptor.configurable &&
          'value' in descriptor &&
          !descriptor.writable
        ) {
          return result
        }
        return membrane(result, `${label}.${traceKey(key)}`)
      },
      getOwnPropertyDescriptor: (target, key) => {
        log(label, 'gopd', key)
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      getPrototypeOf: (target) => {
        log(label, 'proto')
        return Reflect.getPrototypeOf(target)
      },
      has: (target, key) => {
        log(label, 'has', key)
        return Reflect.has(target, key)
      },
      ownKeys: (target) => {
        log(label, 'ownKeys')
        return Reflect.ownKeys(target)
      },
      set: (target, key, newValue, receiver) => {
        if (isActive) {
          events.push(`set ${label} [${traceKey(key)}] = ${shallow(newValue)}`)
        }
        return Reflect.set(target, key, isLazy ? unwrap(newValue) : newValue, receiver)
      },
    })
    proxies.set(value, proxy)
    targets.set(proxy, value)
    labels.set(value, label)
    return proxy
  }

  /**
   * Wraps `value` and (in place) every object reachable through its writable own data properties
   * in recording proxies. Shared objects map to one proxy. ObjectIds, Dates and byte arrays stay
   * unwrapped (their methods need the real receiver) but are labelled.
   */
  const wrap = <T>(value: T, label: string): T => {
    if (!value || typeof value !== 'object') {
      if (typeof value === 'function' && !labels.has(value)) {
        labels.set(value, label)
      }
      return value
    }
    if (targets.has(value)) {
      return value
    }
    if (isLeafObject(value)) {
      if (!labels.has(value)) {
        labels.set(value, label)
      }
      return value
    }
    const existing = proxies.get(value)
    if (existing) {
      return existing as T
    }
    const proxy = proxyOf(value, label)
    if (!Object.isFrozen(value)) {
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor && 'value' in descriptor && descriptor.writable) {
          const wrapped = wrap(descriptor.value, `${label}.${traceKey(key)}`)
          if (wrapped !== descriptor.value) {
            Object.defineProperty(value, key, { ...descriptor, value: wrapped })
          }
        }
      }
    }
    return proxy as T
  }

  /** A recording proxy around `value` only (children are left as they are). */
  const shallowWrap = <T extends object>(value: T, label: string): T => proxyOf(value, label) as T

  /** Labels without wrapping (objects whose identity must be tracked but not traced). */
  const label = <T>(value: T, name: string): T => {
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      labels.set(value as object, name)
    }
    return value
  }

  const sentinel = (name: string) => {
    const error = new Error(`sentinel ${name}`)
    sentinels.set(error, name)
    return error
  }

  const describe = (roots: Record<string, unknown>) => {
    const ids = new Map<object, number>()
    const walk = (value: unknown): unknown => {
      if (value === undefined) {
        return { u: 1 }
      }
      if (value === null) {
        return null
      }
      switch (typeof value) {
        case 'bigint':
          return { big: String(value) }
        case 'boolean':
        case 'string':
          return value
        case 'function':
          return { fn: value.name, label: labels.get(value) }
        case 'number':
          return Number.isFinite(value) && !Object.is(value, -0) ? value : { n: String(value) }
        case 'symbol':
          return { sym: value.description }
      }
      const target = unwrap(value as object)
      const seen = ids.get(target)
      if (seen !== undefined) {
        return { ref: seen }
      }
      const id = ids.size
      ids.set(target, id)
      const label = labels.get(target) ?? 'new'
      if (isObjectIdLike(target)) {
        return { id, label, oid: (target as Types.ObjectId).toHexString() }
      }
      if (target instanceof Date) {
        return {
          id,
          date: Number.isNaN(target.getTime()) ? 'Invalid' : target.toISOString(),
          label,
        }
      }
      if (target instanceof Uint8Array) {
        return {
          id,
          bytes: Buffer.from(target).toString('base64'),
          cls: target.constructor.name,
          label,
        }
      }
      const proto = Object.getPrototypeOf(target)
      const protoName =
        proto === Object.prototype
          ? 'Object'
          : proto === Array.prototype
            ? 'Array'
            : proto === null
              ? 'null'
              : (labels.get(proto) ?? proto.constructor?.name ?? '?')
      return {
        frozen: Object.isFrozen(target),
        id,
        keys: Reflect.ownKeys(target)
          .filter((key) => !(target instanceof Error && key === 'stack'))
          .map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(target, key)!
            return [
              traceKey(key),
              `${descriptor.enumerable ? 'e' : ''}${descriptor.configurable ? 'c' : ''}${'value' in descriptor && descriptor.writable ? 'w' : ''}`,
              'value' in descriptor ? walk(descriptor.value) : { accessor: true },
            ]
          }),
        label,
        proto: protoName,
      }
    }
    return Object.fromEntries(Object.entries(roots).map(([key, value]) => [key, walk(value)]))
  }

  const describeError = (error: unknown, extra?: (error: unknown) => unknown) => {
    if (!error || typeof error !== 'object') {
      return { thrownPrimitive: describe({ error }).error }
    }
    const e = error as Record<string, unknown>
    return {
      class: (e.constructor as { name?: string } | undefined)?.name,
      extra: extra?.(error),
      message: e.message,
      name: e.name,
      sentinel: sentinels.get(error),
    }
  }

  return {
    describe,
    describeError,
    events,
    label,
    membrane,
    sentinel,
    shallowWrap,
    start: () => {
      isActive = true
    },
    stop: () => {
      isActive = false
    },
    unwrap,
    wrap,
  }
}
