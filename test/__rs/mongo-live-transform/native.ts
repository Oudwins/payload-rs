/**
 * Loads `mongoLiveTransformBinding()` from the addon (`PAYLOAD_ENGINE_ADDON`, default
 * packages/engine-rs/payload-engine.node) and initializes it with the values
 * `@payloadcms/db-mongodb` imports (payload's `APIError` / `ValidationError` / `flattenAllFields`,
 * mongoose's `Types`).
 */
import { Types } from 'mongoose'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APIError, flattenAllFields, ValidationError } from 'payload'

export type LiveTransformBinding = {
  getCollection: (args: Record<string, unknown>) => unknown
  getDBName: (args: Record<string, unknown>) => unknown
  getGlobal: (args: Record<string, unknown>) => unknown
  handleError: (args: Record<string, unknown>) => never
  init: (deps: Record<string, unknown>) => void
  isObjectID: (value: unknown) => boolean
  transform: (args: Record<string, unknown>) => unknown
}

const dirname = path.dirname(fileURLToPath(import.meta.url))

let binding: LiveTransformBinding | undefined

export const getLiveTransformBinding = (): LiveTransformBinding => {
  if (!binding) {
    const require = createRequire(import.meta.url)
    const addon = require(
      process.env.PAYLOAD_ENGINE_ADDON ||
        path.resolve(dirname, '../../../packages/engine-rs/payload-engine.node'),
    ) as { mongoLiveTransformBinding?: () => LiveTransformBinding }
    if (typeof addon.mongoLiveTransformBinding !== 'function') {
      throw new Error('the addon has no mongoLiveTransformBinding (build crates/payload-node)')
    }
    binding = addon.mongoLiveTransformBinding()
    binding.init({ APIError, flattenAllFields, Types, ValidationError })
  }
  return binding
}
