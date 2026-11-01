import type { SanitizedGlobalPermission } from '../../auth/index.js'
import type { AllOperations, JsonObject, PayloadRequest } from '../../types/index.js'
import type { SanitizedGlobalConfig } from '../config/types.js'

import { getEntityPermissions } from '../../utilities/getEntityPermissions/getEntityPermissions.js'
import { sanitizePermissions } from '../../utilities/sanitizePermissions.js'

type Arguments = {
  /**
   * If the document data is passed, it will be used to check access instead of fetching the document from the database.
   */
  data?: JsonObject
  globalConfig: SanitizedGlobalConfig
  req: PayloadRequest
}

export const docAccessOperationTS = async (args: Arguments): Promise<SanitizedGlobalPermission> => {
  const { data, globalConfig, req } = args

  const globalOperations: AllOperations[] = ['read', 'update', 'validate']

  if (globalConfig.versions) {
    globalOperations.push('readVersions')
  }

  const result = await getEntityPermissions({
    id: undefined,
    blockReferencesPermissions: {},
    data,
    entity: globalConfig,
    entityType: 'global',
    fetchData: true,
    operations: globalOperations,
    req,
  })

  const sanitizedPermissions = sanitizePermissions({
    globals: {
      [globalConfig.slug]: result,
    },
  })

  const globalPermissions = sanitizedPermissions?.globals?.[globalConfig.slug]
  return globalPermissions ?? { fields: {} }
}

type RustOperations = {
  globalDocAccessOperation: (args: any) => Promise<any>
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
const rustOperationsSpecifier = '../../../../engine-rs/src/ops-global/index.js'
let rustOperations: RustOperations | undefined
const rustOperationsLoad: Promise<RustOperations> | undefined = isRustOperations
  ? import(/* @vite-ignore */ /* webpackIgnore: true */ rustOperationsSpecifier).then(
      (loaded: RustOperations) => (rustOperations = loaded),
    )
  : undefined
void rustOperationsLoad?.catch(() => {})

export const docAccessOperation: typeof docAccessOperationTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.globalDocAccessOperation(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.globalDocAccessOperation(args)
          })
  : docAccessOperationTS
