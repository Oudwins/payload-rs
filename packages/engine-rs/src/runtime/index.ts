/**
 * TS side of the Rust core runtime (crates/payload-core-runtime): loads the binding, installs
 * the JS host helpers it calls back into, and exposes Rust-backed drop-ins for ported engine
 * functions. See RUST_CORE_DESIGN.md.
 *
 * Payload internals are imported by relative path: engine-rs has no installed `payload` link, and
 * the population helpers are not exported. These are the same module instances payload uses.
 */
import { createRequire } from 'node:module'

import type { AfterReadArgs } from '../../../payload/src/fields/hooks/afterRead/index.js'
import type { JsonObject } from '../../../payload/src/types/index.js'

import { MissingEditorProp } from '../../../payload/src/errors/MissingEditorProp.js'
import { relationshipPopulationPromise } from '../../../payload/src/fields/hooks/afterRead/relationshipPopulationPromise.js'
import { virtualFieldPopulationPromise } from '../../../payload/src/fields/hooks/afterRead/virtualFieldPopulationPromise.js'
import { deepCopyObjectSimple } from '../../../payload/src/utilities/deepCopyObject.js'
import { getBlockSelect } from '../../../payload/src/utilities/getBlockSelect.js'
import { getSelectMode } from '../../../payload/src/utilities/getSelectMode.js'

export type CoreRuntimeBinding = {
  afterRead: (args: unknown) => Promise<unknown>
  benchCallJs: (fn: () => unknown, n: number) => number
  benchGetProperty: (obj: object, key: string, n: number) => number
  benchJsonRoundTrip: (json: string) => string
  benchPersist: (obj: object, n: number) => number
  benchProxyGet: (key: string) => unknown
  benchProxyLoad: (json: string) => void
  benchSequentialAwaits: (value: unknown, n: number) => Promise<number>
  benchSetProperty: (obj: object, key: string, n: number) => number
  benchSpawnSyncTasks: (n: number) => number
  benchTsfn: (fn: (done: (() => void) | null, elapsedNs?: number) => void, n: number) => void
  init: (host: Record<string, unknown>) => void
  noop: () => void
  probe: (value: unknown, frozen: object) => Record<string, unknown>
  resume: (token: number, ok: boolean, value: unknown) => void
  stats: () => { awaits: number; tasks: number }
}

let binding: CoreRuntimeBinding | undefined

/** The `pathSegments`, `schemaPathSegments` and `indexPathSegments` of `promise.ts`. */
const pathSegments = (path: string, schemaPath: string, indexPath: string): unknown[][] => [
  path ? path.split('.') : [],
  schemaPath ? schemaPath.split('.') : [],
  indexPath ? indexPath.split('-').filter(Boolean)?.map(Number) : [],
]

const reflectApply = Reflect.apply
// `await` uses the intrinsic PromiseResolve and PerformPromiseThen; capture them before user
// code can patch the globals.
const promiseResolve = Promise.resolve.bind(Promise) as (value: unknown) => Promise<unknown>
// eslint-disable-next-line @typescript-eslint/unbound-method -- called through `reflectApply`
const promiseThen = Promise.prototype.then

// Indices of the `afterReadArgs` array (crates/payload-core-runtime after_read.rs `arg`).
const ARG_COLLECTION = 0
const ARG_CONTEXT = 1
const ARG_CURRENT_DEPTH = 2
const ARG_DEPTH = 3
const ARG_DOC = 4
const ARG_DRAFT = 5
const ARG_FALLBACK_LOCALE = 6
const ARG_FIND_MANY = 7
const ARG_FLATTEN_LOCALES = 8
const ARG_GLOBAL = 9
const ARG_LOCALE = 10
const ARG_OVERRIDE_ACCESS = 11
const ARG_POPULATE = 12
const ARG_REQ = 13
const ARG_SHOW_HIDDEN_FIELDS = 15
const ARG_FIELD_PROMISES = 16
const ARG_POPULATION_PROMISES = 17

/** `promise()` of a field that completed without awaiting: a fresh fulfilled promise. */
const fulfilled = async (): Promise<void> => {}
/** `promise()` of a field that threw before its first await: a fresh rejected promise. */
// eslint-disable-next-line @typescript-eslint/require-await
const rejected = async (error: unknown): Promise<void> => {
  throw error
}

// Bits shared with crates/payload-core-runtime (config.rs `leaf_flags`, after_read.rs `leaf_run_bits`).
const AFFECTS_DATA = 1
const HIDDEN = 2
const NAME_IS_ID = 4
const NAME_TRUTHY = 8
const HAS_DEFAULT_VALUE = 16
const FLATTEN_LOCALES = 1
const SHOW_HIDDEN_FIELDS = 2
const FIELD_DEPTH_ZERO = 4
const ID_PATH = 8
const SELECT_INCLUDE = 16
const SELECT_EXCLUDE = 32

/**
 * `traverseFields` over a run of plain leaf fields (decided by the engine from the decoded
 * config: no hooks, no access to await, no virtual path, no localization and no
 * container/population behaviour). For each field this performs exactly the sibling doc
 * operations of `afterRead/promise.ts`, in order, and pushes the promise `promise()` returns.
 * Returns -1, or the index of the first field whose default value applies: its reads are done,
 * its promise is not pushed, and the engine continues that field with `getDefaultValue`.
 */
const leafRun = (
  siblingDoc: any,
  keys: PropertyKey[],
  flags: number[],
  start: number,
  end: number,
  bits: number,
  select: any,
  fieldPromises: Promise<void>[],
): number => {
  for (let i = start; i < end; i++) {
    const fieldFlags = flags[i]!
    let promise: Promise<void>
    if (fieldFlags & AFFECTS_DATA) {
      try {
        if (plainLeafField(siblingDoc, keys[i]!, fieldFlags, bits, select)) {
          return i
        }
        promise = fulfilled()
      } catch (error) {
        promise = rejected(error)
      }
    } else {
      promise = fulfilled()
    }
    fieldPromises.push(promise)
  }
  return -1
}

/**
 * The doc operations of `promise()` for one plain leaf data field. Returns whether the default
 * value applies (`typeof siblingDoc[field.name] === 'undefined'` with a `defaultValue`).
 */
const plainLeafField = (
  siblingDoc: any,
  key: PropertyKey,
  fieldFlags: number,
  bits: number,
  select: any,
): boolean => {
  const state = leafPrologue(siblingDoc, key, fieldFlags, bits, select)
  return (
    state !== LEAF_UNSELECTED && leafEpilogue(siblingDoc, key, fieldFlags, state === LEAF_REMOVED)
  )
}

const LEAF_CONTINUE = 0
const LEAF_REMOVED = 1
const LEAF_UNSELECTED = 2

/**
 * `promise()` of a plain leaf data field up to its hooks: the hidden check,
 * `stripUnselectedFields` and the `shouldHoistLocalizedValue` reads. Returns `LEAF_UNSELECTED`
 * when `promise()` returns there, else whether the hidden value was removed.
 */
const leafPrologue = (
  siblingDoc: any,
  key: PropertyKey,
  fieldFlags: number,
  bits: number,
  select: any,
): number => {
  let removedFieldValue = false
  const isIDField = (fieldFlags & NAME_IS_ID) !== 0
  if (
    fieldFlags & HIDDEN &&
    typeof siblingDoc[key] !== 'undefined' &&
    !(bits & SHOW_HIDDEN_FIELDS) &&
    !(isIDField && bits & FIELD_DEPTH_ZERO)
  ) {
    removedFieldValue = true
    delete siblingDoc[key]
  }
  // stripUnselectedFields (skipped for the `'id'` path)
  if (!(isIDField && bits & ID_PATH) && fieldFlags & NAME_TRUTHY) {
    if (bits & SELECT_INCLUDE && !select[key]) {
      delete siblingDoc[key]
      return LEAF_UNSELECTED
    }
    if (bits & SELECT_EXCLUDE && select[key] === false) {
      delete siblingDoc[key]
      return LEAF_UNSELECTED
    }
  }
  // shouldHoistLocalizedValue (the field is not localized here, so only the reads remain)
  if (bits & FLATTEN_LOCALES && typeof siblingDoc[key] === 'object') {
    void siblingDoc[key]
  }
  return removedFieldValue ? LEAF_REMOVED : LEAF_CONTINUE
}

/**
 * `!removedFieldValue && allowDefaultValue && typeof siblingDoc[field.name] === 'undefined' &&
 * typeof field.defaultValue !== 'undefined'` (access is never denied for a plain leaf).
 */
const leafEpilogue = (
  siblingDoc: any,
  key: PropertyKey,
  fieldFlags: number,
  removedFieldValue: boolean,
): boolean =>
  !removedFieldValue &&
  typeof siblingDoc[key] === 'undefined' &&
  (fieldFlags & HAS_DEFAULT_VALUE) !== 0

/**
 * The array field's `rows.forEach((row, rowIndex) => traverseFields({ siblingDoc: row || {},
 * ... }))` when every field of the rows is a plain leaf (iterating like `forEach`: `length` read
 * once, holes skipped). Returns -1, or `[rowIndex, fieldIndex, siblingDoc, length]` where a
 * default value applies (see `leafRun`); the engine then continues from `rowIndex + 1`.
 */
const leafRows = (
  rows: any[],
  startRow: number,
  length: number,
  keys: PropertyKey[],
  flags: number[],
  end: number,
  bits: number,
  select: any,
  fieldPromises: Promise<void>[],
): [number, number, unknown, number] | -1 => {
  const len = length < 0 ? rows.length : length
  for (let rowIndex = startRow; rowIndex < len; rowIndex++) {
    if (rowIndex in rows) {
      const siblingDoc = rows[rowIndex] || {}
      const stopped = leafRun(siblingDoc, keys, flags, 0, end, bits, select, fieldPromises)
      if (stopped >= 0) {
        return [rowIndex, stopped, siblingDoc, len]
      }
    }
  }
  return -1
}

/**
 * The binding comes from `PAYLOAD_CORE_RUNTIME_ADDON` (the standalone `dev_addon` build) or
 * from the main addon's `coreRuntimeBinding()` export (crates/payload-node/src/runtime.rs).
 */
export const getCoreRuntime = (): CoreRuntimeBinding => {
  if (binding) {
    return binding
  }
  const require = createRequire(import.meta.url)
  const addonPath =
    process.env.PAYLOAD_CORE_RUNTIME_ADDON ??
    process.env.PAYLOAD_ENGINE_ADDON ??
    '../../payload-engine.node'
  const addon = require(addonPath) as { coreRuntimeBinding: () => CoreRuntimeBinding }
  const created = addon.coreRuntimeBinding()
  const resume = created.resume
  // `await value`: PromiseResolve(%Promise%, value) + a reaction that resumes the Rust task.
  const awaitValue = (value: unknown, token: number) => {
    void reflectApply(promiseThen, promiseResolve(value), [
      (result: unknown) => resume(token, true, result),
      (error: unknown) => resume(token, false, error),
    ])
  }

  created.init({
    awaitValue,
    /**
     * The `afterRead` args destructuring (same pattern, order and `flattenLocales = true`
     * default), plus the two promise arrays. Indices are `after_read.rs` `arg::*`; the engine
     * overwrites `currentDepth`/`depth` with the derived values.
     */
    afterReadArgs: (args: any) => {
      const {
        collection,
        context,
        currentDepth,
        depth,
        doc,
        draft,
        fallbackLocale,
        findMany,
        flattenLocales = true,
        global,
        locale,
        overrideAccess,
        populate,
        req,
        select,
        showHiddenFields,
      } = args
      return [
        collection,
        context,
        currentDepth,
        depth,
        doc,
        draft,
        fallbackLocale,
        findMany,
        flattenLocales,
        global,
        locale,
        overrideAccess,
        populate,
        req,
        select,
        showHiddenFields,
        [],
        [],
      ]
    },
    /**
     * `await hook({ ...args })` of a field afterRead hook (`executor::await_call`): the args
     * object literal of `promise.ts` (same key order and shape), the call (`this` undefined)
     * and the await, in one host call. `c` is the `afterReadArgs` array.
     */
    callFieldHook: (
      token: number,
      hook: (args: unknown) => unknown,
      c: any[],
      blockData: unknown,
      field: unknown,
      segments: unknown[],
      siblingData: unknown,
      siblingFields: unknown,
      value: unknown,
    ) => {
      awaitValue(
        hook({
          blockData,
          collection: c[ARG_COLLECTION],
          context: c[ARG_CONTEXT],
          currentDepth: c[ARG_CURRENT_DEPTH],
          data: c[ARG_DOC],
          depth: c[ARG_DEPTH],
          draft: c[ARG_DRAFT],
          field,
          findMany: c[ARG_FIND_MANY],
          global: c[ARG_GLOBAL],
          indexPath: segments[2],
          operation: 'read',
          originalDoc: c[ARG_DOC],
          overrideAccess: c[ARG_OVERRIDE_ACCESS],
          path: segments[0],
          req: c[ARG_REQ],
          schemaPath: segments[1],
          showHiddenFields: c[ARG_SHOW_HIDDEN_FIELDS],
          siblingData,
          siblingFields,
          value,
        }),
        token,
      )
    },
    /** `await hook({ ...args })` of a rich text editor afterRead hook (`promise.ts`). */
    callEditorHook: (
      token: number,
      hook: (args: unknown) => unknown,
      c: any[],
      field: unknown,
      segments: unknown[],
      parentIsLocalized: unknown,
      siblingData: unknown,
      value: unknown,
    ) => {
      awaitValue(
        hook({
          collection: c[ARG_COLLECTION],
          context: c[ARG_CONTEXT],
          currentDepth: c[ARG_CURRENT_DEPTH],
          data: c[ARG_DOC],
          depth: c[ARG_DEPTH],
          draft: c[ARG_DRAFT],
          fallbackLocale: c[ARG_FALLBACK_LOCALE],
          field,
          fieldPromises: c[ARG_FIELD_PROMISES],
          findMany: c[ARG_FIND_MANY],
          flattenLocales: c[ARG_FLATTEN_LOCALES],
          global: c[ARG_GLOBAL],
          indexPath: segments[2],
          locale: c[ARG_LOCALE],
          operation: 'read',
          originalDoc: c[ARG_DOC],
          overrideAccess: c[ARG_OVERRIDE_ACCESS],
          parentIsLocalized,
          path: segments[0],
          populate: c[ARG_POPULATE],
          populationPromises: c[ARG_POPULATION_PROMISES],
          req: c[ARG_REQ],
          schemaPath: segments[1],
          showHiddenFields: c[ARG_SHOW_HIDDEN_FIELDS],
          siblingData,
          triggerAccessControl: true,
          triggerHooks: true,
          value,
        }),
        token,
      )
    },
    /** `await field.access.read({ id: doc.id, ... })` (called as a method of `field.access`). */
    callReadAccess: (
      token: number,
      access: unknown,
      read: (args: unknown) => unknown,
      c: any[],
      blockData: unknown,
      siblingData: unknown,
    ) => {
      const doc = c[ARG_DOC]
      awaitValue(
        reflectApply(read, access, [
          c[ARG_COLLECTION]
            ? {
                id: doc.id,
                blockData,
                collection: c[ARG_COLLECTION],
                data: doc,
                doc,
                req: c[ARG_REQ],
                siblingData,
              }
            : {
                id: doc.id,
                blockData,
                data: doc,
                doc,
                global: c[ARG_GLOBAL],
                req: c[ARG_REQ],
                siblingData,
              },
        ]),
        token,
      )
    },
    /** `populationPromises.push(relationshipPopulationPromise({ ... }))` */
    pushRelationshipPopulation: (c: any[], field: any, parentIsLocalized: any, siblingDoc: any) => {
      c[ARG_POPULATION_PROMISES].push(
        relationshipPopulationPromise({
          currentDepth: c[ARG_CURRENT_DEPTH],
          depth: c[ARG_DEPTH],
          draft: c[ARG_DRAFT],
          fallbackLocale: c[ARG_FALLBACK_LOCALE],
          field,
          locale: c[ARG_LOCALE],
          overrideAccess: c[ARG_OVERRIDE_ACCESS],
          parentIsLocalized,
          populate: c[ARG_POPULATE],
          req: c[ARG_REQ],
          showHiddenFields: c[ARG_SHOW_HIDDEN_FIELDS],
          siblingDoc,
        }),
      )
    },
    /** `populationPromises.push(virtualFieldPopulationPromise({ ... }))` */
    pushVirtualFieldPopulation: (
      c: any[],
      name: any,
      fields: any,
      segments: any,
      siblingDoc: any,
    ) => {
      c[ARG_POPULATION_PROMISES].push(
        virtualFieldPopulationPromise({
          name,
          draft: c[ARG_DRAFT],
          fallbackLocale: c[ARG_FALLBACK_LOCALE],
          fields,
          locale: c[ARG_LOCALE],
          overrideAccess: c[ARG_OVERRIDE_ACCESS],
          ref: c[ARG_DOC],
          req: c[ARG_REQ],
          segments,
          showHiddenFields: c[ARG_SHOW_HIDDEN_FIELDS],
          siblingDoc,
        }),
      )
    },
    /** `depth > req.payload.config.maxDepth` for non-number operands. */
    deepCopyObjectSimple,
    del: (target: any, key: PropertyKey) => {
      delete target[key]
    },
    descCache: new WeakMap(),
    forEachFields: (fields: any) => fields.forEach(() => {}),
    get: (target: any, key: PropertyKey) => target[key],
    greaterThan: (a: any, b: any) => a > b,
    pathSegments,
    // The args object literal of `promise.ts` (field afterRead hooks), same key order and shape.
    getBlockSelect,
    getSelectMode,
    /**
     * One iteration of a plain leaf's hooks loop: `const hookedValue = await hook({ ...args,
     * value: siblingDoc[field.name] }); if (hookedValue !== undefined) siblingDoc[field.name] =
     * hookedValue`. The assignment runs in the await's reaction job, right where the TS
     * continuation runs it, before the engine task resumes.
     */
    callLeafHook: (
      token: number,
      hook: (args: unknown) => unknown,
      c: any[],
      blockData: unknown,
      field: unknown,
      existingSegments: undefined | unknown[][],
      path: string,
      schemaPath: string,
      indexPath: string,
      siblingData: any,
      siblingFields: unknown,
      key: PropertyKey,
    ) => {
      const segments = existingSegments ?? pathSegments(path, schemaPath, indexPath)
      void reflectApply(
        promiseThen,
        promiseResolve(
          hook({
            blockData,
            collection: c[ARG_COLLECTION],
            context: c[ARG_CONTEXT],
            currentDepth: c[ARG_CURRENT_DEPTH],
            data: c[ARG_DOC],
            depth: c[ARG_DEPTH],
            draft: c[ARG_DRAFT],
            field,
            findMany: c[ARG_FIND_MANY],
            global: c[ARG_GLOBAL],
            indexPath: segments[2],
            operation: 'read',
            originalDoc: c[ARG_DOC],
            overrideAccess: c[ARG_OVERRIDE_ACCESS],
            path: segments[0],
            req: c[ARG_REQ],
            schemaPath: segments[1],
            showHiddenFields: c[ARG_SHOW_HIDDEN_FIELDS],
            siblingData,
            siblingFields,
            value: siblingData[key],
          }),
        ),
        [
          (hookedValue: unknown) => {
            try {
              if (hookedValue !== undefined) {
                siblingData[key] = hookedValue
              }
            } catch (error) {
              resume(token, false, error)
              return
            }
            resume(token, true, undefined)
          },
          (error: unknown) => resume(token, false, error),
        ],
      )
      return segments
    },
    leafEpilogue,
    leafPrologue,
    leafRows,
    leafRun,
    /** `fieldPromises.push(promise())` for a field whose `promise()` completed synchronously. */
    hookArgs: (
      blockData: unknown,
      collection: unknown,
      context: unknown,
      currentDepth: unknown,
      doc: unknown,
      depth: unknown,
      draft: unknown,
      field: unknown,
      findMany: unknown,
      global: unknown,
      indexPath: unknown,
      path: unknown,
      overrideAccess: unknown,
      req: unknown,
      schemaPath: unknown,
      showHiddenFields: unknown,
      siblingData: unknown,
      siblingFields: unknown,
      value: unknown,
    ) => ({
      blockData,
      collection,
      context,
      currentDepth,
      data: doc,
      depth,
      draft,
      field,
      findMany,
      global,
      indexPath,
      operation: 'read',
      originalDoc: doc,
      overrideAccess,
      path,
      req,
      schemaPath,
      showHiddenFields,
      siblingData,
      siblingFields,
      value,
    }),
    missingEditorProp: (field: any) => new MissingEditorProp(field),
    newError: (message: string) => new Error(message),
    objectEntries: Object.entries,
    objectValues: Object.values,
    parseDepth: (depth: unknown) => parseInt(String(depth), 10),
    promiseAll: (promises: Promise<unknown>[]) => Promise.all(promises),
    pushSettled: (fieldPromises: Promise<void>[], ok: boolean, error: unknown) => {
      fieldPromises.push(ok ? fulfilled() : rejected(error))
    },
    relationshipPopulationPromise,
    set: (target: any, key: PropertyKey, value: unknown) => {
      target[key] = value
    },
    spreadWithID: (select: any) => ({ ...select, id: true }),
    tabsAsFields: (tabs: any[]) => tabs.map((tab) => ({ ...tab, type: 'tab' })),
    virtualFieldPopulationPromise,
  })
  binding = created
  return created
}

/** Drop-in for `afterRead` from `payload/src/fields/hooks/afterRead/index.ts`. */
export const afterRead = <T extends JsonObject>(args: AfterReadArgs<T>): Promise<T> =>
  getCoreRuntime().afterRead(args) as Promise<T>
