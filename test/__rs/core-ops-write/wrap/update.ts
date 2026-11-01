/**
 * Stand-in for packages/payload/src/collections/operations/update.ts (redirected by
 * ../vitest.config.ts): `updateOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { updateOperation as rs } from '../../../../packages/engine-rs/src/ops-write/index.js'
import { updateOperation as ts } from '../../../../packages/payload/src/collections/operations/update.js'
import { dispatch } from '../shadow.js'

export const updateOperation = dispatch(
  'update',
  () => ts,
  () => rs,
)
