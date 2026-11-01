/**
 * Differential harness for the Rust core runtime: runs the upstream TS `afterRead` and the Rust
 * port on identical inputs and records, for each run,
 * - the resulting document (with object-identity sharing),
 * - every user callback invocation (field afterRead hooks, field read access, defaultValue
 *   functions, rich text editor afterRead hooks) in call order, with an args snapshot taken at
 *   call time (key order, values, identity of data/siblingData/field/siblingFields/req/context,
 *   `this`), plus when each returned promise settles (microtask interleaving),
 * - the rejection (class, message, identity of the thrown value).
 */
import type {
  Field,
  Payload,
  PayloadRequest,
  SanitizedCollectionConfig,
  SanitizedGlobalConfig,
} from 'payload'

import {
  afterRead as afterReadRS,
  traverseFields as afterReadTraverseFieldsRS,
} from '../../../packages/engine-rs/src/runtime/index.js'
import { upstreamAfterRead as afterReadTS } from '../../../packages/payload/src/fields/hooks/afterRead/index.js'
import { traverseFields as afterReadTraverseFieldsTS } from '../../../packages/payload/src/fields/hooks/afterRead/traverseFields.js'
import { getSelectMode } from '../../../packages/payload/src/utilities/getSelectMode.js'
import { createPayloadRequest } from '../../../packages/payload/src/utilities/createPayloadRequest.js'
import { assertDistinctEngines, startEngineRun } from '../dispatch/engineGuard.js'
import { settleRun, trackDatabaseIO } from '../dispatch/settle.js'

assertDistinctEngines('afterRead', afterReadTS, afterReadRS)
assertDistinctEngines(
  'afterRead traverseFields',
  afterReadTraverseFieldsTS,
  afterReadTraverseFieldsRS,
)

export type Engine = 'rs' | 'ts'

type Recorder = {
  configLabels: WeakMap<object, string>
  current?: {
    events: unknown[]
    ids: WeakMap<object, number>
    nextID: number
    req?: PayloadRequest
    thrown: unknown[]
  }
}

const recorder: Recorder = { configLabels: new WeakMap() }

/**
 * Doc access tracing. Traced runs wrap every non-array object of the input docs in a Proxy that
 * records each [[Get]]/[[Set]]/[[Delete]]/[[HasProperty]]/[[OwnPropertyKeys]]/
 * [[GetOwnProperty]]/[[DefineOwnProperty]] on the doc graph into the event log, in order and
 * interleaved with the callback events. This makes every doc read observable (as a getter or a
 * proxy in user data would see it), so fast paths that skip, add or reorder reads show up as
 * diffs. Arrays stay unwrapped (`napi_is_array` and `Array.isArray` differ on proxies; see
 * RUST_CORE_DESIGN.md section 7) but their object elements are wrapped.
 */
let isTracing = false

const withoutTracing = <T>(fn: () => T): T => {
  const was = isTracing
  isTracing = false
  try {
    return fn()
  } finally {
    isTracing = was
  }
}

const traceKey = (key: PropertyKey) =>
  typeof key === 'symbol' ? `$symbol:${key.description}` : String(key)

/** Wraps the doc graph (in place for children) in recording proxies; shared objects map to one proxy. */
const traceDocs = (docs: Record<string, unknown>[]): Record<string, unknown>[] => {
  const proxies = new Map<object, object>()
  let nextTraceID = 0
  const wrapValue = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || value instanceof Date) {
      return value
    }
    const existing = proxies.get(value)
    if (existing) {
      return existing
    }
    if (Array.isArray(value)) {
      proxies.set(value, value)
      if (Object.isExtensible(value) && !Object.isFrozen(value)) {
        for (let i = 0; i < value.length; i++) {
          if (i in value) {
            value[i] = wrapValue(value[i])
          }
        }
      }
      return value
    }
    const traceID = nextTraceID++
    const log = (op: string, key?: PropertyKey) => {
      if (isTracing) {
        recorder.current?.events.push({
          key: key === undefined ? undefined : traceKey(key),
          op,
          traceID,
        })
      }
    }
    const proxy = new Proxy(value as Record<PropertyKey, unknown>, {
      defineProperty: (target, key, descriptor) => {
        log('define', key)
        return Reflect.defineProperty(target, key, descriptor)
      },
      deleteProperty: (target, key) => {
        log('delete', key)
        return Reflect.deleteProperty(target, key)
      },
      get: (target, key, receiver) => {
        log('get', key)
        return Reflect.get(target, key, receiver)
      },
      getOwnPropertyDescriptor: (target, key) => {
        log('getOwnProperty', key)
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      has: (target, key) => {
        log('has', key)
        return Reflect.has(target, key)
      },
      ownKeys: (target) => {
        log('ownKeys')
        return Reflect.ownKeys(target)
      },
      set: (target, key, newValue, receiver) => {
        log('set', key)
        return Reflect.set(target, key, newValue, receiver)
      },
    })
    proxies.set(value, proxy)
    if (Object.isExtensible(value) && !Object.isFrozen(value)) {
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor && 'value' in descriptor && descriptor.writable) {
          ;(value as Record<string, unknown>)[key] = wrapValue(descriptor.value)
        }
      }
    }
    return proxy
  }
  return docs.map((doc) => wrapValue(doc) as Record<string, unknown>)
}

const wrapped = new WeakSet<Function>()

/** Label for values that must keep identity across engines but are not data. */
const label = (v: object): string | undefined => {
  const r = recorder.current
  if (r?.req && v === r.req) {
    return '$req'
  }
  if (r?.req && v === r.req.context) {
    return '$context'
  }
  if (r?.req && v === r.req.payload) {
    return '$payload'
  }
  return recorder.configLabels.get(v)
}

/** Run-wide identity number of an object (stable across snapshots within one run). */
const identity = (v: object): number => {
  const r = recorder.current!
  let id = r.ids.get(v)
  if (id === undefined) {
    id = r.nextID++
    r.ids.set(v, id)
  }
  return id
}

/**
 * Content snapshot taken now. Objects carry their run-wide identity (`@`); an object repeated
 * within the same snapshot becomes `$ref@n` (cycles, shared references).
 */
export const snap = (v: unknown, maxDepth = 64, seen = new Set<object>(), depth = 0): unknown => {
  switch (typeof v) {
    case 'bigint':
      return `$bigint:${v}`
    case 'function':
      return recorder.configLabels.get(v) ?? '$fn'
    case 'number':
      return Number.isFinite(v) ? v : `$num:${v}`
    case 'object': {
      if (v === null) {
        return null
      }
      const l = label(v)
      if (l) {
        return l
      }
      if (v instanceof Date) {
        return `$date:${v.toISOString()}`
      }
      if (v instanceof Promise) {
        return `$promise@${identity(v)}`
      }
      const id = identity(v)
      if (seen.has(v)) {
        return `$ref@${id}`
      }
      if (depth >= maxDepth) {
        return `$deep@${id}`
      }
      seen.add(v)
      if (Array.isArray(v)) {
        return { '@': id, $array: Array.from(v, (item) => snap(item, maxDepth, seen, depth + 1)) }
      }
      const out: Record<string, unknown> = { '@': id }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        out.$class = proto?.constructor?.name
      }
      for (const key of Object.keys(v)) {
        let value: unknown
        try {
          value = (v as Record<string, unknown>)[key]
        } catch (error) {
          out[key] = `$getterThrew:${error instanceof Error ? error.message : String(error)}`
          continue
        }
        out[key] = snap(value, maxDepth, seen, depth + 1)
      }
      return out
    }
    case 'symbol':
      return '$symbol'
    case 'undefined':
      return '$undefined'
    default:
      return v
  }
}

const identityOnlyArgs = new Set(['data', 'doc', 'originalDoc'])

/** Snapshot of a callback's argument: hook args objects keep key order; docs by identity. */
const snapArg = (arg: unknown): unknown => {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg) || label(arg)) {
    return snap(arg, 6)
  }
  const out: Record<string, unknown> = { '@': identity(arg) }
  for (const key of Object.keys(arg)) {
    const value = (arg as Record<string, unknown>)[key]
    out[key] =
      identityOnlyArgs.has(key) && value && typeof value === 'object'
        ? `@${identity(value)}`
        : snap(value, 6)
  }
  return out
}

const record = (event: () => Record<string, unknown>) => {
  if (recorder.current) {
    recorder.current.events.push(withoutTracing(event))
  }
}

/** Wraps a user callback so each call (and the settling of its result) is recorded. */
const wrap = (fn: Function, kind: string, id: string): Function => {
  if (wrapped.has(fn)) {
    return fn
  }
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const seq = recorder.current?.events.length
    record(() => ({ id, kind, seq, args: args.map(snapArg), this: snap(this, 1) }))
    let result: unknown
    try {
      result = fn.apply(this, args)
    } catch (error) {
      recorder.current?.thrown.push(error)
      record(() => ({ id, kind, seq, threw: describeError(error) }))
      throw error
    }
    if (withoutTracing(() => result && typeof (result as Promise<unknown>).then === 'function')) {
      ;(result as Promise<unknown>).then(
        (value) => record(() => ({ id, kind, seq, settled: snap(value, 6) })),
        (error) => {
          recorder.current?.thrown.push(error)
          record(() => ({ id, kind, seq, rejected: describeError(error) }))
        },
      )
    } else {
      record(() => ({ id, kind, seq, returned: snap(result, 6) }))
    }
    return result
  }
  wrapped.add(wrapper)
  recorder.configLabels.set(wrapper, `$cfg:${kind}:${id}`)
  return wrapper
}

const describeError = (error: unknown) =>
  error instanceof Error
    ? { class: error.constructor.name, message: error.message }
    : snap(error, 4)

/**
 * Wraps every afterRead-relevant user callback in the sanitized config and labels config objects
 * (fields, field arrays, blocks, collections, globals) so snapshots can refer to them by path.
 */
export const instrument = (payload: Payload): void => {
  const visitFields = (fields: unknown, path: string) => {
    if (!Array.isArray(fields) || recorder.configLabels.has(fields)) {
      return
    }
    recorder.configLabels.set(fields, `$cfg:fields:${path}`)
    fields.forEach((field: any, index: number) => {
      const fieldPath = `${path}.${field.name ?? `_${index}`}`
      recorder.configLabels.set(field, `$cfg:field:${fieldPath}`)
      if (Array.isArray(field.hooks?.afterRead)) {
        field.hooks.afterRead = field.hooks.afterRead.map((hook: Function, i: number) =>
          wrap(hook, 'hook', `${fieldPath}#${i}`),
        )
      }
      if (typeof field.access?.read === 'function') {
        field.access.read = wrap(field.access.read, 'access', fieldPath)
      }
      if (typeof field.defaultValue === 'function') {
        field.defaultValue = wrap(field.defaultValue, 'defaultValue', fieldPath)
      }
      if (field.type === 'richText' && field.editor && typeof field.editor === 'object') {
        const editor = field.editor
        if (!recorder.configLabels.has(editor)) {
          recorder.configLabels.set(editor, `$cfg:editor:${fieldPath}`)
          if (Array.isArray(editor.hooks?.afterRead)) {
            editor.hooks.afterRead = editor.hooks.afterRead.map((hook: Function, i: number) =>
              wrap(hook, 'editorHook', `${fieldPath}#${i}`),
            )
          }
        }
      }
      if (field.fields) {
        visitFields(field.fields, fieldPath)
      }
      if (Array.isArray(field.tabs)) {
        field.tabs.forEach((tab: any, i: number) => {
          recorder.configLabels.set(tab, `$cfg:tab:${fieldPath}.${tab.name ?? `_${i}`}`)
          // Tabs are traversed as `{ ...tab, type: 'tab' }`: their own hooks/access are wrapped
          // on the tab object so the copies carry the wrappers.
          if (Array.isArray(tab.hooks?.afterRead)) {
            tab.hooks.afterRead = tab.hooks.afterRead.map((hook: Function, j: number) =>
              wrap(hook, 'hook', `${fieldPath}.${tab.name ?? i}#${j}`),
            )
          }
          visitFields(tab.fields, `${fieldPath}.${tab.name ?? `_${i}`}`)
        })
      }
      if (Array.isArray(field.blocks)) {
        field.blocks.forEach((block: any) => {
          if (typeof block === 'object' && block) {
            recorder.configLabels.set(block, `$cfg:block:${block.slug}`)
            visitFields(block.fields, `${fieldPath}.${block.slug}`)
          }
        })
      }
    })
  }
  for (const collection of payload.config.collections) {
    recorder.configLabels.set(collection, `$cfg:collection:${collection.slug}`)
    visitFields(collection.fields, collection.slug)
  }
  for (const global of payload.config.globals) {
    recorder.configLabels.set(global, `$cfg:global:${global.slug}`)
    visitFields(global.fields, global.slug)
  }
  for (const block of payload.config.blocks ?? []) {
    recorder.configLabels.set(block, `$cfg:block:${block.slug}`)
    visitFields(block.fields, `blocks.${block.slug}`)
  }
}

export type Variant = {
  depth: number
  draft?: boolean
  fallbackLocale?: unknown
  findMany?: boolean
  flattenLocales?: boolean
  locale?: string
  name: string
  overrideAccess: boolean
  select?: Record<string, unknown>
  showHiddenFields: boolean
}

export type RunOutcome = {
  /** `req.context` entries after the run (hooks log their internal steps there). */
  contextAfter: unknown
  docs: unknown
  error?: unknown
  errorIsThrownByCallback?: boolean
  events: unknown[]
  identity: boolean[]
}

/**
 * Runs afterRead for `rawDocs` (cloned) with one engine. With `concurrent`, all docs run in one
 * `Promise.all` like the find operation does, so cross-document interleaving is compared too.
 */
export const runAfterRead = async ({
  collection,
  concurrent,
  engine,
  global,
  payload,
  rawDocs,
  rawDocsFactory,
  trace = false,
  traverse = false,
  variant,
}: {
  collection?: SanitizedCollectionConfig
  concurrent: boolean
  engine: Engine
  global?: SanitizedGlobalConfig
  payload: Payload
  rawDocs: Record<string, unknown>[]
  /** Fresh docs per run, not cloned (keeps frozen objects, shared references, getters). */
  rawDocsFactory?: () => Record<string, unknown>[]
  /** Wrap the input docs in recording proxies (see `traceDocs`). */
  trace?: boolean
  /**
   * Call the exported (synchronous) `traverseFields`, what rich text editor hooks call, with the
   * arguments `afterRead` passes it, then await the promise arrays the way `afterRead` does (the
   * same harness code for both engines), instead of `afterRead`. `'nested'`: with the arguments
   * of a nested call (what lexical's block and link sub-field traversals pass): non-empty parent
   * paths, `fieldDepth` 1, `blockData`, `parentIsLocalized: true`.
   */
  traverse?: 'nested' | boolean
  variant: Variant
}): Promise<RunOutcome> => {
  const afterRead = engine === 'ts' ? afterReadTS : afterReadRS
  const traverseFields = engine === 'ts' ? afterReadTraverseFieldsTS : afterReadTraverseFieldsRS
  const engineRun = startEngineRun(engine, 'afterRead')
  trackDatabaseIO(payload)
  const req = await createPayloadRequest({
    context: { rsDifferential: true },
    fallbackLocale: variant.fallbackLocale as any,
    locale: variant.locale,
    payload,
    user: null,
  } as any)
  const plainDocs = [...rawDocs.map((doc) => structuredClone(doc)), ...(rawDocsFactory?.() ?? [])]
  const docs = trace ? traceDocs(plainDocs) : plainDocs
  recorder.current = { events: [], ids: new WeakMap(), nextID: 0, req, thrown: [] }
  isTracing = trace
  // Each doc's afterRead settling is an event too, so the microtask at which it settles
  // (which depends on how many promises the traversal created) is compared.
  const run = (doc: Record<string, unknown>) => {
    const index = docs.indexOf(doc)
    const promise = runOne(doc)
    promise.then(
      () => record(() => ({ docSettled: index, ok: true })),
      () => record(() => ({ docSettled: index, ok: false })),
    )
    return promise
  }
  const runTraverseFields = async (doc: Record<string, unknown>) => {
    const fieldPromises: Promise<void>[] = []
    const populationPromises: Promise<void>[] = []
    const select = variant.select as any
    const nested = traverse === 'nested'
    traverseFields({
      blockData: nested ? { id: 'block-data', blockType: 'nestedBlock' } : undefined,
      collection: collection ?? null,
      context: req.context,
      currentDepth: 1,
      depth: variant.depth ?? payload.config.defaultDepth,
      doc,
      draft: variant.draft ?? false,
      fallbackLocale: (variant.fallbackLocale ?? req.fallbackLocale) as any,
      fieldDepth: nested ? 1 : 0,
      fieldPromises,
      fields: (collection ?? global)!.fields,
      findMany: variant.findMany!,
      flattenLocales: variant.flattenLocales ?? true,
      global: global ?? null,
      locale: variant.locale ?? req.locale!,
      overrideAccess: variant.overrideAccess,
      parentIndexPath: nested ? '1-2' : '',
      parentIsLocalized: nested,
      parentPath: nested ? 'outer.0' : '',
      parentSchemaPath: nested ? 'outer' : '',
      populationPromises,
      req,
      select,
      selectMode: select ? getSelectMode(select) : undefined,
      showHiddenFields: variant.showHiddenFields,
      siblingDoc: doc,
    })
    while (fieldPromises.length > 0 || populationPromises.length > 0) {
      const currentFieldPromises = fieldPromises.splice(0, fieldPromises.length)
      const currentPopulationPromises = populationPromises.splice(0, populationPromises.length)
      await Promise.all(currentFieldPromises)
      await Promise.all(currentPopulationPromises)
    }
    return doc
  }
  const runOne = (doc: Record<string, unknown>) =>
    traverse
      ? runTraverseFields(doc)
      : afterRead({
          collection: collection ?? null,
          context: req.context,
          depth: variant.depth,
          doc,
          draft: variant.draft ?? false,
          fallbackLocale: (variant.fallbackLocale ?? req.fallbackLocale) as any,
          findMany: variant.findMany,
          flattenLocales: variant.flattenLocales,
          global: global ?? null,
          locale: variant.locale ?? req.locale!,
          overrideAccess: variant.overrideAccess,
          req,
          select: variant.select as any,
          showHiddenFields: variant.showHiddenFields,
        })
  const outcome: RunOutcome = { contextAfter: undefined, docs: undefined, events: [], identity: [] }
  try {
    let results: unknown[]
    if (concurrent) {
      results = await Promise.all(docs.map(run))
    } else {
      results = []
      for (const doc of docs) {
        results.push(await run(doc))
      }
    }
    outcome.identity = results.map((result, i) => result === docs[i])
  } catch (error) {
    outcome.error = describeError(error)
    outcome.errorIsThrownByCallback = recorder.current.thrown.includes(error)
  }
  // let stray settle events land before snapshotting
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settleRun({ activity: () => recorder.current?.events.length ?? 0, payload })
  isTracing = false
  outcome.docs = docs.map((doc) => snap(doc))
  outcome.contextAfter = Object.entries(req.context).map(([key, value]) => [key, snap(value, 8)])
  outcome.events = recorder.current.events
  recorder.current = undefined
  engineRun.finish(docs.length)
  return outcome
}

export type FieldsLike = Field[]
