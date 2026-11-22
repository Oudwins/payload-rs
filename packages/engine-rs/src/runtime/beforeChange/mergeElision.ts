/**
 * Validation merge elision for the Rust port of beforeChange.
 *
 * Upstream's `promise()` builds `deepMergeWithSourceArrays(doc, data)` and
 * `deepMergeWithSourceArrays(siblingDoc, siblingData)` for every validated field and passes them to
 * the validator as `data` / `siblingData`: O(fields x document) work that dominates validation. The
 * copies are fresh objects, so they are observable only
 *
 * - through the validator that receives them: here only built-in validators that field
 *   sanitization installed (`defaultFieldValidators`) and that read neither `data` nor
 *   `siblingData` on the field's config qualify (`mergeFreeBuiltin`), and
 * - through the reads `deepmerge` performs on the four graphs: own enumerable keys and values of
 *   every non-array object reachable through non-array objects, `in` checks, `$$typeof` and
 *   `Symbol.toStringTag` lookups. On objects that are not proxies, have no accessor properties and
 *   whose prototype chains define neither of those two keys, none of this runs user code
 *   (`isInert`).
 *
 * When both hold, the merges are skipped and the built-in is called directly (the sanitize
 * wrapper's `{ ...field, ...options }` is the options object itself, since `options` starts with
 * `...field` of the same field). Otherwise everything is upstream's.
 *
 * `isInert` results are cached only while a `traverseFields` call runs its fields synchronously
 * (`withInertCache`), and dropped at every (nested) `traverseFields` entry and whenever code that
 * could change the graphs runs (`foreignCodeRan`): user code (conditions, hooks, editor hooks,
 * custom validators, label functions), real merges, and upstream reads of values the check does not
 * cover (array elements, `docWithLocales`), which all happen before a nested traversal starts.
 * The request's `t` / `i18n` and the sanitized config are treated as payload's (the config is
 * immutable after sanitization, RUST_CORE_DESIGN.md section 7).
 */
import { types } from 'node:util'

import { defaultFieldValidators } from '../../../../payload/src/fields/config/defaultFieldValidators.js'
import { validations } from '../../../../payload/src/fields/validations.js'
import { getTranslatedLabel as upstreamGetTranslatedLabel } from '../../../../payload/src/utilities/getTranslatedLabel.js'

type Validate = (value: any, options: any) => unknown

type AnyField = Record<string, any>

const { isDate, isProxy, isRegExp } = types
const ObjectPrototype = Object.prototype
const ArrayPrototype = Array.prototype
const DatePrototype = Date.prototype
const RegExpPrototype = RegExp.prototype
const getPrototypeOf = Object.getPrototypeOf
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const getOwnPropertySymbols = Object.getOwnPropertySymbols
const keysOf = Object.keys
const isArray = Array.isArray
const toStringTag = Symbol.toStringTag
/** Deeper graphs are merged for real (upstream overflows the stack on cycles). */
const MAX_DEPTH = 64

/** Per validator function: the built-in to call when the merges are elided, or `null`. */
const builtinByValidator = new WeakMap<Validate, { builtin: null | Validate; field: object }>()

let inertCache: null | Set<object> = null

/**
 * The validator to call without the merges (and `undefined` validation data), or `undefined` when
 * upstream's merges must be built: `validateFn` must be a merge-free built-in of `field` and the
 * four graphs inert.
 */
export const mergeFreeValidator = (
  field: AnyField,
  validateFn: Validate,
  doc: unknown,
  data: unknown,
  siblingDoc: unknown,
  siblingData: unknown,
): undefined | Validate => {
  if (typeof validateFn !== 'function') {
    return undefined
  }
  let plan = builtinByValidator.get(validateFn)
  if (plan === undefined || plan.field !== field) {
    plan = { builtin: mergeFreeBuiltin(field, validateFn), field }
    builtinByValidator.set(validateFn, plan)
  }
  const { builtin } = plan
  if (
    builtin === null ||
    !isInert(doc) ||
    !isInert(data) ||
    !isInert(siblingDoc) ||
    !isInert(siblingData)
  ) {
    return undefined
  }
  return builtin
}

/** Marks that code which could change the graphs (getters, hooks, user validators) ran. */
export const foreignCodeRan = (): void => {
  inertCache?.clear()
}

/**
 * Runs `run` (the synchronous part of a `traverseFields` call) with `isInert` results cached until
 * `foreignCodeRan` or the end of the outermost `run`; a nested call starts from an empty cache.
 */
export const withInertCache = <T>(run: () => T): T => {
  if (inertCache !== null) {
    inertCache.clear()
    return run()
  }
  inertCache = new Set()
  try {
    return run()
  } finally {
    inertCache = null
  }
}

/** `getTranslatedLabel` of payload; a label function is user code. */
export const getTranslatedLabel: typeof upstreamGetTranslatedLabel = (label, i18n) => {
  if (typeof label === 'function') {
    foreignCodeRan()
  }
  return upstreamGetTranslatedLabel(label, i18n)
}

/**
 * The built-in `validateFn` ends up calling, when it is sanitize's default for `field` and reads
 * neither `data` nor `siblingData` given the field's config (validations.ts); else `null`.
 */
function mergeFreeBuiltin(field: AnyField, validateFn: Validate): null | Validate {
  const entry = defaultFieldValidators.get(validateFn)
  if (entry === undefined || entry.field !== field) {
    return null
  }
  if (entry.validate === validateFn) {
    // `() => true`
    return validateFn
  }
  const type = field.type
  if (validations[type as keyof typeof validations] !== entry.validate) {
    return null
  }
  switch (type) {
    case 'array':
    case 'checkbox':
    case 'code':
    case 'json':
    case 'number':
    case 'password':
    case 'point':
    case 'radio':
    case 'slug':
    case 'text':
    case 'textarea':
      return entry.validate
    case 'blocks':
      return field.filterOptions ? null : entry.validate
    case 'date':
      // reads `siblingData[`${name}_tz`]` but uses it only for a required timezone
      return field.timezone && field.required ? null : entry.validate
    case 'relationship':
    case 'upload':
      return typeof field.filterOptions === 'undefined' ? entry.validate : null
    case 'select':
      return typeof field.filterOptions === 'function' ? null : entry.validate
    default:
      // email / username (login with username reads siblingData), confirmPassword, richText
      // (the editor's validator gets the options)
      return null
  }
}

/** Whether `deepmerge` over `root` (an object) runs no user code. */
function isInert(root: unknown): boolean {
  if (typeof root !== 'object' || root === null || isArray(root)) {
    return false
  }
  if (inertCache !== null && inertCache.has(root)) {
    return true
  }
  const isRootInert = isInertValue(root, 0)
  if (isRootInert && inertCache !== null) {
    inertCache.add(root)
  }
  return isRootInert
}

function isInertValue(value: object, depth: number): boolean {
  if (isProxy(value) || '$$typeof' in value || toStringTag in value) {
    return false
  }
  const proto = getPrototypeOf(value)
  if (proto === ArrayPrototype) {
    // arrays are replaced, never traversed (`arrayMerge: (_, source) => source`)
    return isArray(value)
  }
  if (proto === DatePrototype) {
    return isDate(value)
  }
  if (proto === RegExpPrototype) {
    return isRegExp(value)
  }
  if ((proto !== ObjectPrototype && proto !== null) || depth > MAX_DEPTH) {
    return false
  }
  if (getOwnPropertySymbols(value).length !== 0) {
    return false
  }
  const keys = keysOf(value)
  for (let index = 0; index < keys.length; index++) {
    const descriptor = getOwnPropertyDescriptor(value, keys[index]!)
    if (descriptor === undefined || !('value' in descriptor)) {
      return false
    }
    const nested: unknown = descriptor.value
    if (typeof nested === 'object' && nested !== null && !isInertValue(nested, depth + 1)) {
      return false
    }
  }
  return true
}
