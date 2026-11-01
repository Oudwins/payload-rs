/**
 * Stand-in for packages/payload/src/collections/operations/findByID.ts (redirected by
 * ../vitest.config.ts): `findByIDOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { findByIDOperation as rs } from '../../../../packages/engine-rs/src/ops/index.js'
import { findByIDOperationTS as ts } from '../../../../packages/payload/src/collections/operations/findByID.js'
import { dispatch } from '../shadow.js'

export const findByIDOperation = dispatch(
  'findByID',
  () => ts,
  () => rs,
)
