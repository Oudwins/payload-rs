/**
 * TS side of the Rust `beforeChange` port (crates/payload-core-hooks-change): loads the binding
 * from the same addon instance as the core runtime (they share its executor), installs the JS
 * helpers it calls back into, and exposes `beforeChange`, a drop-in for
 * `packages/payload/src/fields/hooks/beforeChange/index.ts`.
 *
 * The helpers are Payload utilities the TS reference calls, plus expressions of `promise.ts`
 * copied verbatim (labels, object literals) so evaluation order, key order and V8 error messages
 * stay identical. Payload internals are imported by relative path (see ../index.ts).
 */
import { createRequire } from 'node:module'

import type { Args as BeforeChangeArgs } from '../../../../payload/src/fields/hooks/beforeChange/index.js'
import type { JsonObject } from '../../../../payload/src/types/index.js'

import { ValidationError } from '../../../../payload/src/errors/ValidationError.js'
import { recordNewDoc } from '../../../../payload/src/fields/baseFields/authorship/index.js'
import { flattenValidationData } from '../../../../payload/src/fields/hooks/beforeChange/flattenValidationData.js'
import { promise as upstreamPromise } from '../../../../payload/src/fields/hooks/beforeChange/promise.js'
import { traverseFields as upstreamTraverseFields } from '../../../../payload/src/fields/hooks/beforeChange/traverseFields.js'
import { validateBlocksFilterOptions } from '../../../../payload/src/fields/validations.js'
import { deepMergeWithSourceArrays } from '../../../../payload/src/utilities/deepMerge.js'
import { getTranslatedLabel } from '../../../../payload/src/utilities/getTranslatedLabel.js'
import { isolateObjectProperty } from '../../../../payload/src/utilities/isolateObjectProperty.js'
import { getCoreRuntime } from '../index.js'

export type BeforeChangeBinding = {
  beforeChange: (args: unknown) => Promise<unknown>
  /**
   * `traverseFields` of beforeChange with its parameter already destructured (array in the
   * pattern's order, string paths): see crates/payload-core-hooks-change before_change.rs.
   */
  beforeChangeTraverseFields: (destructured: unknown[]) => Promise<void>
  init: (host: Record<string, unknown>) => void
  runMergeLocaleAction: (state: unknown) => void
}

let binding: BeforeChangeBinding | undefined

/** Verbatim copy of `buildFieldLabel` from promise.ts. */
function buildFieldLabel(parentLabel: string, label: string | undefined): string {
  if (!label) {
    return parentLabel
  }
  const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1)
  return parentLabel && capitalizedLabel
    ? `${parentLabel} > ${capitalizedLabel}`
    : capitalizedLabel || parentLabel
}

// Indices of the run context array (crates/payload-core-hooks-change before_change.rs `Ctx::arr`).
const C_ID = 0
const C_COLLECTION = 1
const C_CONTEXT = 2
const C_DATA = 3
const C_DOC = 4
const C_DOC_WITH_LOCALES = 5
const C_ERRORS = 6
const C_GLOBAL = 7
const C_IS_VALIDATION_OPERATION = 8
const C_MERGE_LOCALE_ACTIONS = 9
const C_OPERATION = 10
const C_OVERRIDE_ACCESS = 11
const C_REQ = 12
const C_SKIP_HOOKS = 13
const C_SUBMITTED_TOP_LEVEL_FIELD_NAMES = 14

/**
 * Upstream's `promise()` of a leaf field (crates/payload-core-hooks-change `is_leaf`: no subfield
 * traversal, no editor hooks), called with the args object upstream's `traverseFields` builds
 * (same keys, same order). The traversal-constant values come from the run context array `c`.
 */
const leafPromise = (
  c: any[],
  fields: any[],
  fieldIndex: number,
  blockData: any,
  blockFields: any,
  fieldLabelPath: any,
  parentIndexPath: string,
  parentIsLocalized: any,
  parentPath: string,
  parentSchemaPath: string,
  siblingData: any,
  siblingDoc: any,
  siblingDocWithLocales: any,
  skipValidation: any,
): Promise<void> =>
  upstreamPromise({
    id: c[C_ID],
    blockData,
    blockFields,
    collection: c[C_COLLECTION],
    context: c[C_CONTEXT],
    data: c[C_DATA],
    doc: c[C_DOC],
    docWithLocales: c[C_DOC_WITH_LOCALES],
    errors: c[C_ERRORS],
    field: fields[fieldIndex],
    fieldIndex,
    fieldLabelPath,
    global: c[C_GLOBAL],
    isValidationOperation: c[C_IS_VALIDATION_OPERATION],
    mergeLocaleActions: c[C_MERGE_LOCALE_ACTIONS],
    operation: c[C_OPERATION],
    overrideAccess: c[C_OVERRIDE_ACCESS],
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    req: c[C_REQ],
    siblingData,
    siblingDoc,
    siblingDocWithLocales,
    siblingFields: fields,
    skipHooks: c[C_SKIP_HOOKS],
    skipValidation,
    submittedTopLevelFieldNames: c[C_SUBMITTED_TOP_LEVEL_FIELD_NAMES],
  })

/**
 * Loads `hooksBeforeChangeBinding()` from the addon `getCoreRuntime()` uses
 * (`PAYLOAD_CORE_RUNTIME_ADDON`, else `PAYLOAD_ENGINE_ADDON`, else
 * `packages/engine-rs/payload-engine.node`).
 */
export const getBeforeChangeBinding = (): BeforeChangeBinding => {
  if (binding) {
    return binding
  }
  getCoreRuntime()
  const require = createRequire(import.meta.url)
  const addonPath =
    process.env.PAYLOAD_CORE_RUNTIME_ADDON ??
    process.env.PAYLOAD_ENGINE_ADDON ??
    '../../../payload-engine.node'
  const addon = require(addonPath) as { hooksBeforeChangeBinding: () => BeforeChangeBinding }
  const created = addon.hooksBeforeChangeBinding()

  created.init({
    /**
     * A `traverseFields` call whose fields are all leaves (the crate's `traverse`): upstream's
     * own `traverseFields.ts`, with the arguments the crate's call has.
     */
    beforeChangeLeafTraversal: (
      c: any[],
      fields: any[],
      blockData: any,
      blockFields: any,
      fieldLabelPath: any,
      parentIndexPath: string,
      parentIsLocalized: any,
      parentPath: string,
      parentSchemaPath: string,
      siblingData: any,
      siblingDoc: any,
      siblingDocWithLocales: any,
      skipValidation: any,
    ): Promise<void> =>
      upstreamTraverseFields({
        id: c[C_ID],
        blockData,
        blockFields,
        collection: c[C_COLLECTION],
        context: c[C_CONTEXT],
        data: c[C_DATA],
        doc: c[C_DOC],
        docWithLocales: c[C_DOC_WITH_LOCALES],
        errors: c[C_ERRORS],
        fieldLabelPath,
        fields,
        global: c[C_GLOBAL],
        isValidationOperation: c[C_IS_VALIDATION_OPERATION],
        mergeLocaleActions: c[C_MERGE_LOCALE_ACTIONS],
        operation: c[C_OPERATION],
        overrideAccess: c[C_OVERRIDE_ACCESS],
        parentIndexPath,
        parentIsLocalized,
        parentPath,
        parentSchemaPath,
        req: c[C_REQ],
        siblingData,
        siblingDoc,
        siblingDocWithLocales,
        skipHooks: c[C_SKIP_HOOKS],
        skipValidation,
        submittedTopLevelFieldNames: c[C_SUBMITTED_TOP_LEVEL_FIELD_NAMES],
      }),
    /** `promises.push(promise({...}))` of `traverseFields` for the leaf fields `start..end`. */
    beforeChangeLeaves: (
      c: any[],
      fields: any[],
      start: number,
      end: number,
      promises: Promise<void>[],
      blockData: unknown,
      blockFields: unknown,
      fieldLabelPath: unknown,
      parentIndexPath: string,
      parentIsLocalized: unknown,
      parentPath: string,
      parentSchemaPath: string,
      siblingData: unknown,
      siblingDoc: unknown,
      siblingDocWithLocales: unknown,
      skipValidation: unknown,
    ) => {
      for (let fieldIndex = start; fieldIndex < end; fieldIndex++) {
        promises.push(
          leafPromise(
            c,
            fields,
            fieldIndex,
            blockData,
            blockFields,
            fieldLabelPath,
            parentIndexPath,
            parentIsLocalized,
            parentPath,
            parentSchemaPath,
            siblingData,
            siblingDoc,
            siblingDocWithLocales,
            skipValidation,
          ),
        )
      }
    },
    blocksFilterOptionsErrors: (
      validationResult: any,
      field: any,
      siblingData: any,
      fieldLabelPath: string,
      path: string,
      req: any,
      errors: any[],
    ): boolean => {
      let filterOptionsError = false
      if (validationResult?.invalidBlockSlugs?.length) {
        filterOptionsError = true
        let rowIndex = -1
        for (const block of siblingData[field.name] as JsonObject[]) {
          rowIndex++
          if (validationResult.invalidBlockSlugs.includes(block.blockType as string)) {
            const blockConfigOrSlug = field.blocks.find((blockFromField: any) =>
              typeof blockFromField === 'string'
                ? blockFromField === block.blockType
                : blockFromField.slug === block.blockType,
            )
            const blockConfig =
              typeof blockConfigOrSlug === 'string'
                ? req.payload.blocks[blockConfigOrSlug]
                : blockConfigOrSlug

            const blockLabelPath =
              field?.label === false
                ? fieldLabelPath
                : buildFieldLabel(
                    fieldLabelPath,
                    `${getTranslatedLabel(field?.label || field?.name, req.i18n)} > ${req.t('fields:block')} ${rowIndex + 1} (${getTranslatedLabel(blockConfig?.labels?.singular || block.blockType, req.i18n)})`,
                  )

            errors.push({
              label: blockLabelPath,
              message: req.t('validation:invalidBlock', { block: block.blockType }),
              path: `${path}.${rowIndex}.id`,
            })
          }
        }
      }
      return filterOptionsError
    },
    deepMergeWithSourceArrays: (obj1: object, obj2: object) =>
      deepMergeWithSourceArrays<JsonObject>(obj1, obj2),
    // The args object literal of the rich text editor beforeChange hooks (same key order).
    editorHookArgs: (
      collection: unknown,
      context: unknown,
      data: unknown,
      docWithLocales: unknown,
      errors: unknown,
      field: unknown,
      fieldLabelPath: unknown,
      global: unknown,
      indexPath: unknown,
      mergeLocaleActions: unknown,
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
      siblingDocWithLocales: unknown,
      skipValidation: unknown,
      value: unknown,
    ) => ({
      collection,
      context,
      data,
      docWithLocales,
      errors,
      field,
      fieldLabelPath,
      global,
      indexPath,
      mergeLocaleActions,
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
      siblingDocWithLocales,
      skipValidation,
      value,
    }),
    // The args object literal of field beforeChange hooks (same key order).
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
      siblingDocWithLocales: unknown,
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
      siblingDocWithLocales,
      siblingFields,
      value,
    }),
    inOp: (key: PropertyKey, target: any) => key in target,
    isolateLocale: (req: any, locale: string) => {
      const validationReq = isolateObjectProperty(req, 'locale')
      validationReq.locale = locale
      return validationReq
    },
    labelArrayRow: (fieldLabelPath: string, field: any, req: any, rowIndex: number) =>
      field?.label === false
        ? fieldLabelPath
        : buildFieldLabel(
            fieldLabelPath,
            `${getTranslatedLabel(field?.label || field?.name, req.i18n)} ${rowIndex + 1}`,
          ),
    labelBlockRow: (
      fieldLabelPath: string,
      field: any,
      req: any,
      rowIndex: number,
      block: any,
      blockTypeToMatch: any,
    ) =>
      field?.label === false
        ? fieldLabelPath
        : buildFieldLabel(
            fieldLabelPath,
            `${getTranslatedLabel(field?.label || field?.name, req.i18n)} > ${req.t('fields:block')} ${rowIndex + 1} (${getTranslatedLabel(block?.labels?.singular || blockTypeToMatch, req.i18n)})`,
          ),
    labelCollapsible: (fieldLabelPath: string, field: any, req: any) =>
      field.type === 'row' || field?.label === false
        ? fieldLabelPath
        : buildFieldLabel(
            fieldLabelPath,
            getTranslatedLabel(field?.label || field?.type, req.i18n),
          ),
    labelEditor: (fieldLabelPath: string, field: any, req: any) =>
      field?.label === false
        ? fieldLabelPath
        : buildFieldLabel(
            fieldLabelPath,
            getTranslatedLabel(field?.label || field?.name, req.i18n),
          ),
    labelField: (fieldLabelPath: string, field: any, req: any) =>
      buildFieldLabel(fieldLabelPath, getTranslatedLabel(field?.label || field?.name, req.i18n)),
    labelFieldError: (fieldLabelPath: string, field: any, req: any, failedLocale: any) => {
      const fieldLabel = buildFieldLabel(
        fieldLabelPath,
        getTranslatedLabel(field?.label || field?.name, req.i18n),
      )
      return failedLocale ? `${fieldLabel} (${failedLocale})` : fieldLabel
    },
    labelGroup: (fieldLabelPath: string, field: any, req: any, isNamedGroup: boolean) => {
      const fallbackLabel = field?.label || (isNamedGroup ? field.name : field?.type)
      return field?.label === false
        ? fieldLabelPath
        : buildFieldLabel(fieldLabelPath, getTranslatedLabel(fallbackLabel, req.i18n))
    },
    labelTab: (fieldLabelPath: string, field: any, req: any) =>
      field?.label === false
        ? fieldLabelPath
        : buildFieldLabel(fieldLabelPath, getTranslatedLabel(field?.label || field.name, req.i18n)),
    labelTabs: (fieldLabelPath: string, field: any, req: any) =>
      field?.label === false
        ? fieldLabelPath
        : buildFieldLabel(fieldLabelPath, getTranslatedLabel(field?.label || '', req.i18n)),
    localeContext: (
      req: any,
      blockData: any,
      blockFields: any,
      validationData: any,
      collection: any,
      global: any,
      validationSiblingData: any,
      siblingFields: any,
      locale: string,
      parentIsLocalized: boolean,
    ) => ({
      blockData:
        blockData && blockFields
          ? flattenValidationData({
              config: req.payload.config,
              data: blockData,
              fields: blockFields,
              locale,
              parentIsLocalized,
            })
          : blockData,
      data: flattenValidationData({
        config: req.payload.config,
        data: validationData,
        fields: (collection?.fields || global?.fields)!,
        locale,
      }),
      siblingData: flattenValidationData({
        config: req.payload.config,
        data: validationSiblingData,
        fields: siblingFields!,
        locale,
        parentIsLocalized,
      }),
    }),
    localesIn: (localization: any, valueToValidate: any) =>
      localization.localeCodes.filter((locale: string) => locale in valueToValidate),
    // `() => { ... }` of promise.ts: an arrow over the native state (the closure body is in Rust).
    mergeLocaleAction: (state: unknown) => () => created.runMergeLocaleAction(state),
    objectPrototype: Object.prototype,
    parseFloat,
    recordNewDoc: (context: any, docWithLocales: any) =>
      recordNewDoc(context, !docWithLocales || Object.keys(docWithLocales).length === 0),
    tryJSONParse: (siblingData: any, name: string) => {
      try {
        JSON.parse(siblingData[name] as string)
      } catch (e) {
        return e
      }
      return undefined
    },
    validateBlocksFilterOptions,
    validateOptions: (
      field: any,
      id: unknown,
      blockData: unknown,
      collection: any,
      data: unknown,
      jsonError: unknown,
      operation: unknown,
      overrideAccess: unknown,
      path: unknown,
      siblingDoc: any,
      locale: string | undefined,
      req: unknown,
      siblingData: unknown,
    ) => ({
      ...field,
      id,
      blockData,
      collectionSlug: collection?.slug,
      data,
      event: 'submit',
      jsonError,
      operation,
      overrideAccess,
      path,
      preferences: { fields: {} },
      previousValue: locale
        ? (siblingDoc[field.name] as JsonObject)?.[locale]
        : siblingDoc[field.name],
      req,
      siblingData,
    }),
    validationError: (id: any, collection: any, errors: any[], global: any, req: any) =>
      new ValidationError(
        {
          id,
          collection: collection?.slug,
          errors,
          global: global?.slug,
          req,
        },
        req.t,
      ),
  })
  binding = created
  return created
}

/** Drop-in for `beforeChange` from `payload/src/fields/hooks/beforeChange/index.ts`. */
export const beforeChange = <T extends JsonObject>(args: BeforeChangeArgs<T>): Promise<T> =>
  getBeforeChangeBinding().beforeChange(args) as Promise<T>

export type BeforeChangeTraverseFieldsArgs = Parameters<typeof upstreamTraverseFields>[0]

/**
 * Drop-in for `traverseFields` from `payload/src/fields/hooks/beforeChange/traverseFields.ts`
 * (exported by payload as `beforeChangeTraverseFields`, called by rich text editor hooks). The
 * parameter is destructured with upstream's pattern (in an async function, so a throw there is a
 * rejection). Non-string paths, which the port holds as Rust strings, run upstream's body.
 */
export const traverseFields = (args: BeforeChangeTraverseFieldsArgs): Promise<void> => {
  try {
    const {
      id,
      blockData,
      blockFields,
      collection,
      context,
      data,
      doc,
      docWithLocales,
      errors,
      fieldLabelPath,
      fields,
      global,
      isValidationOperation,
      mergeLocaleActions,
      operation,
      overrideAccess,
      parentIndexPath,
      parentIsLocalized,
      parentPath,
      parentSchemaPath,
      req,
      siblingData,
      siblingDoc,
      siblingDocWithLocales,
      skipHooks,
      skipValidation,
      submittedTopLevelFieldNames,
    } = args
    if (
      typeof parentIndexPath !== 'string' ||
      typeof parentPath !== 'string' ||
      typeof parentSchemaPath !== 'string'
    ) {
      return upstreamTraverseFields({
        id,
        blockData,
        blockFields,
        collection,
        context,
        data,
        doc,
        docWithLocales,
        errors,
        fieldLabelPath,
        fields,
        global,
        isValidationOperation,
        mergeLocaleActions,
        operation,
        overrideAccess,
        parentIndexPath,
        parentIsLocalized,
        parentPath,
        parentSchemaPath,
        req,
        siblingData,
        siblingDoc,
        siblingDocWithLocales,
        skipHooks,
        skipValidation,
        submittedTopLevelFieldNames,
      })
    }
    return getBeforeChangeBinding().beforeChangeTraverseFields([
      id,
      blockData,
      blockFields,
      collection,
      context,
      data,
      doc,
      docWithLocales,
      errors,
      fieldLabelPath,
      fields,
      global,
      isValidationOperation,
      mergeLocaleActions,
      operation,
      overrideAccess,
      parentIndexPath,
      parentIsLocalized,
      parentPath,
      parentSchemaPath,
      req,
      siblingData,
      siblingDoc,
      siblingDocWithLocales,
      skipHooks,
      skipValidation,
      submittedTopLevelFieldNames,
    ])
  } catch (error) {
    return Promise.reject(error)
  }
}
