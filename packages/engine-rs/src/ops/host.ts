/**
 * JS helpers of the Rust collection operations (crates/payload-core-ops, looked up by name from
 * `crates/payload-core-ops/src/*.rs`). Each helper is one TS expression or statement of the
 * upstream operation, evaluated at the point where the operation evaluates it:
 *
 * - object literals handed to user code, adapters or upstream utilities (same key order, same
 *   property-read order),
 * - destructuring patterns of the operations (same defaults, getter order and V8 errors),
 * - upstream utilities that are called rather than ported (`sanitizeSelect`/`resolveSelect`,
 *   `buildVersionCollectionFields`, `getEntityPermissions`, `sanitizePermissions`,
 *   `replaceWithDraftIfAvailable`, `checkFileAccess`, `markHistoricalFileURLs`,
 *   `relationshipPopulationPromise`, error classes),
 * - JS built-ins whose semantics the engine must not re-implement (`Array.isArray`,
 *   `Array.prototype.map/filter/find` driving a native callback, `for...of` / `for...in` loops as
 *   generators, `new Date(v).getTime()`).
 *
 * Control flow (hooks, access, awaits, branches, loops) and the query utilities
 * (crates/payload-core-query `live`, installed by `getCoreOps()`) are Rust. Payload internals are
 * imported by relative path, like `../runtime`: engine-rs has no installed `payload` link.
 */
import type { SanitizedCollectionConfig } from '../../../payload/src/collections/config/types.js'

import { prefetchVersionForInheritedReadAccess } from '../../../payload/src/collections/operations/utilities/prefetchVersionForInheritedReadAccess.js'
import { APIError } from '../../../payload/src/errors/APIError.js'
import { Forbidden } from '../../../payload/src/errors/Forbidden.js'
import { NotFound } from '../../../payload/src/errors/NotFound.js'
import { QueryError } from '../../../payload/src/errors/QueryError.js'
import { relationshipPopulationPromise } from '../../../payload/src/fields/hooks/afterRead/relationshipPopulationPromise.js'
import { lockedDocumentsCollectionSlug } from '../../../payload/src/locked-documents/config.js'
import { checkFileAccess } from '../../../payload/src/uploads/checkFileAccess.js'
import { markHistoricalFileURLs } from '../../../payload/src/uploads/fileVersioning/markHistoricalFileURLs.js'
import { getEntityPermissions } from '../../../payload/src/utilities/getEntityPermissions/getEntityPermissions.js'
import { httpStatus } from '../../../payload/src/utilities/httpStatus.js'
import { resolveSelect } from '../../../payload/src/utilities/resolveSelect.js'
import { sanitizePermissions } from '../../../payload/src/utilities/sanitizePermissions.js'
import { sanitizeSelect } from '../../../payload/src/utilities/sanitizeSelect.js'
import { skipCompilation } from '../../../payload/src/utilities/skipCompilation.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { replaceWithDraftIfAvailable } from '../../../payload/src/versions/drafts/replaceWithDraftIfAvailable.js'
import {
  isInheritedReadVersionsAccess,
  withInheritedReadVersionsParentID,
} from '../../../payload/src/versions/isInheritedReadVersionsAccess.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the helpers mirror untyped TS expressions */
type Any = any

/** What the loop generators return when the loop is done. */
const DONE = Symbol('done')

/** `sanitizeSort` of sanitizeSortQuery.ts (private there); the engine handles string sorts. */
const sanitizeSortValue = (fields: Any[], sort: Any): string => {
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

/** `<expr>.map(callback)`: V8's errors for a nullish value or a non-callable `map`. */
const mapWith = (array: Any, expr: string, callback: Any) => {
  if (array === null || array === undefined) {
    throw new TypeError(`Cannot read properties of ${array} (reading 'map')`)
  }
  const map = array.map
  if (typeof map !== 'function') {
    throw new TypeError(`${expr}.map is not a function`)
  }
  return Reflect.apply(map, array, [callback])
}

export const createOpsHost = (
  afterRead?: (args: Any) => Promise<unknown>,
  /** the Rust `afterRead` (core runtime binding), used when `afterRead` is not overridden */
  rustAfterRead?: (args: Any) => Promise<unknown>,
): Record<string, unknown> => ({
  afterRead,
  DONE,

  // ---------------------------------------------------------------- generic JS semantics
  /** V8's `TypeError` for calling a non-callable `expr(...)`. */
  notAFunction: (expr: string) => new TypeError(`${expr} is not a function`),
  /** `[...v]` (the write / global operation crates loop over it by index). */
  isArray: Array.isArray,
  spreadIterable: (v: Any) => [...v],
  /**
   * `for (const item of <expr>)` as a generator the engine steps with `next`. `Symbol.iterator`
   * is read once, as `GetIterator` does; a missing one throws V8's `<expr> is not iterable`.
   */
  *forOf(v: Any, expr?: string) {
    if (expr === undefined) {
      for (const item of v) {
        yield item
      }
      return
    }
    const method = v === null || v === undefined ? undefined : v[Symbol.iterator]
    if (typeof method !== 'function') {
      throw new TypeError(`${expr} is not iterable`)
    }
    for (const item of { [Symbol.iterator]: () => Reflect.apply(method, v, []) }) {
      yield item
    }
  },
  /** `for (const key in o)` as a generator the engine steps with `next`. */
  *forIn(o: Any) {
    for (const key in o) {
      yield key
    }
  },
  next: (generator: Generator<unknown>) => {
    const result = generator.next()
    return result.done ? DONE : result.value
  },
  /** A loop body threw: `IteratorClose` (errors of `return` are ignored for a throw completion). */
  closeLoop: (generator: Generator<unknown>) => {
    try {
      generator.return(undefined)
    } catch {
      // the loop body's error wins
    }
  },
  dateTime: (value: Any) => new Date(value).getTime(),
  filterWith: (array: Any, callback: Any) => array.filter(callback),
  findWith: (array: Any, callback: Any) => array.find(callback),
  mapWith,
  /** `name in o` for a primitive `o` (throws V8's TypeError). */
  hasIn: (o: Any, name: string) => name in o,
  lessThan: (a: Any, b: Any) => a < b,
  now: () => new Date().getTime(),
  spreadObject: (value: Any) => ({ ...value }),
  times1000: (value: Any) => value * 1000,

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
    skipCompilation,
  }),
  afterOperationArgs: (
    args: Any,
    collection: Any,
    operation: Any,
    overrideAccess: Any,
    req: Any,
    result: Any,
  ) => ({ args, collection, operation, overrideAccess, req, result, skipCompilation }),
  beforeOperationArgs: (
    args: Any,
    collection: Any,
    context: Any,
    operation: Any,
    overrideAccess: Any,
    req: Any,
  ) => ({ args, collection, context, operation, overrideAccess, req, skipCompilation }),
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
    skipCompilation,
  }),
  readManyHookArgs: (
    collection: Any,
    context: Any,
    doc: Any,
    overrideAccess: Any,
    query: Any,
    req: Any,
  ) => ({ collection, context, doc, findMany: true, overrideAccess, query, req, skipCompilation }),

  // ---------------------------------------------------------------- sanitizeSortQuery
  findByName: (fields: Any, segment: string) => fields.find((each: Any) => each.name === segment),
  prefixSort: (desc: boolean, virtualPath: string) => `${desc ? '-' : ''}${virtualPath}`,
  sanitizeSortValue,

  // ---------------------------------------------------------------- where / select / sort literals
  /** `{ [deletedAtPath]: { exists: false } }` (appendNonTrashedFilter.ts) */
  notTrashedFilter: (deletedAtPath: string) => ({
    [deletedAtPath]: { exists: false },
  }),
  /** `{ ...where, and: [...where.and, notTrashedFilter] }` (appendNonTrashedFilter.ts) */
  appendToAnd: (where: Any, notTrashedFilter: Any) => ({
    ...where,
    and: [...where.and, notTrashedFilter],
  }),
  /** `{ and: [notTrashedFilter, ...(where ? [where] : [])] }` (appendNonTrashedFilter.ts) */
  andWithOptional: (notTrashedFilter: Any, where: Any) => ({
    and: [notTrashedFilter, ...(where ? [where] : [])],
  }),
  /** getQueryDraftsSelect.ts */
  draftsSelect: (select: Any, include: boolean) =>
    include
      ? {
          parent: true,
          version: select,
        }
      : {
          version: select,
        },
  /** The `sort.map` arrow of getQueryDraftsSort.ts (the engine handles string fields). */
  buildVersionFields: (config: Any, collectionConfig: Any) =>
    buildVersionCollectionFields(config, collectionConfig, true),
  draftsSortField: (field: Any) => {
    let orderBy: string
    let direction = ''
    if (field[0] === '-') {
      orderBy = field.substring(1)
      direction = '-'
    } else {
      orderBy = field
    }

    if (orderBy === 'id') {
      return `${direction}parent`
    }

    return `${direction}version.${orderBy}`
  },
  idWhere: (id: Any) => ({ id: { equals: id } }),
  /** `{ [args.field]: { exists: true } }` (findDistinct.ts) */
  existsWhere: (field: Any) => ({
    [field]: {
      exists: true,
    },
  }),
  sanitizeSortQueryArgs: ({ fields, sort }: Any) => [fields, sort],
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
  /** `{ ...doc, collection: collectionConfig.slug }` (auth collections, find.ts / findByID.ts) */
  withCollection: (doc: Any, collectionConfig: Any) => ({
    ...doc,
    collection: collectionConfig.slug,
  }),

  // ---------------------------------------------------------------- find
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
  /**
   * find.ts `result.docs.map(async (doc) => afterRead({ ... }))` (the async arrow returns
   * afterRead's promise), with `afterRead` the dispatched one: the Rust traversal, or the override.
   */
  findAfterReadAll: (
    docs: Any,
    collectionConfig: Any,
    req: Any,
    currentDepth: Any,
    depth: Any,
    draftsEnabled: Any,
    fallbackLocale: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) => {
    const afterReadOf = (afterRead ?? rustAfterRead)!
    return mapWith(docs, 'result.docs', async (doc: Any) =>
      afterReadOf({
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
    )
  },
  /** find.ts `result.docs.map(async (doc) => { ...beforeRead hooks... })` (verbatim). */
  findBeforeReadHooksAll: (
    docs: Any,
    collectionConfig: Any,
    overrideAccess: Any,
    fullWhere: Any,
    req: Any,
  ) =>
    mapWith(docs, 'result.docs', async (doc: Any) => {
      let docRef = doc

      for (const hook of collectionConfig.hooks.beforeRead) {
        docRef =
          (await hook({
            collection: collectionConfig,
            context: req.context,
            doc: docRef,
            overrideAccess: overrideAccess!,
            query: fullWhere,
            req,
          })) || docRef
      }

      return docRef
    }),
  /** find.ts `result.docs.map(async (doc) => { ...afterRead hooks... })` (verbatim). */
  findAfterReadHooksAll: (
    docs: Any,
    collectionConfig: Any,
    overrideAccess: Any,
    fullWhere: Any,
    req: Any,
  ) =>
    mapWith(docs, 'result.docs', async (doc: Any) => {
      let docRef = doc

      for (const hook of collectionConfig.hooks.afterRead) {
        docRef =
          (await hook({
            collection: collectionConfig,
            context: req.context,
            doc: docRef,
            findMany: true,
            overrideAccess: overrideAccess!,
            query: fullWhere,
            req,
          })) || docRef
      }

      return docRef
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
  /** The `payload.db.queryDrafts` literal of find.ts; `evaluate(0)` / `evaluate(1)` are the
   * engine's `getQueryDraftsSelect({ select })` / `getQueryDraftsSort({ collectionConfig, sort })`. */
  findQueryDraftsArgs: (
    collectionConfig: Any,
    req: Any,
    sanitizedJoins: Any,
    sanitizedLimit: Any,
    locale: Any,
    sanitizedPage: Any,
    usePagination: Any,
    fullWhere: Any,
    evaluate: (which: number) => Any,
  ) => ({
    collection: collectionConfig.slug,
    joins: req.payloadAPI === 'GraphQL' ? false : sanitizedJoins,
    limit: sanitizedLimit,
    locale: locale!,
    page: sanitizedPage,
    pagination: usePagination,
    req,
    select: evaluate(0),
    sort: evaluate(1),
    where: fullWhere,
  }),

  // ---------------------------------------------------------------- findByID
  /** `where: appendVersionToQueryKey(where)` is the engine's `evaluate()`. */
  existingVersionsArgs: (collectionConfig: Any, locale: Any, req: Any, evaluate: () => Any) => ({
    collection: collectionConfig.slug,
    limit: 1,
    locale: locale!,
    pagination: false,
    req,
    select: { parent: true },
    where: evaluate(),
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
  /** `select: getQueryDraftsSelect({ select })` is the engine's `evaluate()`. */
  findByIDQueryDraftsArgs: (
    collectionConfig: Any,
    req: Any,
    sanitizedJoins: Any,
    locale: Any,
    query: Any,
    evaluate: () => Any,
  ) => ({
    collection: collectionConfig.slug,
    joins: req.payloadAPI === 'GraphQL' ? false : sanitizedJoins,
    limit: 1,
    locale: locale!,
    pagination: false,
    req,
    select: evaluate(),
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
    skipCompilation,
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
  /** The `relationshipPopulationPromise({...})` call of findDistinct.ts' population loop. */
  distinctPopulation: (sanitizedField: Any, doc: Any, args: Any, populate: Any, req: Any) =>
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
  /** findVersions.ts `result.docs.map(async (data) => { data.version = await afterRead(...) })`. */
  findVersionsAfterReadAll: (
    docs: Any,
    collectionConfig: Any,
    req: Any,
    depth: Any,
    fallbackLocale: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) => {
    const afterReadOf = (afterRead ?? rustAfterRead)!
    return mapWith(docs, 'result.docs', async (data: Any) => {
      data.version = await afterReadOf({
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
      })
      return data
    })
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
  /** findVersions.ts `result.docs.map(async (doc) => { ...afterRead hooks... })` (verbatim). */
  findVersionsAfterReadHooksAll: (
    docs: Any,
    collectionConfig: Any,
    overrideAccess: Any,
    fullWhere: Any,
    req: Any,
  ) =>
    mapWith(docs, 'result.docs', async (doc: Any) => {
      const docRef = doc

      for (const hook of collectionConfig.hooks.afterRead) {
        docRef.version =
          (await hook({
            collection: collectionConfig,
            context: req.context,
            doc: doc.version,
            findMany: true,
            overrideAccess,
            query: fullWhere,
            req,
          })) || doc.version
      }

      return docRef
    }),
  /** findVersions.ts `paginatedDocs.docs.map(async (doc) => { ... })` (verbatim). */
  findVersionsBeforeReadAll: (
    docs: Any,
    collectionConfig: Any,
    overrideAccess: Any,
    fullWhere: Any,
    req: Any,
  ) =>
    mapWith(docs, 'paginatedDocs.docs', async (doc: Any) => {
      const docRef = doc
      // Fallback if not selected
      if (!docRef.version) {
        ;(docRef as any).version = {}
      }

      if (collectionConfig.hooks?.beforeRead?.length) {
        for (const hook of collectionConfig.hooks.beforeRead) {
          docRef.version =
            (await hook({
              collection: collectionConfig,
              context: req.context,
              doc: docRef.version,
              overrideAccess,
              query: fullWhere,
              req,
            })) || docRef.version
        }
      }

      return docRef
    }),
  isInheritedReadVersionsAccess: (access: Any) => isInheritedReadVersionsAccess(access),
  /** The `result.docs.map` arrow of findVersions.ts for upload collections. */
  markHistoricalRow: (row: Any, collectionConfig: Any, req: Any) => ({
    ...row,
    version: markHistoricalFileURLs({
      collectionSlug: collectionConfig.slug,
      doc: row.version,
      req,
      versionID: row.id,
    }),
  }),
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
  sanitizeCollectionPermissions: (config: Any, result: Any) =>
    sanitizePermissions({
      collections: {
        [config.slug]: result,
      },
    }),
})
