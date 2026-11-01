/**
 * Stand-in for packages/payload/src/auth/operations/resetPassword.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `resetPasswordOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/resetPassword.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/resetPassword.js'

export const resetPasswordOperation = wrapOperation(
  'auth.resetPassword',
  () => real.resetPasswordOperation,
  () => real.resetPasswordOperationTS,
)
