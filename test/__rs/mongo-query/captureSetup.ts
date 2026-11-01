// Setup file of vitest.capture.config.ts: writes the recorded fixtures when a test file is done.
import { afterAll } from 'vitest'

import { flush } from './capture.js'

afterAll(() => {
  flush()
})
