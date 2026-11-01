/**
 * Live differential (TS vs Rust query validation, see ./harness.ts) on test/access-control/config.ts.
 *
 *   PAYLOAD_CORE_RUNTIME_ADDON=<query addon> test/__rs/core-query/live/run.sh access-control
 */
import { vi } from 'vitest'

import { registerLiveDifferential } from './harness.js'

vi.mock(
  import('../../../../packages/payload/src/utilities/getEntityPermissions/getEntityPermissions.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapGetEntityPermissions } = await import('./record.js')
    return { ...mod, getEntityPermissions: wrapGetEntityPermissions(mod.getEntityPermissions) }
  },
)

vi.mock(
  import('../../../../packages/payload/src/auth/executeAccess.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapExecuteAccess } = await import('./record.js')
    return { ...mod, executeAccess: wrapExecuteAccess(mod.executeAccess) }
  },
)

import { test } from '../../../__helpers/int/vitest.js'

test.suite(
  'core-query live: access-control',
  { config: '../../../access-control/config.ts', resetBetweenTests: false },
  () => {
    registerLiveDifferential({ minCases: 300, minHostCalls: 50, name: 'access-control' })
  },
)
