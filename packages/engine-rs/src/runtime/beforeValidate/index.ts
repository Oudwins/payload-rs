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

import type { TypeWithID } from '../../../../payload/src/collections/config/types.js'
import type { JsonValue } from '../../../../payload/src/types/index.js'

import { fieldAffectsData, valueIsValueWithRelation } from '../../../../payload/src/fields/config/types.js'
import { getFieldPaths } from '../../../../payload/src/fields/getFieldPaths.js'
import { cloneDataFromOriginalDoc } from '../../../../payload/src/fields/hooks/beforeChange/cloneDataFromOriginalDoc.js'
import { getFallbackValue } from '../../../../payload/src/fields/hooks/beforeValidate/getFallbackValue.js'
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
 * `beforeValidate/promise.ts` for a leaf field (crates/payload-core-hooks-validate `is_leaf`: no
 * subfield traversal, no editor hooks): upstream's body verbatim up to `// Traverse subfields`,
 * whose `switch` has no case for a leaf. `beforeValidateLeaves` calls it where `traverseFields`
 * calls `promise()`.
 */
const beforeValidateLeaf = async <T>(
  c: any[],
  field: any,
  fieldIndex: number,
  blockData: any,
  docForHooks: any,
  parentIndexPath: string,
  parentPath: string,
  parentSchemaPath: string,
  siblingData: any,
  siblingDoc: any,
  siblingFields: any,
): Promise<void> => {
  const id = c[C_ID]
  const collection = c[C_COLLECTION]
  const context = c[C_CONTEXT]
  const data = c[C_DATA]
  const doc = c[C_DOC]
  const global = c[C_GLOBAL]
  const onFieldAccess = c[C_ON_FIELD_ACCESS]
  const operation = c[C_OPERATION]
  const overrideAccess = c[C_OVERRIDE_ACCESS]
  const req = c[C_REQ]
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
  const policyDoc = path === '_status' && docForHooks ? docForHooks : doc
  const policySiblingDoc =
    path === '_status' && docForHooks ? (docForHooks as JsonObject) : siblingDoc

  if (fieldAffectsData(field)) {
    if (field.name === 'id') {
      if (field.type === 'number' && typeof siblingData[field.name] === 'string') {
        const value = siblingData[field.name] as string

        siblingData[field.name] = parseFloat(value)
      }

      if (
        field.type === 'text' &&
        typeof siblingData[field.name]?.toString === 'function' &&
        typeof siblingData[field.name] !== 'string'
      ) {
        siblingData[field.name] = siblingData[field.name].toString()
      }
    }

    // Sanitize incoming data
    switch (field.type) {
      case 'array':
      case 'blocks': {
        // Handle cases of arrays being intentionally set to 0
        if (siblingData[field.name] === '0' || siblingData[field.name] === 0) {
          siblingData[field.name] = []
        }

        break
      }

      case 'checkbox': {
        if (siblingData[field.name] === 'true') {
          siblingData[field.name] = true
        }
        if (siblingData[field.name] === 'false') {
          siblingData[field.name] = false
        }
        if (siblingData[field.name] === '') {
          siblingData[field.name] = false
        }

        break
      }

      case 'number': {
        if (typeof siblingData[field.name] === 'string') {
          const value = siblingData[field.name] as string
          const trimmed = value.trim()
          siblingData[field.name] = trimmed.length === 0 ? null : parseFloat(trimmed)
        }

        break
      }

      case 'point': {
        if (Array.isArray(siblingData[field.name])) {
          siblingData[field.name] = (siblingData[field.name] as string[]).map((coordinate, i) => {
            if (typeof coordinate === 'string') {
              const value = siblingData[field.name][i] as string
              const trimmed = value.trim()
              return trimmed.length === 0 ? null : parseFloat(trimmed)
            }
            return coordinate
          })
        }

        break
      }
      case 'relationship':
      case 'upload': {
        if (
          siblingData[field.name] === '' ||
          siblingData[field.name] === 'none' ||
          siblingData[field.name] === 'null' ||
          siblingData[field.name] === null
        ) {
          if (field.hasMany === true) {
            siblingData[field.name] = []
          } else {
            siblingData[field.name] = null
          }
        }

        const value = siblingData[field.name]

        if (Array.isArray(field.relationTo)) {
          if (Array.isArray(value)) {
            value.forEach((relatedDoc: { relationTo: string; value: JsonValue }, i) => {
              const relatedCollection = req.payload.collections?.[relatedDoc.relationTo]?.config

              if (
                typeof relatedDoc.value === 'object' &&
                relatedDoc.value &&
                'id' in relatedDoc.value
              ) {
                relatedDoc.value = relatedDoc.value.id
              }

              if (relatedCollection?.fields) {
                const relationshipIDField = relatedCollection.fields.find(
                  (collectionField) =>
                    fieldAffectsData(collectionField) && collectionField.name === 'id',
                )
                if (relationshipIDField?.type === 'number') {
                  siblingData[field.name][i] = {
                    ...relatedDoc,
                    value: parseFloat(relatedDoc.value as string),
                  }
                }
              }
            })
          }
          if (field.hasMany !== true && valueIsValueWithRelation(value)) {
            const relatedCollection = req.payload.collections?.[value.relationTo]?.config

            if (typeof value.value === 'object' && value.value && 'id' in value.value) {
              value.value = (value.value as TypeWithID).id
            }

            if (relatedCollection?.fields) {
              const relationshipIDField = relatedCollection.fields.find(
                (collectionField) =>
                  fieldAffectsData(collectionField) && collectionField.name === 'id',
              )
              if (relationshipIDField?.type === 'number') {
                siblingData[field.name] = { ...value, value: parseFloat(value.value as string) }
              }
            }
          }
        } else {
          if (Array.isArray(value)) {
            value.forEach((relatedDoc: unknown, i) => {
              const relatedCollection = Array.isArray(field.relationTo)
                ? undefined
                : req.payload.collections?.[field.relationTo]?.config

              if (typeof relatedDoc === 'object' && relatedDoc && 'id' in relatedDoc) {
                value[i] = relatedDoc.id
              }

              if (relatedCollection?.fields) {
                const relationshipIDField = relatedCollection.fields.find(
                  (collectionField) =>
                    fieldAffectsData(collectionField) && collectionField.name === 'id',
                )
                if (relationshipIDField?.type === 'number') {
                  siblingData[field.name][i] = parseFloat(relatedDoc as string)
                }
              }
            })
          }
          if (field.hasMany !== true && value) {
            const relatedCollection = req.payload.collections?.[field.relationTo]?.config

            if (typeof value === 'object' && value && 'id' in value) {
              siblingData[field.name] = value.id
            }

            if (relatedCollection?.fields) {
              const relationshipIDField = relatedCollection.fields.find(
                (collectionField) =>
                  fieldAffectsData(collectionField) && collectionField.name === 'id',
              )
              if (relationshipIDField?.type === 'number') {
                siblingData[field.name] = parseFloat(value as string)
              }
            }
          }
        }
        break
      }
      case 'richText': {
        if (typeof siblingData[field.name] === 'string') {
          try {
            const richTextJSON = JSON.parse(siblingData[field.name] as string)
            siblingData[field.name] = richTextJSON
          } catch {
            // Disregard this data as it is not valid.
            // Will be reported to user by field validation
          }
        }

        break
      }

      default: {
        break
      }
    }

    // ensure the fallback value is only computed one time
    // either here or when access control returns false
    const fallbackResult: { executed: boolean; value: unknown } = {
      executed: false,
      value: undefined,
    }
    if (typeof siblingData[field.name!] === 'undefined' && !req.context?.isRestoringVersion) {
      fallbackResult.value = await getFallbackValue({ field, req, siblingDoc })
      fallbackResult.executed = true
    }

    // Execute hooks
    if ('hooks' in field && field.hooks?.beforeValidate) {
      for (const hook of field.hooks.beforeValidate) {
        const hookedValue = await hook({
          blockData,
          collection,
          context,
          data: data as Partial<T>,
          field,
          global,
          indexPath: indexPathSegments,
          operation,
          originalDoc: policyDoc,
          overrideAccess,
          path: pathSegments,
          previousSiblingDoc: policySiblingDoc,
          previousValue: policySiblingDoc[field.name],
          req,
          schemaPath: schemaPathSegments,
          siblingData,
          siblingFields: siblingFields!,
          value:
            typeof siblingData[field.name] === 'undefined'
              ? fallbackResult.value
              : siblingData[field.name],
        })

        if (hookedValue !== undefined) {
          siblingData[field.name] = hookedValue
        }
      }
    }

    let accessResult = true

    // Execute access control
    if (field.access && field.access[operation]) {
      accessResult = overrideAccess
        ? true
        : await field.access[operation](
            collection
              ? {
                  id,
                  blockData,
                  collection,
                  data: data as Partial<T>,
                  doc: policyDoc,
                  req,
                  siblingData,
                }
              : {
                  id,
                  blockData,
                  data: data as Partial<T>,
                  doc: policyDoc,
                  global: global!,
                  req,
                  siblingData,
                },
          )

      if (!accessResult) {
        delete siblingData[field.name!]
      }
    }

    onFieldAccess?.({ accessResult, path })

    if (typeof siblingData[field.name!] === 'undefined' && !req.context?.isRestoringVersion) {
      const isDocumentValueAllowed =
        operation === 'update' || operation === 'validate' || accessResult

      siblingData[field.name!] =
        !fallbackResult.executed || !isDocumentValueAllowed
          ? await getFallbackValue({ field, isDocumentValueAllowed, req, siblingDoc })
          : fallbackResult.value
    }
  }
}

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
    /** `promises.push(promise({...}))` of `traverseFields` for the leaf fields `start..end`. */
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
    ) => {
      for (let fieldIndex = start; fieldIndex < end; fieldIndex++) {
        promises.push(
          beforeValidateLeaf(
            c,
            fields[fieldIndex],
            fieldIndex,
            blockData,
            docForHooks,
            parentIndexPath,
            parentPath,
            parentSchemaPath,
            siblingData,
            siblingDoc,
            fields,
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
