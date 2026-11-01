/**
 * Stand-in for packages/payload/src/collections/operations/create.ts (redirected by
 * ../vitest.config.ts): `createOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { createOperation as rs } from '../../../../packages/engine-rs/src/ops-write/index.js'
import { createOperation as ts } from '../../../../packages/payload/src/collections/operations/create.js'
import { dispatch } from '../shadow.js'

export const createOperation = dispatch(
  'create',
  () => ts,
  () => rs,
)
