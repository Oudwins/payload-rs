/**
 * Stand-in for packages/payload/src/collections/operations/findDistinct.ts (redirected by
 * ../vitest.config.ts): `findDistinctOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { findDistinctOperation as rs } from '../../../../packages/engine-rs/src/ops/index.js'
import { findDistinctOperationTS as ts } from '../../../../packages/payload/src/collections/operations/findDistinct.js'
import { dispatch } from '../shadow.js'

export const findDistinctOperation = dispatch(
  'findDistinct',
  () => ts,
  () => rs,
)
