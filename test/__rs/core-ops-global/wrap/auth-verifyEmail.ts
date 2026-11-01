/**
 * Stand-in for packages/payload/src/auth/operations/verifyEmail.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `verifyEmailOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/verifyEmail.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/verifyEmail.js'

export const verifyEmailOperation = wrapOperation(
  'auth.verifyEmail',
  () => real.verifyEmailOperation,
  () => real.verifyEmailOperationTS,
)
