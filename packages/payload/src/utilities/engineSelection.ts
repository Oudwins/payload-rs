/**
 * Which engine runs Payload: the Rust engine (`@payloadcms/engine-rs`, a Node-API addon) or the
 * upstream TypeScript implementation. The single source of truth for every dispatch site (payload's
 * operations, field hooks and validators, richtext-lexical's hooks, the database adapters); see
 * RUST_PORT.md.
 *
 * - `PAYLOAD_ENGINE`: `rs` (the default in Node.js), `ts` (upstream TypeScript), or `shadow` (the
 *   SQLite adapter's differential mode: both engines, the TS result is returned).
 * - `PAYLOAD_CORE_ENGINE` (`rs` | `ts`): the core's (operations, hooks, validators) engine, when it
 *   should differ from `PAYLOAD_ENGINE`.
 *
 * Outside Node.js (a browser bundle of a shared module, an edge runtime) there is no addon to load:
 * the default is `ts` there.
 */
const env: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? process.env : {}

const isNodeRuntime =
  typeof process !== 'undefined' &&
  typeof process.getBuiltinModule === 'function' &&
  process.release?.name === 'node'

const defaultEngine = isNodeRuntime ? 'rs' : 'ts'

/** The database adapters' engine is Rust (`PAYLOAD_ENGINE`, default `rs` in Node.js). */
export const isRustDatabaseEngine = () => (env.PAYLOAD_ENGINE || defaultEngine) === 'rs'

/**
 * The core's engine is Rust: `override` (a finer variable, e.g. `PAYLOAD_OPS_GLOBAL_ENGINE`) when
 * set, else `PAYLOAD_CORE_ENGINE`, else `PAYLOAD_ENGINE`, else the default.
 */
export const isRustCoreEngine = ({ override }: { override?: string } = {}) =>
  ((override && env[override]) ||
    env.PAYLOAD_CORE_ENGINE ||
    env.PAYLOAD_ENGINE ||
    defaultEngine) === 'rs'
