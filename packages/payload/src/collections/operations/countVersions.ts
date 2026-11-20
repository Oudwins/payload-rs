import type { AccessResult } from '../../config/types.js'
import type { PayloadRequest, Where } from '../../types/index.js'
import type { Collection } from '../config/types.js'

import { executeAccess } from '../../auth/executeAccess.js'
import { combineQueries } from '../../database/combineQueries.js'
import { validateQueryPaths } from '../../database/queryValidation/validateQueryPaths.js'
import { sanitizeWhereQuery } from '../../database/sanitizeWhereQuery.js'
import { buildVersionCollectionFields, type CollectionSlug } from '../../index.js'
import { buildAfterOperation } from './utilities/buildAfterOperation.js'
import { buildBeforeOperation } from './utilities/buildBeforeOperation.js'

export type Arguments = {
  collection: Collection
  disableErrors?: boolean
  overrideAccess?: boolean
  req?: PayloadRequest
  where?: Where
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const countVersionsOperationTS = async <TSlug extends CollectionSlug>(
  incomingArgs: Arguments,
): Promise<{ totalDocs: number }> => {
  let args = incomingArgs

  // /////////////////////////////////////
  // beforeOperation - Collection
  // /////////////////////////////////////

  args = await buildBeforeOperation({
    args,
    collection: args.collection.config,
    operation: 'countVersions',
    overrideAccess: args.overrideAccess!,
  })

  const {
    collection: { config: collectionConfig },
    disableErrors,
    overrideAccess,
    req,
    where,
  } = args

  const { locale, payload } = req!

  // /////////////////////////////////////
  // Access
  // /////////////////////////////////////

  let accessResult: AccessResult

  if (!overrideAccess) {
    accessResult = await executeAccess(
      { slug: collectionConfig.slug, disableErrors, req: req! },
      collectionConfig.access.readVersions,
    )

    // If errors are disabled, and access returns false, return empty results
    if (accessResult === false) {
      return {
        totalDocs: 0,
      }
    }
  }

  let result: { totalDocs: number }

  const fullWhere = combineQueries(where!, accessResult!)

  const versionFields = buildVersionCollectionFields(payload.config, collectionConfig, true)

  sanitizeWhereQuery({ fields: versionFields, payload, where: fullWhere })

  await validateQueryPaths({
    collectionConfig,
    overrideAccess: overrideAccess!,
    req: req!,
    versionFields,
    where: where!,
  })

  result = await payload.db.countVersions({
    collection: collectionConfig.slug,
    locale: locale!,
    req,
    where: fullWhere,
  })

  // /////////////////////////////////////
  // afterOperation - Collection
  // /////////////////////////////////////

  result = await buildAfterOperation({
    args,
    collection: collectionConfig,
    operation: 'countVersions',
    overrideAccess,
    result,
  })

  // /////////////////////////////////////
  // Return results
  // /////////////////////////////////////

  return result
}

type RustOperations = {
  countVersionsOperation: (args: Arguments) => Promise<any>
  recordDeferredCall: () => void
}

/**
 * Rust engine (`packages/engine-rs/src/ops`), selected once at module load:
 * `PAYLOAD_CORE_ENGINE=rs|ts`, else `PAYLOAD_ENGINE=rs`. See RUST_OPS_DESIGN.md.
 */
const isRustOperations = (process.env.PAYLOAD_CORE_ENGINE || process.env.PAYLOAD_ENGINE) === 'rs'
const rustOperationsSpecifier = '@payloadcms/engine-rs/ops'
let rustOperations: RustOperations | undefined
const rustOperationsLoad: Promise<RustOperations> | undefined = isRustOperations
  ? import('../../utilities/importRustEngine.js')
      .then(({ importRustEngine }) => importRustEngine(rustOperationsSpecifier))
      .then((loaded: RustOperations) => (rustOperations = loaded))
  : undefined
void rustOperationsLoad?.catch(() => {})

export const countVersionsOperation: typeof countVersionsOperationTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.countVersionsOperation(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.countVersionsOperation(args)
          })
  : countVersionsOperationTS
