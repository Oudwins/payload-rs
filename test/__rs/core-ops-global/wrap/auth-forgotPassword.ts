/**
 * Stand-in for packages/payload/src/auth/operations/forgotPassword.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `forgotPasswordOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/forgotPassword.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/forgotPassword.js'

export const forgotPasswordOperation = wrapOperation(
  'auth.forgotPassword',
  () => real.forgotPasswordOperation,
  () => real.forgotPasswordOperationTS,
)
