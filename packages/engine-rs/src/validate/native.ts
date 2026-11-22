import type * as Upstream from '../../../payload/src/fields/validations.js'

import { coreRuntimeAddonPath, loadCoreRuntimeAddon } from '../addon.js'

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
  const addonPath = coreRuntimeAddonPath()
  const addon = loadCoreRuntimeAddon() as { validateBinding?: (deps: object) => RustValidations }
  if (typeof addon.validateBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} does not export validateBinding`)
  }
  const validators = addon.validateBinding(deps)
  if ('init' in validators) {
    throw new Error(`The engine addon at ${addonPath} is outdated (validateBinding); rebuild it`)
  }
  return validators
}
