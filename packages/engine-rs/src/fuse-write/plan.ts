/**
 * Eligibility of a collection for the fused writes (FUSED_WRITES.md section 3), decided once per
 * collection config object and re-verified per call through `volatile` triples (like the fused
 * reads' plan, fuse/plan.ts): a hook pushed or a function replaced at runtime sends the call to the
 * exact lane and rebuilds the plan.
 *
 * Eligible: no collection hooks on the write paths and no root `afterError` hooks; every field
 * function on the path is Payload's own (`payloadOwnFunctions`, `defaultFieldValidators`) or a
 * compiled user `validate`; no
 * upload / auth collection, no joins, no custom ID (localization and drafts: WP-I's prepare and
 * WP-A's read plan decide; deletes guard scheduled publish).
 */
import { defaultFieldValidators } from '../../../payload/src/fields/config/defaultFieldValidators.js'
import { payloadOwnFunctions } from '../../../payload/src/fields/config/payloadOwnFunctions.js'
import { laneFunction } from '../compile/index.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- sanitized configs are untyped here */
type Any = any

type Volatile = [Any, PropertyKey, unknown]

export type WritePlan =
  | {
      /** `access.create` / `access.update` / `access.delete` (only reached without `overrideAccess`). */
      access: Record<'create' | 'delete' | 'update', unknown>
      eligible: true
      /** `versions.drafts.schedulePublish`: deletes also delete the scheduled publish jobs. */
      hasScheduledPublish: boolean
      slug: string
      volatile: Volatile[]
    }
  | { eligible: false; reason: string; volatile: Volatile[] }

const writeHooks = [
  'afterChange',
  'afterDelete',
  'afterError',
  'afterOperation',
  'afterRead',
  'beforeChange',
  'beforeDelete',
  'beforeOperation',
  'beforeRead',
  'beforeValidate',
] as const

// `beforeDuplicate` runs only for `duplicate`, which is not fused
const fieldHookNames = ['afterChange', 'afterRead', 'beforeChange', 'beforeValidate'] as const

class Ineligible extends Error {}

const ineligible = (reason: string): never => {
  throw new Ineligible(reason)
}

type Builder = { volatile: Volatile[] }

const watch = (builder: Builder, object: Any, key: PropertyKey) => {
  const value = object[key]
  builder.volatile.push([object, key, value])
  if (Array.isArray(value)) {
    builder.volatile.push([value, 'length', value.length])
  }
  return value
}

const isEmptyList = (list: unknown) =>
  list === undefined || list === null || (Array.isArray(list) && list.length === 0)

const watchEmptyHooks = (builder: Builder, owner: Any, names: readonly string[]) => {
  const hooks = watch(builder, owner, 'hooks')
  if (hooks === undefined || hooks === null) {
    return
  }
  if (typeof hooks !== 'object') {
    ineligible('hooks:shape')
  }
  for (const name of names) {
    if (!isEmptyList(watch(builder, hooks, name))) {
      ineligible(`hooks:${name}`)
    }
  }
}

/** A function Payload installed itself (by identity), else user code. */
const isOwn = (fn: unknown) => typeof fn === 'function' && payloadOwnFunctions.has(fn)

/** Payload's own function, or a compiled user function a lane may use (`laneFunction`). */
const isOwnOrLaneFunction = (fn: unknown) =>
  isOwn(fn) || (typeof fn === 'function' && laneFunction(fn as Any).entry !== undefined)

const fieldsWalk = (builder: Builder, owner: Any, key: string) => {
  const fields = watch(builder, owner, key)
  if (!Array.isArray(fields)) {
    ineligible('fields:shape')
  }
  for (const field of fields) {
    fieldWalk(builder, field)
  }
}

const fieldWalk = (builder: Builder, field: Any) => {
  if (typeof field !== 'object' || field === null || typeof field.type !== 'string') {
    ineligible('field:shape')
  }
  const type = field.type
  if (type === 'join') {
    ineligible('field:join')
  }
  if (type === 'point') {
    ineligible('field:point')
  }
  if (field.virtual) {
    ineligible('field:virtual')
  }
  const hooks = watch(builder, field, 'hooks')
  if (hooks !== undefined && hooks !== null) {
    for (const name of fieldHookNames) {
      const list = watch(builder, hooks, name)
      if (isEmptyList(list)) {
        continue
      }
      // compiled user hooks run in the prepare (beforeValidate, beforeChange: writePlan.ts checks
      // what they read)
      const isAccepted =
        name === 'beforeValidate' || name === 'beforeChange' ? isOwnOrLaneFunction : isOwn
      if (!Array.isArray(list) || !list.every(isAccepted)) {
        ineligible(`field:hooks:${name}`)
      }
    }
  }
  const validate = watch(builder, field, 'validate')
  // a user `validate` runs in the prepare when it is compiled and a lane may use it (guards
  // installed, active: compile/index.ts `laneFunction`; the prepare samples, writePlan.ts checks
  // what it reads)
  if (
    validate !== undefined &&
    !defaultFieldValidators.has(validate) &&
    !isOwnOrLaneFunction(validate)
  ) {
    ineligible('field:validate')
  }
  const defaultValue = watch(builder, field, 'defaultValue')
  if (typeof defaultValue === 'function' && !isOwn(defaultValue)) {
    ineligible('field:defaultValue')
  }
  // a relationship's function `filterOptions` is called by its validator for a truthy value
  // only, where the prepare bails (writePlan.ts)
  if (
    typeof watch(builder, field, 'filterOptions') === 'function' &&
    type !== 'relationship' &&
    type !== 'upload'
  ) {
    ineligible('field:filterOptions')
  }
  if (type === 'richText') {
    const editor = watch(builder, field, 'editor')
    const editorHooks =
      editor && typeof editor === 'object' ? watch(builder, editor, 'hooks') : undefined
    for (const name of fieldHookNames) {
      const list = editorHooks ? watch(builder, editorHooks, name) : undefined
      if (!isEmptyList(list) && (!Array.isArray(list) || !list.every(isOwn))) {
        ineligible(`richText:hooks:${name}`)
      }
    }
  }
  if ('fields' in field) {
    fieldsWalk(builder, field, 'fields')
  }
  if (type === 'tabs') {
    const tabs = watch(builder, field, 'tabs')
    if (!Array.isArray(tabs)) {
      ineligible('tabs:shape')
    }
    for (const tab of tabs) {
      fieldsWalk(builder, tab, 'fields')
    }
  }
  if (type === 'blocks') {
    const blocks = watch(builder, field, 'blocks')
    if (!Array.isArray(blocks) || (field.blockReferences && field.blockReferences.length)) {
      ineligible('blocks:references')
    }
    for (const block of blocks) {
      watchEmptyHooks(builder, block, fieldHookNames)
      fieldsWalk(builder, block, 'fields')
    }
  }
}

export const buildWritePlan = (collection: Any, payload: Any): WritePlan => {
  const builder: Builder = { volatile: [] }
  const config = collection.config
  try {
    watchEmptyHooks(builder, config, writeHooks)
    const rootHooks = watch(builder, payload.config, 'hooks')
    if (rootHooks && !isEmptyList(watch(builder, rootHooks, 'afterError'))) {
      ineligible('hooks:root:afterError')
    }
    if (watch(builder, config, 'upload')) {
      ineligible('upload')
    }
    if (watch(builder, config, 'auth')) {
      ineligible('auth')
    }
    const joins = watch(builder, config, 'joins')
    if (
      (joins && Object.keys(joins).length > 0) ||
      watch(builder, config, 'polymorphicJoins')?.length
    ) {
      ineligible('joins')
    }
    if (watch(builder, collection, 'customIDType')) {
      ineligible('customID')
    }
    if (typeof watch(builder, config, 'select') === 'function') {
      ineligible('select:function')
    }
    const versions = watch(builder, config, 'versions')
    const drafts = versions ? watch(builder, versions, 'drafts') : undefined
    const hasScheduledPublish = Boolean(drafts && watch(builder, drafts, 'schedulePublish'))
    const accessObject = watch(builder, config, 'access') ?? {}
    const access = {
      create: watch(builder, accessObject, 'create'),
      delete: watch(builder, accessObject, 'delete'),
      update: watch(builder, accessObject, 'update'),
    }
    fieldsWalk(builder, config, 'fields')
    return {
      slug: config.slug,
      access,
      eligible: true,
      hasScheduledPublish,
      volatile: builder.volatile,
    }
  } catch (error) {
    return {
      eligible: false,
      reason: error instanceof Ineligible ? error.message : 'plan:error',
      volatile: builder.volatile,
    }
  }
}

const plans = new WeakMap<object, WritePlan>()

const isCurrent = ({ volatile }: WritePlan) => {
  for (let i = 0; i < volatile.length; i++) {
    const entry = volatile[i]!
    if (entry[0][entry[1]] !== entry[2]) {
      return false
    }
  }
  return true
}

/** The write plan of `collection`, rebuilt when a config property it assumed changed. */
export const getWritePlan = (collection: Any, payload: Any) => {
  let plan = plans.get(collection)
  if (plan && isCurrent(plan)) {
    return plan
  }
  plan = buildWritePlan(collection, payload)
  plans.set(collection, plan)
  return plan
}
