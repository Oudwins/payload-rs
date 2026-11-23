import { types } from 'node:util'

/**
 * Inertness checks of the per-call guards (FUSE_CONTRACT.md section 3): values the fused lane
 * reads must not run code when read (accessors, proxies) and must cross the boundary unchanged.
 */

const objectPrototype = Object.prototype
const arrayPrototype = Array.prototype

/** A plain object (prototype `Object.prototype` or `null`), not a proxy, without symbol keys. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === objectPrototype || prototype === null) &&
    !types.isProxy(value) &&
    Object.getOwnPropertySymbols(value).length === 0
  )
}

const isDataProperty = (object: object, key: string): boolean => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor === undefined || 'value' in descriptor
}

/** `object[key]` is absent or a data property (reading it runs no code). */
export const hasDataProperties = (object: object, keys: readonly string[]): boolean => {
  for (const key of keys) {
    if (!isDataProperty(object, key)) {
      return false
    }
  }
  return true
}

/** A plain object whose own enumerable properties are all data properties. */
export const isPlainDataObject = (value: unknown): value is Record<string, unknown> => {
  if (!isPlainObject(value)) {
    return false
  }
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || !isDataProperty(value, key)) {
      return false
    }
  }
  return true
}

const isPlainArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) &&
  Object.getPrototypeOf(value) === arrayPrototype &&
  !types.isProxy(value) &&
  Object.getOwnPropertySymbols(value).length === 0

/** A primitive that crosses the boundary unchanged (strings, finite numbers, booleans, null). */
export const isScalar = (value: unknown): boolean =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value))

/** A plain `Date` (not a subclass, not a proxy). */
export const isPlainDate = (value: unknown): value is Date =>
  value instanceof Date &&
  Object.getPrototypeOf(value) === Date.prototype &&
  !types.isProxy(value) &&
  Reflect.ownKeys(value).length === 0

/**
 * A JSON-like tree of plain objects, plain arrays (no holes) and scalars (`Date`s with
 * `allowDates`), at most `maxDepth` levels deep.
 */
export const isInertTree = (value: unknown, allowDates: boolean, maxDepth = 32): boolean => {
  if (isScalar(value) || value === undefined) {
    return true
  }
  if (maxDepth === 0) {
    return false
  }
  if (allowDates && isPlainDate(value)) {
    return true
  }
  if (isPlainArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value) || !isDataProperty(value, String(i))) {
        return false
      }
      if (!isInertTree(value[i], allowDates, maxDepth - 1)) {
        return false
      }
    }
    return true
  }
  if (!isPlainDataObject(value)) {
    return false
  }
  for (const key in value) {
    if (!isInertTree(value[key], allowDates, maxDepth - 1)) {
      return false
    }
  }
  return true
}
