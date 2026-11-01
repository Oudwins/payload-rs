import { createRequire } from 'node:module'

import { getCoreRuntime } from '../runtime/index.js'

/** Returns what the validator returns (`true`, the `t` result, or a promise of it). */
type Validator = (value: unknown, options: unknown) => any

/** `crates/payload-core-validate/live` through `validateBinding()` of `crates/payload-node`. */
export type ValidateBinding = {
  array: Validator
  blocks: Validator
  checkbox: Validator
  code: Validator
  confirmPassword: Validator
  date: Validator
  email: Validator
  init: (host: Record<string, unknown>) => void
  json: Validator
  number: Validator
  password: Validator
  point: Validator
  radio: Validator
  relationship: Validator
  richText: Validator
  select: Validator
  slug: () => true
  text: Validator
  textarea: Validator
  upload: Validator
  username: Validator
  validateBlocksFilterOptions: (args: unknown) => Promise<any>
}

let binding: undefined | ValidateBinding

/**
 * The validate binding of the addon the core runtime uses (`PAYLOAD_CORE_RUNTIME_ADDON`, else
 * `PAYLOAD_ENGINE_ADDON`, else the shared `payload-engine.node`): both must be the same Rust
 * instance (shared executor), so the core runtime is initialized first.
 */
export const getValidateBinding = (host: () => Record<string, unknown>): ValidateBinding => {
  if (binding) {
    return binding
  }
  getCoreRuntime()
  const require = createRequire(import.meta.url)
  const addonPath =
    process.env.PAYLOAD_CORE_RUNTIME_ADDON ??
    process.env.PAYLOAD_ENGINE_ADDON ??
    '../../payload-engine.node'
  const addon = require(addonPath) as { validateBinding?: () => ValidateBinding }
  if (typeof addon.validateBinding !== 'function') {
    throw new Error(`The engine addon at ${addonPath} does not export validateBinding`)
  }
  const created = addon.validateBinding()
  created.init(host())
  binding = created
  return binding
}
