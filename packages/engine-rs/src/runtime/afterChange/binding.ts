/**
 * Loads the afterChange/beforeDuplicate binding (crates/payload-core-hooks-after, exported by the
 * main addon as `coreHooksAfterBinding()`) and installs its JS helpers. It runs on the core
 * runtime's executor and host, so the core runtime is initialized first, from the same addon file.
 */

import { promise as upstreamAfterChangePromise } from '../../../../payload/src/fields/hooks/afterChange/promise.js'
import { traverseFields as upstreamAfterChangeTraverseFields } from '../../../../payload/src/fields/hooks/afterChange/traverseFields.js'
import { promise as upstreamBeforeDuplicatePromise } from '../../../../payload/src/fields/hooks/beforeDuplicate/promise.js'
import { traverseFields as upstreamBeforeDuplicateTraverseFields } from '../../../../payload/src/fields/hooks/beforeDuplicate/traverseFields.js'
import { callUserFunction } from '../../../../payload/src/utilities/callUserFunction.js'
import { skipCompilation } from '../../../../payload/src/utilities/skipCompilation.js'
import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../../addon.js'
import { getCoreRuntime } from '../index.js'

/*
 * Leaf fields (crates/payload-core-hooks-after `common::is_leaf`: no subfield traversal, no
 * editor hooks) run upstream's own `promise()`, called with the args object upstream's
 * `traverseFields` builds (same keys, same order); a `traverseFields` call whose fields are all
 * leaves runs upstream's own `traverseFields`. The traversal-constant values come from the
 * crate's context array.
 */

// Indices of the `afterChange` context array (after_change.rs `Ctx::arr`).
const AC_COLLECTION = 0
const AC_CONTEXT = 1
const AC_DATA = 2
const AC_DOC = 3
const AC_GLOBAL = 4
const AC_OPERATION = 5
const AC_PREVIOUS_DOC = 6
const AC_REQ = 7

/**
 * `afterChange` `promise()` of a leaf field. `siblingFields` is `traverseFields`' own argument:
 * upstream's nested calls never pass it, only an external caller of the exported
 * `afterChangeTraverseFields` can.
 */
const afterChangeLeaf = (
  c: any[],
  fields: any[],
  fieldIndex: number,
  blockData: any,
  parentIndexPath: string,
  parentIsLocalized: any,
  parentPath: string,
  parentSchemaPath: string,
  previousSiblingDoc: any,
  siblingData: any,
  siblingDoc: any,
  siblingFields: any,
): Promise<void> =>
  upstreamAfterChangePromise({
    blockData,
    collection: c[AC_COLLECTION],
    context: c[AC_CONTEXT],
    data: c[AC_DATA],
    doc: c[AC_DOC],
    field: fields[fieldIndex],
    fieldIndex,
    global: c[AC_GLOBAL],
    operation: c[AC_OPERATION],
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    previousDoc: c[AC_PREVIOUS_DOC],
    previousSiblingDoc,
    req: c[AC_REQ],
    siblingData,
    siblingDoc,
    siblingFields,
  })

// Indices of the `beforeDuplicate` context array (before_duplicate.rs `Ctx::arr`).
const BD_COLLECTION = 0
const BD_CONTEXT = 1
const BD_DOC = 2
const BD_REQ = 3
const BD_ID = 4
const BD_OVERRIDE_ACCESS = 5

/** `beforeDuplicate` `promise()` of a leaf field. */
const beforeDuplicateLeaf = (
  c: any[],
  fields: any[],
  fieldIndex: number,
  blockData: any,
  parentIndexPath: string,
  parentIsLocalized: any,
  parentPath: string,
  parentSchemaPath: string,
  siblingDoc: any,
): Promise<void> =>
  upstreamBeforeDuplicatePromise({
    id: c[BD_ID],
    blockData,
    collection: c[BD_COLLECTION],
    context: c[BD_CONTEXT],
    doc: c[BD_DOC],
    field: fields[fieldIndex],
    fieldIndex,
    overrideAccess: c[BD_OVERRIDE_ACCESS],
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    req: c[BD_REQ],
    siblingDoc,
    siblingFields: fields,
  })

/** afterChange `traverseFields` over leaves only: upstream's own function. */
const afterChangeLeafTraversal = (
  c: any[],
  fields: any[],
  blockData: any,
  parentIndexPath: string,
  parentPath: string,
  parentSchemaPath: string,
  previousSiblingDoc: any,
  siblingData: any,
  siblingDoc: any,
  siblingFields: any,
  parentIsLocalized: any,
): Promise<void> =>
  upstreamAfterChangeTraverseFields({
    blockData,
    collection: c[AC_COLLECTION],
    context: c[AC_CONTEXT],
    data: c[AC_DATA],
    doc: c[AC_DOC],
    fields,
    global: c[AC_GLOBAL],
    operation: c[AC_OPERATION],
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    previousDoc: c[AC_PREVIOUS_DOC],
    previousSiblingDoc,
    req: c[AC_REQ],
    siblingData,
    siblingDoc,
    siblingFields,
  })

/** beforeDuplicate `traverseFields` over leaves only: upstream's own function. */
const beforeDuplicateLeafTraversal = (
  c: any[],
  fields: any[],
  blockData: any,
  parentIndexPath: string,
  parentIsLocalized: any,
  parentPath: string,
  parentSchemaPath: string,
  siblingDoc: any,
): Promise<void> =>
  upstreamBeforeDuplicateTraverseFields({
    id: c[BD_ID],
    blockData,
    collection: c[BD_COLLECTION],
    context: c[BD_CONTEXT],
    doc: c[BD_DOC],
    fields,
    overrideAccess: c[BD_OVERRIDE_ACCESS],
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    req: c[BD_REQ],
    siblingDoc,
  })

export type CoreHooksAfterBinding = {
  afterChange: (args: unknown) => Promise<unknown>
  /**
   * `traverseFields` of afterChange with its parameter already destructured (array in the
   * pattern's order, string paths): see crates/payload-core-hooks-after after_change.rs.
   */
  afterChangeTraverseFields: (destructured: unknown[]) => Promise<void>
  beforeDuplicate: (args: unknown) => Promise<unknown>
  init: (host: Record<string, unknown>) => void
}

let binding: CoreHooksAfterBinding | undefined

export const getCoreHooksAfter = (): CoreHooksAfterBinding => {
  if (binding) {
    return binding
  }
  getCoreRuntime()
  // Same resolution as `getCoreRuntime()`: both bindings must come from one addon instance.
  const addonPath = coreRuntimeAddonPath()
  const addon = loadCoreRuntimeAddon() as { coreHooksAfterBinding?: () => CoreHooksAfterBinding }
  if (typeof addon.coreHooksAfterBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} has no coreHooksAfterBinding export`)
  }
  const created = addon.coreHooksAfterBinding()

  created.init({
    afterChangeLeafTraversal,
    /** `promises.push(promise({...}))` of afterChange `traverseFields` for the leaves `start..end`. */
    afterChangeLeaves: (
      c: any[],
      fields: any[],
      start: number,
      end: number,
      promises: Promise<void>[],
      blockData: unknown,
      parentIndexPath: string,
      parentPath: string,
      parentSchemaPath: string,
      previousSiblingDoc: unknown,
      siblingData: unknown,
      siblingDoc: unknown,
      siblingFields: unknown,
      parentIsLocalized: unknown,
    ) => {
      for (let fieldIndex = start; fieldIndex < end; fieldIndex++) {
        promises.push(
          afterChangeLeaf(
            c,
            fields,
            fieldIndex,
            blockData,
            parentIndexPath,
            parentIsLocalized,
            parentPath,
            parentSchemaPath,
            previousSiblingDoc,
            siblingData,
            siblingDoc,
            siblingFields,
          ),
        )
      }
    },
    beforeDuplicateLeafTraversal,
    /** `promises.push(promise({...}))` of beforeDuplicate `traverseFields` for the leaves `start..end`. */
    beforeDuplicateLeaves: (
      c: any[],
      fields: any[],
      start: number,
      end: number,
      promises: Promise<void>[],
      blockData: unknown,
      parentIndexPath: string,
      parentIsLocalized: unknown,
      parentPath: string,
      parentSchemaPath: string,
      siblingDoc: unknown,
    ) => {
      for (let fieldIndex = start; fieldIndex < end; fieldIndex++) {
        promises.push(
          beforeDuplicateLeaf(
            c,
            fields,
            fieldIndex,
            blockData,
            parentIndexPath,
            parentIsLocalized,
            parentPath,
            parentSchemaPath,
            siblingDoc,
          ),
        )
      }
    },
    // The field afterChange hook args literal of afterChange/promise.ts (same key order).
    afterChangeHookArgs: (
      blockData: unknown,
      collection: unknown,
      context: unknown,
      data: unknown,
      field: unknown,
      global: unknown,
      indexPath: unknown,
      operation: unknown,
      originalDoc: unknown,
      path: unknown,
      previousDoc: unknown,
      previousSiblingDoc: unknown,
      previousValue: unknown,
      req: unknown,
      schemaPath: unknown,
      siblingData: unknown,
      siblingFields: unknown,
      value: unknown,
    ) => ({
      blockData,
      collection,
      context,
      data,
      field,
      global,
      indexPath,
      operation,
      originalDoc,
      path,
      previousDoc,
      previousSiblingDoc,
      previousValue,
      req,
      schemaPath,
      siblingData,
      siblingFields,
      skipCompilation,
      value,
    }),
    // The beforeDuplicateArgs literal of beforeDuplicate/promise.ts (same key order).
    beforeDuplicateHookArgs: (
      blockData: unknown,
      collection: unknown,
      context: unknown,
      data: unknown,
      field: unknown,
      indexPath: unknown,
      path: unknown,
      siblingDoc: unknown,
      previousValue: unknown,
      req: unknown,
      schemaPath: unknown,
      siblingFields: unknown,
      value: unknown,
    ) => ({
      blockData,
      collection,
      context,
      data,
      field,
      global: undefined,
      indexPath,
      path,
      previousSiblingDoc: siblingDoc,
      previousValue,
      req,
      schemaPath,
      siblingData: siblingDoc,
      siblingDocWithLocales: siblingDoc,
      siblingFields,
      skipCompilation,
      value,
    }),
    callHook: (hook: any, args: unknown) => callUserFunction(hook, undefined, [args], 'hook'),
    // The rich text editor afterChange hook args literal of afterChange/promise.ts.
    editorAfterChangeHookArgs: (
      collection: unknown,
      context: unknown,
      data: unknown,
      field: unknown,
      global: unknown,
      indexPath: unknown,
      operation: unknown,
      originalDoc: unknown,
      parentIsLocalized: unknown,
      path: unknown,
      previousDoc: unknown,
      previousSiblingDoc: unknown,
      previousValue: unknown,
      req: unknown,
      schemaPath: unknown,
      siblingData: unknown,
      value: unknown,
    ) => ({
      collection,
      context,
      data,
      field,
      global,
      indexPath,
      operation,
      originalDoc,
      parentIsLocalized,
      path,
      previousDoc,
      previousSiblingDoc,
      previousValue,
      req,
      schemaPath,
      siblingData,
      value,
    }),
    // `for...of` over non-array iterables: same source text, so V8 raises the same TypeError.
    editorAfterChangeHooks: (editor: any) => {
      const hooks: unknown[] = []
      for (const hook of editor.hooks.afterChange) {
        hooks.push(hook)
      }
      return hooks
    },
    fieldAfterChangeHooks: (field: any) => {
      const hooks: unknown[] = []
      for (const hook of field.hooks.afterChange) {
        hooks.push(hook)
      }
      return hooks
    },
    fieldBeforeDuplicateHooks: (field: any) => {
      const hooks: unknown[] = []
      for (const hook of field.hooks.beforeDuplicate) {
        hooks.push(hook)
      }
      return hooks
    },
    keysLength: (value: any) => Object.keys(value).length,
    localeCodes: (localization: any) => {
      const codes: unknown[] = []
      for (const locale of localization.localeCodes) {
        codes.push(locale)
      }
      return codes
    },
    localeCodesForEach: (localization: any) => localization.localeCodes.forEach(() => {}),
    spread: (value: any) => ({ ...value }),
  })
  binding = created
  return created
}
