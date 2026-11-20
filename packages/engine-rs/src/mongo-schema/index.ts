/**
 * `@payloadcms/db-mongodb`'s `init` (model building) on the Rust engine. The live port
 * (crates/payload-mongo-schema `live`) drives the adapter's real mongoose directly; its entry is
 * packages/engine-rs/src/mongo-adapter/init.ts. Kept as the module the model-building harnesses
 * import.
 */
export {
  createRustMongoInit as createMongoInitRS,
  createRustMongoInit,
  getMongoLiveSchema,
  type MongoSchemaDeps,
} from '../mongo-adapter/init.js'
