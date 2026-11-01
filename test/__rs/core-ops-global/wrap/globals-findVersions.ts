/**
 * Stand-in for packages/payload/src/globals/operations/findVersions.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `findVersionsOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/globals/operations/findVersions.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/globals/operations/findVersions.js'

export const findVersionsOperation = wrapOperation(
  'global.findVersions',
  () => real.findVersionsOperation,
  () => real.findVersionsOperationTS,
)
