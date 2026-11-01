/**
 * Recording side of the live query differential (./harness.ts). No payload imports: the
 * `vi.mock` factories of the spec files load it while payload modules are being mocked.
 *
 * During a run every JS-observable step lands in one ordered event log:
 * - calls of `getEntityPermissions` / `executeAccess` (the host functions both implementations
 *   call) with their complete argument objects: key order, `entityType`, `fetchData`,
 *   `operations`, `disableErrors`, `slug`, `id`, `data`, `isReadingStaticFile`, the entity /
 *   access function (config path), `blockReferencesPermissions` and `req` (identity, or an
 *   `isolateObjectProperty` proxy of it), and when their promises settle;
 * - calls of every access function of the config (wrapped in place), their args and results;
 * - in traced runs, every proxy trap on the input graph (`where`, `policies`, `errors`, `joins`,
 *   `sort`): get / set / has / delete / ownKeys / getOwnPropertyDescriptor / defineProperty /
 *   getPrototypeOf, with the key.
 * Object identities are numbered per run in order of first appearance; config objects and
 * functions are named by their path in the config.
 */
import { types } from 'node:util'

export type Run = {
  events: unknown[]
  ids: Map<object, number>
  /** Host calls whose promise has not settled yet (waited for before a run ends). */
  outstanding: number
  req: unknown
  tracing: boolean
}

let current: null | Run = null

export const startRun = (req: unknown, tracing: boolean): Run => {
  current = { events: [], ids: new Map(), outstanding: 0, req, tracing }
  return current
}

export const endRun = () => {
  current = null
}

export const activeRun = () => current

export const record = (event: unknown) => {
  current?.events.push(event)
}

// ---------------------------------------------------------------------------------------------
// identities

const configPaths = new WeakMap<object, string>()
const proxyTargets = new WeakMap<object, object>()

export const setConfigPath = (o: object, path: string) => {
  if (!configPaths.has(o)) {
    configPaths.set(o, path)
  }
}

export const configPathOf = (o: object) => configPaths.get(o)

export const unwrap = <T>(v: T): T =>
  (typeof v === 'object' && v !== null ? (proxyTargets.get(v) ?? v) : v) as T

/** A primitive as a tagged string, an object as `cfg:<path>`, `req`, or `#<run id>`. */
export const describe = (v: unknown): unknown => {
  switch (typeof v) {
    case 'bigint':
      return `big:${v}`
    case 'boolean':
      return v
    case 'function':
    case 'object': {
      if (v === null) {
        return null
      }
      const target = unwrap(v)
      const path = configPaths.get(target)
      if (path) {
        return `cfg:${path}`
      }
      if (current && target === current.req) {
        return 'req'
      }
      if (!current) {
        return typeof v
      }
      let id = current.ids.get(target)
      if (id === undefined) {
        id = current.ids.size + 1
        current.ids.set(target, id)
      }
      return `#${id}`
    }
    case 'number':
      return Object.is(v, -0) ? 'n:-0' : `n:${v}`
    case 'string':
      return `s:${v}`
    case 'symbol':
      return `sym:${v.description}`
    case 'undefined':
      return 'u'
  }
}

/** `req` as passed to a host function: the request itself or an isolating proxy of it. */
const describeReq = (r: any) => {
  if (current && r === current.req) {
    return 'req'
  }
  if (types.isProxy(r)) {
    return { proxy: describe(r), sameContext: r.context === (current?.req as any)?.context }
  }
  return describe(r)
}

// ---------------------------------------------------------------------------------------------
// snapshots (no getters invoked, no traps)

const protoName = (o: object, seen: Map<object, number>): unknown => {
  const proto = Object.getPrototypeOf(o)
  if (proto === Object.prototype) {
    return undefined
  }
  if (proto === null) {
    return 'null'
  }
  if (proto === Array.prototype) {
    return undefined
  }
  if (configPaths.has(proto)) {
    return `cfg:${configPaths.get(proto)}`
  }
  return { ctor: proto.constructor?.name, value: snapWith(proto, seen) }
}

const snapWith = (v: unknown, seen: Map<object, number>): unknown => {
  if (typeof v === 'function') {
    return describe(v)
  }
  if (typeof v !== 'object' || v === null) {
    return describe(v)
  }
  const target = unwrap(v)
  const path = configPaths.get(target)
  if (path) {
    return `cfg:${path}`
  }
  if (current && target === current.req) {
    return 'req'
  }
  const ref = seen.get(target)
  if (ref !== undefined) {
    return { $ref: ref }
  }
  const id = seen.size + 1
  seen.set(target, id)
  if (types.isProxy(target)) {
    // a user proxy: walking it would run its traps
    return { $id: id, $proxy: true }
  }
  if (target instanceof Date) {
    return { $date: target.getTime(), $id: id }
  }
  if (target instanceof Error) {
    return { $error: target.constructor.name, $id: id, message: target.message }
  }
  const out: Record<string, unknown> = { $id: id }
  if (Array.isArray(target)) {
    out.$len = target.length
  }
  const proto = protoName(target, seen)
  if (proto !== undefined) {
    out.$proto = proto
  }
  if (Object.isFrozen(target)) {
    out.$frozen = true
  }
  for (const key of Reflect.ownKeys(target)) {
    const d = Object.getOwnPropertyDescriptor(target, key)!
    const k = typeof key === 'symbol' ? `@@${key.description}` : key
    const flags = d.enumerable ? '' : '~'
    out[flags + k] = 'value' in d ? snapWith(d.value, seen) : { $accessor: true }
  }
  return out
}

/** Identity-preserving snapshot of several values (shared objects become `$ref`s). */
export const snapshot = (values: Record<string, unknown>, seen = new Map<object, number>()) => {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, snapWith(v, seen)]))
}

export const USER_ERROR = Symbol.for('cq.userError')

export const describeError = (e: any, seen = new Map<object, number>()) => {
  if (typeof e !== 'object' || e === null) {
    return { thrown: describe(e) }
  }
  return {
    ctor: e.constructor?.name,
    data: 'data' in e ? snapWith(e.data, seen) : '$none',
    isPublic: e.isPublic,
    message: e.message,
    name: e.name,
    status: e.status,
    user: e[USER_ERROR],
  }
}

// ---------------------------------------------------------------------------------------------
// tracing proxies over the input graph

const traceProxies = new WeakMap<object, object>()

const keyName = (k: PropertyKey) => (typeof k === 'symbol' ? `@@${k.description}` : k)

const trap = (t: string, target: object, key?: PropertyKey, extra?: unknown) => {
  if (current?.tracing) {
    current.events.push(
      key === undefined
        ? { o: describe(target), t }
        : extra === undefined
          ? { k: keyName(key), o: describe(target), t }
          : { k: keyName(key), o: describe(target), t, v: extra },
    )
  }
}

const handler: ProxyHandler<object> = {
  defineProperty(target, key, desc) {
    trap('def', target, key)
    return Reflect.defineProperty(target, key, desc)
  },
  deleteProperty(target, key) {
    trap('del', target, key)
    return Reflect.deleteProperty(target, key)
  },
  get(target, key, receiver) {
    trap('get', target, key)
    const value = Reflect.get(target, key, receiver)
    const d = Reflect.getOwnPropertyDescriptor(target, key)
    // proxy invariant: non-configurable, non-writable data properties report their own value
    if (d && !d.configurable && 'value' in d && !d.writable) {
      return value
    }
    return trace(value)
  },
  getOwnPropertyDescriptor(target, key) {
    trap('desc', target, key)
    return Reflect.getOwnPropertyDescriptor(target, key)
  },
  getPrototypeOf(target) {
    trap('proto', target)
    return Reflect.getPrototypeOf(target)
  },
  has(target, key) {
    trap('has', target, key)
    return Reflect.has(target, key)
  },
  ownKeys(target) {
    trap('keys', target)
    return Reflect.ownKeys(target)
  },
  set(target, key, value, receiver) {
    trap('set', target, key, describe(value))
    return Reflect.set(target, key, value, receiver)
  },
}

/** A recording proxy of an input object (same proxy for the same object; config untouched). */
export const trace = <T>(v: T): T => {
  if (typeof v !== 'object' || v === null) {
    return v
  }
  if (
    configPaths.has(v) ||
    proxyTargets.has(v) ||
    (current && v === current.req) ||
    types.isProxy(v)
  ) {
    return v
  }
  let p = traceProxies.get(v)
  if (!p) {
    p = new Proxy(v, handler)
    traceProxies.set(v, p)
    proxyTargets.set(p, v)
  }
  return p as T
}

// ---------------------------------------------------------------------------------------------
// host function wrappers (installed by the spec files' vi.mock factories)

const settleEvents = (kind: string, p: unknown) => {
  const run = current
  if (!run || !(p instanceof Promise)) {
    record({ result: describe(p), t: `${kind}:returned` })
    return
  }
  run.outstanding++
  p.then(
    (value) => {
      run.outstanding--
      if (current === run) {
        record({ t: `${kind}:resolved`, value: describe(value) })
      }
    },
    (error) => {
      run.outstanding--
      if (current === run) {
        record({ error: describeError(error), t: `${kind}:rejected` })
      }
    },
  )
}

export const wrapGetEntityPermissions = <F extends (...args: any[]) => any>(original: F): F =>
  function (this: unknown, ...callArgs: any[]) {
    if (!current) {
      return original.apply(this, callArgs)
    }
    const [args] = callArgs
    record({
      argc: callArgs.length,
      blockReferencesPermissions: describe(args?.blockReferencesPermissions),
      data: describe(args?.data),
      entity: describe(args?.entity),
      entityType: args?.entityType,
      fetchData: describe(args?.fetchData),
      id: describe(args?.id),
      keys: Object.keys(args ?? {}),
      operations: snapshot({ operations: args?.operations }).operations,
      req: describeReq(args?.req),
      t: 'getEntityPermissions',
      this: describe(this),
    })
    const p = original.apply(this, callArgs)
    settleEvents('getEntityPermissions', p)
    return p
  } as F

export const wrapExecuteAccess = <F extends (...args: any[]) => any>(original: F): F =>
  function (this: unknown, ...callArgs: any[]) {
    if (!current) {
      return original.apply(this, callArgs)
    }
    const [args, access] = callArgs
    record({
      access: describe(access),
      argc: callArgs.length,
      data: describe(args?.data),
      disableErrors: describe(args?.disableErrors),
      id: describe(args?.id),
      isReadingStaticFile: describe(args?.isReadingStaticFile),
      keys: Object.keys(args ?? {}),
      req: describeReq(args?.req),
      slug: describe(args?.slug),
      t: 'executeAccess',
      this: describe(this),
    })
    const p = original.apply(this, callArgs)
    settleEvents('executeAccess', p)
    return p
  } as F

const wrappedAccess = new WeakSet<Function>()

/** Wraps an access function in place (once) so its calls are recorded. */
export const wrapAccessFunction = (owner: any, key: string, path: string) => {
  const original = owner[key]
  if (typeof original !== 'function' || wrappedAccess.has(original)) {
    return
  }
  const wrapped = function (this: unknown, args: any) {
    if (current) {
      record({
        data: describe(args?.data),
        doc: describe(args?.doc),
        fn: path,
        id: describe(args?.id),
        keys: args && typeof args === 'object' ? Object.keys(args) : describe(args),
        req: describeReq(args?.req),
        siblingData: describe(args?.siblingData),
        t: 'access',
        this: describe(this),
      })
    }
    let result: unknown
    try {
      result = original.call(this, args)
    } catch (error) {
      record({ error: describeError(error), fn: path, t: 'access:threw' })
      throw error
    }
    if (current) {
      if (result instanceof Promise) {
        settleEvents(`access:${path}`, result)
      } else {
        record({ fn: path, result: snapshot({ result }).result, t: 'access:returned' })
      }
    }
    return result
  }
  wrappedAccess.add(wrapped)
  owner[key] = wrapped
}
