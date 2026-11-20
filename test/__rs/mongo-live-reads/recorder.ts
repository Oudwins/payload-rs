/**
 * Live differential machinery for the Mongo live reads (crates/payload-mongo-live).
 *
 * One `Run` = one call of a data method (upstream TS or Rust) on a recording view of the live
 * adapter:
 * - the adapter is a Proxy over the real db-mongodb adapter: every property read on it is an
 *   event; `collections` / `versions` / `globals` / `sessions` are per-run objects whose models are
 *   spies (every model method call is an event with a snapshot of its arguments taken at call time);
 * - the method arguments are built per run through `wrap`: recording proxies around every plain
 *   object (get / set / has / delete / ownKeys / getOwnPropertyDescriptor / defineProperty are
 *   events, in order);
 * - `real` mode: model calls go to MongoDB (results are captured into a tape); `tape` mode: model
 *   calls return deterministic thenables replaying a tape (recorded or synthetic: values, errors,
 *   delays), and a microtask pump stamps every event with the current tick, so await points,
 *   `Promise.all` composition and settle order are compared tick for tick;
 * - the outcome: the returned value (identity structure included: shared objects, objects that are
 *   the caller's own inputs or tape values), or the rejection (and whether it is the very error the
 *   tape or user code threw), and the arguments' final state.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

export type Event = [null | number, string, ...unknown[]]

const MODEL_METHODS = new Set([
  'aggregate',
  'countDocuments',
  'distinct',
  'estimatedDocumentCount',
  'find',
  'findOne',
  'paginate',
])

const isPlain = (v: unknown): v is Record<PropertyKey, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return false
  }
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export type TapeEntry = {
  /** extra microtasks before settling (synthetic tapes) */
  delay?: number
  error?: unknown
  label: string
  method: string
  value?: unknown
}

/** Containers are cloned (the engine mutates returned docs in place), leaves are kept. */
export const cloneTree = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v.map(cloneTree)
  }
  if (isPlain(v)) {
    const out: Record<PropertyKey, unknown> =
      Object.getPrototypeOf(v) === null ? Object.create(null) : {}
    for (const key of Reflect.ownKeys(v)) {
      out[key as string] = cloneTree(v[key as string])
    }
    return out
  }
  return v
}

export class Run {
  depth = 0
  events: Event[] = []
  ids = new WeakMap<object, number>()
  /** objects of the tape / inputs whose identity in outcomes is reported by name */
  known = new Map<object, string>()
  label: string
  nextId = 1
  /** objects `wrap` never proxies or descends into (the adapter, models) */
  opaque = new WeakSet<object>()
  pendingPaginate = 0
  proxies = new WeakMap<object, object>()
  recording = true
  tick: null | number = null

  constructor(label: string) {
    this.label = label
  }

  /** Snapshot of a value (structure, classes, identity numbers by first appearance in this run). */
  describe(v: unknown): unknown {
    return this.quiet(() => describeValue(this, v, new Set(), 0))
  }

  id(o: object): number {
    let id = this.ids.get(o)
    if (id === undefined) {
      id = this.nextId++
      this.ids.set(o, id)
    }
    return id
  }

  log(kind: string, ...detail: unknown[]) {
    if (this.recording) {
      this.events.push([this.tick, kind, ...detail])
    }
  }

  /** Runs `fn` without recording (snapshots read through the recording proxies). */
  quiet<T>(fn: () => T): T {
    const was = this.recording
    this.recording = false
    try {
      return fn()
    } finally {
      this.recording = was
    }
  }

  /** A recording proxy around every plain object reachable from `v` (arrays stay plain). */
  wrap<T>(v: T, label: string): T {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        v[i] = this.wrap(v[i], `${label}[${i}]`)
      }
      return v
    }
    if (!isPlain(v) || this.opaque.has(v)) {
      return v
    }
    const cached = this.proxies.get(v)
    if (cached) {
      return cached as T
    }
    for (const key of Reflect.ownKeys(v)) {
      const desc = Object.getOwnPropertyDescriptor(v, key)!
      if ('value' in desc) {
        ;(v as Any)[key] = this.wrap(desc.value, `${label}.${String(key)}`)
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const run = this
    const proxy = new Proxy(v, {
      defineProperty(t, k, d) {
        run.log('define', label, String(k), run.describe(d.value))
        return Reflect.defineProperty(t, k, d)
      },
      deleteProperty(t, k) {
        run.log('delete', label, String(k))
        return Reflect.deleteProperty(t, k)
      },
      get(t, k, r) {
        run.log('get', label, String(k))
        return Reflect.get(t, k, r)
      },
      getOwnPropertyDescriptor(t, k) {
        run.log('gopd', label, String(k))
        return Reflect.getOwnPropertyDescriptor(t, k)
      },
      has(t, k) {
        run.log('has', label, String(k))
        return Reflect.has(t, k)
      },
      ownKeys(t) {
        run.log('ownKeys', label)
        return Reflect.ownKeys(t)
      },
      set(t, k, value, r) {
        run.log('set', label, String(k), run.describe(value))
        return Reflect.set(t, k, value, r)
      },
    })
    this.proxies.set(v, proxy)
    this.known.set(proxy, label)
    return proxy as T
  }
}

const describeValue = (run: Run, v: unknown, stack: Set<object>, depth: number): unknown => {
  switch (typeof v) {
    case 'bigint':
      return { $bigint: String(v) }
    case 'boolean':
    case 'string':
      return v
    case 'function':
      return { $fn: (v as Any).name, $id: run.id(v as object) }
    case 'number':
      if (Object.is(v, -0)) {
        return { $num: '-0' }
      }
      return Number.isFinite(v) ? v : { $num: String(v) }
    case 'symbol':
      return { $symbol: String(v) }
    case 'undefined':
      return { $undefined: true }
  }
  if (v === null) {
    return null
  }
  const o = v as Any
  const id = run.id(o)
  const known = run.known.get(o)
  if (stack.has(o)) {
    return { $cycle: id }
  }
  if (depth > 40) {
    return { $deep: id }
  }
  // real bson values: `_bsontype` from the class prototype (a forged own `_bsontype` is plain data)
  const bsontype = Object.prototype.hasOwnProperty.call(o, '_bsontype') ? undefined : o._bsontype
  if (bsontype === 'ObjectId') {
    return { $id: id, $oid: o.toHexString() }
  }
  if (o instanceof Date) {
    return { $date: Number.isNaN(o.getTime()) ? 'Invalid' : o.toISOString(), $id: id }
  }
  if (o instanceof RegExp) {
    return { $id: id, $regex: String(o) }
  }
  if (Buffer.isBuffer(o)) {
    return { $buffer: o.toString('base64'), $id: id }
  }
  if (o instanceof Promise) {
    return { $id: id, $promise: true }
  }
  if (o instanceof Error) {
    return { $error: o.name, $id: id, class: o.constructor?.name, message: o.message }
  }
  if (typeof bsontype === 'string') {
    return { $bson: bsontype, $id: id, class: o.constructor?.name, value: String(o) }
  }
  if (o.constructor?.name === 'ClientSession') {
    return { $id: id, $session: true }
  }
  if (typeof o.modelName === 'string' && typeof o.find === 'function') {
    return { $id: id, $model: o.modelName }
  }
  stack.add(o)
  try {
    if (Array.isArray(o)) {
      return {
        $id: id,
        ...(known ? { $known: known } : {}),
        items: o.map((item: unknown) => describeValue(run, item, stack, depth + 1)),
      }
    }
    const proto = Object.getPrototypeOf(o)
    const entries: unknown[] = []
    for (const key of Reflect.ownKeys(o)) {
      const desc = Object.getOwnPropertyDescriptor(o, key)!
      const value =
        'value' in desc ? describeValue(run, desc.value, stack, depth + 1) : { $accessor: true }
      entries.push(desc.enumerable ? [String(key), value] : [String(key), value, 'non-enumerable'])
    }
    return {
      $id: id,
      ...(known ? { $known: known } : {}),
      ...(proto === Object.prototype
        ? {}
        : { $class: proto === null ? null : proto.constructor?.name }),
      entries,
    }
  } finally {
    stack.delete(o)
  }
}

/** Tape replay: the i-th top-level model call gets the i-th entry. */
export class Tape {
  entries: TapeEntry[]
  index = 0
  mismatches: string[] = []

  constructor(entries: TapeEntry[]) {
    this.entries = entries
  }

  next(label: string, method: string): unknown {
    const entry = this.entries[this.index++]
    if (!entry || entry.label !== label || entry.method !== method) {
      const message = `tape mismatch at ${this.index - 1}: got ${label}.${method}, tape has ${entry ? `${entry.label}.${entry.method}` : 'nothing'}`
      this.mismatches.push(message)
      return Promise.reject(new Error(message))
    }
    const settle = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      let chain = Promise.resolve()
      for (let i = 0; i < (entry.delay ?? 0); i++) {
        chain = chain.then(() => {})
      }
      void chain.then(() => {
        if ('error' in entry) {
          reject(entry.error)
        } else {
          resolve(cloneTree(entry.value))
        }
      })
    }
    // `paginate` returns a native promise, the other methods mongoose Query / Aggregate thenables
    if (method === 'paginate') {
      return new Promise(settle)
    }
    // like mongoose `Query.prototype.then` / `Aggregate.prototype.then`: `this.exec().then(...)`
    return {
      then(resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return new Promise(settle).then(resolve, reject)
      },
    }
  }
}

/** Wraps a real model call's result so its settlement is recorded into `capture`. */
const captureResult = (
  result: unknown,
  onOk: (v: unknown) => void,
  onErr: (e: unknown) => void,
): unknown => {
  if (result instanceof Promise) {
    return result.then(
      (v) => {
        onOk(v)
        return v
      },
      (e) => {
        onErr(e)
        throw e
      },
    )
  }
  if (result && typeof (result as Any).then === 'function') {
    const target = result as Any
    const proxy: Any = new Proxy(target, {
      get(t, k) {
        if (k === 'then') {
          return (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            t.then(
              (v: unknown) => {
                onOk(v)
                return resolve ? resolve(v) : v
              },
              (e: unknown) => {
                onErr(e)
                if (reject) {
                  return reject(e)
                }
                throw e
              },
            )
        }
        const value = Reflect.get(t, k, t)
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            const out = value.apply(t, args)
            return out === t ? proxy : out
          }
        }
        return value
      },
    })
    return proxy
  }
  onOk(result)
  return result
}

/** A spy around a mongoose model: method calls are events; `tape` replays, otherwise real + capture. */
export const spyModel = ({
  capture,
  label,
  model,
  run,
  tape,
}: {
  capture?: TapeEntry[]
  label: string
  model: Any
  run: Run
  tape?: Tape
}) => {
  if (!model) {
    return model
  }
  const proxy: Any = new Proxy(model, {
    get(t, k) {
      const value = Reflect.get(t, k)
      if (typeof value !== 'function' || typeof k !== 'string' || !MODEL_METHODS.has(k)) {
        return value
      }
      return function (this: unknown, ...args: unknown[]) {
        const nested = run.depth > 0 || run.pendingPaginate > 0
        run.log(
          'call',
          label,
          k,
          nested,
          args.map((a) => run.describe(a)),
          this === proxy,
        )
        if (tape && !nested) {
          return tape.next(label, k)
        }
        run.depth++
        let result: unknown
        try {
          result = Reflect.apply(value, t, args)
        } finally {
          run.depth--
        }
        if (nested || !capture) {
          return result
        }
        const entry: TapeEntry = { label, method: k }
        capture.push(entry)
        if (k === 'paginate') {
          run.pendingPaginate++
        }
        return captureResult(
          result,
          (v) => {
            if (k === 'paginate') {
              run.pendingPaginate--
            }
            entry.value = cloneTree(v)
          },
          (e) => {
            if (k === 'paginate') {
              run.pendingPaginate--
            }
            entry.error = e
          },
        )
      }
    },
  })
  return proxy
}

/** Starts the microtask pump that stamps events with ticks; returns its stop function. */
export const startPump = (run: Run, max = 100_000) => {
  let alive = true
  run.tick = 0
  void (async () => {
    for (let i = 0; i < max && alive; i++) {
      await null
      run.tick = (run.tick ?? 0) + 1
    }
  })()
  return () => {
    alive = false
  }
}

/**
 * The recording adapter view: reads of adapter properties are events, `collections` / `versions`
 * / `globals` / `sessions` are per-run objects (spied models, the case's sessions), `overrides`
 * replace adapter properties (`useJoinAggregations`, `collation`, ...).
 */
export const adapterView = ({
  adapter,
  capture,
  overrides,
  run,
  sessions,
  tape,
}: {
  adapter: Any
  capture?: TapeEntry[]
  overrides: Record<string, unknown>
  run: Run
  sessions: Record<string, unknown>
  tape?: Tape
}) => {
  const spyMap = (kind: string, models: Record<string, Any>) => {
    const out: Record<string, Any> = {}
    for (const [slug, model] of Object.entries(models ?? {})) {
      out[slug] = spyModel({ capture, label: `${kind}.${slug}`, model, run, tape })
    }
    return run.wrap(out, `adapter.${kind}`)
  }
  const local: Record<string, unknown> = {
    collections: spyMap('collections', adapter.collections),
    globals: spyModel({ capture, label: 'globals', model: adapter.globals, run, tape }),
    sessions: run.wrap(sessions, 'adapter.sessions'),
    versions: spyMap('versions', adapter.versions),
    ...overrides,
  }
  const view = new Proxy(adapter, {
    get(t, k) {
      run.log('adapter', String(k))
      if (typeof k === 'string' && k in local) {
        return local[k]
      }
      return Reflect.get(t, k)
    },
    set(t, k, v) {
      run.log('adapter.set', String(k), run.describe(v))
      if (typeof k === 'string' && k in local) {
        local[k] = v
        return true
      }
      return Reflect.set(t, k, v)
    },
  })
  run.known.set(view, 'adapter')
  return { local, view }
}

/** First differing index of two event lists (for readable failures). */
export const firstDifference = (a: unknown[], b: unknown[]) => {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = JSON.stringify(a[i])
    const y = JSON.stringify(b[i])
    if (x !== y) {
      return { index: i, ts: a[i], rs: b[i], context: a.slice(Math.max(0, i - 3), i) }
    }
  }
  return null
}
