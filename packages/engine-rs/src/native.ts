import { createRequire } from 'node:module'

/** `crates/payload-node/src/engine.rs` (see ENGINE_CONTRACT.md). */
export type NativeSqliteEngine = {
  attachClient: (clientId: number) => void
  /**
   * `contextJson` = `{ now, allowIDOnCreate, blocksAsJSON, limitedBoundParameters }`: the JS clock
   * (`Date.now()`) at the call, for the "now" stamps upstream takes from `new Date()` (so faked
   * clocks apply), and the adapter properties drizzle reads at call time (changed after init).
   */
  call: (method: string, argsJson: string, connId: number, contextJson: string) => Promise<string>
  rawSchema: () => string
}

export type NativeSqliteEngineClass = {
  create: (
    graphJson: string,
    optionsJson: string,
    callFunction: (id: number, argJson: string) => string,
  ) => NativeSqliteEngine
}

export type NativeEngine = {
  buildRawSchema: (
    graph: string,
    options: string,
    callFunction: (id: number, arg: string) => string,
  ) => string
  /** Absent until the Rust engine is built into the addon. */
  SqliteEngine?: NativeSqliteEngineClass
  version: () => string
}

let native: NativeEngine | undefined

/**
 * Loads the addon. `PAYLOAD_ENGINE_ADDON` may point at an alternative build (an agent-local cargo
 * target dir); it is the same path `sqlite/native.ts` loads, so both share one addon instance.
 */
export const getNativeEngine = (): NativeEngine => {
  if (!native) {
    const require = createRequire(import.meta.url)
    native = require(process.env.PAYLOAD_ENGINE_ADDON || '../payload-engine.node') as NativeEngine
  }
  return native
}
