/**
 * Stand-in for packages/payload/src/auth/operations/auth.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `auth` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/auth.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/auth.js'

export const auth = wrapOperation(
  'auth.auth',
  () => real.auth,
  () => real.authTS,
)
