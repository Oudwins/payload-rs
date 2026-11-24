/**
 * What Payload's own function does, for the Rust engine's fused write lanes
 * (packages/engine-rs/FUSED_WRITES.md section 4): each kind names the Rust implementation of the
 * same behaviour.
 */
export type PayloadOwnFunction =
  | {
      /**
       * A lexical rich text editor hook (`@payloadcms/richtext-lexical` `getLexicalHooks`); its
       * work depends on the editor config's features (`editorConfig.features.hooks`, node hooks).
       */
      editorConfig: unknown
      hook: 'afterChange' | 'afterRead' | 'beforeChange' | 'beforeValidate'
      kind: 'lexicalHook'
    }
  | {
      /** `slug` field `beforeChange` (`generateSlug`), with the options it closes over. */
      kind: 'slugBeforeChange'
      options: { localized?: boolean; name: string; slugify?: unknown; useAsSlug?: string }
    }
  | {
      /** `slug` field `beforeDuplicate` (`generateSlugBeforeDuplicate`). */
      kind: 'slugBeforeDuplicate'
      options: { name: string }
    }
  | {
      /** Array / block row `id` field (`baseIDField`). */
      kind: 'rowIdBeforeChange' | 'rowIdBeforeDuplicate' | 'rowIdDefaultValue'
    }
  | {
      /** Authorship (`createdBy` / `updatedBy`) hooks. */
      field: 'createdBy' | 'updatedBy'
      kind: 'authorshipBeforeChange' | 'authorshipBeforeDuplicate' | 'authorshipBeforeValidate'
    }

/**
 * Functions Payload itself installs in sanitized configs (field hooks and default values), by
 * identity, so the Rust engine can tell them from user code (owner decision 2026-11-24,
 * RUST_PERF_PLAN.md section 0). Default validators are in `defaultFieldValidators`. Internal and
 * additive: nothing reads it on the TS engine.
 */
export const payloadOwnFunctions = new WeakMap<object, PayloadOwnFunction>()

/** Registers `fn` as Payload's own and returns it. */
export const registerPayloadOwnFunction = <T extends object>(
  fn: T,
  description: PayloadOwnFunction,
): T => {
  payloadOwnFunctions.set(fn, description)
  return fn
}
