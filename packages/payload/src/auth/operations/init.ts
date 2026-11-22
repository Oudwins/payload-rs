import type { PayloadRequest, Where } from '../../types/index.js'

import { appendNonTrashedFilter } from '../../utilities/appendNonTrashedFilter.js'
import { isRustCoreEngine } from '../../utilities/engineSelection.js'

export const initOperationTS = async (args: {
  collection: string
  req: PayloadRequest
}): Promise<boolean> => {
  const { collection: slug, req } = args

  const collectionConfig = req.payload.config.collections?.find((c) => c.slug === slug)

  // Exclude trashed documents unless `trash: true`
  const where: Where = appendNonTrashedFilter({
    enableTrash: Boolean(collectionConfig?.trash),
    trash: false,
    where: {},
  })

  const doc = await req.payload.db.findOne({
    collection: slug,
    req,
    where,
  })

  return !!doc
}

type RustOperations = {
  initOperation: (args: any) => Promise<any>
  recordDeferredCall: () => void
}

/**
 * Rust engine (`packages/engine-rs/src/ops-global`), selected once at module load:
 * `isRustCoreEngine({ override: 'PAYLOAD_OPS_GLOBAL_ENGINE' })` (Rust unless `PAYLOAD_ENGINE=ts`, utilities/engineSelection.ts).
 * See RUST_OPS_DESIGN.md.
 */
const isRustOperations = isRustCoreEngine({ override: 'PAYLOAD_OPS_GLOBAL_ENGINE' })
const rustOperationsSpecifier = '@payloadcms/engine-rs/ops-global'
let rustOperations: RustOperations | undefined
const rustOperationsLoad: Promise<RustOperations> | undefined = isRustOperations
  ? import('../../utilities/importRustEngine.js')
      .then(({ importRustEngine }) => importRustEngine(rustOperationsSpecifier))
      .then((loaded: RustOperations) => (rustOperations = loaded))
  : undefined
void rustOperationsLoad?.catch(() => {})

export const initOperation: typeof initOperationTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.initOperation(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.initOperation(args)
          })
  : initOperationTS
