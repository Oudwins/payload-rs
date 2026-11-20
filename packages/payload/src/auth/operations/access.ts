import type { PayloadRequest } from '../../types/index.js'
import type { SanitizedPermissions } from '../types.js'

import { adminInit as adminInitTelemetry } from '../../utilities/telemetry/events/adminInit.js'
import { getAccessResults } from '../getAccessResults.js'

type Arguments = {
  req: PayloadRequest
}

export const accessOperationTS = async (args: Arguments): Promise<SanitizedPermissions> => {
  const { req } = args

  adminInitTelemetry(req)

  return getAccessResults({ req })
}

type RustOperations = {
  accessOperation: (args: any) => Promise<any>
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

export const accessOperation: typeof accessOperationTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.accessOperation(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.accessOperation(args)
          })
  : accessOperationTS
