/**
 * Records every top-level call of upstream `transform` (wrapped by ./plugin.ts) for the Rust
 * replay in crates/payload-mongo-transform/tests/replay.rs.
 *
 * Enabled by PAYLOAD_RS_MONGO_TRANSFORM_RECORD_DIR; one JSONL file per process / thread. Lines:
 *
 * - `{ t: 'config', id, graph }`: `adapter.payload.config` reduced to what `transform` reads
 *   (`blocks`, `collections[].{slug, fields}`, `localization`) plus `globals[].{slug, fields}`
 *   (only to reference global fields), in the `serializeForEngine` graph encoding (typed BSON).
 * - `{ t: 'fields', id, config, ref: ['collections' | 'globals', index] }` or
 *   `{ t: 'fields', id, graph }` (deduplicated by content).
 * - `{ t: 'call', config, fields, flags, meta, before, after, identity, nows, ret, error }`:
 *   `before` / `after` are graphs of `{ data, $inc, $push, $addToSet, $pull }` before and after the
 *   call (shared objects stay shared), `identity` lists, for every object of `after` in pre-order of
 *   first visit, the pre-order index of the same object in `before` (-1 for new objects), so the
 *   replay checks in-place mutation and identity exactly. `nows` are the `Date.now()` values of the
 *   `updatedAt` stamps the call wrote (one per document), `error` the thrown error's name/message.
 * - `{ t: 'summary', ... }` at exit, and the same counters in `<pid>-<thread>.summary.json`,
 *   rewritten after every call (vitest workers are often killed without an `exit` event).
 *
 * Calls whose line is identical to an earlier one are counted, not written again. Recording never
 * changes what upstream does: upstream runs exactly once with the original arguments, and its
 * error is rethrown.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { threadId } from 'node:worker_threads'

import {
  createEntryReader,
  createFunctionRegistry,
  type EntryReader,
  serializeForEngine,
} from '../../../packages/engine-rs/src/serialize.js'

type AnyObject = Record<string, any>

const dir = process.env.PAYLOAD_RS_MONGO_TRANSFORM_RECORD_DIR
const maxBytes = Number(process.env.PAYLOAD_RS_MONGO_TRANSFORM_MAX_BYTES || 400_000_000)

let fd: number | undefined
let summaryFD: number | undefined
let depth = 0
let bytes = 0
const counters = { calls: 0, duplicates: 0, failed: 0, skipped: 0, written: 0 }
const configIDs = new WeakMap<object, number>()
const fieldsIDs = new WeakMap<object, number>()
const fieldsByHash = new Map<string, number>()
const seenCalls = new Set<string>()
let nextConfigID = 0
let nextFieldsID = 0

const write = (line: string) => {
  if (fd === undefined) {
    fs.mkdirSync(dir!, { recursive: true })
    fd = fs.openSync(path.join(dir!, `${process.pid}-${threadId}.jsonl`), 'a')
  }
  fs.writeSync(fd, line + '\n')
  bytes += line.length + 1
}

/** Rewrites the summary file in place (positional write, padded so a shorter text overwrites). */
const writeSummary = () => {
  if (summaryFD === undefined) {
    fs.mkdirSync(dir!, { recursive: true })
    summaryFD = fs.openSync(path.join(dir!, `${process.pid}-${threadId}.summary.json`), 'w')
  }
  fs.writeSync(summaryFD, JSON.stringify(counters).padEnd(256), 0)
}

if (dir) {
  process.on('exit', () => {
    if (fd !== undefined) {
      write(JSON.stringify({ t: 'summary', ...counters }))
      fs.closeSync(fd)
    }
  })
}

const bson = {}
const serialize = (value: unknown, reader: EntryReader = createEntryReader()) =>
  serializeForEngine(value, createFunctionRegistry(), reader, bson)

const sha1 = (text: string) => crypto.createHash('sha1').update(text).digest('hex')

/** Values `serializeForEngine` encodes as typed leaves (Date, RegExp, bson, Uint8Array). */
const isLeaf = (value: object) => {
  if (value instanceof Date || value instanceof RegExp || value instanceof Uint8Array) {
    return true
  }
  const type = (value as AnyObject)._bsontype
  return type === 'Binary' || type === 'Decimal128' || type === 'ObjectId'
}

/** Every object reachable from `root`, in pre-order of first visit (as the Rust importer). */
const objectsOf = (root: unknown, reader: EntryReader): object[] => {
  const seen = new Set<object>()
  const out: object[] = []
  const visit = (value: unknown) => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }
    seen.add(value)
    out.push(value)
    if (isLeaf(value)) {
      return
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        visit(value[i])
      }
      return
    }
    for (const [, item] of reader(value)) {
      visit(item)
    }
  }
  visit(root)
  return out
}

/** The documents `transform` stamps, in its order (it recurses into arrays, skips falsy data). */
const documentsOf = (data: unknown, out: [unknown, boolean][] = []) => {
  if (!data) {
    return out
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      documentsOf(item, out)
    }
    return out
  }
  out.push([data, typeof (data as AnyObject).updatedAt === 'undefined'])
  return out
}

const configID = (config: AnyObject) => {
  let id = configIDs.get(config)
  if (id !== undefined) {
    return id
  }
  id = nextConfigID++
  configIDs.set(config, id)
  const reduced = {
    blocks: config?.blocks,
    collections: config?.collections?.map((c: AnyObject) => ({ fields: c.fields, slug: c.slug })),
    globals: config?.globals?.map((g: AnyObject) => ({ fields: g.fields, slug: g.slug })),
    localization: config?.localization,
  }
  write(`{"t":"config","id":${id},"graph":${serialize(reduced)}}`)
  return id
}

const fieldsID = (config: AnyObject, configKey: number, fields: unknown) => {
  if (typeof fields === 'object' && fields !== null) {
    const known = fieldsIDs.get(fields)
    if (known !== undefined) {
      return known
    }
  }
  let ref: [string, number] | undefined
  for (const kind of ['collections', 'globals'] as const) {
    const index = (config?.[kind] ?? []).findIndex((entity: AnyObject) => entity.fields === fields)
    if (index !== -1 && !ref) {
      ref = [kind, index]
    }
  }
  let id: number
  if (ref) {
    id = nextFieldsID++
    write(JSON.stringify({ t: 'fields', id, config: configKey, ref }))
  } else {
    const text = serialize(fields)
    const hash = sha1(text)
    const existing = fieldsByHash.get(hash)
    if (existing !== undefined) {
      id = existing
    } else {
      id = nextFieldsID++
      fieldsByHash.set(hash, id)
      write(`{"t":"fields","id":${id},"graph":${text}}`)
    }
  }
  if (typeof fields === 'object' && fields !== null) {
    fieldsIDs.set(fields, id)
  }
  return id
}

export const recordTransform = (upstream: (args: AnyObject) => unknown, args: AnyObject) => {
  if (!dir || depth > 0) {
    return upstream(args)
  }
  counters.calls++
  if (bytes > maxBytes) {
    counters.skipped++
    writeSummary()
    return upstream(args)
  }
  let prepared:
    | {
        before: string
        beforeObjects: Map<object, number>
        configKey: number
        documents: [unknown, boolean][]
        fieldsKey: number
        meta: string
        state: AnyObject
      }
    | undefined
  try {
    const config = args.adapter?.payload?.config
    const configKey = configID(config)
    const fieldsKey = fieldsID(config, configKey, args.fields)
    const state = {
      data: args.data,
      $inc: args.$inc,
      $push: args.$push,
      $addToSet: args.$addToSet,
      $pull: args.$pull,
    }
    const reader = createEntryReader()
    const beforeObjects = new Map(objectsOf(state, reader).map((object, index) => [object, index]))
    prepared = {
      before: serialize(state, reader),
      beforeObjects,
      configKey,
      documents: documentsOf(args.data),
      fieldsKey,
      meta: serialize({
        globalSlug: args.globalSlug,
        operation: args.operation,
        parentIsLocalized: args.parentIsLocalized,
        validateRelationships: args.validateRelationships,
      }),
      state,
    }
  } catch {
    counters.failed++
  }

  depth++
  let ret: unknown
  let error: unknown
  let threw = false
  try {
    ret = upstream(args)
  } catch (e) {
    threw = true
    error = e
  } finally {
    depth--
  }

  if (prepared) {
    try {
      const reader = createEntryReader()
      const after = serialize(prepared.state, reader)
      const identity = objectsOf(prepared.state, reader).map(
        (object) => prepared.beforeObjects.get(object) ?? -1,
      )
      const nows =
        args.operation === 'write'
          ? prepared.documents
              .filter(
                ([doc, wasUndefined]) =>
                  wasUndefined && typeof (doc as AnyObject)?.updatedAt === 'string',
              )
              .map(([doc]) => Date.parse((doc as AnyObject).updatedAt))
          : []
      const flags = {
        allowAdditionalKeys: Boolean(args.adapter?.allowAdditionalKeys),
        useBigIntForNumberIDs: Boolean(args.adapter?.useBigIntForNumberIDs),
      }
      const errorJSON = threw
        ? JSON.stringify({
            name: (error as AnyObject)?.name ?? null,
            message: (error as AnyObject)?.message ?? String(error),
          })
        : 'null'
      const body =
        `"config":${prepared.configKey},"fields":${prepared.fieldsKey},"flags":${JSON.stringify(flags)},` +
        `"meta":${prepared.meta},"before":${prepared.before},"after":${after},` +
        `"identity":${JSON.stringify(identity)},"nows":${JSON.stringify(nows)},` +
        `"ret":${JSON.stringify(ret === null ? 'null' : ret === undefined ? 'undefined' : 'other')},"error":${errorJSON}`
      const hash = sha1(body)
      if (seenCalls.has(hash)) {
        counters.duplicates++
      } else {
        seenCalls.add(hash)
        counters.written++
        write(`{"t":"call",${body}}`)
      }
    } catch {
      counters.failed++
    }
  }

  writeSummary()
  if (threw) {
    throw error
  }
  return ret
}
