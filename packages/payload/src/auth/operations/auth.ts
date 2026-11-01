import type { AuthenticatedUser, SanitizedPermissions } from '../../index.js'
import type { PayloadRequest } from '../../types/index.js'

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

export const auth: typeof authTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.auth(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.auth(args)
          })
  : authTS
