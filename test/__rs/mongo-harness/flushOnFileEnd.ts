/**
 * Setup file of test/__rs/mongo-harness/vitest.config.ts: after each test file, calls the flush
 * functions the Rust engine glue (engine stats) and the shadow adapter (shadow totals) registered
 * (packages/engine-rs/src/mongo-adapter/flushOnFileEnd.ts). vitest terminates its workers without
 * an `exit` event, so totals of a Payload the test never destroys would otherwise be lost. Runs
 * last (`afterAll` hooks run in reverse registration order, setup files register first).
 */
import { afterAll } from 'vitest'

afterAll(() => {
  const registry = (globalThis as Record<symbol, Set<() => void> | undefined>)[
    Symbol.for('payload.rs.flushOnFileEnd')
  ]
  for (const flush of registry ?? []) {
    flush()
  }
})
