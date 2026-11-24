import { isInertTree } from './inert.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- sanitized config shapes */
type Any = any

/**
 * Collection plans of the fused lanes (FUSE_CONTRACT.md section 2): whether a collection's read
 * path is free of user JS, and the field plan the Rust `afterRead` traversal runs
 * (crates/payload-fuse/src/plan.rs documents the JSON).
 */

/** Set by `@payloadcms/richtext-lexical` on its editor `afterRead` hook (value: the editor config). */
export const lexicalAfterReadMarker = Symbol.for('payload.engine-rs.lexicalAfterRead')

/** `[object, key, expected]`: the decision assumed `object[key] === expected`. */
type Volatile = [object: Any, key: PropertyKey, expected: unknown]

export type CollectionPlan =
  | {
      /** Reads of the collection's read access (only reached without `overrideAccess`). */
      access: unknown
      auth: boolean
      eligible: true
      /**
       * The fields' `access.read` functions (once each): a field's `ra` is its index, the
       * request's `fieldAccess[ra]` its result without `overrideAccess`.
       */
      fieldAccess: Any[]
      /** Relationship / upload fields: population would run with `depth && currentDepth <= depth`. */
      hasRelations: boolean
      /** The registered native plan, created on first use (`registerPlan`). */
      id?: number
      json: string
      /** The collections relationship / upload fields point to. */
      relations: string[]
      volatile: Volatile[]
    }
  | { eligible: false; reason: string; volatile: Volatile[] }

const objectPrototypeKeys = new Set(Object.getOwnPropertyNames(Object.prototype))

const readHooks = ['beforeOperation', 'beforeRead', 'afterRead', 'afterOperation'] as const

class Ineligible extends Error {}

const ineligible = (reason: string): never => {
  throw new Ineligible(reason)
}

type Builder = {
  blocks: Map<string, unknown>
  fieldAccess: Any[]
  hasRelations: boolean
  payload: Any
  relations: Set<string>
  volatile: Volatile[]
}

/** Records `object[key]` (and the length of arrays it holds) as an assumption of the plan. */
const watch = (builder: Builder, object: Any, key: PropertyKey): unknown => {
  const value = object[key]
  builder.volatile.push([object, key, value])
  if (Array.isArray(value)) {
    builder.volatile.push([value, 'length', value.length])
  }
  return value
}

const watchEmptyHooks = (builder: Builder, owner: Any, names: readonly string[]) => {
  const hooks = watch(builder, owner, 'hooks') as Any
  if (hooks === undefined || hooks === null) {
    return
  }
  if (typeof hooks !== 'object') {
    ineligible('hooks:shape')
  }
  for (const name of names) {
    const list = watch(builder, hooks, name) as Any
    if (list !== undefined && list !== null && (!Array.isArray(list) || list.length > 0)) {
      ineligible(`hooks:${name}`)
    }
  }
}

const richTextPlan = (builder: Builder, field: Any): string[] => {
  const editor = watch(builder, field, 'editor') as Any
  if (typeof editor !== 'object' || editor === null) {
    ineligible('richText:editor')
  }
  const hooks = watch(builder, editor, 'hooks') as Any
  const afterRead = hooks ? (watch(builder, hooks, 'afterRead') as Any) : undefined
  if (!afterRead?.length) {
    return []
  }
  if (!Array.isArray(afterRead) || afterRead.length !== 1) {
    ineligible('richText:hooks')
  }
  const editorConfig = afterRead[0]?.[lexicalAfterReadMarker]
  if (!editorConfig) {
    ineligible('richText:hooks')
  }
  const features = editorConfig.features
  if (features?.hooks?.afterRead?.length) {
    ineligible('richText:featureHooks')
  }
  const active = new Set<string>()
  for (const map of [features?.nodeHooks?.afterRead, features?.getSubFields]) {
    if (map === undefined || map === null) {
      continue
    }
    if (!(map instanceof Map)) {
      ineligible('richText:features')
    }
    for (const key of map.keys()) {
      if (typeof key !== 'string') {
        ineligible('richText:features')
      }
      active.add(key)
    }
  }
  return [...active]
}

const fieldsPlan = (builder: Builder, owner: Any, key: string): unknown[] => {
  const fields = watch(builder, owner, key) as Any
  if (!Array.isArray(fields)) {
    return ineligible('fields:shape')
  }
  return fields.map((field) => fieldPlan(builder, field))
}

const fieldPlan = (builder: Builder, field: Any): Record<string, unknown> => {
  if (typeof field !== 'object' || field === null) {
    return ineligible('field:shape')
  }
  const type = field.type
  if (typeof type !== 'string') {
    return ineligible('field:type')
  }
  const out: Record<string, unknown> = { t: type }
  if ('name' in field) {
    if (typeof field.name !== 'string' || objectPrototypeKeys.has(field.name)) {
      return ineligible('field:name')
    }
    out.n = field.name
    if (type !== 'ui') {
      out.ad = 1
    }
  }
  if ('virtual' in field && typeof field.virtual === 'string') {
    return ineligible('field:virtual')
  }
  const hidden = watch(builder, field, 'hidden')
  if (hidden) {
    out.h = 1
    if (hidden === true) {
      out.ht = 1
    }
  }
  if (watch(builder, field, 'localized')) {
    out.l = 1
  }
  if (out.ad) {
    watchEmptyHooks(builder, field, ['afterRead'])
    const access = watch(builder, field, 'access') as Any
    if (access !== undefined && access !== null) {
      const read = watch(builder, access, 'read')
      if (read) {
        if (typeof read !== 'function') {
          return ineligible('field:access')
        }
        const index = builder.fieldAccess.indexOf(read)
        out.ra = index === -1 ? builder.fieldAccess.push(read) - 1 : index
      }
    }
    const defaultValue = watch(builder, field, 'defaultValue')
    if (typeof defaultValue === 'function') {
      out.df = 1
    } else if (defaultValue === null) {
      out.dn = 1
    } else if (defaultValue !== undefined) {
      if (!isInertTree(defaultValue, false)) {
        return ineligible('field:defaultValue')
      }
      out.d = defaultValue
    }
  }
  switch (type) {
    case 'array':
    case 'collapsible':
    case 'group':
    case 'row':
    case 'tab':
      out.f = fieldsPlan(builder, field, 'fields')
      break
    case 'blocks': {
      const blocks = watch(builder, field, 'blocks') as Any
      if (!Array.isArray(blocks)) {
        return ineligible('blocks:shape')
      }
      const local: Record<string, unknown> = {}
      for (const block of blocks) {
        if (typeof block === 'string') {
          globalBlock(builder, block)
        } else if (typeof block === 'object' && block !== null && typeof block.slug === 'string') {
          if (!(block.slug in local)) {
            local[block.slug] = fieldsPlan(builder, block, 'fields')
          }
        } else {
          return ineligible('blocks:shape')
        }
      }
      // every global block can match a row's `blockType`, referenced or not
      for (const slug of Object.keys(builder.payload.blocks ?? {})) {
        globalBlock(builder, slug)
      }
      out.b = local
      break
    }
    case 'join':
      return ineligible('join')
    case 'relationship':
    case 'upload': {
      builder.hasRelations = true
      const relationTo = watch(builder, field, 'relationTo')
      if (typeof relationTo === 'string') {
        out.r = relationTo
        builder.relations.add(relationTo)
      } else if (
        Array.isArray(relationTo) &&
        relationTo.every((slug) => typeof slug === 'string')
      ) {
        out.r = [...relationTo]
        for (const slug of relationTo) {
          builder.relations.add(slug)
        }
      } else {
        return ineligible('relationship:relationTo')
      }
      if (watch(builder, field, 'hasMany')) {
        out.m = 1
      }
      const maxDepth = watch(builder, field, 'maxDepth')
      if (typeof maxDepth === 'number') {
        out.md = maxDepth
      } else if (maxDepth !== undefined) {
        return ineligible('relationship:maxDepth')
      }
      break
    }
    case 'richText':
      out.lx = richTextPlan(builder, field)
      break
    case 'tabs': {
      const tabs = watch(builder, field, 'tabs') as Any
      if (!Array.isArray(tabs)) {
        return ineligible('tabs:shape')
      }
      out.tabs = tabs.map((tab: Any) => fieldPlan(builder, { ...tab, type: 'tab' }))
      // the copies above are not the config objects: watch the tabs themselves
      for (const tab of tabs) {
        watch(builder, tab, 'access')
        watch(builder, tab, 'fields')
        watch(builder, tab, 'localized')
        watch(builder, tab, 'hidden')
      }
      break
    }
    default:
      break
  }
  return out
}

const globalBlock = (builder: Builder, slug: string) => {
  if (builder.blocks.has(slug)) {
    return
  }
  const blocks = builder.payload.blocks
  const block =
    blocks && Object.prototype.hasOwnProperty.call(blocks, slug) ? blocks[slug] : undefined
  if (typeof block !== 'object' || block === null) {
    return ineligible('blocks:reference')
  }
  // placeholder first: blocks can reference themselves
  builder.blocks.set(slug, [])
  builder.blocks.set(slug, fieldsPlan(builder, block, 'fields'))
}

/** Builds the plan of `collection` (a `payload.collections[slug]` entry). */
export const buildCollectionPlan = (collection: Any): CollectionPlan => {
  const config = collection.config
  const payload = config && collectionPayload.get(collection)
  const builder: Builder = {
    blocks: new Map(),
    fieldAccess: [],
    hasRelations: false,
    payload,
    relations: new Set(),
    volatile: [],
  }
  try {
    if (!payload) {
      ineligible('payload')
    }
    watchEmptyHooks(builder, config, readHooks)
    if (typeof watch(builder, config, 'select') === 'function') {
      ineligible('select:function')
    }
    const joins = watch(builder, config, 'joins') as Any
    if (joins && Object.keys(joins).length > 0) {
      ineligible('joins')
    }
    if ((watch(builder, config, 'polymorphicJoins') as Any)?.length) {
      ineligible('joins')
    }
    const accessObject = watch(builder, config, 'access') as Any
    const access = accessObject ? watch(builder, accessObject, 'read') : undefined
    const fields = fieldsPlan(builder, config, 'fields')
    // flattened fields: where validation and the sort / where sanitizers read them
    watch(builder, config, 'flattenedFields')
    const collections = Object.keys(payload.collections)
    const json = JSON.stringify({
      slug: config.slug,
      collections,
      fields,
      globalBlocks: Object.fromEntries(builder.blocks),
      trashCollections: collections.filter((slug) => payload.collections[slug]?.config?.trash),
    })
    return {
      access,
      auth: Boolean(config.auth),
      eligible: true,
      fieldAccess: builder.fieldAccess,
      hasRelations: builder.hasRelations,
      json,
      relations: [...builder.relations],
      volatile: builder.volatile,
    }
  } catch (error) {
    if (error instanceof Ineligible) {
      return { eligible: false, reason: error.message, volatile: builder.volatile }
    }
    return { eligible: false, reason: 'plan:error', volatile: builder.volatile }
  }
}

/** `payload` of a collection entry (set by the dispatch before the plan is built). */
export const collectionPayload = new WeakMap<object, unknown>()

const plans = new WeakMap<object, CollectionPlan>()

const isCurrent = (plan: CollectionPlan): boolean => {
  const volatile = plan.volatile
  for (let i = 0; i < volatile.length; i++) {
    const entry = volatile[i]!
    if (entry[0][entry[1]] !== entry[2]) {
      return false
    }
  }
  return true
}

/** The plan of `collection`, rebuilt when a config property it assumed changed. */
export const getCollectionPlan = (collection: Any, payload: unknown): CollectionPlan => {
  let plan = plans.get(collection)
  if (plan && isCurrent(plan)) {
    return plan
  }
  collectionPayload.set(collection, payload)
  plan = buildCollectionPlan(collection)
  plans.set(collection, plan)
  return plan
}
