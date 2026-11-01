/**
 * Stand-in for packages/payload/src/collections/operations/duplicate.ts (redirected by
 * ../vitest.config.ts): `duplicateOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { duplicateOperation as rs } from '../../../../packages/engine-rs/src/ops-write/index.js'
import { duplicateOperation as ts } from '../../../../packages/payload/src/collections/operations/duplicate.js'
import { dispatch } from '../shadow.js'

export const duplicateOperation = dispatch(
  'duplicate',
  () => ts,
  () => rs,
)
