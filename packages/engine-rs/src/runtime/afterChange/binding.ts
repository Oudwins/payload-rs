/**
 * Loads the afterChange/beforeDuplicate binding (crates/payload-core-hooks-after, exported by the
 * main addon as `coreHooksAfterBinding()`) and installs its JS helpers. It runs on the core
 * runtime's executor and host, so the core runtime is initialized first, from the same addon file.
 */
import { createRequire } from 'node:module'

import { fieldAffectsData, fieldShouldBeLocalized } from '../../../../payload/src/fields/config/types.js'
import { getFieldPaths } from '../../../../payload/src/fields/getFieldPaths.js'
import { getCoreRuntime } from '../index.js'

/*
 * Leaf fields (crates/payload-core-hooks-after `common::is_leaf`: no subfield traversal, no
 * editor hooks) run their whole `promise()` as one JS `async` function: the code below is
 * upstream's `promise.ts` with the `switch` cases that cannot match a leaf removed. The engine
 * calls them through `afterChangeLeaves` / `beforeDuplicateLeaves` where `traverseFields` calls
 * `promise()` and pushes the promises into the same array, in field order.
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

/** `afterChange/promise.ts` for a leaf field (`siblingFields` is never passed by upstream). */
const afterChangeLeaf = async (
  c: any[],
  field: any,
  fieldIndex: number,
  blockData: unknown,
  parentIndexPath: string,
  parentPath: string,
  parentSchemaPath: string,
  previousSiblingDoc: any,
  siblingData: unknown,
  siblingDoc: any,
): Promise<void> => {
  const { indexPath, path, schemaPath } = getFieldPaths({
    field,
    index: fieldIndex,
    parentIndexPath,
    parentPath,
    parentSchemaPath,
  })

  const pathSegments = path ? path.split('.') : []
  const schemaPathSegments = schemaPath ? schemaPath.split('.') : []
  const indexPathSegments = indexPath ? indexPath.split('-').filter(Boolean)?.map(Number) : []
  const getNestedValue = (data: any, path: string[]) =>
    path.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), data)
  const previousDoc = c[AC_PREVIOUS_DOC]
  const previousValData =
    previousSiblingDoc && Object.keys(previousSiblingDoc).length > 0
      ? previousSiblingDoc
      : previousDoc

  if (fieldAffectsData(field)) {
    // Execute hooks
    if ('hooks' in field && field.hooks?.afterChange) {
      for (const hook of field.hooks.afterChange) {
        const hookedValue = await hook({
          blockData,
          collection: c[AC_COLLECTION],
          context: c[AC_CONTEXT],
          data: c[AC_DATA],
          field,
          global: c[AC_GLOBAL],
          indexPath: indexPathSegments,
          operation: c[AC_OPERATION],
          originalDoc: c[AC_DOC],
          path: pathSegments,
          previousDoc,
          previousSiblingDoc,
          previousValue:
            getNestedValue(previousValData, pathSegments) ?? previousValData?.[field.name],
          req: c[AC_REQ],
          schemaPath: schemaPathSegments,
          siblingData,
          siblingFields: undefined,
          value: getNestedValue(siblingDoc, pathSegments) ?? siblingDoc?.[field.name],
        })

        if (hookedValue !== undefined) {
          siblingDoc[field.name] = hookedValue
        }
      }
    }
  }
}

// Indices of the `beforeDuplicate` context array (before_duplicate.rs `Ctx::arr`).
const BD_COLLECTION = 0
const BD_CONTEXT = 1
const BD_DOC = 2
const BD_REQ = 3

/** `beforeDuplicate/promise.ts` for a leaf field. */
const beforeDuplicateLeaf = async (
  c: any[],
  field: any,
  fieldIndex: number,
  blockData: unknown,
  parentIndexPath: string,
  parentIsLocalized: boolean,
  parentPath: string,
  parentSchemaPath: string,
  siblingDoc: any,
  siblingFields: unknown,
): Promise<void> => {
  const { indexPath, path, schemaPath } = getFieldPaths({
    field,
    index: fieldIndex,
    parentIndexPath,
    parentPath,
    parentSchemaPath,
  })

  const req = c[BD_REQ]
  const { localization } = req.payload.config

  const pathSegments = path ? path.split('.') : []
  const schemaPathSegments = schemaPath ? schemaPath.split('.') : []
  const indexPathSegments = indexPath ? indexPath.split('-').filter(Boolean)?.map(Number) : []

  if (fieldAffectsData(field)) {
    if ('disableDuplicate' in field && field.disableDuplicate) {
      delete siblingDoc[field.name]
      return
    }

    let fieldData = siblingDoc?.[field.name!]
    const fieldIsLocalized = localization && fieldShouldBeLocalized({ field, parentIsLocalized })

    // Run field beforeDuplicate hooks.
    if (Array.isArray('hooks' in field && field.hooks?.beforeDuplicate)) {
      if (fieldIsLocalized) {
        const localeData: Record<string, unknown> = {}

        for (const locale of localization.localeCodes) {
          const beforeDuplicateArgs = {
            blockData,
            collection: c[BD_COLLECTION],
            context: c[BD_CONTEXT],
            data: c[BD_DOC],
            field,
            global: undefined,
            indexPath: indexPathSegments,
            path: pathSegments,
            previousSiblingDoc: siblingDoc,
            previousValue: siblingDoc[field.name!]?.[locale],
            req,
            schemaPath: schemaPathSegments,
            siblingData: siblingDoc,
            siblingDocWithLocales: siblingDoc,
            siblingFields,
            value: siblingDoc[field.name!]?.[locale],
          }

          let hookResult
          if ('hooks' in field && field.hooks?.beforeDuplicate) {
            for (const hook of field.hooks.beforeDuplicate) {
              hookResult = await hook(beforeDuplicateArgs)
            }
          }

          if (typeof hookResult !== 'undefined') {
            localeData[locale] = hookResult
          }
        }

        siblingDoc[field.name!] = localeData
      } else {
        const beforeDuplicateArgs = {
          blockData,
          collection: c[BD_COLLECTION],
          context: c[BD_CONTEXT],
          data: c[BD_DOC],
          field,
          global: undefined,
          indexPath: indexPathSegments,
          path: pathSegments,
          previousSiblingDoc: siblingDoc,
          previousValue: siblingDoc[field.name!]!,
          req,
          schemaPath: schemaPathSegments,
          siblingData: siblingDoc,
          siblingDocWithLocales: siblingDoc,
          siblingFields,
          value: siblingDoc[field.name!]!,
        }

        let hookResult
        if ('hooks' in field && field.hooks?.beforeDuplicate) {
          for (const hook of field.hooks.beforeDuplicate) {
            hookResult = await hook(beforeDuplicateArgs)
          }
        }

        if (typeof hookResult !== 'undefined') {
          siblingDoc[field.name!] = hookResult
        }
      }
    }

    // First, for any localized fields, we will loop over locales
    // and if locale data is present, traverse the sub fields.
    // There are only a few different fields where this is possible.
    if (fieldIsLocalized) {
      if (typeof fieldData !== 'object' || fieldData === null) {
        siblingDoc[field.name!] = {}
        fieldData = siblingDoc[field.name!]
      }

      const promises: Promise<void>[] = []

      localization.localeCodes.forEach((locale: string) => {
        if (fieldData[locale]) {
          // (no subfields to traverse for a leaf: none of upstream's `switch` cases matches)
        }
      })

      await Promise.all(promises)
    }
  }
}

export type CoreHooksAfterBinding = {
  afterChange: (args: unknown) => Promise<unknown>
  beforeDuplicate: (args: unknown) => Promise<unknown>
  init: (host: Record<string, unknown>) => void
}

let binding: CoreHooksAfterBinding | undefined

export const getCoreHooksAfter = (): CoreHooksAfterBinding => {
  if (binding) {
    return binding
  }
  getCoreRuntime()
  const require = createRequire(import.meta.url)
  // Same resolution as `getCoreRuntime()`: both bindings must come from one addon instance.
  const addonPath =
    process.env.PAYLOAD_CORE_RUNTIME_ADDON ??
    process.env.PAYLOAD_ENGINE_ADDON ??
    '../../../payload-engine.node'
  const addon = require(addonPath) as { coreHooksAfterBinding?: () => CoreHooksAfterBinding }
  if (typeof addon.coreHooksAfterBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} has no coreHooksAfterBinding export`)
  }
  const created = addon.coreHooksAfterBinding()

  created.init({
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
    ) => {
      for (let fieldIndex = start; fieldIndex < end; fieldIndex++) {
        promises.push(
          afterChangeLeaf(
            c,
            fields[fieldIndex],
            fieldIndex,
            blockData,
            parentIndexPath,
            parentPath,
            parentSchemaPath,
            previousSiblingDoc,
            siblingData,
            siblingDoc,
          ),
        )
      }
    },
    /** `promises.push(promise({...}))` of beforeDuplicate `traverseFields` for the leaves `start..end`. */
    beforeDuplicateLeaves: (
      c: any[],
      fields: any[],
      start: number,
      end: number,
      promises: Promise<void>[],
      blockData: unknown,
      parentIndexPath: string,
      parentIsLocalized: boolean,
      parentPath: string,
      parentSchemaPath: string,
      siblingDoc: unknown,
    ) => {
      for (let fieldIndex = start; fieldIndex < end; fieldIndex++) {
        promises.push(
          beforeDuplicateLeaf(
            c,
            fields[fieldIndex],
            fieldIndex,
            blockData,
            parentIndexPath,
            parentIsLocalized,
            parentPath,
            parentSchemaPath,
            siblingDoc,
            fields,
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
      value,
    }),
    callHook: (hook: any, args: unknown) => hook(args),
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
