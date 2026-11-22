import type { AuthenticatedUser, SanitizedPermissions } from '../../index.js'
import type { PayloadRequest } from '../../types/index.js'

import { isRustCoreEngine } from '../../utilities/engineSelection.js'
import { executeAuthStrategies } from '../executeAuthStrategies.js'
import { getAccessResults } from '../getAccessResults.js'

export type AuthArgs = {
  /**
   * Specify if it's possible for auth strategies to set headers within this operation.
   */
  canSetHeaders?: boolean
  headers: Request['headers']
  req?: Omit<PayloadRequest, 'user'>
}

export type AuthResult = {
  permissions: SanitizedPermissions
  responseHeaders?: Headers
  user: AuthenticatedUser | null
}

export const authTS = async (args: Required<AuthArgs>): Promise<AuthResult> => {
  const { canSetHeaders, headers } = args
  const req = args.req as PayloadRequest
  const { payload } = req

  const { responseHeaders, user } = await executeAuthStrategies({
    canSetHeaders,
    headers,
    payload,
    req,
  })

  req.user = user
  req.responseHeaders = responseHeaders

  const permissions = await getAccessResults({
    req,
  })

  return {
    permissions,
    responseHeaders,
    user,
  }
}

type RustOperations = {
  auth: (args: any) => Promise<any>
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

export const auth: typeof authTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.auth(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.auth(args)
          })
  : authTS
