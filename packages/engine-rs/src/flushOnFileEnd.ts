/**
 * Harness registry (`Symbol.for('payload.rs.flushOnFileEnd')` on `globalThis`): functions the
 * mongo-harness vitest setup file (test/__rs/mongo-harness/flushOnFileEnd.ts) calls after each test
 * file. Only used while a stats file is configured.
 */
export const registerFlushOnFileEnd = (flush: () => void) => {
  const key = Symbol.for('payload.rs.flushOnFileEnd')
  const registry = ((globalThis as Record<symbol, Set<() => void>>)[key] ??= new Set())
  registry.add(flush)
}
