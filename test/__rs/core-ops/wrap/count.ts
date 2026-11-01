/**
 * Stand-in for packages/payload/src/collections/operations/count.ts (redirected by
 * ../vitest.config.ts): `countOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { countOperation as rs } from '../../../../packages/engine-rs/src/ops/index.js'
import { countOperationTS as ts } from '../../../../packages/payload/src/collections/operations/count.js'
import { dispatch } from '../shadow.js'

export const countOperation = dispatch(
  'count',
  () => ts,
  () => rs,
)
