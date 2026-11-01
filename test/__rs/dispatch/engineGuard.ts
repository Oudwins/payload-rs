/**
 * Guards for the differential harnesses (test/__rs/core-*): the TS side must be upstream's own
 * implementation and must not reach the Rust core engine (directly, or through a dispatching export
 * such as payload's `afterRead` used by relationship population when PAYLOAD_ENGINE /
 * PAYLOAD_CORE_ENGINE is set), and the Rust side must actually run Rust. Otherwise both sides could
 * run the same engine and every comparison would trivially pass.
 */
import { getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'

/** Throws unless the TS reference and the Rust implementation are distinct functions. */
export const assertDistinctEngines = (label: string, ts: unknown, rs: unknown): void => {
  if (typeof ts !== 'function' || typeof rs !== 'function' || ts === rs) {
    throw new Error(
      `${label}: the TS reference and the Rust implementation must be distinct functions`,
    )
  }
}

/**
 * Starts measuring one engine's run: `finish(cases)` throws if a TS run called into the Rust core
 * engine at all (any exported engine function or task), or if a Rust run of at least one case did
 * not.
 */
export const startEngineRun = (
  engine: 'rs' | 'ts',
  label: string,
): { finish: (cases: number) => void } => {
  const count = () => {
    const { entries, tasks } = getCoreRuntime().stats()
    return entries + tasks
  }
  const before = count()
  return {
    finish: (cases) => {
      const used = count() - before
      if (engine === 'ts' && used !== 0) {
        throw new Error(
          `${label}: the TS reference run called the Rust core engine ${used} times (is PAYLOAD_ENGINE or PAYLOAD_CORE_ENGINE set?)`,
        )
      }
      if (engine === 'rs' && cases > 0 && used === 0) {
        throw new Error(`${label}: the Rust run never called the Rust core engine`)
      }
    },
  }
}
