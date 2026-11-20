/**
 * Scenarios of the live write differential. Each builds fresh live inputs per run (recording
 * proxies via `env.rec`) and calls the method(s) through the adapter view. Grouped by method; the
 * review findings each one covers are noted (MONGO_ENGINE_CONTRACT.md "Stage 1b decision",
 * .rs-baseline/review-mongo-joins-engine-glue-sol.md: engine items 1, 4, 6, 7, 8, glue items 2-7;
 * .rs-baseline/review-mongo-live-writes-sol.md: writes items 1-11, harness gaps A-H).
 *
 * Every scenario declares what it is for (`expect`, harness.ts `Expectation`): the TS outcome kind
 * and error class, landmarks that must be in the record (the model calls / events of the branch it
 * exists for) and landmarks that must not.
 */
import type { Env, Expectation, Scenario } from './harness.js'

import { resolveDbMongodbMongoose } from '../../../packages/engine-rs/src/mongo-live/host.js'
import { seed } from './harness.js'

const mongoose = resolveDbMongodbMongoose() as any

const [cat1, cat2] = seed.categories
const [post0, post1, post2] = seed.posts
const [job0, job1] = seed.jobs

const ok = (reach: string[], absent?: string[]): Expectation => ({ absent, outcome: 'ok', reach })
const err = (error: string, reach: string[], absent?: string[]): Expectation => ({
  absent,
  error,
  outcome: 'error',
  reach,
})

/** Collection name of a model (labels of the model spies). */
const coll = (env: Env, slug: string) => env.raw.collections[slug].collection.name as string
const vers = (env: Env, slug: string) => env.raw.versions[slug].collection.name as string

const t = (env: Env) =>
  function t(key: string) {
    env.log('t', key)
    return `T(${key})`
  }

/** A recorded `req` (payload, `t`, `locale`, plus `extra`). */
const req = (env: Env, extra: Record<string, unknown> = {}) =>
  env.rec('req', { context: {}, locale: 'en', payload: env.payload, t: t(env), ...extra })

const oid = (env: Env, hex: string) => new mongoose.Types.ObjectId(hex)

/** A built-in's frame (no source position: `at Object.assign (<anonymous>)`, `native`). */
const isBuiltinFrame = (line: string) => /\((<anonymous>|native)\)$/.test(line.trim())

/**
 * Whether the code calling the instrumented function (skipping built-ins in between, e.g. an
 * `Object.assign` that runs a setter) is code of a node_modules package.
 */
const callerInNodeModules = () => {
  const lines = new Error().stack?.split('\n') ?? []
  // [0] Error, [1] this function, [2] the instrumented function, [3...] its callers
  const caller = lines.slice(3).find((line) => !isBuiltinFrame(line))
  return caller?.includes('/node_modules/') ?? false
}

/** The stack frame text of the instrumented function's caller. */
const callerFrame = () => (new Error().stack?.split('\n') ?? [])[3] ?? ''

/** Replaces `obj[key]` for the run (restored after the snapshot). */
const patch = (env: Env, obj: any, key: PropertyKey, descriptor: PropertyDescriptor) => {
  const had = Object.prototype.hasOwnProperty.call(obj, key)
  const previous = Object.getOwnPropertyDescriptor(obj, key)
  Object.defineProperty(obj, key, { configurable: true, ...descriptor })
  env.finally(() => {
    if (had) {
      Object.defineProperty(obj, key, previous!)
    } else {
      delete obj[key]
    }
  })
}

/** Wraps the hydrated docs a `create` returns: logs `_id` / `updatedAt` / `toObject` reads and calls. */
const spyCreatedDocs = (env: Env, label: string) =>
  env.modelBehaviour(label, 'create', (original, args, self) =>
    original.apply(self, args).then((docs: any[]) =>
      docs.map((doc) => {
        const toObject = doc.toObject
        doc.toObject = function (...a: unknown[]) {
          env.log('doc.toObject called')
          return toObject.apply(this, a)
        }
        return new Proxy(doc, {
          get(target, key, receiver) {
            if (key === '_id' || key === 'updatedAt' || key === 'toObject') {
              env.log('doc get', key)
            }
            return Reflect.get(target, key, receiver)
          },
        })
      }),
    ),
  )

/** Makes model method `label.method` reject with `error` (after calling nothing). */
const rejectWith = (env: Env, label: string, method: string, error: unknown) =>
  env.modelBehaviour(label, method, () => Promise.reject(error))

/** An error object that records every trap (glue item 6: no eager property reads). */
const recordedError = (env: Env, props: Record<string, unknown>) => {
  const target = Object.assign(new Error(String(props.message ?? 'boom')), props)
  return env.inject(
    new Proxy(target, {
      get(o, key, receiver) {
        if (typeof key === 'string') {
          env.log('error get', key)
        }
        return Reflect.get(o, key, receiver)
      },
      has(o, key) {
        env.log('error has', String(key))
        return Reflect.has(o, key)
      },
    }),
  )
}

/** A live transaction under a fixed id (`adapter.sessions['tx-fixed']`), ended after the run. */
const withSession = async (env: Env, { inTransaction = true } = {}) => {
  const session = env.raw.connection.getClient().startSession()
  if (inTransaction) {
    session.startTransaction()
  }
  env.raw.sessions['tx-fixed'] = session
  env.finally(async () => {
    if (session.inTransaction()) {
      await session.abortTransaction()
    }
    await session.endSession()
    delete env.raw.sessions['tx-fixed']
  })
  return session
}

/**
 * Deterministic delivery of model results chosen by the scenario (harness gap B): each call of a
 * gated model method runs the real call and returns a promise the scenario settles with the real
 * outcome, in the order `release(...)` gives, once every real call settled.
 */
const gate = (env: Env, targets: [label: string, method: string][]) => {
  const calls: {
    real: Promise<unknown>
    reject: (e: unknown) => void
    resolve: (v: unknown) => void
  }[] = []
  for (const [label, method] of targets) {
    env.modelBehaviour(label, method, (original, args, self) => {
      const real = original.apply(self, args)
      return new Promise((resolve, reject) => {
        calls.push({ real, reject, resolve })
      })
    })
  }
  return {
    calls,
    /** settles call `i` (in call order) with its real outcome */
    release: async (i: number) => {
      const call = calls[i]!
      env.log('release', i)
      await call.real.then(call.resolve, call.reject)
    },
    /** waits (macrotasks) until `n` calls were made and their real results arrived */
    ready: async (n: number) => {
      for (let tries = 0; calls.length < n && tries < 10_000; tries++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      await Promise.allSettled(calls.map((c) => c.real))
    },
  }
}

/** Logs how many log entries job `hex` has in the database (raw driver). */
const logJobLog = async (env: Env, hex: string) => {
  const doc = await env.raw.connection.db
    .collection(coll(env, 'payload-jobs'))
    .findOne({ _id: new mongoose.Types.ObjectId(hex) })
  env.log('log entries', doc?.log?.length ?? 0)
}

const postData = (env: Env, extra: Record<string, unknown> = {}) =>
  env.rec('data', {
    title: 'fresh',
    slug: { en: 'fresh-slug' },
    count: 3,
    rows: [{ label: 'a' }, { label: 'b' }],
    categories: [cat1, cat2],
    category: cat2,
    publishedAt: '2024-05-01T10:00:00.000Z',
    group: { inner: 'g' },
    ...extra,
  })

const create = (
  name: string,
  expect: Expectation,
  run: (env: Env) => Promise<unknown>,
  overrides?: Record<string, unknown>,
): Scenario => ({
  name: `create: ${name}`,
  expect,
  overrides,
  run,
})

const createPost = (env: Env) =>
  env.call('create', env.rec('args', { collection: 'posts', data: postData(env), req: req(env) }))

export const scenarios: Scenario[] = [
  // ------------------------------------------------------------------ create
  create(
    'plain post (mutations before the first await, clock reads)',
    ok([
      'set data.createdAt',
      'clock new',
      'model @posts.create',
      'settled @posts.create fulfilled',
      'settled call create fulfilled',
    ]),
    createPost,
  ),
  create(
    'createdAt given (no createdAt clock read)',
    ok(['model @posts.create'], ['set data.createdAt']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env, { createdAt: '2020-01-01T00:00:00.000Z' }),
          req: req(env),
        }),
      ),
  ),
  create(
    'returning false (no toObject; engine item 1 / glue item 3)',
    ok(['model @posts.create', 'settled @posts.create fulfilled'], ['log doc.toObject called']),
    (env) => {
      spyCreatedDocs(env, coll(env, 'posts'))
      return env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env),
          req: req(env),
          returning: false,
        }),
      )
    },
  ),
  create('returning true (toObject after create)', ok(['log doc.toObject called']), (env) => {
    spyCreatedDocs(env, coll(env, 'posts'))
    return createPost(env)
  }),
  create('without req', ok(['model @posts.create']), (env) =>
    env.call('create', env.rec('args', { collection: 'posts', data: postData(env) })),
  ),
  create('customID: valid hex string', ok(['set data._id', 'model @posts.create']), (env) =>
    env.call(
      'create',
      env.rec('args', {
        collection: 'posts',
        customID: '64b0000000000000000000aa',
        data: postData(env),
        req: req(env),
      }),
    ),
  ),
  create(
    'customID: invalid string',
    err('ValidationError', ['set data._id', 'settled @categories.create rejected']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'categories',
          customID: 'not-hex',
          data: env.rec('data', { name: 'n' }),
          req: req(env),
        }),
      ),
  ),
  create(
    'customID: number',
    err('ValidationError', ['set data._id', 'settled @categories.create rejected']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'categories',
          customID: 42,
          data: env.rec('data', { name: 'n' }),
          req: req(env),
        }),
      ),
  ),
  create('customIDType text', ok(['set data._id', 'model @custom-text.create']), (env) =>
    env.call(
      'create',
      env.rec('args', {
        collection: 'custom-text',
        data: env.rec('data', { id: 'my-text-id', title: 'x' }),
        req: req(env),
      }),
    ),
  ),
  create('customIDType number', ok(['set data._id', 'model @custom-number.create']), (env) =>
    env.call(
      'create',
      env.rec('args', {
        collection: 'custom-number',
        data: env.rec('data', { id: 99, title: 'x' }),
        req: req(env),
      }),
    ),
  ),
  create(
    'customIDType text duplicate _id (ValidationError path _id)',
    err('ValidationError', ['settled @custom-text.create rejected']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'custom-text',
          data: env.rec('data', { id: 'existing-text', title: 'dup' }),
          req: req(env),
        }),
      ),
  ),
  create(
    'allowIDOnCreate: hex string id',
    ok(['adapter allowIDOnCreate', 'set data._id', 'model @categories.create']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'categories',
          data: env.rec('data', { id: '64b0000000000000000000bb', name: 'n' }),
          req: req(env),
        }),
      ),
    { allowIDOnCreate: true },
  ),
  create(
    'allowIDOnCreate: real ObjectId id',
    ok(['adapter allowIDOnCreate', 'set data._id', 'model @categories.create']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'categories',
          data: env.rec('data', { id: oid(env, '64b0000000000000000000cc'), name: 'n' }),
          req: req(env),
        }),
      ),
    { allowIDOnCreate: true },
  ),
  create(
    'allowIDOnCreate: ObjectId-like object with toHexString (engine item 8)',
    err('BSONError', ['adapter allowIDOnCreate', 'get data.id'], ['model @categories.create']),
    (env) => {
      const idLike = {
        toHexString() {
          env.log('idLike.toHexString')
          return '64b0000000000000000000dd'
        },
      }
      return env.call(
        'create',
        env.rec('args', {
          collection: 'categories',
          data: env.rec('data', { id: idLike, name: 'n' }),
          req: req(env),
        }),
      )
    },
    { allowIDOnCreate: true },
  ),
  create(
    'allowIDOnCreate: object with an id buffer (bson ctor)',
    ok(['adapter allowIDOnCreate', 'set data._id', 'model @categories.create']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'categories',
          data: env.rec('data', { id: { id: Buffer.from('0123456789ab') }, name: 'n' }),
          req: req(env),
        }),
      ),
    { allowIDOnCreate: true },
  ),
  create(
    'allowIDOnCreate: invalid id (BSONError, logger.error, data.id read again)',
    err('BSONError', ['log logger.error'], ['model @categories.create']),
    (env) => {
      const logger = env.payload.logger as any
      patch(env, logger, 'error', {
        value(msg: unknown) {
          env.log('logger.error', msg)
        },
        writable: true,
      })
      let reads = 0
      const data = env.rec('data', { name: 'n' }) as any
      Object.defineProperty(data, 'id', {
        configurable: true,
        enumerable: true,
        get() {
          reads++
          return `bad-${reads}`
        },
      })
      return env.call('create', env.rec('args', { collection: 'categories', data, req: req(env) }))
    },
    { allowIDOnCreate: true },
  ),
  create(
    'allowIDOnCreate: Types.ObjectId resolved before data.id is read (writes item 2)',
    ok(['log data.id read 2', 'log Types.ObjectId read', 'model @categories.create']),
    (env) => {
      const Types = mongoose.Types
      const ObjectId = Types.ObjectId
      patch(env, Types, 'ObjectId', {
        get() {
          if (!callerInNodeModules()) {
            env.log('Types.ObjectId read')
          }
          return ObjectId
        },
      })
      let reads = 0
      const data = env.rec('data', { name: 'n' }) as any
      Object.defineProperty(data, 'id', {
        configurable: true,
        enumerable: true,
        get() {
          env.log('data.id read', ++reads)
          return '64b0000000000000000000ee'
        },
      })
      return env.call('create', env.rec('args', { collection: 'categories', data, req: req(env) }))
    },
    { allowIDOnCreate: true },
  ),
  create(
    'allowIDOnCreate: Types.ObjectId replaced while data.id is read (writes item 2)',
    ok(['log data.id read 2', 'set data._id', 'model @categories.create'], ['log logger.error']),
    (env) => {
      const Types = mongoose.Types
      const ObjectId = Types.ObjectId
      const logger = env.payload.logger as any
      patch(env, logger, 'error', {
        value(msg: unknown) {
          env.log('logger.error', msg)
        },
        writable: true,
      })
      env.finally(() => {
        Types.ObjectId = ObjectId
      })
      let reads = 0
      const data = env.rec('data', { name: 'n' }) as any
      Object.defineProperty(data, 'id', {
        configurable: true,
        enumerable: true,
        get() {
          env.log('data.id read', ++reads)
          if (reads === 2) {
            Types.ObjectId = function Replaced() {
              throw env.inject(new Error('replaced constructor'))
            }
          }
          return '64b0000000000000000000ef'
        },
      })
      return env
        .call('create', env.rec('args', { collection: 'categories', data, req: req(env) }))
        .finally(() => {
          Types.ObjectId = ObjectId
        })
    },
    { allowIDOnCreate: true },
  ),
  create(
    'duplicate unique title (ValidationError, req.t)',
    err('ValidationError', ['settled @posts.create rejected', 'log t']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env, { title: 'post 1' }),
          req: req(env),
        }),
      ),
  ),
  create(
    'duplicate localized slug in es (locale stripped)',
    err('ValidationError', ['settled @posts.create rejected']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env, { slug: { en: 'other', es: 'entrada-2' } }),
          req: req(env, { locale: 'all' }),
        }),
      ),
  ),
  create(
    'duplicate: req.payload with another localization (engine item 4 / glue item 7)',
    err('ValidationError', ['settled @posts.create rejected', 'get payloadStub.config']),
    (env) => {
      const stub = env.rec('payloadStub', {
        config: { localization: { localeCodes: ['es', 'xx'] } },
      })
      return env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env, { slug: { en: 'other', es: 'entrada-2' } }),
          req: req(env, { payload: stub }),
        }),
      )
    },
  ),
  create(
    'duplicate: req without payload (no locale strip)',
    err('ValidationError', ['settled @posts.create rejected', 'log t']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env, { slug: { en: 'post-0', es: 'otra' } }),
          req: env.rec('req', { t: t(env) }),
        }),
      ),
  ),
  create(
    'duplicate: without req (default message)',
    err('ValidationError', ['settled @posts.create rejected'], ['log t']),
    (env) =>
      env.call(
        'create',
        env.rec('args', { collection: 'posts', data: postData(env, { title: 'post 2' }) }),
      ),
  ),
  create(
    'error: code getter throws (glue item 6)',
    err('TypeError', ['log code getter']),
    (env) => {
      const getterError = env.inject(new TypeError('code getter'))
      const error = env.inject(new Error('driver'))
      Object.defineProperty(error, 'code', {
        get() {
          env.log('code getter')
          throw getterError
        },
      })
      rejectWith(env, coll(env, 'posts'), 'create', error)
      return createPost(env)
    },
  ),
  create(
    'error: recorded duplicate key error with keyValue',
    err('ValidationError', ['log error get', 'settled @posts.create rejected']),
    (env) => {
      rejectWith(
        env,
        coll(env, 'posts'),
        'create',
        recordedError(env, { code: 11000, keyValue: { 'slug.es': 'v' } }),
      )
      return createPost(env)
    },
  ),
  create(
    'error: duplicate key message only (extractFieldFromMessage)',
    err('ValidationError', ['log error get', 'settled @posts.create rejected']),
    (env) => {
      rejectWith(
        env,
        coll(env, 'posts'),
        'create',
        recordedError(env, {
          code: 11000,
          message: 'E11000 duplicate key error index: group.inner_1 dup key',
        }),
      )
      return createPost(env)
    },
  ),
  create(
    'error: duplicate key, keyValue getter counted',
    err('ValidationError', ['log keyValue read']),
    (env) => {
      const error: any = env.inject(new Error('dup'))
      error.code = 11000
      let reads = 0
      Object.defineProperty(error, 'keyValue', {
        get() {
          env.log('keyValue read', ++reads)
          return { 'title.es': 1 }
        },
      })
      rejectWith(env, coll(env, 'posts'), 'create', error)
      return createPost(env)
    },
  ),
  create(
    'error: code 11000 as a string (rethrown)',
    err('Error', ['log error get', 'settled @posts.create rejected'], ['log t']),
    (env) => {
      rejectWith(env, coll(env, 'posts'), 'create', recordedError(env, { code: '11000' }))
      return createPost(env)
    },
  ),
  create('error: thrown primitive', err('string', ['settled @posts.create rejected']), (env) => {
    rejectWith(env, coll(env, 'posts'), 'create', 'boom')
    return createPost(env)
  }),
  create(
    'error: req.t throws while building the ValidationError',
    err('RangeError', ['settled @posts.create rejected']),
    (env) => {
      const tError = env.inject(new RangeError('t'))
      return env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env, { title: 'post 0' }),
          req: env.rec('req', {
            payload: env.payload,
            t() {
              throw tError
            },
          }),
        }),
      )
    },
  ),
  create(
    'Model.create throws synchronously (handled like a rejection)',
    err('SyntaxError', ['model @posts.create'], ['settled @posts.create rejected']),
    (env) => {
      env.modelBehaviour(coll(env, 'posts'), 'create', () => {
        throw env.inject(new SyntaxError('sync'))
      })
      return createPost(env)
    },
  ),
  create(
    'Model.create resolves to a non-iterable (TypeError inside the try)',
    err('TypeError', ['settled @posts.create fulfilled']),
    (env) => {
      env.modelBehaviour(coll(env, 'posts'), 'create', () => Promise.resolve(5))
      return createPost(env)
    },
  ),
  create(
    'Model.create promise with a constructor getter (one read by the await; writes item 1 / gap A)',
    ok(['log constructor read 1', 'settled @posts.create fulfilled'], ['log constructor read 2']),
    (env) => {
      env.modelBehaviour(coll(env, 'posts'), 'create', (original, args, self) => {
        const real = original.apply(self, args)
        let reads = 0
        Object.defineProperty(real, 'constructor', {
          configurable: true,
          get() {
            env.log('constructor read', ++reads)
            if (reads > 1) {
              throw env.inject(new Error('second constructor read'))
            }
            return Promise
          },
        })
        return real
      })
      return createPost(env)
    },
  ),
  create(
    'toObject error with code 11000 is not handled (engine item 1)',
    err('Error', ['settled @posts.create fulfilled'], ['log error has']),
    (env) => {
      env.modelBehaviour(coll(env, 'posts'), 'create', (original, args, self) =>
        original.apply(self, args).then((docs: any[]) => {
          docs[0].toObject = () => {
            throw recordedError(env, { code: 11000, keyValue: { title: 1 } })
          }
          return docs
        }),
      )
      return createPost(env)
    },
  ),
  create(
    'model swapped while getSession awaits (Model captured at the start, glue item 5)',
    ok(['log swap model', 'model @posts.create'], ['model @categories.create']),
    (env) => {
      const original = env.raw.collections.posts
      const transactionID = Promise.resolve(undefined).then(() => {
        env.log('swap model')
        env.raw.collections.posts = env.raw.collections.categories
      })
      env.finally(() => {
        env.raw.collections.posts = original
      })
      return env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env),
          req: req(env, { transactionID }),
        }),
      )
    },
  ),
  create(
    'transactionID assigned after the call starts (seen at getSession)',
    ok(['set req.transactionID', 'model @posts.create']),
    async (env) => {
      const session = await withSession(env)
      const r = req(env) as any
      const p = env.call(
        'create',
        env.rec('args', { collection: 'posts', data: postData(env), req: r }),
      )
      r.transactionID = 'tx-fixed'
      env.extra.sessionUsed = session.inTransaction()
      return p
    },
  ),
  create(
    'transaction: string transactionID',
    ok(['get req.transactionID', 'model @posts.create']),
    async (env) => {
      await withSession(env)
      return env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env),
          req: req(env, { transactionID: 'tx-fixed' }),
        }),
      )
    },
  ),
  create(
    'transaction: promised transactionID (read twice)',
    ok(['get req.transactionID', 'model @posts.create']),
    async (env) => {
      await withSession(env)
      return env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env),
          req: req(env, { transactionID: Promise.resolve('tx-fixed') }),
        }),
      )
    },
  ),
  create('transaction: orphaned session is dropped', ok(['model @posts.create']), async (env) => {
    await withSession(env, { inTransaction: false })
    const out = await env.call(
      'create',
      env.rec('args', {
        collection: 'posts',
        data: postData(env),
        req: req(env, { transactionID: 'tx-fixed' }),
      }),
    )
    env.extra.sessionKept = 'tx-fixed' in env.raw.sessions
    return out
  }),
  create(
    'args undefined (destructuring TypeError)',
    err('TypeError', ['settled call create rejected'], ['adapter payload']),
    (env) => env.call('create', undefined),
  ),
  create(
    'args null',
    err('TypeError', ['settled call create rejected'], ['adapter payload']),
    (env) => env.call('create', null),
  ),
  create(
    'unknown collection (APIError)',
    err('APIError', ['adapter payload'], ['clock new']),
    (env) =>
      env.call(
        'create',
        env.rec('args', { collection: 'nope', data: env.rec('data', {}), req: req(env) }),
      ),
  ),
  create(
    'frozen data (strict TypeError on createdAt)',
    err('TypeError', ['clock new'], ['model @categories.create']),
    (env) =>
      env.call(
        'create',
        env.rec('args', {
          collection: 'categories',
          data: Object.freeze({ name: 'x' }),
          req: req(env),
        }),
      ),
  ),
  create(
    'data undefined',
    err('TypeError', ['adapter payload'], ['model @categories.create']),
    (env) => env.call('create', env.rec('args', { collection: 'categories', req: req(env) })),
  ),
  create(
    'concurrent creates, the duplicate settles first, others pending at the rejection (gap B)',
    err('ValidationError', [
      'log release',
      'settled call create rejected',
      'settled call create fulfilled',
      'quiescent',
    ]),
    async (env) => {
      const g = gate(env, [
        [coll(env, 'categories'), 'create'],
        [coll(env, 'posts'), 'create'],
      ])
      const all = Promise.all([
        env.call(
          'create',
          env.rec('a1', {
            collection: 'categories',
            data: env.rec('d1', { name: 'c1' }),
            req: req(env),
          }),
        ),
        env.call(
          'create',
          env.rec('a2', {
            collection: 'posts',
            data: postData(env, { title: 'post 0' }),
            req: req(env),
          }),
        ),
        env.call(
          'create',
          env.rec('a3', {
            collection: 'categories',
            data: env.rec('d3', { name: 'c3' }),
            req: req(env),
          }),
        ),
      ])
      all.catch(() => {})
      await g.ready(3)
      // the posts call (the duplicate) first; the others a macrotask later, after the rejection
      await g.release(1)
      await new Promise((resolve) => setImmediate(resolve))
      await g.release(2)
      await g.release(0)
      return all
    },
  ),
  create(
    'concurrent creates settled in reverse order (gap B)',
    ok(['log release', 'settled call create fulfilled']),
    async (env) => {
      const g = gate(env, [[coll(env, 'categories'), 'create']])
      const all = Promise.all(
        [1, 2, 3].map((n) =>
          env.call(
            'create',
            env.rec(`a${n}`, {
              collection: 'categories',
              data: env.rec(`d${n}`, { name: `c${n}` }),
              req: req(env),
            }),
          ),
        ),
      )
      await g.ready(3)
      void g.release(2)
      void g.release(1)
      void g.release(0)
      return all
    },
  ),
  create(
    'caller-retained arrays mutated by the write transform (gap D)',
    ok(['get data.categories', 'model @posts.create']),
    async (env) => {
      const data = postData(env) as any
      const categories = data.categories
      const rows = data.rows
      const out = await env.call(
        'create',
        env.rec('args', { collection: 'posts', data, req: req(env) }),
      )
      env.extra.categories = categories
      env.extra.rows = rows
      return out
    },
  ),
  create(
    'inherited session / timestamps setters are not run by the options literal (writes item 7)',
    ok(
      ['log probe session setter', 'model @posts.create'],
      ['log session setter', 'log timestamps setter'],
    ),
    (env) => {
      for (const key of ['session', 'timestamps']) {
        patch(env, Object.prototype, key, {
          set(this: any, v: unknown) {
            if (!callerInNodeModules()) {
              env.log((this as any).__probe ? `probe ${key} setter` : `${key} setter`)
            }
            Object.defineProperty(this, key, {
              configurable: true,
              enumerable: true,
              value: v,
              writable: true,
            })
          },
        })
      }
      const probe: any = { __probe: true }
      probe.session = 1
      return env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env),
          req: req(env),
          returning: false,
        }),
      )
    },
  ),
  create(
    'a throwing inherited session setter is not reached (writes item 7)',
    ok(['model @posts.create'], ['log session setter threw']),
    (env) => {
      patch(env, Object.prototype, 'session', {
        set(this: any, v: unknown) {
          if (!callerInNodeModules()) {
            env.log('session setter threw')
            throw env.inject(new Error('session setter'))
          }
          Object.defineProperty(this, 'session', {
            configurable: true,
            enumerable: true,
            value: v,
            writable: true,
          })
        },
      })
      return createPost(env)
    },
  ),

  // ------------------------------------------------------------------ createGlobal
  {
    name: 'createGlobal: settings',
    expect: ok(['model @globals.create', 'settled @globals.create fulfilled']),
    run: (env) =>
      env.call(
        'createGlobal',
        env.rec('args', {
          slug: 'settings',
          data: env.rec('data', { siteName: 's', featured: cat1 }),
          req: req(env),
        }),
      ),
  },
  {
    name: 'createGlobal: returning false (no toObject)',
    expect: ok(['model @globals.create'], ['log doc.toObject called']),
    run: (env) => {
      spyCreatedDocs(env, env.raw.globals.collection.name)
      return env.call(
        'createGlobal',
        env.rec('args', {
          slug: 'settings',
          data: env.rec('data', { siteName: 's' }),
          req: req(env),
          returning: false,
        }),
      )
    },
  },
  {
    name: 'createGlobal: unknown global',
    expect: err('APIError', ['adapter payload'], ['model @globals.create']),
    run: (env) =>
      env.call(
        'createGlobal',
        env.rec('args', { slug: 'nope', data: env.rec('data', {}), req: req(env) }),
      ),
  },

  // ------------------------------------------------------------------ createVersion / createGlobalVersion
  {
    name: 'createVersion: latest flip uses the hydrated doc, then toObject (engine item 1)',
    expect: ok([
      'model @v:posts.create',
      'log doc get',
      'model @v:posts.updateMany',
      'log doc.toObject called',
    ]),
    run: (env) => {
      spyCreatedDocs(env, vers(env, 'posts'))
      return env.call(
        'createVersion',
        env.rec('args', {
          autosave: false,
          collectionSlug: 'posts',
          parent: post0,
          req: req(env),
          versionData: env.rec('versionData', { title: 'v', categories: [cat1] }),
          updatedAt: '2031-01-01T00:00:00.000Z',
        }),
      )
    },
  },
  {
    name: 'createVersion: returning false (flip, no toObject)',
    expect: ok(['model @v:posts.updateMany'], ['log doc.toObject called']),
    run: (env) => {
      spyCreatedDocs(env, vers(env, 'posts'))
      return env.call(
        'createVersion',
        env.rec('args', {
          collectionSlug: 'posts',
          createdAt: '2030-06-01T00:00:00.000Z',
          parent: post0,
          publishedLocale: 'en',
          req: req(env),
          returning: false,
          snapshot: true,
          versionData: env.rec('versionData', { title: 'v' }),
        }),
      )
    },
  },
  {
    name: 'createVersion: flip rejects (no handleError)',
    expect: err('Error', ['settled @v:posts.updateMany rejected'], ['log error get']),
    run: (env) => {
      rejectWith(
        env,
        vers(env, 'posts'),
        'updateMany',
        recordedError(env, { code: 11000, keyValue: { latest: 1 } }),
      )
      return env.call(
        'createVersion',
        env.rec('args', {
          collectionSlug: 'posts',
          parent: post1,
          req: req(env),
          versionData: env.rec('versionData', {}),
        }),
      )
    },
  },
  {
    name: 'createGlobalVersion: latest flip and toObject',
    expect: ok(['model @v:settings.updateMany', 'log doc.toObject called']),
    run: (env) => {
      spyCreatedDocs(env, vers(env, 'settings'))
      return env.call(
        'createGlobalVersion',
        env.rec('args', {
          autosave: true,
          globalSlug: 'settings',
          req: req(env),
          versionData: env.rec('versionData', { siteName: 'gv', featured: cat2 }),
        }),
      )
    },
  },
  {
    name: 'createGlobalVersion: returning false',
    expect: ok(['model @v:settings.updateMany'], ['log doc.toObject called']),
    run: (env) => {
      spyCreatedDocs(env, vers(env, 'settings'))
      return env.call(
        'createGlobalVersion',
        env.rec('args', {
          globalSlug: 'settings',
          req: req(env),
          returning: false,
          versionData: env.rec('versionData', {}),
        }),
      )
    },
  },

  // ------------------------------------------------------------------ updateOne / upsert
  {
    name: 'updateOne: by id',
    expect: ok([
      'model @posts.findOneAndUpdate',
      'exec @posts.findOneAndUpdate',
      'settled @posts.findOneAndUpdate.exec fulfilled',
    ]),
    run: (env) =>
      env.call(
        'updateOne',
        env.rec('args', {
          id: post1,
          collection: 'posts',
          data: env.rec('data', { title: 'renamed', category: cat1 }),
          req: req(env),
        }),
      ),
  },
  {
    name: 'updateOne: operators ($inc, $push, $addToSet, $pull) and select',
    expect: ok(['model @posts.findOneAndUpdate', 'settled @posts.findOneAndUpdate.exec fulfilled']),
    run: (env) =>
      env.call(
        'updateOne',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', {
            count: { $inc: 5 },
            rows: { $push: [{ label: 'pushed' }] },
            categories: { $push: [cat2] },
          }),
          req: req(env),
          select: { title: true, count: true },
          where: { title: { equals: 'post 0' } },
        }),
      ),
  },
  {
    name: 'updateOne: $remove (pull)',
    expect: ok(['model @posts.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateOne',
        env.rec('args', {
          id: post0,
          collection: 'posts',
          data: env.rec('data', { categories: { $remove: [cat1] } }),
          req: req(env),
        }),
      ),
  },
  {
    name: 'updateOne: returning false (read transform on data)',
    expect: ok(['model @posts.updateOne'], ['model @posts.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateOne',
        env.rec('args', {
          id: post2,
          collection: 'posts',
          data: env.rec('data', { category: cat1, publishedAt: '2024-01-01T00:00:00.000Z' }),
          req: req(env),
          returning: false,
        }),
      ),
  },
  {
    name: 'updateOne: options spread before the await (getter reads)',
    expect: ok(['log maxTimeMS read', 'model @posts.findOneAndUpdate']),
    run: (env) => {
      const options = env.rec('options', { comment: 'c' }) as any
      Object.defineProperty(options, 'maxTimeMS', {
        enumerable: true,
        get: () => (env.log('maxTimeMS read'), 5000),
      })
      return env.call(
        'updateOne',
        env.rec('args', {
          id: post0,
          collection: 'posts',
          data: env.rec('data', { title: 'o' }),
          options,
          req: req(env),
        }),
      )
    },
  },
  {
    name: 'updateOne: transactionID assigned after the call starts (seen after buildQuery)',
    expect: ok(['set req.transactionID', 'model @posts.findOneAndUpdate']),
    run: async (env) => {
      await withSession(env)
      const r = req(env) as any
      const p = env.call(
        'updateOne',
        env.rec('args', {
          id: post0,
          collection: 'posts',
          data: env.rec('data', { title: 'tx' }),
          req: r,
        }),
      )
      r.transactionID = 'tx-fixed'
      const out = await p
      // the update ran in the transaction: not visible outside it
      env.extra.outside = await env.raw.connection.db
        .collection(env.raw.collections.posts.collection.name)
        .findOne({ title: 'tx' })
      return out
    },
  },
  {
    name: 'updateOne: no match (null)',
    expect: ok(['settled @posts.findOneAndUpdate.exec fulfilled']),
    run: (env) =>
      env.call(
        'updateOne',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { title: 'x' }),
          req: req(env),
          where: { title: { equals: 'none' } },
        }),
      ),
  },
  {
    name: 'updateOne: duplicate key (handleError)',
    expect: err('ValidationError', ['settled @posts.findOneAndUpdate.exec rejected', 'log t']),
    run: (env) =>
      env.call(
        'updateOne',
        env.rec('args', {
          id: post0,
          collection: 'posts',
          data: env.rec('data', { title: 'post 1' }),
          req: req(env),
        }),
      ),
  },
  {
    name: 'updateOne: returning false, transform error inside the try',
    expect: err('Error', ['settled @posts.updateOne fulfilled', 'log error has code']),
    run: (env) => {
      const data = env.rec('data', { title: 'x' }) as any
      // the getter appears once the update ran (mongoose's casting reads `data` too), so it throws in
      // the read transform that follows inside the try
      env.modelBehaviour(coll(env, 'posts'), 'updateOne', (original, args, self) =>
        original.apply(self, args).then((result: unknown) => {
          Object.defineProperty(data, 'category', {
            enumerable: true,
            get() {
              throw recordedError(env, { message: 'read transform getter' })
            },
          })
          return result
        }),
      )
      return env.call(
        'updateOne',
        env.rec('args', { id: post0, collection: 'posts', data, req: req(env), returning: false }),
      )
    },
  },
  {
    name: 'updateOne: Model.updateOne returns a custom thenable (awaited as is; gap A)',
    expect: ok(['log thenable.then', 'model @posts.updateOne']),
    run: (env) => {
      env.modelBehaviour(coll(env, 'posts'), 'updateOne', (original, args, self) => {
        const query = original.apply(self, args)
        return {
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            env.log('thenable.then', typeof resolve, typeof reject)
            query.then(resolve, reject)
          },
        }
      })
      return env.call(
        'updateOne',
        env.rec('args', {
          id: post0,
          collection: 'posts',
          data: env.rec('data', { title: 'thenable' }),
          req: req(env),
          returning: false,
        }),
      )
    },
  },
  {
    name: 'updateOne: current Object.keys runs the operator assembly (writes item 5)',
    expect: ok(['log Object.keys 5', 'model @posts.findOneAndUpdate'], ['log Object.keys 6']),
    run: (env) => {
      const keys = Object.keys
      let calls = 0
      patch(env, Object, 'keys', {
        value: function (o: object) {
          const frame = callerFrame()
          if (
            /\bassembleUpdateOps\b|db-mongodb\/src\/(updateOne|updateMany|updateJobs)\.ts/.test(
              frame,
            )
          ) {
            calls++
            env.log('Object.keys', calls, o)
          }
          return keys(o)
        },
        writable: true,
      })
      return env.call(
        'updateOne',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { title: 'keys' }),
          req: req(env),
          where: {},
        }),
      )
    },
  },
  {
    name: 'updateOne: a throwing Object.keys rejects before mongoose (writes item 5)',
    expect: err('Error', ['log Object.keys threw'], ['model @posts.findOneAndUpdate']),
    run: (env) => {
      const keys = Object.keys
      patch(env, Object, 'keys', {
        value: function (o: object) {
          const frame = callerFrame()
          if (
            /\bassembleUpdateOps\b|db-mongodb\/src\/(updateOne|updateMany|updateJobs)\.ts/.test(
              frame,
            )
          ) {
            env.log('Object.keys threw')
            throw env.inject(new Error('Object.keys'))
          }
          return keys(o)
        },
        writable: true,
      })
      return env.call(
        'updateOne',
        env.rec('args', {
          id: post0,
          collection: 'posts',
          data: env.rec('data', { title: 'keys' }),
          req: req(env),
        }),
      )
    },
  },
  {
    name: 'updateOne: an inherited $inc setter consumes the operator (writes item 6)',
    expect: ok(['log $inc setter', 'model @posts.findOneAndUpdate']),
    run: (env) => {
      patch(env, Object.prototype, '$inc', {
        set(_v: unknown) {
          if (!callerInNodeModules()) {
            env.log('$inc setter')
          }
        },
      })
      return env.call(
        'updateOne',
        env.rec('args', {
          id: post0,
          collection: 'posts',
          data: env.rec('data', { count: { $inc: 1 } }),
          req: req(env),
        }),
      )
    },
  },
  {
    name: 'updateOne: a getter-only inherited $set makes the strict assignment throw (writes item 6)',
    expect: err('TypeError', ['adapter payload'], ['model @posts.findOneAndUpdate']),
    run: (env) => {
      patch(env, Object.prototype, '$set', {
        get() {
          return undefined
        },
      })
      return env.call(
        'updateOne',
        env.rec('args', {
          id: post0,
          collection: 'posts',
          data: env.rec('data', { count: { $inc: 1 } }),
          req: req(env),
        }),
      )
    },
  },
  {
    name: 'upsert: creates',
    expect: ok(['adapter updateOne', 'model @posts.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'upsert',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { title: 'upserted', count: 1 }),
          req: req(env),
          where: { title: { equals: 'upserted' } },
        }),
      ),
  },
  {
    name: 'upsert: updates an existing doc',
    expect: ok(['adapter updateOne', 'model @posts.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'upsert',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { count: 50 }),
          req: req(env),
          select: { count: true },
          where: { title: { equals: 'post 2' } },
        }),
      ),
  },
  {
    name: 'upsert: this.updateOne is a user override',
    expect: ok(
      ['adapter updateOne', 'settled call upsert fulfilled'],
      ['model @posts.findOneAndUpdate'],
    ),
    overrides: {
      updateOne(this: unknown, args: any) {
        return Promise.resolve({ overridden: true, sawUpsert: args.options?.upsert })
      },
    },
    run: (env) =>
      env.call(
        'upsert',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', {}),
          req: req(env),
          where: { title: { equals: 'x' } },
        }),
      ),
  },

  // ------------------------------------------------------------------ updateMany
  {
    name: 'updateMany: where, sort default',
    expect: ok(['model @posts.updateMany', 'model @posts.find']),
    run: (env) =>
      env.call(
        'updateMany',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { category: cat2 }),
          req: req(env),
          where: { count: { greater_than_equal: 1 } },
        }),
      ),
  },
  {
    name: 'updateMany: limit, sort, $inc',
    expect: ok(['model @posts.find', 'model @posts.updateMany']),
    run: (env) =>
      env.call(
        'updateMany',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { count: { $inc: 10 } }),
          limit: 2,
          req: req(env),
          sort: '-title',
          where: { title: { exists: true } },
        }),
      ),
  },
  {
    name: 'updateMany: limit with no candidates (null inside the try)',
    expect: ok(['model @posts.find'], ['model @posts.updateMany']),
    run: (env) =>
      env.call(
        'updateMany',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { title: 'none' }),
          limit: 3,
          req: req(env),
          where: { title: { equals: 'missing' } },
        }),
      ),
  },
  {
    name: 'updateMany: near constraint (no sort)',
    expect: ok(
      ['model @posts.updateMany', 'settled @posts.updateMany.exec fulfilled'],
      ['model @posts.find'],
    ),
    run: (env) =>
      env.call(
        'updateMany',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { count: 1 }),
          req: req(env),
          returning: false,
          where: { and: [{ location: { near: '10,20,1000000,0' } }] },
        }),
      ),
  },
  {
    name: 'updateMany: returning false, duplicate key',
    expect: err('ValidationError', ['settled @posts.updateMany.exec rejected']),
    run: (env) =>
      env.call(
        'updateMany',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { title: 'same' }),
          req: req(env),
          returning: false,
          where: { count: { greater_than_equal: 0 } },
        }),
      ),
  },
  {
    name: 'updateMany: select and options',
    expect: ok(['get options.comment', 'model @posts.updateMany', 'model @posts.find']),
    run: (env) =>
      env.call(
        'updateMany',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { group: { inner: 'many' } }),
          options: env.rec('options', { comment: 'm' }),
          req: req(env),
          select: { group: true },
          where: { id: { in: [post0, post1] } },
        }),
      ),
  },
  {
    name: 'updateMany: an inherited $inc setter consumes the operator (writes item 6)',
    expect: ok(['log $inc setter', 'model @posts.updateMany']),
    run: (env) => {
      patch(env, Object.prototype, '$inc', {
        set(_v: unknown) {
          if (!callerInNodeModules()) {
            env.log('$inc setter')
          }
        },
      })
      return env.call(
        'updateMany',
        env.rec('args', {
          collection: 'posts',
          data: env.rec('data', { count: { $inc: 1 } }),
          req: req(env),
          where: { count: { equals: 1 } },
        }),
      )
    },
  },

  // ------------------------------------------------------------------ updateGlobal
  {
    name: 'updateGlobal: returning doc with select',
    expect: ok(['model @globals.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateGlobal',
        env.rec('args', {
          slug: 'settings',
          data: env.rec('data', { siteName: 'n', featured: cat2 }),
          req: req(env),
          select: { siteName: true },
        }),
      ),
  },
  {
    name: 'updateGlobal: returning false',
    expect: ok(['model @globals.updateOne'], ['model @globals.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateGlobal',
        env.rec('args', {
          slug: 'settings',
          data: env.rec('data', { count: 9 }),
          req: req(env),
          returning: false,
        }),
      ),
  },

  // ------------------------------------------------------------------ updateVersion / updateGlobalVersion
  {
    name: 'updateVersion: by id',
    expect: ok(['model @v:posts.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateVersion',
        env.rec('args', {
          id: seed.postVersions[1],
          collection: 'posts',
          req: req(env),
          versionData: env.rec('versionData', { version: { title: 'edited' }, latest: true }),
        }),
      ),
  },
  {
    name: 'updateVersion: where, returning false',
    expect: ok(['model @v:posts.updateOne'], ['model @v:posts.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateVersion',
        env.rec('args', {
          collection: 'posts',
          req: req(env),
          returning: false,
          versionData: env.rec('versionData', { autosave: true }),
          where: { latest: { equals: true } },
        }),
      ),
  },
  {
    name: 'updateVersion: no match',
    expect: ok(['settled @v:posts.findOneAndUpdate.exec fulfilled']),
    run: (env) =>
      env.call(
        'updateVersion',
        env.rec('args', {
          id: '64b0000000000000000000ff',
          collection: 'posts',
          req: req(env),
          versionData: env.rec('versionData', {}),
        }),
      ),
  },
  {
    name: 'updateGlobalVersion: by id with select',
    expect: ok(['model @v:settings.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateGlobalVersion',
        env.rec('args', {
          id: seed.globalVersions[0],
          global: 'settings',
          req: req(env),
          select: { version: { siteName: true } },
          versionData: env.rec('versionData', { version: { siteName: 'gv edited' } }),
        }),
      ),
  },
  {
    name: 'updateGlobalVersion: returning false',
    expect: ok(['model @v:settings.updateOne'], ['model @v:settings.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateGlobalVersion',
        env.rec('args', {
          global: 'settings',
          req: req(env),
          returning: false,
          versionData: env.rec('versionData', { autosave: false }),
          where: { latest: { equals: true } },
        }),
      ),
  },

  // ------------------------------------------------------------------ updateJobs
  {
    name: 'updateJobs: by id (empty log deleted)',
    expect: ok(['delete data.log', 'model @payload-jobs.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateJobs',
        env.rec('args', {
          id: job0,
          data: env.rec('data', { log: [], processing: true }),
          req: req(env),
        }),
      ),
  },
  {
    name: 'updateJobs: by id, returning false, $push log kept',
    expect: ok(['model @payload-jobs.updateOne', 'log log entries 1']),
    run: async (env) => {
      const out = await env.call(
        'updateJobs',
        env.rec('args', {
          id: job1,
          data: env.rec('data', {
            log: {
              $push: {
                executedAt: '2030-01-01T00:00:00.000Z',
                state: 'succeeded',
                taskSlug: 'noop',
                taskID: '1',
                completedAt: '2030-01-01T00:00:00.000Z',
              },
            },
          }),
          req: req(env),
          returning: false,
        }),
      )
      await logJobLog(env, job1)
      return out
    },
  },
  {
    name: 'updateJobs: data.log reads pass through null (typeof null is object; writes item 3)',
    expect: ok(['log log read 4', 'model @payload-jobs.updateOne', 'log log entries 1']),
    run: async (env) => {
      const values = [
        {},
        {},
        null,
        { $push: { state: 'succeeded', taskSlug: 'noop', taskID: '2' } },
      ]
      let reads = 0
      const data = env.rec('data', { processing: false }) as any
      Object.defineProperty(data, 'log', {
        configurable: true,
        enumerable: true,
        get() {
          reads++
          env.log('log read', reads)
          return values[Math.min(reads, values.length) - 1]
        },
      })
      const out = await env.call(
        'updateJobs',
        env.rec('args', { id: job0, data, req: req(env), returning: false }),
      )
      await logJobLog(env, job0)
      return out
    },
  },
  {
    name: 'updateJobs: delete trap throws (strict delete of data.log)',
    expect: err('Error', ['log deleteProperty trap'], ['adapter payload']),
    run: (env) => {
      const data = new Proxy(
        { log: [], processing: true },
        {
          deleteProperty(target, key) {
            env.log('deleteProperty trap', String(key))
            throw env.inject(new Error('delete trap'))
          },
        },
      )
      return env.call('updateJobs', env.rec('args', { id: job0, data, req: req(env) }))
    },
  },
  {
    name: 'updateJobs: delete trap returns false (strict delete throws, trap runs once)',
    expect: err('TypeError', ['log deleteProperty trap 1'], ['log deleteProperty trap 2']),
    run: (env) => {
      let calls = 0
      const data = new Proxy(
        { log: [], processing: true },
        {
          deleteProperty(target, key) {
            calls++
            env.log('deleteProperty trap', calls)
            if (calls === 1) {
              return false
            }
            return Reflect.deleteProperty(target, key)
          },
        },
      )
      return env.call('updateJobs', env.rec('args', { id: job0, data, req: req(env) }))
    },
  },
  {
    name: 'updateJobs: limit 1 (findOneAndUpdate sorted)',
    expect: ok(['model @payload-jobs.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateJobs',
        env.rec('args', {
          data: env.rec('data', { processing: true }),
          limit: 1,
          req: req(env),
          where: { queue: { equals: 'default' } },
        }),
      ),
  },
  {
    name: 'updateJobs: limit 1, returning false',
    expect: ok(['model @payload-jobs.findOneAndUpdate']),
    run: (env) =>
      env.call(
        'updateJobs',
        env.rec('args', {
          data: env.rec('data', { processing: true }),
          limit: 1,
          req: req(env),
          returning: false,
          sort: 'createdAt',
          where: { queue: { equals: 'default' } },
        }),
      ),
  },
  {
    name: 'updateJobs: limit 2 with processingToken (claim)',
    expect: ok([
      'model @payload-jobs.find',
      'model @payload-jobs.updateMany',
      'get data.processingToken',
    ]),
    run: (env) =>
      env.call(
        'updateJobs',
        env.rec('args', {
          data: env.rec('data', { processing: true, processingToken: 'tok' }),
          limit: 2,
          req: req(env),
          where: { queue: { equals: 'default' } },
        }),
      ),
  },
  {
    name: 'updateJobs: limit 2 without token, returning false',
    expect: ok(['model @payload-jobs.find', 'model @payload-jobs.updateMany']),
    run: (env) =>
      env.call(
        'updateJobs',
        env.rec('args', {
          data: env.rec('data', { hasError: true }),
          limit: 2,
          req: req(env),
          returning: false,
          where: { queue: { equals: 'default' } },
        }),
      ),
  },
  {
    name: 'updateJobs: limit 5, no candidates',
    expect: ok(['model @payload-jobs.find'], ['model @payload-jobs.updateMany']),
    run: (env) =>
      env.call(
        'updateJobs',
        env.rec('args', {
          data: env.rec('data', { hasError: true }),
          limit: 5,
          req: req(env),
          where: { queue: { equals: 'none' } },
        }),
      ),
  },
  {
    name: 'updateJobs: no limit, log getter counted',
    expect: ok(['log log read', 'delete data.log', 'model @payload-jobs.updateMany']),
    run: (env) => {
      const data = env.rec('data', { totalTried: 1 }) as any
      let reads = 0
      Object.defineProperty(data, 'log', {
        configurable: true,
        enumerable: true,
        get() {
          env.log('log read', ++reads)
          return { notPush: true }
        },
      })
      return env.call(
        'updateJobs',
        env.rec('args', { data, req: req(env), where: { queue: { equals: 'default' } } }),
      )
    },
  },
  {
    name: 'updateJobs: no limit, returning false',
    expect: ok(['model @payload-jobs.updateMany'], ['model @payload-jobs.find']),
    run: (env) =>
      env.call(
        'updateJobs',
        env.rec('args', {
          data: env.rec('data', { queue: 'q2' }),
          req: req(env),
          returning: false,
          where: { queue: { equals: 'default' } },
        }),
      ),
  },
  {
    name: 'updateJobs: data undefined (TypeError at data.log)',
    expect: err('TypeError', ['get args.data'], ['adapter payload']),
    run: (env) => env.call('updateJobs', env.rec('args', { id: job0, req: req(env) })),
  },

  // ------------------------------------------------------------------ deletes
  {
    name: 'deleteOne: returning doc with select',
    expect: ok(['model @posts.findOneAndDelete', 'exec @posts.findOneAndDelete']),
    run: (env) =>
      env.call(
        'deleteOne',
        env.rec('args', {
          collection: 'posts',
          req: req(env),
          select: { title: true },
          where: { id: { equals: post1 } },
        }),
      ),
  },
  {
    name: 'deleteOne: returning false',
    expect: ok(['model @posts.deleteOne'], ['model @posts.findOneAndDelete']),
    run: (env) =>
      env.call(
        'deleteOne',
        env.rec('args', {
          collection: 'posts',
          req: req(env),
          returning: false,
          where: { id: { equals: post2 } },
        }),
      ),
  },
  {
    name: 'deleteOne: no match',
    expect: ok(['settled @posts.findOneAndDelete.exec fulfilled']),
    run: (env) =>
      env.call(
        'deleteOne',
        env.rec('args', {
          collection: 'posts',
          req: req(env),
          where: { title: { equals: 'missing' } },
        }),
      ),
  },
  {
    name: 'deleteMany: where',
    expect: ok(['model @categories.deleteMany']),
    run: (env) =>
      env.call(
        'deleteMany',
        env.rec('args', {
          collection: 'categories',
          req: req(env),
          where: { name: { equals: 'one' } },
        }),
      ),
  },
  {
    name: 'deleteMany: in a transaction',
    expect: ok(['get req.transactionID', 'model @posts.deleteMany']),
    run: async (env) => {
      await withSession(env)
      return env.call(
        'deleteMany',
        env.rec('args', {
          collection: 'posts',
          req: req(env, { transactionID: 'tx-fixed' }),
          where: { count: { less_than: 2 } },
        }),
      )
    },
  },
  {
    name: 'deleteMany: inherited session setter not run by the options literal (writes item 7)',
    expect: ok(
      ['log probe session setter', 'model @categories.deleteMany'],
      ['log session setter'],
    ),
    run: (env) => {
      patch(env, Object.prototype, 'session', {
        set(this: any, v: unknown) {
          if (!callerInNodeModules()) {
            env.log(this.__probe ? 'probe session setter' : 'session setter')
          }
          Object.defineProperty(this, 'session', {
            configurable: true,
            enumerable: true,
            value: v,
            writable: true,
          })
        },
      })
      const probe: any = { __probe: true }
      probe.session = 1
      return env.call(
        'deleteMany',
        env.rec('args', {
          collection: 'categories',
          req: req(env),
          where: { name: { equals: 'two' } },
        }),
      )
    },
  },
  {
    name: 'deleteVersions: collection',
    expect: ok(['model @v:posts.deleteMany']),
    run: (env) =>
      env.call(
        'deleteVersions',
        env.rec('args', {
          collection: 'posts',
          req: req(env),
          where: { latest: { not_equals: true } },
        }),
      ),
  },
  {
    name: 'deleteVersions: global',
    expect: ok(['model @v:settings.deleteMany']),
    run: (env) =>
      env.call(
        'deleteVersions',
        env.rec('args', {
          globalSlug: 'settings',
          locale: 'en',
          req: req(env),
          where: { 'version.siteName': { equals: 'site v0' } },
        }),
      ),
  },
  {
    name: 'deleteVersions: neither (APIError)',
    expect: err('APIError', ['get args.globalSlug'], ['model @v:posts.deleteMany']),
    run: (env) => env.call('deleteVersions', env.rec('args', { req: req(env), where: {} })),
  },

  // ------------------------------------------------------------------ handleError (writes item 9)
  {
    name: 'handleError: String.prototype.lastIndexOf of the duplicate path is called (writes item 9)',
    expect: err('ValidationError', ['log lastIndexOf slug.en', 'log substring slug.en']),
    run: (env) => {
      const lastIndexOf = String.prototype.lastIndexOf
      const substring = String.prototype.substring
      patch(env, String.prototype, 'lastIndexOf', {
        value: function (this: string, ...a: any[]) {
          if (String(this) === 'slug.en') {
            env.log('lastIndexOf slug.en', a)
          }
          return lastIndexOf.apply(this, a as any)
        },
        writable: true,
      })
      patch(env, String.prototype, 'substring', {
        value: function (this: string, ...a: any[]) {
          if (String(this) === 'slug.en') {
            env.log('substring slug.en', a)
          }
          return substring.apply(this, a as any)
        },
        writable: true,
      })
      rejectWith(
        env,
        coll(env, 'posts'),
        'create',
        recordedError(env, { code: 11000, keyValue: { 'slug.en': 'x' } }),
      )
      return createPost(env)
    },
  },
  {
    name: 'handleError: a throwing String.prototype.lastIndexOf propagates (writes item 9)',
    expect: err('Error', ['log lastIndexOf threw']),
    run: (env) => {
      const lastIndexOf = String.prototype.lastIndexOf
      patch(env, String.prototype, 'lastIndexOf', {
        value: function (this: string, ...a: any[]) {
          if (String(this) === 'slug.en') {
            env.log('lastIndexOf threw')
            throw env.inject(new Error('lastIndexOf'))
          }
          return lastIndexOf.apply(this, a as any)
        },
        writable: true,
      })
      rejectWith(
        env,
        coll(env, 'posts'),
        'create',
        recordedError(env, { code: 11000, keyValue: { 'slug.en': 'x' } }),
      )
      return createPost(env)
    },
  },

  // ------------------------------------------------------------------ shared helpers owned elsewhere
  {
    name: 'getSession: promised transactionID with a constructor getter (writes item 1, shared path)',
    expect: ok(
      ['log transactionID constructor read 1', 'model @posts.create'],
      ['log transactionID constructor read 2'],
    ),
    run: async (env) => {
      await withSession(env)
      const transactionID = Promise.resolve('tx-fixed')
      let reads = 0
      Object.defineProperty(transactionID, 'constructor', {
        configurable: true,
        get() {
          env.log('transactionID constructor read', ++reads)
          return Promise
        },
      })
      return env.call(
        'create',
        env.rec('args', {
          collection: 'posts',
          data: postData(env),
          req: req(env, { transactionID }),
        }),
      )
    },
  },
  {
    name: 'toObject not callable: the intrinsic TypeError, not the global one (writes item 8)',
    expect: err('TypeError', ['settled @posts.create fulfilled']),
    run: (env) => {
      const NativeTypeError = TypeError
      patch(env, globalThis, 'TypeError', {
        value: class TypeError extends NativeTypeError {
          constructor(message?: string) {
            super(`replaced: ${message}`)
          }
        },
        writable: true,
      })
      env.modelBehaviour(coll(env, 'posts'), 'create', () => Promise.resolve([{ toObject: 0 }]))
      return createPost(env)
    },
  },
]
