/**
 * Stand-in for packages/payload/src/collections/operations/validate.ts (redirected by
 * ../vitest.config.ts): `validateOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { validateOperation as rs } from '../../../../packages/engine-rs/src/ops-write/index.js'
import { validateOperation as ts } from '../../../../packages/payload/src/collections/operations/validate.js'
import { dispatch } from '../shadow.js'

export const validateOperation = dispatch(
  'validate',
  () => ts,
  () => rs,
)
