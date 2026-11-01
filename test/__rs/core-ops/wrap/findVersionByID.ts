/**
 * Stand-in for packages/payload/src/collections/operations/findVersionByID.ts (redirected by
 * ../vitest.config.ts): `findVersionByIDOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { findVersionByIDOperation as rs } from '../../../../packages/engine-rs/src/ops/index.js'
import { findVersionByIDOperation as ts } from '../../../../packages/payload/src/collections/operations/findVersionByID.js'
import { dispatch } from '../shadow.js'

export const findVersionByIDOperation = dispatch(
  'findVersionByID',
  () => ts,
  () => rs,
)
