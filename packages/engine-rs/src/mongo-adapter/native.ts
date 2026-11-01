import { getNativeEngine } from '../native.js'

/** `crates/payload-node/src/mongo_engine.rs` (MONGO_ENGINE_CONTRACT.md "napi surface"). */
export type NativeMongoEngine = {
  /**
   * Runs one adapter method. `argsJson`: the `serializeForEngine` graph (BSON markers) of the
   * reduced arguments; `contextJson`: `MongoCallContext`. Database I/O goes through `host`
   * (host.ts). Resolves to `{ result, mutations }` (tree encoding), rejects with a
   * `MongoEngineError` JSON message (errors.ts).
   */
  call: (
    method: string,
    argsJson: string,
    contextJson: string,
    host: (opJson: string) => Promise<string>,
  ) => Promise<string>
  /** Schema description per collection / version / global (mongo-schema builds the Schemas). */
  schemaDescription: () => string
}

export type NativeMongoEngineClass = {
  create: (
    graphJson: string,
    optionsJson: string,
    callFunction: (id: number, argJson: string) => string,
  ) => NativeMongoEngine
}

/** The addon's `MongoEngine` class, `undefined` until it is built into the addon. */
export const getNativeMongoEngineClass = (): NativeMongoEngineClass | undefined =>
  (getNativeEngine() as { MongoEngine?: NativeMongoEngineClass }).MongoEngine
