/**
 * Differential harness for the Rust `beforeChange` port: runs the upstream TS `beforeChange` and
 * the Rust port on identical inputs and records, for each run,
 * - the returned data, the inputs afterwards (`data`, `doc` and `docWithLocales` are mutated by
 *   upstream, e.g. groups and tabs), and whether the result is a copy,
 * - every user callback invocation (field beforeChange hooks, validate functions, admin
 *   conditions, rich text editor beforeChange hooks, filterOptions, label functions,
 *   onDataProcessed) in call order with an args snapshot taken at call time (key order, values,
 *   identities, `this`), plus when each returned promise settles (microtask interleaving),
 * - the rejection (class, message, ValidationError data, identity of the thrown value),
 * - `req.context` afterwards.
 */
import type {
  Payload,
  PayloadRequest,
  SanitizedCollectionConfig,
  SanitizedGlobalConfig,
} from 'payload'

import { types } from 'node:util'

import {
  beforeChange as beforeChangeRS,
  traverseFields as beforeChangeTraverseFieldsRS,
} from '../../../packages/engine-rs/src/runtime/beforeChange/index.js'
import { defaultFieldValidators } from '../../../packages/payload/src/fields/config/defaultFieldValidators.js'
import { upstreamBeforeChange as beforeChangeTS } from '../../../packages/payload/src/fields/hooks/beforeChange/index.js'
import { traverseFields as beforeChangeTraverseFieldsTS } from '../../../packages/payload/src/fields/hooks/beforeChange/traverseFields.js'
import { createPayloadRequest } from '../../../packages/payload/src/utilities/createPayloadRequest.js'
import { assertDistinctEngines, startEngineRun } from '../dispatch/engineGuard.js'
import { settleRun, trackDatabaseIO } from '../dispatch/settle.js'

assertDistinctEngines('beforeChange', beforeChangeTS, beforeChangeRS)
assertDistinctEngines(
  'beforeChange traverseFields',
  beforeChangeTraverseFieldsTS,
  beforeChangeTraverseFieldsRS,
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

const wrapped = new WeakSet<Function>()

/** Label for values that must keep identity across engines but are not data. */
const label = (v: object): string | undefined => {
  const r = recorder.current
  if (r?.req) {
    if (v === r.req) {
      return '$req'
    }
    if (v === r.req.context) {
      return '$context'
    }
    if (v === r.req.payload) {
      return '$payload'
    }
    if (v === r.req.i18n) {
      return '$i18n'
    }
    if (v === r.req.user) {
      return '$user'
    }
    // `isolateObjectProperty(req, 'locale')` proxies created for per-locale validation
    if (types.isProxy(v) && (v as PayloadRequest).payload === r.req.payload) {
      return `$reqProxy:${String((v as PayloadRequest).locale)}`
    }
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
      return recorder.configLabels.get(v) ?? `$fn:${v.name}`
    case 'number':
      return Number.isFinite(v) ? (Object.is(v, -0) ? '$num:-0' : v) : `$num:${v}`
    case 'object': {
      if (v === null) {
        return null
      }
      const l = label(v)
      if (l) {
        return l
      }
      if (v instanceof Date) {
        return `$date:${Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()}`
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
        const items: unknown[] = []
        for (let i = 0; i < v.length; i++) {
          items.push(i in v ? snap(v[i], maxDepth, seen, depth + 1) : '$hole')
        }
        return { '@': id, $array: items }
      }
      const out: Record<string, unknown> = { '@': id }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        out.$class = proto?.constructor?.name
      }
      if (proto === null) {
        out.$proto = null
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

const identityOnlyArgs = new Set(['data', 'doc', 'docWithLocales', 'originalDoc'])

/** Snapshot of a callback's argument: args objects keep key order; whole docs by identity. */
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

/** Wraps a user callback so each call (and the settling of its result) is recorded. */
export const wrap = (fn: Function, kind: string, id: string): Function => {
  if (wrapped.has(fn)) {
    return fn
  }
  const wrapper = function (this: unknown, ...args: unknown[]) {
    if (!recorder.current) {
      return fn.apply(this, args)
    }
    const seq = recorder.current.events.length
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
      ;(result as Promise<unknown>).then(
        (value) => record({ id, kind, seq, settled: snap(value, 6) }),
        (error) => {
          recorder.current?.thrown.push(error)
          record({ id, kind, seq, rejected: describeError(error) })
        },
      )
    } else {
      record({ id, kind, seq, returned: snap(result, 6) })
    }
    return result
  }
  wrapped.add(wrapper)
  recorder.configLabels.set(wrapper, `$cfg:${kind}:${id}`)
  return wrapper
}

const describeError = (error: unknown) =>
  error instanceof Error
    ? {
        class: error.constructor.name,
        data: snap((error as { data?: unknown }).data, 8),
        message: error.message,
      }
    : snap(error, 4)

/**
 * Wraps every beforeChange-relevant user callback in the sanitized config and labels config
 * objects (fields, field arrays, blocks, collections, globals, editors) so snapshots refer to them
 * by path. `keepDefaultValidators`: leave the validators field sanitization installed unwrapped
 * (they are not user code), so the Rust port's validation merge elision applies.
 */
export const instrument = (
  payload: Payload,
  { keepDefaultValidators = false }: { keepDefaultValidators?: boolean } = {},
): void => {
  const wrapField = (field: any, fieldPath: string) => {
    if (Array.isArray(field.hooks?.beforeChange)) {
      field.hooks.beforeChange = field.hooks.beforeChange.map((hook: Function, i: number) =>
        wrap(hook, 'hook', `${fieldPath}#${i}`),
      )
    }
    if (
      typeof field.validate === 'function' &&
      !(keepDefaultValidators && defaultFieldValidators.has(field.validate))
    ) {
      field.validate = wrap(field.validate, 'validate', fieldPath)
    }
    if (typeof field.admin?.condition === 'function') {
      field.admin.condition = wrap(field.admin.condition, 'condition', fieldPath)
    }
    if (typeof field.filterOptions === 'function') {
      field.filterOptions = wrap(field.filterOptions, 'filterOptions', fieldPath)
    }
    if (typeof field.label === 'function') {
      field.label = wrap(field.label, 'label', fieldPath)
    }
  }
  const visitBlock = (block: any, blockPath: string) => {
    if (!block || typeof block !== 'object' || recorder.configLabels.has(block)) {
      return
    }
    recorder.configLabels.set(block, `$cfg:block:${block.slug}`)
    if (typeof block.labels?.singular === 'function') {
      block.labels.singular = wrap(block.labels.singular, 'label', `${blockPath}.labels.singular`)
    }
    visitFields(block.fields, blockPath)
  }
  const visitFields = (fields: unknown, path: string) => {
    if (!Array.isArray(fields) || recorder.configLabels.has(fields)) {
      return
    }
    recorder.configLabels.set(fields, `$cfg:fields:${path}`)
    fields.forEach((field: any, index: number) => {
      const fieldPath = `${path}.${field.name ?? `_${index}`}`
      recorder.configLabels.set(field, `$cfg:field:${fieldPath}`)
      wrapField(field, fieldPath)
      if (field.type === 'richText' && field.editor && typeof field.editor === 'object') {
        const editor = field.editor
        if (!recorder.configLabels.has(editor)) {
          recorder.configLabels.set(editor, `$cfg:editor:${fieldPath}`)
          if (Array.isArray(editor.hooks?.beforeChange)) {
            editor.hooks.beforeChange = editor.hooks.beforeChange.map((hook: Function, i: number) =>
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
          const tabPath = `${fieldPath}.${tab.name ?? `_${i}`}`
          recorder.configLabels.set(tab, `$cfg:tab:${tabPath}`)
          // Tabs are traversed as `{ ...tab, type: 'tab' }`: wrap on the tab object so the
          // copies carry the wrappers.
          wrapField(tab, tabPath)
          visitFields(tab.fields, tabPath)
        })
      }
      if (Array.isArray(field.blocks)) {
        field.blocks.forEach((block: any) => visitBlock(block, `${fieldPath}.${block?.slug}`))
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
    visitBlock(block, `blocks.${block.slug}`)
  }
}

export type Variant = {
  fieldsToValidate?: string[]
  isValidationOperation?: boolean
  locale?: string
  name: string
  /** Pass a recorded `onDataProcessed` callback. */
  onDataProcessed?: boolean
  operation: 'create' | 'update' | 'validate'
  overrideAccess?: boolean
  skipHooks?: boolean
  skipValidation?: boolean
  /** Give the request a user. */
  user?: boolean
}

export type BeforeChangeInput = {
  data: Record<string, unknown>
  doc: Record<string, unknown>
  docWithLocales: Record<string, unknown>
  id?: number | string
}

export type RunOutcome = {
  contextAfter: unknown
  error?: unknown
  errorIsThrownByCallback?: boolean
  events: unknown[]
  /** Inputs after the run (upstream mutates `doc`/`docWithLocales` for groups and tabs). */
  inputsAfter: unknown
  resultIsCopy: boolean[]
  results: unknown
  /**
   * Rejections nobody handles. Upstream leaves sibling promises unawaited when a sync throw
   * interrupts `rows.forEach`, so both engines must produce the same ones.
   */
  unhandled: unknown[]
}

/**
 * Runs beforeChange for every input with one engine. With `concurrent`, all inputs run in one
 * `Promise.all` so cross-document interleaving is compared too.
 */
export const runBeforeChange = async ({
  collection,
  concurrent,
  engine,
  global,
  inputs,
  payload,
  traverse,
  variant,
}: {
  collection?: SanitizedCollectionConfig
  concurrent: boolean
  engine: Engine
  global?: SanitizedGlobalConfig
  /** Fresh inputs for this run (not cloned: keeps frozen objects, shared references). */
  inputs: BeforeChangeInput[]
  payload: Payload
  /**
   * Call the exported `traverseFields` (what rich text editor hooks call) with the arguments
   * `beforeChange` passes it (on `data` itself, fresh `errors`/`mergeLocaleActions` arrays kept on
   * the input so they are compared), instead of `beforeChange`. `'nested'`: with the arguments of
   * a nested call (lexical's sub-field traversals): parent paths, `blockData`, a field label path,
   * `parentIsLocalized: true`.
   */
  traverse?: 'nested' | boolean
  variant: Variant
}): Promise<RunOutcome> => {
  const beforeChange = engine === 'ts' ? beforeChangeTS : beforeChangeRS
  const traverseFields =
    engine === 'ts' ? beforeChangeTraverseFieldsTS : beforeChangeTraverseFieldsRS
  const engineRun = startEngineRun(engine, 'beforeChange')
  trackDatabaseIO(payload)
  const req = await createPayloadRequest({
    context: { rsDifferential: true },
    locale: variant.locale,
    payload,
    user: variant.user
      ? ({ id: 1, collection: payload.config.admin.user, email: 'dev@payloadcms.com' } as any)
      : null,
  } as any)
  recorder.current = { events: [], ids: new WeakMap(), nextID: 0, req, thrown: [] }
  const onDataProcessed = variant.onDataProcessed
    ? wrap(() => undefined, 'onDataProcessed', 'onDataProcessed')
    : undefined
  const runTraverseFields = (input: BeforeChangeInput & Record<string, unknown>) => {
    const errors: unknown[] = []
    const mergeLocaleActions: unknown[] = []
    input.traverseErrors = errors
    input.traverseMergeLocaleActions = mergeLocaleActions
    const nested = traverse === 'nested'
    return traverseFields({
      id: input.id,
      blockData: nested ? { id: 'block-data', blockType: 'nestedBlock' } : undefined,
      collection: collection ?? null,
      context: req.context,
      data: input.data,
      doc: input.doc,
      docWithLocales: input.docWithLocales,
      errors,
      fieldLabelPath: nested ? 'Outer 1' : '',
      fields: (collection ?? global)!.fields,
      global: global ?? null,
      isValidationOperation: variant.isValidationOperation,
      mergeLocaleActions,
      operation: variant.operation,
      overrideAccess: variant.overrideAccess,
      parentIndexPath: nested ? '1-2' : '',
      parentIsLocalized: nested,
      parentPath: nested ? 'outer.0' : '',
      parentSchemaPath: nested ? 'outer' : '',
      req,
      siblingData: input.data,
      siblingDoc: input.doc,
      siblingDocWithLocales: input.docWithLocales,
      skipHooks: variant.skipHooks,
      skipValidation: variant.skipValidation,
      submittedTopLevelFieldNames: variant.fieldsToValidate
        ? new Set(variant.fieldsToValidate)
        : undefined,
    } as any).then(async () => {
      // what beforeChange does with them afterwards (same harness code for both engines)
      for (const action of mergeLocaleActions as (() => unknown)[]) {
        await action()
      }
    })
  }
  const run = (input: BeforeChangeInput) =>
    traverse
      ? runTraverseFields(input)
      : beforeChange({
          id: input.id,
          collection: collection ?? null,
          context: req.context,
          data: input.data,
          doc: input.doc,
          docWithLocales: input.docWithLocales,
          fieldsToValidate: variant.fieldsToValidate
            ? new Set(variant.fieldsToValidate)
            : undefined,
          global: global ?? null,
          isValidationOperation: variant.isValidationOperation,
          onDataProcessed: onDataProcessed as any,
          operation: variant.operation,
          overrideAccess: variant.overrideAccess,
          req,
          skipHooks: variant.skipHooks,
          skipValidation: variant.skipValidation,
        } as any)
  const outcome: RunOutcome = {
    contextAfter: undefined,
    events: [],
    inputsAfter: undefined,
    resultIsCopy: [],
    results: undefined,
    unhandled: [],
  }
  // Capture unhandled rejections of this run instead of letting the test runner fail on them.
  const previousListeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  const onUnhandled = (reason: unknown) => {
    outcome.unhandled.push(describeError(reason))
  }
  process.on('unhandledRejection', onUnhandled)
  let results: unknown[] = []
  try {
    if (concurrent) {
      results = await Promise.all(inputs.map((input, i) => recordSettle(i, run(input))))
    } else {
      for (const [i, input] of inputs.entries()) {
        results.push(await recordSettle(i, run(input)))
      }
    }
    outcome.resultIsCopy = results.map((result, i) => result !== inputs[i]!.data)
  } catch (error) {
    outcome.error = describeError(error)
    outcome.errorIsThrownByCallback = recorder.current.thrown.includes(error)
  }
  // let stray settle events and unhandled rejections land before snapshotting
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
  await settleRun({ activity: () => recorder.current?.events.length ?? 0, payload })
  process.off('unhandledRejection', onUnhandled)
  for (const listener of previousListeners) {
    process.on('unhandledRejection', listener)
  }
  outcome.results = results.map((result) => snap(result))
  outcome.inputsAfter = inputs.map((input) => snap(input))
  outcome.contextAfter = Object.entries(req.context).map(([key, value]) => [key, snap(value, 8)])
  outcome.events = recorder.current.events
  recorder.current = undefined
  engineRun.finish(inputs.length)
  return outcome
}
