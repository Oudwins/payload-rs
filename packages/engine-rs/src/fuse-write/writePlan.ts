import { defaultFieldValidators } from '../../../payload/src/fields/config/defaultFieldValidators.js'
import { payloadOwnFunctions } from '../../../payload/src/fields/config/payloadOwnFunctions.js'
import { getVersionsMax } from '../../../payload/src/utilities/getVersionsConfig.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { isInertTree } from '../fuse/inert.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- sanitized config and mongoose schema shapes */
type Any = any

/**
 * The write plan of the fused MongoDB writes (packages/engine-rs/FUSED_WRITES.md section 12.1):
 * what `crates/payload-fuse-write`'s write-side steps need from the sanitized collection config and
 * db-mongodb's mongoose schemas, as JSON. Built once per `collection.config`; `volatile` lists the
 * `[object, key, expected]` assumptions (hook arrays and their lengths, validators, defaults) a
 * caller re-checks per call, like the fused read plans.
 */
export type WritePlanResult =
  | { fieldAccess: FieldAccess[]; json: string; reason?: undefined; volatile: Volatile[] }
  | { json?: undefined; reason: string; volatile: Volatile[] }

/**
 * A field's `access` object: a field's `access` in the plan is its index; without
 * `overrideAccess` the request's `fieldAccess[access]` is `access[operation]`'s result for the call
 * (`null`: no function for the operation).
 */
type FieldAccess = Record<'create' | 'update', unknown>

type Volatile = [object: Any, key: PropertyKey, expected: unknown]

const objectPrototypeKeys = new Set(Object.getOwnPropertyNames(Object.prototype))

class Ineligible extends Error {}

const ineligible = (reason: string) => {
  throw new Ineligible(reason)
}

/** Field types the write-side steps model (12.1). */
const modelledTypes = new Set([
  'array',
  'blocks',
  'checkbox',
  'collapsible',
  'date',
  'email',
  'group',
  'json',
  'number',
  'relationship',
  'richText',
  'row',
  'select',
  'tabs',
  'text',
  'textarea',
])

/** Validator option keys the default validators of the modelled types read (validations.ts). */
const validatorOptionKeys = [
  'hasMany',
  'max',
  'maxLength',
  'maxRows',
  'min',
  'minLength',
  'minRows',
  'name',
  'options',
  'relationTo',
  'required',
] as const

/** The field hooks upstream runs on the create / update path. */
const writeHookNames = ['beforeValidate', 'beforeChange', 'afterChange'] as const

/** The collection hooks of the create / update path. */
const collectionHookNames = [
  'beforeOperation',
  'beforeValidate',
  'beforeChange',
  'afterChange',
  'afterRead',
  'afterOperation',
  'afterError',
] as const

type Builder = {
  fieldAccess: FieldAccess[]
  payload: Any
  relations: Set<string>
  volatile: Volatile[]
}

const watch = (builder: Builder, object: Any, key: PropertyKey) => {
  const value = object[key]
  builder.volatile.push([object, key, value])
  if (Array.isArray(value)) {
    builder.volatile.push([value, 'length', value.length])
  }
  return value
}

export const buildWritePlan = ({ collection, payload }: { collection: Any; payload: Any }) => {
  const builder: Builder = { fieldAccess: [], payload, relations: new Set(), volatile: [] }
  try {
    const config = collection.config
    const localization = payload.config.localization
    if (localization && localization.filterAvailableLocales) {
      ineligible('localization:filterAvailableLocales')
    }
    if (config.auth) {
      ineligible('auth')
    }
    if (config.upload) {
      ineligible('upload')
    }
    const drafts =
      config.versions && typeof config.versions === 'object' ? config.versions.drafts : undefined
    // (`drafts.schedulePublish` only changes deletes: deleteScheduledPublishJobs)
    if (collection.customIDType) {
      ineligible('customID')
    }
    const hooks = watch(builder, config, 'hooks')
    for (const name of collectionHookNames) {
      const list = hooks ? watch(builder, hooks, name) : undefined
      if (list !== undefined && list !== null && (!Array.isArray(list) || list.length > 0)) {
        ineligible(`hooks:${name}`)
      }
    }
    const rootHooks = payload.config.hooks
    if (rootHooks?.afterError?.length) {
      ineligible('hooks:root.afterError')
    }
    const fields = fieldsPlan(builder, config.fields)
    const adapter = payload.db
    const Model = adapter.collections?.[config.slug]
    if (!Model?.schema) {
      ineligible('model')
    }
    const max = getVersionsMax(config)
    let versions: unknown = null
    if (config.versions) {
      const VersionModel = adapter.versions?.[config.slug]
      if (!VersionModel?.schema) {
        ineligible('versionModel')
      }
      versions = {
        fields: fieldsPlan(builder, buildVersionCollectionFields(payload.config, config)),
        max,
        schema: schemaPlan(VersionModel.schema),
      }
    }
    const relations: Record<string, unknown> = {}
    for (const slug of builder.relations) {
      const related = payload.collections?.[slug]
      if (!related) {
        ineligible('relationship:unknownCollection')
      }
      relations[slug] = { customIDType: related.customIDType ?? null }
    }
    const json = JSON.stringify({
      slug: config.slug,
      allowAdditionalKeys: Boolean(adapter.allowAdditionalKeys),
      allowIDOnCreate: Boolean(adapter.allowIDOnCreate),
      defaultIDType: adapter.defaultIDType ?? null,
      defaultMaxTextLength:
        typeof payload.config.defaultMaxTextLength === 'number'
          ? payload.config.defaultMaxTextLength
          : null,
      fields,
      // `req.payload.blocks[blockType]` wins over a field's own block of that slug: rows of these
      // slugs bail in the prepare
      globalBlocks: Object.keys(payload.blocks ?? {}),
      localization: localization
        ? { defaultLocale: localization.defaultLocale, localeCodes: localization.localeCodes }
        : null,
      relations,
      schema: schemaPlan(Model.schema),
      timestamps: config.timestamps !== false,
      v: 1,
      versions,
      // `versions.drafts` (sanitized): `validate` (draft validation), `autosave`, `localizeStatus`
      drafts: drafts
        ? {
            autosave: Boolean(drafts.autosave),
            localizeStatus: Boolean(drafts.localizeStatus),
            validate: Boolean(drafts.validate),
          }
        : null,
    })
    return { fieldAccess: builder.fieldAccess, json, volatile: builder.volatile }
  } catch (error) {
    if (error instanceof Ineligible) {
      return { reason: error.message, volatile: builder.volatile }
    }
    throw error
  }
}

const fieldsPlan = (builder: Builder, fields: Any) => {
  if (!Array.isArray(fields)) {
    return ineligible('fields:shape')
  }
  return fields.map((field) => fieldPlan(builder, field))
}

/** `getTranslatedLabel` input: a string, a language map, `false`, or `null` (a function). */
const labelPlan = (label: unknown) => {
  if (label === undefined) {
    return undefined
  }
  if (typeof label === 'string' || label === false) {
    return label
  }
  if (typeof label === 'object' && label !== null && isInertTree(label, false)) {
    return label
  }
  return null
}

/** The field hooks and defaults the library ports, by registry kind. */
const portedKinds = new Set([
  'authorshipBeforeChange:createdBy',
  'authorshipBeforeChange:updatedBy',
  'authorshipBeforeValidate:createdBy',
  'authorshipBeforeValidate:updatedBy',
  'rowIdBeforeChange',
  'rowIdDefaultValue',
])

const ownKind = (fn: unknown) => {
  const own = typeof fn === 'function' ? payloadOwnFunctions.get(fn) : undefined
  if (!own) {
    return ineligible('field:userFunction')
  }
  const kind = 'field' in own ? `${own.kind}:${own.field}` : own.kind
  return portedKinds.has(kind) ? kind : ineligible(`field:${own.kind}`)
}

/**
 * `tab`: a tab of a `tabs` field, which upstream's traversals hand on as `{ ...tab, type: 'tab' }`
 * (a fresh object per call: the functions that would receive it, tab hooks, access and
 * validators, are user functions and make the collection ineligible here).
 */
const fieldPlan = (builder: Builder, field: Any, tab?: 'tab') => {
  if (typeof field !== 'object' || field === null || (!tab && typeof field.type !== 'string')) {
    return ineligible('field:shape')
  }
  const type = tab ?? field.type
  if (!tab && !modelledTypes.has(type)) {
    return ineligible(`field:${type}`)
  }
  const out: Record<string, unknown> = { t: type }
  const named = 'name' in field
  if (named) {
    if (typeof field.name !== 'string' || objectPrototypeKeys.has(field.name)) {
      return ineligible('field:name')
    }
    if (field.name.includes('.') || field.name.startsWith('$')) {
      return ineligible('field:name')
    }
    out.n = field.name
  }
  if (watch(builder, field, 'localized')) {
    // sanitization deletes `localized` without localization
    out.l = 1
  }
  if (field.virtual) {
    return ineligible('field:virtual')
  }
  if (field.admin?.condition) {
    return ineligible('field:condition')
  }
  if (type === 'date' && field.timezone) {
    return ineligible('date:timezone')
  }
  if (type === 'json' && field.jsonSchema) {
    // the validator's `validateJSONSchema` (zod) is not ported
    return ineligible('json:jsonSchema')
  }
  const label = labelPlan(field.label)
  if (label !== undefined) {
    out.label = label
  }
  if (named && type !== 'row' && type !== 'collapsible' && type !== 'tabs') {
    const hooks = watch(builder, field, 'hooks')
    if (hooks !== undefined && hooks !== null) {
      const own: Record<string, string[]> = {}
      for (const name of writeHookNames) {
        const list = watch(builder, hooks, name)
        if (list === undefined || list === null) {
          continue
        }
        if (!Array.isArray(list)) {
          return ineligible('field:hooks')
        }
        if (list.length > 0) {
          own[name] = list.map(ownKind)
        }
      }
      if (own.afterChange) {
        return ineligible('field:afterChange')
      }
      out.hooks = own
    }
    const access = watch(builder, field, 'access')
    if (access && (access.create || access.update)) {
      out.access =
        builder.fieldAccess.push({
          create: watch(builder, access, 'create'),
          update: watch(builder, access, 'update'),
        }) - 1
    }
    const defaultValue = watch(builder, field, 'defaultValue')
    if (typeof defaultValue === 'function') {
      if (ownKind(defaultValue) !== 'rowIdDefaultValue') {
        return ineligible('field:defaultValue')
      }
      out.rowId = 1
    } else if (defaultValue !== undefined) {
      if (!isInertTree(defaultValue, false)) {
        return ineligible('field:defaultValue')
      }
      out.d = defaultValue
    }
    const validate = watch(builder, field, 'validate')
    const known = typeof validate === 'function' ? defaultFieldValidators.get(validate) : undefined
    if (!validate) {
      // fields sanitization never saw (the timestamps): upstream validates nothing
    } else if (!known || known.field !== field) {
      return ineligible('field:validate')
    } else if (known.validate === validate) {
      out.val = true
    } else {
      out.val = type
      const options: Record<string, unknown> = {}
      for (const key of validatorOptionKeys) {
        if (key in field) {
          const value = key === 'options' ? selectOptionsPlan(field[key]) : field[key]
          if (typeof value === 'function' || !isInertTree(value, false)) {
            return ineligible(`field:${key}`)
          }
          options[key] = value
        }
      }
      if (type === 'relationship' && field.filterOptions !== undefined) {
        // a static `filterOptions` (a where, `true` / `false`): the validator returns `true` for
        // an empty value without I/O, and its `payloadDataLoader.find` for any other value is a
        // bail of payload-core-validate's host in the prepare
        if (typeof field.filterOptions === 'function' || !isInertTree(field.filterOptions, false)) {
          return ineligible('field:filterOptions')
        }
        options.filterOptions = field.filterOptions
      } else if (field.filterOptions) {
        return ineligible('field:filterOptions')
      }
      out.vo = options
    }
  }
  if ('required' in field && field.required) {
    out.req = 1
  }
  if (named && field.unique) {
    // validateUniqueConstraints (on-demand validation) reads the database for these
    out.u = 1
  }
  switch (type) {
    case 'array':
    case 'collapsible':
    case 'group':
    case 'row':
    case 'tab':
      if (type === 'group' && !named) {
        return ineligible('group:unnamed')
      }
      out.f = fieldsPlan(builder, field.fields)
      break
    case 'blocks':
      if (field.filterOptions) {
        return ineligible('blocks:filterOptions')
      }
      out.b = field.blocks.map((block: Any) =>
        typeof block === 'object' && block !== null && typeof block.slug === 'string'
          ? {
              slug: block.slug,
              f: fieldsPlan(builder, block.fields),
              label: labelPlan(block.labels?.singular),
            }
          : ineligible('blocks:reference'),
      )
      break
    case 'number':
    case 'select':
    case 'text':
      if (field.hasMany) {
        out.m = 1
      }
      break
    case 'relationship': {
      const relationTo = field.relationTo
      if (typeof relationTo === 'string') {
        builder.relations.add(relationTo)
      } else if (Array.isArray(relationTo) && relationTo.every((s) => typeof s === 'string')) {
        relationTo.forEach((slug) => builder.relations.add(slug))
      } else {
        return ineligible('relationship:relationTo')
      }
      out.r = relationTo
      if (field.hasMany) {
        out.m = 1
      }
      break
    }
    case 'richText':
      out.lx = lexicalPlan(builder, field)
      break
    case 'tabs':
      out.tabs = field.tabs.map((tab: Any) => fieldPlan(builder, tab, 'tab'))
      break
    default:
      break
  }
  return out
}

/**
 * A select's `options` as its validator reads them (`option.value`, never the label): an option
 * whose label is a function (drafts' `_status`, `({ t }) => t('version:draft')`) keeps only its
 * `value`; anything else as configured.
 */
const selectOptionsPlan = (options: unknown) =>
  Array.isArray(options)
    ? options.map((option) =>
        typeof option === 'object' && option !== null && typeof option.label === 'function'
          ? { value: option.value }
          : option,
      )
    : options

/** The editor hooks upstream runs on the create / update path, and its `validate`. */
const lexicalHookNames = ['beforeValidate', 'beforeChange', 'afterChange'] as const

const mapKeys = (map: unknown) => {
  if (map === undefined || map === null) {
    return []
  }
  if (!(map instanceof Map)) {
    return ineligible('richText:features')
  }
  return [...map.keys()].map((key) =>
    typeof key === 'string' ? key : ineligible('richText:features'),
  )
}

/**
 * Lexical with Payload's own editor hooks and validator (registered in `payloadOwnFunctions`)
 * whose features add no hooks: `maps` whether the hooks do their node bookkeeping (any node hooks
 * or sub fields: the `req.context.internal.richText` entry), `nodeValidations` the node types
 * whose validations are all richtext-lexical's own (ported: `heading` with its tags, `list`,
 * `listItem`), `validated` the other node types with validations (a document holding one bails).
 */
const lexicalPlan = (builder: Builder, field: Any) => {
  const editor = watch(builder, field, 'editor')
  if (typeof editor !== 'object' || editor === null) {
    return ineligible('richText:editor')
  }
  const validate = payloadOwnFunctions.get(watch(builder, editor, 'validate'))
  if (validate?.kind !== 'lexicalValidate') {
    return ineligible('richText:validate')
  }
  const editorConfig: Any = validate.editorConfig
  const hooks = watch(builder, editor, 'hooks')
  for (const name of lexicalHookNames) {
    const list = hooks ? watch(builder, hooks, name) : undefined
    const own =
      Array.isArray(list) && list.length === 1 ? payloadOwnFunctions.get(list[0]) : undefined
    if (own?.kind !== 'lexicalHook' || own.hook !== name || own.editorConfig !== editorConfig) {
      return ineligible('richText:hooks')
    }
  }
  const features = editorConfig?.features
  for (const name of lexicalHookNames) {
    if (features?.hooks?.[name]?.length) {
      return ineligible('richText:featureHooks')
    }
  }
  const nodeHooks = features?.nodeHooks
  const maps =
    mapKeys(nodeHooks?.beforeValidate).length +
      mapKeys(nodeHooks?.beforeChange).length +
      mapKeys(nodeHooks?.afterChange).length +
      mapKeys(features?.getSubFields).length >
    0
  const nodeValidations: Record<string, unknown[]> = {}
  const validated: string[] = []
  for (const type of mapKeys(features?.validations)) {
    const list = features.validations.get(type)
    const ported = Array.isArray(list)
      ? list.map((fn: unknown) => {
          const own = typeof fn === 'function' ? payloadOwnFunctions.get(fn) : undefined
          if (own?.kind !== 'lexicalNodeValidation') {
            return undefined
          }
          if (own.validation === 'upload' || own.validation === 'relationship') {
            // the upload validation reads the collections' ID types
            own.allowed?.forEach((slug) => builder.relations.add(slug))
          }
          return { allowed: own.allowed, formState: own.formState, validation: own.validation }
        })
      : [undefined]
    if (ported.every(Boolean)) {
      nodeValidations[type] = ported
    } else {
      validated.push(type)
    }
  }
  return { maps, nodeValidations, validated }
}

/**
 * A mongoose schema as the casting needs it: `schema.tree`'s key order, every path with its
 * SchemaType, nested paths, the options the document building reads.
 */
const schemaPlan = (schema: Any, hasEmbeddedDiscriminators = false) => {
  const { options } = schema
  if (options.strict !== true && options.strict !== undefined) {
    ineligible('schema:strict')
  }
  if (
    !hasEmbeddedDiscriminators &&
    schema.discriminators &&
    Object.keys(schema.discriminators).length
  ) {
    ineligible('schema:discriminators')
  }
  const paths: unknown[] = []
  for (const [path, type] of Object.entries<Any>(schema.paths)) {
    paths.push(pathPlan(path, type))
  }
  return {
    minimize: options.minimize !== false,
    nested: Object.keys(schema.nested),
    paths,
    tree: Object.keys(schema.tree),
    versionKey: typeof options.versionKey === 'string' ? options.versionKey : null,
  }
}

const pathPlan = (path: string, type: Any) => {
  const out: Record<string, unknown> = { i: type.instance, p: path }
  const setters = type.setters ?? []
  if (path === '_id') {
    if (setters.some((setter: Any) => setter.name !== 'resetId')) {
      ineligible('schema:setters')
    }
  } else if (setters.length && !type.options?.$skipDiscriminatorCheck) {
    // (an embedded discriminator's key path keeps its value: the setter only rejects others)
    ineligible('schema:setters')
  }
  if (type.getters?.length) {
    ineligible('schema:getters')
  }
  const defaultValue = type.defaultValue
  if (typeof defaultValue === 'function') {
    if (path === '_id' && type.instance === 'ObjectId') {
      out.d = 'auto'
    } else if (type.$isMongooseArray && defaultValue.$runBeforeSetters === true) {
      // mongoose's own array default (`[].concat(default)`), static per schema
      const value = defaultValue.call({})
      if (!isInertTree(value, false)) {
        ineligible('schema:default')
      }
      out.d = { arr: value }
    } else {
      ineligible('schema:default')
    }
  } else if (defaultValue !== undefined) {
    if (!isInertTree(defaultValue, false)) {
      ineligible('schema:default')
    }
    out.d = { s: defaultValue }
  }
  const enumValues = type.enumValues
  if (Array.isArray(enumValues) && enumValues.length) {
    out.enum = enumValues
  }
  const discriminators = type.$isMongooseDocumentArray
    ? type.Constructor?.discriminators
    : undefined
  if (discriminators && Object.keys(discriminators).length) {
    // embedded discriminators (blocks): the element's `discriminatorKey` value picks the schema
    out.dk = type.schema.options.discriminatorKey
    out.disc = Object.fromEntries(
      Object.entries<Any>(discriminators).map(([name, ctor]) => [name, schemaPlan(ctor.schema)]),
    )
  }
  if (type.$isMongooseDocumentArray || type.$isSingleNested) {
    out.sub = schemaPlan(type.schema, Boolean(out.disc))
    out.k = type.$isMongooseDocumentArray ? 'docArray' : 'single'
  } else if (type.$isMongooseArray) {
    const element = type.embeddedSchemaType ?? type.caster
    if (!element) {
      ineligible('schema:array')
    }
    out.el = pathPlan(`${path}.$`, element)
  }
  return out
}
