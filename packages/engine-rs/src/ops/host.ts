/**
 * JS helpers of the Rust collection operations (crates/payload-core-ops, looked up by name from
 * `crates/payload-core-ops/src/*.rs`). Each helper is one TS expression or statement of the
 * upstream operation, evaluated at the point where the operation evaluates it:
 *
 * - object literals handed to user code, adapters or upstream utilities (same key order, same
 *   property-read order),
 * - destructuring patterns of the operations (same defaults, getter order and V8 errors),
 * - upstream utilities that are called rather than ported (query/select/join validation and
 *   sanitization, error classes, `replaceWithDraftIfAvailable`, `checkFileAccess`, ...),
 * - synchronous segments without user callbacks (`docs.map` spreads, lock-status filtering).
 *
 * Control flow (hooks, access, awaits, branches) stays in Rust. Payload internals are imported
 * by relative path, like `../runtime`: engine-rs has no installed `payload` link.
 */
import type { SanitizedCollectionConfig } from '../../../payload/src/collections/config/types.js'
import type { FlattenedField } from '../../../payload/src/fields/config/types.js'

import { prefetchVersionForInheritedReadAccess } from '../../../payload/src/collections/operations/utilities/prefetchVersionForInheritedReadAccess.js'
import { combineQueries } from '../../../payload/src/database/combineQueries.js'
import { getLocalizedPaths } from '../../../payload/src/database/getLocalizedPaths.js'
import { prefixWherePaths } from '../../../payload/src/database/prefixWherePaths.js'
import { validateQueryPaths } from '../../../payload/src/database/queryValidation/validateQueryPaths.js'
import { validateSortQuery } from '../../../payload/src/database/queryValidation/validateSortQuery.js'
import { sanitizeJoinQuery } from '../../../payload/src/database/sanitizeJoinQuery.js'
import { sanitizeWhereQuery } from '../../../payload/src/database/sanitizeWhereQuery.js'
import { APIError } from '../../../payload/src/errors/APIError.js'
import { Forbidden } from '../../../payload/src/errors/Forbidden.js'
import { NotFound } from '../../../payload/src/errors/NotFound.js'
import { QueryError } from '../../../payload/src/errors/QueryError.js'
import { relationshipPopulationPromise } from '../../../payload/src/fields/hooks/afterRead/relationshipPopulationPromise.js'
import { lockedDocumentsCollectionSlug } from '../../../payload/src/locked-documents/config.js'
import { checkFileAccess } from '../../../payload/src/uploads/checkFileAccess.js'
import { markHistoricalFileURLs } from '../../../payload/src/uploads/fileVersioning/markHistoricalFileURLs.js'
import { appendNonTrashedFilter } from '../../../payload/src/utilities/appendNonTrashedFilter.js'
import { getEntityPermissions } from '../../../payload/src/utilities/getEntityPermissions/getEntityPermissions.js'
import { getFieldByPath } from '../../../payload/src/utilities/getFieldByPath.js'
import { getSelectMode } from '../../../payload/src/utilities/getSelectMode.js'
import { httpStatus } from '../../../payload/src/utilities/httpStatus.js'
import { resolveSelect } from '../../../payload/src/utilities/resolveSelect.js'
import { sanitizeInternalFields } from '../../../payload/src/utilities/sanitizeInternalFields.js'
import { sanitizePermissions } from '../../../payload/src/utilities/sanitizePermissions.js'
import { sanitizeSelect } from '../../../payload/src/utilities/sanitizeSelect.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { appendVersionToQueryKey } from '../../../payload/src/versions/drafts/appendVersionToQueryKey.js'
import { getQueryDraftsSelect } from '../../../payload/src/versions/drafts/getQueryDraftsSelect.js'
import { getQueryDraftsSort } from '../../../payload/src/versions/drafts/getQueryDraftsSort.js'
import { replaceWithDraftIfAvailable } from '../../../payload/src/versions/drafts/replaceWithDraftIfAvailable.js'
import {
  isInheritedReadVersionsAccess,
  withInheritedReadVersionsParentID,
} from '../../../payload/src/versions/isInheritedReadVersionsAccess.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the helpers mirror untyped TS expressions */
type Any = any

const lockDurationDefault = 300 // Default 5 minutes in seconds (find.ts / findByID.ts)

const allOperations = ['create', 'read', 'update', 'delete', 'validate']

/** `sanitizeSort` of sanitizeSortQuery.ts (private there); the engine handles string sorts. */
const sanitizeSortValue = (fields: FlattenedField[], sort: Any): string => {
  let sortProperty = sort
  let desc = false
  if (sort.indexOf('-') === 0) {
    desc = true
    sortProperty = sortProperty.substring(1)
  }

  const segments = sortProperty.split('.')

  for (const segment of segments) {
    const field: Any = fields.find((each) => each.name === segment)
    if (!field) {
      return sort
    }

    if ('fields' in field) {
      fields = field.flattenedFields
      continue
    }

    if ('virtual' in field && typeof field.virtual === 'string') {
      return `${desc ? '-' : ''}${field.virtual}`
    }
  }

  return sort
}

export const createOpsHost = (
  afterRead?: (args: Any) => Promise<unknown>,
): Record<string, unknown> => ({
  afterRead,

  // ---------------------------------------------------------------- generic JS semantics
  /** V8's `TypeError` for calling a non-callable `expr(...)`. */
  notAFunction: (expr: string) => new TypeError(`${expr} is not a function`),
  /** `for (const x of v)` over a non-array: collects (or throws V8's not-iterable error). */
  spreadIterable: (v: Any) => [...v],
  /** The error `docs.map(...)` throws for a non-array `docs` (`expr` is its source text). */
  mapGuard: (docs: Any, expr: string) => {
    if (docs === null || docs === undefined) {
      return new TypeError(`Cannot read properties of ${docs} (reading 'map')`)
    }
    if (typeof docs.map === 'function') {
      return new Error(`core ops: ${expr} is not an array (unsupported)`)
    }
    return new TypeError(`${expr}.map is not a function`)
  },
  /** `name in o` for a primitive `o` (throws V8's TypeError). */
  hasIn: (o: Any, name: string) => name in o,
  lessThan: (a: Any, b: Any) => a < b,
  now: () => new Date().getTime(),

  // ---------------------------------------------------------------- errors
  distinctFieldNotFound: (field: Any, slug: Any) =>
    new APIError(`Field ${field} was not found in the collection ${slug}`, httpStatus.BAD_REQUEST),
  distinctVirtualNotLinked: () =>
    new APIError(
      `Cannot findDistinct by a virtual field that isn't linked to a relationship field.`,
    ),
  forbidden: (t: Any) => new Forbidden(t),
  missingVersionID: () => new APIError('Missing ID of version.', httpStatus.BAD_REQUEST),
  notFound: (t: Any) => new NotFound(t),
  queryError: (field: Any) => new QueryError([{ path: field }]),

  // ---------------------------------------------------------------- executeAccess / hooks
  accessArgs: (id: Any, slug: Any, data: Any, isReadingStaticFile: Any, req: Any) => ({
    id,
    slug,
    data,
    isReadingStaticFile,
    req,
  }),
  afterOperationArgs: (
    args: Any,
    collection: Any,
    operation: Any,
    overrideAccess: Any,
    req: Any,
    result: Any,
  ) => ({ args, collection, operation, overrideAccess, req, result }),
  beforeOperationArgs: (
    args: Any,
    collection: Any,
    context: Any,
    operation: Any,
    overrideAccess: Any,
    req: Any,
  ) => ({ args, collection, context, operation, overrideAccess, req }),
  executeAccessArgs: ({ id, slug, data, disableErrors, isReadingStaticFile = false, req }: Any) => [
    id,
    slug,
    data,
    disableErrors,
    isReadingStaticFile,
    req,
  ],
  readHookArgs: (
    collection: Any,
    context: Any,
    doc: Any,
    overrideAccess: Any,
    query: Any,
    req: Any,
  ) => ({
    collection,
    context,
    doc,
    overrideAccess,
    query,
    req,
  }),
  readManyHookArgs: (
    collection: Any,
    context: Any,
    doc: Any,
    overrideAccess: Any,
    query: Any,
    req: Any,
  ) => ({ collection, context, doc, findMany: true, overrideAccess, query, req }),

  // ---------------------------------------------------------------- sanitizeSortQuery
  findByName: (fields: Any, segment: string) => fields.find((each: Any) => each.name === segment),
  prefixSort: (desc: boolean, virtualPath: string) => `${desc ? '-' : ''}${virtualPath}`,
  sanitizeSortValue,

  // ---------------------------------------------------------------- query / select utilities
  appendNonTrashedFilter: (enableTrash: Any, trash: Any, where: Any) =>
    appendNonTrashedFilter({ enableTrash, trash, where }),
  appendNonTrashedVersionFilter: (enableTrash: Any, trash: Any, where: Any) =>
    appendNonTrashedFilter({ deletedAtPath: 'version.deletedAt', enableTrash, trash, where }),
  appendVersionToQueryKey: (where: Any) => appendVersionToQueryKey(where),
  combineQueries: (where: Any, access: Any) => combineQueries(where, access),
  getSelectMode: (select: Any) => getSelectMode(select),
  idWhere: (id: Any) => ({ id: { equals: id } }),
  prefixWherePaths: (prefix: Any, where: Any) => prefixWherePaths({ prefix, where }),
  sanitizeWhereQuery: (fields: Any, payload: Any, where: Any) => {
    sanitizeWhereQuery({ fields, payload, where })
  },
  selectRead: (collectionConfig: Any, req: Any, incomingSelect: Any) =>
    sanitizeSelect({
      fields: collectionConfig.flattenedFields,
      select: resolveSelect({
        config: collectionConfig.select,
        operation: 'read',
        req,
        select: incomingSelect,
      }),
    }),
  selectVersions: (versionFields: Any, collectionConfig: Any, req: Any, incomingSelect: Any) =>
    sanitizeSelect({
      fields: versionFields,
      select: resolveSelect({
        config: collectionConfig.select,
        operation: 'read',
        req,
        select: incomingSelect,
      }),
      versions: true,
    }),
  validateQueryPaths: (collectionConfig: Any, overrideAccess: Any, req: Any, where: Any) =>
    validateQueryPaths({ collectionConfig, overrideAccess, req, where }),
  validateQueryPathsOrEmpty: (collectionConfig: Any, overrideAccess: Any, req: Any, where: Any) =>
    validateQueryPaths({ collectionConfig, overrideAccess, req, where: where ?? {} }),
  validateQueryPathsVersions: (
    collectionConfig: Any,
    overrideAccess: Any,
    req: Any,
    versionFields: Any,
    where: Any,
  ) => validateQueryPaths({ collectionConfig, overrideAccess, req, versionFields, where }),
  versionFields: (payload: Any, collectionConfig: Any) =>
    buildVersionCollectionFields(payload.config, collectionConfig, true),
  /** find.ts drafts branch (`collection.config` and `payload.config` read in the literal). */
  validateQueryPathsCollectionDrafts: (
    collection: Any,
    overrideAccess: Any,
    req: Any,
    payload: Any,
    where: Any,
  ) =>
    validateQueryPaths({
      collectionConfig: collection.config,
      overrideAccess,
      req,
      versionFields: buildVersionCollectionFields(payload.config, collection.config, true),
      where: appendVersionToQueryKey(where),
    }),
  /** findByID.ts drafts branch. */
  sanitizeJoinQuery: (collectionConfig: Any, joins: Any, overrideAccess: Any, req: Any) =>
    sanitizeJoinQuery({ collectionConfig, joins, overrideAccess, req }),
  validateQueryPathsByIDDrafts: (
    collectionConfig: Any,
    overrideAccess: Any,
    req: Any,
    where: Any,
  ) =>
    validateQueryPaths({
      collectionConfig,
      overrideAccess,
      req,
      versionFields: buildVersionCollectionFields(req.payload.config, collectionConfig, true),
      where: appendVersionToQueryKey(where),
    }),
  validateSortQuery: (collectionConfig: Any, overrideAccess: Any, req: Any, sort: Any) =>
    validateSortQuery({ collectionConfig, overrideAccess, req, sort }),
  validateSortQueryVersions: (
    collectionConfig: Any,
    overrideAccess: Any,
    req: Any,
    sort: Any,
    versionFields: Any,
  ) => validateSortQuery({ collectionConfig, overrideAccess, req, sort, versionFields }),

  // ---------------------------------------------------------------- find
  authDocs: (result: Any, collectionConfig: Any) => {
    result.docs = result.docs.map((doc: Any) => ({ ...doc, collection: collectionConfig.slug }))
  },
  emptyFindResult: (limit: Any) => ({
    docs: [],
    hasNextPage: false,
    hasPrevPage: false,
    limit: limit!,
    nextPage: null,
    page: 1,
    pagingCounter: 1,
    prevPage: null,
    totalDocs: 0,
    totalPages: 1,
  }),
  findAfterReadArgs: (
    collectionConfig: Any,
    req: Any,
    currentDepth: Any,
    depth: Any,
    doc: Any,
    draftsEnabled: Any,
    fallbackLocale: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) => ({
    collection: collectionConfig,
    context: req.context,
    currentDepth,
    depth: depth!,
    doc,
    draft: draftsEnabled!,
    fallbackLocale: fallbackLocale!,
    findMany: true,
    global: null,
    locale: locale!,
    overrideAccess: overrideAccess!,
    populate,
    req,
    select,
    showHiddenFields: showHiddenFields!,
  }),
  findArgs: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      collection,
      currentDepth,
      depth,
      disableErrors,
      draft: draftsEnabled,
      includeLockStatus: includeLockStatusFromArgs,
      joins,
      limit,
      overrideAccess,
      page,
      pagination = true,
      populate,
      select: incomingSelect,
      showHiddenFields,
      sort: incomingSort,
      trash = false,
      where,
    } = args
    return [
      collectionConfig,
      collection,
      currentDepth,
      depth,
      disableErrors,
      draftsEnabled,
      includeLockStatusFromArgs,
      joins,
      limit,
      overrideAccess,
      page,
      pagination,
      populate,
      incomingSelect,
      showHiddenFields,
      incomingSort,
      trash,
      where,
    ]
  },
  findDbArgs: (
    collectionConfig: Any,
    draftsEnabled: Any,
    req: Any,
    sanitizedJoins: Any,
    sanitizedLimit: Any,
    locale: Any,
    sanitizedPage: Any,
    pagination: Any,
    select: Any,
    sort: Any,
    fullWhere: Any,
  ) => ({
    collection: collectionConfig.slug,
    draftsEnabled,
    joins: req.payloadAPI === 'GraphQL' ? false : sanitizedJoins,
    limit: sanitizedLimit,
    locale: locale!,
    page: sanitizedPage,
    pagination,
    req,
    select,
    sort,
    where: fullWhere,
  }),
  findLockApply: (
    lockedDocuments: Any,
    result: Any,
    now: number,
    lockDurationInMilliseconds: number,
  ) => {
    const lockedDocs = Array.isArray(lockedDocuments?.docs) ? lockedDocuments.docs : []

    // Filter out stale locks
    const validLockedDocs = lockedDocs.filter((lock: Any) => {
      const lastEditedAt = new Date(lock?.updatedAt).getTime()
      return lastEditedAt + lockDurationInMilliseconds > now
    })

    for (const doc of result.docs) {
      const lockedDoc = validLockedDocs.find((lock: Any) => lock?.document?.value === doc.id)
      doc._isLocked = !!lockedDoc
      doc._userEditing = lockedDoc ? lockedDoc?.user?.value : null
    }
  },
  findLockArgs: (
    collectionConfig: Any,
    sanitizedLimit: Any,
    req: Any,
    result: Any,
    now: number,
    lockDurationInMilliseconds: number,
  ) => ({
    collection: lockedDocumentsCollectionSlug,
    depth: 1,
    limit: sanitizedLimit,
    overrideAccess: false,
    pagination: false,
    req,
    where: {
      and: [
        {
          'document.relationTo': {
            equals: collectionConfig.slug,
          },
        },
        {
          'document.value': {
            in: result.docs.map((doc: Any) => doc.id),
          },
        },
        // Query where the lock is newer than the current time minus lock time
        {
          updatedAt: {
            greater_than: new Date(now - lockDurationInMilliseconds),
          },
        },
      ],
    },
  }),
  findLockReset: (result: Any) => {
    for (const doc of result.docs) {
      doc._isLocked = false
      doc._userEditing = null
    }
  },
  findQueryDraftsArgs: (
    collectionConfig: Any,
    req: Any,
    sanitizedJoins: Any,
    sanitizedLimit: Any,
    locale: Any,
    sanitizedPage: Any,
    usePagination: Any,
    select: Any,
    sort: Any,
    fullWhere: Any,
  ) => ({
    collection: collectionConfig.slug,
    joins: req.payloadAPI === 'GraphQL' ? false : sanitizedJoins,
    limit: sanitizedLimit,
    locale: locale!,
    page: sanitizedPage,
    pagination: usePagination,
    req,
    select: getQueryDraftsSelect({ select }),
    sort: getQueryDraftsSort({
      collectionConfig,
      sort,
    }),
    where: fullWhere,
  }),
  lockDurationMs: (collectionConfig: Any) => {
    const lockDocumentsProp = collectionConfig?.lockDocuments

    const lockDuration =
      typeof lockDocumentsProp === 'object' ? lockDocumentsProp.duration : lockDurationDefault
    return lockDuration * 1000
  },

  // ---------------------------------------------------------------- findByID
  applyLockStatus: (result: Any, lockStatus: Any) => {
    result._isLocked = !!lockStatus
    result._userEditing = lockStatus?.user?.value ?? null
  },
  existingVersionsArgs: (collectionConfig: Any, locale: Any, req: Any, where: Any) => ({
    collection: collectionConfig.slug,
    limit: 1,
    locale: locale!,
    pagination: false,
    req,
    select: { parent: true },
    where: appendVersionToQueryKey(where),
  }),
  findByIDAfterReadArgs: (
    collectionConfig: Any,
    req: Any,
    currentDepth: Any,
    depth: Any,
    doc: Any,
    replaceWithVersion: Any,
    fallbackLocale: Any,
    flattenLocales: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) => ({
    collection: collectionConfig,
    context: req.context,
    currentDepth,
    depth: depth!,
    doc,
    draft: replaceWithVersion,
    fallbackLocale: fallbackLocale!,
    flattenLocales,
    global: null,
    locale: locale!,
    overrideAccess,
    populate,
    req,
    select,
    showHiddenFields: showHiddenFields!,
  }),
  findByIDArgs: (args: Any) => {
    const {
      id,
      collection: { config: collectionConfig },
      currentDepth,
      depth,
      disableErrors,
      draft: replaceWithVersion = false,
      flattenLocales,
      includeLockStatus: includeLockStatusFromArgs,
      joins,
      overrideAccess = false,
      populate,
      req: { fallbackLocale, locale, t },
      req,
      select: incomingSelect,
      showHiddenFields,
      trash = false,
    } = args
    return [
      id,
      collectionConfig,
      currentDepth,
      depth,
      disableErrors,
      replaceWithVersion,
      flattenLocales,
      includeLockStatusFromArgs,
      joins,
      overrideAccess,
      populate,
      fallbackLocale,
      locale,
      t,
      req,
      incomingSelect,
      showHiddenFields,
      trash,
    ]
  },
  findByIDLockArgs: (
    collectionConfig: Any,
    id: Any,
    req: Any,
    lockDurationInMilliseconds: number,
  ) => ({
    collection: lockedDocumentsCollectionSlug,
    depth: 1,
    limit: 1,
    overrideAccess: false,
    pagination: false,
    req,
    where: {
      and: [
        {
          'document.relationTo': {
            equals: collectionConfig.slug,
          },
        },
        {
          'document.value': {
            equals: id,
          },
        },
        // Query where the lock is newer than the current time minus lock time
        {
          updatedAt: {
            greater_than: new Date(new Date().getTime() - lockDurationInMilliseconds),
          },
        },
      ],
    },
  }),
  findByIDQueryDraftsArgs: (
    collectionConfig: Any,
    req: Any,
    sanitizedJoins: Any,
    locale: Any,
    select: Any,
    query: Any,
  ) => ({
    collection: collectionConfig.slug,
    joins: req.payloadAPI === 'GraphQL' ? false : sanitizedJoins,
    limit: 1,
    locale: locale!,
    pagination: false,
    req,
    select: getQueryDraftsSelect({ select }),
    where: query,
  }),
  findOneArgs: (
    collectionConfig: Any,
    replaceWithVersion: Any,
    req: Any,
    sanitizedJoins: Any,
    locale: Any,
    dbSelect: Any,
    fullWhere: Any,
  ) => ({
    collection: collectionConfig.slug,
    draftsEnabled: replaceWithVersion,
    joins: req.payloadAPI === 'GraphQL' ? false : sanitizedJoins,
    locale: locale!,
    req: {
      transactionID: req.transactionID,
    },
    select: dbSelect,
    where: fullWhere,
  }),
  lockStatusOf: (lockedDocument: Any) => {
    let lockStatus = null
    if (lockedDocument && lockedDocument.docs.length > 0) {
      lockStatus = lockedDocument.docs[0]!
    }
    return lockStatus
  },
  replaceWithDraftIfAvailable: (
    accessResult: Any,
    doc: Any,
    entity: Any,
    overrideAccess: Any,
    req: Any,
    select: Any,
  ) =>
    replaceWithDraftIfAvailable({
      accessResult,
      doc,
      entity,
      entityType: 'collection',
      overrideAccess,
      req,
      select,
    }),
  selectWithTimestamps: (select: Any) => ({ ...select, createdAt: true, updatedAt: true }),
  spreadCollection: (result: Any, collectionConfig: Any) => ({
    ...result,
    collection: collectionConfig.slug,
  }),

  // ---------------------------------------------------------------- count / countVersions
  countArgs: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      disableErrors,
      overrideAccess,
      req,
      trash = false,
      where,
    } = args
    return [collectionConfig, disableErrors, overrideAccess, req, trash, where]
  },
  countDbArgs: (collectionConfig: Any, req: Any, fullWhere: Any) => ({
    collection: collectionConfig.slug,
    locale: req?.locale || undefined,
    req,
    where: fullWhere,
  }),
  countVersionsArgs: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      disableErrors,
      overrideAccess,
      req,
      where,
    } = args
    return [collectionConfig, disableErrors, overrideAccess, req, where]
  },
  countVersionsDbArgs: (collectionConfig: Any, locale: Any, req: Any, fullWhere: Any) => ({
    collection: collectionConfig.slug,
    locale: locale!,
    req,
    where: fullWhere,
  }),
  emptyCountResult: () => ({
    totalDocs: 0,
  }),

  // ---------------------------------------------------------------- findDistinct
  distinctFieldByPath: (payload: Any, collectionConfig: Any, args: Any) =>
    getFieldByPath({
      config: payload.config,
      fields: collectionConfig.flattenedFields,
      includeRelationships: true,
      path: args.field,
    }),
  distinctLocalizedPaths: (collectionConfig: Any, args: Any, req: Any, payload: Any) =>
    getLocalizedPaths({
      collectionSlug: collectionConfig.slug,
      fields: collectionConfig.flattenedFields,
      incomingPath: args.field,
      locale: req.locale!,
      overrideAccess: true,
      payload,
    }),
  distinctTrimIDPath: (paths: Any) => {
    if (paths.at(-1)?.path === 'id') {
      const previousField = paths.at(-2)?.field
      if (
        previousField &&
        (previousField.type === 'relationship' || previousField.type === 'upload') &&
        typeof previousField.relationTo === 'string'
      ) {
        paths.pop()
      }
    }
  },
  distinctVirtualPath: (collectionConfig: Any, fieldResult: Any) => {
    let relationPath: string = ''
    let currentFields: FlattenedField[] = collectionConfig.flattenedFields
    const fieldPathSegments = fieldResult.field.virtual.split('.')
    for (const segment of fieldResult.field.virtual.split('.')) {
      relationPath = `${relationPath}${segment}`
      fieldPathSegments.shift()
      const field: Any = currentFields.find((e) => e.name === segment)!
      if (
        (field.type === 'relationship' || field.type === 'upload') &&
        typeof field.relationTo === 'string'
      ) {
        break
      }
      if ('flattenedFields' in field) {
        currentFields = field.flattenedFields
      }
    }

    return `${relationPath}.${fieldPathSegments.join('.')}`
  },
  emptyDistinctResult: (limit: Any) => ({
    hasNextPage: false,
    hasPrevPage: false,
    limit: limit || 0,
    nextPage: null,
    page: 1,
    pagingCounter: 1,
    prevPage: null,
    totalDocs: 0,
    totalPages: 0,
    values: [],
  }),
  fieldReadAccessArgs: (collectionConfig: Any, req: Any) => ({
    collection: collectionConfig,
    req,
  }),
  findDistinctArgs: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      disableErrors,
      overrideAccess,
      populate,
      showHiddenFields = false,
      trash = false,
      where,
    } = args
    return [
      collectionConfig,
      disableErrors,
      overrideAccess,
      populate,
      showHiddenFields,
      trash,
      where,
    ]
  },
  findDistinctDbArgs: (
    collectionConfig: Any,
    args: Any,
    locale: Any,
    relatedAccessByPath: Any,
    req: Any,
    fullWhere: Any,
  ) => ({
    collection: collectionConfig.slug,
    field: args.field,
    limit: args.limit,
    locale: locale!,
    page: args.page,
    relatedAccess: relatedAccessByPath,
    req,
    sort: args.sort,
    where: fullWhere,
  }),
  relationshipPath: (paths: Any, pathIndex: number) =>
    paths
      .slice(0, pathIndex)
      .map(({ path }: Any) => path)
      .join('.'),
  renameDistinctValues: (result: Any, args: Any, path: Any) => {
    for (const val of result.values) {
      val[args.field] = val[path]
      delete val[path]
    }
  },
  validateQueryPathsDistinctField: (
    collectionConfig: Any,
    req: Any,
    showHiddenFields: Any,
    args: Any,
  ) =>
    validateQueryPaths({
      collectionConfig,
      overrideAccess: false,
      req,
      showHiddenFields,
      where: {
        [args.field]: {
          exists: true,
        },
      },
    }),
  virtualFindDistinctArgs: (
    collectionConfig: Any,
    args: Any,
    disableErrors: Any,
    path: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    req: Any,
    showHiddenFields: Any,
    trash: Any,
    where: Any,
  ) => ({
    collection: collectionConfig.slug,
    depth: args.depth,
    disableErrors,
    field: path,
    limit: args.limit,
    locale,
    overrideAccess,
    page: args.page,
    populate,
    req,
    showHiddenFields,
    sort: args.sort,
    trash,
    where,
  }),
  /** The population loop of findDistinct.ts up to `Promise.all(populationPromises)`. */
  distinctPopulate: (fieldResult: Any, result: Any, args: Any, populate: Any, req: Any) => {
    const populationPromises: Promise<void>[] = []
    const sanitizedField = { ...fieldResult.field }
    if (fieldResult.field.hasMany) {
      sanitizedField.hasMany = false
    }
    for (const doc of result.values) {
      populationPromises.push(
        relationshipPopulationPromise({
          currentDepth: 0,
          depth: args.depth,
          draft: false,
          fallbackLocale: req.fallbackLocale || null,
          field: sanitizedField,
          locale: req.locale || null,
          overrideAccess: args.overrideAccess ?? false,
          parentIsLocalized: false,
          populate,
          req,
          showHiddenFields: false,
          siblingDoc: doc,
        }),
      )
    }
    return Promise.all(populationPromises)
  },

  // ---------------------------------------------------------------- findVersions / findVersionByID
  findVersionsArgs: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      depth,
      limit,
      overrideAccess,
      page,
      pagination = true,
      populate,
      select: incomingSelect,
      showHiddenFields,
      sort,
      trash = false,
      where,
    } = args
    return [
      collectionConfig,
      depth,
      limit,
      overrideAccess,
      page,
      pagination,
      populate,
      incomingSelect,
      showHiddenFields,
      sort,
      trash,
      where,
    ]
  },
  findVersionsDbArgs: (
    collectionConfig: Any,
    sanitizedLimit: Any,
    locale: Any,
    sanitizedPage: Any,
    pagination: Any,
    req: Any,
    select: Any,
    sort: Any,
    fullWhere: Any,
  ) => ({
    collection: collectionConfig.slug,
    limit: sanitizedLimit,
    locale: locale!,
    page: sanitizedPage,
    pagination,
    req,
    select,
    sort,
    where: fullWhere,
  }),
  /** `checkFileAccess` of a version row (findVersions.ts loop / findVersionByID.ts). */
  checkFileAccessVersion: (args: Any, row: Any, req: Any) => {
    const filename = (row.version as Record<string, unknown>)?.filename

    return checkFileAccess({
      collection: args.collection,
      documentID: row.parent,
      filename: typeof filename === 'string' ? filename : '',
      req,
    })
  },
  findVersionByIDArgs: (args: Any) => {
    const {
      id,
      collection: { config: collectionConfig },
      currentDepth,
      depth,
      disableErrors,
      overrideAccess,
      populate,
      req: { fallbackLocale, locale, payload },
      req,
      select: incomingSelect,
      showHiddenFields,
      trash = false,
    } = args
    return [
      id,
      collectionConfig,
      currentDepth,
      depth,
      disableErrors,
      overrideAccess,
      populate,
      fallbackLocale,
      locale,
      payload,
      req,
      incomingSelect,
      showHiddenFields,
      trash,
    ]
  },
  findVersionsAfterReadArgs: (
    collectionConfig: Any,
    req: Any,
    depth: Any,
    data: Any,
    fallbackLocale: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) => ({
    collection: collectionConfig,
    context: req.context,
    depth: depth!,
    doc: data.version,
    draft: undefined,
    fallbackLocale: fallbackLocale!,
    findMany: true,
    global: null,
    locale: locale!,
    overrideAccess: overrideAccess!,
    populate,
    req,
    select: typeof select?.version === 'object' ? select.version : undefined,
    showHiddenFields: showHiddenFields!,
  }),
  isInheritedReadVersionsAccess: (access: Any) => isInheritedReadVersionsAccess(access),
  markHistoricalVersions: (result: Any, collectionConfig: Any, req: Any) => {
    result.docs = result.docs.map((row: Any) => ({
      ...row,
      version: markHistoricalFileURLs({
        collectionSlug: collectionConfig.slug,
        doc: row.version,
        req,
        versionID: row.id,
      }),
    }))
  },
  prefetchVersion: (
    id: Any,
    collectionConfig: Any,
    locale: Any,
    req: Any,
    select: Any,
    trash: Any,
  ) =>
    prefetchVersionForInheritedReadAccess({
      id,
      collectionConfig,
      locale: locale!,
      req,
      select,
      trash,
    }),
  sanitizeInternalDocs: (result: Any) => {
    result.docs = result.docs.map((doc: Any) => sanitizeInternalFields(doc))
  },
  /** The access function findVersionByID.ts passes for inherited `readVersions` access. */
  findVersionByIDAfterReadArgs: (
    collectionConfig: Any,
    req: Any,
    currentDepth: Any,
    depth: Any,
    result: Any,
    fallbackLocale: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) => ({
    collection: collectionConfig,
    context: req.context,
    currentDepth,
    depth: depth!,
    doc: result.version,
    draft: undefined,
    fallbackLocale: fallbackLocale!,
    global: null,
    locale: locale!,
    overrideAccess: overrideAccess!,
    populate,
    req,
    select: typeof select?.version === 'object' ? select.version : undefined,
    showHiddenFields: showHiddenFields!,
  }),
  findVersionByIDDbArgs: (
    collectionConfig: Any,
    locale: Any,
    req: Any,
    select: Any,
    fullWhere: Any,
  ) => ({
    collection: collectionConfig.slug,
    limit: 1,
    locale: locale!,
    pagination: false,
    req,
    select,
    where: fullWhere,
  }),
  inheritedReadVersionsAccess:
    (collectionConfig: SanitizedCollectionConfig, prefetched: Any) => (accessArgs: Any) =>
      collectionConfig.access.readVersions!(
        withInheritedReadVersionsParentID(accessArgs, prefetched?.parentID),
      ),
  markHistoricalVersion: (result: Any, collectionConfig: Any, req: Any) => {
    result.version = markHistoricalFileURLs({
      collectionSlug: collectionConfig.slug,
      doc: result.version,
      req,
      versionID: result.id,
    })
  },

  // ---------------------------------------------------------------- docAccess
  allOperations: () => [...allOperations],
  docAccessArgs: (args: Any) => {
    const {
      id,
      collection: { config },
      data,
      req,
    } = args
    return [id, config, data, req]
  },
  emptyPermissions: () => ({ fields: {} }),
  getEntityPermissions: (id: Any, data: Any, config: Any, collectionOperations: Any, req: Any) =>
    getEntityPermissions({
      id: id!,
      blockReferencesPermissions: {},
      data,
      entity: config,
      entityType: 'collection',
      fetchData: id ? true : (false as true),
      operations: collectionOperations,
      req,
    }),
  pushOperation: (operations: Any[], operation: string) => {
    operations.push(operation)
  },
  sanitizeCollectionPermissions: (config: Any, result: Any) =>
    sanitizePermissions({
      collections: {
        [config.slug]: result,
      },
    }),
})
