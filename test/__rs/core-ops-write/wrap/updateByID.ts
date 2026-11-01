/**
 * Stand-in for packages/payload/src/collections/operations/updateByID.ts (redirected by
 * ../vitest.config.ts): `updateByIDOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { updateByIDOperation as rs } from '../../../../packages/engine-rs/src/ops-write/index.js'
import { updateByIDOperation as ts } from '../../../../packages/payload/src/collections/operations/updateByID.js'
import { dispatch } from '../shadow.js'

export const updateByIDOperation = dispatch(
  'updateByID',
  () => ts,
  () => rs,
)
