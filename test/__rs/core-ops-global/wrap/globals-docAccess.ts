/**
 * Stand-in for packages/payload/src/globals/operations/docAccess.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `docAccessOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/globals/operations/docAccess.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/globals/operations/docAccess.js'

export const docAccessOperation = wrapOperation(
  'global.docAccess',
  () => real.docAccessOperation,
  () => real.docAccessOperationTS,
)
