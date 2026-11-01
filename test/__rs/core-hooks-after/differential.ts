/**
 * Differential harness for the Rust ports of `afterChange` and `beforeDuplicate`: runs the
 * upstream TS functions and the Rust ports on identical inputs and records, for each run,
 * - the resulting `data`/`doc`/`previousDoc` objects (snapshotted together, so object-identity
 *   sharing between and inside them is compared) and whether the result is the input `doc`,
 * - every user callback invocation (field afterChange/beforeDuplicate hooks, rich text editor
 *   afterChange hooks) in call order, with an args snapshot taken at call time (key order,
 *   values, identities, `this`), plus when each returned promise settles (microtask order),
 * - `req.context` after the run,
 * - the rejection (class, message, whether it is the very value user code threw) and unhandled
 *   rejections (detached traversals of upstream's beforeDuplicate).
 */
import type {
  Payload,
  PayloadRequest,
  SanitizedCollectionConfig,
  SanitizedGlobalConfig,
} from 'payload'

import { afterChange as afterChangeRS } from '../../../packages/engine-rs/src/runtime/afterChange/index.js'
import { beforeDuplicate as beforeDuplicateRS } from '../../../packages/engine-rs/src/runtime/beforeDuplicate/index.js'
import { traverseFields as afterChangeTraverseFieldsRS } from '../../../packages/engine-rs/src/runtime/afterChange/index.js'
import { upstreamAfterChange as afterChangeTS } from '../../../packages/payload/src/fields/hooks/afterChange/index.js'
import { traverseFields as afterChangeTraverseFieldsTS } from '../../../packages/payload/src/fields/hooks/afterChange/traverseFields.js'
import { upstreamBeforeDuplicate as beforeDuplicateTS } from '../../../packages/payload/src/fields/hooks/beforeDuplicate/index.js'
import { createPayloadRequest } from '../../../packages/payload/src/utilities/createPayloadRequest.js'
import { assertDistinctEngines, startEngineRun } from '../dispatch/engineGuard.js'

assertDistinctEngines('afterChange', afterChangeTS, afterChangeRS)
assertDistinctEngines(
  'afterChange traverseFields',
  afterChangeTraverseFieldsTS,
  afterChangeTraverseFieldsRS,
)
assertDistinctEngines('beforeDuplicate', beforeDuplicateTS, beforeDuplicateRS)

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
      if (Object.isFrozen(v)) {
        out.$frozen = true
      }
      for (const key of Object.keys(v)) {
        out[key] = snap((v as Record<string, unknown>)[key], maxDepth, seen, depth + 1)
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

/** Snapshot of a callback's argument: hook args objects keep key order and own keys. */
const snapArg = (arg: unknown): unknown => {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg) || label(arg)) {
    return snap(arg, 6)
  }
  const out: Record<string, unknown> = { '@': identity(arg) }
  for (const key of Object.keys(arg)) {
    out[key] = snap((arg as Record<string, unknown>)[key], 6)
  }
  return out
}

const record = (event: Record<string, unknown>) => {
  recorder.current?.events.push(event)
}

/**
 * Records when the promise of run input `index` settles: the microtask at which a traversal's own
 * promise settles (its trailing ticks) is compared, not only the callbacks inside it.
 */
const recordSettle = <P extends Promise<unknown>>(index: number, promise: P): P => {
  promise.then(
    () => record({ inputSettled: index, ok: true }),
    () => record({ inputSettled: index, ok: false }),
  )
  return promise
}

const describeError = (error: unknown) =>
  error instanceof Error
    ? { class: error.constructor.name, message: error.message }
    : snap(error, 4)

/** Wraps a user callback so each call (and the settling of its result) is recorded. */
const wrap = (fn: Function, kind: string, id: string): Function => {
  if (wrapped.has(fn)) {
    return fn
  }
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const seq = recorder.current?.events.length
    record({ id, kind, seq, args: args.map(snapArg), this: snap(this, 1) })
    let result: unknown
    try {
      result = fn.apply(this, args)
    } catch (error) {
      recorder.current?.thrown.push(error)
      record({ id, kind, seq, threw: describeError(error) })
      throw error
    }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      // only native promises are observed (a user thenable's `then` must run exactly as often
      // as the engine calls it)
      if (result instanceof Promise) {
        result.then(
          (value) => record({ id, kind, seq, settled: snap(value, 6) }),
          (error) => {
            recorder.current?.thrown.push(error)
            record({ id, kind, seq, rejected: describeError(error) })
          },
        )
      } else {
        record({ id, kind, seq, returned: '$thenable' })
      }
    } else {
      record({ id, kind, seq, returned: snap(result, 6) })
    }
    return result
  }
  wrapped.add(wrapper)
  recorder.configLabels.set(wrapper, `$cfg:${kind}:${id}`)
  return wrapper
}

const hookNames = ['afterChange', 'beforeDuplicate'] as const

const wrapFieldHooks = (holder: any, path: string) => {
  for (const hookName of hookNames) {
    if (Array.isArray(holder.hooks?.[hookName])) {
      holder.hooks[hookName] = holder.hooks[hookName].map((hook: Function, i: number) =>
        wrap(hook, hookName, `${path}#${i}`),
      )
    }
  }
}

/**
 * Wraps every afterChange/beforeDuplicate user callback in the sanitized config and labels config
 * objects (fields, field arrays, blocks, tabs, editors, collections, globals) by path.
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
      wrapFieldHooks(field, fieldPath)
      if (field.type === 'richText' && field.editor && typeof field.editor === 'object') {
        const editor = field.editor
        if (!recorder.configLabels.has(editor)) {
          recorder.configLabels.set(editor, `$cfg:editor:${fieldPath}`)
          if (Array.isArray(editor.hooks?.afterChange)) {
            editor.hooks.afterChange = editor.hooks.afterChange.map((hook: Function, i: number) =>
              wrap(hook, 'editorAfterChange', `${fieldPath}#${i}`),
            )
          }
        }
      }
      if (field.fields) {
        visitFields(field.fields, fieldPath)
      }
      if (Array.isArray(field.tabs)) {
        field.tabs.forEach((tab: any, i: number) => {
          const tabPath = `${fieldPath}.${tab.name ?? `_${i}`}`
          recorder.configLabels.set(tab, `$cfg:tab:${tabPath}`)
          // tabs are traversed as `{ ...tab, type: 'tab' }` copies, which carry these arrays
          wrapFieldHooks(tab, tabPath)
          visitFields(tab.fields, tabPath)
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

export type RunOutcome = {
  /** `req.context` entries after the run (hooks log their internal steps there). */
  contextAfter: unknown
  docs: unknown
  error?: unknown
  errorIsThrownByCallback?: boolean
  events: unknown[]
  /** `result === doc` per case. */
  identity: boolean[]
  unhandled: unknown[]
}

/** One afterChange input: `data` (before hooks), `doc` (after), `previousDoc`. */
export type AfterChangeCase = {
  data: Record<string, unknown>
  doc: Record<string, unknown>
  previousDoc: Record<string, unknown>
}

type RequestVariant = { fallbackLocale?: unknown; locale?: string }

let lastThrown: unknown[] = []

const finish = async (
  req: PayloadRequest,
  outcome: Omit<RunOutcome, 'contextAfter' | 'events' | 'unhandled'>,
  snapshot: () => unknown,
): Promise<Omit<RunOutcome, 'unhandled'>> => {
  // let stray settle events and detached traversals land before snapshotting
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const current = recorder.current!
  lastThrown = current.thrown
  const result = {
    ...outcome,
    contextAfter: Object.entries(req.context).map(([key, value]) => [key, snap(value, 8)]),
    docs: snapshot(),
    events: current.events,
  }
  recorder.current = undefined
  return result
}

const makeRequest = (payload: Payload, variant: RequestVariant) =>
  createPayloadRequest({
    context: { rsDifferential: true },
    fallbackLocale: variant.fallbackLocale as any,
    locale: variant.locale,
    payload,
    user: null,
  } as any)

const runCases = async <C>({
  cases,
  concurrent,
  invoke,
  req,
  resultOf,
  snapshot,
}: {
  cases: C[]
  concurrent: boolean
  invoke: (c: C) => Promise<unknown>
  req: PayloadRequest
  resultOf: (c: C) => unknown
  snapshot: () => unknown
}): Promise<RunOutcome> =>
  withUnhandledCaptureAndThrown(async () => {
    const outcome: Omit<RunOutcome, 'contextAfter' | 'events' | 'unhandled'> = {
      docs: undefined,
      identity: [],
    }
    try {
      let results: unknown[]
      if (concurrent) {
        results = await Promise.all(cases.map((c, i) => recordSettle(i, invoke(c))))
      } else {
        results = []
        for (const [i, c] of cases.entries()) {
          results.push(await recordSettle(i, invoke(c)))
        }
      }
      outcome.identity = results.map((result, i) => result === resultOf(cases[i]!))
    } catch (error) {
      outcome.error = describeError(error)
      outcome.errorIsThrownByCallback = recorder.current!.thrown.includes(error)
    }
    return finish(req, outcome, snapshot)
  })

/**
 * Captures unhandled rejections during `body` (which also waits a few macrotasks) instead of
 * letting the test runner report them: upstream beforeDuplicate detaches some traversals, whose
 * rejections are unhandled by design.
 */
const withUnhandledCaptureAndThrown = async (
  body: () => Promise<Omit<RunOutcome, 'unhandled'>>,
): Promise<RunOutcome> => {
  const saved = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  const reasons: unknown[] = []
  const handler = (reason: unknown) => {
    reasons.push(reason)
  }
  process.on('unhandledRejection', handler)
  try {
    const outcome = await body()
    return {
      ...outcome,
      unhandled: reasons.map((reason) => ({
        error: describeError(reason),
        isThrownByCallback: lastThrown.includes(reason),
      })),
    }
  } finally {
    process.off('unhandledRejection', handler)
    for (const listener of saved) {
      process.on('unhandledRejection', listener as (...args: unknown[]) => void)
    }
  }
}

/**
 * Runs afterChange for each case (fresh copies) with one engine. With `concurrent`, all cases run
 * in one `Promise.all`, so cross-document interleaving is compared too.
 */
export const runAfterChange = async ({
  cases: makeCases,
  collection,
  concurrent,
  engine,
  global,
  operation,
  payload,
  traverse,
  variant,
}: {
  cases: () => AfterChangeCase[]
  collection?: SanitizedCollectionConfig
  concurrent: boolean
  engine: Engine
  global?: SanitizedGlobalConfig
  operation: 'create' | 'update'
  payload: Payload
  /**
   * Call the exported `traverseFields` (what rich text editor hooks call) with the arguments
   * `afterChange` passes it, instead of `afterChange`; `siblingFields` also passes the fields as
   * `siblingFields` (only an external caller can).
   */
  traverse?: 'fields' | 'siblingFields'
  variant: RequestVariant
}): Promise<RunOutcome> => {
  const afterChange = engine === 'ts' ? afterChangeTS : afterChangeRS
  const traverseFields = engine === 'ts' ? afterChangeTraverseFieldsTS : afterChangeTraverseFieldsRS
  const engineRun = startEngineRun(engine, 'afterChange')
  const req = await makeRequest(payload, variant)
  const cases = makeCases()
  recorder.current = { events: [], ids: new WeakMap(), nextID: 0, req, thrown: [] }
  const outcome = await runCases({
    cases,
    concurrent,
    invoke: (c) =>
      traverse
        ? traverseFields({
            blockData: undefined,
            collection: collection ?? null,
            context: req.context,
            data: c.data,
            doc: c.doc,
            fields: (collection ?? global)!.fields,
            global: global ?? null,
            operation,
            parentIndexPath: '',
            parentIsLocalized: false,
            parentPath: '',
            parentSchemaPath: '',
            previousDoc: c.previousDoc,
            previousSiblingDoc: c.previousDoc,
            req,
            siblingData: c.data,
            siblingDoc: c.doc,
            siblingFields:
              traverse === 'siblingFields' ? (collection ?? global)!.fields : undefined,
          })
        : afterChange({
            collection: collection ?? null,
            context: req.context,
            data: c.data,
            doc: c.doc,
            global: global ?? null,
            operation,
            previousDoc: c.previousDoc,
            req,
          }),
    req,
    resultOf: (c) => c.doc,
    snapshot: () => snap(cases),
  })
  engineRun.finish(cases.length)
  return outcome
}

/** Runs beforeDuplicate for each doc (fresh copies) with one engine. */
export const runBeforeDuplicate = async ({
  collection,
  concurrent,
  docs: makeDocs,
  engine,
  overrideAccess,
  payload,
  variant,
}: {
  collection: null | SanitizedCollectionConfig
  concurrent: boolean
  docs: () => Record<string, unknown>[]
  engine: Engine
  overrideAccess: boolean
  payload: Payload
  variant: RequestVariant
}): Promise<RunOutcome> => {
  const beforeDuplicate = engine === 'ts' ? beforeDuplicateTS : beforeDuplicateRS
  const engineRun = startEngineRun(engine, 'beforeDuplicate')
  const req = await makeRequest(payload, variant)
  const docs = makeDocs()
  recorder.current = { events: [], ids: new WeakMap(), nextID: 0, req, thrown: [] }
  const outcome = await runCases({
    cases: docs,
    concurrent,
    invoke: (doc) =>
      beforeDuplicate({
        id: doc.id as number | string,
        collection,
        context: req.context,
        doc,
        overrideAccess,
        req,
      }),
    req,
    resultOf: (doc) => doc,
    snapshot: () => snap(docs),
  })
  engineRun.finish(docs.length)
  return outcome
}
