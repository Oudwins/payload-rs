import { createRequire } from 'node:module'

/** `crates/payload-node/src/validate.rs` */
export type ValidateBinding = {
  ValidateEnv: new (graphJson: string) => object
  ValidateRun: new (env: object, entry: string, inputJson: string) => NativeValidateRun
}

export type NativeValidateRun = {
  replyText: (text: string) => void
  replyThrown: () => void
  replyUnit: () => void
  replyValue: (graphJson: string) => void
  step: () => string
}

let binding: undefined | ValidateBinding

/** The main addon, or the build in `PAYLOAD_ENGINE_ADDON`. */
export const getValidateBinding = (): ValidateBinding => {
  if (!binding) {
    const require = createRequire(import.meta.url)
    binding = require(
      process.env.PAYLOAD_ENGINE_ADDON ?? '../../payload-engine.node',
    ) as ValidateBinding
  }
  return binding
}
