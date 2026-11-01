import { createRequire } from 'node:module'

/**
 * Drop-in for `packages/payload/src/fields/validations.ts` whose validators run in Rust on the
 * caller's live objects (crates/payload-core-validate/live, through `validateBinding()` of
 * crates/payload-node). It loads its own binding, independent of `PAYLOAD_ENGINE`, so the
 * differential suites can compare it with the upstream module.
 *
 * Every export has the upstream name, signature (`length`, parameter defaults) and kind: sync
 * validators return synchronously, async ones are async functions that await where the TS awaits
 * (same microtask ticks), and every read of `value` / `options` / `req` happens on the original
 * objects at the point the TS makes it.
 *
 * `validationsModule` is all value exports as one object, typed as the upstream module.
 */
// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import type * as Upstream from '../../../payload/src/fields/validations.js'

// oxlint-disable-next-line payload/no-relative-monorepo-imports -- no 'payload' dependency is installed here
import { validateJSONSchema } from '../../../payload/src/fields/validateJSONSchema.js'
import { loadValidateBinding } from './native.js'

export type {
  ArrayFieldValidation,
  BlocksFieldValidation,
  CheckboxFieldValidation,
  CodeFieldValidation,
  ConfirmPasswordFieldValidation,
  DateFieldValidation,
  EmailFieldValidation,
  JSONFieldValidation,
  NumberFieldManyValidation,
  NumberFieldSingleValidation,
  NumberFieldValidation,
  PasswordFieldValidation,
  PointFieldValidation,
  RadioFieldValidation,
  RelationshipFieldManyValidation,
  RelationshipFieldSingleValidation,
  RelationshipFieldValidation,
  RichTextFieldValidation,
  SelectFieldManyValidation,
  SelectFieldSingleValidation,
  SelectFieldValidation,
  SlugFieldValidation,
  TextareaFieldValidation,
  TextFieldManyValidation,
  TextFieldSingleValidation,
  TextFieldValidation,
  UploadFieldManyValidation,
  UploadFieldSingleValidation,
  UploadFieldValidation,
  UsernameFieldValidation,
} from '../../../payload/src/fields/validations.js'

// `bson-objectid` as payload resolves it (engine-rs has no dependency on it).
const ObjectIdImport = createRequire(new URL('../../../payload/package.json', import.meta.url))(
  'bson-objectid',
)
const ObjectId = 'default' in ObjectIdImport ? ObjectIdImport.default : ObjectIdImport

const rust = loadValidateBinding({ ObjectId, validateJSONSchema })

export const {
  slug,
  array,
  blocks,
  checkbox,
  code,
  confirmPassword,
  date,
  email,
  json,
  number,
  password,
  point,
  radio,
  relationship,
  richText,
  select,
  text,
  textarea,
  upload,
  username,
  validateBlocksFilterOptions,
} = rust

/**
 * Built-in field validations used by Payload
 *
 * These can be re-used in custom validations
 */
export const validations = {
  slug,
  array,
  blocks,
  checkbox,
  code,
  confirmPassword,
  date,
  email,
  json,
  number,
  password,
  point,
  radio,
  relationship,
  richText,
  select,
  text,
  textarea,
  upload,
}

/** Every value export of `validations.ts`, backed by Rust. */
export const validationsModule: typeof Upstream = { ...rust, validations }
