import { types } from 'node:util'

/**
 * Snapshots of JS values for the function compiler (crates/payload-fn-ir): fresh plain objects,
 * arrays and primitives only. Everything the interpreter does not model becomes one of the
 * `opaque*` sentinels; reading a snapshot never runs user code (no getters, no proxy traps).
 */
/** Any JS function (the compiler accepts every kind). */
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyFunction = (...args: any[]) => unknown

export const opaqueObject = Object.freeze({ opaque: 'object' })
export const opaqueFunction = Object.freeze({ opaque: 'function' })
export const opaquePrimitive = Object.freeze({ opaque: 'primitive' })

/** A compiled function inside a snapshot. */
export class FnRef {
  constructor(readonly id: number) {}
}

/** A partial object: only its listed properties are known (reading others bails). */
export class Partial {
  constructor(readonly value: Record<string, unknown>) {}
}

/** A `Headers` object as its iterator yields it (`[name, value]` pairs, names lower-case). */
export class HeadersSnapshot {
  constructor(readonly entries: [string, string][]) {}
}

export const createNullProto = () => Object.create(null) as object

const pristineHeaders = typeof Headers === 'function' ? Headers : undefined
const pristineHeadersEntries = pristineHeaders?.prototype.entries
const pristineRequest = typeof Request === 'function' ? Request : undefined
/** `Request.prototype` getters a compiled function may read through `req` (REST requests). */
const pristineRequestGetters = new Map<string, () => unknown>(
  (['headers', 'method'] as const).flatMap((key) => {
    const get = pristineRequest
      ? Object.getOwnPropertyDescriptor(pristineRequest.prototype, key)?.get
      : undefined
    return get ? [[key, get] as [string, () => unknown]] : []
  }),
)

/** A snapshot of a `Headers` object, or `undefined` when it is not a plain built-in one. */
const snapshotHeaders = (value: unknown): HeadersSnapshot | undefined => {
  if (
    !pristineHeaders ||
    !pristineHeadersEntries ||
    typeof value !== 'object' ||
    value === null ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== pristineHeaders.prototype ||
    Reflect.ownKeys(value).length > 0
  ) {
    return undefined
  }
  const entries: [string, string][] = []
  for (const [k, v] of Reflect.apply(pristineHeadersEntries, value, []) as Iterable<
    [string, string]
  >) {
    entries.push([k, v])
  }
  return new HeadersSnapshot(entries)
}

/**
 * The parts of `req` a compiled function can read: `true` leaves are snapshotted, objects are
 * partial snapshots of the listed members. Reading anything else of `req` bails. The config
 * paths are what Payload's own access wrappers read (`withBaseAccess`); the sanitized config is
 * immutable, so a fused lane can provide them once.
 */
export const capturedRequest = {
  context: true,
  fallbackLocale: true,
  headers: true,
  locale: true,
  method: true,
  operation: true,
  payload: { config: { admin: { user: true }, baseAccess: true } },
  query: true,
  user: true,
} as const

type CaptureSpec = { readonly [key: string]: CaptureSpec | true }

const maxNodes = 20_000

type SnapshotOptions = {
  /** Compile time: compiles functions found in captured values. Guard time: absent (opaque). */
  functionRef?: (fn: AnyFunction) => FnRef | undefined
}

/** A snapshot of `value`. */
export const snapshot = (value: unknown, options: SnapshotOptions = {}): unknown => {
  const state = { nodes: 0, options, seen: new Set<object>() }
  return copy(value, state)
}

type State = { nodes: number; options: SnapshotOptions; seen: Set<object> }

const copy = (value: unknown, state: State): unknown => {
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'undefined':
      return value
    case 'function':
      return state.options.functionRef?.(value as AnyFunction) ?? opaqueFunction
    case 'object':
      break
    case 'string':
      return (value as { isWellFormed: () => boolean } & string).isWellFormed()
        ? value
        : opaquePrimitive
    default:
      return opaquePrimitive
  }
  if (value === null) {
    return null
  }
  if (++state.nodes > maxNodes || state.seen.has(value) || types.isProxy(value)) {
    return opaqueObject
  }
  const proto = Object.getPrototypeOf(value)
  const isArray = Array.isArray(value)
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    return opaqueObject
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  state.seen.add(value)
  try {
    if (isArray) {
      const length = (value as unknown[]).length
      // Exactly the indices and `length`: no holes, no extra properties.
      if (keys.length !== length + 1) {
        return opaqueObject
      }
      const out: unknown[] = new Array(length)
      for (let i = 0; i < length; i++) {
        const d = descriptors[i as unknown as string]
        if (!d || !('value' in d)) {
          return opaqueObject
        }
        out[i] = copy(d.value, state)
      }
      return out
    }
    const out: Record<string, unknown> = proto === null ? Object.create(null) : {}
    for (const key of keys) {
      const d = descriptors[key as string]!
      if (typeof key === 'symbol' || !d.enumerable || !('value' in d)) {
        return opaqueObject
      }
      out[key] = copy(d.value, state)
    }
    return out
  } finally {
    state.seen.delete(value)
  }
}

/**
 * A data property of `object` without running user code: `{ found, value }`, or `{ found:
 * false }` for a missing one, `undefined` when it cannot be read safely (an accessor, a proxy,
 * an inherited property).
 */
export const readDataProperty = (
  object: object,
  key: string,
): { found: boolean; value?: unknown } | undefined => {
  if (types.isProxy(object)) {
    return undefined
  }
  const own = Object.getOwnPropertyDescriptor(object, key)
  if (own) {
    return 'value' in own ? { found: true, value: own.value } : undefined
  }
  for (let p = Object.getPrototypeOf(object); p; p = Object.getPrototypeOf(p)) {
    if (types.isProxy(p) || Object.getOwnPropertyDescriptor(p, key)) {
      return undefined
    }
  }
  return { found: false }
}

/**
 * `req.headers` / `req.method` of a REST request (a Fetch `Request`): the pristine built-in
 * `Request.prototype` getter, called when it is the one the property resolves to.
 */
const readRequestGetter = (
  value: object,
  key: string,
): { found: boolean; value?: unknown } | undefined => {
  const pristine = pristineRequestGetters.get(key)
  if (!pristine || !pristineRequest || !(value instanceof pristineRequest)) {
    return undefined
  }
  for (let p: null | object = value; p; p = Object.getPrototypeOf(p)) {
    if (types.isProxy(p)) {
      return undefined
    }
    const d = Object.getOwnPropertyDescriptor(p, key)
    if (d) {
      return d.get === pristine
        ? { found: true, value: Reflect.apply(pristine, value, []) }
        : undefined
    }
  }
  return undefined
}

/** `req` as a partial snapshot of the properties compiled functions may read. */
export const snapshotRequest = (req: unknown): unknown => capture(req, capturedRequest)

/** What payload's `isolateObjectProperty` recorded for each proxy it created. */
const isolatedObjects = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('payload.isolateObjectProperty')
] ??= new WeakMap()) as WeakMap<object, { delegate: object; keys: PropertyKey[]; target: object }>

/**
 * `object[key]` as `readDataProperty` / `readRequestGetter` read it, also through Payload's own
 * `isolateObjectProperty` proxies (GraphQL resolvers' `req`): their handler reads isolated keys
 * from a plain delegate and every other key from the target.
 */
const readRequestProperty = (
  object: object,
  key: string,
  depth = 0,
): { found: boolean; value?: unknown } | undefined => {
  const isolated = depth < 8 ? isolatedObjects.get(object) : undefined
  if (isolated) {
    const source = isolated.keys.includes(key) ? isolated.delegate : isolated.target
    return readRequestProperty(source, key, depth + 1)
  }
  return readDataProperty(object, key) ?? readRequestGetter(object, key)
}

const capture = (value: unknown, spec: CaptureSpec): unknown => {
  if (typeof value !== 'object' || value === null) {
    return snapshot(value)
  }
  const out: Record<string, unknown> = {}
  for (const [key, sub] of Object.entries(spec)) {
    const read = readRequestProperty(value, key)
    if (!read) {
      // Not safely readable: leave it out, reading it bails.
      continue
    }
    out[key] = !read.found
      ? undefined
      : sub === true
        ? (snapshotHeaders(read.value) ?? snapshot(read.value))
        : capture(read.value, sub)
  }
  return new Partial(out)
}

/**
 * Snapshots of call arguments: for an args object (`{ req, data, ... }`), only `keys` when the
 * function destructures exactly those, and `req` as a partial snapshot.
 */
export const snapshotArgs = (args: unknown[], argKeys: (null | string[])[]): unknown[] =>
  args.map((arg, i) => {
    // `argKeys` has one entry per parameter; a compiled function has no rest parameter and never
    // reads `arguments` (both rejected), so it cannot read the arguments past its parameters
    if (i >= argKeys.length) {
      return opaqueObject
    }
    if (typeof arg !== 'object' || arg === null || Array.isArray(arg) || types.isProxy(arg)) {
      return snapshot(arg)
    }
    const proto = Object.getPrototypeOf(arg)
    if (proto !== Object.prototype && proto !== null) {
      return opaqueObject
    }
    const keys = argKeys[i] ?? Object.keys(arg)
    const out: Record<string, unknown> = {}
    let complete = true
    for (const key of keys) {
      const read = readDataProperty(arg, key)
      if (!read) {
        complete = false
        continue
      }
      if (!read.found) {
        // Absent own property: `undefined` unless the destructured key is on the prototype.
        out[key] = undefined
        continue
      }
      out[key] = key === 'req' ? snapshotRequest(read.value) : snapshot(read.value)
    }
    // With an explicit key list the function reads nothing else, so the object is closed.
    return complete ? out : new Partial(out)
  })

/**
 * A snapshot (`snapshot` / `snapshotRequest`) as JSON for a lane that evaluates compiled functions
 * in Rust (`payload_fn_ir::lanes::from_typed`): `null`, booleans, strings and finite numbers other
 * than `-0` as themselves, every other value a `[tag, payload]` pair (`u` undefined, `n` a
 * non-finite number or `-0`, `a` an array, `o` / `z` / `p` an object, one with a `null`
 * prototype, a partial one, `h` headers, `x` opaque).
 */
export const encodeSnapshot = (value: unknown): unknown => {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : ['n', Object.is(value, -0) ? '-0' : String(value)]
    case 'object':
      break
    case 'undefined':
      return ['u']
    default:
      return ['x', 'primitive']
  }
  if (value === null) {
    return null
  }
  if (value === opaqueObject) {
    return ['x', 'object']
  }
  if (value === opaqueFunction || value instanceof FnRef) {
    return ['x', 'function']
  }
  if (value === opaquePrimitive) {
    return ['x', 'primitive']
  }
  if (value instanceof Partial) {
    return ['p', encodeEntries(value.value)]
  }
  if (value instanceof HeadersSnapshot) {
    return ['h', value.entries]
  }
  if (Array.isArray(value)) {
    return ['a', value.map(encodeSnapshot)]
  }
  return [Object.getPrototypeOf(value) === null ? 'z' : 'o', encodeEntries(value)]
}

const encodeEntries = (value: object) =>
  Object.entries(value).map(([key, item]) => [key, encodeSnapshot(item)])
