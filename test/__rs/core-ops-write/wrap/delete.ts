/**
 * Stand-in for packages/payload/src/collections/operations/delete.ts (redirected by
 * ../vitest.config.ts): `deleteOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { deleteOperation as rs } from '../../../../packages/engine-rs/src/ops-write/index.js'
import { deleteOperation as ts } from '../../../../packages/payload/src/collections/operations/delete.js'
import { dispatch } from '../shadow.js'

export const deleteOperation = dispatch(
  'delete',
  () => ts,
  () => rs,
)
