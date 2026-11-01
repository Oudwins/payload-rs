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
import type { Field, TabAsField, Validate } from '../../../../payload/src/fields/config/types.js'

import { ValidationError } from '../../../../payload/src/errors/ValidationError.js'
import { recordNewDoc } from '../../../../payload/src/fields/baseFields/authorship/index.js'
import { fieldAffectsData, fieldShouldBeLocalized } from '../../../../payload/src/fields/config/types.js'
import { getFieldPaths } from '../../../../payload/src/fields/getFieldPaths.js'
import { flattenValidationData } from '../../../../payload/src/fields/hooks/beforeChange/flattenValidationData.js'
import { validateBlocksFilterOptions } from '../../../../payload/src/fields/validations.js'
import { deepMergeWithSourceArrays } from '../../../../payload/src/utilities/deepMerge.js'
import { getTranslatedLabel } from '../../../../payload/src/utilities/getTranslatedLabel.js'
import { isolateObjectProperty } from '../../../../payload/src/utilities/isolateObjectProperty.js'
import { getCoreRuntime } from '../index.js'

export type BeforeChangeBinding = {
  beforeChange: (args: unknown) => Promise<unknown>
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
// 5: docWithLocales (only read by container fields)
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
 * `beforeChange/promise.ts` for a leaf field (crates/payload-core-hooks-change `is_leaf`: no
 * subfield traversal, no editor hooks): upstream's body verbatim, with the one `switch` case a
 * leaf can reach (`point`). `beforeChangeLeaves` calls it where `traverseFields` calls
 * `promise()`.
 */
const beforeChangeLeaf = async (
  c: any[],
  field: any,
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
  siblingFields: any,
  skipValidation: any,
): Promise<void> => {
  const id = c[C_ID]
  const collection = c[C_COLLECTION]
  const context = c[C_CONTEXT]
  const data = c[C_DATA]
  const doc = c[C_DOC]
  const errors = c[C_ERRORS]
  const global = c[C_GLOBAL]
  const isValidationOperation = c[C_IS_VALIDATION_OPERATION]
  const mergeLocaleActions = c[C_MERGE_LOCALE_ACTIONS]
  const operation = c[C_OPERATION]
  const overrideAccess = c[C_OVERRIDE_ACCESS]
  const req = c[C_REQ]
  const skipHooks = c[C_SKIP_HOOKS]
  const submittedTopLevelFieldNames = c[C_SUBMITTED_TOP_LEVEL_FIELD_NAMES]
  const { indexPath, path, schemaPath } = getFieldPaths({
    field,
    index: fieldIndex,
    parentIndexPath,
    parentPath,
    parentSchemaPath,
  })

  const { localization } = req.payload.config
  const defaultLocale = localization ? localization?.defaultLocale : 'en'
  const operationLocale = req.locale || defaultLocale

  const pathSegments = path ? path.split('.') : []
  const schemaPathSegments = schemaPath ? schemaPath.split('.') : []
  const indexPathSegments = indexPath ? indexPath.split('-').filter(Boolean)?.map(Number) : []

  const passesCondition = field.admin?.condition
    ? Boolean(
        field.admin.condition(data, siblingData, {
          blockData: blockData!,
          operation,
          path: pathSegments,
          user: req.user,
        }),
      )
    : true
  const isOutsideSubmittedFieldScope =
    submittedTopLevelFieldNames !== undefined &&
    fieldAffectsData(field) &&
    !submittedTopLevelFieldNames.has(pathSegments[0]!)
  let skipValidationFromHere = skipValidation || isOutsideSubmittedFieldScope || !passesCondition

  if (fieldAffectsData(field)) {
    const shouldSkipValidationForLocalizedFallback =
      !isValidationOperation &&
      operation !== 'validate' &&
      fieldShouldBeLocalized({ field, parentIsLocalized }) &&
      operationLocale !== defaultLocale &&
      ['array', 'blocks'].includes(field.type) &&
      siblingData[field.name!] === null

    if (shouldSkipValidationForLocalizedFallback) {
      skipValidationFromHere = true
    }

    // Execute hooks
    if (!skipHooks && 'hooks' in field && field.hooks?.beforeChange) {
      for (const hook of field.hooks.beforeChange) {
        const hookedValue = await hook({
          blockData,
          collection,
          context,
          data,
          field,
          global,
          indexPath: indexPathSegments,
          operation,
          originalDoc: doc,
          overrideAccess,
          path: pathSegments,
          previousSiblingDoc: siblingDoc,
          previousValue: siblingDoc[field.name],
          req,
          schemaPath: schemaPathSegments,
          siblingData,
          siblingDocWithLocales,
          siblingFields: siblingFields!,
          value: siblingData[field.name],
        })

        if (hookedValue !== undefined) {
          siblingData[field.name] = hookedValue
        }
      }
    }

    if (hasInvalidFieldValueShape({ field, value: siblingData[field.name!] })) {
      errors.push({
        label: buildFieldLabel(
          fieldLabelPath,
          getTranslatedLabel(field?.label || field?.name, req.i18n),
        ),
        message: req.t('validation:invalidInput'),
        path,
      })
      return
    }

    // Validate
    if (!skipValidationFromHere && 'validate' in field && field.validate) {
      const valueToValidate = siblingData[field.name]

      // With `locale: 'all'` a localized scalar is a locale-keyed object; validate each locale, not the
      // wrapper. Containers (`group`/`array`/`blocks`) are excluded - per-locale child validation is a follow-up.
      const isLocaleKeyedValue =
        operationLocale === 'all' &&
        localization &&
        fieldShouldBeLocalized({ field, parentIsLocalized }) &&
        field.type !== 'group' &&
        valueToValidate !== null &&
        typeof valueToValidate === 'object' &&
        !Array.isArray(valueToValidate)

      const localizedValuesToValidate: { locale?: string; value: unknown }[] = isLocaleKeyedValue
        ? localization.localeCodes
            .filter((locale) => locale in (valueToValidate as JsonObject))
            .map((locale) => ({ locale, value: (valueToValidate as JsonObject)[locale] }))
        : [{ value: valueToValidate }]

      // No recognized locales (e.g. `{}`): validate `undefined` once so required/optional still apply.
      if (localizedValuesToValidate.length === 0) {
        localizedValuesToValidate.push({ value: undefined })
      }

      let jsonError: object

      if (field.type === 'json' && typeof siblingData[field.name] === 'string') {
        try {
          JSON.parse(siblingData[field.name] as string)
        } catch (e) {
          jsonError = e as object
        }
      }

      const validateFn: Validate<object, object, object, object> = field.validate as Validate<
        object,
        object,
        object,
        object
      >

      let validationResult: string | true = true
      let failedLocale: string | undefined

      const validationData = deepMergeWithSourceArrays<JsonObject>(doc, data)
      const validationSiblingData = deepMergeWithSourceArrays<JsonObject>(siblingDoc, siblingData)

      for (const { locale, value } of localizedValuesToValidate) {
        // Scope `req.locale` to the locale being validated without mutating the shared request.
        const validationReq = locale ? isolateObjectProperty(req, 'locale') : req
        if (locale) {
          validationReq.locale = locale
        }

        const localeContext = locale
          ? {
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
            }
          : { blockData, data: validationData, siblingData: validationSiblingData }

        validationResult = await validateFn(value as never, {
          ...field,
          id,
          blockData: localeContext.blockData!,
          collectionSlug: collection?.slug,
          data: localeContext.data,
          event: 'submit',
          // @ts-expect-error generic validation options cannot infer JSON fields
          jsonError,
          operation,
          overrideAccess,
          path: pathSegments,
          preferences: { fields: {} },
          previousValue: locale
            ? (siblingDoc[field.name] as JsonObject)?.[locale]
            : siblingDoc[field.name],
          req: validationReq,
          siblingData: localeContext.siblingData,
        })

        if (typeof validationResult === 'string') {
          failedLocale = locale
          break
        }
      }

      if (typeof validationResult === 'string') {
        let filterOptionsError = false

        if (field.type === 'blocks' && field.filterOptions) {
          // Re-run filteroptions. If the validation error is due to filteroptions, we need to add error paths to all the blocks
          // that are no longer valid
          const validationResult = await validateBlocksFilterOptions({
            id,
            data,
            filterOptions: field.filterOptions,
            req,
            siblingData,
            value: siblingData[field.name],
          })
          if (validationResult?.invalidBlockSlugs?.length) {
            filterOptionsError = true
            let rowIndex = -1
            for (const block of siblingData[field.name] as JsonObject[]) {
              rowIndex++
              if (validationResult.invalidBlockSlugs.includes(block.blockType as string)) {
                const blockConfigOrSlug = field.blocks.find((blockFromField) =>
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
        }

        if (!filterOptionsError) {
          // If the error is due to block filterOptions, we want to push the errors for each individual block, not the blocks
          // field itself => only push the error if the field is not a block field with validation failure due to filterOptions
          const fieldLabel = buildFieldLabel(
            fieldLabelPath,
            getTranslatedLabel(field?.label || field?.name, req.i18n),
          )

          errors.push({
            label: failedLocale ? `${fieldLabel} (${failedLocale})` : fieldLabel,
            message: validationResult,
            path,
          })
        }
      }
    }

    // Push merge locale action if applicable
    if (localization && fieldShouldBeLocalized({ field, parentIsLocalized })) {
      mergeLocaleActions.push(() => {
        const localeData: Record<string, unknown> = {}

        // With `locale: 'all'`, siblingData holds a locale-keyed object (`{ en, es }`) rather than a single
        // locale's value - take each submitted locale, falling back to the existing doc for ones not sent.
        const submittedValue = siblingData[field.name!]
        const isAllLocales =
          req.locale === 'all' &&
          submittedValue !== null &&
          typeof submittedValue === 'object' &&
          !Array.isArray(submittedValue)

        for (const locale of localization.localeCodes) {
          const existingValue = siblingDocWithLocales?.[field.name!]?.[locale]

          const fieldValue = isAllLocales
            ? locale in (submittedValue as Record<string, unknown>)
              ? (submittedValue as Record<string, unknown>)[locale]
              : existingValue
            : locale === req.locale
              ? submittedValue
              : existingValue

          // update locale value if it's not undefined
          if (typeof fieldValue !== 'undefined') {
            localeData[locale] = fieldValue
          }
        }

        // If there are locales with data, set the data
        if (Object.keys(localeData).length > 0) {
          siblingData[field.name!] = localeData
        }
      })
    }
  }

  switch (field.type) {
    case 'point': {
      // Transform point data for storage
      if (
        Array.isArray(siblingData[field.name]) &&
        siblingData[field.name][0] !== null &&
        siblingData[field.name][1] !== null
      ) {
        siblingData[field.name] = {
          type: 'Point',
          coordinates: [
            parseFloat(siblingData[field.name][0]),
            parseFloat(siblingData[field.name][1]),
          ],
        }
      }

      break
    }
  }
}

/** Verbatim copy of the module-private `hasInvalidFieldValueShape` of promise.ts. */
function hasInvalidFieldValueShape({
  field,
  value,
}: {
  field: Field | TabAsField
  value: unknown
}): boolean {
  if (value === null || typeof value === 'undefined' || !fieldAffectsData(field)) {
    return false
  }

  if (field.type === 'array' || field.type === 'blocks') {
    // Form state may use a numeric row count, while submitted values use arrays.
    return !(Array.isArray(value) || typeof value === 'number')
  }

  if (field.type === 'number') {
    // Only hasMany number fields may receive arrays.
    return typeof value === 'object' && !(field.hasMany && Array.isArray(value))
  }

  if ((field.type === 'relationship' || field.type === 'upload') && field.hasMany) {
    // HasMany relationships/uploads may receive arrays or one valid polymorphic value.
    if (typeof value !== 'object' || Array.isArray(value)) {
      return false
    }

    const relationshipValue = value as Record<PropertyKey, unknown>
    const valuePrototype = Object.getPrototypeOf(value)
    const isSinglePolymorphicRelationshipValue =
      Array.isArray(field.relationTo) &&
      (valuePrototype === null || valuePrototype === Object.prototype) &&
      Object.hasOwn(relationshipValue, 'relationTo') &&
      Object.hasOwn(relationshipValue, 'value') &&
      Reflect.ownKeys(relationshipValue).length === 2 &&
      typeof relationshipValue.relationTo === 'string' &&
      field.relationTo.includes(relationshipValue.relationTo) &&
      (typeof relationshipValue.value === 'string' || typeof relationshipValue.value === 'number')

    return !isSinglePolymorphicRelationshipValue
  }

  return false
}

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
          beforeChangeLeaf(
            c,
            fields[fieldIndex],
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
            fields,
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
