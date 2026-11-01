/**
 * Stand-in for packages/payload/src/collections/operations/docAccess.ts (redirected by
 * ../vitest.config.ts): `docAccessOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { docAccessOperation as rs } from '../../../../packages/engine-rs/src/ops/index.js'
import { docAccessOperationTS as ts } from '../../../../packages/payload/src/collections/operations/docAccess.js'
import { dispatch } from '../shadow.js'

export const docAccessOperation = dispatch(
  'docAccess',
  () => ts,
  () => rs,
)
