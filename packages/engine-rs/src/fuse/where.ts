import { validOperatorSet } from '../../../payload/src/types/constants.js'
import { isPlainDataObject, isPlainDate, isScalar } from './inert.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- sanitized config shapes */
type Any = any

/**
 * The conservative `where` validator of the fused lanes (FUSE_CONTRACT.md section 3): `true` only
 * for a `where` that upstream's `validateQueryPaths` accepts without errors and that neither
 * `sanitizeWhereQuery` nor `validateSearchParam` rewrites, given `overrideAccess`. Anything else
 * (including valid queries outside the accepted subset) returns `false` and the operation runs on
 * the exact lane, which throws or rewrites as upstream does.
 *
 * Accepted: `and` / `or` arrays of such queries; `id`; paths through non-hidden, non-virtual
 * fields, descending into groups, named tabs and arrays (flattened fields), with at most one
 * string `relationTo` relationship / upload hop; valid operators; scalar values, `Date`s and
 * arrays of them.
 */
export const isAcceptedWhere = ({
  fields,
  idOnly = false,
  payload,
  where,
}: {
  fields: Any[]
  /** Only `id` paths (`validateSearchParam` checks no field permissions for them). */
  idOnly?: boolean
  payload: Any
  where: unknown
}): boolean => {
  if (where === undefined) {
    return true
  }
  if (!isPlainDataObject(where)) {
    return false
  }
  for (const key in where) {
    const value = where[key]
    const lower = key.toLowerCase()
    if (lower === 'and' || lower === 'or') {
      if (!Array.isArray(value)) {
        return false
      }
      for (const item of value) {
        if (item === undefined || !isAcceptedWhere({ fields, idOnly, payload, where: item })) {
          return false
        }
      }
      continue
    }
    if (!isPlainDataObject(value)) {
      return false
    }
    let hasOperator = false
    for (const operator in value) {
      hasOperator = true
      if (!validOperatorSet.has(operator as never) || !isAcceptedValue(value[operator])) {
        return false
      }
    }
    if (
      !hasOperator ||
      (idOnly && key !== 'id') ||
      !isAcceptedPath({ fields, path: key, payload })
    ) {
      return false
    }
  }
  return true
}

const isAcceptedValue = (value: unknown): boolean => {
  if (value === undefined || isScalar(value) || isPlainDate(value)) {
    return true
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (!(i in value) || !(isScalar(item) || isPlainDate(item))) {
      return false
    }
  }
  return true
}

const pathCache = new WeakMap<object, Map<string, boolean>>()

const isAcceptedPath = ({
  fields,
  path,
  payload,
}: {
  fields: Any[]
  path: string
  payload: Any
}): boolean => {
  let cache = pathCache.get(fields)
  if (!cache) {
    cache = new Map()
    pathCache.set(fields, cache)
  }
  let accepted = cache.get(path)
  if (accepted === undefined) {
    accepted = resolvePath({ fields, hops: 0, payload, segments: path.split('.') })
    cache.set(path, accepted)
  }
  return accepted
}

const resolvePath = ({
  fields,
  hops,
  payload,
  segments,
}: {
  fields: Any[]
  hops: number
  payload: Any
  segments: string[]
}): boolean => {
  if (segments.length === 1 && segments[0] === 'id') {
    return true
  }
  const localeCodes: string[] = payload.config.localization?.localeCodes ?? []
  let current = fields
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    if (
      segment === '' ||
      segment.includes('__') ||
      segment === '_id' ||
      localeCodes.includes(segment)
    ) {
      return false
    }
    const field = current.find((each: Any) => each.name === segment)
    if (!field || field.hidden || ('virtual' in field && field.virtual)) {
      return false
    }
    const isLast = i === segments.length - 1
    switch (field.type) {
      case 'array':
      case 'group':
      case 'tab': {
        if (isLast) {
          return true
        }
        if (!Array.isArray(field.flattenedFields)) {
          return false
        }
        current = field.flattenedFields
        break
      }
      case 'blocks':
      case 'join':
      case 'json':
      case 'richText':
        return false
      case 'relationship':
      case 'upload': {
        if (typeof field.relationTo !== 'string') {
          return false
        }
        if (isLast) {
          return true
        }
        if (
          hops > 0 ||
          !Object.prototype.hasOwnProperty.call(payload.collections, field.relationTo)
        ) {
          return false
        }
        return resolvePath({
          fields: payload.collections[field.relationTo].config.flattenedFields,
          hops: hops + 1,
          payload,
          segments: segments.slice(i + 1),
        })
      }
      default:
        return isLast
    }
  }
  return false
}
