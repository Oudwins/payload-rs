/**
 * Keys a user object whose only key is one of them is `$obj`-escaped for. The BSON keys of the
 * MongoDB boundary (crates/payload-engine/src/bson.rs) are reserved for every engine: escaping is
 * lossless, so this does not change what any decoder returns.
 */
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

/**
 * Options of the MongoDB boundary (MONGO_ENGINE_CONTRACT.md "Values"). Without them nothing
 * changes: BSON values serialize as before and BSON markers decode as plain data.
 */
export type BsonBoundary = {
  /** The bson classes decoded values are built with (the adapter's `mongoose.mongo.BSON`). */
  classes?: {
    Binary: new (buffer: Uint8Array, subType?: number) => unknown
    Decimal128: { fromString: (value: string) => unknown }
    ObjectId: new (hex: string) => unknown
  }
  /** Resolves `{ $hostObject: id }` while decoding. */
  hostObject?: (id: number) => unknown
  /** Returns the host object id of a value that crosses as a handle, `undefined` otherwise. */
  hostObjectID?: (value: object) => number | undefined
}

/** The typed BSON encoding of `value` (crates/payload-engine/src/bson.rs), `undefined` otherwise. */
const encodeBson = (value: object, bson: BsonBoundary): unknown => {
  const hostObjectID = bson.hostObjectID?.(value)
  if (hostObjectID !== undefined) {
    return { $hostObject: hostObjectID }
  }
  if (value instanceof RegExp) {
    return { $regex: { source: value.source, flags: value.flags } }
  }
  const bsonType = (value as { _bsontype?: unknown })._bsontype
  switch (bsonType) {
    case 'Binary': {
      const binary = value as { buffer: Uint8Array; position: number; sub_type: number }
      const bytes = binary.buffer.subarray(0, binary.position)
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
      return { $oid: (value as { toHexString: () => string }).toHexString() }
  }
  if (value instanceof Uint8Array) {
    return { $buffer: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  }
  return undefined
}

export type FunctionRegistry = {
  functions: Function[]
}

export const createFunctionRegistry = (): FunctionRegistry => ({ functions: [] })

/**
 * Property names the Rust engine reads from serialized values. Besides own enumerable properties,
 * `serializeForEngine` includes these when they are not own enumerable properties: own
 * non-enumerable properties and properties inherited from a non-built-in prototype (class
 * instance getters, prototype fields, `Object.create(proto)`), so the engine reads them like JS
 * property access does. `engine_read_keys_cover_engine_sources`
 * (crates/payload-engine/tests/engine_read_keys.rs) checks that every literal property name read in
 * `crates/<crate>/src` is listed.
 */
export const engineReadKeys: ReadonlySet<string> = new Set([
  // engine-read-keys:start
  '$hostError',
  '$inc',
  '$lookup',
  '$oid',
  '$push',
  '$remove',
  '_bsontype',
  '_field',
  '_id',
  '_locale',
  '_selected',
  '_uuid',
  'a',
  'access',
  'adapter',
  'admin',
  'alias',
  'allowIDOnCreate',
  'and',
  'as',
  'atomic',
  'autoPluralization',
  'autosave',
  'b',
  'bad',
  'base64',
  'big',
  'bin',
  'blockTableNameIndexes',
  'blocks',
  'buf',
  'cause',
  'code',
  'collation',
  'collection',
  'collectionName',
  'collections',
  'collectionsSchemaOptions',
  'column',
  'columns',
  'condition',
  'config',
  'count',
  'createdAt',
  'custom',
  'customID',
  'customIDType',
  'd',
  'data',
  'dbName',
  'default',
  'defaultIDType',
  'defaultLimit',
  'defaultLocale',
  'defaultMaxTextLength',
  'defaultSort',
  'defaultValue',
  'disableLocalStrategy',
  'docs',
  'drafts',
  'draftsEnabled',
  'drizzle',
  'enumName',
  'error',
  'extras',
  'fake',
  'field',
  'fields',
  'filenameCompoundIndex',
  'flags',
  'flattenedFields',
  'followingFieldsInvalid',
  'fromDriver',
  'generated',
  'getForeignPath',
  'globalSlug',
  'globals',
  'handle',
  'hasDefault',
  'hasMany',
  'hasReq',
  'hero',
  'hidden',
  'id',
  'in',
  'index',
  'indexSortableFields',
  'isCacheEnabled',
  'isObject',
  'joinPath',
  'joins',
  'kind',
  'length',
  'limit',
  'limitedBoundParameters',
  'locale',
  'localeCodes',
  'locales',
  'localization',
  'localizeStatus',
  'localized',
  'localizedPath',
  'log',
  'max',
  'message',
  'min',
  'mode',
  'models',
  'name',
  'now',
  'objects',
  'ok',
  'on',
  'options',
  'order',
  'orderBy',
  'owner',
  'page',
  'pagination',
  'params',
  'parent',
  'parentIsLocalized',
  'path',
  'pathHasLocalized',
  'plain',
  'polymorphicJoins',
  'primary',
  'primaryKey',
  'processingToken',
  'processingUntil',
  'projection',
  'publishedLocale',
  'query',
  'rawCode',
  'rawTables',
  're',
  'references',
  'relatedAccess',
  'relationName',
  'relationTo',
  'relations',
  'req',
  'required',
  'result',
  'returning',
  'root',
  'sanitizedIndexes',
  'schedulePublish',
  'select',
  'self',
  'slug',
  'snapshot',
  'sort',
  'source',
  'sql',
  'subType',
  'tab',
  'table',
  'tableName',
  'tabs',
  'targetField',
  'timestamps',
  'to',
  'toHexString',
  'toJSON',
  'toString',
  'translations',
  'type',
  'unique',
  'updatedAt',
  'upload',
  'upsert',
  'useBigIntForNumberIDs',
  'validate',
  'value',
  'valueMustBeUnique',
  'valueOf',
  'version',
  'versionData',
  'versions',
  'virtual',
  'when',
  'where',
  'with',
  'withMutations',
  // engine-read-keys:end
])

/** Prototypes whose properties are never serialized (built-ins the engine models itself or not at all). */
const builtinPrototypes = new Set<null | object>([
  Array.prototype,
  ArrayBuffer.prototype,
  BigInt.prototype,
  Boolean.prototype,
  DataView.prototype,
  Date.prototype,
  Error.prototype,
  Function.prototype,
  Map.prototype,
  null,
  Number.prototype,
  Object.getPrototypeOf(Uint8Array.prototype),
  Object.prototype,
  Promise.prototype,
  RegExp.prototype,
  Set.prototype,
  String.prototype,
  Symbol.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
])

export type Entry = [key: string, value: unknown]

/** Reads the properties `serializeForEngine` serializes for a non-array object, once per object. */
export type EntryReader = (v: object) => Entry[]

/**
 * An `EntryReader` that caches the entries per object, so walks that share it (serializing, then
 * finding paths in the same graph) invoke every getter once.
 */
export const createEntryReader = (): EntryReader => {
  const entriesByObject = new Map<object, Entry[]>()
  return (v) => {
    let entries = entriesByObject.get(v)
    if (!entries) {
      entries = readEntries(v)
      entriesByObject.set(v, entries)
    }
    return entries
  }
}

/**
 * Serializes a JS value graph (e.g. the sanitized Payload config) for the Rust engine,
 * preserving what JSON loses and the engine depends on: object identity of shared objects
 * (including cycles), functions (as handles into `registry`), own properties set to `undefined`,
 * non-finite numbers, `Date`s (`{ $date: iso | null }`, `null` when invalid), `bigint`s
 * (`{ $bigint: '123' }`) and own `__proto__` keys.
 *
 * Objects are read like JS property access, each property once:
 * - own enumerable string keys in `Object.keys` order: data properties by value, getters invoked
 *   once with the object as receiver;
 * - then the `engineReadKeys` that are own non-enumerable properties or inherited from a
 *   non-built-in prototype (nearest first), read with `Reflect.get` semantics.
 * Getters on other inherited / non-enumerable properties are never invoked. A getter that throws
 * is serialized as `undefined` (TS would throw where it reads the property).
 * Symbol keys and the internal state of built-ins other than arrays and dates (Map, Set, ...) are
 * not preserved.
 */
export const serializeForEngine = (
  value: unknown,
  registry: FunctionRegistry,
  /** Share one reader with other walks of the same graph (see `createEntryReader`). */
  entriesOf: EntryReader = createEntryReader(),
  /** Encode BSON values typed (MongoDB engine only). */
  bson?: BsonBoundary,
): string => {
  const referenceCounts = new Map<object, number>()
  const functionIDs = new Map<Function, number>()

  const count = (v: unknown) => {
    if (typeof v !== 'object' || v === null) {
      return
    }
    const seen = referenceCounts.get(v)
    referenceCounts.set(v, (seen ?? 0) + 1)
    if (seen || v instanceof Date || (bson && encodeBson(v, bson) !== undefined)) {
      return
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        count(v[i])
      }
    } else {
      for (const [, item] of entriesOf(v)) {
        count(item)
      }
    }
  }

  count(value)

  const objects: unknown[] = []
  const objectIDs = new Map<object, number>()

  const encode = (v: unknown): unknown => {
    switch (typeof v) {
      case 'bigint':
        return { $bigint: v.toString() }
      case 'function': {
        let id = functionIDs.get(v)
        if (id === undefined) {
          id = registry.functions.push(v) - 1
          functionIDs.set(v, id)
        }
        return { $fn: id }
      }
      case 'number':
        return Number.isFinite(v) ? v : { $num: String(v) }
      case 'object': {
        if (v === null) {
          return null
        }
        if ((referenceCounts.get(v) ?? 0) > 1) {
          let id = objectIDs.get(v)
          if (id === undefined) {
            id = objects.push(null) - 1
            objectIDs.set(v, id)
            objects[id] = encodeContainer(v)
          }
          return { $ref: id }
        }
        return encodeContainer(v)
      }
      case 'symbol':
      case 'undefined':
        return { $undefined: true }
      default:
        return v
    }
  }

  const encodeContainer = (v: object): unknown => {
    if (v instanceof Date) {
      return { $date: Number.isNaN(v.getTime()) ? null : v.toISOString() }
    }
    if (bson) {
      const typed = encodeBson(v, bson)
      if (typed !== undefined) {
        return typed
      }
    }
    if (Array.isArray(v)) {
      // index access: holes read as `undefined`
      const items: unknown[] = []
      for (let i = 0; i < v.length; i++) {
        items.push(encode(v[i]))
      }
      return items
    }
    const entries = entriesOf(v)
    // a null-prototype object keeps an own `__proto__` key as a plain key
    const out: Record<string, unknown> = Object.create(null)
    for (const [key, item] of entries) {
      out[key] = encode(item)
    }
    return entries.length === 1 && reservedKeys.has(entries[0]![0]) ? { $obj: out } : out
  }

  const root = encode(value)
  return JSON.stringify({ objects, root })
}

/** `receiver[key]` for a property found as `descriptor` on `receiver` or its prototype chain. */
const readProperty = (receiver: object, descriptor: PropertyDescriptor): unknown => {
  if ('value' in descriptor) {
    return descriptor.value
  }
  try {
    return descriptor.get?.call(receiver)
  } catch {
    return undefined
  }
}

/** The properties `serializeForEngine` serializes for a non-array object, see there. */
const readEntries = (v: object): Entry[] => {
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const key of Object.keys(v)) {
    seen.add(key)
    const descriptor = Object.getOwnPropertyDescriptor(v, key)
    if (descriptor) {
      entries.push([key, readProperty(v, descriptor)])
    }
  }
  for (const key of Object.getOwnPropertyNames(v)) {
    if (!seen.has(key)) {
      seen.add(key)
      if (engineReadKeys.has(key)) {
        entries.push([key, readProperty(v, Object.getOwnPropertyDescriptor(v, key)!)])
      }
    }
  }
  for (
    let proto = Object.getPrototypeOf(v);
    !builtinPrototypes.has(proto);
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || seen.has(key)) {
        continue
      }
      seen.add(key)
      if (engineReadKeys.has(key)) {
        entries.push([key, readProperty(v, Object.getOwnPropertyDescriptor(proto, key)!)])
      }
    }
  }
  return entries
}

/**
 * Decodes a value the engine returns in the `serializeForEngine` encoding (a tree: no `$ref`s).
 * `$fn` handles are resolved through `registry`.
 *
 * Iterative, so values nested deeper than the JS stack allows (V8's `JSON.parse` has no depth
 * limit, and the engine returns what it parsed) decode like shallow ones.
 */
export const deserializeFromEngine = (
  value: unknown,
  registry?: FunctionRegistry,
  /** Decode the BSON markers (MongoDB engine only); without it they stay plain data. */
  bson?: BsonBoundary,
): unknown => {
  // containers are created with their keys in order; their items are decoded afterwards
  const pending: [
    target: Record<string, unknown> | unknown[],
    key: number | string,
    item: unknown,
  ][] = []
  const decodeShallow = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length).fill(undefined)
      for (let i = v.length - 1; i >= 0; i--) {
        pending.push([out, i, v[i]])
      }
      return out
    }
    if (typeof v !== 'object' || v === null) {
      return v
    }
    let entries = Object.entries(v)
    if (entries.length === 1) {
      const [key, inner] = entries[0]!
      switch (key) {
        case '$bigint':
          return BigInt(inner as string)
        case '$date':
          return new Date(inner === null ? NaN : (inner as string))
        case '$fn':
          return registry?.functions[inner as number]
        case '$num':
          return Number(inner)
        case '$obj':
          entries = Object.entries(inner as object)
          break
        case '$undefined':
          return undefined
      }
      if (bson) {
        switch (key) {
          case '$binary': {
            const { base64, subType } = inner as { base64: string; subType: number }
            return new bson.classes!.Binary(Buffer.from(base64, 'base64'), subType)
          }
          case '$buffer':
            return Buffer.from(inner as string, 'base64')
          case '$decimal':
            return bson.classes!.Decimal128.fromString(inner as string)
          case '$hostObject':
            return bson.hostObject!(inner as number)
          case '$oid':
            return new bson.classes!.ObjectId(inner as string)
          case '$regex': {
            const { flags, source } = inner as { flags: string; source: string }
            return new RegExp(source, flags)
          }
        }
      }
    }
    const out: Record<string, unknown> = {}
    for (const [key] of entries) {
      defineOwn(out, key, undefined)
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      pending.push([out, entries[i]![0], entries[i]![1]])
    }
    return out
  }
  const root = decodeShallow(value)
  while (pending.length > 0) {
    const [target, key, item] = pending.pop()!
    const decoded = decodeShallow(item)
    if (Array.isArray(target)) {
      target[key as number] = decoded
    } else {
      defineOwn(target, key as string, decoded)
    }
  }
  return root
}

/** `CreateDataProperty`, as `Object.fromEntries` does: a `__proto__` key stays a plain own key. */
const defineOwn = (target: Record<string, unknown>, key: string, value: unknown) => {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  } else {
    target[key] = value
  }
}
