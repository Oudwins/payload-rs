import { createRequire } from 'node:module'

/**
 * Drop-in for `packages/payload/src/fields/validations.ts` whose validators run in Rust on the
 * caller's live objects (crates/payload-core-validate/live, RUST_CORE_DESIGN.md strategy B,
 * through `validateBinding()` of crates/payload-node).
 *
 * Every export has the upstream name, signature (`length`, parameter defaults) and behaviour:
 * sync validators return synchronously, async ones return the promise of a Rust task that awaits
 * where the TS awaits (same microtask ticks), and every read of `value` / `options` / `req`
 * happens on the original objects at the point the TS makes it, so mutations made while a
 * validator awaits (`filterOptions`, `payloadDataLoader.find`) are seen exactly like upstream.
 *
 * The host below gives Rust the operations it must not re-implement: the parameter destructuring
 * of each validator (copies of the TS patterns, so reads, defaults and V8 messages are the
 * same), JS builtins whose results depend on V8 internals, `bson-objectid` (the same module
 * instance payload uses), `validateJSONSchema`, and the TS expressions that build the messages.
 *
 * `validationsModule` is all value exports as one object, typed as the upstream module.
 */
import type * as Upstream from '../../../payload/src/fields/validations.js'
import type {
  ArrayFieldValidation,
  BlocksFieldValidation,
  CheckboxFieldValidation,
  CodeFieldValidation,
  ConfirmPasswordFieldValidation,
  DateFieldValidation,
  EmailFieldValidation,
  JSONFieldValidation,
  NumberFieldValidation,
  PasswordFieldValidation,
  PointFieldValidation,
  RadioFieldValidation,
  RelationshipFieldValidation,
  RichTextFieldValidation,
  SelectFieldValidation,
  SlugFieldValidation,
  TextareaFieldValidation,
  TextFieldValidation,
  UploadFieldValidation,
  UsernameFieldValidation,
} from '../../../payload/src/fields/validations.js'

import { validateJSONSchema } from '../../../payload/src/fields/validateJSONSchema.js'
import { getValidateBinding } from './native.js'

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

const continueMarker = Symbol('continue')

const createHost = () => ({
  args: {
    array: (_value: unknown, { maxRows, minRows, req: { t }, required }: any) => [
      maxRows,
      minRows,
      t,
      required,
    ],
    blocks: (
      _value: unknown,
      { id, data, filterOptions, maxRows, minRows, req: { t }, req, required, siblingData }: any,
    ) => [id, data, filterOptions, maxRows, minRows, req, t, required, siblingData],
    checkbox: (_value: unknown, { req: { t }, required }: any) => [t, required],
    code: (_value: unknown, { req: { t }, required }: any) => [t, required],
    confirmPassword: (_value: unknown, { req: { t }, required, siblingData }: any) => [
      t,
      required,
      siblingData,
    ],
    date: (_value: unknown, { name, req: { t }, required, siblingData, timezone }: any) => [
      name,
      t,
      required,
      siblingData,
      timezone,
    ],
    email: (
      _value: unknown,
      {
        collectionSlug,
        req: {
          payload: { collections, config },
          t,
        },
        required,
        siblingData,
      }: any,
    ) => [collectionSlug, collections, config, t, required, siblingData],
    json: (_value: unknown, { jsonError, jsonSchema, req: { t }, required }: any) => [
      jsonError,
      jsonSchema,
      t,
      required,
    ],
    number: (
      _value: unknown,
      { hasMany, max, maxRows, min, minRows, req: { t }, required }: any,
    ) => [hasMany, max, maxRows, min, minRows, t, required],
    password: (
      _value: unknown,
      {
        maxLength: fieldMaxLength,
        minLength = 3,
        req: {
          payload: { config },
          t,
        },
        required,
      }: any,
    ) => [fieldMaxLength, minLength, config, t, required],
    point: (value: unknown = ['', ''], { req: { t }, required }: any) => [value, t, required],
    radio: (_value: unknown, { options, req: { t }, required }: any) => [options, t, required],
    relationship: (_value: unknown, options: any) => {
      const {
        event,
        maxRows,
        minRows,
        relationTo,
        req: { payload, t },
        required,
      } = options
      return [event, maxRows, minRows, relationTo, payload, t, required]
    },
    select: (
      _value: unknown,
      { data, filterOptions, hasMany, options, req, req: { t }, required, siblingData }: any,
    ) => [data, filterOptions, hasMany, options, req, t, required, siblingData],
    text: (
      _value: unknown,
      {
        hasMany,
        maxLength: fieldMaxLength,
        maxRows,
        minLength,
        minRows,
        req: {
          payload: { config },
          t,
        },
        required,
      }: any,
    ) => [hasMany, fieldMaxLength, maxRows, minLength, minRows, config, t, required],
    textarea: (
      _value: unknown,
      {
        maxLength: fieldMaxLength,
        minLength,
        req: {
          payload: { config },
          t,
        },
        required,
      }: any,
    ) => [fieldMaxLength, minLength, config, t, required],
    username: (
      _value: unknown,
      {
        collectionSlug,
        req: {
          payload: { collections, config },
          t,
        },
        required,
        siblingData,
      }: any,
    ) => [collectionSlug, collections, config, t, required, siblingData],
    validateBlocksFilterOptions: ({ id, data, filterOptions, req, siblingData, value }: any) => [
      id,
      data,
      filterOptions,
      req,
      siblingData,
      value,
    ],
    validateFilterOptions: (
      _value: unknown,
      {
        id,
        blockData,
        data,
        filterOptions,
        overrideAccess,
        relationTo,
        req,
        req: { t, user },
        siblingData,
      }: any,
    ) => [
      id,
      blockData,
      data,
      filterOptions,
      overrideAccess,
      relationTo,
      req,
      t,
      user,
      siblingData,
    ],
  },
  continueMarker,
  dateParse: (value: string) => Date.parse(value),
  duplicatesMessage: (duplicates: unknown[], t: (key: string) => string) =>
    duplicates.reduce((err, duplicate, i) => {
      return `${err} ${JSON.stringify(duplicate)}${i < duplicates.length - 1 ? ',' : ''}`
    }, t('validation:invalidSelections')),
  emailTest: (value: string) =>
    /^(?!.*\.\.)[\w!#$%&'*+/=?^`{|}~-](?:[\w!#$%&'*+/=?^`{|}~.-]*[\w!#$%&'*+/=?^`{|}~-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(
      value,
    ),
  error: (message: string) => new Error(message),
  findCollection: (config: any, collectionSlug: unknown) =>
    config.collections.find(({ slug }: any) => slug === collectionSlug),
  /** `for...of` without awaits in the body; the callback returns `continueMarker` to go on. */
  forOf: (items: Iterable<unknown>, callback: (item: unknown) => unknown) => {
    for (const item of items) {
      const result = callback(item)
      if (result !== continueMarker) {
        return result
      }
    }
    return continueMarker
  },
  gt: (a: any, b: any) => a > b,
  invalidRelationshipsMessage: (invalidRelationships: unknown[]) =>
    `This relationship field has the following invalid relationships: ${invalidRelationships
      .map((err, invalid) => {
        return `${err} ${JSON.stringify(invalid)}`
      })
      .join(', ')}`,
  invalidSelectionsMessage: (invalidRelationships: unknown[], t: (key: string) => string) =>
    invalidRelationships.reduce((err, invalid, i) => {
      return `${err} ${JSON.stringify(invalid)}${invalidRelationships.length === i + 1 ? ',' : ''} `
    }, t('validation:invalidSelections')),
  isArray: (value: unknown) => Array.isArray(value),
  /** `for...of` whose body awaits: `GetIterator` once, then one step per call. */
  iterator: (items: any) => {
    const iterator = items[Symbol.iterator]()
    const next = iterator.next
    return () => {
      const result: IteratorResult<unknown> = Reflect.apply(next, iterator, [])
      if ((typeof result !== 'object' || result === null) && typeof result !== 'function') {
        throw new TypeError(`Iterator result ${String(result)} is not an object`)
      }
      return result.done ? continueMarker : result.value
    }
  },
  join: (items: unknown[], separator: string) => items.join(separator),
  lt: (a: any, b: any) => a < b,
  Number: (value: unknown) => Number(value),
  objectIdHex: (val: unknown) => new ObjectId(val).toHexString(),
  objectIdIsValid: (id: unknown) => ObjectId.isValid(id),
  objectKeysLength: (value: object) => Object.keys(value).length,
  parseFloat: (value: unknown) => parseFloat(value as string),
  String: (value: unknown) => String(value),
  template: (value: unknown) => `${value as string}`,
  typeError: (message: string) => new TypeError(message),
  validateJSONSchema: (jsonSchema: any, value: unknown) =>
    validateJSONSchema({ jsonSchema, value }),
})

const native = () => getValidateBinding(createHost)

// ---------------------------------------------------------------------------------------------
// Validators (same order, parameter counts and defaults as validations.ts)

export const text: TextFieldValidation = (value, options) => native().text(value, options)

export const slug: SlugFieldValidation = () => native().slug()

export const password: PasswordFieldValidation = (value, options) =>
  native().password(value, options)

export const confirmPassword: ConfirmPasswordFieldValidation = (value, options) =>
  native().confirmPassword(value, options)

export const email: EmailFieldValidation = (value, options) => native().email(value, options)

export const username: UsernameFieldValidation = (value, options) =>
  native().username(value, options)

export const textarea: TextareaFieldValidation = (value, options) =>
  native().textarea(value, options)

export const code: CodeFieldValidation = (value, options) => native().code(value, options)

export const json: JSONFieldValidation = (value, options) => native().json(value, options)

export const checkbox: CheckboxFieldValidation = (value, options) =>
  native().checkbox(value, options)

export const date: DateFieldValidation = (value, options) => native().date(value, options)

export const richText: RichTextFieldValidation = (value, options) =>
  native().richText(value, options)

export const number: NumberFieldValidation = (value, options) => native().number(value, options)

export const array: ArrayFieldValidation = (value, options) => native().array(value, options)

/**
 * Validates the blocks filter options for a blocks field.
 *
 * @internal - this may break or be removed at any time
 */
export function validateBlocksFilterOptions(
  args: Parameters<typeof Upstream.validateBlocksFilterOptions>[0],
): ReturnType<typeof Upstream.validateBlocksFilterOptions> {
  return native().validateBlocksFilterOptions(args)
}

export const blocks: BlocksFieldValidation = (value, options) => native().blocks(value, options)

export const upload: UploadFieldValidation = (value, options) => native().upload(value, options)

export const relationship: RelationshipFieldValidation = (value, options) =>
  native().relationship(value, options)

export const select: SelectFieldValidation = (value, options) => native().select(value, options)

export const radio: RadioFieldValidation = (value, options) => native().radio(value, options)

// `(value = ['', ''], ...)` upstream: `point.length` is 0; Rust applies the default.
export const point: PointFieldValidation = (...args: Parameters<PointFieldValidation>) =>
  native().point(args[0], args[1])

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

/** Every value export of `validations.ts`, backed by Rust (the dispatch object for the core). */
export const validationsModule: typeof Upstream = {
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
  validations,
}
