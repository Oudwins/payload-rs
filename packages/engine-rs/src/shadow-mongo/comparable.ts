/**
 * Typed, order-preserving view of MongoDB values for the shadow comparison and the parity goldens.
 *
 * A plain deep comparison walks own enumerable keys of class instances, which makes every
 * `RegExp` equal to every other and reports bson values by their internal fields. Before
 * comparing, both sides are mapped through `toComparable`, which keeps key order, array order,
 * `undefined`, Dates and Buffers, and spells bson values with the canonical markers of
 * MONGO_ENGINE_CONTRACT.md "Values":
 *
 * - bson `ObjectId` -> `{ $oid: <24 lowercase hex> }`
 * - `RegExp` -> `{ $regex: { source, flags } }`
 * - bson `Decimal128` -> `{ $decimal: toString() }`
 * - bson `Binary` -> `{ $binary: { base64, subType } }` (a Node Buffer stays a Uint8Array, so
 *   Buffer vs Binary is a type difference)
 * - other bson values (`Long`, `Int32`, `Double`, `Timestamp`, `MinKey`, ...) ->
 *   `{ $bson: <_bsontype>, value: <toString()> }`
 * - hydrated mongoose documents -> `{ $mongooseDocument: toObject() }`
 * - `Map` -> `{ $map: [[key, value], ...] }`
 * - other class instances -> `{ $class: <constructor name>, value: { ...own enumerable keys } }`
 *
 * A bson value is recognised only when it really is one (`Symbol.for('@@mdb.bson.version')` on
 * its prototype chain, which every bson class since v5 carries, or a mongoose/driver ObjectId
 * class): a plain object that merely carries `_bsontype: 'ObjectId'` is user data.
 *
 * The spelling is unambiguous: a user (plain) object with any marker key (`$oid`, `$regex`, ...,
 * and the golden/report markers `$date`, `$undefined`, ...) is wrapped as `{ $obj: { ... } }`, so
 * an ObjectId and the user value `{ $oid: '<same hex>' }` never compare equal.
 *
 * `replaceString` lets the candidate side map its own database name to the reference's in
 * strings (MongoDB error messages name the namespace, e.g. `E11000 ... collection: <db>.posts`).
 *
 * Functions are `{ $function: { name, length } }` (never equal to each other by type alone).
 *
 * Shadow-only options (both sides live in one process):
 * - `identities`: objects / functions of a call's arguments (taken before the call) by label; such
 *   a value is spelled `{ $arg: <label>, value }`, so returning or keeping the caller's very object
 *   differs from returning or assigning an equal copy (argument identity, in-place mutation vs
 *   replacement).
 * - `prototypes`: every non-plain object (and a null-prototype or subclassed array / object)
 *   carries `$proto: <id>`, one id per prototype object in this process, so equally named but
 *   distinct classes (another bson copy, another Error class) differ.
 * - `opaque`: values spelled by a label instead of their content (ClientSessions mapped between
 *   the two sides).
 */
export type ComparableOptions = {
  identities?: Map<unknown, string>
  opaque?: (value: object) => string | undefined
  prototypes?: boolean
  replaceString?: (value: string) => string
}

/** Keys that mark typed values in comparable trees, goldens and reports. */
export const MARKER_KEYS = new Set([
  '$arg',
  '$bigint',
  '$binary',
  '$bson',
  '$bytes',
  '$circular',
  '$class',
  '$date',
  '$decimal',
  '$error',
  '$function',
  '$map',
  '$mongooseDocument',
  '$number',
  '$obj',
  '$oid',
  '$opaque',
  '$proto',
  '$regex',
  '$undefined',
])

const BSON_VERSION = Symbol.for('@@mdb.bson.version')

const isPlainObject = (value: object) => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** `_bsontype` of a real bson value (never of a plain object carrying that key). */
const bsonTypeOf = (value: object): string | undefined => {
  if (isPlainObject(value) || !(BSON_VERSION in value)) {
    return undefined
  }
  const type = (value as { _bsontype?: unknown })._bsontype
  return typeof type === 'string' ? type : undefined
}

const isMongooseDocument = (value: object) =>
  !isPlainObject(value) &&
  '$__' in value &&
  typeof (value as { toObject?: unknown }).toObject === 'function'

const hasMarkerKey = (value: object) => Object.keys(value).some((key) => MARKER_KEYS.has(key))

const prototypeIDs = new WeakMap<object, number>()
let nextPrototypeID = 0

/** One id per prototype object in this process (`null` for a null prototype). */
const prototypeID = (value: object): null | number => {
  const proto = Object.getPrototypeOf(value) as null | object
  if (proto === null) {
    return null
  }
  let id = prototypeIDs.get(proto)
  if (id === undefined) {
    id = ++nextPrototypeID
    prototypeIDs.set(proto, id)
  }
  return id
}

const ordinaryPrototypes = new Set<unknown>([Array.prototype, Object.prototype])

export function toComparable(value: unknown, options: ComparableOptions = {}): unknown {
  const seen = new Map<object, unknown>()

  const ownKeys = (input: object, out: Record<string, unknown>) => {
    for (const key of Object.keys(input)) {
      out[key] = walk((input as Record<string, unknown>)[key])
    }
    return out
  }

  const walk = (input: unknown): unknown => {
    const label = options.identities?.get(input)
    if (label === undefined) {
      return walkValue(input)
    }
    if (typeof input === 'object' && input !== null && seen.has(input)) {
      return seen.get(input)
    }
    // the content first (it registers the object for cycles), then later references reach the
    // labelled spelling
    const out = { $arg: label, value: walkValue(input) }
    if (typeof input === 'object' && input !== null) {
      seen.set(input, out)
    }
    return out
  }

  const walkValue = (input: unknown): unknown => {
    if (typeof input === 'string') {
      return options.replaceString ? options.replaceString(input) : input
    }
    if (typeof input === 'function') {
      return { $function: { name: input.name, length: input.length } }
    }
    if (input === null || typeof input !== 'object') {
      return input
    }
    if (seen.has(input)) {
      return seen.get(input)
    }
    const opaque = options.opaque?.(input)
    if (opaque !== undefined) {
      return { $opaque: opaque }
    }
    // a hydrated document's prototype is its side's own Model (one connection per side)
    if (
      options.prototypes &&
      !ordinaryPrototypes.has(Object.getPrototypeOf(input)) &&
      !isMongooseDocument(input)
    ) {
      const out: { $proto: null | number; value?: unknown } = { $proto: prototypeID(input) }
      seen.set(input, out)
      out.value = walkTyped(input)
      return out
    }
    return walkTyped(input)
  }

  const walkTyped = (input: object): unknown => {
    if (input instanceof Date || input instanceof Error) {
      return input
    }
    const bsonType = bsonTypeOf(input)
    if (bsonType === 'ObjectId' || bsonType === 'ObjectID') {
      return { $oid: (input as { toHexString: () => string }).toHexString() }
    }
    if (bsonType === 'Decimal128') {
      return { $decimal: (input as { toString: () => string }).toString() }
    }
    if (bsonType === 'Binary') {
      const binary = input as { sub_type: number; toString: (encoding: string) => string }
      return { $binary: { base64: binary.toString('base64'), subType: binary.sub_type } }
    }
    if (bsonType) {
      return { $bson: bsonType, value: (input as { toString: () => string }).toString() }
    }
    if (input instanceof RegExp) {
      return { $regex: { flags: input.flags, source: input.source } }
    }
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      return input
    }
    if (Array.isArray(input)) {
      const out: unknown[] = []
      seen.set(input, out)
      for (const item of input) {
        out.push(walk(item))
      }
      return out
    }
    if (input instanceof Map) {
      const out: { $map: unknown[] } = { $map: [] }
      seen.set(input, out)
      for (const [key, item] of input) {
        out.$map.push([walk(key), walk(item)])
      }
      return out
    }
    if (isMongooseDocument(input)) {
      const out: Record<string, unknown> = {}
      seen.set(input, out)
      out.$mongooseDocument = walk((input as { toObject: () => unknown }).toObject())
      return out
    }
    if (!isPlainObject(input)) {
      const value: Record<string, unknown> = {}
      const out = { $class: input.constructor?.name ?? 'unknown', value }
      seen.set(input, out)
      ownKeys(input, value)
      return out
    }
    if (hasMarkerKey(input)) {
      const inner: Record<string, unknown> = {}
      const out = { $obj: inner }
      seen.set(input, out)
      ownKeys(input, inner)
      return out
    }
    const out: Record<string, unknown> = {}
    seen.set(input, out)
    return ownKeys(input, out)
  }

  return walk(value)
}
