/**
 * Stand-in for packages/payload/src/fields/hooks/beforeChange/index.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `beforeChange` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/fields/hooks/beforeChange/index.js'
import { wrapTraversal } from '../trace.js'

export * from '../../../../packages/payload/src/fields/hooks/beforeChange/index.js'

export const beforeChange = wrapTraversal('beforeChange', () => real.beforeChange)
