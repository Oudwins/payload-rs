/**
 * Errors crossing the engine boundary (ENGINE_CONTRACT.md "Errors").
 *
 * The engine rejects with an `Error` whose message is the JSON of an `EngineError`; `rebuildError`
 * turns it into the error upstream `@payloadcms/drizzle` throws, with the same class and own
 * properties. `describeError` is the inverse, used by the loopback engine.
 */
import type { NativeError } from '../sqlite/native.js'

// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { APIError } from '../../../payload/src/errors/APIError.js'
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { NotFound } from '../../../payload/src/errors/NotFound.js'
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { QueryError } from '../../../payload/src/errors/QueryError.js'
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { ValidationError } from '../../../payload/src/errors/ValidationError.js'
import { createEngineError } from '../schema.js'
import { LibsqlError, SqliteError, toJsError } from '../sqlite/errors.js'

/**
 * - `APIError`: `new APIError(message, status, data, isPublic)`; `status` / `isPublic` / `data` may
 *   also come as the `data: { status, data?, isPublic? }` envelope the Rust crates use
 * - `QueryError`: `new QueryError(data)` (`data` = `[{ path }]`)
 * - `ValidationError`: `new ValidationError({ id, collection, errors, global, req }, req?.t)` with
 *   `data = { id, collection, errors: [{ path, tableName }], global }`. Error entries without a
 *   `message` get upstream's unique-violation message
 *   (`req?.t ? req.t('error:valueMustBeUnique') : 'Value must be unique'`), the only
 *   ValidationError the drizzle data path throws (handleUpsertError).
 * - `LibsqlError`: `data` is a sqlite runtime error (`NativeError`), rebuilt by `toJsError`
 * - `NotFound`: `new NotFound(req?.t)`
 * - `DrizzleQueryError`: drizzle's `new DrizzleQueryError(query, params, cause)`; `params` in the
 *   tree encoding, `cause` a sqlite runtime error (`NativeError`, as `sqlite/native.ts`).
 * - anything else: JS built-in class of that name, payload `InvalidConfiguration`, or an `Error`
 *   with `name` set (`createEngineError`).
 */
export type EngineError = {
  cause?: NativeError
  data?: unknown
  isPublic?: boolean
  message?: string
  name: string
  params?: unknown
  query?: string
  status?: number
}

type Req = { t?: (key: string, options?: Record<string, unknown>) => string } | undefined

/** Constructor of drizzle-orm's `DrizzleQueryError` (`new DrizzleQueryError(query, params, cause)`). */
export type DrizzleQueryErrorClass = new (query: string, params: unknown[], cause?: Error) => Error

/**
 * Shape-compatible copy of drizzle-orm's `DrizzleQueryError`, used when the adapter did not pass
 * the class of the drizzle-orm copy its session runs on (`withRustEngine(obj, { DrizzleQueryError })`).
 */
export class DrizzleQueryError extends Error {
  // `declare`: own properties are created by the constructor in drizzle's order
  declare cause: unknown
  declare params: unknown[]
  declare query: string

  constructor(query: string, params: unknown[], cause?: Error) {
    super(`Failed query: ${query}\nparams: ${params as unknown as string}`)
    this.query = query
    this.params = params
    this.cause = cause
    Error.captureStackTrace(this, DrizzleQueryError)
    if (cause) {
      this.cause = cause
    }
  }
}

export const rebuildError = ({
  decode,
  DrizzleQueryErrorClass = DrizzleQueryError,
  error,
  req,
}: {
  decode: (value: unknown) => unknown
  /** The class upstream's drizzle session throws (identity matters for `instanceof`). */
  DrizzleQueryErrorClass?: DrizzleQueryErrorClass
  error: EngineError
  req: Req
}): Error => {
  switch (error.name) {
    case 'APIError': {
      const { data, isPublic, status } = unwrapStatusEnvelope(error)
      return new APIError(
        error.message!,
        status,
        (data === undefined ? undefined : decode(data)) as null | Record<string, unknown>,
        isPublic,
      )
    }
    case 'DrizzleQueryError':
      return new DrizzleQueryErrorClass(
        error.query!,
        decode(error.params) as unknown[],
        error.cause ? toJsError(error.cause) : undefined,
      )
    case 'LibsqlError':
      // a client / connection error raised outside a statement: `data` is the sqlite runtime error
      return toJsError(error.data as NativeError)
    case 'NotFound':
      return new NotFound(req?.t as never)
    case 'QueryError':
      return new QueryError(decode(unwrapStatusEnvelope(error).data) as { path: string }[])
    case 'ValidationError': {
      const data = decode(error.data) as {
        collection?: string
        errors: { message?: string; path: string; tableName?: string }[]
        global?: string
        id?: number | string
      }
      const errors = data.errors.map((fieldError) =>
        fieldError.message === undefined
          ? {
              message: req?.t ? req.t('error:valueMustBeUnique') : 'Value must be unique',
              ...fieldError,
            }
          : fieldError,
      )
      return new ValidationError(
        {
          id: data.id,
          collection: data.collection,
          errors: errors as never,
          global: data.global,
          req: req as never,
        },
        req?.t as never,
      )
    }
    default:
      return createEngineError({
        name: error.name,
        data: error.data === undefined ? undefined : decode(error.data),
        message: error.message!,
      })
  }
}

/**
 * The Rust crates encode an `APIError`'s constructor arguments as `data: { status, data?,
 * isPublic? }` (e.g. `{ status: 400 }`, QueryError `{ status: 400, data: [{ path }] }`); top-level
 * `status` / `isPublic` with `data` as the error data is accepted too. No drizzle `APIError`
 * carries data of its own, so a `data` object with a numeric `status` and no other keys than
 * these is always the envelope.
 */
const unwrapStatusEnvelope = (
  error: EngineError,
): { data: unknown; isPublic?: boolean; status?: number } => {
  const { data } = error
  if (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    typeof (data as { status?: unknown }).status === 'number' &&
    Object.keys(data).every((key) => key === 'data' || key === 'isPublic' || key === 'status')
  ) {
    const envelope = data as { data?: unknown; isPublic?: boolean; status: number }
    return { data: envelope.data, isPublic: envelope.isPublic, status: envelope.status }
  }
  return { data, isPublic: error.isPublic, status: error.status }
}

/** `EngineError` describing an error thrown by the upstream TS implementation. */
export const describeError = ({
  encode,
  error,
}: {
  encode: (value: unknown) => unknown
  error: unknown
}): EngineError | undefined => {
  if (!(error instanceof Error)) {
    return undefined
  }
  if (error instanceof ValidationError) {
    const data = error.data as {
      collection?: string
      errors: { message?: string }[]
      global?: string
      id?: number | string
    }
    return {
      name: 'ValidationError',
      data: encode({
        id: data.id,
        collection: data.collection,
        // the unique-violation message is the one the engine leaves to TS
        errors: data.errors.map(({ message: _message, ...rest }) => rest),
        global: data.global,
      }),
    }
  }
  if (error instanceof QueryError) {
    return { name: 'QueryError', data: encode(error.data) }
  }
  if (error instanceof NotFound) {
    return { name: 'NotFound' }
  }
  if (error instanceof APIError) {
    return {
      name: 'APIError',
      data: encode(error.data),
      isPublic: error.isPublic,
      message: error.message,
      status: error.status,
    }
  }
  const drizzle = error as { params?: unknown; query?: unknown } & Error
  if (
    error.constructor.name === 'DrizzleQueryError' &&
    typeof drizzle.query === 'string' &&
    Array.isArray(drizzle.params)
  ) {
    return {
      name: 'DrizzleQueryError',
      cause: describeNativeError(error.cause),
      params: encode(drizzle.params),
      query: drizzle.query,
    }
  }
  return { name: error.name, message: error.message }
}

const describeNativeError = (cause: unknown): NativeError | undefined => {
  if (cause instanceof LibsqlError) {
    const message = cause.message.startsWith(`${cause.code}: `)
      ? cause.message.slice(cause.code.length + 2)
      : cause.message
    return cause.cause instanceof SqliteError
      ? { code: cause.code, kind: 'sqlite', message, rawCode: cause.rawCode }
      : { code: cause.code, kind: 'libsql', message }
  }
  if (!(cause instanceof Error)) {
    return undefined
  }
  const native = cause as { code?: string; libsqlError?: boolean; rawCode?: number } & Error
  if (native.libsqlError === true) {
    return { code: native.code, kind: 'native', message: native.message, rawCode: native.rawCode }
  }
  if (cause instanceof TypeError || cause instanceof RangeError) {
    return { kind: cause.name as 'RangeError' | 'TypeError', message: cause.message }
  }
  return { code: native.code, kind: 'Error', message: cause.message }
}
