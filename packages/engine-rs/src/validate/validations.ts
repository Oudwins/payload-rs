/**
 * Drop-in for `packages/payload/src/fields/validations.ts` whose validators run in Rust
 * (crates/payload-core-validate through crates/payload-node/src/validate.rs).
 *
 * Every export has the upstream signature and keeps the upstream observable behaviour:
 * - sync validators stay sync, async ones are `async` functions with the same `await`s (one per
 *   `filterOptions` / `payloadDataLoader.find` call, `await validateBlocksFilterOptions(...)` in
 *   `blocks`, `return validateFilterOptions(...)` in `upload` / `relationship`, and the tail calls
 *   `return validateJSONSchema(...)` / `return editor.validate(...)`), so microtask ordering
 *   against concurrently running field hooks is unchanged;
 * - parameters are destructured with the upstream patterns (same `TypeError`s for missing `req`);
 * - JS calls (`req.t`, `filterOptions`, `find`, `logger.error`, `Date.prototype.toString`) are
 *   made from here with the original objects (`req`, `data`, `siblingData`, the user's option
 *   filter, the caught error), in the order the Rust run requests them (see `replay.rs`).
 *
 * Rust receives the value and the option values the validator reads. Objects Rust only tests
 * for truthiness / `typeof` (rich text editor, JSON schema, relationship filter objects) are
 * passed as `{}`, and `siblingData` / find results are reduced to the properties that are read.
 */
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
import { createFunctionRegistry, deserializeFromEngine, serializeForEngine } from '../serialize.js'
import { getValidateBinding, type NativeValidateRun } from './native.js'

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

// ---------------------------------------------------------------------------------------------
// Runs

type Step =
  | { blocks: { all: unknown; allowed: unknown; invalid: unknown } }
  | { done: string | true }
  | { enter: true }
  | { error: { message: string; name: string } }
  | ({ request: string } & Record<string, any>)
  | { thrown: number }

type Run = {
  native: NativeValidateRun
  registry: ReturnType<typeof createFunctionRegistry>
  /** Number of replies so far: the journal index of the next one. */
  replies: number
  /** JS exceptions by journal index. */
  thrown: Map<number, unknown>
}

/** What the synchronous JS calls of a run need: the destructured `t` and `req` (if any). */
type Host = { req?: any; t?: (key: string, vars?: unknown) => unknown }

const envCache = new WeakMap<object, WeakMap<object, object>>()
const noCollections = {}
let emptyEnv: object | undefined

/** Option filters / editors / schemas Rust only tests for truthiness and `typeof`. */
const opaque = (value: unknown) => (typeof value === 'object' && value !== null ? {} : value)

/** `object?.[key]` reduced to the one property the validator reads. */
const pickOptional = (object: any, key: string) =>
  (typeof object === 'object' && object !== null) || typeof object === 'function'
    ? { [key]: object[key] }
    : object

const authView = (auth: any) =>
  typeof auth === 'object' && auth !== null
    ? {
        loginWithUsername:
          typeof auth.loginWithUsername === 'object' && auth.loginWithUsername !== null
            ? {
                requireEmail: auth.loginWithUsername.requireEmail,
                requireUsername: auth.loginWithUsername.requireUsername,
              }
            : opaque(auth.loginWithUsername),
      }
    : auth

/**
 * `req.payload.config` / `req.payload.collections` as the validators read them: the collection
 * slugs, `auth.loginWithUsername` and `customIDType`. Cached per config / collections object
 * (sanitized once at init); `config.defaultMaxTextLength` is read on every call instead.
 */
const getEnv = (config: any, collections: any): object => {
  const isConfigObject = typeof config === 'object' && config !== null
  const isCollectionsObject = typeof collections === 'object' && collections !== null
  const byCollections = isConfigObject ? envCache.get(config) : undefined
  const cached = byCollections?.get(isCollectionsObject ? collections : noCollections)
  if (cached) {
    return cached
  }
  const configView = isConfigObject
    ? {
        collections: Array.isArray(config.collections)
          ? config.collections.map((collection: any) =>
              typeof collection === 'object' && collection !== null
                ? { slug: collection.slug, auth: authView(collection.auth) }
                : collection,
            )
          : opaque(config.collections),
      }
    : config
  const collectionsView = !isCollectionsObject
    ? collections
    : Object.fromEntries(
        Object.keys(collections).map((slug) => {
          const collection = collections[slug]
          return [
            slug,
            typeof collection === 'object' && collection !== null
              ? {
                  config:
                    typeof collection.config === 'object' && collection.config !== null
                      ? { auth: authView(collection.config.auth) }
                      : collection.config,
                  customIDType: collection.customIDType,
                }
              : collection,
          ]
        }),
      )
  const env = new (getValidateBinding().ValidateEnv)(
    serializeForEngine(
      { collections: collectionsView, config: configView },
      createFunctionRegistry(),
    ),
  )
  if (isConfigObject) {
    if (!byCollections) {
      envCache.set(config, new WeakMap([[isCollectionsObject ? collections : noCollections, env]]))
    } else {
      byCollections.set(isCollectionsObject ? collections : noCollections, env)
    }
  }
  return env
}

const createRun = ({
  defaultIDType,
  defaultMaxTextLength,
  entry,
  env,
  options,
  value,
}: {
  defaultIDType?: unknown
  /** `config?.defaultMaxTextLength`, for the validators that read it. */
  defaultMaxTextLength?: unknown
  entry: string
  env?: object
  options: Record<string, unknown>
  value: unknown
}): Run => {
  const binding = getValidateBinding()
  const registry = createFunctionRegistry()
  emptyEnv ??= new binding.ValidateEnv(serializeForEngine({}, createFunctionRegistry()))
  const native = new binding.ValidateRun(
    env ?? emptyEnv,
    entry,
    serializeForEngine({ defaultIDType, defaultMaxTextLength, options, value }, registry),
  )
  return { native, registry, replies: 0, thrown: new Map() }
}

const decode = (run: Run, encoded: unknown) => deserializeFromEngine(encoded, run.registry)

const replyThrown = (run: Run, error: unknown) => {
  run.thrown.set(run.replies++, error)
  run.native.replyThrown()
}

const replyValue = (run: Run, value: unknown) => {
  run.replies++
  run.native.replyValue(serializeForEngine(value, run.registry))
}

const engineError = ({ name, message }: { message: string; name: string }) => {
  switch (name) {
    case 'RangeError':
      return new RangeError(message)
    case 'TypeError':
      return new TypeError(message)
    default:
      return new Error(message)
  }
}

/** Steps the run, making the synchronous JS calls it requests, until it ends or needs an async call. */
const drain = (run: Run, host: Host): Step => {
  for (;;) {
    const step = JSON.parse(run.native.step()) as Step
    if (!('request' in step)) {
      return step
    }
    switch (step.request) {
      case 'dateToString':
        run.replies++
        run.native.replyText(String(new Date(step.ms)))
        continue
      case 'logError':
        host.req.payload.logger.error({
          err: 'thrown' in step ? run.thrown.get(step.thrown) : engineError(step.error),
          msg: step.msg,
        })
        run.replies++
        run.native.replyUnit()
        continue
      case 't': {
        let text: unknown
        try {
          text =
            step.vars === undefined ? host.t!(step.key) : host.t!(step.key, decode(run, step.vars))
        } catch (error) {
          replyThrown(run, error)
          continue
        }
        if (typeof text !== 'string') {
          throw new Error(
            `req.t returned a ${typeof text}: the Rust validators only support strings`,
          )
        }
        run.replies++
        run.native.replyText(text)
        continue
      }
      default:
        return step
    }
  }
}

/** The validator's return value or exception. */
const finish = (run: Run, step: Step): string | true => {
  if ('done' in step) {
    return step.done
  }
  if ('thrown' in step) {
    throw run.thrown.get(step.thrown)
  }
  if ('error' in step) {
    throw engineError(step.error)
  }
  throw new Error(`unexpected validator step ${JSON.stringify(step)}`)
}

/**
 * The call of `await call()`: a synchronous throw is recorded without awaiting (`undefined`);
 * the caller awaits `pending` inline, so the await count matches TS.
 */
const callHost = (run: Run, call: () => unknown): { pending: unknown } | undefined => {
  try {
    return { pending: call() }
  } catch (error) {
    replyThrown(run, error)
    return undefined
  }
}

const runSync = (
  entry: string,
  value: unknown,
  options: Record<string, unknown>,
  host: Host,
  config?: { collections?: unknown; config: any },
) => {
  const run = createRun({
    defaultMaxTextLength: config?.config?.defaultMaxTextLength,
    entry,
    env: config && getEnv(config.config, config.collections),
    options,
    value,
  })
  return finish(run, drain(run, host))
}

// ---------------------------------------------------------------------------------------------
// Validators (same order and parameter patterns as validations.ts)

export const text: TextFieldValidation = (
  value,
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
  },
) =>
  runSync(
    'text',
    value,
    { hasMany, maxLength: fieldMaxLength, maxRows, minLength, minRows, required },
    { t },
    { config },
  )

export const slug: SlugFieldValidation = () => runSync('slug', undefined, {}, {})

export const password: PasswordFieldValidation = (
  value,
  {
    maxLength: fieldMaxLength,
    minLength,
    req: {
      payload: { config },
      t,
    },
    required,
  },
) =>
  runSync('password', value, { maxLength: fieldMaxLength, minLength, required }, { t }, { config })

export const confirmPassword: ConfirmPasswordFieldValidation = (
  value,
  { req: { t }, required, siblingData },
) =>
  runSync(
    'confirmPassword',
    value,
    // `siblingData.password` is only read when `value` is truthy (and throws on nullish).
    { required, siblingData: value ? pickOptional(siblingData, 'password') : undefined },
    { t },
  )

export const email: EmailFieldValidation = (
  value,
  {
    collectionSlug,
    req: {
      payload: { collections, config },
      t,
    },
    required,
    siblingData,
  },
) =>
  runSync(
    'email',
    value,
    { collectionSlug, required, siblingData: pickOptional(siblingData, 'username') },
    { t },
    { collections, config },
  )

export const username: UsernameFieldValidation = (
  value,
  {
    collectionSlug,
    req: {
      payload: { collections, config },
      t,
    },
    required,
    siblingData,
  },
) =>
  runSync(
    'username',
    value,
    { collectionSlug, required, siblingData: pickOptional(siblingData, 'email') },
    { t },
    { collections, config },
  )

export const textarea: TextareaFieldValidation = (
  value,
  {
    maxLength: fieldMaxLength,
    minLength,
    req: {
      payload: { config },
      t,
    },
    required,
  },
) =>
  runSync('textarea', value, { maxLength: fieldMaxLength, minLength, required }, { t }, { config })

export const code: CodeFieldValidation = (value, { req: { t }, required }) =>
  runSync('code', value, { required }, { t })

export const json: JSONFieldValidation = async (
  value,
  { jsonError, jsonSchema, req: { t }, required },
) => {
  const run = createRun({
    entry: 'json',
    options: { jsonError, jsonSchema: opaque(jsonSchema), required },
    value,
  })
  const step = drain(run, { t })
  if ('request' in step && step.request === 'jsonSchema') {
    return validateJSONSchema({ jsonSchema: jsonSchema!, value })
  }
  return finish(run, step)
}

export const checkbox: CheckboxFieldValidation = (value, { req: { t }, required }) =>
  runSync('checkbox', value, { required }, { t })

export const date: DateFieldValidation = (
  value,
  { name, req: { t }, required, siblingData, timezone },
) =>
  runSync(
    'date',
    value,
    { name, required, siblingData: pickOptional(siblingData, `${name}_tz`), timezone },
    { t },
  )

// oxlint-disable-next-line require-await -- `async` like upstream: a throw is a rejection
export const richText: RichTextFieldValidation = async (value, options) => {
  const run = createRun({
    entry: 'richText',
    options: { editor: opaque(options?.editor) },
    value: undefined,
  })
  const step = drain(run, {})
  if ('request' in step && step.request === 'richText') {
    const editor = options?.editor
    return editor!.validate(value, options)
  }
  return finish(run, step)
}

/** `value` as `validateArrayLength` reads it: only the length of an array matters. */
const rowsShape = (value: unknown) => (Array.isArray(value) ? value.map(() => null) : value)

export const number: NumberFieldValidation = (
  value,
  { hasMany, max, maxRows, min, minRows, req: { t }, required },
) => runSync('number', value, { hasMany, max, maxRows, min, minRows, required }, { t })

export const array: ArrayFieldValidation = (value, { maxRows, minRows, req: { t }, required }) =>
  runSync('array', rowsShape(value), { maxRows, minRows, required }, { t })

/** Block rows as `validateBlocksFilterOptions` reads them (`b.blockType`). */
const blockRowsShape = (value: unknown) =>
  Array.isArray(value)
    ? value.map((row) =>
        (typeof row === 'object' && row !== null) || typeof row === 'function'
          ? { blockType: row.blockType }
          : row,
      )
    : value

/** Block filter options: functions and arrays are read, other objects only tested for truthiness. */
const blockFilterOptionsShape = (filterOptions: unknown) =>
  typeof filterOptions === 'function' || Array.isArray(filterOptions)
    ? filterOptions
    : opaque(filterOptions)

/**
 * Validates the blocks filter options for a blocks field.
 *
 * @internal - this may break or be removed at any time
 */
export async function validateBlocksFilterOptions({
  id,
  data,
  filterOptions,
  req,
  siblingData,
  value,
}: { value: Parameters<BlocksFieldValidation>[0] } & Pick<
  Parameters<BlocksFieldValidation>[1],
  'data' | 'filterOptions' | 'id' | 'req' | 'siblingData'
>): Promise<{
  allBlockSlugs: string[]
  allowedBlockSlugs: string[] | undefined
  invalidBlockSlugs: string[] | undefined
}> {
  const run = createRun({
    entry: 'validateBlocksFilterOptions',
    options: { filterOptions: blockFilterOptionsShape(filterOptions) },
    value: blockRowsShape(value),
  })
  let filterOptionsResult: unknown
  for (;;) {
    const step = drain(run, { req })
    if ('blocks' in step) {
      return {
        allBlockSlugs: decode(run, step.blocks.all) as string[],
        // The array itself: the filterOptions result or the configured array.
        allowedBlockSlugs:
          step.blocks.allowed === null
            ? undefined
            : ((typeof filterOptions === 'function'
                ? filterOptionsResult
                : filterOptions) as string[]),
        invalidBlockSlugs: decode(run, step.blocks.invalid) as string[],
      }
    }
    if (!('request' in step) || step.request !== 'filterOptions') {
      return finish(run, step) as never
    }
    const called = callHost(run, () =>
      (filterOptions as (args: Record<string, unknown>) => unknown)({
        id: id!,
        data,
        req,
        siblingData,
        user: req.user,
      }),
    )
    if (called) {
      try {
        filterOptionsResult = await called.pending
      } catch (error) {
        replyThrown(run, error)
        continue
      }
      replyValue(run, filterOptionsResult)
    }
  }
}

export const blocks: BlocksFieldValidation = async (
  value,
  { id, data, filterOptions, maxRows, minRows, req: { t }, req, required, siblingData },
) => {
  const prefix = createRun({
    entry: 'blocksPrefix',
    options: { filterOptions: blockFilterOptionsShape(filterOptions), maxRows, minRows, required },
    value: rowsShape(value),
  })
  const step = drain(prefix, { t })
  if (!('enter' in step)) {
    return finish(prefix, step)
  }
  const { invalidBlockSlugs } = await validateBlocksFilterOptions({
    id,
    data,
    filterOptions,
    req,
    siblingData,
    value,
  })
  return runSync('blocksInvalidBlockSlugs', invalidBlockSlugs, {}, { t })
}

/** Relationship option filters: functions are called, `true`/`false` matter, objects are pushed into `where` as is. */
const relationshipFilterOptionsShape = (filterOptions: unknown) =>
  typeof filterOptions === 'function' ? filterOptions : opaque(filterOptions)

/** `result.docs.map((doc) => doc.id)` reads only these. */
const findResultShape = (result: any) =>
  typeof result === 'object' && result !== null
    ? {
        docs: Array.isArray(result.docs)
          ? result.docs.map((doc: any) =>
              (typeof doc === 'object' && doc !== null) || typeof doc === 'function'
                ? { id: doc.id }
                : doc,
            )
          : opaque(result.docs),
      }
    : result

const validateFilterOptions = async (
  value: unknown,
  run: Run,
  {
    id,
    blockData,
    data,
    filterOptions,
    req,
    req: { t, user },
    siblingData,
  }: Parameters<RelationshipFieldValidation>[1],
) => {
  // The option filter of the current collection, pushed into `where` as the same object.
  let optionFilter: unknown = filterOptions
  for (;;) {
    const step = drain(run, { req, t })
    if (!('request' in step) || (step.request !== 'filterOptions' && step.request !== 'find')) {
      return finish(run, step)
    }
    const called =
      step.request === 'filterOptions'
        ? callHost(run, () =>
            (filterOptions as (args: Record<string, unknown>) => unknown)({
              id: id!,
              blockData,
              data,
              relationTo: decode(run, step.relationTo),
              req,
              siblingData,
              user,
            }),
          )
        : callHost(run, () => {
            const where: Record<string, any> = { and: [{ id: { in: decode(run, step.ids) } }] }
            if (step.hasOptionFilter) {
              where.and.push(optionFilter)
            }
            return req.payloadDataLoader.find({
              collection: decode(run, step.collection) as string,
              depth: 0,
              disableErrors: true,
              limit: 0,
              overrideAccess: decode(run, step.overrideAccess) as boolean,
              pagination: false,
              req,
              where,
            })
          })
    if (!called) {
      continue
    }
    let result: unknown
    try {
      result = await called.pending
    } catch (error) {
      replyThrown(run, error)
      continue
    }
    if (step.request === 'filterOptions') {
      optionFilter = result
      replyValue(run, opaque(result))
    } else {
      replyValue(run, findResultShape(result))
    }
  }
}

const relationshipLike = (
  value: unknown,
  options: Parameters<RelationshipFieldValidation>[1],
  {
    event,
    maxRows,
    minRows,
    relationTo,
    req: { payload, t },
    required,
  }: Parameters<RelationshipFieldValidation>[1],
) => {
  const { filterOptions, overrideAccess } = options
  const runOptions = {
    event,
    filterOptions: relationshipFilterOptionsShape(filterOptions),
    maxRows,
    minRows,
    overrideAccess,
    relationTo,
    required,
  }
  const env = getEnv(payload?.config, payload?.collections)
  const defaultIDType = payload?.db?.defaultIDType
  const prefix = createRun({
    defaultIDType,
    entry: 'relationshipPrefix',
    env,
    options: runOptions,
    value,
  })
  const step = drain(prefix, { t })
  if (!('enter' in step)) {
    return finish(prefix, step)
  }
  const run = createRun({
    defaultIDType,
    entry: 'validateFilterOptions',
    env,
    options: runOptions,
    value,
  })
  return validateFilterOptions(value, run, options)
}

export const upload: UploadFieldValidation = async (value, options) =>
  relationshipLike(
    value,
    options as Parameters<RelationshipFieldValidation>[1],
    options as Parameters<RelationshipFieldValidation>[1],
  )

export const relationship: RelationshipFieldValidation = async (value, options) =>
  relationshipLike(value, options, options)

export const select: SelectFieldValidation = async (
  value,
  { data, filterOptions, hasMany, options, req, req: { t }, required, siblingData },
) => {
  const run = createRun({
    entry: 'select',
    options: {
      filterOptions: typeof filterOptions === 'function' ? filterOptions : undefined,
      hasMany,
      options,
      required,
    },
    value,
  })
  for (;;) {
    const step = drain(run, { t })
    if (!('request' in step) || step.request !== 'filterOptions') {
      return finish(run, step)
    }
    const called = callHost(run, () => filterOptions!({ data, options, req, siblingData }))
    if (called) {
      let result: unknown
      try {
        result = await called.pending
      } catch (error) {
        replyThrown(run, error)
        continue
      }
      replyValue(run, result)
    }
  }
}

export const radio: RadioFieldValidation = (value, { options, req: { t }, required }) =>
  runSync('radio', value, { options, required }, { t })

export const point: PointFieldValidation = (value = ['', ''], { req: { t }, required }) =>
  runSync('point', value, { required }, { t })

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
