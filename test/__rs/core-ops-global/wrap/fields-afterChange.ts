/**
 * Stand-in for packages/payload/src/fields/hooks/afterChange/index.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `afterChange` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/fields/hooks/afterChange/index.js'
import { wrapTraversal } from '../trace.js'

export * from '../../../../packages/payload/src/fields/hooks/afterChange/index.js'

export const afterChange = wrapTraversal('afterChange', () => real.afterChange)
