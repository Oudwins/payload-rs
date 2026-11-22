/**
 * The PAYLOAD_ENGINE switch code of the database adapters (review-defaultpath-sol.md items 1 and 5):
 *
 * - `PAYLOAD_ENGINE=ts`, a consumer that replaced the sqlite adapter's `init` must not make
 *   `connect` import engine-rs or add a tick before upstream's `createClient` (the trace is
 *   upstream's: the client config is read synchronously, before `connect` returns);
 * - flags unset: the Rust engine is selected (the default), as with `PAYLOAD_ENGINE=rs`;
 * - `PAYLOAD_ENGINE=rs`, engine module not loaded yet when `config.db.init` runs: a consumer
 *   wrapper of the built adapter's `init` survives every call and reaches the engine's `init`;
 * - `PAYLOAD_ENGINE=rs`, engine loaded: `init` is exactly `withRustEngine(adapterObj).init`.
 *
 * The engine entries are replaced by stubs (vi.mock on the files the adapters' runtime resolution
 * reaches), whose load is gated so the test decides whether `init` runs before or after it.
 * `RS_SWITCH_SQLITE_INDEX` / `RS_SWITCH_SQLITE_CONNECT` / `RS_SWITCH_MONGODB_INDEX` may name other
 * module files (the previous implementation, to show these tests fail on it).
 */
import { afterEach, expect, vi } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

type AnyFunction = (...args: any[]) => any
type Gate = { open: () => void; promise: Promise<void> }

const gates = vi.hoisted(() => {
  const create = () => {
    let open!: () => void
    const promise = new Promise<void>((resolve) => (open = resolve))
    return { open, promise }
  }
  return {
    create,
    current: { adapter: create(), mongodb: create(), sqlite: create() },
  }
})

/** Mimics `withRustEngine`: replaces the built adapter's `init` with the engine's. */
const stubWithEngine = vi.hoisted(() => (name: string) => (adapterObj: any) => ({
  ...adapterObj,
  init: (args: any) => {
    const adapter = adapterObj.init(args)
    adapter.rustInitCalls = 0
    adapter.rustInit = async function rustInit(this: any) {
      adapter.rustInitCalls++
    }
    adapter.init = adapter.rustInit
    adapter.engine = name
    return adapter
  },
}))

vi.mock('../../../packages/engine-rs/src/adapter/index.ts', async () => {
  await gates.current.adapter.promise
  return {
    isRustEngineAdapter: (adapter: any) => adapter?.engine === 'sqlite',
    withRustEngine: stubWithEngine('sqlite'),
  }
})
vi.mock('../../../packages/engine-rs/src/sqlite/libsql.ts', async () => {
  await gates.current.sqlite.promise
  return { createClient: () => ({ rust: true }) }
})
vi.mock('../../../packages/engine-rs/src/mongo-adapter/index.ts', async () => {
  await gates.current.mongodb.promise
  return { withRustMongoEngine: stubWithEngine('mongodb') }
})

const sqliteIndex = process.env.RS_SWITCH_SQLITE_INDEX ?? '../../../packages/db-sqlite/src/index.js'
const sqliteConnect =
  process.env.RS_SWITCH_SQLITE_CONNECT ?? '../../../packages/db-sqlite/src/connect.js'
const mongodbIndex =
  process.env.RS_SWITCH_MONGODB_INDEX ?? '../../../packages/db-mongodb/src/index.js'

const savedEnv = { ...process.env }
const engineMarker = Symbol.for('@payloadcms/engine-rs')

afterEach(() => {
  for (const key of ['PAYLOAD_ENGINE', 'PAYLOAD_CORE_ENGINE']) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  gates.current = { adapter: gates.create(), mongodb: gates.create(), sqlite: gates.create() }
  vi.restoreAllMocks()
  vi.resetModules()
})

const fakePayload = () => ({
  config: { collections: [], globals: [] },
  logger: { error: () => {}, info: () => {}, warn: () => {} },
})

const openAll = () => {
  for (const gate of Object.values(gates.current) as Gate[]) {
    gate.open()
  }
}

/** Polls (the module loads asynchronously) until `build()` returns an engine adapter. */
const untilEngineAdapter = async (build: () => any) => {
  let adapter: any
  await vi.waitFor(
    () => {
      adapter = build()
      expect(adapter.engine).toBeDefined()
    },
    { interval: 5, timeout: 10_000 },
  )
  return adapter
}

test.suite('PAYLOAD_ENGINE switch of the database adapters', {}, () => {
  test('should run upstream connect timing for a replaced sqlite init with PAYLOAD_ENGINE=ts', async () => {
    process.env.PAYLOAD_ENGINE = 'ts'
    delete process.env.PAYLOAD_CORE_ENGINE
    expect((globalThis as any)[engineMarker]).toBeUndefined()
    const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule')
    const { connect } = await import(/* @vite-ignore */ sqliteConnect)

    const trace: string[] = []
    const adapter = {
      init: async () => {}, // a consumer's replacement of the drizzle init
      payload: fakePayload(),
      get clientConfig() {
        trace.push('client config')
        throw new Error('stop before opening a database')
      },
    }
    const result = connect.call(adapter)
    trace.push('returned')
    await result.then(
      () => trace.push('resolved'),
      () => trace.push('rejected'),
    )

    expect(trace).toEqual(['client config', 'returned', 'rejected'])
    expect(getBuiltinModule).not.toHaveBeenCalled()
    expect((globalThis as any)[engineMarker]).toBeUndefined()
  })

  test('should select the Rust sqlite engine with the flags unset', async () => {
    delete process.env.PAYLOAD_ENGINE
    delete process.env.PAYLOAD_CORE_ENGINE
    openAll()
    const { sqliteAdapter } = await import(/* @vite-ignore */ sqliteIndex)
    const adapter = await untilEngineAdapter(() =>
      sqliteAdapter({ client: { url: 'file::memory:' } }).init({ payload: fakePayload() }),
    )

    expect(adapter.engine).toBe('sqlite')
  })

  test('should select the Rust mongodb engine with the flags unset', async () => {
    delete process.env.PAYLOAD_ENGINE
    delete process.env.PAYLOAD_CORE_ENGINE
    openAll()
    const { mongooseAdapter } = await import(/* @vite-ignore */ mongodbIndex)
    const adapter = await untilEngineAdapter(() =>
      mongooseAdapter({ url: 'mongodb://localhost:1/never' }).init({ payload: fakePayload() }),
    )

    expect(adapter.engine).toBe('mongodb')
  })

  test('should keep a consumer init wrapper when the sqlite engine loads after config.db.init', async () => {
    process.env.PAYLOAD_ENGINE = 'rs'
    const { sqliteAdapter } = await import(/* @vite-ignore */ sqliteIndex)
    const adapterObj = sqliteAdapter({ client: { url: 'file::memory:' } })
    const adapter = adapterObj.init({ payload: fakePayload() })
    expect(adapter.engine).toBeUndefined()

    let consumerCalls = 0
    const wrapped: AnyFunction = adapter.init
    const consumerInit = async function (this: unknown) {
      consumerCalls++
      return wrapped.call(this)
    }
    adapter.init = consumerInit

    openAll()
    await adapter.init()
    await adapter.init()

    expect(adapter.engine).toBe('sqlite')
    expect(consumerCalls).toBe(2)
    expect(adapter.rustInitCalls).toBe(2)
    expect(adapter.init).toBe(consumerInit)
  })

  test('should install the sqlite engine init itself when no consumer wrapped it', async () => {
    process.env.PAYLOAD_ENGINE = 'rs'
    const { sqliteAdapter } = await import(/* @vite-ignore */ sqliteIndex)
    const adapter = sqliteAdapter({ client: { url: 'file::memory:' } }).init({
      payload: fakePayload(),
    })

    openAll()
    await adapter.init()

    expect(adapter.engine).toBe('sqlite')
    expect(adapter.init).toBe(adapter.rustInit)
    expect(adapter.rustInitCalls).toBe(1)
  })

  test('should apply withRustEngine synchronously once the sqlite engine has loaded', async () => {
    process.env.PAYLOAD_ENGINE = 'rs'
    openAll()
    const { sqliteAdapter } = await import(/* @vite-ignore */ sqliteIndex)
    const adapter = await untilEngineAdapter(() =>
      sqliteAdapter({ client: { url: 'file::memory:' } }).init({ payload: fakePayload() }),
    )

    expect(adapter.engine).toBe('sqlite')
    expect(adapter.init).toBe(adapter.rustInit)
  })

  test('should give connect the Rust client for the engine adapter only', async () => {
    process.env.PAYLOAD_ENGINE = 'rs'
    openAll()
    const { sqliteAdapter } = await import(/* @vite-ignore */ sqliteIndex)
    await untilEngineAdapter(() =>
      sqliteAdapter({ client: { url: 'file::memory:' } }).init({ payload: fakePayload() }),
    )
    const { connect } = await import(/* @vite-ignore */ sqliteConnect)

    const clients: unknown[] = []
    for (const engine of ['sqlite', undefined]) {
      const adapter: Record<string, unknown> = {
        busyTimeout: 0,
        clientConfig: { url: 'file::memory:' },
        engine,
        payload: fakePayload(),
        push: false,
      }
      await connect.call(adapter, { hotReload: true }).catch(() => {})
      clients.push(adapter.client)
    }

    expect(clients[0]).toEqual({ rust: true })
    expect(clients[1]).not.toEqual({ rust: true })
    expect(typeof (clients[1] as { execute?: unknown }).execute).toBe('function')
  })

  test('should keep a consumer init wrapper when the mongodb engine loads after config.db.init', async () => {
    process.env.PAYLOAD_ENGINE = 'rs'
    const { mongooseAdapter } = await import(/* @vite-ignore */ mongodbIndex)
    const adapterObj = mongooseAdapter({ url: 'mongodb://localhost:1/never' })
    const adapter = adapterObj.init({ payload: fakePayload() })
    expect(adapter.engine).toBeUndefined()

    let consumerCalls = 0
    const wrapped: AnyFunction = adapter.init
    const consumerInit = async function (this: unknown) {
      consumerCalls++
      return wrapped.call(this)
    }
    adapter.init = consumerInit

    openAll()
    await adapter.init()
    await adapter.init()

    expect(adapter.engine).toBe('mongodb')
    expect(consumerCalls).toBe(2)
    expect(adapter.rustInitCalls).toBe(2)
    expect(adapter.init).toBe(consumerInit)
  })

  test('should apply withRustMongoEngine synchronously once the mongodb engine has loaded', async () => {
    process.env.PAYLOAD_ENGINE = 'rs'
    openAll()
    const { mongooseAdapter } = await import(/* @vite-ignore */ mongodbIndex)
    const adapter = await untilEngineAdapter(() =>
      mongooseAdapter({ url: 'mongodb://localhost:1/never' }).init({ payload: fakePayload() }),
    )

    expect(adapter.engine).toBe('mongodb')
    expect(adapter.init).toBe(adapter.rustInit)
  })
})
