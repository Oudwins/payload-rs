/**
 * Stand-in for packages/payload/src/auth/operations/unlock.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `unlockOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/unlock.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/unlock.js'

export const unlockOperation = wrapOperation(
  'auth.unlock',
  () => real.unlockOperation,
  () => real.unlockOperationTS,
)
