/**
 * Backend targets of the fused lanes (FUSE_CONTRACT.md section 6): a database adapter that can
 * serve fused reads registers a lookup for itself; the lookup says, per call, how a fused call
 * made now would run on it, or why it would not. Kept on `globalThis` so every copy of this
 * module (source and dist entries of one process) shares one registry. This module imports
 * nothing: loading it never loads a database driver.
 */
export type FusedTarget = {
  /** `"sqlite"`, `"mongodb"` */
  backend: string
  /**
   * The `db` part of a request for `payload.db[method](args)` and what `run` needs besides the
   * request, or the reason the call cannot be fused. Without it the `db` part is the args
   * serialized for the engine. `isWriteRead`: the read of a fused write (src/fuse-write).
   */
  encode?: (
    method: 'count' | 'find' | 'findOne',
    args: Record<string, unknown>,
    isWriteRead: boolean,
  ) => { db: string; payload: unknown } | string
  /**
   * Population: what the backend's nested finds of collection `slug` need besides their args
   * (`Related.backend` natively), or the reason they cannot run fused.
   */
  relatedBackend?: (
    slug: string,
    args: {
      /** the nested finds' `draft` (`draftsEnabled` of their `payload.db.find`) */
      draft: unknown
      /** the nested finds' `joins` argument (`false` for GraphQL, else `{}`) */
      joins: unknown
      locale: unknown
      overrideAccess: boolean
      select: unknown
      sort: unknown
    },
  ) => { backend: unknown } | string
  /** Runs one fused request (JSON), returning the result JSON or `!<reason>`. */
  run: (requestJson: string, payload?: unknown) => Promise<string> | string
  /**
   * Shadow mode: runs the exact lane (`exact`) and checks what the backend sees of it against
   * `payload` (e.g. the database commands), reporting differences through `report`.
   */
  shadowExact?: <T>(
    payload: unknown,
    exact: () => Promise<T>,
    report: (difference: Record<string, unknown>) => void,
  ) => Promise<T>
}

/** A target, or the reason a fused call cannot run on the adapter now. */
export type FusedTargetLookup = (adapter: object) => FusedTarget | string

const registryKey = Symbol.for('@payloadcms/engine-rs/fuse-targets')

const registry = ((globalThis as Record<symbol, unknown>)[registryKey] ??= new WeakMap<
  object,
  FusedTargetLookup
>()) as WeakMap<object, FusedTargetLookup>

export const registerFusedTarget = (adapter: object, lookup: FusedTargetLookup): void => {
  registry.set(adapter, lookup)
}

export const getFusedTarget = (adapter: unknown): FusedTarget | string => {
  if (typeof adapter !== 'object' || adapter === null) {
    return 'adapter:none'
  }
  const lookup = registry.get(adapter) ?? registry.get(Object.getPrototypeOf(adapter))
  return lookup ? lookup(adapter) : 'adapter:no-fused-backend'
}
