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
  /** Runs one fused request (JSON), returning the result JSON or `!<reason>`. */
  run: (requestJson: string) => Promise<string> | string
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
