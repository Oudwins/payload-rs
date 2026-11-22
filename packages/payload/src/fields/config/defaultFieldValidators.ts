type AnyValidate = (value: any, options: any) => unknown

export type DefaultFieldValidator = {
  /** The field object the validator closes over (`{ ...field, ...options }`). */
  field: object
  /**
   * The function the validator ends up calling: the built-in validator of the field type, or the
   * validator itself when it is `() => true`.
   */
  validate: AnyValidate
}

/**
 * The `field.validate` functions that field sanitization creates for fields without their own
 * `validate` (sanitize.ts), so the Rust core engine can recognize them. Not used by the TS engine.
 */
export const defaultFieldValidators = new WeakMap<AnyValidate, DefaultFieldValidator>()
