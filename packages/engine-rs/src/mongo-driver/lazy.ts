/**
 * Lazy mongoose (MONGO_DRIVER_CONTRACT.md "Lazy mongoose"): with the driver lane, `connect` opens
 * only the Rust client. The adapter's mongoose objects (`connection`, `collections`, `versions`,
 * `globals`, `sessions`) stay the real ones, built by `init` on the unopened connection; they become
 * accessor properties, and the first read of any of them (user code, the mongoose lane, a
 * transaction, migrations) opens the mongoose connection (`openUri` with upstream's options).
 * Until it is open, mongoose buffers collection and model operations (its `bufferCommands`), so
 * they work as usual; a process that never touches them runs one pool, the Rust one.
 *
 * What upstream's `connect` does on the mongoose connection happens through the Rust client:
 *
 * - the replica set check (transactions off without one),
 * - `PAYLOAD_DROP_DATABASE` (`dropDatabase`, or the `useAlternativeDropDatabase` variant),
 * - what opening the connection triggers for every model (`Model.init()`: `createCollection` when
 *   `autoCreate`, `ensureIndexes` when `autoIndex`, in the background) and the awaited
 *   `ensureIndexes` of `ensureIndexes: true`: mongoose's own `createCollection` / `ensureIndexes`
 *   run, with only their I/O (`connection.createCollection`, `collection.createIndex`) sent to the
 *   Rust client as the Node driver's commands (`create`, `createIndexes`), so index specs and
 *   names are mongoose's.
 *
 * `beginTransaction` waits for the mongoose connection (sessions are mongoose's). Configurations the
 * lazy mode cannot reproduce (`afterOpenConnection`, `mongoMemoryServer`, `bufferCommands: false`)
 * connect mongoose eagerly, as does `PAYLOAD_MONGO_DRIVER=eager`.
 */
import { defaultBeginTransaction } from '../../../payload/src/database/defaultBeginTransaction.js'
import { type DriverLane } from './lane.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- mongoose objects are untyped here */
type Any = any

const lazyKeys = ['collections', 'connection', 'globals', 'sessions', 'versions'] as const

type LazyState = {
  isOpen: boolean
  /** `payload.db.connection` was assigned by user code: never opened by the lane. */
  isUserConnection: boolean
  opening?: Promise<void>
  openOptions: Record<string, unknown>
  values: Record<(typeof lazyKeys)[number], Any>
}

const states = new WeakMap<object, LazyState>()

/** Why `adapter` must connect mongoose eagerly, or `undefined`. */
export const eagerReason = (adapter: Any, mongoose: Any): string | undefined => {
  if (process.env.PAYLOAD_MONGO_DRIVER === 'eager') {
    return 'PAYLOAD_MONGO_DRIVER=eager'
  }
  if (typeof adapter.url !== 'string') {
    return 'no url'
  }
  if (adapter.afterOpenConnection) {
    return 'afterOpenConnection'
  }
  if (adapter.mongoMemoryServer) {
    return 'mongoMemoryServer'
  }
  if (
    adapter.connectOptions?.bufferCommands === false ||
    mongoose.get('bufferCommands') === false
  ) {
    return 'bufferCommands false'
  }
  if (!adapter.connection || adapter.connection.readyState !== 0) {
    return 'connection already open'
  }
  return undefined
}

/** Whether the adapter's mongoose connection is lazy and still unopened. */
export const isMongooseUnopened = (adapter: object): boolean => {
  const state = states.get(adapter)
  return Boolean(state && !state.isOpen && !state.opening)
}

/** Opens the adapter's mongoose connection (once), like upstream `connect` does. */
export const openMongoose = (adapter: Any): Promise<void> | undefined => {
  const state = states.get(adapter)
  if (!state || state.isOpen || state.isUserConnection) {
    return state?.opening
  }
  state.opening ??= (async () => {
    const connection = state.values.connection
    await connection.openUri(adapter.url, { ...state.openOptions })
    if (adapter.useAlternativeDropDatabase && connection.db) {
      // upstream connect's Firestore patch
      connection.db.dropDatabase = async function (this: Any): Promise<boolean> {
        const existingCollections = await this.listCollections().toArray()
        await Promise.all(
          existingCollections.map(async (collectionInfo: Any) => {
            const collection = this.collection(collectionInfo.name)
            await collection.deleteMany({})
          }),
        )
        return true
      }
      connection.dropDatabase = async function (this: Any) {
        await this.db?.dropDatabase()
      }
    }
    state.isOpen = true
  })()
  // failures reach the buffered operations (mongoose rejects them)
  state.opening.catch(() => {})
  return state.opening
}

/**
 * An object standing for `adapter` in the lane's own calls of upstream helpers: it inherits
 * everything from the adapter, but reads its mongoose objects without opening mongoose.
 */
export const createAdapterView = (adapter: Any): Any => {
  const view = Object.create(adapter)
  for (const key of lazyKeys) {
    Object.defineProperty(view, key, {
      configurable: true,
      enumerable: true,
      get: () => (states.get(adapter)?.values ?? adapter)[key],
      set(value) {
        adapter[key] = value
      },
    })
  }
  return view
}

const serverError = (lane: DriverLane, error: unknown) => {
  let description: Any
  try {
    description = JSON.parse((error as Error).message)
  } catch {
    return error
  }
  const { MongoServerError } = lane.mongoose.mongo
  return new MongoServerError({ ...description, errmsg: description.message })
}

const command = async (lane: DriverLane, doc: Record<string, unknown>) => {
  try {
    return lane.BSON.deserialize(
      await lane.binding.command(
        lane.clientID,
        null,
        lane.BSON.serialize(doc, { ignoreUndefined: false }),
      ),
    )
  } catch (error) {
    throw serverError(lane, error)
  }
}

/** The Node driver's `VALID_INDEX_OPTIONS` (operations/indexes.js). */
const validIndexOptions = new Set([
  '2dsphereIndexVersion',
  'background',
  'bits',
  'bucketSize',
  'collation',
  'default_language',
  'expireAfterSeconds',
  'hidden',
  'language_override',
  'max',
  'min',
  'name',
  'partialFilterExpression',
  'sparse',
  'storageEngine',
  'textIndexVersion',
  'unique',
  'version',
  'weights',
  'wildcardProjection',
])

/** `collection.createIndex(fields, options)` of the Node driver, on the Rust client. */
const createIndex = async (
  lane: DriverLane,
  collectionName: string,
  fields: Any,
  options: Any = {},
) => {
  const key = new Map(Object.entries(fields))
  const name = options.name ?? Array.from(key).flat().join('_')
  const index: Record<string, unknown> = {}
  for (const [option, value] of Object.entries(options)) {
    if (validIndexOptions.has(option)) {
      index[option === 'version' ? 'v' : option] = value
    }
  }
  const spec = { ...index, name, key }
  const createIndexes: Record<string, unknown> = { createIndexes: collectionName, indexes: [spec] }
  if (options.commitQuorum != null) {
    createIndexes.commitQuorum = options.commitQuorum
  }
  if (options.writeConcern != null) {
    createIndexes.writeConcern = options.writeConcern
  }
  await command(lane, createIndexes)
  return name
}

/** The Node driver's `db.createCollection(name, options)` options it does not send. */
const createCollectionIgnored = new Set([
  'bsonRegExp',
  'fieldsAsRaw',
  'raw',
  'readPreference',
  'session',
])

/**
 * Runs `fn` with mongoose's `connection.createCollection` and every model collection's
 * `createIndex` sent to the Rust client (own properties, removed when the last runner is done).
 */
let redirects = 0
const withRedirectedIo = async (
  lane: DriverLane,
  connection: Any,
  models: Any[],
  fn: () => Promise<unknown>,
) => {
  const collections = [...new Set(models.map((model) => model.collection))]
  if (redirects++ === 0) {
    connection.createCollection = async (name: string, options: Any = {}) => {
      const create: Record<string, unknown> = { create: name }
      for (const [option, value] of Object.entries(options ?? {})) {
        if (!createCollectionIgnored.has(option)) {
          create[option] = value
        }
      }
      await command(lane, create)
      return connection.collection(name)
    }
    for (const collection of collections) {
      collection.createIndex = (fields: Any, options: Any) =>
        createIndex(lane, collection.collectionName, fields, options)
    }
  }
  try {
    return await fn()
  } finally {
    if (--redirects === 0) {
      delete connection.createCollection
      for (const collection of collections) {
        delete collection.createIndex
      }
    }
  }
}

/** `utils.getOption(name, ...objects)`: the first non-nullish value. */
const getOption = (name: string, ...objects: Any[]) => {
  for (const object of objects) {
    if (object?.[name] != null) {
      return object[name]
    }
  }
  return undefined
}

/**
 * What `Model.init()` does once the connection is open, for every model of the connection
 * (`createCollection` when `autoCreate`, then `ensureIndexes` when `autoIndex`), with the
 * connection config `openUri` would set from `openOptions`.
 */
const initModels = (lane: DriverLane, connection: Any, openOptions: Any) => {
  const base = connection.base
  const config = {
    autoCreate: 'autoCreate' in openOptions ? Boolean(openOptions.autoCreate) : undefined,
    autoIndex: openOptions.autoIndex != null ? openOptions.autoIndex !== false : undefined,
  }
  return Promise.all(
    Object.values(connection.models as Record<string, Any>).map(async (model) => {
      try {
        if (getOption('autoCreate', model.schema.options, config, base.options)) {
          await model.createCollection()
        }
        if (getOption('autoIndex', model.schema.options, config, base.options)) {
          await model.ensureIndexes()
        }
      } catch {
        // `Model.init()` errors are handled by mongoose (`$init.catch`)
      }
    }),
  )
}

/**
 * upstream `connect` for a lazy adapter (the Rust client is up): everything except opening the
 * mongoose connection. Throws upstream's `Error: cannot connect to MongoDB: ...` on failures.
 */
export const connectLazily = async ({
  adapter,
  hotReload,
  lane,
}: {
  adapter: Any
  hotReload: boolean
  lane: { replicaSet: null | string } & DriverLane
}) => {
  const connection = adapter.connection
  const openOptions: Record<string, unknown> = { autoIndex: true, ...adapter.connectOptions }
  if (hotReload) {
    openOptions.autoIndex = false
  }
  const values = {} as LazyState['values']
  for (const key of lazyKeys) {
    values[key] = adapter[key]
  }
  const state: LazyState = { isOpen: false, isUserConnection: false, openOptions, values }
  states.set(adapter, state)
  for (const key of lazyKeys) {
    Object.defineProperty(adapter, key, {
      configurable: true,
      enumerable: true,
      get() {
        void openMongoose(adapter)
        return state.values[key]
      },
      set(value) {
        state.values[key] = value
        if (key === 'connection') {
          state.isUserConnection = true
        }
      },
    })
  }

  try {
    if (!lane.replicaSet) {
      adapter.transactionOptions = false
      adapter.beginTransaction = defaultBeginTransaction()
    } else {
      const beginTransaction = adapter.beginTransaction
      adapter.beginTransaction = async function (this: Any, ...args: unknown[]) {
        await openMongoose(this)
        return beginTransaction.apply(this, args)
      }
    }

    if (!hotReload && process.env.PAYLOAD_DROP_DATABASE === 'true') {
      adapter.payload.logger.info('---- DROPPING DATABASE ----')
      if (adapter.useAlternativeDropDatabase) {
        const listed = await command(lane, { listCollections: 1, nameOnly: true })
        await Promise.all(
          listed.cursor.firstBatch.map((info: Any) =>
            command(lane, { delete: info.name, deletes: [{ limit: 0, q: {} }] }),
          ),
        )
      } else {
        await command(lane, { dropDatabase: 1 })
      }
      adapter.payload.logger.info('---- DROPPED DATABASE ----')
    }

    const models = Object.values(connection.models as Record<string, Any>)
    // what opening the connection would start for every model (not awaited, like mongoose)
    void withRedirectedIo(lane, connection, models, () => initModels(lane, connection, openOptions))

    if (adapter.ensureIndexes) {
      await withRedirectedIo(lane, connection, models, () =>
        Promise.all(
          [
            ...adapter.payload.config.collections.flatMap((collection: Any) => [
              values.collections[collection.slug],
              values.versions[collection.slug],
            ]),
            ...adapter.payload.config.globals.map((global: Any) => values.versions[global.slug]),
          ].map(async (model) => {
            await model?.ensureIndexes()
          }),
        ),
      )
    }

    if (process.env.NODE_ENV === 'production' && adapter.prodMigrations) {
      await adapter.migrate({ migrations: adapter.prodMigrations })
    }
  } catch (err) {
    let msg = `Error: cannot connect to MongoDB.`
    if (typeof err === 'object' && err && 'message' in err && typeof err.message === 'string') {
      msg = `${msg} Details: ${err.message}`
    }
    adapter.payload.logger.error({ err, msg })
    throw new Error(`Error: cannot connect to MongoDB: ${msg}`)
  }
}
