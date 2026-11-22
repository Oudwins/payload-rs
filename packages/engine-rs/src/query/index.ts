/**
 * TS side of the live query validation port (crates/payload-core-query `live`): loads
 * `coreQueryBinding()` from the engine addon (it shares the core runtime's executor and host),
 * installs the host helpers and exposes drop-ins with the upstream signatures of
 * `validateQueryPaths`, `validateSearchParam`, `validateSortQuery`, `sanitizeJoinQuery`,
 * `getLocalizedPaths`, `getFieldByPath`, `sanitizeWhereQuery`, `combineQueries` and
 * `prefixWherePaths`.
 *
 * Every helper is a Payload function the TS calls at that point or a TS expression copied
 * verbatim (destructuring patterns, loops, `find` callbacks, object literals), so property
 * reads, iterator steps and V8 error messages are the upstream ones. Payload internals are
 * imported by relative path: these are the module instances payload itself uses (and the ones a
 * `vi.mock` of them replaces).
 *
 * The read operations (`../ops`) install this host before their own binding.
 */

import { executeAccess } from '../../../payload/src/auth/executeAccess.js'
import { hasWhereAccessResult } from '../../../payload/src/auth/types.js'
import { isNestedRelationshipQuery } from '../../../payload/src/database/isNestedRelationshipQuery.js'
import { APIError } from '../../../payload/src/errors/APIError.js'
import { QueryError } from '../../../payload/src/errors/QueryError.js'
import {
  fieldAffectsData,
  fieldShouldBeLocalized,
} from '../../../payload/src/fields/config/types.js'
import { deepCopyObjectSimple } from '../../../payload/src/utilities/deepCopyObject.js'
import { getEntityPermissions } from '../../../payload/src/utilities/getEntityPermissions/getEntityPermissions.js'
import { isolateObjectProperty } from '../../../payload/src/utilities/isolateObjectProperty.js'
import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../addon.js'
import { getCoreRuntime } from '../runtime/index.js'

export type CoreQueryBinding = {
  combineQueries: (where: any, access: any) => any
  getFieldByPath: (args: any) => any
  getLocalizedPaths: (args: any) => any[]
  init: (host: Record<string, unknown>) => void
  prefixWherePaths: (args: any) => any
  sanitizeJoinQuery: (args: any) => Promise<any>
  sanitizeWhereQuery: (args: any) => void
  validateQueryPaths: (args: any) => Promise<void>
  validateSearchParam: (args: any) => Promise<void>
  validateSortQuery: (args: any) => Promise<void>
}

let binding: CoreQueryBinding | undefined

const reflectApply = Reflect.apply
// `await` uses the intrinsic PromiseResolve and PerformPromiseThen (see runtime/index.ts).
const promiseResolve = Promise.resolve.bind(Promise) as (value: unknown) => Promise<unknown>
const promiseThen = Promise.prototype.then

const DONE = Symbol('done')

export const getCoreQueryBinding = (): CoreQueryBinding => {
  if (binding) {
    return binding
  }
  const runtime = getCoreRuntime()
  // Must resolve to the same file as the core runtime so both bindings share one Rust instance.
  const addonPath = coreRuntimeAddonPath()
  const addon = loadCoreRuntimeAddon() as { coreQueryBinding?: () => CoreQueryBinding }
  if (typeof addon.coreQueryBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} does not export coreQueryBinding`)
  }
  const created = addon.coreQueryBinding()
  const resume = runtime.resume
  const awaitValue = (value: unknown, token: number) => {
    void reflectApply(promiseThen, promiseResolve(value), [
      (result: unknown) => resume(token, true, result),
      (error: unknown) => resume(token, false, error),
    ])
  }

  created.init({
    DONE,
    // `policies.collections![collectionSlug] = await getEntityPermissions({...})` (validateSearchParams.ts)
    awaitCollectionPermissions: (
      token: number,
      blockReferencesPermissions: unknown,
      req: any,
      collectionSlug: string,
    ) => {
      awaitValue(
        getEntityPermissions({
          blockReferencesPermissions: blockReferencesPermissions as any,
          entity: req.payload.collections[collectionSlug]!.config,
          entityType: 'collection',
          fetchData: false,
          operations: ['read'],
          req: isolateObjectProperty(req, 'transactionID'),
        }),
        token,
      )
    },
    // `await executeAccess({ slug, disableErrors: true, req }, access.read)` (sanitizeJoinQuery.ts)
    awaitExecuteAccess: (token: number, joinCollectionConfig: any, req: any) => {
      awaitValue(
        executeAccess(
          { slug: joinCollectionConfig.slug, disableErrors: true, req },
          joinCollectionConfig.access.read,
        ),
        token,
      )
    },
    // `policies.globals![slug] = await getEntityPermissions({...})` (validateSearchParams.ts)
    andOf: (and: unknown[]) => ({ and }),
    appendAnd: (existingAnd: any, accessWhere: unknown) => [...existingAnd, accessWhere],
    awaitGlobalPermissions: (
      token: number,
      blockReferencesPermissions: unknown,
      globalConfig: any,
      req: any,
    ) => {
      awaitValue(
        getEntityPermissions({
          blockReferencesPermissions: blockReferencesPermissions as any,
          entity: globalConfig,
          entityType: 'global',
          fetchData: false,
          operations: ['read'],
          req,
        }),
        token,
      )
    },
    // `function* () { for (const _block of lastIncompletePath.field.blocks) ... }` (getLocalizedPaths.ts)
    *blocksOf(field: any) {
      const lastIncompletePath = { field }
      for (const _block of lastIncompletePath.field.blocks) {
        yield _block
      }
    },
    collectionConfigOf: (req: any, slug: string) => req.payload.collections[slug]!.config,
    deepCopyObjectSimple: (value: any) => deepCopyObjectSimple(value),
    defaultPolicies: () => ({
      collections: {},
      globals: {},
    }),
    existsTrue: () => ({ exists: true }),
    fieldAffectsData,
    fieldByPathResult: (field: unknown, localizedPath: string, pathHasLocalized: boolean) => ({
      field,
      localizedPath,
      pathHasLocalized,
    }),
    fieldShouldBeLocalized: (field: any, parentIsLocalized: any) =>
      fieldShouldBeLocalized({ field, parentIsLocalized }),
    fieldsOf: (versionFields: any, globalConfig: any, collectionConfig: any) =>
      versionFields || (globalConfig || collectionConfig).flattenedFields,
    findBlock: (config: any, field: any, blockSlug: string) =>
      config?.blocks?.find((b: any) => b.slug === blockSlug) ??
      field.blocks.find((b: any) => typeof b !== 'string' && b.slug === blockSlug),
    findCollectionFlattenedFields: (config: any, field: any) =>
      config.collections.find((e: any) => e.slug === field.relationTo)?.flattenedFields,
    findCurrent: (currentFields: any, segment: string) =>
      currentFields.find((each: any) => each.name === segment),
    findFieldsToSearch: (fieldsToSearch: any, segment: string) =>
      fieldsToSearch.find((field: any) => field.name === segment),
    findInBlock: (block: any, segment: string) =>
      block.flattenedFields.find((field: any) => field.name === segment),
    *forIn(o: any) {
      for (const key in o) {
        yield key
      }
    },
    *forOf(v: any) {
      for (const item of v) {
        yield item
      }
    },
    getFieldByPathArgs: ({
      config,
      fields,
      includeRelationships = false,
      localizedPath = '',
      path,
    }: any) => [config, fields, includeRelationships, localizedPath, path],
    getLocalizedPathsArgs: ({
      collectionSlug,
      fields,
      globalSlug,
      incomingPath,
      locale,
      overrideAccess = false,
      parentIsLocalized,
      payload,
      showHiddenFields = false,
    }: any) => [
      collectionSlug,
      fields,
      globalSlug,
      incomingPath,
      locale,
      overrideAccess,
      parentIsLocalized,
      payload,
      showHiddenFields,
    ],
    hasWhereAccessResult,
    idField: (payload: any) => ({
      name: 'id',
      type: payload.db.defaultIDType,
    }),
    inOp: (key: string, obj: any) => key in obj,
    isArray: Array.isArray,
    isNestedRelationshipQuery,
    isPolymorphicJoin: (join: any) => Array.isArray(join.field.collection),
    *joinCollectionsOf(join: any) {
      for (const collectionSlug of join.field.collection) {
        yield collectionSlug
      }
    },
    // `const { joinPath } = join` (sanitizeJoinQuery.ts, sanitizeJoinFieldQuery)
    joinPathOf: (join: any) => {
      const { joinPath } = join
      return joinPath
    },
    *joinsOf(collectionConfig: any, collectionSlug: string) {
      for (const join of collectionConfig.joins[collectionSlug]!) {
        yield join
      }
    },
    joinSort: (joinQuery: any, join: any, joinCollectionConfig: any) =>
      joinQuery.sort || join.field.defaultSort || joinCollectionConfig.defaultSort,
    lengthGreaterThanZero: (errors: any) => errors.length > 0,
    localeCodesInclude: (localizationConfig: any, nextSegment: unknown) =>
      localizationConfig.localeCodes.includes(nextSegment),
    // The reads of the `getLocalizedPaths({...})` argument literal, in order.
    localizedPathsArgs: (collectionConfig: any, globalConfig: any, req: any) => [
      collectionConfig?.slug,
      globalConfig?.slug,
      req.locale!,
      req.payload,
    ],
    nestedWhere: (subPath: string, operator: string, val: unknown) => ({
      [subPath]: {
        [operator]: val,
      },
    }),
    newAPIError: (message: string) => new APIError(message),
    newQueryError: (errors: any) => new QueryError(errors),
    next: (generator: Generator<unknown>) => {
      const result = generator.next()
      return result.done ? DONE : result.value
    },
    noReadPermission: (fieldAccess: any) => !fieldAccess?.read?.permission,
    objectEntries: Object.entries,
    pathToQuery: (
      collectionSlug: unknown,
      complete: boolean,
      field: unknown,
      fields: unknown,
      globalSlug: unknown,
      invalid: boolean,
      parentIsLocalized: unknown,
      path: string,
    ) => ({
      collectionSlug,
      complete,
      field,
      fields,
      globalSlug,
      invalid,
      parentIsLocalized,
      path,
    }),
    *polymorphicJoinsOf(collectionConfig: any) {
      for (const join of collectionConfig.polymorphicJoins) {
        yield join
      }
    },
    prefixMap: (value: any[], prefix: string) =>
      value.map((nestedWhere) => created.prefixWherePaths({ prefix, where: nestedWhere })),
    prefixWherePathsArgs: ({ prefix, where }: any) => [prefix, where],
    pushPath: (errors: any, path: string) => errors.push({ path }),
    relationToField: (payload: any) => ({
      name: 'relationTo',
      type: 'select',
      options: Object.keys(payload.collections),
    }),
    // `incomingPath.replace(/__/g, '.')` (validateSearchParams.ts) for a non-string path
    replaceDunder: (incomingPath: any) => incomingPath.replace(/__/g, '.'),
    sanitizeJoinQueryArgs: ({ collectionConfig, joins: joinsQuery, overrideAccess, req }: any) => [
      collectionConfig,
      joinsQuery,
      overrideAccess,
      req,
    ],
    sanitizeWhereQueryArgs: ({ fields, payload, where }: any) => [fields, payload, where],
    scopedAnd: (
      existingAnd: any,
      relationshipPath: string,
      relatedFieldPath: string,
      operator: string,
      val: unknown,
      relatedCollectionReadPermission: any,
    ) => [
      ...existingAnd,
      {
        [relationshipPath]: {
          contains: {
            and: [
              {
                [relatedFieldPath]: {
                  [operator]: val,
                },
              },
              relatedCollectionReadPermission.where,
            ],
          },
        },
      },
    ],
    // `const { slug } = (collectionConfig || globalConfig)!`
    slugOf: (collectionConfig: any, globalConfig: any) => {
      const { slug } = collectionConfig || globalConfig
      return slug
    },
    someNested: (val: any) =>
      Array.isArray(val) && val.some((entry) => isNestedRelationshipQuery(entry)),
    sortFieldsOf: (sort: any) => (Array.isArray(sort) ? sort : [sort]),
    sortPath: (sortField: any) => sortField.replace(/^-/, '').replace(/__/g, '.'),
    splitPath: (path: any) => path.split('.'),
    str: (value: unknown) => `${value as string}`,
    // `path.endsWith(`.${req.locale}`) ? path.slice(0, -(req.locale!.length + 1)) : path`
    stripLocale: (path: string, req: any) => {
      let fieldPath = path
      if (path.endsWith(`.${req.locale}`)) {
        fieldPath = path.slice(0, -(req.locale!.length + 1))
      }
      return fieldPath
    },
    textField: (name: string) => ({
      name,
      type: 'text',
    }),
    validateQueryPathsArgs: ({
      collectionConfig,
      errors = [],
      globalConfig,
      overrideAccess,
      policies = {
        collections: {},
        globals: {},
      },
      polymorphicJoin,
      req,
      showHiddenFields,
      versionFields,
      where,
    }: any) => [
      collectionConfig,
      errors,
      globalConfig,
      overrideAccess,
      policies,
      polymorphicJoin,
      req,
      showHiddenFields,
      versionFields,
      where,
    ],
    validateSearchParamArgs: ({
      collectionConfig,
      constraint,
      errors,
      fields,
      globalConfig,
      operator,
      overrideAccess,
      parentIsLocalized,
      path: incomingPath,
      policies,
      polymorphicJoin,
      req,
      showHiddenFields,
      val,
      versionFields,
    }: any) => [
      collectionConfig,
      constraint,
      errors,
      fields,
      globalConfig,
      operator,
      overrideAccess,
      parentIsLocalized,
      incomingPath,
      policies,
      polymorphicJoin,
      req,
      showHiddenFields,
      val,
      versionFields,
    ],
    validateSortQueryArgs: ({
      collectionConfig,
      globalConfig,
      overrideAccess,
      req,
      sort,
      versionFields,
    }: any) => [collectionConfig, globalConfig, overrideAccess, req, sort, versionFields],
  })
  binding = created
  return created
}

export const validateQueryPaths = (args: any): Promise<void> =>
  getCoreQueryBinding().validateQueryPaths(args)
export const validateSearchParam = (args: any): Promise<void> =>
  getCoreQueryBinding().validateSearchParam(args)
export const validateSortQuery = (args: any): Promise<void> =>
  getCoreQueryBinding().validateSortQuery(args)
export const sanitizeJoinQuery = (args: any): Promise<any> =>
  getCoreQueryBinding().sanitizeJoinQuery(args)
export const getLocalizedPaths = (args: any): any[] => getCoreQueryBinding().getLocalizedPaths(args)
export const getFieldByPath = (args: any): any => getCoreQueryBinding().getFieldByPath(args)
export const sanitizeWhereQuery = (args: any): void =>
  getCoreQueryBinding().sanitizeWhereQuery(args)
export const combineQueries = (where: any, access: any): any =>
  getCoreQueryBinding().combineQueries(where, access)
export const prefixWherePaths = (args: any): any => getCoreQueryBinding().prefixWherePaths(args)
