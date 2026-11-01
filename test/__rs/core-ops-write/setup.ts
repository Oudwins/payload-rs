/**
 * Setup file of test/__rs/core-ops-write/vitest.config.ts: tracks the running test for diff
 * reports and writes this file's operation report (stats per operation, diffs) after the file.
 */
import { afterAll, beforeEach, expect } from 'vitest'

import { flushReport, loadRustCalls, setCurrentTest } from './shadow.js'

beforeEach(({ task }) => {
  setCurrentTest(task.name)
})

afterAll(async () => {
  await loadRustCalls()
  flushReport(expect.getState().testPath ?? 'unknown')
})
