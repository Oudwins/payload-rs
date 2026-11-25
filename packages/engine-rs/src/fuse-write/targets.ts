/**
 * Backend targets of the fused writes: a database adapter that can serve fused writes registers a
 * lookup for itself (the MongoDB driver lane, fuse-write/mongo.ts); the lookup says, per call, how
 * a fused write made now would run on it, or why it would not. On `globalThis` so every copy of
 * this module (source and dist entries of one process) shares one registry. Imports nothing:
 * loading it never loads a database driver.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- operation arguments are untyped here */
type Any = any

/** A prepared create: its generated id, the native request, the shadow's state reads. */
export type PreparedCreate = {
  /** The copy of the caller's `data` after `beforeValidate` (the mutations to replay). */
  data: Any
  id: string
  op: Uint8Array
  state: Uint8Array
}

/** A prepared `updateByID` / `deleteByID`: the native request, the shadow's state reads. */
export type PreparedByID = {
  op: Uint8Array
  state: Uint8Array
}

export type FusedWriteTarget = {
  backend: 'mongodb'
  /** The `req.context` writes an `updateByID` result carries (`run`'s third text). */
  contextWrites: (text: string) => [string, unknown][]
  /** The bson `ObjectId` class the adapter generates ids with (shadow replay). */
  objectIdClass: unknown
  /**
   * Prepares an `updateByID` / `deleteByID` of `args`: the clock readings and ids upstream would
   * take (update), the cast filters of its statements; the stored-document read and WP-I's
   * prepare run inside `run`. A string is a bail (nothing ran).
   */
  prepareByID: (name: 'deleteByID' | 'updateByID', args: Any) => Promise<PreparedByID | string>
  /**
   * Prepares a create of `args` on `data` and `context` (copies of the caller's data and
   * `req.context`, which upstream mutates in place: the dispatch replays that): the clock readings and
   * ids in upstream's order, the statements' documents. A string is a bail (nothing ran that the
   * caller can observe); a thrown error is the error the operation throws.
   */
  prepareCreate: (args: Any, data: Any, context: Any) => Promise<PreparedCreate | string>
  /** The touched collections' state outside any transaction (shadow, after the exact lane). */
  readState: (state: Uint8Array) => Promise<string>
  /** payload's `bson-objectid` class (array / block row ids; shadow replay). */
  rowIdClass: unknown
  /**
   * Runs one prepared operation in a new Rust-owned transaction with its result read (`read`:
   * the fused `findByID` request of the result), then commits; with `state` reads the touched
   * collections inside the transaction and aborts. `[text]` / `[text, state]`; `updateByID` /
   * `deleteByID`: `[text, state | '', contextWrites | '']`.
   */
  run: (input: {
    op: Uint8Array
    read: { payload: unknown; request: string }
    state?: Uint8Array
  }) => Promise<string[]>
  /**
   * Runs a bulk update / delete (`args` the operation's) in a new Rust-owned transaction: the
   * document read of `read` (the fused `find` request of `payload.db.find` and of the results'
   * `afterRead`), the per-document statements prepared for the documents it found, the results'
   * `afterRead` and the commit; with `isShadow` reads the touched collections inside the
   * transaction and aborts. `result`: `[text, state | '', '']`; a string is a bail (the
   * transaction was aborted, nothing was written).
   */
  runBulk: (input: {
    args: Any
    isShadow: boolean
    name: 'delete' | 'update'
    read: { payload: unknown; request: string }
  }) => Promise<{ result: string[]; state: Uint8Array } | string>
}

export type FusedWriteTargetLookup = (adapter: object) => FusedWriteTarget | string

const registryKey = Symbol.for('@payloadcms/engine-rs/fuse-write-targets')

const registry = ((globalThis as Record<symbol, unknown>)[registryKey] ??= new WeakMap<
  object,
  FusedWriteTargetLookup
>()) as WeakMap<object, FusedWriteTargetLookup>

export const registerFusedWriteTarget = (adapter: object, lookup: FusedWriteTargetLookup) => {
  registry.set(adapter, lookup)
}

export const getFusedWriteTarget = (adapter: unknown): FusedWriteTarget | string => {
  if (typeof adapter !== 'object' || adapter === null) {
    return 'adapter:none'
  }
  const lookup = registry.get(adapter)
  return lookup ? lookup(adapter) : 'adapter:no-fused-write-backend'
}
