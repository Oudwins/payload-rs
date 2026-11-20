import type { AccessResult } from '../../config/types.js'
import type { PayloadRequest, Where } from '../../types/index.js'

import { executeAccess } from '../../auth/executeAccess.js'
import { combineQueries } from '../../database/combineQueries.js'
import { validateQueryPaths } from '../../database/queryValidation/validateQueryPaths.js'
import { sanitizeWhereQuery } from '../../database/sanitizeWhereQuery.js'
import {
  buildVersionGlobalFields,
  type GlobalSlug,
  type SanitizedGlobalConfig,
} from '../../index.js'

export type Arguments = {
  disableErrors?: boolean
  global: SanitizedGlobalConfig
  overrideAccess?: boolean
  req?: PayloadRequest
  where?: Where
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const countGlobalVersionsOperationTS = async <TSlug extends GlobalSlug>(
  args: Arguments,
): Promise<{ totalDocs: number }> => {
  const { disableErrors, global, overrideAccess, where } = args
  const req = args.req!
  const { payload } = req

  // /////////////////////////////////////
  // beforeOperation - Global
  // /////////////////////////////////////

  if (global.hooks?.beforeOperation?.length) {
    for (const hook of global.hooks.beforeOperation) {
      args =
        (await hook({
          args,
          context: req.context,
          global,
          operation: 'countVersions',
          overrideAccess,
          req,
        })) || args
    }
  }

  // /////////////////////////////////////
  // Access
  // /////////////////////////////////////

  let accessResult: AccessResult

  if (!overrideAccess) {
    accessResult = await executeAccess(
      { slug: global.slug, disableErrors, req },
      global.access.readVersions,
    )

    // If errors are disabled, and access returns false, return empty results
    if (accessResult === false) {
      return {
        totalDocs: 0,
      }
    }
  }

  const fullWhere = combineQueries(where!, accessResult!)

  const versionFields = buildVersionGlobalFields(payload.config, global, true)

  sanitizeWhereQuery({ fields: versionFields, payload, where: fullWhere })

  await validateQueryPaths({
    globalConfig: global,
    overrideAccess: overrideAccess!,
    req,
    versionFields,
    where: where!,
  })

  const result = await payload.db.countGlobalVersions({
    global: global.slug,
    locale: req?.locale || undefined,
    req,
    where: fullWhere,
  })

  // /////////////////////////////////////
  // Return results
  // /////////////////////////////////////

  return result
}

type RustOperations = {
  countGlobalVersionsOperation: (args: any) => Promise<any>
  recordDeferredCall: () => void
}

/**
 * Rust engine (`packages/engine-rs/src/ops-global`), selected once at module load:
 * `PAYLOAD_OPS_GLOBAL_ENGINE=rs|ts`, else `PAYLOAD_CORE_ENGINE=rs|ts`, else `PAYLOAD_ENGINE=rs`.
 * See RUST_OPS_DESIGN.md.
 */
const isRustOperations =
  (process.env.PAYLOAD_OPS_GLOBAL_ENGINE ||
    process.env.PAYLOAD_CORE_ENGINE ||
    process.env.PAYLOAD_ENGINE) === 'rs'
const rustOperationsSpecifier = '@payloadcms/engine-rs/ops-global'
let rustOperations: RustOperations | undefined
const rustOperationsLoad: Promise<RustOperations> | undefined = isRustOperations
  ? import('../../utilities/importRustEngine.js')
      .then(({ importRustEngine }) => importRustEngine(rustOperationsSpecifier))
      .then((loaded: RustOperations) => (rustOperations = loaded))
  : undefined
void rustOperationsLoad?.catch(() => {})

export const countGlobalVersionsOperation: typeof countGlobalVersionsOperationTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.countGlobalVersionsOperation(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.countGlobalVersionsOperation(args)
          })
  : countGlobalVersionsOperationTS
