/**
 * TS side of the Rust core runtime (crates/payload-core-runtime): loads the binding, installs
 * the JS host helpers it calls back into, and exposes Rust-backed drop-ins for ported engine
 * functions. See RUST_CORE_DESIGN.md.
 *
 * Payload internals are imported by relative path: engine-rs has no installed `payload` link, and
 * the population helpers are not exported. These are the same module instances payload uses.
 */

import type { AfterReadArgs } from '../../../payload/src/fields/hooks/afterRead/index.js'
import type { JsonObject } from '../../../payload/src/types/index.js'

import { MissingEditorProp } from '../../../payload/src/errors/MissingEditorProp.js'
import { promise as upstreamPromise } from '../../../payload/src/fields/hooks/afterRead/promise.js'
import { relationshipPopulationPromise } from '../../../payload/src/fields/hooks/afterRead/relationshipPopulationPromise.js'
import { traverseFields as upstreamTraverseFields } from '../../../payload/src/fields/hooks/afterRead/traverseFields.js'
import { virtualFieldPopulationPromise } from '../../../payload/src/fields/hooks/afterRead/virtualFieldPopulationPromise.js'
import { deepCopyObjectSimple } from '../../../payload/src/utilities/deepCopyObject.js'
import { getBlockSelect } from '../../../payload/src/utilities/getBlockSelect.js'
import { getSelectMode } from '../../../payload/src/utilities/getSelectMode.js'
import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../addon.js'

export type CoreRuntimeBinding = {
  afterRead: (args: unknown) => Promise<unknown>
  /**
   * afterRead's `traverseFields` with its parameter already destructured: the `afterReadArgs`
   * layout followed by the `TRAV_*` entries (after_read.rs `traverse_fields_entry`).
   */
  afterReadTraverseFields: (destructured: unknown[]) => void
  /**
   * Host-helper contract version of the core runtime and the field hook crates in the same addon
   * (crates/payload-core-runtime/src/binding.rs `API_VERSION`), checked at load.
   */
  apiVersion?: number
  /**
   * `await value` resuming the Rust task `token` (a compiled async function: V8's own Await).
   * Every JS-side `await f(...)` host helper must use it.
   */
  awaitValue: (value: unknown, token: number) => void
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
  /** Executor tasks/awaits and calls of exported core engine functions (excluding `stats`). */
  stats: () => { awaits: number; entries: number; tasks: number }
  /** `async (promise, value) => { await promise; return value }` (executor::spawn_tail). */
  thenReturn: (promise: unknown, value: unknown) => Promise<unknown>
}

let binding: CoreRuntimeBinding | undefined

/** The contract this glue implements (crates/payload-core-runtime/src/binding.rs `API_VERSION`). */
const CORE_RUNTIME_API_VERSION = 2

/** The `pathSegments`, `schemaPathSegments` and `indexPathSegments` of `promise.ts`. */
const pathSegments = (path: string, schemaPath: string, indexPath: string): unknown[][] => [
  path ? path.split('.') : [],
  schemaPath ? schemaPath.split('.') : [],
  indexPath ? indexPath.split('-').filter(Boolean)?.map(Number) : [],
]

const reflectApply = Reflect.apply
const legacyPromiseResolve = Promise.resolve.bind(Promise) as (value: unknown) => Promise<unknown>
// eslint-disable-next-line @typescript-eslint/unbound-method -- called through `reflectApply`
const legacyPromiseThen = Promise.prototype.then

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
const HOOKED = 32
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
  // Only for runs with hooked leaves: the `afterReadArgs` array, the traversal's `blockData`,
  // `fields` (= `siblingFields`), parent paths, `fieldDepth`, `parentIsLocalized`, `selectMode`.
  c?: any[],
  blockData?: unknown,
  fields?: any[],
  parentIndexPath?: string,
  parentPath?: string,
  parentSchemaPath?: string,
  fieldDepth?: number,
  parentIsLocalized?: unknown,
  selectMode?: unknown,
): number => {
  for (let i = start; i < end; i++) {
    const fieldFlags = flags[i]!
    let promise: Promise<void>
    if (fieldFlags & HOOKED) {
      promise = hookedLeaf(
        c!,
        blockData,
        fields!,
        i,
        fieldDepth!,
        parentIndexPath!,
        parentIsLocalized,
        parentPath!,
        parentSchemaPath!,
        select,
        selectMode,
        siblingDoc,
      )
    } else if (fieldFlags & AFFECTS_DATA) {
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
 * `promise()` of a plain leaf data field with `afterRead` hooks (crates/payload-core-runtime
 * config.rs `hooked_leaf`, flag `HOOKED`): upstream's own `promise` of `afterRead/promise.ts`,
 * called with the args literal upstream's `traverseFields` builds (same keys, same order;
 * `triggerAccessControl`/`triggerHooks` are `true`, the only values the port runs with). `leafRun`
 * calls it where `traverseFields` calls `promise()` and pushes its promise. `c` is the
 * `afterReadArgs` array.
 */
const hookedLeaf = (
  c: any[],
  blockData: unknown,
  fields: any[],
  fieldIndex: number,
  fieldDepth: number,
  parentIndexPath: string,
  parentIsLocalized: unknown,
  parentPath: string,
  parentSchemaPath: string,
  select: unknown,
  selectMode: unknown,
  siblingDoc: any,
): Promise<void> =>
  upstreamPromise({
    blockData,
    collection: c[ARG_COLLECTION],
    context: c[ARG_CONTEXT],
    currentDepth: c[ARG_CURRENT_DEPTH],
    depth: c[ARG_DEPTH],
    doc: c[ARG_DOC],
    draft: c[ARG_DRAFT],
    fallbackLocale: c[ARG_FALLBACK_LOCALE],
    field: fields[fieldIndex],
    fieldDepth,
    fieldIndex,
    fieldPromises: c[ARG_FIELD_PROMISES],
    findMany: c[ARG_FIND_MANY],
    flattenLocales: c[ARG_FLATTEN_LOCALES],
    global: c[ARG_GLOBAL],
    locale: c[ARG_LOCALE],
    overrideAccess: c[ARG_OVERRIDE_ACCESS],
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    populate: c[ARG_POPULATE],
    populationPromises: c[ARG_POPULATION_PROMISES],
    req: c[ARG_REQ],
    select,
    selectMode,
    showHiddenFields: c[ARG_SHOW_HIDDEN_FIELDS],
    siblingDoc,
    siblingFields: fields,
    triggerAccessControl: true,
    triggerHooks: true,
  } as any)

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
  // Only for rows with hooked leaves: the `afterReadArgs` array, `blockData`, `field.fields`,
  // the array field's `path` / `schemaPath` and the rows' `fieldDepth`, `parentIsLocalized` and
  // `selectMode`.
  c?: any[],
  blockData?: unknown,
  fields?: any[],
  path?: string,
  schemaPath?: string,
  fieldDepth?: number,
  parentIsLocalized?: unknown,
  selectMode?: unknown,
): [number, number, unknown, number] | -1 => {
  const len = length < 0 ? rows.length : length
  for (let rowIndex = startRow; rowIndex < len; rowIndex++) {
    if (rowIndex in rows) {
      const siblingDoc = rows[rowIndex] || {}
      const stopped = c
        ? leafRun(
            siblingDoc,
            keys,
            flags,
            0,
            end,
            bits,
            select,
            fieldPromises,
            c,
            blockData,
            fields,
            '',
            path + '.' + rowIndex,
            schemaPath,
            fieldDepth,
            parentIsLocalized,
            selectMode,
          )
        : leafRun(siblingDoc, keys, flags, 0, end, bits, select, fieldPromises)
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
  const addonPath = coreRuntimeAddonPath()
  const addon = loadCoreRuntimeAddon() as { coreRuntimeBinding: () => CoreRuntimeBinding }
  const created = addon.coreRuntimeBinding()
  if (created.apiVersion !== CORE_RUNTIME_API_VERSION) {
    throw new Error(
      `The engine addon at ${addonPath} has core runtime API version ${created.apiVersion}, expected ${CORE_RUNTIME_API_VERSION}; rebuild it`,
    )
  }
  // `await value` resuming the Rust task: the binding's compiled async helper (V8's own Await, no
  // species lookups; crates/payload-core-runtime executor.rs `install_native_await`).
  // TRANSITIONAL (phase J, runtime): addons built before 2026-11-16 lack it; remove the fallback
  // once every agent's addon is rebuilt.
  const resume = created.resume
  const awaitValue =
    created.awaitValue ??
    ((value: unknown, token: number) => {
      void reflectApply(legacyPromiseThen, legacyPromiseResolve(value), [
        (result: unknown) => resume(token, true, result),
        (error: unknown) => resume(token, false, error),
      ])
    })

  created.init({
    // read only by addons built before 2026-11-16 (TRANSITIONAL, see above)
    awaitValue,
    thenReturn: (promise: Promise<unknown>, value: unknown) =>
      reflectApply(legacyPromiseThen, promise, [() => value]),
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

export type AfterReadTraverseFieldsArgs = Parameters<typeof upstreamTraverseFields>[0]

/**
 * Drop-in for `traverseFields` from `payload/src/fields/hooks/afterRead/traverseFields.ts`
 * (synchronous; exported by payload as `afterReadTraverseFields`, called by rich text editor
 * hooks). The parameter is destructured with upstream's pattern and defaults. The port runs the
 * traversal unless `triggerAccessControl` or `triggerHooks` is falsy (the engine's own traversals
 * never are; those flags are not modelled by the port), a path is not a string or `fieldDepth` is
 * not a number: then upstream's body runs.
 */
export const traverseFields = (args: AfterReadTraverseFieldsArgs): void => {
  const {
    blockData,
    collection,
    context,
    currentDepth,
    depth,
    doc,
    draft,
    fallbackLocale,
    fieldDepth = 0,
    fieldPromises,
    fields,
    findMany,
    flattenLocales,
    global,
    locale,
    overrideAccess,
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    populate,
    populationPromises,
    req,
    select,
    selectMode,
    showHiddenFields,
    siblingDoc,
    triggerAccessControl = true,
    triggerHooks = true,
  } = args
  if (
    !triggerAccessControl ||
    !triggerHooks ||
    typeof parentIndexPath !== 'string' ||
    typeof parentPath !== 'string' ||
    typeof parentSchemaPath !== 'string' ||
    typeof fieldDepth !== 'number'
  ) {
    upstreamTraverseFields({
      blockData,
      collection,
      context,
      currentDepth,
      depth,
      doc,
      draft,
      fallbackLocale,
      fieldDepth,
      fieldPromises,
      fields,
      findMany,
      flattenLocales,
      global,
      locale,
      overrideAccess,
      parentIndexPath,
      parentIsLocalized,
      parentPath,
      parentSchemaPath,
      populate,
      populationPromises,
      req,
      select,
      selectMode,
      showHiddenFields,
      siblingDoc,
      triggerAccessControl,
      triggerHooks,
    })
    return
  }
  // `afterReadArgs` layout (ARG_*), then blockData, fieldDepth, fields, parentIndexPath,
  // parentIsLocalized, parentPath, parentSchemaPath, selectMode, siblingDoc (after_read.rs `trav_arg`)
  getCoreRuntime().afterReadTraverseFields([
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
    fieldPromises,
    populationPromises,
    blockData,
    fieldDepth,
    fields,
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    selectMode,
    siblingDoc,
  ])
}
