import type { NativeError } from './native.js'

/**
 * Port of `LibsqlError` (`@libsql/core/lib-esm/api.js`): error thrown by the client.
 */
export class LibsqlError extends Error {
  /** Machine-readable error code. */
  code: string
  /** Raw numeric error code */
  rawCode?: number

  constructor(message: string, code: string, rawCode?: number, cause?: Error) {
    if (code !== undefined) {
      message = `${code}: ${message}`
    }
    super(message, { cause })
    this.code = code
    this.rawCode = rawCode
    this.name = 'LibsqlError'
  }
}

/**
 * Port of `SqliteError` (`libsql/sqlite-error.js`), the error class of the
 * `libsql` native binding (attached as `cause` of a `LibsqlError`).
 */
export class SqliteError extends Error {
  declare code: string
  declare rawCode: number | undefined

  constructor(message: string, code: string, rawCode?: number) {
    super(message)
    Error.captureStackTrace(this, SqliteError)
    this.code = code
    this.rawCode = rawCode
  }
}

Object.defineProperty(SqliteError.prototype, 'name', {
  configurable: true,
  enumerable: false,
  value: 'SqliteError',
  writable: true,
})

/** Rebuilds the JS error object described by the Rust runtime. */
export const toJsError = (error: NativeError): Error => {
  switch (error.kind) {
    case 'libsql':
      return new LibsqlError(error.message, error.code!)
    case 'libsqlUri':
      // `percentDecode`: new LibsqlError(`...: ${e}`, "URL_INVALID", undefined, e)
      return new LibsqlError(error.message, error.code!, undefined, new URIError('URI malformed'))
    case 'native': {
      // A raw error object of the `libsql` binding that escaped `convertError`.
      const err = new Error(error.message) as {
        code?: string
        libsqlError?: boolean
        rawCode?: number
      } & Error
      err.rawCode = error.rawCode
      err.code = error.code
      err.libsqlError = true
      return err
    }
    case 'RangeError':
      return new RangeError(error.message)
    case 'sqlite': {
      // `mapSqliteError`: new LibsqlError(e.message, e.code, e.rawCode, e)
      const cause = new SqliteError(error.message, error.code!, error.rawCode)
      return new LibsqlError(error.message, error.code!, error.rawCode, cause)
    }
    case 'TypeError':
      return new TypeError(error.message)
    default: {
      const err = new Error(error.message) as { code?: string } & Error
      if (error.code !== undefined) {
        err.code = error.code
      }
      return err
    }
  }
}
