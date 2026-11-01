/**
 * Stand-in for packages/payload/src/globals/operations/countGlobalVersions.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `countGlobalVersionsOperation` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/globals/operations/countGlobalVersions.js'
import { wrapOperation } from '../trace.js'

export * from '../../../../packages/payload/src/globals/operations/countGlobalVersions.js'

export const countGlobalVersionsOperation = wrapOperation(
  'global.countVersions',
  () => real.countGlobalVersionsOperation,
  () => real.countGlobalVersionsOperationTS,
)
