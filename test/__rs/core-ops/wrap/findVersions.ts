/**
 * Stand-in for packages/payload/src/collections/operations/findVersions.ts (redirected by
 * ../vitest.config.ts): `findVersionsOperation` dispatched by `PAYLOAD_OPS` (see ../shadow.ts).
 */
import { findVersionsOperation as rs } from '../../../../packages/engine-rs/src/ops/index.js'
import { findVersionsOperation as ts } from '../../../../packages/payload/src/collections/operations/findVersions.js'
import { dispatch } from '../shadow.js'

export const findVersionsOperation = dispatch(
  'findVersions',
  () => ts,
  () => rs,
)
