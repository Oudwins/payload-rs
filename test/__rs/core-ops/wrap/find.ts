/**
 * Stand-in for packages/payload/src/collections/operations/find.ts (redirected by
 * ../vitest.config.ts): `findOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { findOperation as rs } from '../../../../packages/engine-rs/src/ops/index.js'
import { findOperationTS as ts } from '../../../../packages/payload/src/collections/operations/find.js'
import { dispatch } from '../shadow.js'

export const findOperation = dispatch(
  'find',
  () => ts,
  () => rs,
)
