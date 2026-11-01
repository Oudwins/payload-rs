/**
 * Stand-in for packages/payload/src/auth/operations/me.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `meOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/me.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/me.js'

export const meOperation = wrapOperation(
  'auth.me',
  () => real.meOperation,
  () => real.meOperationTS,
)
