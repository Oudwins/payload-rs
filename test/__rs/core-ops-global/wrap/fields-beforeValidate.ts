/**
 * Stand-in for packages/payload/src/fields/hooks/beforeValidate/index.ts (redirected by ../vitest.config.ts): the module's
 * exports, with `beforeValidate` traced by ../trace.ts.
 */
import * as real from '../../../../packages/payload/src/fields/hooks/beforeValidate/index.js'
import { wrapTraversal } from '../trace.js'

export * from '../../../../packages/payload/src/fields/hooks/beforeValidate/index.js'

export const beforeValidate = wrapTraversal('beforeValidate', () => real.beforeValidate)
