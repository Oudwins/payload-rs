/**
 * afterRead's `traverseFields` driven by the plans the Rust core runtime decodes from the
 * sanitized config (crates/payload-core-runtime config.rs `FieldsDesc::js_plan`, `fast_kind`).
 *
 * The Rust engine decides, once per fields array and per `overrideAccess` / parent-localized
 * combination, which branches of upstream's `promise()` (fields/hooks/afterRead/promise.ts) a
 * field can reach. For the kinds it classifies (plain leaves, localized plain leaves, relationship-
 * like fields, named groups, arrays, unnamed rows / collapsibles / groups) every remaining branch is a fixed
 * sequence of sibling doc operations; `fastField` performs exactly that sequence, in upstream's
 * order, as an `async` function with upstream's awaits (the field hooks loop and the default
 * value step), and recurses into nested fields with the same plans. A localized plain leaf
 * (`LOCALIZED_LEAF`) adds upstream's value hoisting, and runs this way only with a truthy
 * `flattenLocales` and a `locale` other than `'all'`. Every other field (virtual fields, read
 * access to await, other localized fields, `locale: 'all'`, blocks, tabs, rich text, points)
 * runs upstream's own `promise()` with the args literal upstream's
 * `traverseFields` builds, so its behaviour is upstream's by construction.
 *
 * What the plans skip is config work only: argument literals, `getFieldPaths` and path segment
 * arrays nobody reads, `fieldAffectsData` / `fieldShouldBeLocalized` / `stripUnselectedFields`
 * calls whose results the config decides. Every doc, select and request read, write, delete and
 * call happens as in upstream, and every field pushes one promise onto `fieldPromises`, created
 * where upstream's is and settled the same way (so `Promise.all` schedules the same reactions).
 *
 * Like the Rust port, a traversal iterates the decoded fields (RUST_CORE_DESIGN.md section 7:
 * config mutations after the first traversal are not seen).
 */

import { getDefaultValue } from '../../../payload/src/fields/getDefaultValue.js'
import { getFieldPaths } from '../../../payload/src/fields/getFieldPaths.js'
import { relationshipPopulationPromise } from '../../../payload/src/fields/hooks/afterRead/relationshipPopulationPromise.js'
import { callUserFunction } from '../../../payload/src/utilities/callUserFunction.js'
import { skipCompilation } from '../../../payload/src/utilities/skipCompilation.js'

/** A fields array decoded by Rust (`FieldsDesc::js_plan`). */
export type AfterReadPlan = {
  /** nested plans, `children[fieldIndex * 4 + variant]` (filled by `childPlan`) */
  children: (AfterReadPlan | undefined)[]
  /** the fields array itself (`siblingFields`) */
  fields: any
  /** `leaf_flags` bits per field */
  flags: number[]
  isArray: boolean
  /** `field.name` per field */
  keys: PropertyKey[]
  /** `fast_kind` per field */
  kinds: number[]
}

/** The arguments of one `traverseFields` call that vary between calls. */
type Trav = {
  blockData: unknown
  fieldDepth: number
  /** `getFieldPaths`' `parentPathToUse` is empty (a field named `id` gets the path `'id'`) */
  isIDPath: boolean
  parentIndexPath: string
  parentIsLocalized: unknown
  parentPath: string
  parentSchemaPath: string
  select: any
  selectMode: unknown
  siblingDoc: any
}

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

// config.rs `leaf_flags`
const AFFECTS_DATA = 1
const HIDDEN = 2
const NAME_IS_ID = 4
const NAME_TRUTHY = 8
const HAS_DEFAULT_VALUE = 16
const HIDDEN_IS_TRUE = 64
const HAS_HOOKS = 128

// config.rs `fast_kind`
const UPSTREAM = 0
const RELATIONSHIP = 2
const GROUP = 3
const ARRAY = 4
const UNNAMED = 5
const LOCALIZED_LEAF = 6

/**
 * promise.ts's localized value hoisting (`if (fieldAffectsDataResult && shouldHoistLocalizedValue)`),
 * verbatim: `{ [locale]: value }` -> the value of `locale`, or of the fallback locale(s) when that
 * is missing (or empty, for text-like fields).
 */
const hoistLocalizedValue = (c: any[], field: any, key: PropertyKey, siblingDoc: any): void => {
  const locale = c[ARG_LOCALE]
  const fallbackLocale = c[ARG_FALLBACK_LOCALE]
  const value = siblingDoc[key][locale]

  let hoistedValue = value

  if (fallbackLocale && fallbackLocale !== locale) {
    let fallbackValue
    const isNullOrUndefined = typeof value === 'undefined' || value === null

    if (Array.isArray(fallbackLocale)) {
      for (const locale of fallbackLocale) {
        const val = siblingDoc[key]?.[locale]
        if (val !== undefined && val !== null && val !== '') {
          fallbackValue = val
          break
        }
      }
    } else {
      fallbackValue = siblingDoc[key][fallbackLocale]
    }

    if (fallbackValue) {
      switch (field.type) {
        case 'slug':
        case 'text':
        case 'textarea': {
          if (value === '' || isNullOrUndefined) {
            hoistedValue = fallbackValue
          }
          break
        }

        default: {
          if (isNullOrUndefined) {
            hoistedValue = fallbackValue
          }
          break
        }
      }
    }
  }

  siblingDoc[key] = hoistedValue
}

/** after_read.rs `parent_path_to_use_is_empty` */
const isIDPathOf = (parentPath: string): boolean =>
  parentPath === '' || (!parentPath.includes('.') && parentPath.startsWith('_index-'))

export type AfterReadTraverseDeps = {
  /** `fields.forEach(() => {})` (V8's TypeError for a fields value that is not an array) */
  forEachFields: (fields: unknown) => void
  /** upstream's `promise()` for field `fieldIndex` with upstream `traverseFields`' args literal */
  hookedLeaf: (
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
  ) => Promise<void>
  /** the Rust plan of a fields array (`afterReadPlan` of the core runtime binding) */
  planFor: (fields: unknown, variant: number) => AfterReadPlan
}

/**
 * Creates the host's `afterReadTraverse(c, plan, siblingDoc, select, selectMode)`: the root
 * `traverseFields` call of `afterRead` (`c` is the `afterReadArgs` array).
 */
export const createAfterReadTraverse = ({
  forEachFields,
  hookedLeaf,
  planFor,
}: AfterReadTraverseDeps) => {
  const traverse = (c: any[], plan: AfterReadPlan, t: Trav): void => {
    if (!plan.isArray) {
      forEachFields(plan.fields)
      return
    }
    const kinds = plan.kinds
    const fieldPromises = c[ARG_FIELD_PROMISES]
    for (let i = 0; i < kinds.length; i++) {
      // `fieldPromises.push(promise({...}))`: `push` is read before the field runs
      if (
        kinds[i] === UPSTREAM ||
        (kinds[i] === LOCALIZED_LEAF && (!c[ARG_FLATTEN_LOCALES] || c[ARG_LOCALE] === 'all'))
      ) {
        fieldPromises.push(
          hookedLeaf(
            c,
            t.blockData,
            plan.fields,
            i,
            t.fieldDepth,
            t.parentIndexPath,
            t.parentIsLocalized,
            t.parentPath,
            t.parentSchemaPath,
            t.select,
            t.selectMode,
            t.siblingDoc,
          ),
        )
      } else {
        fieldPromises.push(fastField(c, plan, i, t))
      }
    }
  }

  /** The plan of `field.fields` for the nested traversal (cached on the parent plan). */
  const childPlan = (
    c: any[],
    plan: AfterReadPlan,
    index: number,
    field: any,
    parentIsLocalized: unknown,
  ): AfterReadPlan => {
    const variant = (c[ARG_OVERRIDE_ACCESS] ? 1 : 0) | (parentIsLocalized ? 2 : 0)
    const slot = index * 4 + variant
    return (plan.children[slot] ??= planFor(field.fields, variant))
  }

  const trav = (
    siblingDoc: any,
    select: any,
    selectMode: unknown,
    blockData: unknown,
    fieldDepth: number,
    parentIsLocalized: unknown,
    parentIndexPath: string,
    parentPath: string,
    parentSchemaPath: string,
  ): Trav => ({
    blockData,
    fieldDepth,
    isIDPath: isIDPathOf(parentPath),
    parentIndexPath,
    parentIsLocalized,
    parentPath,
    parentSchemaPath,
    select,
    selectMode,
    siblingDoc,
  })

  /** `promise()` of a field of a fast kind (see the module comment). */
  const fastField = async (c: any[], plan: AfterReadPlan, i: number, t: Trav): Promise<void> => {
    const kind = plan.kinds[i]!
    const flags = plan.flags[i]!
    const key = plan.keys[i]!
    const siblingDoc = t.siblingDoc
    let removedFieldValue = false

    if (
      flags & AFFECTS_DATA &&
      flags & HIDDEN &&
      typeof siblingDoc[key] !== 'undefined' &&
      !c[ARG_SHOW_HIDDEN_FIELDS] &&
      !(flags & NAME_IS_ID && t.fieldDepth === 0)
    ) {
      removedFieldValue = true
      delete siblingDoc[key]
    }

    // `if (path !== 'id')` stripUnselectedFields
    if (!(flags & NAME_IS_ID && t.isIDPath)) {
      const select = t.select
      const selectMode = t.selectMode
      if (flags & AFFECTS_DATA && select && selectMode && flags & NAME_TRUTHY) {
        let shouldContinue = true
        if (selectMode === 'include') {
          if (!select[key]) {
            delete siblingDoc[key]
            shouldContinue = false
          }
        }
        if (selectMode === 'exclude') {
          if (select[key] === false) {
            delete siblingDoc[key]
            shouldContinue = false
          }
        }
        if (!shouldContinue) {
          return
        }
      }
    }

    // shouldHoistLocalizedValue: `fieldShouldBeLocalized` is false for every kind but
    // `LOCALIZED_LEAF` (true there), so for the others only the reads before it remain
    if (
      c[ARG_FLATTEN_LOCALES] &&
      flags & AFFECTS_DATA &&
      typeof siblingDoc[key] === 'object' &&
      siblingDoc[key] !== null &&
      kind === LOCALIZED_LEAF &&
      c[ARG_LOCALE] !== 'all' &&
      c[ARG_REQ].payload.config.localization
    ) {
      hoistLocalizedValue(c, plan.fields[i], key, siblingDoc)
    }

    // Sanitize outgoing field value
    if (kind === GROUP && typeof siblingDoc[key] === 'undefined') {
      siblingDoc[key] = {}
    }

    if (flags & AFFECTS_DATA) {
      // Execute hooks (`shouldRunHookOnAllLocales` is false for these kinds)
      if (flags & HAS_HOOKS) {
        const field = plan.fields[i]
        const { indexPath, path, schemaPath } = getFieldPaths({
          field,
          index: i,
          parentIndexPath: t.parentIndexPath,
          parentPath: t.parentPath,
          parentSchemaPath: t.parentSchemaPath,
        })
        const pathSegments = path ? path.split('.') : []
        const schemaPathSegments = schemaPath ? schemaPath.split('.') : []
        const indexPathSegments = indexPath ? indexPath.split('-').filter(Boolean)?.map(Number) : []
        for (const hook of field.hooks.afterRead) {
          const hookedValue = await callUserFunction(
            hook,
            undefined,
            [
              {
                blockData: t.blockData,
                collection: c[ARG_COLLECTION],
                context: c[ARG_CONTEXT],
                currentDepth: c[ARG_CURRENT_DEPTH],
                data: c[ARG_DOC],
                depth: c[ARG_DEPTH],
                draft: c[ARG_DRAFT],
                field,
                findMany: c[ARG_FIND_MANY],
                global: c[ARG_GLOBAL],
                indexPath: indexPathSegments,
                operation: 'read',
                originalDoc: c[ARG_DOC],
                overrideAccess: c[ARG_OVERRIDE_ACCESS],
                path: pathSegments,
                req: c[ARG_REQ],
                schemaPath: schemaPathSegments,
                showHiddenFields: c[ARG_SHOW_HIDDEN_FIELDS],
                siblingData: siblingDoc,
                siblingFields: plan.fields,
                skipCompilation,
                value: siblingDoc[key],
              },
            ],
            'hook',
          )

          if (hookedValue !== undefined) {
            siblingDoc[key] = hookedValue
          }
        }
      }

      // no virtual population; read access (if any) is skipped by `overrideAccess`
      if (
        !removedFieldValue &&
        typeof siblingDoc[key] === 'undefined' &&
        flags & HAS_DEFAULT_VALUE
      ) {
        const field = plan.fields[i]
        const req = c[ARG_REQ]
        siblingDoc[key] = await getDefaultValue({
          defaultValue: field.defaultValue,
          locale: c[ARG_LOCALE],
          req,
          user: req.user,
          value: siblingDoc[key],
        })
      }

      if (kind === RELATIONSHIP) {
        c[ARG_POPULATION_PROMISES].push(
          relationshipPopulationPromise({
            currentDepth: c[ARG_CURRENT_DEPTH],
            depth: c[ARG_DEPTH],
            draft: c[ARG_DRAFT],
            fallbackLocale: c[ARG_FALLBACK_LOCALE],
            field: plan.fields[i],
            locale: c[ARG_LOCALE],
            overrideAccess: c[ARG_OVERRIDE_ACCESS],
            parentIsLocalized: t.parentIsLocalized as boolean,
            populate: c[ARG_POPULATE],
            req: c[ARG_REQ],
            showHiddenFields: c[ARG_SHOW_HIDDEN_FIELDS],
            siblingDoc,
          }),
        )
      }
    }

    if (kind === ARRAY) {
      const field = plan.fields[i]
      const { path, schemaPath } = getFieldPaths({
        field,
        index: i,
        parentIndexPath: t.parentIndexPath,
        parentPath: t.parentPath,
        parentSchemaPath: t.parentSchemaPath,
      })
      const rows = siblingDoc[key]
      let arraySelect = t.select?.[key]
      if (t.selectMode === 'include' && typeof arraySelect === 'object') {
        arraySelect = {
          ...arraySelect,
          id: true,
        }
      }
      if (Array.isArray(rows) && rows.length > 0) {
        const parentIsLocalized = t.parentIsLocalized || field.localized
        const rowPlan = childPlan(c, plan, i, field, parentIsLocalized)
        const rowSelect = typeof arraySelect === 'object' ? arraySelect : undefined
        rows.forEach((row, rowIndex) => {
          traverse(
            c,
            rowPlan,
            trav(
              row || {},
              rowSelect,
              t.selectMode,
              t.blockData,
              t.fieldDepth + 1,
              parentIsLocalized,
              '',
              path + '.' + rowIndex,
              schemaPath,
            ),
          )
        })
      } else if (typeof rows === 'object' && rows !== null) {
        // `!shouldHoistLocalizedValue` holds for these kinds
        Object.values(rows).forEach((localeRows) => {
          if (Array.isArray(localeRows)) {
            localeRows.forEach((row, rowIndex) => {
              const parentIsLocalized = t.parentIsLocalized || field.localized
              traverse(
                c,
                childPlan(c, plan, i, field, parentIsLocalized),
                trav(
                  row || {},
                  undefined,
                  undefined,
                  t.blockData,
                  t.fieldDepth + 1,
                  parentIsLocalized,
                  '',
                  path + '.' + rowIndex,
                  schemaPath,
                ),
              )
            })
          }
        })
      } else if (!(flags & HIDDEN_IS_TRUE) || c[ARG_SHOW_HIDDEN_FIELDS] === true) {
        siblingDoc[key] = []
      }
    } else if (kind === GROUP) {
      const field = plan.fields[i]
      const { path, schemaPath } = getFieldPaths({
        field,
        index: i,
        parentIndexPath: t.parentIndexPath,
        parentPath: t.parentPath,
        parentSchemaPath: t.parentSchemaPath,
      })
      const groupSelect = typeof t.select?.[key] === 'object' ? t.select?.[key] : undefined
      // `shouldLocalizeField` is false for this kind
      const parentIsLocalized = t.parentIsLocalized || field.localized
      traverse(
        c,
        childPlan(c, plan, i, field, parentIsLocalized),
        trav(
          typeof siblingDoc[key] !== 'object' ? {} : siblingDoc[key],
          groupSelect,
          t.selectMode,
          t.blockData,
          t.fieldDepth + 1,
          parentIsLocalized,
          '',
          path,
          schemaPath,
        ),
      )
    } else if (kind === UNNAMED) {
      const field = plan.fields[i]
      const { indexPath, schemaPath } = getFieldPaths({
        field,
        index: i,
        parentIndexPath: t.parentIndexPath,
        parentPath: t.parentPath,
        parentSchemaPath: t.parentSchemaPath,
      })
      traverse(
        c,
        childPlan(c, plan, i, field, t.parentIsLocalized),
        trav(
          siblingDoc,
          t.select,
          t.selectMode,
          t.blockData,
          t.fieldDepth,
          t.parentIsLocalized,
          indexPath,
          t.parentPath,
          schemaPath,
        ),
      )
    }
  }

  return (c: any[], plan: AfterReadPlan, siblingDoc: any, select: any, selectMode: unknown) =>
    traverse(c, plan, trav(siblingDoc, select, selectMode, undefined, 0, false, '', '', ''))
}
