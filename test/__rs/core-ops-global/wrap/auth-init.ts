/**
 * Stand-in for packages/payload/src/auth/operations/init.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `initOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/auth/operations/init.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/auth/operations/init.js'

export const initOperation = wrapOperation(
  'auth.init',
  () => real.initOperation,
  () => real.initOperationTS,
)
