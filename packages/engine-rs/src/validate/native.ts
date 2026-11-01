import { createRequire } from 'node:module'
import path from 'node:path'

// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import type * as Upstream from '../../../payload/src/fields/validations.js'

/** Every validator export of `validations.ts` (the `validations` object aside). */
export type RustValidations = Omit<typeof Upstream, 'validations'>

/**
 * `validateBinding(deps)` of the addon (`PAYLOAD_CORE_RUNTIME_ADDON`, else `PAYLOAD_ENGINE_ADDON`,
 * else the shared `payload-engine.node`): a fresh set of Rust-backed validators
 * (crates/payload-core-validate/live) using this `ObjectId` and `validateJSONSchema`. Payload's
 * own `fields/validations.ts` does the same when `PAYLOAD_ENGINE=rs`.
 */
export const loadValidateBinding = (deps: {
  ObjectId: unknown
  validateJSONSchema: unknown
}): RustValidations => {
  const require = createRequire(import.meta.url)
  const envAddonPath = process.env.PAYLOAD_CORE_RUNTIME_ADDON ?? process.env.PAYLOAD_ENGINE_ADDON
  // A path from the environment is relative to the working directory, not to this module.
  const addonPath = envAddonPath
    ? path.resolve(process.cwd(), envAddonPath)
    : '../../payload-engine.node'
  const addon = require(addonPath) as { validateBinding?: (deps: object) => RustValidations }
  if (typeof addon.validateBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} does not export validateBinding`)
  }
  const validators = addon.validateBinding(deps)
  if ('init' in validators) {
    throw new Error(`The engine addon at ${addonPath} is outdated (validateBinding); rebuild it`)
  }
  return validators
}
