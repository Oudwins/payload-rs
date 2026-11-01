/**
 * Errors crossing the MongoDB engine boundary (MONGO_ENGINE_CONTRACT.md "Errors").
 *
 * `MongoEngine.call` rejects with an `Error` whose message is the JSON of a `MongoEngineError`:
 * - `{ rethrow: n }`: the call fails with that host object, unchanged (the value a host op threw
 *   and upstream rethrew, e.g. a mongoose `CastError` or a driver error outside `handleError`'s
 *   duplicate-key branch).
 * - `name: 'HostError'`, `message: 'JS function <id> threw'`: the error of that JS function.
 * - otherwise the Payload / JS error, rebuilt with the class upstream throws.
 * `mutations` (optional) are applied to the caller's arguments before the error is thrown, as
 * upstream mutates them before it fails (e.g. `create`'s write transform before a duplicate key).
 */
import type { EngineError } from '../adapter/errors.js'
import type { BsonClasses } from './codec.js'

// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { ValidationError } from '../../../payload/src/errors/ValidationError.js'
import { describeError, rebuildError } from '../adapter/errors.js'

export type MongoEngineError = {
  /** Argument mutations made before the failure (`[path, tree]`, see `applyMutations`). */
  mutations?: [string[], unknown][]
  /** A host object id: the call rejects with that original JS value. */
  rethrow?: number
} & EngineError

type Req = { t?: (key: string, options?: Record<string, unknown>) => string } | undefined

/**
 * Rebuilds a Payload / JS error of the engine:
 * - `ValidationError` (upstream `handleError`'s unique violation): `data` is upstream's
 *   `{ collection, errors, global }` (no `id`); entries without a `message` get
 *   `req?.t ? req.t('error:valueMustBeUnique') : 'Value must be unique'`.
 * - `BSONError` (`new Types.ObjectId(invalid)`): the bson class of the adapter's mongoose.
 * - anything else: as the SQLite engine (`APIError`, `QueryError`, `NotFound`, JS built-ins).
 */
export const rebuildMongoError = ({
  classes,
  decode,
  error,
  req,
}: {
  classes: BsonClasses
  decode: (value: unknown) => unknown
  error: MongoEngineError
  req: Req
}): Error => {
  switch (error.name) {
    case 'BSONError':
      return new classes.BSONError(error.message ?? '')
    case 'ValidationError': {
      const data = decode(error.data) as {
        errors: { message?: string; path: string }[]
      } & Record<string, unknown>
      const errors = data.errors.map((fieldError) =>
        fieldError.message === undefined
          ? {
              message: req?.t ? req.t('error:valueMustBeUnique') : 'Value must be unique',
              ...fieldError,
            }
          : fieldError,
      )
      return new ValidationError({ ...data, errors } as never, req?.t as never)
    }
    default:
      return rebuildError({ decode, error, req })
  }
}

/** `MongoEngineError` of an error thrown by the upstream TS code (loopback engine). */
export const describeMongoError = ({
  encode,
  error,
}: {
  encode: (value: unknown) => unknown
  error: unknown
}): EngineError | undefined => {
  if (error instanceof ValidationError) {
    const { errors, ...rest } = error.data as {
      errors: { message?: string }[]
    } & Record<string, unknown>
    const data: Record<string, unknown> = {}
    // upstream's key order (`{ collection, errors, global }`)
    for (const key of Object.keys(error.data as object)) {
      data[key] =
        key === 'errors'
          ? errors.map(({ message: _message, ...fieldError }) => fieldError)
          : rest[key]
    }
    return { name: 'ValidationError', data: encode(data) }
  }
  if (error instanceof Error && error.name === 'BSONError') {
    return { name: 'BSONError', message: error.message }
  }
  return describeError({ encode, error })
}
