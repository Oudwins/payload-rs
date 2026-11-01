/**
 * Stand-in for packages/payload/src/collections/operations/deleteByID.ts (redirected by
 * ../vitest.config.ts): `deleteByIDOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { deleteByIDOperation as rs } from '../../../../packages/engine-rs/src/ops-write/index.js'
import { deleteByIDOperation as ts } from '../../../../packages/payload/src/collections/operations/deleteByID.js'
import { dispatch } from '../shadow.js'

export const deleteByIDOperation = dispatch(
  'deleteByID',
  () => ts,
  () => rs,
)
