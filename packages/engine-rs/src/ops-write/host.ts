/**
 * JS helpers of the Rust collection write operations (crates/payload-core-ops-write, looked up by
 * name from `crates/payload-core-ops-write/src/*.rs`). Each helper is one TS expression or
 * synchronous statement sequence of the upstream operation (create.ts, update.ts, updateByID.ts,
 * utilities/update.ts, delete.ts, deleteByID.ts, duplicate.ts, restoreVersion.ts, validate.ts),
 * evaluated at the point where the operation evaluates it:
 *
 * - object literals handed to user code, adapters or upstream utilities (same key order, same
 *   property-read order),
 * - destructuring patterns of the operations (same defaults, getter order and V8 errors),
 * - upstream utilities that are called rather than ported (transactions, uploads and file
 *   versioning, versions, auth crypto and emails, locked documents, query utilities, errors),
 * - synchronous segments without user callbacks (publication status bookkeeping, spreads).
 *
 * Control flow (hooks, access, field traversals, awaits, branches, try/catch/finally) stays in
 * Rust. Payload internals are imported by relative path, like `../ops`.
 */
import crypto, { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { ensureUsernameOrEmail } from '../../../payload/src/auth/ensureUsernameOrEmail.js'
import { sendVerificationEmail } from '../../../payload/src/auth/sendVerificationEmail.js'
import { removeExpiredSessions } from '../../../payload/src/auth/sessions.js'
import { generatePasswordSaltHash } from '../../../payload/src/auth/strategies/local/generatePasswordSaltHash.js'
import { registerLocalStrategy } from '../../../payload/src/auth/strategies/local/register.js'
import { hasWhereAccessResult } from '../../../payload/src/auth/types.js'
import { createOperation } from '../../../payload/src/collections/operations/create.js'
import { validateLocalWithLocaleKeyedData } from '../../../payload/src/collections/operations/local/validate.js'
import { copyDataWithFreshRowIDs } from '../../../payload/src/collections/operations/utilities/copyDataWithFreshRowIDs.js'
import { validateUniqueConstraints } from '../../../payload/src/collections/operations/utilities/validateUniqueConstraints.js'
import { combineQueries } from '../../../payload/src/database/combineQueries.js'
import { validateQueryPaths } from '../../../payload/src/database/queryValidation/validateQueryPaths.js'
import { validateSortQuery } from '../../../payload/src/database/queryValidation/validateSortQuery.js'
import { sanitizeWhereQuery } from '../../../payload/src/database/sanitizeWhereQuery.js'
import { getDuplicateDocumentData } from '../../../payload/src/duplicateDocument/index.js'
import { APIError } from '../../../payload/src/errors/APIError.js'
import { Forbidden } from '../../../payload/src/errors/Forbidden.js'
import { Locked } from '../../../payload/src/errors/Locked.js'
import { NotFound } from '../../../payload/src/errors/NotFound.js'
import { ValidationError } from '../../../payload/src/errors/ValidationError.js'
import { fillEmptyLocalizedSlugs } from '../../../payload/src/fields/baseFields/slug/fillEmptyLocalizedSlugs.js'
import { deleteUserPreferences } from '../../../payload/src/preferences/deleteUserPreferences.js'
import { deleteAssociatedFiles } from '../../../payload/src/uploads/deleteAssociatedFiles.js'
import { runLocalFileUpdate } from '../../../payload/src/uploads/fileVersioning/archive.js'
import {
  collectStoredFiles,
  collectVersionFiles,
  removeUnreferencedStagedObjects,
  scheduleUnreferencedFileCleanup,
} from '../../../payload/src/uploads/fileVersioning/cleanup.js'
import {
  captureCloudHookState,
  runCloudFileCreation,
  runCloudFileUpdate,
} from '../../../payload/src/uploads/fileVersioning/cloudStorage.js'
import {
  abortFileOperationScope,
  beginFileOperationScope,
  completeFileOperationScope,
  runFileCreationPlan,
  shareFileOperationScope,
  stageLocalUploadFiles,
} from '../../../payload/src/uploads/fileVersioning/fileOperationManager.js'
import { runStoredFileRestore } from '../../../payload/src/uploads/fileVersioning/restore.js'
import { withLegacyCloudUploadFileData } from '../../../payload/src/uploads/fileVersioning/storedFiles.js'
import { generateFileData } from '../../../payload/src/uploads/generateFileData.js'
import {
  getExternalUploadSource,
  getLocalizedUploadProperties,
  getUploadDestination,
  mergeUploadDataWithDocument,
  restoreUploadDataFromDocument,
  sanitizeUploadData,
} from '../../../payload/src/uploads/sanitizeUploadData.js'
import { unlinkTempFiles } from '../../../payload/src/uploads/unlinkTempFiles.js'
import { uploadFiles } from '../../../payload/src/uploads/uploadFiles.js'
import { appendNonTrashedFilter } from '../../../payload/src/utilities/appendNonTrashedFilter.js'
import { assertNoValidationWrite } from '../../../payload/src/utilities/assertNoValidationWrite.js'
import {
  checkDocumentLockStatus,
  deleteDocumentLocks,
  getLockedDocumentIds,
} from '../../../payload/src/utilities/checkDocumentLockStatus.js'
import { commitTransaction } from '../../../payload/src/utilities/commitTransaction.js'
import { deepCopyObjectSimple } from '../../../payload/src/utilities/deepCopyObject.js'
import { deepMergeWithSourceArraysIgnoringUndefined } from '../../../payload/src/utilities/deepMerge.js'
import { flattenDataByLocale } from '../../../payload/src/utilities/flattenDataByLocale.js'
import { getTopLevelFieldNames } from '../../../payload/src/utilities/getTopLevelFieldNames.js'
import {
  hasDraftsEnabled,
  hasDraftValidationEnabled,
  hasLocalizeStatusEnabled,
  hasScheduledPublishEnabled,
} from '../../../payload/src/utilities/getVersionsConfig.js'
import { httpStatus } from '../../../payload/src/utilities/httpStatus.js'
import { initTransaction } from '../../../payload/src/utilities/initTransaction.js'
import { isErrorPublic } from '../../../payload/src/utilities/isErrorPublic.js'
import { isolateObjectProperty } from '../../../payload/src/utilities/isolateObjectProperty.js'
import { killTransaction } from '../../../payload/src/utilities/killTransaction.js'
import { resolvePublishAllLocales } from '../../../payload/src/utilities/resolvePublishAllLocales.js'
import { resolveSelect } from '../../../payload/src/utilities/resolveSelect.js'
import { sanitizeInternalFields } from '../../../payload/src/utilities/sanitizeInternalFields.js'
import { sanitizeSelect } from '../../../payload/src/utilities/sanitizeSelect.js'
import { skipCompilation } from '../../../payload/src/utilities/skipCompilation.js'
import { toValidationResult } from '../../../payload/src/utilities/toValidationResult.js'
import {
  buildAllLocalesPublicationHookDoc,
  getAllLocalesPublicationStatus,
  hasAuthorizedAllLocalesPublicationStatus,
  normalizeAllLocalesPublicationStatus,
  reconcileAllLocalesPublicationStatus,
  validateAllLocalesPublicationFlags,
} from '../../../payload/src/versions/allLocalesPublicationStatus.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { buildLocalizedPublishData } from '../../../payload/src/versions/buildSingleLocalePublishData.js'
import { deleteCollectionVersions } from '../../../payload/src/versions/deleteCollectionVersions.js'
import { deleteScheduledPublishJobs } from '../../../payload/src/versions/deleteScheduledPublishJobs.js'
import { appendVersionToQueryKey } from '../../../payload/src/versions/drafts/appendVersionToQueryKey.js'
import { getQueryDraftsSort } from '../../../payload/src/versions/drafts/getQueryDraftsSort.js'
import { getLatestCollectionVersion } from '../../../payload/src/versions/getLatestCollectionVersion.js'
import { getRestoredStatusesToAuthorize } from '../../../payload/src/versions/getRestoredStatusesToAuthorize.js'
import { saveVersion } from '../../../payload/src/versions/saveVersion.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the helpers mirror untyped TS expressions */
type Any = any

/** The internal `let` locals the upstream arrows `onFieldAccess` / `onDataProcessed` assign. */
type StatusCell = { statusFieldAccess: Any; statusFieldValue: Any }

/** `(locale === 'all' || !locale) ? (localization ? defaultLocale : undefined) : locale` */
const uploadLocale = (locale: Any, config: Any) =>
  locale === 'all' || !locale
    ? config.localization
      ? config.localization.defaultLocale
      : undefined
    : locale

export const createOpsWriteHost = (traversals?: Record<string, Any>): Record<string, unknown> => ({
  traversals,

  // ---------------------------------------------------------------- generic
  /** `{ ...v }` */
  spread: (v: Any) => ({ ...v }),
  /** `[...a, ...b]` */
  concatSpread: (a: Any, b: Any) => [...a, ...b],
  /** `{ ...doc, collection: collectionConfig.slug }` */
  withCollection: (doc: Any, collectionConfig: Any) => ({
    ...doc,
    collection: collectionConfig.slug,
  }),
  /** `const { data, files } = <result>` (generateFileData) */
  dataAndFiles: ({ data, files }: Any) => [data, files],
  /** `const [first] = arr` */
  createOperationFn: () => createOperation,
  deepCopyObjectSimple: (v: Any) => deepCopyObjectSimple(v),
  firstOf: (arr: Any) => {
    const [first] = arr
    return first
  },
  hasLocalizeStatusEnabled: (collectionConfig: Any) => hasLocalizeStatusEnabled(collectionConfig),
  hasScheduledPublishEnabled: (collectionConfig: Any) =>
    hasScheduledPublishEnabled(collectionConfig),
  hasWhereAccessResult: (result: Any) => hasWhereAccessResult(result),
  idWhere: (id: Any) => ({ id: { equals: id } }),
  newMap: () => new Map(),
  newSet: () => new Set(),
  sanitizeInternalFields: (doc: Any) => sanitizeInternalFields(doc),

  // ---------------------------------------------------------------- errors
  bulkDeleteDisabled: (args: Any) =>
    new APIError(`Collection ${args.collection.config.slug} has disabled bulk delete`, 403),
  bulkEditDisabled: (args: Any) =>
    new APIError(`Collection ${args.collection.config.slug} has disabled bulk edit`, 403),
  cannotDuplicate: (collectionConfig: Any) =>
    new APIError(
      `The collection with slug ${String(collectionConfig.slug)} cannot be duplicated.`,
      400,
    ),
  createValidationError: (collectionConfig: Any, validationResult: Any, req: Any) =>
    new ValidationError(
      {
        collection: collectionConfig.slug,
        errors: validationResult.errors,
        req,
      },
      req.t,
    ),
  forbidden: (t: Any) => new Forbidden(t),
  missingDeleteWhere: () =>
    new APIError("Missing 'where' query of documents to delete.", httpStatus.BAD_REQUEST),
  missingRestoreVersionID: () =>
    new APIError('Missing ID of version to restore.', httpStatus.BAD_REQUEST),
  missingUpdateID: () => new APIError('Missing ID of document to update.', httpStatus.BAD_REQUEST),
  missingUpdateWhere: () =>
    new APIError("Missing 'where' query of documents to update.", httpStatus.BAD_REQUEST),
  notFound: (t: Any) => new NotFound(t),
  restoreTrashed: (parentDocID: Any) =>
    new APIError(
      `Cannot restore a version of a trashed document (ID: ${parentDocID}). Restore the document first.`,
      httpStatus.FORBIDDEN,
    ),
  updateValidationError: (id: Any, collectionConfig: Any, validationResult: Any, req: Any) =>
    new ValidationError(
      {
        id,
        collection: collectionConfig.slug,
        errors: validationResult.errors,
        req,
      },
      req.t,
    ),

  // ---------------------------------------------------------------- transactions / scopes
  abortFileOperationScope: (req: Any) => abortFileOperationScope({ req }),
  assertNoValidationWrite: (req: Any) => assertNoValidationWrite(req),
  beginFileOperationScope: (req: Any) => beginFileOperationScope({ req }),
  commitTransaction: (req: Any) => commitTransaction(req),
  completeFileOperationScope: (req: Any) => completeFileOperationScope({ req }),
  initTransaction: (req: Any) => initTransaction(req),
  killTransaction: (req: Any) => killTransaction(req),
  shareFileOperationScope: (owner: Any, req: Any) => shareFileOperationScope({ owner, req }),
  /** `await unlinkTempFiles({ collectionConfig, config, req }).catch(log)` */
  unlinkTempFilesCaught: (collectionConfig: Any, config: Any, req: Any) =>
    unlinkTempFiles({
      collectionConfig,
      config,
      req,
    }).catch((unlinkError) => {
      req.payload.logger.error({ err: unlinkError, msg: 'Failed to remove temp file' })
    }),
  unlinkTempFilesOnError: (args: Any) =>
    unlinkTempFiles({
      collectionConfig: args.collection.config,
      config: args.req.payload.config,
      req: args.req,
    }).catch((unlinkError) => {
      args.req.payload.logger.error({ err: unlinkError, msg: 'Failed to remove temp file' })
    }),

  // ---------------------------------------------------------------- hook / traversal args
  /** beforeValidate / beforeChange collection hooks (create, updateDocument) */
  afterChangeArgs: (
    collection: Any,
    req: Any,
    data: Any,
    doc: Any,
    operation: Any,
    previousDoc: Any,
  ) => ({
    collection,
    context: req.context,
    data,
    doc,
    global: null,
    operation,
    previousDoc,
    req,
  }),
  afterDeleteHookArgs: (id: Any, collection: Any, req: Any, doc: Any) => ({
    id,
    collection,
    context: req.context,
    doc,
    req,
    skipCompilation,
  }),
  afterReadHookArgs: (collection: Any, req: Any, doc: Any, overrideAccess: Any) => ({
    collection,
    context: req.context,
    doc,
    overrideAccess,
    req,
    skipCompilation,
  }),
  beforeDeleteHookArgs: (id: Any, collection: Any, req: Any) => ({
    id,
    collection,
    context: req.context,
    req,
    skipCompilation,
  }),
  createAfterChangeHookArgs: (
    collection: Any,
    req: Any,
    data: Any,
    doc: Any,
    overrideAccess: Any,
    args: Any,
    select: Any,
  ) => ({
    collection,
    context: req.context,
    data,
    doc,
    operation: 'create',
    overrideAccess,
    previousDoc: {},
    req: args.req,
    select,
    skipCompilation,
  }),
  dataHookArgs: (collection: Any, req: Any, data: Any, operation: Any, originalDoc: Any) => ({
    collection,
    context: req.context,
    data,
    operation,
    originalDoc,
    req,
    skipCompilation,
  }),
  updateAfterChangeHookArgs: (
    collection: Any,
    req: Any,
    data: Any,
    doc: Any,
    overrideAccess: Any,
    previousDoc: Any,
    select: Any,
  ) => ({
    collection,
    context: req.context,
    data,
    doc,
    operation: 'update',
    overrideAccess,
    previousDoc,
    req,
    select,
    skipCompilation,
  }),
  /** afterRead fields with `draft: undefined` (delete, deleteByID, restoreVersion) */
  afterReadArgsWithoutDraft: (
    collection: Any,
    req: Any,
    depth: Any,
    doc: Any,
    fallbackLocale: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) => ({
    collection,
    context: req.context,
    depth,
    doc,
    draft: undefined,
    fallbackLocale,
    global: null,
    locale,
    overrideAccess,
    populate,
    req,
    select,
    showHiddenFields,
  }),
  writeSelect: (collectionConfig: Any, operation: Any, req: Any, incomingSelect: Any) =>
    sanitizeSelect({
      fields: collectionConfig.flattenedFields,
      select: resolveSelect({
        config: collectionConfig.select,
        operation,
        req,
        select: incomingSelect,
      }),
    }),

  // ---------------------------------------------------------------- publication status
  callFilterAvailableLocales: (config: Any, req: Any) =>
    config.localization.filterAvailableLocales({
      locales: config.localization.locales,
      req,
    }),
  localeCodesOf: (filteredLocales: Any) =>
    filteredLocales.map((locale: Any) => (typeof locale === 'string' ? locale : locale.code)),
  localizedStatusEnabled: (config: Any, collectionConfig: Any) =>
    config.localization && hasLocalizeStatusEnabled(collectionConfig),
  publicationFieldPolicyDoc: (doc: Any, docWithLocales: Any, data: Any, status: Any) =>
    buildAllLocalesPublicationHookDoc({
      doc,
      docWithLocales,
      status: data._status === status ? status : undefined,
    }),
  publicationHookDoc: (doc: Any, docWithLocales: Any, data: Any, status: Any, cell: StatusCell) =>
    buildAllLocalesPublicationHookDoc({
      doc,
      docWithLocales,
      status: cell.statusFieldAccess && data._status === status ? status : undefined,
    }),
  statusCell: (): StatusCell => ({ statusFieldAccess: false, statusFieldValue: undefined }),
  /** `if (typeof o._status !== 'object' || o._status === null) o._status = {}; for (...) o._status[code] = value` */
  setStatusLocales: (target: Any, accessibleLocaleCodes: Any, value: Any) => {
    if (typeof target._status !== 'object' || target._status === null) {
      target._status = {}
    }

    for (const localeCode of accessibleLocaleCodes) {
      target._status[localeCode] = value
    }
  },
  shouldValidateAllLocales: (
    config: Any,
    collectionConfig: Any,
    publishAllLocales: Any,
    hasAuthorizedPublicationStatus: Any,
    unpublishAllLocales: Any,
  ) =>
    config.localization &&
    hasDraftsEnabled(collectionConfig) &&
    publishAllLocales &&
    !unpublishAllLocales &&
    (!hasLocalizeStatusEnabled(collectionConfig) || hasAuthorizedPublicationStatus),
  validatePublicationFlagsOfArgs: (args: Any) =>
    validateAllLocalesPublicationFlags({
      publishAllLocales: args.publishAllLocales,
      unpublishAllLocales: args.unpublishAllLocales,
    }),

  // ---------------------------------------------------------------- create.ts
  captureCloudHookState: (req: Any) => captureCloudHookState({ req }),
  createAfterReadArgs: (
    collection: Any,
    req: Any,
    depth: Any,
    doc: Any,
    draft: Any,
    fallbackLocale: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) => ({
    collection,
    context: req.context,
    depth,
    doc,
    draft,
    fallbackLocale,
    global: null,
    locale,
    overrideAccess,
    populate,
    req,
    select,
    showHiddenFields,
  }),
  createArgs: (args: Any) => {
    const {
      autosave = false,
      collection: { config: collectionConfig },
      collection,
      depth,
      disableVerificationEmail,
      draft = false,
      duplicateFromID,
      overrideAccess,
      overwriteExistingFiles = false,
      populate,
      publishAllLocales: publishAllLocalesArg,
      req: {
        fallbackLocale,
        locale,
        payload,
        payload: { config },
      },
      req,
      select: incomingSelect,
      selectedLocales,
      showHiddenFields,
    } = args

    const { data } = args

    return [
      autosave,
      collectionConfig,
      collection,
      depth,
      disableVerificationEmail,
      draft,
      duplicateFromID,
      overrideAccess,
      overwriteExistingFiles,
      populate,
      publishAllLocalesArg,
      fallbackLocale,
      locale,
      payload,
      config,
      req,
      incomingSelect,
      selectedLocales,
      showHiddenFields,
      data,
    ]
  },
  createBeforeChangeArgs: (
    collectionConfig: Any,
    req: Any,
    data: Any,
    publicationHookDoc: Any,
    duplicatedFromDocWithLocales: Any,
    cell: StatusCell,
    overrideAccess: Any,
    isSavingDraft: Any,
  ) => {
    const docWithLocalesForFields = !cell.statusFieldAccess
      ? { ...duplicatedFromDocWithLocales, _status: {} }
      : duplicatedFromDocWithLocales

    return {
      collection: collectionConfig,
      context: req.context,
      data,
      doc: publicationHookDoc,
      docWithLocales: docWithLocalesForFields,
      global: null,
      onDataProcessed: (processedData: Any) => {
        cell.statusFieldValue = processedData._status
      },
      operation: 'create',
      overrideAccess,
      req,
      skipValidation: isSavingDraft && !hasDraftValidationEnabled(collectionConfig),
    }
  },
  createBeforeValidateArgs: (
    collection: Any,
    req: Any,
    data: Any,
    doc: Any,
    docForHooks: Any,
    cell: StatusCell,
    overrideAccess: Any,
  ) => ({
    collection,
    context: req.context,
    data,
    doc,
    docForHooks,
    global: null,
    onFieldAccess: ({ accessResult, path }: Any) => {
      if (path === '_status') {
        cell.statusFieldAccess = accessResult
      }
    },
    operation: 'create',
    overrideAccess,
    req,
  }),
  createGenerateFileData: (
    collection: Any,
    config: Any,
    data: Any,
    isSavingDraft: Any,
    externalUploadSource: Any,
    isDuplicating: Any,
    duplicatedFromDoc: Any,
    overwriteExistingFiles: Any,
    req: Any,
  ) =>
    generateFileData({
      collection,
      config,
      data,
      draft: isSavingDraft,
      externalUploadSource,
      isDuplicating,
      operation: 'create',
      originalDoc: duplicatedFromDoc,
      overwriteExistingFiles,
      req,
      throwOnMissingFile:
        !isSavingDraft && collection.config.upload.filesRequiredOnCreate !== false,
    }),
  createHasManagedLocalUpload: (collectionConfig: Any, filesToUpload: Any, dataWithLocales: Any) =>
    !collectionConfig.upload.disableLocalStorage &&
    filesToUpload.length > 0 &&
    Boolean(dataWithLocales.original),
  createInitialPublicationIntent: (args: Any) => {
    const initialCollectionConfig = args.collection.config
    const initialPublishAllLocales = resolvePublishAllLocales({
      draft: args.draft,
      hasLocalizeStatusEnabled: hasLocalizeStatusEnabled(initialCollectionConfig),
      publishAllLocalesArg: args.publishAllLocales,
    })
    const initialAllLocalesPublicationStatus = getAllLocalesPublicationStatus({
      hasLocalizedStatus: Boolean(
        args.req.payload.config.localization && hasLocalizeStatusEnabled(initialCollectionConfig),
      ),
      publishAllLocales: initialPublishAllLocales,
      unpublishAllLocales: false,
    })

    return normalizeAllLocalesPublicationStatus({
      data: args.data,
      status: initialAllLocalesPublicationStatus,
    })
  },
  createPublication: (
    draft: Any,
    collectionConfig: Any,
    publishAllLocalesArg: Any,
    config: Any,
    data: Any,
    initialAllLocalesPublicationIntent: Any,
  ) => {
    let publishAllLocales = resolvePublishAllLocales({
      draft,
      hasLocalizeStatusEnabled: hasLocalizeStatusEnabled(collectionConfig),
      publishAllLocalesArg,
    })
    const requestedAllLocalesPublicationStatus = getAllLocalesPublicationStatus({
      hasLocalizedStatus: Boolean(
        config.localization && hasLocalizeStatusEnabled(collectionConfig),
      ),
      publishAllLocales,
      unpublishAllLocales: false,
    })
    const allLocalesPublicationStatus = reconcileAllLocalesPublicationStatus({
      data,
      intent: initialAllLocalesPublicationIntent,
      status: requestedAllLocalesPublicationStatus,
    })

    if (requestedAllLocalesPublicationStatus && !allLocalesPublicationStatus) {
      publishAllLocales = false
    }
    const isSavingDraft = Boolean(draft && hasDraftsEnabled(collectionConfig) && !publishAllLocales)

    return [publishAllLocales, allLocalesPublicationStatus, isSavingDraft]
  },
  createSanitizeUpload: (args: Any) => {
    const externalUploadSource = getExternalUploadSource(args.data)
    const { objectKey, prefix } = getUploadDestination({ data: args.data, file: args.req.file })
    const sanitizedData = sanitizeUploadData(args.data, 'create')

    return [
      externalUploadSource,
      {
        ...args,
        data:
          typeof sanitizedData === 'object' && sanitizedData !== null
            ? {
                ...sanitizedData,
                ...(prefix !== undefined ? { prefix } : {}),
                ...(objectKey !== undefined ? { _objectKey: objectKey } : {}),
              }
            : sanitizedData,
      },
    ]
  },
  createSaveVersion: (
    resultWithLocales: Any,
    autosave: Any,
    collection: Any,
    payload: Any,
    req: Any,
  ) =>
    saveVersion({
      id: resultWithLocales.id,
      autosave,
      collection,
      docWithLocales: resultWithLocales,
      operation: 'create',
      payload,
      req,
      returning: false,
    }),
  createStatusAfterBeforeChange: (
    publicationData: Any,
    cell: StatusCell,
    allLocalesPublicationStatus: Any,
    dataWithLocales: Any,
    duplicatedFromDocWithLocales: Any,
    config: Any,
    collectionConfig: Any,
  ) => {
    const statusFieldAccess = cell.statusFieldAccess
    const statusFieldValue = cell.statusFieldValue
    const hasAuthorizedPublicationStatus = hasAuthorizedAllLocalesPublicationStatus({
      data: publicationData,
      fieldAccessDenied: !statusFieldAccess,
      fieldValue: statusFieldValue,
      status: allLocalesPublicationStatus,
    })

    if (
      allLocalesPublicationStatus &&
      !hasAuthorizedPublicationStatus &&
      statusFieldAccess &&
      typeof statusFieldValue === 'undefined' &&
      typeof duplicatedFromDocWithLocales._status === 'object' &&
      duplicatedFromDocWithLocales._status !== null
    ) {
      dataWithLocales._status = { ...duplicatedFromDocWithLocales._status }
    }

    if (
      config.localization &&
      hasLocalizeStatusEnabled(collectionConfig) &&
      typeof dataWithLocales._status === 'string'
    ) {
      const statusStr = dataWithLocales._status

      if (
        hasAuthorizedPublicationStatus &&
        typeof duplicatedFromDocWithLocales._status === 'object' &&
        duplicatedFromDocWithLocales._status !== null
      ) {
        dataWithLocales._status = { ...duplicatedFromDocWithLocales._status }
      } else {
        dataWithLocales._status = {}
      }

      if (!hasAuthorizedPublicationStatus) {
        for (const localeCode of config.localization.localeCodes) {
          dataWithLocales._status[localeCode] = statusStr
        }
      }
    }

    return hasAuthorizedPublicationStatus
  },
  createValidateAllLocales: (
    collectionConfig: Any,
    dataWithLocales: Any,
    overrideAccess: Any,
    req: Any,
    payload: Any,
  ) =>
    validateLocalWithLocaleKeyedData({
      operation: 'create',
      options: {
        collection: collectionConfig.slug,
        data: dataWithLocales,
        locale: 'all',
        overrideAccess,
        req,
      },
      payload,
    }),
  dbCreateArgs: (collectionConfig: Any, data: Any, req: Any) => ({
    collection: collectionConfig.slug,
    data,
    req,
  }),
  ensureUsernameOrEmailCreate: (args: Any) =>
    ensureUsernameOrEmail({
      authOptions: args.collection.config.auth,
      collectionSlug: args.collection.config.slug,
      data: args.data,
      operation: 'create',
      req: args.req,
    }),
  fillEmptyLocalizedSlugs: (collection: Any, data: Any, overrideAccess: Any, req: Any) =>
    fillEmptyLocalizedSlugs({
      collection,
      data,
      overrideAccess,
      req,
    }),
  getDuplicateDocumentData: (
    id: Any,
    collectionConfig: Any,
    draftArg: Any,
    overrideAccess: Any,
    req: Any,
    selectedLocales: Any,
  ) =>
    getDuplicateDocumentData({
      id,
      collectionConfig,
      draftArg,
      overrideAccess,
      req,
      selectedLocales,
    }),
  registerLocalStrategy: (collection: Any, doc: Any, data: Any, req: Any) =>
    registerLocalStrategy({
      collection,
      doc,
      password: data.password as string,
      payload: req.payload,
      req,
    }),
  runCloudFileCreation: (
    collection: Any,
    data: Any,
    files: Any,
    req: Any,
    write: () => Promise<Any>,
  ) =>
    runCloudFileCreation({
      collection,
      data,
      files,
      req,
      write,
    }),
  runFileCreationPlan: (
    collectionConfig: Any,
    filesToUpload: Any,
    req: Any,
    write: () => Promise<Any>,
  ) =>
    runFileCreationPlan({
      cleanupStagedAfterWriteFailure: (objects) =>
        removeUnreferencedStagedObjects({ collection: collectionConfig, objects, req }),
      req,
      stage: ({ trackStagedObject }) =>
        stageLocalUploadFiles({
          files: filesToUpload,
          staticDir: collectionConfig.upload.staticDir!,
          trackStagedObject,
        }),
      write,
    }),
  sendVerificationEmail: (
    collectionConfig: Any,
    payload: Any,
    disableEmail: Any,
    req: Any,
    token: Any,
    user: Any,
  ) =>
    sendVerificationEmail({
      collection: { config: collectionConfig },
      config: payload.config,
      disableEmail,
      email: payload.email,
      req,
      token,
      user,
    }),
  setVerificationFields: (dataWithLocales: Any) => {
    dataWithLocales._verified = Boolean(dataWithLocales._verified) || false
    dataWithLocales._verificationToken = crypto.randomBytes(20).toString('hex')
  },
  uploadFiles: (payload: Any, filesToUpload: Any, req: Any) =>
    uploadFiles(payload, filesToUpload, req),
  usesCloudFileCreation: (collectionConfig: Any, filesToUpload: Any, req: Any) =>
    collectionConfig.upload.fileOperations &&
    (filesToUpload.length > 0 || req.context?._payloadVerifiedProviderOriginal),

  // ---------------------------------------------------------------- duplicate.ts
  duplicateCreateArgs: (incomingArgs: Any) => {
    const { id, ...args } = incomingArgs
    return {
      ...args,
      data: incomingArgs?.data || {},
      duplicateFromID: id,
    }
  },

  // ---------------------------------------------------------------- update.ts / updateByID.ts
  sanitizeUploadArgs: (args: Any) => {
    const { objectKey, prefix } = getUploadDestination({ data: args.data, file: args.req.file })
    const data = sanitizeUploadData(args.data, 'update')

    return {
      ...args,
      data:
        typeof data === 'object' && data !== null
          ? {
              ...data,
              ...(prefix !== undefined ? { prefix } : {}),
              ...(objectKey !== undefined ? { _objectKey: objectKey } : {}),
            }
          : data,
    }
  },
  updateArgs: (args: Any) => {
    const {
      autosave = false,
      collection: { config: collectionConfig },
      collection,
      depth,
      draft: draftArg = false,
      limit = 0,
      overrideAccess,
      overrideLock,
      overwriteExistingFiles = false,
      populate,
      publishAllLocales: publishAllLocalesArg,
      req: {
        fallbackLocale,
        locale,
        payload: { config },
        payload,
      },
      req,
      select: incomingSelect,
      showHiddenFields,
      sort: incomingSort,
      trash = false,
      unpublishAllLocales: unpublishAllLocalesArg,
      where,
    } = args

    return [
      autosave,
      collectionConfig,
      collection,
      depth,
      draftArg,
      limit,
      overrideAccess,
      overrideLock,
      overwriteExistingFiles,
      populate,
      publishAllLocalesArg,
      fallbackLocale,
      locale,
      config,
      payload,
      req,
      incomingSelect,
      showHiddenFields,
      incomingSort,
      trash,
      unpublishAllLocalesArg,
      where,
    ]
  },
  updateByIDArgs: (args: Any) => {
    const {
      id,
      autosave = false,
      collection: { config: collectionConfig },
      collection,
      depth,
      draft: draftArg = false,
      overrideAccess,
      overrideLock,
      overwriteExistingFiles = false,
      populate,
      publishAllLocales: publishAllLocalesArg,
      req: {
        fallbackLocale,
        locale,
        payload: { config },
        payload,
      },
      req,
      select: incomingSelect,
      showHiddenFields,
      trash = false,
      unpublishAllLocales: unpublishAllLocalesArg,
    } = args

    return [
      id,
      autosave,
      collectionConfig,
      collection,
      depth,
      draftArg,
      overrideAccess,
      overrideLock,
      overwriteExistingFiles,
      populate,
      publishAllLocalesArg,
      fallbackLocale,
      locale,
      config,
      payload,
      req,
      incomingSelect,
      showHiddenFields,
      trash,
      unpublishAllLocalesArg,
    ]
  },
  updateByIDInitialPublicationIntent: (args: Any) => {
    const initialCollectionConfig = args.collection.config
    const initialAllLocalesPublicationStatus = getAllLocalesPublicationStatus({
      hasLocalizedStatus: Boolean(
        args.req.payload.config.localization && hasLocalizeStatusEnabled(initialCollectionConfig),
      ),
      publishAllLocales:
        !args.draft &&
        (args.publishAllLocales ??
          (hasLocalizeStatusEnabled(initialCollectionConfig) && args.req.locale !== 'all'
            ? false
            : true)),
      unpublishAllLocales: Boolean(args.unpublishAllLocales),
    })

    return normalizeAllLocalesPublicationStatus({
      data: args.data,
      status: initialAllLocalesPublicationStatus,
    })
  },
  updateInitialPublicationIntent: (args: Any) => {
    const initialCollectionConfig = args.collection.config
    const initialAllLocalesPublicationStatus = getAllLocalesPublicationStatus({
      hasLocalizedStatus: Boolean(
        args.req.payload.config.localization && hasLocalizeStatusEnabled(initialCollectionConfig),
      ),
      publishAllLocales:
        !args.draft &&
        (args.publishAllLocales ??
          !(hasLocalizeStatusEnabled(initialCollectionConfig) && args.req.locale !== 'all')),
      unpublishAllLocales: Boolean(args.unpublishAllLocales),
    })

    return normalizeAllLocalesPublicationStatus({
      data: args.data,
      status: initialAllLocalesPublicationStatus,
    })
  },
  /** Shared by update.ts and updateByID.ts (same expressions in both). */
  appendNonTrashedFilter: (enableTrash: Any, trash: Any, where: Any) =>
    appendNonTrashedFilter({ enableTrash, trash, where }),
  appendVersionToQueryKey: (where: Any) => appendVersionToQueryKey(where),
  bulkFindArgs: (
    collectionConfig: Any,
    limit: Any,
    locale: Any,
    req: Any,
    sort: Any,
    where: Any,
  ) => ({
    collection: collectionConfig.slug,
    limit,
    locale: locale!,
    pagination: false,
    req,
    sort,
    where,
  }),
  bulkGenerateFileData: (
    collection: Any,
    config: Any,
    data: Any,
    overwriteExistingFiles: Any,
    req: Any,
  ) =>
    generateFileData({
      collection,
      config,
      data,
      operation: 'update',
      overwriteExistingFiles,
      req,
      throwOnMissingFile: false,
    }),
  bulkQueryDraftsArgs: (
    collectionConfig: Any,
    limit: Any,
    locale: Any,
    req: Any,
    sort: Any,
    where: Any,
  ) => ({
    collection: collectionConfig.slug,
    limit,
    locale: locale!,
    pagination: false,
    req,
    sort: getQueryDraftsSort({ collectionConfig, sort }),
    where,
  }),
  combineQueries: (where: Any, access: Any) => combineQueries(where, access),
  findOneArgsOf: (collectionConfig: Any, locale: Any, req: Any, where: Any) => ({
    collection: collectionConfig.slug,
    locale,
    req,
    where,
  }),
  getLatestCollectionVersion: (id: Any, config: Any, payload: Any, query: Any, req: Any) =>
    getLatestCollectionVersion({
      id,
      config,
      payload,
      query,
      req,
    }),
  isTrashAttempt: (collectionConfig: Any, data: Any) =>
    collectionConfig.trash &&
    typeof data === 'object' &&
    data !== null &&
    'deletedAt' in data &&
    data.deletedAt != null,
  mergeUploadDataWithDocument: (
    data: Any,
    docWithLocales: Any,
    locale: Any,
    config: Any,
    collectionConfig: Any,
  ) =>
    mergeUploadDataWithDocument(data, docWithLocales, {
      locale: uploadLocale(locale, config),
      localizedProperties: getLocalizedUploadProperties(collectionConfig.flattenedFields),
    }),
  runCloudFileUpdate: (
    id: Any,
    collection: Any,
    current: Any,
    updateArgs: Any,
    files: Any,
    req: Any,
    write: () => Promise<Any>,
  ) =>
    runCloudFileUpdate({
      id,
      collection,
      current,
      data: updateArgs.data,
      files,
      req,
      write,
    }),
  sanitizeWhereQuery: (fields: Any, payload: Any, where: Any) =>
    sanitizeWhereQuery({ fields, payload, where }),
  updateByIDUpdateArgs: (
    id: Any,
    autosave: Any,
    collectionConfig: Any,
    config: Any,
    newFileData: Any,
    depth: Any,
    docWithLocales: Any,
    draftArg: Any,
    fallbackLocale: Any,
    filesToUpload: Any,
    locale: Any,
    overrideAccess: Any,
    overrideLock: Any,
    payload: Any,
    populate: Any,
    publishAllLocales: Any,
    req: Any,
    select: Any,
    showHiddenFields: Any,
    unpublishAllLocales: Any,
  ) => ({
    id,
    autosave,
    collectionConfig,
    config,
    data: deepCopyObjectSimple(newFileData),
    depth: depth!,
    docWithLocales,
    draftArg,
    fallbackLocale: fallbackLocale!,
    filesToUpload,
    locale: locale!,
    overrideAccess: overrideAccess!,
    overrideLock: overrideLock!,
    payload,
    populate,
    publishAllLocales,
    req,
    select: select!,
    shouldManageLocalFiles: true,
    showHiddenFields: showHiddenFields!,
    unpublishAllLocales,
  }),
  updateGenerateFileData: (
    collection: Any,
    config: Any,
    data: Any,
    docWithLocales: Any,
    overwriteExistingFiles: Any,
    req: Any,
  ) =>
    generateFileData({
      collection,
      config,
      data,
      operation: 'update',
      originalDoc: docWithLocales,
      overwriteExistingFiles,
      req,
      throwOnMissingFile: false,
    }),
  updatePublication: (
    publishAllLocalesArg: Any,
    unpublishAllLocalesArg: Any,
    draftArg: Any,
    collectionConfig: Any,
    config: Any,
    locale: Any,
    data: Any,
    initialAllLocalesPublicationIntent: Any,
  ) => {
    validateAllLocalesPublicationFlags({
      publishAllLocales: publishAllLocalesArg,
      unpublishAllLocales: unpublishAllLocalesArg,
    })

    const requestedAllLocalesPublicationStatus = getAllLocalesPublicationStatus({
      hasLocalizedStatus: Boolean(
        config.localization && hasLocalizeStatusEnabled(collectionConfig),
      ),
      publishAllLocales:
        !draftArg &&
        (publishAllLocalesArg ?? !(hasLocalizeStatusEnabled(collectionConfig) && locale !== 'all')),
      unpublishAllLocales: Boolean(unpublishAllLocalesArg),
    })
    const allLocalesPublicationStatus = reconcileAllLocalesPublicationStatus({
      data,
      intent: initialAllLocalesPublicationIntent,
      status: requestedAllLocalesPublicationStatus,
    })
    const publicationIntentSurvivedBeforeOperation =
      !requestedAllLocalesPublicationStatus || Boolean(allLocalesPublicationStatus)
    const publishAllLocales = publicationIntentSurvivedBeforeOperation
      ? publishAllLocalesArg
      : false
    const unpublishAllLocales = publicationIntentSurvivedBeforeOperation
      ? unpublishAllLocalesArg
      : false

    return [publishAllLocales, unpublishAllLocales]
  },
  validateQueryPaths: (collectionConfig: Any, overrideAccess: Any, req: Any, where: Any) =>
    validateQueryPaths({
      collectionConfig,
      overrideAccess,
      req,
      where,
    }),
  validateSortQuery: (collectionConfig: Any, overrideAccess: Any, req: Any, sort: Any) =>
    validateSortQuery({
      collectionConfig,
      overrideAccess,
      req,
      sort,
    }),
  validateVersionQueryPaths: (
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
  withLegacyCloudUploadFileData: (collection: Any, doc: Any, req: Any) =>
    withLegacyCloudUploadFileData({
      collection,
      doc,
      req,
    }),
  /** `req.file ? { ...req.file } : undefined` */
  copyRequestFile: (req: Any) => (req.file ? { ...req.file } : undefined),
  /** The temp file copy path when `collectionConfig.upload && documentFile?.tempFilePath`. */
  bulkDocumentGenerateFileData: (
    collection: Any,
    config: Any,
    bulkUpdateData: Any,
    docWithLocales: Any,
    locale: Any,
    collectionConfig: Any,
    overwriteExistingFiles: Any,
    documentReq: Any,
  ) =>
    generateFileData({
      collection,
      config,
      data: mergeUploadDataWithDocument(bulkUpdateData, docWithLocales, {
        locale: uploadLocale(locale, config),
        localizedProperties: getLocalizedUploadProperties(collectionConfig.flattenedFields),
      }),
      operation: 'update',
      originalDoc: docWithLocales,
      overwriteExistingFiles,
      req: documentReq,
      throwOnMissingFile: false,
    }),
  bulkErrorIsPublic: (error: Any, config: Any) =>
    error instanceof Error ? isErrorPublic(error, config) : false,
  bulkResult: (awaitedDocs: Any, errors: Any) => ({
    docs: awaitedDocs.filter(Boolean),
    errors,
  }),
  bulkUpdateArgs: (
    id: Any,
    autosave: Any,
    collectionConfig: Any,
    config: Any,
    documentData: Any,
    depth: Any,
    docWithLocales: Any,
    draftArg: Any,
    fallbackLocale: Any,
    generatedFileData: Any,
    locale: Any,
    overrideAccess: Any,
    overrideLock: Any,
    payload: Any,
    populate: Any,
    publishAllLocales: Any,
    documentReq: Any,
    select: Any,
    showHiddenFields: Any,
    unpublishAllLocales: Any,
  ) => ({
    id,
    autosave,
    collectionConfig,
    config,
    data: documentData,
    depth: depth!,
    docWithLocales,
    draftArg,
    fallbackLocale: fallbackLocale!,
    filesToUpload: generatedFileData.files,
    locale: locale!,
    overrideAccess: overrideAccess!,
    overrideLock: overrideLock!,
    payload,
    populate,
    publishAllLocales,
    req: documentReq,
    select: select!,
    shouldManageLocalFiles: true,
    showHiddenFields: showHiddenFields!,
    unpublishAllLocales,
  }),
  copyDataWithFreshRowIDs: (
    config: Any,
    generatedFileData: Any,
    docWithLocales: Any,
    collectionConfig: Any,
  ) =>
    copyDataWithFreshRowIDs({
      config,
      data: generatedFileData.data,
      existingDoc: docWithLocales,
      fields: collectionConfig.fields,
    }),
  copyFile: (from: Any, to: Any) => fs.copyFile(from, to),
  documentTempFilePathFor: (collectionConfig: Any, documentFile: Any) => {
    if (collectionConfig.upload && documentFile?.tempFilePath) {
      const extension = path.extname(documentFile.tempFilePath)
      return path.join(
        path.dirname(documentFile.tempFilePath),
        `${path.basename(documentFile.tempFilePath, extension)}-${randomUUID()}${extension}`,
      )
    }
    return undefined
  },
  isolateUploadRequest: (req: Any) => isolateObjectProperty(req, ['file', 'payloadUploadSizes']),
  processSequentially: (req: Any, collectionConfig: Any) =>
    req.payload.db.bulkOperationsSingleTransaction || Boolean(collectionConfig.upload && req.file),
  pushBulkError: (errors: Any, id: Any, isPublic: Any, error: Any) => {
    errors.push({
      id,
      isPublic,
      message: error instanceof Error ? error.message : 'Unknown error',
    })
  },
  removeTempFileCopy: (documentTempFilePath: Any, req: Any) =>
    fs.rm(documentTempFilePath, { force: true }).catch((error) => {
      req.payload.logger.error({ err: error, msg: 'Failed to remove temp file copy' })
    }),
  setDocumentRequestFile: (documentReq: Any, documentFile: Any) => {
    documentReq.file = documentFile
    documentReq.payloadUploadSizes = {}
  },

  // ---------------------------------------------------------------- utilities/update.ts
  applyPasswordHash: (
    dataToUpdate: Any,
    data: Any,
    { hash, salt }: Any,
    collectionConfig: Any,
    req: Any,
    id: Any,
    docWithLocales: Any,
  ) => {
    dataToUpdate.salt = salt
    dataToUpdate.hash = hash
    delete dataToUpdate.password
    delete data.password

    if (collectionConfig.auth?.useSessions) {
      const currentSid =
        req.user?.collection === collectionConfig.slug && String(req.user.id) === String(id)
          ? req.user._sid
          : undefined
      const existingSessions = removeExpiredSessions(docWithLocales.sessions ?? [])

      dataToUpdate.sessions = currentSid
        ? existingSessions.filter((session: Any) => session.id === currentSid)
        : []
    }
  },
  buildLocalizedPublishData: (
    config: Any,
    currentDoc: Any,
    collectionConfig: Any,
    locale: Any,
    result: Any,
  ) =>
    buildLocalizedPublishData({
      config,
      currentDoc,
      fields: collectionConfig.fields,
      locale,
      result,
    }),
  checkDocumentLockStatusUpdate: (id: Any, collectionConfig: Any, overrideLock: Any, req: Any) =>
    checkDocumentLockStatus({
      id,
      collectionSlug: collectionConfig.slug,
      lockErrorMessage: `Document with ID ${id} is currently locked by another user and cannot be updated.`,
      overrideLock,
      req,
    }),
  currentDocFindOneArgs: (collectionConfig: Any, req: Any, id: Any) => ({
    collection: collectionConfig.slug,
    locale: 'all',
    req,
    where: { id: { equals: id } },
  }),
  dbUpdateOneArgs: (id: Any, collectionConfig: Any, data: Any, locale: Any, req: Any) => ({
    id,
    collection: collectionConfig.slug,
    data,
    locale,
    req,
  }),
  deleteAssociatedFilesUpdate: (
    collectionConfig: Any,
    config: Any,
    doc: Any,
    files: Any,
    req: Any,
  ) =>
    deleteAssociatedFiles({
      collectionConfig,
      config,
      doc,
      files,
      overrideDelete: false,
      req,
    }),
  generatePasswordSaltHash: (collection: Any, password: Any, req: Any) =>
    generatePasswordSaltHash({
      collection,
      password,
      req,
    }),
  isSingleLocalePublish: (isSavingDraft: Any, result: Any, locale: Any) =>
    !isSavingDraft &&
    result._status &&
    typeof result._status === 'object' &&
    !Array.isArray(result._status) &&
    result._status[locale] === 'published',
  originalDocAfterReadArgs: (
    collection: Any,
    req: Any,
    docWithLocales: Any,
    draftArg: Any,
    id: Any,
    fallbackLocale: Any,
    locale: Any,
  ) => ({
    collection,
    context: req.context,
    depth: 0,
    doc: deepCopyObjectSimple(docWithLocales),
    draft: draftArg,
    fallbackLocale: id ? null : fallbackLocale,
    global: null,
    locale,
    overrideAccess: true,
    req,
    showHiddenFields: true,
  }),
  runLocalFileUpdate: (
    id: Any,
    collection: Any,
    current: Any,
    hasManagedLocalUpload: Any,
    filesToUpload: Any,
    next: Any,
    req: Any,
    write: () => Promise<Any>,
  ) =>
    runLocalFileUpdate({
      id,
      collection,
      current,
      files: hasManagedLocalUpload ? filesToUpload : [],
      next,
      req,
      write,
    }),
  setUpdatedAtNow: (dataToUpdate: Any) => {
    dataToUpdate.updatedAt = new Date().toISOString()
  },
  updateAfterReadArgs: (
    collection: Any,
    req: Any,
    depth: Any,
    doc: Any,
    draftArg: Any,
    fallbackLocale: Any,
    locale: Any,
    overrideAccess: Any,
    populate: Any,
    select: Any,
    showHiddenFields: Any,
  ) => ({
    collection,
    context: req.context,
    depth,
    doc,
    draft: draftArg,
    fallbackLocale,
    global: null,
    locale,
    overrideAccess,
    populate,
    req,
    select,
    showHiddenFields,
  }),
  updateBeforeChangeArgs: (
    id: Any,
    collection: Any,
    req: Any,
    data: Any,
    publicationHookDoc: Any,
    docWithLocales: Any,
    submittedTopLevelFieldNames: Any,
    overrideAccess: Any,
    isSavingDraft: Any,
    cell: StatusCell,
  ) => {
    const beforeChangeArgs = {
      id,
      collection,
      context: req.context,
      data: { ...data, id },
      doc: publicationHookDoc,
      docWithLocales,
      fieldsToValidate: submittedTopLevelFieldNames,
      global: null,
      operation: 'update',
      overrideAccess,
      req,
      // only skip validation for drafts when draft validation is false
      skipValidation: isSavingDraft && !hasDraftValidationEnabled(collection),
    }

    return {
      ...beforeChangeArgs,
      onDataProcessed: (processedData: Any) => {
        cell.statusFieldValue = processedData._status
      },
    }
  },
  updateBeforeValidateArgs: (
    id: Any,
    collection: Any,
    req: Any,
    data: Any,
    doc: Any,
    docForHooks: Any,
    cell: StatusCell,
    overrideAccess: Any,
  ) => ({
    id,
    collection,
    context: req.context,
    data,
    doc,
    docForHooks,
    global: null,
    onFieldAccess: ({ accessResult, path }: Any) => {
      if (path === '_status') {
        cell.statusFieldAccess = accessResult
      }
    },
    operation: 'update',
    overrideAccess,
    req,
  }),
  updateDocumentMiddle: (
    originalDoc: Any,
    data: Any,
    collectionConfig: Any,
    unpublishAllLocales: Any,
    req: Any,
    isSavingDraft: Any,
    docWithLocales: Any,
    filesToUpload: Any,
  ) => {
    const isRestoringDraftFromTrash =
      Boolean(originalDoc?.deletedAt) && data?._status !== 'published'
    const shouldLimitValidationToSubmittedFields =
      (collectionConfig.trash && (Boolean(data?.deletedAt) || isRestoringDraftFromTrash)) ||
      unpublishAllLocales
    const submittedTopLevelFieldNames = shouldLimitValidationToSubmittedFields
      ? getTopLevelFieldNames(data)
      : undefined

    if (collectionConfig.auth) {
      ensureUsernameOrEmail({
        authOptions: collectionConfig.auth,
        collectionSlug: collectionConfig.slug,
        data,
        operation: 'update',
        originalDoc,
        req,
      })
    }

    const isDraftOverPublished = isSavingDraft && docWithLocales._status === 'published'

    const hasManagedLocalUpload =
      filesToUpload.length > 0 &&
      Boolean(data.original) &&
      !collectionConfig.upload.disableLocalStorage

    return [submittedTopLevelFieldNames, isDraftOverPublished, hasManagedLocalUpload]
  },
  updateDocumentParams: ({
    id,
    autosave,
    collectionConfig,
    config,
    data,
    depth,
    docWithLocales,
    draftArg,
    fallbackLocale,
    filesToUpload,
    locale,
    overrideAccess,
    overrideLock,
    payload,
    populate,
    publishAllLocales: publishAllLocalesArg,
    req,
    select,
    shouldManageLocalFiles,
    showHiddenFields,
    unpublishAllLocales: unpublishAllLocalesArg,
  }: Any) => [
    id,
    autosave,
    collectionConfig,
    config,
    data,
    depth,
    docWithLocales,
    draftArg,
    fallbackLocale,
    filesToUpload,
    locale,
    overrideAccess,
    overrideLock,
    payload,
    populate,
    publishAllLocalesArg,
    req,
    select,
    shouldManageLocalFiles,
    showHiddenFields,
    unpublishAllLocalesArg,
  ],
  updateDocumentPrologue: (
    collectionConfig: Any,
    shouldManageLocalFiles: Any,
    data: Any,
    publishAllLocalesArg: Any,
    unpublishAllLocalesArg: Any,
    draftArg: Any,
    locale: Any,
    config: Any,
  ) => {
    const nextFileData =
      collectionConfig.upload && shouldManageLocalFiles && !collectionConfig.upload.fileOperations
        ? deepCopyObjectSimple(data)
        : undefined

    validateAllLocalesPublicationFlags({
      publishAllLocales: publishAllLocalesArg,
      unpublishAllLocales: unpublishAllLocalesArg,
    })

    const publishAllLocales = resolvePublishAllLocales({
      draft: draftArg,
      hasLocalizeStatusEnabled: hasLocalizeStatusEnabled(collectionConfig),
      locale,
      publishAllLocalesArg,
    })
    const unpublishAllLocales =
      typeof unpublishAllLocalesArg === 'string'
        ? unpublishAllLocalesArg === 'true'
        : !!unpublishAllLocalesArg
    const allLocalesPublicationStatus = getAllLocalesPublicationStatus({
      hasLocalizedStatus: Boolean(
        config.localization && hasLocalizeStatusEnabled(collectionConfig),
      ),
      publishAllLocales,
      unpublishAllLocales,
    })
    const isSavingDraft =
      Boolean(draftArg && hasDraftsEnabled(collectionConfig)) &&
      data._status !== 'published' &&
      !publishAllLocales
    if (allLocalesPublicationStatus || isSavingDraft) {
      data._status = allLocalesPublicationStatus ?? 'draft'
    }

    return [
      nextFileData,
      publishAllLocales,
      unpublishAllLocales,
      allLocalesPublicationStatus,
      isSavingDraft,
    ]
  },
  updatePassword: (data: Any, collectionConfig: Any, isSavingDraft: Any) => {
    const password = data?.password
    const shouldSavePassword = Boolean(
      password &&
      collectionConfig.auth &&
      (!collectionConfig.auth.disableLocalStrategy ||
        (typeof collectionConfig.auth.disableLocalStrategy === 'object' &&
          collectionConfig.auth.disableLocalStrategy.enableFields)) &&
      !isSavingDraft,
    )
    return [password, shouldSavePassword]
  },
  updateSaveVersion: (
    id: Any,
    autosave: Any,
    collection: Any,
    docWithLocales: Any,
    isSavingDraft: Any,
    payload: Any,
    req: Any,
    unpublishAllLocales: Any,
  ) =>
    saveVersion({
      id,
      autosave,
      collection,
      docWithLocales,
      draft: isSavingDraft,
      operation: 'update',
      payload,
      req,
      unpublish: unpublishAllLocales,
    }),
  updateStatusAfterBeforeChange: (
    publicationData: Any,
    cell: StatusCell,
    allLocalesPublicationStatus: Any,
    result: Any,
    docWithLocales: Any,
    config: Any,
    collectionConfig: Any,
  ) => {
    const statusFieldValue = cell.statusFieldValue
    const hasAuthorizedPublicationStatus = hasAuthorizedAllLocalesPublicationStatus({
      data: publicationData,
      fieldAccessDenied: !cell.statusFieldAccess,
      fieldValue: statusFieldValue,
      status: allLocalesPublicationStatus,
    })

    if (
      allLocalesPublicationStatus &&
      !hasAuthorizedPublicationStatus &&
      typeof statusFieldValue === 'undefined' &&
      typeof docWithLocales._status === 'object' &&
      docWithLocales._status !== null
    ) {
      result._status = { ...docWithLocales._status }
    }

    if (
      config.localization &&
      hasLocalizeStatusEnabled(collectionConfig) &&
      typeof result._status === 'string'
    ) {
      const statusStr = result._status

      if (
        hasAuthorizedPublicationStatus &&
        typeof docWithLocales._status === 'object' &&
        docWithLocales._status !== null
      ) {
        result._status = { ...docWithLocales._status }
      } else {
        result._status = {}
      }

      if (!hasAuthorizedPublicationStatus) {
        for (const localeCode of config.localization.localeCodes) {
          result._status[localeCode] = statusStr
        }
      }
    }

    return hasAuthorizedPublicationStatus
  },
  updateValidateAllLocales: (
    id: Any,
    collectionConfig: Any,
    result: Any,
    overrideAccess: Any,
    req: Any,
    payload: Any,
    docWithLocales: Any,
    publicationHookDoc: Any,
    locale: Any,
    originalDoc: Any,
  ) =>
    validateLocalWithLocaleKeyedData({
      operation: 'update',
      options: {
        id,
        collection: collectionConfig.slug,
        data: result,
        draft: true,
        locale: 'all',
        overrideAccess,
        req,
      },
      payload,
      sourceData: {
        docWithLocales,
        originalDoc: publicationHookDoc,
        originalLocale: locale,
      },
      trash: Boolean(originalDoc?.deletedAt),
    }),
  withUpdatedAt: (result: Any, dataToUpdate: Any) => ({
    ...result,
    updatedAt: dataToUpdate.updatedAt,
  }),

  // ---------------------------------------------------------------- delete.ts / deleteByID.ts
  checkDocumentLockStatusDelete: (id: Any, collectionConfig: Any, overrideLock: Any, req: Any) =>
    checkDocumentLockStatus({
      id,
      collectionSlug: collectionConfig.slug,
      lockErrorMessage: `Document with ID ${id} is currently locked and cannot be deleted.`,
      overrideLock,
      req,
    }),
  collectStoredFiles: (collection: Any, doc: Any, req: Any) =>
    collectStoredFiles({ collection, doc, req }),
  collectVersionFiles: (collection: Any, parentID: Any, req: Any) =>
    collectVersionFiles({ collection, parentID, req }),
  deleteArgs: (args: Any) => {
    const {
      collection: { config: collectionConfig },
      depth,
      overrideAccess,
      overrideLock,
      populate,
      req: {
        fallbackLocale,
        locale,
        payload: { config },
        payload,
      },
      req,
      select: incomingSelect,
      showHiddenFields,
      trash = false,
      where,
    } = args

    return [
      collectionConfig,
      depth,
      overrideAccess,
      overrideLock,
      populate,
      fallbackLocale,
      locale,
      config,
      payload,
      req,
      incomingSelect,
      showHiddenFields,
      trash,
      where,
    ]
  },
  deleteByIDArgs: (args: Any) => {
    const {
      id,
      collection: { config: collectionConfig },
      depth,
      overrideAccess,
      overrideLock,
      populate,
      req: {
        fallbackLocale,
        locale,
        payload: { config },
        payload,
      },
      req,
      select: incomingSelect,
      showHiddenFields,
      trash = false,
    } = args

    return [
      id,
      collectionConfig,
      depth,
      overrideAccess,
      overrideLock,
      populate,
      fallbackLocale,
      locale,
      config,
      payload,
      req,
      incomingSelect,
      showHiddenFields,
      trash,
    ]
  },
  /** deleteByID: register the managed delete on `req.context`, returns its identity. */
  bulkDeleteFindArgs: (collectionConfig: Any, locale: Any, req: Any, select: Any, where: Any) => ({
    collection: collectionConfig.slug,
    locale: locale!,
    req,
    // File cleanup needs every stored representation even when the response selects only an ID.
    select: collectionConfig.upload ? undefined : select,
    where,
  }),
  clearManagedDeleteIdentity: (args: Any, managedDeleteIdentity: Any) => {
    const managedDeletedUploads = args.req.context?._payloadManagedDeletedUploads
    managedDeletedUploads?.delete(managedDeleteIdentity)
    if (managedDeletedUploads?.size === 0) {
      delete args.req.context._payloadManagedDeletedUploads
    }
  },
  deleteAssociatedFilesDelete: (collectionConfig: Any, config: Any, doc: Any, req: Any) =>
    deleteAssociatedFiles({
      collectionConfig,
      config,
      doc,
      overrideDelete: true,
      req,
    }),
  deleteCollectionVersionsByID: (id: Any, collectionConfig: Any, payload: Any, req: Any) =>
    deleteCollectionVersions({
      id,
      slug: collectionConfig.slug,
      payload,
      req,
    }),
  deleteCollectionVersionsByIDs: (collectionConfig: Any, ids: Any, payload: Any, req: Any) =>
    deleteCollectionVersions({
      slug: collectionConfig.slug,
      ids,
      payload,
      req,
    }),
  deleteOneArgs: (collectionConfig: Any, req: Any, select: Any, id: Any) => ({
    collection: collectionConfig.slug,
    req,
    select,
    where: { id: { equals: id } },
  }),
  deleteOneNoReturnArgs: (collectionConfig: Any, req: Any, id: Any) => ({
    collection: collectionConfig.slug,
    req,
    returning: false,
    where: {
      id: {
        equals: id,
      },
    },
  }),
  deleteScheduledPublishJobsByID: (id: Any, collectionConfig: Any, payload: Any, req: Any) =>
    deleteScheduledPublishJobs({
      id,
      slug: collectionConfig.slug,
      payload,
      req,
    }),
  deleteScheduledPublishJobsByIDs: (collectionConfig: Any, ids: Any, payload: Any, req: Any) =>
    deleteScheduledPublishJobs({
      slug: collectionConfig.slug,
      ids,
      payload,
      req,
    }),
  deleteUserPreferencesOfDocs: (collectionConfig: Any, docs: Any, payload: Any, req: Any) =>
    deleteUserPreferences({
      collectionConfig,
      ids: docs.map(({ id }: Any) => id),
      payload,
      req,
    }),
  deleteUserPreferencesOfID: (collectionConfig: Any, id: Any, payload: Any, req: Any) =>
    deleteUserPreferences({
      collectionConfig,
      ids: [id],
      payload,
      req,
    }),
  markManagedDelete: (collectionConfig: Any, id: Any, req: Any) => {
    const managedDeleteIdentity = JSON.stringify([collectionConfig.slug, String(id)])
    req.context ??= {}
    const managedDeletedUploads = (req.context._payloadManagedDeletedUploads ??= new Set())
    managedDeletedUploads.add(managedDeleteIdentity)
    return managedDeleteIdentity
  },
  scheduleUnreferencedFileCleanup: (candidates: Any, collection: Any, req: Any) =>
    scheduleUnreferencedFileCleanup({
      candidates,
      collection,
      req,
    }),
  /** Removes this operation's marked identities from `req.context._payloadManagedDeletedUploads`. */
  clearMarkedManagedDeletes: (args: Any, markedManagedDeletes: Set<string>) => {
    const managedDeletedUploads = args.req.context?._payloadManagedDeletedUploads as
      | Set<string>
      | undefined
    for (const identity of markedManagedDeletes) {
      managedDeletedUploads?.delete(identity)
    }
    if (managedDeletedUploads?.size === 0) {
      delete args.req.context._payloadManagedDeletedUploads
    }
  },
  /** `req.context ??= {}; (req.context._payloadManagedDeletedUploads ??= new Set())` */
  managedDeletedUploadsOf: (req: Any) => {
    req.context ??= {}
    return (req.context._payloadManagedDeletedUploads ??= new Set())
  },
  /** `pushError(id, error, message?)` of delete.ts */
  pushError: (errors: Any, id: Any, error: Any, config: Any, message?: string) => {
    errors.push({
      id,
      isPublic: error instanceof Error ? isErrorPublic(error, config) : false,
      message: message ?? (error instanceof Error ? error.message : 'Unknown error'),
    })
  },
  /** `deletedFilesByID.get(doc.id) ?? []` */
  deletedFilesOf: (deletedFilesByID: Map<Any, Any>, doc: Any) => deletedFilesByID.get(doc.id) ?? [],
  getLockedDocumentIds: (collectionConfig: Any, docs: Any, overrideLock: Any, req: Any) =>
    getLockedDocumentIds({
      collectionSlug: collectionConfig.slug,
      ids: docs.map(({ id }: Any) => id),
      overrideLock,
      req,
    }),
  nullFilledArray: (docs: Any) => new Array(docs.length).fill(null),
  recordDeletedFiles: (
    deletedFilesByID: Map<Any, Any>,
    doc: Any,
    stored: Any,
    versions: Any,
    collectionConfig: Any,
    managedDeletedUploads: Set<string>,
    markedManagedDeletes: Set<string>,
  ) => {
    deletedFilesByID.set(doc.id, [...stored, ...versions])
    if (deletedFilesByID.get(doc.id)?.length) {
      const identity = JSON.stringify([collectionConfig.slug, String(doc.id)])
      managedDeletedUploads.add(identity)
      markedManagedDeletes.add(identity)
    }
  },
  /** The `docs.forEach` of `deleteDocumentsInBulk`: returns `unlocked`. */
  bulkDeleteFailedMessage: (deletable: Any, error: Any) =>
    `Bulk delete failed for this batch of ${deletable.length} documents: ${
      error instanceof Error ? error.message : 'Unknown error'
    }`,
  deletableFiles: (deletable: Any, deletedFilesByID: Map<Any, Any>) =>
    deletable.flatMap(({ doc }: Any) => deletedFilesByID.get(doc.id) ?? []),
  deleteDocumentLocks: (collectionConfig: Any, unlocked: Any, req: Any) =>
    deleteDocumentLocks({
      collectionSlug: collectionConfig.slug,
      ids: unlocked.map(({ doc }: Any) => doc.id),
      req,
    }),
  deleteManyArgs: (collectionConfig: Any, req: Any, ids: Any) => ({
    collection: collectionConfig.slug,
    req,
    where: {
      id: {
        in: ids,
      },
    },
  }),
  entryIds: (deletable: Any) => deletable.map(({ doc }: Any) => doc.id),
  partitionLocked: (docs: Any, lockedIds: Set<string>, errors: Any, config: Any) => {
    const unlocked: { doc: Any; index: number }[] = []

    docs.forEach((doc: Any, index: number) => {
      if (lockedIds.has(String(doc.id))) {
        const error = new Locked(
          `Document with ID ${doc.id} is currently locked and cannot be deleted.`,
        )
        errors.push({
          id: doc.id,
          isPublic: error instanceof Error ? isErrorPublic(error, config) : false,
          message: error instanceof Error ? error.message : 'Unknown error',
        })

        return
      }

      unlocked.push({ doc, index })
    })

    return unlocked
  },

  // ---------------------------------------------------------------- restoreVersion.ts
  restoreAfterChangeHookArgs: (
    collection: Any,
    req: Any,
    result: Any,
    overrideAccess: Any,
    previousDoc: Any,
  ) => ({
    collection,
    context: req.context,
    data: result,
    doc: result,
    operation: 'update',
    overrideAccess,
    previousDoc,
    req,
    skipCompilation,
  }),
  restoreBeforeChangeArgs: (
    parentDocID: Any,
    collection: Any,
    req: Any,
    data: Any,
    originalDoc: Any,
    versionToRestoreWithLocales: Any,
    overrideAccess: Any,
    reqWithValidationLocale: Any,
    draftArg: Any,
  ) => ({
    id: parentDocID,
    collection,
    context: req.context,
    data: { ...data, id: parentDocID },
    doc: originalDoc,
    docWithLocales: versionToRestoreWithLocales,
    global: null,
    operation: 'update',
    overrideAccess,
    req: reqWithValidationLocale,
    skipValidation: draftArg && !hasDraftValidationEnabled(collection),
  }),
  restoreBeforeValidateArgs: (
    parentDocID: Any,
    collection: Any,
    req: Any,
    prevVersionDoc: Any,
    originalDoc: Any,
    overrideAccess: Any,
    reqWithValidationLocale: Any,
  ) => ({
    id: parentDocID,
    collection,
    context: req.context,
    data: deepCopyObjectSimple(prevVersionDoc),
    doc: originalDoc,
    global: null,
    operation: 'update',
    overrideAccess,
    req: reqWithValidationLocale,
  }),
  restoreCheckVersionAccess: (id: Any, collectionConfig: Any, req: Any) =>
    req.payload.findVersionByID({
      id: String(id),
      collection: collectionConfig.slug,
      depth: 0,
      overrideAccess: false,
      req,
    }),
  restoreDataHookArgs: (
    collection: Any,
    req: Any,
    data: Any,
    originalDoc: Any,
    reqWithValidationLocale: Any,
  ) => ({
    collection,
    context: req.context,
    data,
    operation: 'update',
    originalDoc,
    req: reqWithValidationLocale,
    skipCompilation,
  }),
  restoredStatuses: (draftArg: Any, versionToRestoreWithLocales: Any) =>
    draftArg ? ['draft'] : getRestoredStatusesToAuthorize(versionToRestoreWithLocales?._status),
  restoreFindOneArgs: (
    collectionConfig: Any,
    req: Any,
    accessResultsList: Any,
    parentDocID: Any,
  ) => ({
    collection: collectionConfig.slug,
    locale: 'all',
    req,
    where: accessResultsList.reduce((where: Any, result: Any) => combineQueries(where, result), {
      id: { equals: parentDocID },
    }),
  }),
  restoreFindVersionsArgs: (collectionConfig: Any, req: Any, id: Any) => ({
    collection: collectionConfig.slug,
    limit: 1,
    locale: 'all',
    pagination: false,
    req,
    where: { id: { equals: id } },
  }),
  restoreOriginalAfterReadArgs: (
    collection: Any,
    req: Any,
    doc: Any,
    draftArg: Any,
    validationLocale: Any,
  ) => ({
    collection,
    context: req.context,
    depth: 0,
    doc: deepCopyObjectSimple(doc),
    draft: draftArg,
    fallbackLocale: null,
    global: null,
    locale: validationLocale,
    overrideAccess: true,
    req,
    showHiddenFields: true,
  }),
  restoreSaveVersion: (
    parentDocID: Any,
    collection: Any,
    result: Any,
    draftArg: Any,
    payload: Any,
    reqWithValidationLocale: Any,
    select: Any,
  ) =>
    saveVersion({
      id: parentDocID,
      autosave: false,
      collection,
      docWithLocales: result,
      draft: draftArg,
      operation: 'restoreVersion',
      payload,
      req: reqWithValidationLocale,
      select,
    }),
  restoreStampResult: (result: Any, draftArg: Any) => {
    // Ensure updatedAt date is always updated
    result.updatedAt = new Date().toISOString()
    // Ensure status respects restoreAsDraft arg
    result._status = draftArg ? 'draft' : result._status
  },
  restoreUpdateOneArgs: (
    parentDocID: Any,
    collectionConfig: Any,
    result: Any,
    reqWithValidationLocale: Any,
    select: Any,
  ) => ({
    id: parentDocID,
    collection: collectionConfig.slug,
    data: result,
    req: reqWithValidationLocale,
    select,
  }),
  restoreUploadDataFromDocument: (result: Any, restored: Any) =>
    restoreUploadDataFromDocument(result, restored, { clearMissing: true }),
  restoreValidationRequest: (req: Any, validationLocale: Any) => {
    req.context.isRestoringVersion = true

    const reqWithValidationLocale = isolateObjectProperty(req, ['fallbackLocale', 'locale'])
    shareFileOperationScope({ owner: req, req: reqWithValidationLocale })
    reqWithValidationLocale.fallbackLocale = null
    reqWithValidationLocale.locale = validationLocale
    return reqWithValidationLocale
  },
  restoreVersionArgs: (args: Any) => {
    const {
      id,
      collection: { config: collectionConfig },
      depth,
      draft: draftArg = false,
      overrideAccess = false,
      populate,
      req,
      req: { fallbackLocale, locale, payload },
      select: incomingSelect,
      showHiddenFields,
    } = args

    return [
      id,
      collectionConfig,
      depth,
      draftArg,
      overrideAccess,
      populate,
      req,
      fallbackLocale,
      locale,
      payload,
      incomingSelect,
      showHiddenFields,
    ]
  },
  runStoredFileRestore: (
    id: Any,
    collection: Any,
    current: Any,
    req: Any,
    selected: Any,
    write: (restored: Any) => Promise<Any>,
  ) =>
    runStoredFileRestore({
      id,
      collection,
      current,
      req,
      selected,
      write,
    }),
  someWhereAccessResult: (accessResultsList: Any) =>
    accessResultsList.some((result: Any) => hasWhereAccessResult(result)),
  statusData: (status: Any) => ({ _status: status }),
  statusesToAuthorize: (restoredStatuses: Any) =>
    restoredStatuses.length > 0 ? restoredStatuses : [undefined],
  validationLocaleOf: (payload: Any, locale: Any) =>
    payload.config.localization ? payload.config.localization.defaultLocale : locale!,

  // ---------------------------------------------------------------- validate.ts
  /**
   * The `beforeValidation` and `validateData` arrows of validate.ts's `runValidationLifecycle({...})`
   * call (an object literal, so the arrows keep their upstream names).
   */
  validateLifecycleCallbacks: (collectionConfig: Any, id: Any, originalDoc: Any, req: Any) => ({
    beforeValidation: ({ data }: Any) => {
      if (!collectionConfig.auth) {
        return
      }

      if (id === undefined) {
        ensureUsernameOrEmail({
          authOptions: collectionConfig.auth,
          collectionSlug: collectionConfig.slug,
          data,
          operation: 'create',
          req,
        })
      } else {
        ensureUsernameOrEmail({
          authOptions: collectionConfig.auth,
          collectionSlug: collectionConfig.slug,
          data,
          operation: 'update',
          originalDoc,
          req,
        })
      }
    },
    validateData: ({ data }: Any) =>
      validateUniqueConstraints({
        id,
        collection: collectionConfig,
        data,
        req,
      }),
  }),

  // ---------------------------------------------------------------- runValidationLifecycle.ts
  // (crates/payload-core-ops-write validation_lifecycle.rs; also used by the global validate)
  /** `deepCopyObjectSimple(incomingData ?? {})` */
  deepMergeWithSourceArraysIgnoringUndefined: (originalDoc: Any, data: Any) =>
    deepMergeWithSourceArraysIgnoringUndefined(originalDoc, data),
  lifecycleCopyIncomingData: (incomingData: Any) => deepCopyObjectSimple(incomingData ?? {}),
  /** `{ data }` */
  dataArg: (data: Any) => ({ data }),
  lifecycleBeforeValidateArgs: (
    id: Any,
    collection: Any,
    req: Any,
    data: Any,
    originalDoc: Any,
    global: Any,
    validationOperation: Any,
    overrideAccess: Any,
  ) => ({
    id,
    collection,
    context: req.context,
    data,
    doc: originalDoc,
    global,
    operation: validationOperation,
    overrideAccess,
    req,
  }),
  /** `for (const hook of <hooks> ?? [])` over a value that is neither nullish nor a plain array. */
  *forOfNullishOr(hooks: Any) {
    for (const hook of hooks ?? []) {
      yield hook
    }
  },
  lifecycleCollectionHookArgs: (
    collection: Any,
    req: Any,
    data: Any,
    validationOperation: Any,
    originalDoc: Any,
  ) => ({
    collection,
    context: req.context,
    data,
    operation: validationOperation,
    originalDoc,
    req,
    skipCompilation,
  }),
  lifecycleGlobalCreateError: () =>
    new Error('Global validation does not support the create operation.'),
  lifecycleGlobalHookArgs: (
    req: Any,
    data: Any,
    global: Any,
    validationOperation: Any,
    originalDoc: Any,
    overrideAccess: Any,
  ) => ({
    context: req.context,
    data,
    global,
    operation: validationOperation,
    originalDoc,
    overrideAccess,
    req,
    skipCompilation,
  }),
  /** The `beforeChange({...})` args; `onDataProcessed` stores into `processed[0]`. */
  lifecycleBeforeChangeArgs: (
    id: Any,
    collection: Any,
    req: Any,
    data: Any,
    originalDoc: Any,
    docWithLocales: Any,
    global: Any,
    validationOperation: Any,
    overrideAccess: Any,
    skipMutationHooks: Any,
    processed: Any[],
  ) => ({
    id,
    collection,
    context: req.context,
    data: id === undefined ? data : { ...data, id },
    doc: originalDoc,
    docWithLocales,
    global,
    isValidationOperation: true,
    onDataProcessed: (result: Any) => {
      processed[0] = deepCopyObjectSimple(result)
    },
    operation: validationOperation,
    overrideAccess,
    req,
    skipHooks: skipMutationHooks,
  }),
  /** `return toValidationResult({ error, req })` */
  lifecycleValidationResult: (error: Any, req: Any) => toValidationResult({ error, req }),
  /** `return { errors: [], valid: true }` */
  lifecycleValid: () => ({
    errors: [],
    valid: true,
  }),
  setValidationOperation: (args: Any) => {
    args.req.operation = args.validationOperation ?? 'validate'
  },
  spreadWithReq: (query: Any, req: Any) => ({
    ...query,
    req,
  }),
  validateAfterReadArgs: (collection: Any, req: Any, docWithLocales: Any, draft: Any) => ({
    collection,
    context: req.context,
    depth: 0,
    doc: deepCopyObjectSimple(docWithLocales),
    draft,
    fallbackLocale: null,
    global: null,
    locale: req.locale!,
    overrideAccess: true,
    req,
    showHiddenFields: true,
  }),
  validateArgs: ({
    id,
    collection,
    data: incomingData,
    draft,
    onValidationData,
    overrideAccess,
    req,
    skipAccessControl = false,
    skipMutationHooks = false,
    sourceData,
    trash = false,
    validationOperation = 'validate',
  }: Any) => [
    id,
    collection,
    incomingData,
    draft,
    onValidationData,
    overrideAccess,
    req,
    skipAccessControl,
    skipMutationHooks,
    sourceData,
    trash,
    validationOperation,
  ],
  validateExistingVersionsArgs: (collectionConfig: Any, req: Any, idWhere: Any) => ({
    collection: collectionConfig.slug,
    limit: 1,
    locale: req.locale!,
    pagination: false,
    req,
    select: { parent: true },
    where: appendVersionToQueryKey(idWhere),
  }),
  validateIdWhere: (collectionConfig: Any, trash: Any, id: Any) =>
    appendNonTrashedFilter({
      enableTrash: collectionConfig.trash,
      trash,
      where: { id: { equals: id } },
    }),
  validateInitialDocWithLocales: (sourceData: Any) =>
    sourceData ? deepCopyObjectSimple(sourceData.docWithLocales) : {},
  validateOriginalFromSource: (
    req: Any,
    sourceData: Any,
    docWithLocales: Any,
    collectionConfig: Any,
  ) =>
    req.locale === sourceData.originalLocale
      ? deepCopyObjectSimple(sourceData.originalDoc)
      : flattenDataByLocale({
          configBlockReferences: req.payload.config.blocks,
          docWithLocales,
          fields: collectionConfig.fields,
          locale: req.locale!,
        }),
  validateQueryDraftsArgs: (collectionConfig: Any, req: Any, where: Any) => ({
    collection: collectionConfig.slug,
    limit: 1,
    locale: req.locale!,
    pagination: false,
    req,
    where: appendVersionToQueryKey(where),
  }),
})
