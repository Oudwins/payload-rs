/**
 * Captures every `transformForWrite` call (args + output) as golden fixtures for the Rust port
 * (crates/payload-sql-write/tests/replay.rs).
 *
 * Encoding (shared with the Rust side, see `encode_value` in crates/payload-sql-write/src/types.rs):
 * - values use the `serializeForEngine` conventions: `{"$undefined":true}`, `{"$num":"NaN"}`,
 *   `{"$date":iso|null}`, `{"$bigint":"1"}`, `{"$obj":{...}}` escapes (fixtures recorded before
 *   typed values existed store dates as ISO strings)
 * - the input `data` is a graph (`dataGraph`: `{ objects, root }` with `{"$ref":id}` for objects
 *   reachable more than once, cycles included), so object identity survives; outputs and
 *   `dataAfter` are trees
 * - `Set` as an array, drizzle `SQL` as `{"$sql":[{"str":"..."} | param]}`
 * - fields and config blocks keep only the keys the write transform reads, block objects carry
 *   `block[InternalBlockTableNameIndex]` under `__internalBlockTableNameIndex`
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import { InternalBlockTableNameIndex } from '../../../packages/drizzle/src/utilities/validateExistingBlockIsIdentical.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
export const fixturesDir = path.resolve(dirname, 'fixtures')

export const BLOCK_INDEX_KEY = '__internalBlockTableNameIndex'
const SCHEMA_KEYS = new Set([
  'blocks',
  'flattenedFields',
  'hasMany',
  'localized',
  'name',
  'relationTo',
  'slug',
  'type',
  'virtual',
])
const RESERVED_KEYS = new Set([
  '$bigint',
  '$date',
  '$fn',
  '$num',
  '$obj',
  '$ref',
  '$sql',
  '$undefined',
])
const MAX_CALLS_PER_GROUP = Number(process.env.RS_WRITE_MAX_CALLS ?? 4000)

const isSQL = (v: any): boolean =>
  Boolean(v) &&
  typeof v === 'object' &&
  Array.isArray(v.queryChunks) &&
  typeof v.getSQL === 'function'

const isStringChunk = (v: any): boolean =>
  Boolean(v) &&
  typeof v === 'object' &&
  Array.isArray(v.value) &&
  v.constructor?.name === 'StringChunk'

type Encode = (v: unknown, depth: number) => unknown

export const encodeValue = (
  v: unknown,
  depth = 0,
  child: Encode = (x, d) => encodeValue(x, d),
): unknown => {
  if (depth > 200) {
    throw new Error('encodeValue: value too deep (cycle?)')
  }
  switch (typeof v) {
    case 'bigint':
      return { $bigint: String(v) }
    case 'boolean':
    case 'string':
      return v
    case 'function':
      return { $fn: 0 }
    case 'number':
      return Number.isFinite(v) ? v : { $num: String(v) }
    case 'symbol':
    case 'undefined':
      return { $undefined: true }
  }
  if (v === null) {
    return null
  }
  if (v instanceof Date) {
    return { $date: Number.isNaN(v.getTime()) ? null : v.toISOString() }
  }
  if (v instanceof Set) {
    return Array.from(v).map((x) => child(x, depth + 1))
  }
  if (isSQL(v)) {
    return {
      $sql: (v as any).queryChunks.map((c: any) =>
        isStringChunk(c) ? { str: c.value.join('') } : child(c, depth + 1),
      ),
    }
  }
  if (Array.isArray(v)) {
    return Array.from(v, (x) => child(x, depth + 1))
  }
  // null prototype: an own `__proto__` key (e.g. from JSON.parse) stays an own key
  const out: Record<string, unknown> = Object.create(null)
  const keys = Object.keys(v as object)
  for (const key of keys) {
    out[key] = child((v as Record<string, unknown>)[key], depth + 1)
  }
  return keys.length === 1 && RESERVED_KEYS.has(keys[0]!) ? { $obj: out } : out
}

/**
 * `{ objects, root }` (`decode_graph_typed`): objects reachable more than once (or from inside
 * themselves) are stored once in `objects` and referenced as `{"$ref": id}`.
 */
export const encodeGraph = (root: unknown): { objects: unknown[]; root: unknown } => {
  const counts = new Map<object, number>()
  const visit = (v: unknown) => {
    if (!v || typeof v !== 'object') {
      return
    }
    const n = (counts.get(v) ?? 0) + 1
    counts.set(v, n)
    if (n === 1 && !(v instanceof Date) && !isSQL(v)) {
      for (const item of v instanceof Set || Array.isArray(v) ? Array.from(v) : Object.values(v)) {
        visit(item)
      }
    }
  }
  visit(root)
  const ids = new Map<object, number>()
  const objects: unknown[] = []
  const encode: Encode = (v, depth) => {
    if (
      v &&
      typeof v === 'object' &&
      (counts.get(v) ?? 0) > 1 &&
      !(v instanceof Set) &&
      !isSQL(v)
    ) {
      let id = ids.get(v)
      if (id === undefined) {
        id = objects.length
        ids.set(v, id)
        objects.push(null)
        objects[id] = encodeValue(v, 0, encode)
      }
      return { $ref: id }
    }
    return encodeValue(v, depth, encode)
  }
  return { objects, root: encode(root, 0) }
}

/** Encodes fields / blocks keeping only what the write transform reads. */
export const encodeSchema = (v: unknown, stack: object[] = []): unknown => {
  if (Array.isArray(v)) {
    return v.map((x) => encodeSchema(x, stack))
  }
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if (stack.includes(v)) {
      return { $cycle: true }
    }
    stack.push(v)
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(v)) {
      if (SCHEMA_KEYS.has(key)) {
        out[key] = encodeSchema((v as Record<string, unknown>)[key], stack)
      }
    }
    const blockIndex = (v as any)[InternalBlockTableNameIndex]
    if (blockIndex !== undefined) {
      out[BLOCK_INDEX_KEY] = blockIndex
    }
    stack.pop()
    return out
  }
  return encodeValue(v)
}

type Group = {
  adapter: Record<string, unknown>
  calls: Record<string, unknown>[]
  fields: Record<string, unknown>
  fieldsIDs: WeakMap<object, string>
  seen: Set<string>
}

const groups = new Map<object, Group>()
let label = 'unknown'
let enabled = true

export const setCaptureLabel = (value: string) => {
  label = value
}

export const setCaptureEnabled = (value: boolean) => {
  enabled = value
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)

const getGroup = (adapter: any): Group => {
  let group = groups.get(adapter)
  if (!group) {
    const tables: Record<string, boolean> = {}
    for (const [name, table] of Object.entries(adapter.tables ?? {})) {
      if (table) {
        tables[name] = Boolean((table as any)._uuid)
      }
    }
    group = {
      adapter: {
        name: adapter.name,
        blocksAsJSON: Boolean(adapter.blocksAsJSON),
        configBlocks: encodeSchema(adapter.payload.config.blocks ?? []),
        tableNameMap: Object.fromEntries(adapter.tableNameMap),
        tables,
      },
      calls: [],
      fields: {},
      fieldsIDs: new WeakMap(),
      seen: new Set(),
    }
    groups.set(adapter, group)
  }
  return group
}

const getFieldsID = (group: Group, fields: unknown): string => {
  if (fields && typeof fields === 'object') {
    const cached = group.fieldsIDs.get(fields)
    if (cached) {
      return cached
    }
  }
  const encoded = encodeSchema(fields)
  const id = hash(JSON.stringify(encoded))
  group.fields[id] = encoded
  if (fields && typeof fields === 'object') {
    group.fieldsIDs.set(fields, id)
  }
  return id
}

/** Runs `fn` with `new Date()` / `Date.now()` frozen at `now` (instanceof keeps working). */
export const withFrozenDate = <T>(now: number, fn: () => T): T => {
  const RealDate = Date
  class FrozenDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(now)
      } else {
        // @ts-expect-error spread into Date constructor
        super(...args)
      }
    }
    static override now() {
      return now
    }
    static [Symbol.hasInstance](x: unknown) {
      return x instanceof RealDate
    }
  }
  globalThis.Date = FrozenDate as DateConstructor
  try {
    return fn()
  } finally {
    globalThis.Date = RealDate
  }
}

export const wrapTransformForWrite = <F extends (args: any) => any>(original: F): F =>
  ((args: any) => {
    if (!enabled) {
      return original(args)
    }
    let call: Record<string, unknown>
    let group: Group
    try {
      group = getGroup(args.adapter)
      call = {
        fields: getFieldsID(group, args.fields),
        tableName: args.tableName,
        path: encodeValue(args.path),
        parentIsLocalized: Boolean(args.parentIsLocalized),
        enableAtomicWrites: Boolean(args.enableAtomicWrites),
        blocksAsJSON: Boolean(args.adapter?.blocksAsJSON),
        adapterName: args.adapter?.name,
        dataGraph: encodeGraph(args.data),
      }
    } catch {
      return original(args)
    }

    const now = Date.now()
    let output: unknown
    let error: unknown
    let threw = false
    try {
      output = withFrozenDate(now, () => original(args))
    } catch (e) {
      error = e
      threw = true
    }

    const key = hash(JSON.stringify(call))
    if (!group.seen.has(key) && group.calls.length < MAX_CALLS_PER_GROUP) {
      group.seen.add(key)
      call.now = now
      if (threw) {
        call.error = { name: (error as Error)?.name, message: (error as Error)?.message }
      } else {
        call.output = encodeValue(output)
      }
      try {
        call.dataAfter = encodeValue(args.data)
        group.calls.push(call)
      } catch {
        // not encodable, skip
      }
    }

    if (threw) {
      throw error
    }
    return output
  }) as F

/** Writes all groups captured so far to `fixtures/<label>.json.gz` and resets the store. */
export const flushFixtures = (name = label) => {
  const nonEmpty = [...groups.values()].filter((g) => g.calls.length)
  groups.clear()
  if (!nonEmpty.length) {
    return null
  }
  fs.mkdirSync(fixturesDir, { recursive: true })
  const file = path.join(fixturesDir, `${name.replace(/[^\w.-]+/g, '__')}.json.gz`)
  fs.writeFileSync(
    file,
    zlib.gzipSync(
      JSON.stringify({
        groups: nonEmpty.map(({ adapter, calls, fields }) => ({ adapter, calls, fields })),
      }),
      { level: 9 },
    ),
  )
  return { calls: nonEmpty.reduce((n, g) => n + g.calls.length, 0), file }
}
