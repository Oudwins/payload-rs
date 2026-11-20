import type { SanitizedCollectionPermission } from '../../auth/index.js'
import type { AllOperations, JsonObject, PayloadRequest } from '../../types/index.js'
import type { Collection } from '../config/types.js'

import { getEntityPermissions } from '../../utilities/getEntityPermissions/getEntityPermissions.js'
import { sanitizePermissions } from '../../utilities/sanitizePermissions.js'

const allOperations: AllOperations[] = ['create', 'read', 'update', 'delete', 'validate']

type Arguments = {
  collection: Collection
  /**
   * If the document data is passed, it will be used to check access instead of fetching the document from the database.
   */
  data?: JsonObject
  /**
   * When called for creating a new document, id is not provided.
   */
  id?: number | string
  req: PayloadRequest
}

export async function docAccessOperationTS(
  args: Arguments,
): Promise<SanitizedCollectionPermission> {
  const {
    id,
    collection: { config },
    data,
    req,
  } = args

  const collectionOperations = [...allOperations]

  if (
    config.auth &&
    typeof config.auth.maxLoginAttempts !== 'undefined' &&
    config.auth.maxLoginAttempts !== 0
  ) {
    collectionOperations.push('unlock')
  }

  if (config.versions) {
    collectionOperations.push('readVersions')
  }

  const result = await getEntityPermissions({
    id: id!,
    blockReferencesPermissions: {},
    data,
    entity: config,
    entityType: 'collection',
    fetchData: id ? true : (false as true),
    operations: collectionOperations,
    req,
  })

  const sanitizedPermissions = sanitizePermissions({
    collections: {
      [config.slug]: result,
    },
  })

  const collectionPermissions = sanitizedPermissions?.collections?.[config.slug]
  return collectionPermissions ?? { fields: {} }
}

type RustOperations = {
  docAccessOperation: (args: Arguments) => Promise<any>
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

export const docAccessOperation: typeof docAccessOperationTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.docAccessOperation(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.docAccessOperation(args)
          })
  : docAccessOperationTS
