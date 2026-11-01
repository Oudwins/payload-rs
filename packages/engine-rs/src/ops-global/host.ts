/**
 * JS helpers of the Rust global and auth operations (crates/payload-core-ops-global, looked up by
 * name). Each helper is one TS expression or statement sequence of the upstream operation
 * (`packages/payload/src/globals/operations/*.ts`, `packages/payload/src/auth/operations/*.ts`),
 * evaluated at the point where the operation evaluates it:
 *
 * - object literals handed to user code, adapters, the Local API or upstream utilities (same key
 *   order, same property-read order),
 * - destructuring patterns (same defaults, getter order and V8 errors; parameters are named like
 *   the upstream source so V8's "Cannot destructure ... of '<name>'" messages match),
 * - upstream utilities that are called rather than ported: transactions, field traversals,
 *   crypto / JWT / sessions / cookies / email, query / select utilities, error classes,
 * - synchronous segments without user callbacks (all-locales publication bookkeeping, login input
 *   sanitization, forgot-password URL/HTML building).
 *
 * Control flow (hooks, access, awaits, branches, try/catch/finally) stays in Rust. Payload
 * internals are imported by relative path, like `../ops`: engine-rs has no installed `payload`
 * link. The field traversals are payload's own exports (dispatched by `PAYLOAD_CORE_ENGINE`), so
 * the operations use whichever traversal engine payload uses.
 */
import crypto from 'crypto'

import { createAuthToken } from '../../../payload/src/auth/createAuthToken.js'
import { ensureUsernameOrEmail } from '../../../payload/src/auth/ensureUsernameOrEmail.js'
import { executeAuthStrategies } from '../../../payload/src/auth/executeAuthStrategies.js'
import { getAccessResults } from '../../../payload/src/auth/getAccessResults.js'
import { getFieldsToSign } from '../../../payload/src/auth/getFieldsToSign.js'
import { getLoginOptions } from '../../../payload/src/auth/getLoginOptions.js'
import { jwtSign } from '../../../payload/src/auth/jwt.js'
import { checkLoginPermission } from '../../../payload/src/auth/operations/login.js'
import { extendSession, revokeSession } from '../../../payload/src/auth/sessions.js'
import { authenticateLocalStrategy } from '../../../payload/src/auth/strategies/local/authenticate.js'
import { generatePasswordSaltHash } from '../../../payload/src/auth/strategies/local/generatePasswordSaltHash.js'
import { incrementLoginAttempts } from '../../../payload/src/auth/strategies/local/incrementLoginAttempts.js'
import { resetLoginAttempts } from '../../../payload/src/auth/strategies/local/resetLoginAttempts.js'
import { hasWhereAccessResult } from '../../../payload/src/auth/types.js'
import { combineQueries } from '../../../payload/src/database/combineQueries.js'
import { validateQueryPaths } from '../../../payload/src/database/queryValidation/validateQueryPaths.js'
import { validateSortQuery } from '../../../payload/src/database/queryValidation/validateSortQuery.js'
import { sanitizeWhereQuery } from '../../../payload/src/database/sanitizeWhereQuery.js'
import {
  APIError,
  AuthenticationError,
  Forbidden,
  NotFound,
  UnverifiedEmail,
  ValidationError,
} from '../../../payload/src/errors/index.js'
import { afterChange } from '../../../payload/src/fields/hooks/afterChange/index.js'
import { afterRead } from '../../../payload/src/fields/hooks/afterRead/index.js'
import { beforeChange } from '../../../payload/src/fields/hooks/beforeChange/index.js'
import { beforeValidate } from '../../../payload/src/fields/hooks/beforeValidate/index.js'
import { validateGlobalLocalWithLocaleKeyedData } from '../../../payload/src/globals/operations/local/validate.js'
import { lockedDocumentsCollectionSlug } from '../../../payload/src/locked-documents/config.js'
import { appendNonTrashedFilter } from '../../../payload/src/utilities/appendNonTrashedFilter.js'
import { assertNoValidationWrite } from '../../../payload/src/utilities/assertNoValidationWrite.js'
import { checkDocumentLockStatus } from '../../../payload/src/utilities/checkDocumentLockStatus.js'
import { commitTransaction } from '../../../payload/src/utilities/commitTransaction.js'
import { deepCopyObjectSimple } from '../../../payload/src/utilities/deepCopyObject.js'
import { flattenDataByLocale } from '../../../payload/src/utilities/flattenDataByLocale.js'
import { formatAdminURL } from '../../../payload/src/utilities/formatAdminURL.js'
import { getEntityPermissions } from '../../../payload/src/utilities/getEntityPermissions/getEntityPermissions.js'
import { getRequestOrigin } from '../../../payload/src/utilities/getRequestOrigin.js'
import { getSelectMode } from '../../../payload/src/utilities/getSelectMode.js'
import { getTopLevelFieldNames } from '../../../payload/src/utilities/getTopLevelFieldNames.js'
import {
  hasDraftsEnabled,
  hasDraftValidationEnabled,
  hasLocalizeStatusEnabled,
} from '../../../payload/src/utilities/getVersionsConfig.js'
import { httpStatus } from '../../../payload/src/utilities/httpStatus.js'
import { initTransaction } from '../../../payload/src/utilities/initTransaction.js'
import { isolateObjectProperty } from '../../../payload/src/utilities/isolateObjectProperty.js'
import { killTransaction } from '../../../payload/src/utilities/killTransaction.js'
import { resolvePublishAllLocales } from '../../../payload/src/utilities/resolvePublishAllLocales.js'
import { resolveSelect } from '../../../payload/src/utilities/resolveSelect.js'
import { runValidationLifecycle } from '../../../payload/src/utilities/runValidationLifecycle.js'
import { sanitizeInternalFields } from '../../../payload/src/utilities/sanitizeInternalFields.js'
import { sanitizePermissions } from '../../../payload/src/utilities/sanitizePermissions.js'
import { sanitizeSelect } from '../../../payload/src/utilities/sanitizeSelect.js'
import { adminInit as adminInitTelemetry } from '../../../payload/src/utilities/telemetry/events/adminInit.js'
import {
  buildAllLocalesPublicationHookDoc,
  getAllLocalesPublicationStatus,
  hasAuthorizedAllLocalesPublicationStatus,
  normalizeAllLocalesPublicationStatus,
  reconcileAllLocalesPublicationStatus,
  validateAllLocalesPublicationFlags,
} from '../../../payload/src/versions/allLocalesPublicationStatus.js'
import { buildVersionGlobalFields } from '../../../payload/src/versions/buildGlobalFields.js'
import { buildLocalizedPublishData } from '../../../payload/src/versions/buildSingleLocalePublishData.js'
import {
  findDraftVersion,
  getDocumentFromDraftVersion,
  replaceWithDraftIfAvailable,
} from '../../../payload/src/versions/drafts/replaceWithDraftIfAvailable.js'
import { getLatestGlobalVersion } from '../../../payload/src/versions/getLatestGlobalVersion.js'
import { getRestoredStatusesToAuthorize } from '../../../payload/src/versions/getRestoredStatusesToAuthorize.js'
import { saveVersion } from '../../../payload/src/versions/saveVersion.js'
// payload's own `jose` (`import { decodeJwt } from 'jose/jwt/decode'` in me.ts): engine-rs does not
// depend on jose, so the same file is imported by path (one module instance, same error classes).
import { decodeJwt } from '../../../payload/node_modules/jose/dist/webapi/util/decode_jwt.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the helpers mirror untyped TS expressions */
type Any = any

const lockDurationDefault = 300 // Default 5 minutes in seconds (findOne.ts)

/** `const { <first>, ... } = (await ...)` on a nullish value: V8's TypeError. */
const destructureError = (value: Any, first: string) =>
  new TypeError(
    `Cannot destructure property '${first}' of '(intermediate value)' as it is ${value}.`,
  )

export const createOpsGlobalHost = (): Record<string, unknown> => ({
  // ---------------------------------------------------------------- generic
  /** `const { a, b } = await x`: the destructured values (V8's error when `x` is nullish). */
  awaitedProps: (value: Any, ...keys: string[]) => {
    if (value === null || value === undefined) {
      throw destructureError(value, keys[0]!)
    }
    return keys.map((key) => value[key])
  },
  combineQueries: (where: Any, access: Any) => combineQueries(where, access),
  deepCopyObjectSimple: (value: Any) => deepCopyObjectSimple(value),
  emptyCountResult: () => ({ totalDocs: 0 }),
  hasKeys: (v: Any) => v && Object.keys(v).length > 0,
  hasLocalizeStatusEnabled: (globalConfig: Any) => hasLocalizeStatusEnabled(globalConfig),
  hasWhereAccessResult: (result: Any) => hasWhereAccessResult(result),
  idWhere: (id: Any) => ({ id: { equals: id } }),
  isEmptyList: (v: Any) => !v || v.length === 0,
  pushValue: (array: Any[], value: Any) => {
    array.push(value)
  },
  sanitizeInternalFields: (doc: Any) => sanitizeInternalFields(doc),
  sanitizeWhereQuery: (fields: Any, payload: Any, where: Any) => {
    sanitizeWhereQuery({ fields, payload, where })
  },
  spread: (v: Any) => ({ ...v }),
  spreadEither: (a: Any, b: Any) => ({ ...(a ?? b) }),
  spreadTwo: (a: Any, b: Any) => ({ ...a, ...b }),
  stampUpdatedAt: (doc: Any) => {
    doc.updatedAt = new Date().toISOString()
  },

  // ---------------------------------------------------------------- errors
  apiError: (message: string, status: number) => new APIError(message, status),
  authenticationError: (t: Any) => new AuthenticationError(t),
  forbidden: (t: Any) => new Forbidden(t),
  notFound: (t: Any) => new NotFound(t),
  unverifiedEmail: (t: Any) => new UnverifiedEmail({ t }),

  // ---------------------------------------------------------------- transactions
  assertNoValidationWrite: (req: Any) => assertNoValidationWrite(req),
  commitTransaction: (req: Any) => commitTransaction(req),
  initTransaction: (req: Any) => initTransaction(req),
  killTransaction: (req: Any) => killTransaction(req),

  // ---------------------------------------------------------------- global hook args
  globalAfterChangeHookArgs: (
    req: Any,
    data: Any,
    doc: Any,
    global: Any,
    overrideAccess: Any,
    previousDoc: Any,
  ) => ({
    context: req.context,
    data,
    doc,
    global,
    operation: 'update',
    overrideAccess,
    previousDoc,
    req,
  }),
  globalBeforeOperationArgs: (args: Any, global: Any, operation: Any, overrideAccess: Any) => ({
    args,
    context: args.req.context,
    global,
    operation,
    overrideAccess,
    req: args.req,
  }),
  globalBeforeOperationArgsUpdate: (args: Any, global: Any, operation: Any) => ({
    args,
    context: args.req.context,
    global,
    operation,
    overrideAccess: args.overrideAccess,
    req: args.req,
  }),
  globalBeforeOperationReqArgs: (
    args: Any,
    req: Any,
    global: Any,
    operation: Any,
    overrideAccess: Any,
  ) => ({ args, context: req.context, global, operation, overrideAccess, req }),
  globalChangeHookArgs: (
    req: Any,
    data: Any,
    global: Any,
    originalDoc: Any,
    overrideAccess: Any,
  ) => ({
    context: req.context,
    data,
    global,
    operation: 'update',
    originalDoc,
    overrideAccess,
    req,
  }),
  globalReadHookArgs: (req: Any, doc: Any, global: Any, overrideAccess: Any) => ({
    context: req.context,
    doc,
    global,
    overrideAccess,
    req,
  }),
  globalVersionHookArgs: (
    context: Any,
    doc: Any,
    global: Any,
    overrideAccess: Any,
    query: Any,
    hasQuery: boolean,
    req: Any,
  ) =>
    hasQuery
      ? { context, doc, global, overrideAccess, query, req }
      : { context, doc, global, overrideAccess, req },
  globalVersionsHookArgs: (
    context: Any,
    doc: Any,
    global: Any,
    overrideAccess: Any,
    query: Any,
    req: Any,
  ) => ({ context, doc, findMany: true, global, overrideAccess, query, req }),

  // ---------------------------------------------------------------- global select / query
  globalSelectVersionsFresh: (payload: Any, globalConfig: Any, req: Any, incomingSelect: Any) =>
    sanitizeSelect({
      fields: buildVersionGlobalFields(payload.config, globalConfig, true),
      select: resolveSelect({
        config: globalConfig.select,
        operation: 'read',
        req,
        select: incomingSelect,
      }),
      versions: true,
    }),
  globalVersionFields: (payload: Any, global: Any) =>
    buildVersionGlobalFields(payload.config, global, true),
  selectRead: (config: Any, req: Any, incomingSelect: Any, operation: Any) =>
    sanitizeSelect({
      fields: config.flattenedFields,
      select: resolveSelect({
        config: config.select,
        operation,
        req,
        select: incomingSelect,
      }),
    }),
  selectVersions: (versionFields: Any, globalConfig: Any, req: Any, incomingSelect: Any) =>
    sanitizeSelect({
      fields: versionFields,
      select: resolveSelect({
        config: globalConfig.select,
        operation: 'read',
        req,
        select: incomingSelect,
      }),
      versions: true,
    }),
  stripGlobalType: (select: Any, doc: Any) => {
    if (select && doc.globalType) {
      const selectMode = getSelectMode(select)
      if (
        (selectMode === 'include' && !select['globalType']) ||
        (selectMode === 'exclude' && select['globalType'] === false)
      ) {
        delete doc['globalType']
      }
    }
  },
  validateQueryPathsGlobal: (
    globalConfig: Any,
    overrideAccess: Any,
    req: Any,
    versionFields: Any,
    where: Any,
  ) => validateQueryPaths({ globalConfig, overrideAccess, req, versionFields, where }),
  validateSortQueryGlobal: (
    globalConfig: Any,
    overrideAccess: Any,
    req: Any,
    sort: Any,
    versionFields: Any,
  ) => validateSortQuery({ globalConfig, overrideAccess, req, sort, versionFields }),

  // ---------------------------------------------------------------- globals: findOne
  applyLockStatus: (doc: Any, lockStatus: Any) => {
    doc._isLocked = !!lockStatus
    doc._userEditing = lockStatus?.user?.value ?? null
  },
  findGlobalArgs: (
    slug: Any,
    locale: Any,
    req: Any,
    dbSelect: Any,
    overrideAccess: Any,
    accessResult: Any,
  ) => ({
    slug,
    locale: locale!,
    req,
    select: dbSelect,
    where: overrideAccess ? undefined : accessResult,
  }),
  findOneAfterRead: (
    req: Any,
    depth: Any,
    doc: Any,
    replaceWithVersion: Any,
    fallbackLocale: Any,
    flattenLocales: Any,
    globalConfig: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) =>
    afterRead({
      collection: null,
      context: req.context,
      depth: depth!,
      doc,
      draft: replaceWithVersion,
      fallbackLocale: fallbackLocale!,
      flattenLocales,
      global: globalConfig,
      locale: locale!,
      overrideAccess,
      populate,
      req,
      select,
      showHiddenFields: showHiddenFields!,
    }),
  findOneArgs: (args: Any) => {
    const {
      slug,
      depth,
      disableErrors,
      draft: replaceWithVersion = false,
      flattenLocales,
      globalConfig,
      includeLockStatus: includeLockStatusFromArgs,
      overrideAccess = false,
      populate,
      req: { fallbackLocale, locale },
      req,
      select: incomingSelect,
      showHiddenFields,
    } = args
    return [
      slug,
      depth,
      disableErrors,
      replaceWithVersion,
      flattenLocales,
      globalConfig,
      includeLockStatusFromArgs,
      overrideAccess,
      populate,
      fallbackLocale,
      locale,
      req,
      incomingSelect,
      showHiddenFields,
    ]
  },
  findOneDbSelect: (globalConfig: Any, replaceWithVersion: Any, select: Any) => {
    let dbSelect = select

    if (
      globalConfig.versions?.drafts &&
      replaceWithVersion &&
      select &&
      getSelectMode(select) === 'include'
    ) {
      dbSelect = { ...select, createdAt: true, updatedAt: true }
    }
    return dbSelect
  },
  globalLockArgs: (slug: Any, req: Any, lockDurationInMilliseconds: number) => ({
    collection: lockedDocumentsCollectionSlug,
    depth: 1,
    limit: 1,
    overrideAccess: false,
    pagination: false,
    req,
    where: {
      and: [
        {
          globalSlug: {
            equals: slug,
          },
        },
        {
          updatedAt: {
            greater_than: new Date(new Date().getTime() - lockDurationInMilliseconds),
          },
        },
      ],
    },
  }),
  globalReplaceWithDraft: (
    accessResult: Any,
    doc: Any,
    globalConfig: Any,
    overrideAccess: Any,
    req: Any,
    select: Any,
  ) =>
    replaceWithDraftIfAvailable({
      accessResult,
      doc,
      entity: globalConfig,
      entityType: 'global',
      overrideAccess,
      req,
      select,
    }),
  includeLockStatus: (includeLockStatusFromArgs: Any, req: Any) =>
    includeLockStatusFromArgs && req.payload.collections?.[lockedDocumentsCollectionSlug],
  lockDurationMs: (globalConfig: Any) => {
    const lockDocumentsProp = globalConfig?.lockDocuments

    const lockDuration =
      typeof lockDocumentsProp === 'object' ? lockDocumentsProp.duration : lockDurationDefault
    return lockDuration * 1000
  },
  lockStatusOf: (lockedDocument: Any, lockStatus: Any) =>
    lockedDocument && lockedDocument.docs.length > 0 ? lockedDocument.docs[0]! : lockStatus,

  // ---------------------------------------------------------------- globals: countGlobalVersions
  countGlobalVersionsArgs: (args: Any) => {
    const { disableErrors, global, overrideAccess, where } = args
    const req = args.req!
    const { payload } = req
    return [disableErrors, global, overrideAccess, where, req, payload]
  },
  countGlobalVersionsDbArgs: (global: Any, req: Any, fullWhere: Any) => ({
    global: global.slug,
    locale: req?.locale || undefined,
    req,
    where: fullWhere,
  }),

  // ---------------------------------------------------------------- globals: findVersions
  globalFindVersionsAfterRead: (
    data: Any,
    req: Any,
    depth: Any,
    fallbackLocale: Any,
    globalConfig: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) =>
    afterRead({
      collection: null,
      context: req.context,
      depth: depth!,
      doc: {
        ...data.version,
        // Patch globalType onto version doc
        globalType: globalConfig.slug,
      },
      draft: undefined!,
      fallbackLocale: fallbackLocale!,
      findMany: true,
      global: globalConfig,
      locale: locale!,
      overrideAccess: overrideAccess!,
      populate,
      req,
      select,
      showHiddenFields: showHiddenFields!,
    }),
  globalFindVersionsArgs: (args: Any) => {
    const {
      depth,
      globalConfig,
      limit,
      overrideAccess,
      page,
      pagination = true,
      populate,
      select: incomingSelect,
      showHiddenFields,
      sort,
      where,
    } = args
    const req = args.req!
    const { fallbackLocale, locale, payload } = req
    return [
      depth,
      globalConfig,
      limit,
      overrideAccess,
      page,
      pagination,
      populate,
      incomingSelect,
      showHiddenFields,
      sort,
      where,
      req,
      fallbackLocale,
      locale,
      payload,
    ]
  },
  globalFindVersionsDbArgs: (
    globalConfig: Any,
    limit: Any,
    locale: Any,
    page: Any,
    pagination: Any,
    req: Any,
    select: Any,
    sort: Any,
    fullWhere: Any,
  ) => {
    const usePagination = pagination && limit !== 0
    const sanitizedLimit = limit ?? (usePagination ? 10 : 0)
    const sanitizedPage = page || 1
    return {
      global: globalConfig.slug,
      limit: sanitizedLimit,
      locale: locale!,
      page: sanitizedPage,
      pagination,
      req,
      select,
      sort,
      where: fullWhere,
    }
  },
  sanitizeVersionDocs: (result: Any) => ({
    ...result,
    docs: result.docs.map((doc: Any) => sanitizeInternalFields(doc)),
  }),

  // ---------------------------------------------------------------- globals: findVersionByID
  globalFindVersionByIDAfterRead: (
    req: Any,
    currentDepth: Any,
    depth: Any,
    result: Any,
    fallbackLocale: Any,
    globalConfig: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) =>
    afterRead({
      collection: null,
      context: req.context,
      currentDepth,
      depth: depth!,
      doc: result.version,
      draft: undefined!,
      fallbackLocale: fallbackLocale!,
      global: globalConfig,
      locale: locale!,
      overrideAccess: overrideAccess!,
      populate,
      req,
      select: typeof select?.version === 'object' ? select.version : undefined,
      showHiddenFields: showHiddenFields!,
    }),
  globalFindVersionByIDArgs: (args: Any) => {
    const {
      id,
      currentDepth,
      depth,
      disableErrors,
      globalConfig,
      overrideAccess,
      populate,
      req: { fallbackLocale, locale, payload },
      req,
      select: incomingSelect,
      showHiddenFields,
    } = args
    return [
      id,
      currentDepth,
      depth,
      disableErrors,
      globalConfig,
      overrideAccess,
      populate,
      fallbackLocale,
      locale,
      payload,
      req,
      incomingSelect,
      showHiddenFields,
    ]
  },
  globalFindVersionByIDDbArgs: (
    globalConfig: Any,
    locale: Any,
    req: Any,
    select: Any,
    where: Any,
  ) => ({
    global: globalConfig.slug,
    limit: 1,
    locale: locale!,
    req,
    select,
    where,
  }),

  // ---------------------------------------------------------------- globals: docAccess
  globalDocAccessArgs: (args: Any) => {
    const { data, globalConfig, req } = args
    return [data, globalConfig, req]
  },
  globalEntityPermissions: (data: Any, globalConfig: Any, globalOperations: Any, req: Any) =>
    getEntityPermissions({
      id: undefined,
      blockReferencesPermissions: {},
      data,
      entity: globalConfig,
      entityType: 'global',
      fetchData: true,
      operations: globalOperations,
      req,
    }),
  globalOperations: () => ['read', 'update', 'validate'],
  globalSanitizePermissions: (globalConfig: Any, result: Any) => {
    const sanitizedPermissions = sanitizePermissions({
      globals: {
        [globalConfig.slug]: result,
      },
    } as Any)

    const globalPermissions = sanitizedPermissions?.globals?.[globalConfig.slug]
    return globalPermissions ?? { fields: {} }
  },
  pushReadVersions: (globalOperations: Any[]) => {
    globalOperations.push('readVersions')
  },

  // ---------------------------------------------------------------- globals: validate
  copyWithoutID: (storedGlobal: Any) => {
    const docWithLocales = deepCopyObjectSimple(storedGlobal)

    if (docWithLocales._id) {
      delete docWithLocales._id
    }
    return docWithLocales
  },
  findAccessibleDraft: (
    accessResult: Any,
    base: Any,
    newestDraft: Any,
    globalConfig: Any,
    overrideAccess: Any,
    req: Any,
  ) =>
    findDraftVersion({
      accessResult,
      doc: base,
      draftVersionID: newestDraft.id,
      entity: globalConfig,
      entityType: 'global',
      overrideAccess,
      req,
    }),
  findNewestDraft: (base: Any, globalConfig: Any, req: Any) =>
    findDraftVersion({
      accessResult: true,
      doc: base,
      entity: globalConfig,
      entityType: 'global',
      overrideAccess: true,
      req,
    }),
  globalDocumentFromDraft: (base: Any, newestDraft: Any) =>
    getDocumentFromDraftVersion({
      doc: base,
      draftVersion: newestDraft,
      entityType: 'global',
    }),
  globalRunValidationLifecycle: (
    docWithLocales: Any,
    globalConfig: Any,
    incomingData: Any,
    onValidationData: Any,
    originalDoc: Any,
    overrideAccess: Any,
    req: Any,
    skipMutationHooks: Any,
    validationOperation: Any,
  ) =>
    runValidationLifecycle({
      collection: null,
      docWithLocales,
      global: globalConfig,
      incomingData,
      onValidationData,
      originalDoc,
      overrideAccess,
      req,
      skipMutationHooks,
      validationOperation,
    }),
  globalTypeDoc: (slug: Any) => ({ globalType: slug }),
  globalValidateAfterRead: (req: Any, docWithLocales: Any, draft: Any, globalConfig: Any) =>
    afterRead({
      collection: null,
      context: req.context,
      depth: 0,
      doc: deepCopyObjectSimple(docWithLocales),
      draft,
      fallbackLocale: req.fallbackLocale!,
      global: globalConfig,
      locale: req.locale!,
      overrideAccess: true,
      req,
      showHiddenFields: true,
    }),
  globalValidateArgs: ({
    slug,
    data: incomingData,
    draft,
    globalConfig,
    onValidationData,
    overrideAccess,
    req,
    skipAccessControl = false,
    skipMutationHooks = false,
    sourceData,
    validationOperation = 'validate',
  }: Any) => [
    slug,
    incomingData,
    draft,
    globalConfig,
    onValidationData,
    overrideAccess,
    req,
    skipAccessControl,
    skipMutationHooks,
    sourceData,
    validationOperation,
  ],
  validationFindGlobalArgs: (slug: Any, req: Any, where: Any, hasWhere: boolean) =>
    hasWhere ? { slug, locale: req.locale!, req, where } : { slug, locale: req.locale!, req },
  validationOriginalFromSource: (
    req: Any,
    sourceData: Any,
    docWithLocales: Any,
    globalConfig: Any,
  ) =>
    req.locale === sourceData.originalLocale
      ? deepCopyObjectSimple(sourceData.originalDoc)
      : flattenDataByLocale({
          configBlockReferences: req.payload.config.blocks,
          docWithLocales,
          fields: globalConfig.fields,
          locale: req.locale!,
        }),

  // ---------------------------------------------------------------- globals: update
  destructureGlobalType: (resultWithLocales: Any) => {
    const { globalType } = resultWithLocales
    return globalType
  },
  filterAvailableLocales: (config: Any, req: Any) =>
    config.localization.filterAvailableLocales({
      locales: config.localization.locales,
      req,
    }),
  globalAfterChange: (req: Any, data: Any, doc: Any, globalConfig: Any, previousDoc: Any) =>
    afterChange({
      collection: null,
      context: req.context,
      data,
      doc,
      global: globalConfig,
      operation: 'update',
      previousDoc,
      req,
    }),
  globalBeforeChange: (
    data: Any,
    req: Any,
    publicationHookDoc: Any,
    globalJSON: Any,
    submittedTopLevelFieldNames: Any,
    globalConfig: Any,
    isSavingDraft: boolean,
  ) => {
    const publicationData = { ...data }

    const beforeChangeArgs = {
      collection: null,
      context: req.context,
      data,
      doc: publicationHookDoc,
      docWithLocales: globalJSON,
      fieldsToValidate: submittedTopLevelFieldNames,
      global: globalConfig,
      operation: 'update',
      req,
      skipValidation: isSavingDraft && !hasDraftValidationEnabled(globalConfig),
    }

    const statusFieldValue: { value: unknown } = { value: undefined }

    const promise = beforeChange({
      ...(beforeChangeArgs as Any),
      onDataProcessed: (processedData: Any) => {
        statusFieldValue.value = processedData._status
      },
    })
    return [publicationData, statusFieldValue, promise]
  },
  globalBeforeValidate: (
    req: Any,
    data: Any,
    originalDoc: Any,
    publicationFieldPolicyDoc: Any,
    globalConfig: Any,
    onFieldAccess: Any,
    overrideAccess: Any,
  ) =>
    beforeValidate({
      collection: null,
      context: req.context,
      data,
      doc: originalDoc,
      docForHooks: publicationFieldPolicyDoc,
      global: globalConfig,
      onFieldAccess,
      operation: 'update',
      overrideAccess: overrideAccess!,
      req,
    }),
  globalCheckLockStatus: (slug: Any, overrideLock: Any, req: Any) =>
    checkDocumentLockStatus({
      globalSlug: slug,
      lockErrorMessage: `Global with slug "${slug}" is currently locked by another user and cannot be updated.`,
      overrideLock,
      req,
    }),
  globalFindAllLocalesArgs: (globalConfig: Any, req: Any, query: Any) => ({
    slug: globalConfig.slug,
    locale: 'all',
    req,
    where: query,
  }),
  globalLatestVersion: (
    slug: Any,
    globalConfig: Any,
    publishAllLocales: Any,
    unpublishAllLocales: Any,
    locale: Any,
    payload: Any,
    req: Any,
    query: Any,
  ) =>
    getLatestGlobalVersion({
      slug,
      config: globalConfig,
      locale: publishAllLocales || unpublishAllLocales ? 'all' : locale!,
      payload,
      req,
      where: query,
    }),
  globalLocalizedPublishData: (
    config: Any,
    currentGlobal: Any,
    globalConfig: Any,
    locale: Any,
    result: Any,
  ) =>
    buildLocalizedPublishData({
      config,
      currentDoc: currentGlobal,
      fields: globalConfig.fields,
      locale: locale!,
      result,
    }),
  globalSaveVersion: (
    autosave: Any,
    resultWithLocales: Any,
    isSavingDraft: Any,
    globalConfig: Any,
    payload: Any,
    req: Any,
    select: Any,
    unpublishAllLocales: Any,
    operation: Any,
  ) =>
    saveVersion({
      autosave,
      docWithLocales: resultWithLocales,
      draft: isSavingDraft,
      global: globalConfig,
      operation,
      payload,
      req,
      select,
      unpublish: unpublishAllLocales,
    }),
  globalUpdateAfterRead: (
    req: Any,
    depth: Any,
    resultWithLocales: Any,
    draftArg: Any,
    globalConfig: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) =>
    afterRead({
      collection: null,
      context: req.context,
      depth: depth!,
      doc: resultWithLocales,
      draft: draftArg!,
      fallbackLocale: null!,
      global: globalConfig,
      locale: locale!,
      overrideAccess: overrideAccess!,
      populate,
      req,
      select,
      showHiddenFields: showHiddenFields!,
    }),
  globalUpdateArgs: (args: Any) => {
    const {
      slug,
      autosave,
      depth,
      draft: draftArg,
      globalConfig,
      overrideAccess,
      overrideLock,
      populate,
      publishAllLocales: publishAllLocalesArg,
      req: { fallbackLocale, locale, payload, payload: { config } = {} },
      select: incomingSelect,
      showHiddenFields,
      unpublishAllLocales: unpublishAllLocalesArg,
    } = args
    return [
      slug,
      autosave,
      depth,
      draftArg,
      globalConfig,
      overrideAccess,
      overrideLock,
      populate,
      publishAllLocalesArg,
      fallbackLocale,
      locale,
      payload,
      config,
      incomingSelect,
      showHiddenFields,
      unpublishAllLocalesArg,
    ]
  },
  globalUpdateCurrent: (accessResults: Any, globalVersionResult: Any, req: Any) => {
    const { global, globalExists } = globalVersionResult || {}

    if (
      hasWhereAccessResult(accessResults) &&
      globalExists &&
      (!global || Object.keys(global).length === 0)
    ) {
      throw new Forbidden(req.t)
    }

    let globalJSON: Any = {}

    if (globalVersionResult && globalVersionResult.global) {
      globalJSON = deepCopyObjectSimple(global)

      if (globalJSON._id) {
        delete globalJSON._id
      }
    }
    return [global, globalExists, globalJSON]
  },
  globalUpdateOriginalAfterRead: (
    req: Any,
    globalJSON: Any,
    draftArg: Any,
    fallbackLocale: Any,
    globalConfig: Any,
    locale: Any,
    showHiddenFields: Any,
  ) =>
    afterRead({
      collection: null,
      context: req.context,
      depth: 0,
      doc: deepCopyObjectSimple(globalJSON),
      draft: draftArg!,
      fallbackLocale: fallbackLocale!,
      global: globalConfig,
      locale: locale!,
      overrideAccess: true,
      req,
      showHiddenFields: showHiddenFields!,
    }),
  globalUpdatePrelude: (args: Any) => {
    assertNoValidationWrite(args.req)

    const req = args.req
    const initialGlobalConfig = args.globalConfig

    assertNoValidationWrite(req)

    validateAllLocalesPublicationFlags({
      publishAllLocales: args.publishAllLocales,
      unpublishAllLocales: args.unpublishAllLocales,
    })

    const initialPublishAllLocales = resolvePublishAllLocales({
      draft: args.draft,
      hasLocalizeStatusEnabled: hasLocalizeStatusEnabled(initialGlobalConfig),
      locale: req.locale,
      publishAllLocalesArg: args.publishAllLocales,
    })
    const initialAllLocalesPublicationStatus = getAllLocalesPublicationStatus({
      hasLocalizedStatus: Boolean(
        req.payload.config.localization && hasLocalizeStatusEnabled(initialGlobalConfig),
      ),
      publishAllLocales: initialPublishAllLocales,
      unpublishAllLocales: Boolean(args.unpublishAllLocales),
    })

    const initialAllLocalesPublicationIntent = normalizeAllLocalesPublicationStatus({
      data: args.data,
      status: initialAllLocalesPublicationStatus,
    })
    return [req, initialGlobalConfig, initialAllLocalesPublicationIntent]
  },
  globalUpdatePublication: (
    publishAllLocalesArg: Any,
    unpublishAllLocalesArg: Any,
    draftArg: Any,
    globalConfig: Any,
    locale: Any,
    config: Any,
    data: Any,
    initialAllLocalesPublicationIntent: Any,
  ) => {
    validateAllLocalesPublicationFlags({
      publishAllLocales: publishAllLocalesArg,
      unpublishAllLocales: unpublishAllLocalesArg,
    })

    let publishAllLocales = resolvePublishAllLocales({
      draft: draftArg,
      hasLocalizeStatusEnabled: hasLocalizeStatusEnabled(globalConfig),
      locale,
      publishAllLocalesArg,
    })
    let unpublishAllLocales =
      typeof unpublishAllLocalesArg === 'string'
        ? unpublishAllLocalesArg === 'true'
        : !!unpublishAllLocalesArg
    const requestedAllLocalesPublicationStatus = getAllLocalesPublicationStatus({
      hasLocalizedStatus: Boolean(config?.localization && hasLocalizeStatusEnabled(globalConfig)),
      publishAllLocales,
      unpublishAllLocales,
    })
    const allLocalesPublicationStatus = reconcileAllLocalesPublicationStatus({
      data,
      intent: initialAllLocalesPublicationIntent,
      status: requestedAllLocalesPublicationStatus,
    })

    if (requestedAllLocalesPublicationStatus && !allLocalesPublicationStatus) {
      publishAllLocales = false
      unpublishAllLocales = false
    }

    const isSavingDraft =
      Boolean(draftArg && hasDraftsEnabled(globalConfig)) &&
      data._status !== 'published' &&
      !publishAllLocales

    if (isSavingDraft) {
      data._status = 'draft'
    }

    const submittedTopLevelFieldNames = unpublishAllLocales
      ? getTopLevelFieldNames(data)
      : undefined
    return [
      publishAllLocales,
      unpublishAllLocales,
      allLocalesPublicationStatus,
      isSavingDraft,
      submittedTopLevelFieldNames,
    ]
  },
  globalUpdateStatusAfterChange: (
    result: Any,
    publicationData: Any,
    statusFieldAccess: { value: Any },
    statusFieldValue: { value: Any },
    allLocalesPublicationStatus: Any,
    globalJSON: Any,
    config: Any,
    globalConfig: Any,
  ) => {
    const hasAuthorizedPublicationStatus = hasAuthorizedAllLocalesPublicationStatus({
      data: publicationData,
      fieldAccessDenied: !statusFieldAccess.value,
      fieldValue: statusFieldValue.value,
      status: allLocalesPublicationStatus,
    })

    if (
      allLocalesPublicationStatus &&
      !hasAuthorizedPublicationStatus &&
      typeof statusFieldValue.value === 'undefined' &&
      typeof globalJSON._status === 'object' &&
      globalJSON._status !== null
    ) {
      result._status = { ...globalJSON._status }
    }

    if (
      config?.localization &&
      hasLocalizeStatusEnabled(globalConfig) &&
      typeof result._status === 'string'
    ) {
      const statusStr = result._status

      if (
        hasAuthorizedPublicationStatus &&
        typeof globalJSON._status === 'object' &&
        globalJSON._status !== null
      ) {
        result._status = { ...globalJSON._status }
      } else {
        result._status = {}
      }

      if (!hasAuthorizedPublicationStatus) {
        for (const localeCode of config.localization.localeCodes) {
          ;(result._status as Record<string, unknown>)[localeCode] = statusStr
        }
      }
    }
    return hasAuthorizedPublicationStatus
  },
  globalValidateLocaleKeyed: (
    globalConfig: Any,
    result: Any,
    overrideAccess: Any,
    req: Any,
    payload: Any,
    globalJSON: Any,
    publicationHookDoc: Any,
    locale: Any,
  ) =>
    validateGlobalLocalWithLocaleKeyedData({
      operation: 'update',
      options: {
        slug: globalConfig.slug,
        data: result,
        draft: true,
        locale: 'all',
        overrideAccess,
        req,
      },
      payload,
      sourceData: {
        docWithLocales: globalJSON,
        originalDoc: publicationHookDoc,
        originalLocale: locale!,
      },
    }),
  globalValidationError: (errors: Any, globalConfig: Any, req: Any) =>
    new ValidationError(
      {
        errors,
        global: globalConfig.slug,
        req,
      },
      req.t,
    ),
  globalWriteArgs: (slug: Any, data: Any, req: Any, select: Any, isUpdate: boolean) =>
    isUpdate ? { slug, data, req, select } : { slug, data, req },
  hasLocalizationAndVersions: (config: Any, globalConfig: Any) =>
    config && config.localization && globalConfig.versions,
  isLocalePublished: (result: Any, locale: Any) =>
    result._status &&
    typeof result._status === 'object' &&
    !Array.isArray(result._status) &&
    (result._status as Record<string, unknown>)[locale!] === 'published',
  localeCodesOf: (filteredLocales: Any) =>
    filteredLocales.map((locale: Any) => (typeof locale === 'string' ? locale : locale.code)),
  localizedPublishResult: (result: Any, resultWithLocales: Any, now: Any) => ({
    ...result,
    createdAt: resultWithLocales.createdAt ?? result.createdAt ?? now,
    updatedAt: now,
  }),
  publicationHookDoc: (
    originalDoc: Any,
    globalJSON: Any,
    data: Any,
    allLocalesPublicationStatus: Any,
    statusFieldAccess: { value: Any } | undefined,
  ) =>
    buildAllLocalesPublicationHookDoc({
      doc: originalDoc,
      docWithLocales: globalJSON,
      status:
        statusFieldAccess === undefined
          ? data._status === allLocalesPublicationStatus
            ? allLocalesPublicationStatus
            : undefined
          : statusFieldAccess.value && data._status === allLocalesPublicationStatus
            ? allLocalesPublicationStatus
            : undefined,
    }),
  publishLocaleStatuses: (result: Any, accessibleLocaleCodes: Any, unpublishAllLocales: Any) => {
    if (typeof result._status !== 'object' || result._status === null) {
      result._status = {}
    }

    for (const localeCode of accessibleLocaleCodes) {
      result._status[localeCode] = unpublishAllLocales ? 'draft' : 'published'
    }
  },
  shouldValidateAllLocales: (
    config: Any,
    globalConfig: Any,
    publishAllLocales: Any,
    unpublishAllLocales: Any,
    hasAuthorizedPublicationStatus: Any,
  ) =>
    config?.localization &&
    hasDraftsEnabled(globalConfig) &&
    publishAllLocales &&
    !unpublishAllLocales &&
    (!hasLocalizeStatusEnabled(globalConfig) || hasAuthorizedPublicationStatus),
  stampDates: (dataToUpdate: Any) => {
    const now = new Date().toISOString()
    // Ensure global has createdAt
    if (!dataToUpdate.createdAt) {
      dataToUpdate.createdAt = now
    }

    // Ensure updatedAt date is always updated
    dataToUpdate.updatedAt = now
    return now
  },
  statusFieldAccessCell: () => {
    const statusFieldAccess: { value: unknown } = { value: false }
    // Named like the inline `onFieldAccess: (...) => ...` property of update.ts (`fn.name`).
    const onFieldAccess = ({ accessResult, path }: Any) => {
      if (path === '_status') {
        statusFieldAccess.value = accessResult
      }
    }
    return [statusFieldAccess, onFieldAccess]
  },
  withGlobalType: (resultWithLocales: Any, globalType: Any) => ({
    ...resultWithLocales,
    globalType,
  }),

  // ---------------------------------------------------------------- globals: restoreVersion
  globalRestoreAfterRead: (
    req: Any,
    depth: Any,
    result: Any,
    fallbackLocale: Any,
    globalConfig: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    showHiddenFields: Any,
  ) =>
    afterRead({
      collection: null,
      context: req.context,
      depth: depth!,
      doc: result,
      draft: undefined!,
      fallbackLocale: fallbackLocale!,
      global: globalConfig,
      locale: locale!,
      overrideAccess: overrideAccess!,
      populate,
      req,
      showHiddenFields: showHiddenFields!,
    }),
  globalRestoreFindArgs: (globalConfig: Any, req: Any, where: Any) => ({
    global: globalConfig.slug,
    limit: 1,
    req,
    where,
  }),
  globalRestoreSaveVersion: (result: Any, draft: Any, globalConfig: Any, payload: Any, req: Any) =>
    saveVersion({
      autosave: false,
      docWithLocales: result,
      draft,
      global: globalConfig,
      operation: 'restoreVersion',
      payload,
      req,
    }),
  globalRestoreVersionArgs: (args: Any) => {
    assertNoValidationWrite(args.req)

    const { id, depth, draft, globalConfig, overrideAccess, populate, showHiddenFields } = args
    const req = args.req!
    const { fallbackLocale, locale, payload } = req
    return [
      id,
      depth,
      draft,
      globalConfig,
      overrideAccess,
      populate,
      showHiddenFields,
      req,
      fallbackLocale,
      locale,
      payload,
    ]
  },
  restoredStatusesToAuthorize: (rawVersion: Any) =>
    getRestoredStatusesToAuthorize(rawVersion.version._status),
  restoreFindGlobalArgs: (globalConfig: Any, req: Any, where: Any, hasWhere: boolean) =>
    hasWhere ? { slug: globalConfig.slug, req, where } : { slug: globalConfig.slug, req },
  restorePreviousDocArgs: (globalConfig: Any, depth: Any, req: Any) => ({
    slug: globalConfig.slug,
    depth,
    overrideAccess: true,
    req,
  }),
  restoreWriteArgs: (globalConfig: Any, data: Any, req: Any) => ({
    slug: globalConfig.slug,
    data,
    req,
  }),
  statusData: (status: Any) => ({ _status: status }),
  statusesToAuthorize: (restoredStatuses: Any) =>
    restoredStatuses.length > 0 ? restoredStatuses : [undefined],
  withGlobalSlug: (result: Any, globalConfig: Any) => ({
    ...result,
    globalType: globalConfig.slug,
  }),

  // ---------------------------------------------------------------- auth: shared
  authenticateLocalStrategy: (user: Any, password: Any, payload: Any) =>
    authenticateLocalStrategy({
      doc: user,
      password,
      passwordHashIterations: payload.config.auth.passwordHashIterations,
    }),
  authenticationMetadata: (user: Any) => ({
    ...(user._sid !== undefined ? { _sid: user._sid } : {}),
    _strategy: user._strategy,
    collection: user.collection,
  }),
  /** `const { exp, token, ...session } = await createAuthToken(...)` (login) or
   * `const { token, ...session } = ...` (resetPassword). */
  authTokenParts: (value: Any, withExp: boolean) => {
    if (value === null || value === undefined) {
      throw destructureError(value, withExp ? 'exp' : 'token')
    }
    if (withExp) {
      const { exp, token, ...session } = value
      return [exp, token, session]
    }
    const { token, ...session } = value
    return [undefined, token, session]
  },
  checkLoginPermission: (loggingInWithUsername: Any, req: Any, user: Any) =>
    loggingInWithUsername === undefined
      ? checkLoginPermission({ req, user })
      : checkLoginPermission({ loggingInWithUsername, req, user }),
  createAuthToken: (collectionConfig: Any, email: Any, req: Any, user: Any) =>
    createAuthToken({
      collectionConfig,
      email: email!,
      req,
      user,
    }),
  loginHookArgs: (args: Any, user: Any, token: Any, hasToken: boolean) =>
    hasToken
      ? {
          collection: args.collection?.config,
          context: args.req.context,
          req: args.req,
          token,
          user,
        }
      : {
          collection: args.collection?.config,
          context: args.req.context,
          req: args.req,
          user,
        },
  loginResult: (exp: Any, token: Any, user: Any) => ({ exp, token, user }),
  resetLoginAttempts: (collectionConfig: Any, user: Any, req: Any) =>
    resetLoginAttempts({
      collection: collectionConfig,
      doc: user,
      payload: req.payload,
      req,
    }),
  revokeSession: (collectionConfig: Any, payload: Any, req: Any, sid: Any, user: Any) =>
    revokeSession({
      collectionConfig,
      payload,
      req,
      sid,
      user,
    }),
  userAfterRead: (
    collection: Any,
    req: Any,
    depth: Any,
    user: Any,
    overrideAccess: Any,
    showHiddenFields: Any,
  ) =>
    afterRead({
      collection,
      context: req.context,
      depth: depth!,
      doc: deepCopyObjectSimple(user),
      draft: false,
      fallbackLocale: req.fallbackLocale!,
      global: null,
      locale: req.locale!,
      overrideAccess,
      req,
      showHiddenFields,
    }),
  userAfterReadHookArgs: (collection: Any, req: Any, doc: Any, overrideAccess: Any) => ({
    collection,
    context: req.context,
    doc,
    overrideAccess,
    req,
  }),
  userFindOneArgs: (collectionConfig: Any, req: Any, where: Any) => ({
    collection: collectionConfig.slug,
    req,
    where,
  }),
  userWhere: (collectionConfig: Any, user: Any) =>
    appendNonTrashedFilter({
      enableTrash: Boolean(collectionConfig.trash),
      trash: false,
      where: {
        id: {
          equals: user.id,
        },
      },
    }),

  // ---------------------------------------------------------------- auth: access / auth / init
  adminInitTelemetry: (req: Any) => adminInitTelemetry(req),
  authArgs: (args: Any) => {
    const { canSetHeaders, headers } = args
    const req = args.req
    const { payload } = req
    return [canSetHeaders, headers, req, payload]
  },
  authResult: (permissions: Any, responseHeaders: Any, user: Any) => ({
    permissions,
    responseHeaders,
    user,
  }),
  executeAuthStrategies: (canSetHeaders: Any, headers: Any, payload: Any, req: Any) =>
    executeAuthStrategies({
      canSetHeaders,
      headers,
      payload,
      req,
    }),
  getAccessResults: (req: Any) => getAccessResults({ req }),
  initArgs: (args: Any) => {
    const { collection: slug, req } = args

    const collectionConfig = req.payload.config.collections?.find((c: Any) => c.slug === slug)

    // Exclude trashed documents unless `trash: true`
    const where = appendNonTrashedFilter({
      enableTrash: Boolean(collectionConfig?.trash),
      trash: false,
      where: {},
    })
    return [slug, req, where]
  },
  initFindArgs: (slug: Any, req: Any, where: Any) => ({ collection: slug, req, where }),

  // ---------------------------------------------------------------- auth: logout
  afterLogoutHookArgs: (args: Any, req: Any) => ({
    collection: args.collection?.config,
    context: req.context,
    req,
  }),
  logoutArgs: (incomingArgs: Any) => {
    const {
      allSessions,
      collection: { config: collectionConfig },
      req: { user },
      req,
    } = incomingArgs

    assertNoValidationWrite(req)

    if (!user) {
      throw new APIError('No User', httpStatus.BAD_REQUEST)
    }
    if (user.collection !== collectionConfig.slug) {
      throw new APIError('Incorrect collection', httpStatus.FORBIDDEN)
    }
    return [allSessions, collectionConfig, user, req]
  },
  logoutUpdateArgs: (user: Any, collectionConfig: Any, userWithSessions: Any, req: Any) => ({
    id: user.id,
    collection: collectionConfig.slug,
    data: userWithSessions,
    req,
    returning: false,
  }),
  logoutUsesSessions: (collectionConfig: Any) =>
    collectionConfig.auth.disableLocalStrategy !== true && collectionConfig.auth.useSessions,
  removeSessions: (userWithSessions: Any, allSessions: Any, req: Any) => {
    if (allSessions) {
      userWithSessions.sessions = []
    } else {
      const sessionsAfterLogout = (userWithSessions?.sessions || []).filter(
        (s: Any) => s.id !== req?.user?._sid,
      )

      userWithSessions.sessions = sessionsAfterLogout
    }

    // Prevent updatedAt from being updated when only removing a session
    userWithSessions.updatedAt = null
  },

  // ---------------------------------------------------------------- auth: me
  afterMeHookArgs: (collection: Any, req: Any, result: Any) => ({
    collection: collection?.config,
    context: req.context,
    req,
    response: result,
  }),
  meApplyHookResult: (result: Any, hookResult: Any) => {
    result.user = hookResult.user
    result.exp = hookResult.exp
  },
  meArgs: (args: Any) => {
    const { collection, currentToken, depth, draft, joins, populate, req, select } = args
    return [collection, currentToken, depth, draft, joins, populate, req, select]
  },
  meDefaultUser: (result: Any, user: Any, currentToken: Any, collection: Any) => {
    result.user = user

    if (currentToken) {
      const decoded = decodeJwt(currentToken)
      if (decoded) {
        result.exp = decoded.exp
      }
      if (!collection.config.auth.removeTokenFromResponses) {
        result.token = currentToken
      }
    }
  },
  meEmptyResult: () => ({ user: null }),
  meFindByID: (
    req: Any,
    collection: Any,
    depth: Any,
    draft: Any,
    joins: Any,
    populate: Any,
    select: Any,
  ) => {
    const { pathname } = req
    const isGraphQL = pathname === `/api${req.payload.config.routes.graphQL}`

    return req.payload.findByID({
      id: req.user.id,
      collection: collection.config.slug,
      depth: isGraphQL ? 0 : (depth ?? collection.config.auth.depth),
      draft,
      joins,
      overrideAccess: false,
      populate,
      req,
      select,
      showHiddenFields: false,
    })
  },
  meHookArgs: (args: Any, user: Any) => ({ args, user }),
  meUserMetadata: (user: Any, collection: Any, req: Any) => {
    user.collection = collection.config.slug
    user._strategy = req.user._strategy
  },

  // ---------------------------------------------------------------- auth: verifyEmail
  verificationWhere: (collection: Any, token: Any) =>
    appendNonTrashedFilter({
      enableTrash: Boolean(collection.config.trash),
      trash: false,
      where: {
        _verificationToken: { equals: token },
      },
    }),
  verifyEmailArgs: (args: Any) => {
    const { collection, req, token } = args

    assertNoValidationWrite(req)

    if (collection.config.auth.disableLocalStrategy) {
      throw new Forbidden(req.t)
    }
    if (!Object.prototype.hasOwnProperty.call(args, 'token')) {
      throw new APIError('Missing required data.', httpStatus.BAD_REQUEST)
    }
    return [collection, req, token]
  },
  verifyEmailUpdateArgs: (user: Any, collection: Any, req: Any) => ({
    id: user.id,
    collection: collection.config.slug,
    data: {
      ...user,
      _verificationToken: null,
      _verified: true,
    },
    req,
    returning: false,
  }),

  // ---------------------------------------------------------------- auth: login
  incrementLoginAttempts: (collectionConfig: Any, req: Any, user: Any) =>
    incrementLoginAttempts({
      collection: collectionConfig,
      payload: req.payload,
      user,
    }),
  lockStateFindArgs: (collectionConfig: Any, req: Any, user: Any) => ({
    collection: collectionConfig.slug,
    req,
    select: {
      lockUntil: true,
      loginAttempts: true,
    },
    where: { id: { equals: user.id } },
  }),
  loginArgs: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      data,
      depth,
      overrideAccess = false,
      req,
      req: { payload },
      showHiddenFields,
    } = args
    return [collectionConfig, data, depth, overrideAccess, req, payload, showHiddenFields]
  },
  logRehashFailure: (payload: Any, err: Any) => {
    payload.logger.error({ err, msg: 'Failed to update the stored password hash' })
  },
  /** login.ts from `const { email: unsanitizedEmail, password } = data` to the trash filter. */
  loginPrepare: (collectionConfig: Any, data: Any, req: Any) => {
    const { email: unsanitizedEmail, password } = data
    const loginWithUsername = collectionConfig.auth.loginWithUsername

    const sanitizedEmail =
      typeof unsanitizedEmail === 'string' ? unsanitizedEmail.toLowerCase().trim() : null
    const sanitizedUsername =
      'username' in data && typeof data?.username === 'string'
        ? data.username.toLowerCase().trim()
        : null

    const { canLoginWithEmail, canLoginWithUsername } = getLoginOptions(loginWithUsername)

    // cannot login with email, did not provide username
    if (!canLoginWithEmail && !sanitizedUsername) {
      throw new ValidationError({
        collection: collectionConfig.slug,
        errors: [{ message: req.i18n.t('validation:required'), path: 'username' }],
      })
    }

    // cannot login with username, did not provide email
    if (!canLoginWithUsername && !sanitizedEmail) {
      throw new ValidationError({
        collection: collectionConfig.slug,
        errors: [{ message: req.i18n.t('validation:required'), path: 'email' }],
      })
    }

    // can login with either email or username, did not provide either
    if (!sanitizedUsername && !sanitizedEmail) {
      throw new ValidationError({
        collection: collectionConfig.slug,
        errors: [
          { message: req.i18n.t('validation:required'), path: 'email' },
          { message: req.i18n.t('validation:required'), path: 'username' },
        ],
      })
    }

    // did not provide password for login
    if (typeof password !== 'string' || password.trim() === '') {
      throw new ValidationError({
        collection: collectionConfig.slug,
        errors: [{ message: req.i18n.t('validation:required'), path: 'password' }],
      })
    }

    let whereConstraint: Any = {}
    const emailConstraint = {
      email: {
        equals: sanitizedEmail,
      },
    }
    const usernameConstraint = {
      username: {
        equals: sanitizedUsername,
      },
    }

    if (canLoginWithEmail && canLoginWithUsername && (sanitizedUsername || sanitizedEmail)) {
      if (sanitizedUsername) {
        whereConstraint = {
          or: [
            usernameConstraint,
            {
              email: {
                equals: sanitizedUsername,
              },
            },
          ],
        }
      } else {
        whereConstraint = {
          or: [
            emailConstraint,
            {
              username: {
                equals: sanitizedEmail,
              },
            },
          ],
        }
      }
    } else if (canLoginWithEmail && sanitizedEmail) {
      whereConstraint = emailConstraint
    } else if (canLoginWithUsername && sanitizedUsername) {
      whereConstraint = usernameConstraint
    }

    // Exclude trashed users
    whereConstraint = appendNonTrashedFilter({
      enableTrash: collectionConfig.trash,
      trash: false,
      where: whereConstraint,
    })
    return [canLoginWithUsername, sanitizedEmail, sanitizedUsername, password, whereConstraint]
  },
  maxLoginAttemptsEnabled: (args: Any) => args.collection.config.auth.maxLoginAttempts > 0,
  rehashPassword: (collectionConfig: Any, password: Any, req: Any) =>
    generatePasswordSaltHash({
      collection: collectionConfig,
      isPasswordAuthenticated: true,
      password,
      req,
    }),
  rehashUpdateArgs: (
    collectionConfig: Any,
    hash: Any,
    salt: Any,
    req: Any,
    user: Any,
    authenticatedHash: Any,
    authenticatedSalt: Any,
  ) => ({
    collection: collectionConfig.slug,
    data: { hash, salt },
    req,
    select: { id: true },
    where: {
      id: { equals: user.id },
      hash: { equals: authenticatedHash },
      salt: { equals: authenticatedSalt },
    },
  }),

  // ---------------------------------------------------------------- auth: refresh
  afterRefreshHookArgs: (args: Any, result: Any) => ({
    collection: args.collection?.config,
    context: args.req.context,
    exp: result.exp,
    req: args.req,
    token: result.refreshedToken,
  }),
  extendSession: (collectionConfig: Any, req: Any, sid: Any, user: Any) =>
    extendSession({ collectionConfig, req, sid, user }),
  jwtSign: (fieldsToSign: Any, secret: Any, collectionConfig: Any) =>
    jwtSign({
      fieldsToSign,
      secret,
      tokenExpiration: collectionConfig.auth.tokenExpiration,
    }),
  refreshArgs: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      req,
      req: {
        payload: { config, secret },
      },
    } = args
    return [collectionConfig, req, config, secret]
  },
  refreshFieldsToSign: (collectionConfig: Any, user: Any, sid: Any, args: Any) =>
    getFieldsToSign({
      collectionConfig,
      email: user?.email as string,
      sid,
      user: args.req.user,
    }),
  refreshFindArgs: (collectionConfig: Any, req: Any, args: Any) => ({
    collection: collectionConfig.slug,
    req,
    where: { id: { equals: args.req.user.id } },
  }),
  refreshFindTrashedArgs: (collectionConfig: Any, req: Any, user: Any) => ({
    collection: collectionConfig.slug,
    locale: req.locale ?? undefined,
    req,
    where: appendNonTrashedFilter({
      enableTrash: Boolean(collectionConfig.trash),
      trash: false,
      where: { id: { equals: user.id } },
    }),
  }),
  refreshHookArgs: (args: Any, user: Any) => ({ args, user }),
  refreshIsGraphQL: (args: Any, config: Any) => {
    const pathname = new URL(args.req.url!).pathname

    return pathname === config.routes.graphQL
  },
  refreshResult: (exp: Any, refreshedToken: Any, user: Any) => ({
    exp,
    refreshedToken,
    setCookie: true,
    user,
  }),
  usesSessions: (collectionConfig: Any) =>
    collectionConfig.auth.useSessions && !collectionConfig.auth.disableLocalStrategy,

  // ---------------------------------------------------------------- auth: forgotPassword
  afterForgotPasswordHookArgs: (args: Any, req: Any) => ({
    args,
    collection: args.collection?.config,
    context: req.context,
  }),
  emailHookArgs: (req: Any, token: Any, user: Any) => ({ req, token, user }),
  forgotPasswordHTML: (config: Any, req: Any, token: Any) => {
    const serverURL = getRequestOrigin({ config, req })
    const forgotURL = formatAdminURL({
      adminRoute: config.routes.admin,
      path: `${config.admin.routes.reset}/${token}`,
      serverURL,
    })
    const html = `${req.t('authentication:youAreReceivingResetPassword')}
    <a href="${forgotURL}">${forgotURL}</a>
    ${req.t('authentication:youDidNotRequestPassword')}`
    return html
  },
  forgotPasswordPrelude: (incomingArgs: Any) => {
    assertNoValidationWrite(incomingArgs.req)

    const loginWithUsername = incomingArgs.collection.config.auth.loginWithUsername
    const { data, overrideAccess } = incomingArgs

    const { canLoginWithEmail, canLoginWithUsername } = getLoginOptions(loginWithUsername)

    const sanitizedEmail =
      (canLoginWithEmail && (incomingArgs.data.email || '').toLowerCase().trim()) || null
    const sanitizedUsername =
      'username' in data && typeof data?.username === 'string'
        ? data.username.toLowerCase().trim()
        : null

    if (incomingArgs.collection.config.auth.disableLocalStrategy) {
      throw new Forbidden(incomingArgs.req.t)
    }
    if (!sanitizedEmail && !sanitizedUsername) {
      throw new APIError(
        `Missing ${loginWithUsername ? 'username' : 'email'}.`,
        httpStatus.BAD_REQUEST,
      )
    }
    return [
      data,
      overrideAccess,
      canLoginWithEmail,
      canLoginWithUsername,
      sanitizedEmail,
      sanitizedUsername,
    ]
  },
  forgotPasswordSetup: (
    args: Any,
    canLoginWithEmail: Any,
    sanitizedEmail: Any,
    canLoginWithUsername: Any,
    sanitizedUsername: Any,
  ) => {
    const {
      collection: { config: collectionConfig },
      disableEmail,
      expiration,
      req: {
        payload: { config, email },
        payload,
      },
      req,
    } = args
    const minRequestInterval = collectionConfig.auth.forgotPassword.minRequestInterval ?? 15000

    let whereConstraint: Any = {}

    if (canLoginWithEmail && sanitizedEmail) {
      whereConstraint = {
        email: {
          equals: sanitizedEmail,
        },
      }
    } else if (canLoginWithUsername && sanitizedUsername) {
      whereConstraint = {
        username: {
          equals: sanitizedUsername,
        },
      }
    }

    // Exclude trashed users unless `trash: true`
    whereConstraint = appendNonTrashedFilter({
      enableTrash: collectionConfig.trash,
      trash: false,
      where: whereConstraint,
    })

    const now = Date.now()
    const token: string = crypto.randomBytes(20).toString('hex')
    const resetPasswordExpiration = new Date(
      now + (collectionConfig.auth?.forgotPassword?.expiration ?? expiration ?? 3600000),
    ).toISOString()
    return [
      collectionConfig,
      disableEmail,
      expiration,
      config,
      email,
      payload,
      req,
      minRequestInterval,
      whereConstraint,
      now,
      token,
      resetPasswordExpiration,
      !disableEmail && minRequestInterval > 0,
    ]
  },
  logReleaseFailure: (args: Any, err: Any) => {
    args.req.payload.logger.error({ err, msg: 'Failed to release forgot-password interval' })
  },
  releaseRequestArgs: (
    collectionConfig: Any,
    reservationReq: Any,
    userID: Any,
    requestedAt: Any,
  ) => ({
    collection: collectionConfig.slug,
    data: { resetPasswordRequestedAt: null },
    options: { atomic: true },
    req: reservationReq,
    where: {
      and: [{ id: { equals: userID } }, { resetPasswordRequestedAt: { equals: requestedAt } }],
    },
  }),
  reservationRequest: (now: Any, req: Any) => {
    const requestedAt = new Date(now).toISOString()
    const reservationReq = isolateObjectProperty(req, 'transactionID')
    reservationReq.transactionID = undefined
    return [requestedAt, reservationReq]
  },
  reserveRequestArgs: (
    collectionConfig: Any,
    requestedAt: Any,
    reservationReq: Any,
    whereConstraint: Any,
    now: Any,
    minRequestInterval: Any,
  ) => ({
    collection: collectionConfig.slug,
    data: {
      resetPasswordRequestedAt: requestedAt,
    },
    options: { atomic: true },
    req: reservationReq,
    where: {
      and: [
        whereConstraint,
        {
          or: [
            { resetPasswordRequestedAt: { exists: false } },
            { resetPasswordRequestedAt: { equals: null } },
            {
              resetPasswordRequestedAt: {
                less_than_equal: new Date(now - minRequestInterval).toISOString(),
              },
            },
          ],
        },
      ],
    },
  }),
  resetEmailArgs: (email: Any, html: Any, subject: Any, user: Any) => ({
    from: `"${email.defaultFromName}" <${email.defaultFromAddress}>`,
    html,
    subject,
    to: user.email,
  }),
  resetTokenUpdateArgs: (
    user: Any,
    collectionConfig: Any,
    resetPasswordExpiration: Any,
    token: Any,
    req: Any,
  ) => ({
    id: user.id,
    collection: collectionConfig.slug,
    data: {
      resetPasswordExpiration,
      resetPasswordToken: token,
    },
    overrideAccess: true,
    req,
  }),
  translate: (req: Any, key: string) => req.t(key),

  // ---------------------------------------------------------------- auth: resetPassword
  authenticateWith: (doc: Any, data: Any, payload: Any) =>
    authenticateLocalStrategy({
      doc,
      password: data.password,
      passwordHashIterations: payload.config.auth.passwordHashIterations,
    }),
  createAuthTokenFor: (collectionConfig: Any, user: Any, req: Any) =>
    createAuthToken({
      collectionConfig,
      email: user.email!,
      req,
      user,
    }),
  findPasswordField: (collectionConfig: Any) =>
    collectionConfig.flattenedFields.find((field: Any) => field.name === 'password'),
  hashPassword: (collectionConfig: Any, data: Any, req: Any) =>
    generatePasswordSaltHash({
      collection: collectionConfig,
      password: data.password,
      req,
    }),
  hasValidate: (passwordField: Any) =>
    !(!passwordField || !('validate' in passwordField) || !passwordField.validate),
  passwordValidateOptions: (
    passwordField: Any,
    user: Any,
    password: Any,
    collectionConfig: Any,
    overrideAccess: Any,
    req: Any,
  ) => {
    const dataToValidate = { ...user, password }

    return {
      ...passwordField,
      id: user.id,
      blockData: {},
      collectionSlug: collectionConfig.slug,
      data: dataToValidate,
      event: 'submit',
      operation: 'update',
      overrideAccess,
      path: ['password'],
      preferences: { fields: {} },
      req,
      siblingData: dataToValidate,
    }
  },
  passwordValidationError: (collectionConfig: Any, validationResult: Any) =>
    new ValidationError({
      collection: collectionConfig.slug,
      errors: [{ message: validationResult, path: 'password' }],
    }),
  resetPasswordApply: (user: Any, salt: Any, hash: Any, collectionConfig: Any) => {
    user.salt = salt
    user.hash = hash

    user.resetPasswordExpiration = new Date().toISOString()

    if (collectionConfig.auth.maxLoginAttempts > 0) {
      user.lockUntil = null
      user.loginAttempts = 0
    }

    if (collectionConfig.auth.verify) {
      user._verified = Boolean(user._verified)
    }
  },
  resetPasswordArgs: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      data,
      depth,
      overrideAccess = false,
      req: { payload },
      req,
    } = args

    assertNoValidationWrite(req)

    if (
      !Object.prototype.hasOwnProperty.call(data, 'token') ||
      !Object.prototype.hasOwnProperty.call(data, 'password')
    ) {
      throw new APIError('Missing required data.', httpStatus.BAD_REQUEST)
    }

    if (collectionConfig.auth.disableLocalStrategy) {
      throw new Forbidden(req.t)
    }
    return [collectionConfig, data, depth, overrideAccess, payload, req]
  },
  resetPasswordBeforeUpdate: (user: Any, collectionConfig: Any) => {
    // Ensure updatedAt date is always updated
    user.updatedAt = new Date().toISOString()

    if (collectionConfig.auth.useSessions) {
      user.sessions = []
    }
  },
  resetPasswordBeforeValidateArgs: (args: Any, req: Any, user: Any) => ({
    collection: args.collection?.config,
    context: req.context,
    data: user,
    operation: 'update',
    req,
  }),
  resetPasswordUpdateArgs: (user: Any, collectionConfig: Any, req: Any) => ({
    id: user.id,
    collection: collectionConfig.slug,
    data: user,
    req,
  }),
  resetPasswordWhere: (collectionConfig: Any, data: Any) =>
    appendNonTrashedFilter({
      enableTrash: Boolean(collectionConfig.trash),
      trash: false,
      where: {
        resetPasswordExpiration: { greater_than: new Date().toISOString() },
        resetPasswordToken: { equals: data.token },
      },
    }),
  tokenUserResult: (token: Any, user: Any) => ({ token, user }),

  // ---------------------------------------------------------------- auth: registerFirstUser
  ensureUsernameOrEmail: (config: Any, slug: Any, data: Any, req: Any) =>
    ensureUsernameOrEmail({
      authOptions: config.auth,
      collectionSlug: slug,
      data,
      operation: 'create',
      req,
    }),
  noTrashedWhere: (config: Any) =>
    appendNonTrashedFilter({
      enableTrash: Boolean(config.trash),
      trash: false,
      where: {}, // no initial filter; just exclude trashed docs
    }),
  registerCreateArgs: (slug: Any, data: Any, req: Any) => ({
    collection: slug,
    data,
    overrideAccess: true,
    req,
  }),
  registerFirstUserArgs: (args: Any) => {
    const {
      collection: {
        config,
        config: {
          slug,
          auth: { verify },
        },
      },
      data,
      req,
      req: { payload },
    } = args

    if (config.auth.disableLocalStrategy) {
      throw new Forbidden(req.t)
    }
    return [config, slug, verify, data, req, payload]
  },
  registerLoginArgs: (args: Any, slug: Any, req: Any) => ({
    ...args,
    collection: slug,
    overrideAccess: false,
    req,
  }),
  registerVerifyArgs: (result: Any, slug: Any, req: Any) => ({
    id: result.id,
    collection: slug,
    data: {
      _verified: true,
    },
    overrideAccess: true,
    req,
  }),

  // ---------------------------------------------------------------- auth: unlock
  unlockFindArgs: (collectionConfig: Any, locale: Any, req: Any, whereConstraint: Any) => ({
    collection: collectionConfig.slug,
    locale: locale!,
    req,
    where: whereConstraint,
  }),
  unlockPrelude: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      overrideAccess,
      req: { locale },
      req,
    } = args

    const loginWithUsername = collectionConfig.auth.loginWithUsername

    const { canLoginWithEmail, canLoginWithUsername } = getLoginOptions(loginWithUsername)

    const sanitizedEmail = canLoginWithEmail && (args.data?.email || '').toLowerCase().trim()
    const sanitizedUsername =
      (canLoginWithUsername &&
        'username' in args.data &&
        typeof args.data.username === 'string' &&
        args.data.username.toLowerCase().trim()) ||
      null

    if (collectionConfig.auth.disableLocalStrategy) {
      throw new Forbidden(req.t)
    }
    if (!sanitizedEmail && !sanitizedUsername) {
      throw new APIError(
        `Missing ${collectionConfig.auth.loginWithUsername ? 'username' : 'email'}.`,
        httpStatus.BAD_REQUEST,
      )
    }
    return [
      collectionConfig,
      overrideAccess,
      locale,
      req,
      canLoginWithEmail,
      canLoginWithUsername,
      sanitizedEmail,
      sanitizedUsername,
    ]
  },
  unlockWhere: (
    whereConstraint: Any,
    canLoginWithEmail: Any,
    sanitizedEmail: Any,
    canLoginWithUsername: Any,
    sanitizedUsername: Any,
    collectionConfig: Any,
  ) => {
    if (canLoginWithEmail && sanitizedEmail) {
      whereConstraint = combineQueries(whereConstraint, {
        email: {
          equals: sanitizedEmail,
        },
      })
    } else if (canLoginWithUsername && sanitizedUsername) {
      whereConstraint = combineQueries(whereConstraint, {
        username: {
          equals: sanitizedUsername,
        },
      })
    }

    // Exclude trashed users unless `trash: true`
    return appendNonTrashedFilter({
      enableTrash: Boolean(collectionConfig.trash),
      trash: false,
      where: whereConstraint,
    })
  },
})
