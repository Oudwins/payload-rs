/**
 * Typed values of the MongoDB boundary (MONGO_ENGINE_CONTRACT.md "Values", the encodings of
 * crates/payload-engine/src/bson.rs). Everything crosses in the tree encoding (no `$ref`s):
 * - to the engine (call arguments, host op results): `encodeMongoTree` with the `hostObjectID` of
 *   `createArgsBoundary` / `createResultBoundary`;
 * - from the engine (results, mutations, host op requests): `deserializeFromEngine` (serialize.ts)
 *   with that `BsonBoundary`.
 * The two boundaries of one engine call share its host object table (`{ $hostObject: n }`
 * handles, freed when the call settles).
 */
import type { BsonBoundary, FunctionRegistry } from '../serialize.js'

type AnyObject = Record<PropertyKey, any>

/** The bson classes values are decoded into (`mongoose.mongo.BSON` of the adapter's mongoose). */
export type BsonClasses = {
  Binary: new (buffer: Uint8Array, subType?: number) => unknown
  BSONError: new (message: string) => Error
  Decimal128: { fromString: (value: string) => unknown }
  ObjectId: new (hex: string) => unknown
}

/** The bson classes of the mongoose instance behind an adapter's connection. */
export const getBsonClasses = (adapter: AnyObject): BsonClasses => {
  const BSON = (adapter.connection?.base ?? adapter.mongoose)?.mongo?.BSON
  if (!BSON) {
    throw new Error('withRustMongoEngine: the adapter has no mongoose connection')
  }
  return BSON as BsonClasses
}

/** JS values kept for the duration of one engine call (sessions, errors, opaque bson), by id. */
export type HostObjects = { ids: Map<object, number>; objects: unknown[] }

export const createHostObjects = (): HostObjects => ({ ids: new Map(), objects: [] })

export const addHostObject = (hostObjects: HostObjects, value: unknown): number => {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    const known = hostObjects.ids.get(value)
    if (known !== undefined) {
      return known
    }
    const id = hostObjects.objects.push(value) - 1
    hostObjects.ids.set(value, id)
    return id
  }
  return hostObjects.objects.push(value) - 1
}

const getHostObject = (hostObjects: HostObjects, id: number) => {
  if (!Number.isInteger(id) || id < 0 || id >= hostObjects.objects.length) {
    throw new Error(`Unknown host object ${String(id)}`)
  }
  return hostObjects.objects[id]
}

/** bson types the engine decodes (crates/payload-engine/src/bson.rs); other bson types are handles. */
const engineBsonTypes = new Set(['Binary', 'Decimal128', 'ObjectId'])

const bsonTypeOf = (value: object): string | undefined => {
  const type = (value as AnyObject)._bsontype
  return typeof type === 'string' ? type : undefined
}

/** A mongoose / driver `ClientSession` (an args value that must stay the same JS object). */
const isClientSession = (value: object) =>
  typeof (value as AnyObject).inTransaction === 'function' &&
  typeof (value as AnyObject).endSession === 'function'

/** Data the engine decodes structurally or typed: plain objects, arrays, dates, engine bson, bytes. */
const isEngineData = (value: object) => {
  if (Array.isArray(value) || value instanceof Date || value instanceof Uint8Array) {
    return true
  }
  if (value instanceof RegExp) {
    return true
  }
  const bsonType = bsonTypeOf(value)
  if (bsonType !== undefined) {
    return engineBsonTypes.has(bsonType)
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * The boundary for values going to the engine as arguments: structural like the SQLite engine
 * (class instances keep `serializeForEngine`'s reading), except bson types the engine has no
 * representation for and client sessions, which cross as handles.
 */
export const createArgsBoundary = ({
  classes,
  hostObjects,
}: {
  classes: BsonClasses
  hostObjects: HostObjects
}): BsonBoundary => ({
  classes,
  hostObject: (id) => getHostObject(hostObjects, id),
  hostObjectID: (value) => {
    const known = hostObjects.ids.get(value)
    if (known !== undefined) {
      return known
    }
    const bsonType = bsonTypeOf(value)
    if ((bsonType !== undefined && !engineBsonTypes.has(bsonType)) || isClientSession(value)) {
      return addHostObject(hostObjects, value)
    }
    return undefined
  },
})

/**
 * The boundary for host op results (documents, counts, sessions): everything that is not engine
 * data (non-lean mongoose documents, `ClientSession`, `Long`, `Timestamp`, ...) is a handle.
 */
export const createResultBoundary = ({
  classes,
  hostObjects,
}: {
  classes: BsonClasses
  hostObjects: HostObjects
}): BsonBoundary => ({
  classes,
  hostObject: (id) => getHostObject(hostObjects, id),
  hostObjectID: (value) => {
    const known = hostObjects.ids.get(value)
    if (known !== undefined) {
      return known
    }
    return isEngineData(value) ? undefined : addHostObject(hostObjects, value)
  },
})

const reservedKeys = new Set([
  '$bigint',
  '$binary',
  '$buffer',
  '$date',
  '$decimal',
  '$fn',
  '$hostObject',
  '$num',
  '$obj',
  '$oid',
  '$ref',
  '$regex',
  '$undefined',
])

/** The typed encoding of a non-plain value, or `undefined` for plain objects / arrays. */
const encodeTyped = (value: object): unknown => {
  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() }
  }
  if (value instanceof RegExp) {
    return { $regex: { flags: value.flags, source: value.source } }
  }
  switch (bsonTypeOf(value)) {
    case 'Binary': {
      const binary = value as AnyObject
      const bytes: Uint8Array = binary.buffer.subarray(0, binary.position)
      return {
        $binary: {
          base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
          subType: binary.sub_type,
        },
      }
    }
    case 'Decimal128':
      return { $decimal: String(value) }
    case 'ObjectId':
      return { $oid: (value as AnyObject).toHexString() }
  }
  if (value instanceof Uint8Array) {
    return {
      $buffer: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    }
  }
  return undefined
}

/**
 * Tree encoding (no `$ref`s) of a value, as the engine emits it. `hostObjectID` gives the handle of
 * values that cross as `{ $hostObject: n }`; `onFunction` replaces a function (with its path from
 * the root) instead of registering it as `{ $fn: n }`.
 */
export const encodeMongoTree = ({
  hostObjectID,
  onFunction,
  registry,
  value,
}: {
  hostObjectID?: (value: object) => number | undefined
  onFunction?: (fn: Function, path: string[]) => unknown
  registry: FunctionRegistry
  value: unknown
}): unknown => {
  const path: string[] = []
  const encode = (v: unknown): unknown => {
    switch (typeof v) {
      case 'bigint':
        return { $bigint: v.toString() }
      case 'function':
        return onFunction ? onFunction(v, [...path]) : { $fn: registry.functions.push(v) - 1 }
      case 'number':
        return Number.isFinite(v) ? v : { $num: String(v) }
      case 'object': {
        if (v === null) {
          return null
        }
        const handle = hostObjectID?.(v)
        if (handle !== undefined) {
          return { $hostObject: handle }
        }
        const typed = encodeTyped(v)
        if (typed !== undefined) {
          return typed
        }
        if (Array.isArray(v)) {
          const items: unknown[] = []
          for (let i = 0; i < v.length; i++) {
            path.push(String(i))
            items.push(encode(v[i]))
            path.pop()
          }
          return items
        }
        const out: Record<string, unknown> = Object.create(null)
        const keys = Object.keys(v)
        for (const key of keys) {
          path.push(key)
          out[key] = encode((v as AnyObject)[key])
          path.pop()
        }
        return keys.length === 1 && reservedKeys.has(keys[0]!) ? { $obj: out } : out
      }
      case 'symbol':
      case 'undefined':
        return { $undefined: true }
      default:
        return v
    }
  }
  return encode(value)
}
