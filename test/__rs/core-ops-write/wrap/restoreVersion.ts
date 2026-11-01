/**
 * Stand-in for packages/payload/src/collections/operations/restoreVersion.ts (redirected by
 * ../vitest.config.ts): `restoreVersionOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { restoreVersionOperation as rs } from '../../../../packages/engine-rs/src/ops-write/index.js'
import { restoreVersionOperation as ts } from '../../../../packages/payload/src/collections/operations/restoreVersion.js'
import { dispatch } from '../shadow.js'

export const restoreVersionOperation = dispatch(
  'restoreVersion',
  () => ts,
  () => rs,
)
