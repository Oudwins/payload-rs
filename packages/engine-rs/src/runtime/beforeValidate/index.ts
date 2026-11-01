/**
 * TS side of the Rust `beforeValidate` field traversal (crates/payload-core-hooks-validate):
 * loads `hooksBeforeValidateBinding()` from the same addon as the core runtime (they share its
 * executor and host), installs the beforeValidate host helpers and exposes drop-ins for
 * `beforeValidate` and the exported `traverseFields`. See RUST_CORE_DESIGN.md.
 *
 * Payload internals are imported by relative path (engine-rs has no installed `payload` link);
 * these are the module instances payload itself uses.
 */
import { createRequire } from 'node:module'

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
import { stripNullRows } from '../../../../payload/src/fields/hooks/beforeValidate/stripNullRows.js'
import { unflattenData } from '../../../../payload/src/utilities/unflattenData.js'
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

export const getBeforeValidateBinding = (): BeforeValidateBinding => {
  if (binding) {
    return binding
  }
  // Installs the shared runtime host (executor await helper, property helpers, descriptor cache).
  getCoreRuntime()
  const require = createRequire(import.meta.url)
  // Must resolve to the same file as the core runtime so both bindings share one Rust instance.
  const addonPath =
    process.env.PAYLOAD_CORE_RUNTIME_ADDON ??
    process.env.PAYLOAD_ENGINE_ADDON ??
    '../../../payload-engine.node'
  const addon = require(addonPath) as { hooksBeforeValidateBinding?: () => BeforeValidateBinding }
  if (typeof addon.hooksBeforeValidateBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} does not export hooksBeforeValidateBinding`)
  }
  const created = addon.hooksBeforeValidateBinding()
  created.init({
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

/** Drop-in for `traverseFields` from `payload/src/fields/hooks/beforeValidate/traverseFields.ts`. */
export const traverseFields = (args: Record<string, unknown>): Promise<void> =>
  getBeforeValidateBinding().traverseFields(args)
