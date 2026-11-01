/**
 * Differential harness for the Rust `beforeValidate` traversal: runs the upstream TS
 * `beforeValidate` and the Rust port on identical inputs and records, for each run,
 * - the resulting data, the original doc and `docForHooks` (the traversal mutates `siblingDoc`
 *   for groups/tabs and shares cloned values), with object-identity structure,
 * - every user callback invocation in call order (field beforeValidate hooks, field
 *   create/update/validate access, defaultValue functions, rich text editor beforeValidate hooks,
 *   `onFieldAccess`, `logger.warn` from stripNullRows) with an args snapshot taken at call time
 *   (key order, values, identity of data/siblingData/field/siblingFields/req/context, `this`),
 *   plus when each returned promise settles (microtask interleaving),
 * - the rejection (class, message, identity of the thrown value) and `req.context` afterwards.
 */
import type {
  Payload,
  PayloadRequest,
  SanitizedCollectionConfig,
  SanitizedGlobalConfig,
} from 'payload'

import {
  beforeValidate as beforeValidateRS,
  traverseFields as traverseFieldsRS,
} from '../../../packages/engine-rs/src/runtime/beforeValidate/index.js'
import { beforeValidate as beforeValidateTS } from '../../../packages/payload/src/fields/hooks/beforeValidate/index.js'
import { traverseFields as traverseFieldsTS } from '../../../packages/payload/src/fields/hooks/beforeValidate/traverseFields.js'
import { createPayloadRequest } from '../../../packages/payload/src/utilities/createPayloadRequest.js'

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
 * within the same snapshot becomes `$ref@n` (cycles, shared references). Holes are `$hole`.
 */
export const snap = (v: unknown, maxDepth = 64, seen = new Set<object>(), depth = 0): unknown => {
  switch (typeof v) {
    case 'bigint':
      return `$bigint:${v}`
    case 'function':
      return recorder.configLabels.get(v) ?? '$fn'
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

/** Args that are whole documents: compared by identity in call snapshots (content via the run). */
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

export const record = (event: Record<string, unknown>) => {
  recorder.current?.events.push(event)
}

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

export const describeError = (error: unknown) =>
  error instanceof Error
    ? { class: error.constructor.name, message: error.message }
    : snap(error, 4)

const accessOperations = ['create', 'update', 'validate'] as const

/**
 * Wraps every beforeValidate-relevant user callback in the sanitized config and labels config
 * objects (fields, field arrays, blocks, tabs, collections, globals) so snapshots refer to them by
 * path. Also records `payload.logger.warn` (stripNullRows).
 */
export const instrument = (payload: Payload): void => {
  const wrapFieldCallbacks = (field: any, fieldPath: string) => {
    if (Array.isArray(field.hooks?.beforeValidate)) {
      field.hooks.beforeValidate = field.hooks.beforeValidate.map((hook: Function, i: number) =>
        wrap(hook, 'hook', `${fieldPath}#${i}`),
      )
    }
    if (field.access && typeof field.access === 'object') {
      for (const operation of accessOperations) {
        if (typeof field.access[operation] === 'function') {
          field.access[operation] = wrap(field.access[operation], `access.${operation}`, fieldPath)
        }
      }
    }
    if (typeof field.defaultValue === 'function') {
      field.defaultValue = wrap(field.defaultValue, 'defaultValue', fieldPath)
    }
  }
  const visitFields = (fields: unknown, path: string) => {
    if (!Array.isArray(fields) || recorder.configLabels.has(fields)) {
      return
    }
    recorder.configLabels.set(fields, `$cfg:fields:${path}`)
    fields.forEach((field: any, index: number) => {
      const fieldPath = `${path}.${field.name ?? `_${index}`}`
      recorder.configLabels.set(field, `$cfg:field:${fieldPath}`)
      wrapFieldCallbacks(field, fieldPath)
      if (field.type === 'richText' && field.editor && typeof field.editor === 'object') {
        const editor = field.editor
        if (!recorder.configLabels.has(editor)) {
          recorder.configLabels.set(editor, `$cfg:editor:${fieldPath}`)
          if (Array.isArray(editor.hooks?.beforeValidate)) {
            editor.hooks.beforeValidate = editor.hooks.beforeValidate.map(
              (hook: Function, i: number) => wrap(hook, 'editorHook', `${fieldPath}#${i}`),
            )
          }
        }
      }
      if (field.fields) {
        visitFields(field.fields, fieldPath)
      }
      if (Array.isArray(field.tabs)) {
        recorder.configLabels.set(field.tabs, `$cfg:tabs:${fieldPath}`)
        field.tabs.forEach((tab: any, i: number) => {
          const tabPath = `${fieldPath}.${tab.name ?? `_${i}`}`
          recorder.configLabels.set(tab, `$cfg:tab:${tabPath}`)
          // Tabs are traversed as `{ ...tab, type: 'tab' }` copies, which carry these wrappers.
          wrapFieldCallbacks(tab, tabPath)
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
  const logger = payload.logger as any
  if (!wrapped.has(logger.warn)) {
    const warn = function (this: unknown, ...args: unknown[]) {
      if (recorder.current) {
        record({ kind: 'logger.warn', args: args.map((a) => snap(a, 4)) })
        return
      }
      // outside a differential run: keep the logger's behaviour
      return originalWarn.apply(this, args)
    }
    const originalWarn = logger.warn
    wrapped.add(warn)
    logger.warn = warn
  }
}

export type Variant = {
  /** `req.context` entries set before the run. */
  context?: Record<string, unknown>
  /** Pass the doc as `docForHooks` too, with these overrides (the publication policy doc). */
  docForHooks?: Record<string, unknown>
  /** `doc` to pass: the original raw doc, an empty object (create), or `undefined`. */
  docMode: 'doc' | 'empty' | 'undefined'
  locale?: string
  name: string
  /** Record `onFieldAccess` calls. */
  onFieldAccess?: boolean
  operation: 'create' | 'update' | 'validate'
  overrideAccess: boolean
  /** Call the exported `traverseFields` (as lexical does) instead of `beforeValidate`. */
  viaTraverseFields?: boolean
  /** Pass `id` (the doc id). */
  withID?: boolean
}

export type RunOutcome = {
  contextAfter: unknown
  data: unknown
  doc: unknown
  docForHooks: unknown
  error?: unknown
  errorIsThrownByCallback?: boolean
  events: unknown[]
  identity: boolean[]
}

export type RunInput = {
  data: Record<string, unknown>
  doc: Record<string, unknown>
}

/**
 * Runs beforeValidate for each input (fresh copies) with one engine. With `concurrent`, all inputs
 * run in one `Promise.all`, so cross-document interleaving is compared too.
 */
export const runBeforeValidate = async ({
  collection,
  concurrent,
  engine,
  global,
  inputs,
  payload,
  variant,
}: {
  collection?: SanitizedCollectionConfig
  concurrent: boolean
  engine: Engine
  global?: SanitizedGlobalConfig
  /** Fresh inputs per call (not cloned: keeps frozen objects, shared references, getters). */
  inputs: () => RunInput[]
  payload: Payload
  variant: Variant
}): Promise<RunOutcome> => {
  const beforeValidate = engine === 'ts' ? beforeValidateTS : beforeValidateRS
  const req = await createPayloadRequest({
    context: { rsDifferential: true, ...variant.context },
    locale: variant.locale,
    payload,
    user: null,
  } as any)
  const runInputs = inputs()
  const docs = runInputs.map((input) =>
    variant.docMode === 'doc' ? input.doc : variant.docMode === 'empty' ? {} : undefined,
  )
  const policyDocs = runInputs.map((input) =>
    variant.docForHooks ? { ...input.doc, ...variant.docForHooks } : undefined,
  )
  recorder.current = { events: [], ids: new WeakMap(), nextID: 0, req, thrown: [] }
  // deterministic Math.random per run (random defaultValue functions), same sequence per engine
  const originalRandom = Math.random
  let seed = 1
  Math.random = () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
  const onFieldAccess = variant.onFieldAccess
    ? function (this: unknown, args: unknown) {
        record({ kind: 'onFieldAccess', args: snap(args, 3), this: snap(this, 1) })
      }
    : undefined
  const traverseFields = engine === 'ts' ? traverseFieldsTS : traverseFieldsRS
  const run = (input: RunInput, i: number) =>
    variant.viaTraverseFields
      ? (traverseFields as (args: Record<string, unknown>) => Promise<unknown>)({
          id: variant.withID ? input.doc.id : undefined,
          blockData: undefined,
          collection: collection ?? null,
          context: req.context,
          data: input.data,
          doc: docs[i],
          docForHooks: policyDocs[i],
          fields: (collection ?? global)!.fields,
          global: global ?? null,
          onFieldAccess,
          operation: variant.operation,
          overrideAccess: variant.overrideAccess,
          parentIndexPath: '',
          parentIsLocalized: false,
          parentPath: '',
          parentSchemaPath: '',
          req,
          siblingData: input.data,
          siblingDoc: docs[i],
        })
      : beforeValidate({
          id: variant.withID ? (input.doc.id as number | string) : undefined,
          collection: collection ?? null,
          context: req.context,
          data: input.data,
          doc: docs[i] as any,
          docForHooks: policyDocs[i] as any,
          global: global ?? null,
          onFieldAccess,
          operation: variant.operation,
          overrideAccess: variant.overrideAccess,
          req,
        })
  const outcome: RunOutcome = {
    contextAfter: undefined,
    data: undefined,
    doc: undefined,
    docForHooks: undefined,
    events: [],
    identity: [],
  }
  try {
    let results: unknown[]
    if (concurrent) {
      results = await Promise.all(runInputs.map(run))
    } else {
      results = []
      for (const [i, input] of runInputs.entries()) {
        results.push(await run(input, i))
      }
    }
    outcome.identity = results.map((result, i) => result === runInputs[i]!.data)
  } catch (error) {
    outcome.error = describeError(error)
    outcome.errorIsThrownByCallback = recorder.current.thrown.includes(error)
  }
  // let stray settle events land before snapshotting
  await new Promise((resolve) => setTimeout(resolve, 0))
  Math.random = originalRandom
  // one snapshot pass so sharing between data, doc and docForHooks shows up as `$ref`
  const all = snap({
    data: runInputs.map((input) => input.data),
    doc: docs,
    docForHooks: policyDocs,
  }) as Record<string, unknown>
  outcome.data = all.data
  outcome.doc = all.doc
  outcome.docForHooks = all.docForHooks
  outcome.contextAfter = Object.entries(req.context).map(([key, value]) => [key, snap(value, 8)])
  outcome.events = recorder.current.events
  recorder.current = undefined
  return outcome
}
