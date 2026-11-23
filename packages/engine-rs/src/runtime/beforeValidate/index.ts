/**
 * TS side of the Rust `beforeValidate` field traversal (crates/payload-core-hooks-validate):
 * loads `hooksBeforeValidateBinding()` from the same addon as the core runtime (they share its
 * executor and host), installs the beforeValidate host helpers and exposes drop-ins for
 * `beforeValidate` and the exported `traverseFields`. See RUST_CORE_DESIGN.md.
 *
 * Payload internals are imported by relative path (engine-rs has no installed `payload` link);
 * these are the module instances payload itself uses.
 */

import type { SanitizedCollectionConfig } from '../../../../payload/src/collections/config/types.js'
import type { SanitizedGlobalConfig } from '../../../../payload/src/globals/config/types.js'
import type { RequestContext } from '../../../../payload/src/index.js'
import type {
  BeforeValidateOperation,
  JsonObject,
  PayloadRequest,
} from '../../../../payload/src/types/index.js'

import { cloneDataFromOriginalDoc } from '../../../../payload/src/fields/hooks/beforeChange/cloneDataFromOriginalDoc.js'
import { getExistingRowDoc } from '../../../../payload/src/fields/hooks/beforeChange/getExistingRowDoc.js'
import { promise as upstreamPromise } from '../../../../payload/src/fields/hooks/beforeValidate/promise.js'
import { stripNullRows } from '../../../../payload/src/fields/hooks/beforeValidate/stripNullRows.js'
import { traverseFields as upstreamTraverseFields } from '../../../../payload/src/fields/hooks/beforeValidate/traverseFields.js'
import { skipCompilation } from '../../../../payload/src/utilities/skipCompilation.js'
import { unflattenData } from '../../../../payload/src/utilities/unflattenData.js'
import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../../addon.js'
import { getCoreRuntime } from '../index.js'

export type BeforeValidateBinding = {
  beforeValidate: (args: unknown) => Promise<unknown>
  init: (host: Record<string, unknown>) => void
  traverseFields: (args: unknown) => Promise<void>
}

/** Same arguments as `beforeValidate` in `payload/src/fields/hooks/beforeValidate/index.ts`. */
export type BeforeValidateArgs<T extends JsonObject> = {
  collection: null | SanitizedCollectionConfig
  context: RequestContext
  data: T
  doc?: T
  docForHooks?: T
  duplicate?: boolean
  global: null | SanitizedGlobalConfig
  id?: number | string
  onFieldAccess?: (args: { accessResult: boolean; path: string }) => void
  operation: BeforeValidateOperation
  overrideAccess: boolean
  req: PayloadRequest
}

let binding: BeforeValidateBinding | undefined

// Indices of the run context array (crates/payload-core-hooks-validate before_validate.rs `Ctx::arr`).
const C_ID = 0
const C_COLLECTION = 1
const C_CONTEXT = 2
const C_DATA = 3
const C_DOC = 4
const C_GLOBAL = 5
const C_ON_FIELD_ACCESS = 6
const C_OPERATION = 7
const C_OVERRIDE_ACCESS = 8
const C_REQ = 9

/**
 * Upstream's `promise()` of a leaf field (crates/payload-core-hooks-validate `is_leaf`: no subfield
 * traversal, no editor hooks), called with the args object upstream's `traverseFields` builds
 * (same keys, same order). The traversal-constant values come from the run context array `c`.
 */
const leafPromise = (
  c: any[],
  fields: any[],
  fieldIndex: number,
  blockData: any,
  docForHooks: any,
  parentIndexPath: string,
  parentIsLocalized: any,
  parentPath: string,
  parentSchemaPath: string,
  siblingData: any,
  siblingDoc: any,
): Promise<void> =>
  upstreamPromise({
    id: c[C_ID],
    blockData,
    collection: c[C_COLLECTION],
    context: c[C_CONTEXT],
    data: c[C_DATA],
    doc: c[C_DOC],
    docForHooks,
    field: fields[fieldIndex],
    fieldIndex,
    global: c[C_GLOBAL],
    onFieldAccess: c[C_ON_FIELD_ACCESS],
    operation: c[C_OPERATION],
    overrideAccess: c[C_OVERRIDE_ACCESS],
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    req: c[C_REQ],
    siblingData,
    siblingDoc,
    siblingFields: fields,
  })

/**
 * A `traverseFields` call whose fields are all leaves (the crate's `traverse`): upstream's own
 * `traverseFields.ts`, with the arguments the crate's call has.
 */
const beforeValidateLeafTraversal = (
  c: any[],
  fields: any[],
  blockData: any,
  docForHooks: any,
  parentIndexPath: string,
  parentPath: string,
  parentSchemaPath: string,
  siblingData: any,
  siblingDoc: any,
  parentIsLocalized: any,
): Promise<void> =>
  upstreamTraverseFields({
    id: c[C_ID],
    blockData,
    collection: c[C_COLLECTION],
    context: c[C_CONTEXT],
    data: c[C_DATA],
    doc: c[C_DOC],
    docForHooks,
    fields,
    global: c[C_GLOBAL],
    onFieldAccess: c[C_ON_FIELD_ACCESS],
    operation: c[C_OPERATION],
    overrideAccess: c[C_OVERRIDE_ACCESS],
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    req: c[C_REQ],
    siblingData,
    siblingDoc,
  })

export const getBeforeValidateBinding = (): BeforeValidateBinding => {
  if (binding) {
    return binding
  }
  // Installs the shared runtime host (executor await helper, property helpers, descriptor cache).
  getCoreRuntime()
  // Must resolve to the same file as the core runtime so both bindings share one Rust instance.
  const addonPath = coreRuntimeAddonPath()
  const addon = loadCoreRuntimeAddon() as {
    hooksBeforeValidateBinding?: () => BeforeValidateBinding
  }
  if (typeof addon.hooksBeforeValidateBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} does not export hooksBeforeValidateBinding`)
  }
  const created = addon.hooksBeforeValidateBinding()
  created.init({
    /** `promises.push(promise({...}))` of `traverseFields` for the leaf fields `start..end`. */
    beforeValidateLeafTraversal,
    beforeValidateLeaves: (
      c: any[],
      fields: any[],
      start: number,
      end: number,
      promises: Promise<void>[],
      blockData: unknown,
      docForHooks: unknown,
      parentIndexPath: string,
      parentPath: string,
      parentSchemaPath: string,
      siblingData: unknown,
      siblingDoc: unknown,
      parentIsLocalized: unknown,
    ) => {
      for (let fieldIndex = start; fieldIndex < end; fieldIndex++) {
        promises.push(
          leafPromise(
            c,
            fields,
            fieldIndex,
            blockData,
            docForHooks,
            parentIndexPath,
            parentIsLocalized,
            parentPath,
            parentSchemaPath,
            siblingData,
            siblingDoc,
          ),
        )
      }
    },
    cloneDataFromOriginalDoc,
    // The args object literal of the rich text editor hooks in `promise.ts` (same key order).
    editorHookArgs: (
      collection: unknown,
      context: unknown,
      data: unknown,
      field: unknown,
      global: unknown,
      indexPath: unknown,
      operation: unknown,
      originalDoc: unknown,
      overrideAccess: unknown,
      parentIsLocalized: unknown,
      path: unknown,
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
      overrideAccess,
      parentIsLocalized,
      path,
      previousSiblingDoc,
      previousValue,
      req,
      schemaPath,
      siblingData,
      value,
    }),
    getExistingRowDoc,
    skipCompilation,
    // The args object literal of the field hooks in `promise.ts` (same key order).
    hookArgs: (
      blockData: unknown,
      collection: unknown,
      context: unknown,
      data: unknown,
      field: unknown,
      global: unknown,
      indexPath: unknown,
      operation: unknown,
      originalDoc: unknown,
      overrideAccess: unknown,
      path: unknown,
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
      overrideAccess,
      path,
      previousSiblingDoc,
      previousValue,
      req,
      schemaPath,
      siblingData,
      siblingFields,
      skipCompilation,
      value,
    }),
    jsonParse: (text: string) => JSON.parse(text),
    parseFloat,
    // `{ ...relatedDoc, value: parseFloat(relatedDoc.value) }` (spread first, then the read).
    spreadParseValue: (relatedDoc: any) => ({ ...relatedDoc, value: parseFloat(relatedDoc.value) }),
    stripNullRows,
    // Named `value` so a non-string produces V8's `value.trim is not a function`, like promise.ts.
    trim: (value: any) => value.trim(),
    unflattenData,
  })
  binding = created
  return created
}

/** Drop-in for `beforeValidate` from `payload/src/fields/hooks/beforeValidate/index.ts`. */
export const beforeValidate = <T extends JsonObject>(args: BeforeValidateArgs<T>): Promise<T> =>
  getBeforeValidateBinding().beforeValidate(args) as Promise<T>

export type BeforeValidateTraverseFieldsArgs = Parameters<typeof upstreamTraverseFields>[0]

/**
 * Drop-in for `traverseFields` from `payload/src/fields/hooks/beforeValidate/traverseFields.ts`
 * (exported by payload as `beforeValidateTraverseFields`). The parameter is destructured with
 * upstream's pattern (a throwing getter rejects, as in the async function); a path that is not a
 * string runs upstream's own function (the port works on string paths), as do the other
 * traversals' drop-ins.
 */
export const traverseFields = (args: BeforeValidateTraverseFieldsArgs): Promise<void> => {
  let destructured: BeforeValidateTraverseFieldsArgs
  try {
    const {
      id,
      blockData,
      collection,
      context,
      data,
      doc,
      docForHooks,
      fields,
      global,
      onFieldAccess,
      operation,
      overrideAccess,
      parentIndexPath,
      parentIsLocalized,
      parentPath,
      parentSchemaPath,
      req,
      siblingData,
      siblingDoc,
    } = args
    destructured = {
      id,
      blockData,
      collection,
      context,
      data,
      doc,
      docForHooks,
      fields,
      global,
      onFieldAccess,
      operation,
      overrideAccess,
      parentIndexPath,
      parentIsLocalized,
      parentPath,
      parentSchemaPath,
      req,
      siblingData,
      siblingDoc,
    }
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the thrown value, unchanged
    return Promise.reject(error)
  }
  if (
    typeof destructured.parentIndexPath !== 'string' ||
    typeof destructured.parentPath !== 'string' ||
    typeof destructured.parentSchemaPath !== 'string'
  ) {
    return upstreamTraverseFields(destructured)
  }
  try {
    return getBeforeValidateBinding().traverseFields(destructured)
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the thrown value, unchanged
    return Promise.reject(error)
  }
}
