/**
 * Typed, order-preserving view of MongoDB values for the shadow comparison.
 *
 * `compareValues` (../shadow/compare.ts) walks own enumerable keys of class instances, which
 * makes every `RegExp` equal to every other and reports bson values by their internal fields.
 * Before comparing, both sides are mapped through `toComparable`, which keeps key order, array
 * order, `undefined`, Dates (so the timestamp rule still applies) and Buffers, and spells bson
 * values with the canonical markers of MONGO_ENGINE_CONTRACT.md "Values":
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
 * - other class instances -> `{ $class: <constructor name>, ...own enumerable keys }`
 *
 * `replaceString` lets the candidate side map its own database name to the reference's in
 * strings (MongoDB error messages name the namespace, e.g. `E11000 ... collection: <db>.posts`).
 */
export type ComparableOptions = {
  replaceString?: (value: string) => string
}

const isPlainObject = (value: object) => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const bsonTypeOf = (value: object): string | undefined => {
  const type = (value as { _bsontype?: unknown })._bsontype
  return typeof type === 'string' ? type : undefined
}

const isMongooseDocument = (value: object) =>
  '$__' in value && typeof (value as { toObject?: unknown }).toObject === 'function'

export function toComparable(value: unknown, options: ComparableOptions = {}): unknown {
  const seen = new Map<object, unknown>()

  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') {
      return options.replaceString ? options.replaceString(input) : input
    }
    if (input === null || typeof input !== 'object') {
      return input
    }
    if (seen.has(input)) {
      return seen.get(input)
    }
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
    const out: Record<string, unknown> = {}
    seen.set(input, out)
    if (!isPlainObject(input)) {
      out.$class = input.constructor?.name ?? 'unknown'
    }
    for (const key of Object.keys(input)) {
      out[key] = walk((input as Record<string, unknown>)[key])
    }
    return out
  }

  return walk(value)
}
