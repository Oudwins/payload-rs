/**
 * Stand-in for packages/payload/src/collections/operations/countVersions.ts (redirected by
 * ../vitest.config.ts): `countVersionsOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { countVersionsOperation as rs } from '../../../../packages/engine-rs/src/ops/index.js'
import { countVersionsOperation as ts } from '../../../../packages/payload/src/collections/operations/countVersions.js'
import { dispatch } from '../shadow.js'

export const countVersionsOperation = dispatch(
  'countVersions',
  () => ts,
  () => rs,
)
