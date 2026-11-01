/**
 * Stand-in for packages/payload/src/fields/hooks/afterRead/index.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `afterRead` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/fields/hooks/afterRead/index.js'
import { wrapTraversal } from '../trace.js'

export * from '../../../../packages/payload/src/fields/hooks/afterRead/index.js'

export const afterRead = wrapTraversal('afterRead', () => real.afterRead)
