const reservedKeys = new Set(['$bigint', '$date', '$fn', '$num', '$obj', '$ref', '$undefined'])

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
  '$push',
  '$remove',
  '_locale',
  '_selected',
  '_uuid',
  'a',
  'access',
  'admin',
  'alias',
  'allowIDOnCreate',
  'and',
  'atomic',
  'autosave',
  'b',
  'bad',
  'big',
  'blocks',
  'blockTableNameIndexes',
  'cause',
  'code',
  'collection',
  'collections',
  'column',
  'columns',
  'condition',
  'config',
  'count',
  'createdAt',
  'custom',
  'customID',
  'customIDType',
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
  'drafts',
  'draftsEnabled',
  'drizzle',
  'enumName',
  'extras',
  'field',
  'fields',
  'filenameCompoundIndex',
  'flattenedFields',
  'followingFieldsInvalid',
  'fromDriver',
  'globals',
  'globalSlug',
  'hasMany',
  'hero',
  'hidden',
  'id',
  'in',
  'index',
  'joinPath',
  'joins',
  'length',
  'limit',
  'limitedBoundParameters',
  'locale',
  'localeCodes',
  'locales',
  'localization',
  'localized',
  'localizedPath',
  'localizeStatus',
  'log',
  'max',
  'message',
  'min',
  'mode',
  'name',
  'now',
  'objects',
  'on',
  'options',
  'order',
  'orderBy',
  'owner',
  'page',
  'pagination',
  'params',
  'parent',
  'path',
  'pathHasLocalized',
  'plain',
  'polymorphicJoins',
  'primaryKey',
  'processingToken',
  'processingUntil',
  'publishedLocale',
  'query',
  'rawCode',
  'rawTables',
  'references',
  'relationName',
  'relations',
  'relationTo',
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
  'sql',
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
  'validate',
  'value',
  'valueMustBeUnique',
  'valueOf',
  'version',
  'versionData',
  'versions',
  'virtual',
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
): string => {
  const referenceCounts = new Map<object, number>()
  const functionIDs = new Map<Function, number>()

  const count = (v: unknown) => {
    if (typeof v !== 'object' || v === null) {
      return
    }
    const seen = referenceCounts.get(v)
    referenceCounts.set(v, (seen ?? 0) + 1)
    if (seen || v instanceof Date) {
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
 */
export const deserializeFromEngine = (value: unknown, registry?: FunctionRegistry): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => deserializeFromEngine(item, registry))
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  const entries = Object.entries(value)
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
        return decodeEntries(Object.entries(inner as object), registry)
      case '$undefined':
        return undefined
    }
  }
  return decodeEntries(entries, registry)
}

// `Object.fromEntries` defines own properties, so a `__proto__` key stays a plain key
const decodeEntries = (entries: [string, unknown][], registry?: FunctionRegistry) =>
  Object.fromEntries(entries.map(([key, item]) => [key, deserializeFromEngine(item, registry)]))
