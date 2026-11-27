import { defaultFieldValidators } from '../../../payload/src/fields/config/defaultFieldValidators.js'
import { payloadOwnFunctions } from '../../../payload/src/fields/config/payloadOwnFunctions.js'
import { slug } from '../../../payload/src/fields/validations.js'
import { getVersionsMax } from '../../../payload/src/utilities/getVersionsConfig.js'
import { buildVersionCollectionFields } from '../../../payload/src/versions/buildCollectionFields.js'
import { compileFunction } from '../compile/compileFunction.js'
import { encodeSnapshot, snapshot } from '../compile/snapshot.js'
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
  | {
      fieldAccess: FieldAccess[]
      json: string
      /** A compiled user function of the plan reads `req`: the prepare request carries it. */
      readsReq: boolean
      reason?: undefined
      volatile: Volatile[]
      /**
       * The compiled user functions every prepare call uses (fields outside array / block rows):
       * field hooks, and validators (unless the call skips validation). While one is still in
       * guard sampling's first calls the prepare bails on it (`fn:verify`).
       */
      warmup: { hooks: number[]; validators: number[] }
    }
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
  'radio',
  'relationship',
  'richText',
  'row',
  'select',
  // a text field with `generateSlug` (the prepare runs its branches that read nothing)
  'slug',
  'tabs',
  'text',
  'textarea',
  'upload',
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
  /** Planning the fields of array / block rows (their functions run per row). */
  isInRows: boolean
  payload: Any
  readsReq: boolean
  relations: Set<string>
  volatile: Volatile[]
  warmup: { hooks: number[]; validators: number[] }
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
  const builder: Builder = {
    fieldAccess: [],
    isInRows: false,
    payload,
    readsReq: false,
    relations: new Set(),
    volatile: [],
    warmup: { hooks: [], validators: [] },
  }
  try {
    const config = collection.config
    // `localization.filterAvailableLocales` (a user function) runs on the eligible write paths only
    // in the all-locales publish validation (`resolveValidationLocales`), where the prepare bails
    const localization = payload.config.localization
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
        ? {
            defaultLocale: localization.defaultLocale,
            filterAvailableLocales: Boolean(localization.filterAvailableLocales),
            localeCodes: localization.localeCodes,
          }
        : null,
      relations,
      schema: schemaPlan(Model.schema),
      timestamps: config.timestamps !== false,
      // a unique compound index: the all-locales publish validation would read the database
      uniqueIndexes: (config.sanitizedIndexes ?? []).some((index: Any) => index.unique),
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
    return {
      fieldAccess: builder.fieldAccess,
      json,
      readsReq: builder.readsReq,
      volatile: builder.volatile,
      warmup: builder.warmup,
    }
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

const ownKind = (fn: unknown, field?: Any) => {
  const own = typeof fn === 'function' ? payloadOwnFunctions.get(fn) : undefined
  if (!own) {
    return ineligible('field:userFunction')
  }
  if (own.kind === 'slugBeforeChange') {
    // the field's own `generateSlug` (`name` and `localized` as sanitization passed them)
    const { options } = own
    if (
      field?.type !== 'slug' ||
      options.name !== field.name ||
      Boolean(options.localized) !== Boolean(field.localized)
    ) {
      return ineligible('field:slug:hook')
    }
    return options.slugify ? 'slugBeforeChange:custom' : 'slugBeforeChange'
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
  // an upload field is a relationship everywhere on the write path (beforeValidate, beforeChange,
  // the transforms: `relationship || upload`) except its validator (`upload`, the same code)
  const out: Record<string, unknown> = {
    t: type === 'upload' ? 'relationship' : type === 'slug' ? 'text' : type,
  }
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
  const label = labelPlan(field.label)
  if (label !== undefined) {
    out.label = label
  }
  if (named && type !== 'row' && type !== 'collapsible' && type !== 'tabs') {
    const hooks = watch(builder, field, 'hooks')
    if (hooks !== undefined && hooks !== null) {
      const own: Record<string, unknown[]> = {}
      for (const name of writeHookNames) {
        const list = watch(builder, hooks, name)
        if (list === undefined || list === null) {
          continue
        }
        if (!Array.isArray(list)) {
          return ineligible('field:hooks')
        }
        if (list.length > 0) {
          // compiled user hooks run in the prepare (beforeValidate, beforeChange)
          own[name] = list.map((hook) =>
            name !== 'afterChange' && !payloadOwnFunctions.has(hook)
              ? userFunctionPlan(builder, hook, 0, hookArgKeys, 'field:hooks', (key) =>
                  key === 'field' ? (tab ? { ...field, type: 'tab' } : field) : undefined,
                )
              : ownKind(hook, field),
          )
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
    } else if (!known) {
      // a user function: compiled (FN_COMPILE_CONTRACT.md), evaluated by the prepare
      out.val = userFunctionPlan(
        builder,
        validate,
        1,
        validateOptionKeys,
        'field:validate',
        (key) => spreadProperty(builder, field, key),
      )
    } else if (known.field !== field) {
      return ineligible('field:validate')
    } else if (known.validate === validate || (type === 'slug' && known.validate === slug)) {
      // `() => true` stubs (`validations.slug` among them: uniqueness is the hook's)
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
      if ((type === 'relationship' || type === 'upload') && field.filterOptions !== undefined) {
        // a static `filterOptions` (a where, `true` / `false`): the validator returns `true` for
        // an empty value without I/O, and its `payloadDataLoader.find` for any other value is a
        // bail of payload-core-validate's host in the prepare. A function: `validateFilterOptions`
        // calls it only for a truthy value, where the prepare bails (`fof`)
        if (typeof field.filterOptions === 'function') {
          out.fof = 1
        } else if (!isInertTree(field.filterOptions, false)) {
          return ineligible('field:filterOptions')
        } else {
          options.filterOptions = field.filterOptions
        }
      } else if (field.filterOptions) {
        return ineligible('field:filterOptions')
      }
      if (type === 'json' && field.jsonSchema) {
        options.jsonSchema = jsonSchemaPlan(builder, field)
      }
      if (type === 'date' && field.timezone) {
        // the validator reads `timezone` (truthiness) and the sibling `<name>_tz` (the select
        // field sanitization inserts after this one, a field of the plan like any other)
        options.timezone = true
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
      if (type === 'group' && !named && out.l) {
        // a localized unnamed group: the hooks pass `parentIsLocalized || field.localized` to its
        // fields, `traverseFields` (the transforms) does not
        return ineligible('group:unnamed:localized')
      }
      out.f =
        type === 'array'
          ? inRows(builder, () => fieldsPlan(builder, field.fields))
          : fieldsPlan(builder, field.fields)
      break
    case 'blocks':
      if (field.filterOptions) {
        return ineligible('blocks:filterOptions')
      }
      out.b = inRows(builder, () =>
        field.blocks.map((block: Any) =>
          typeof block === 'object' && block !== null && typeof block.slug === 'string'
            ? {
                slug: block.slug,
                f: fieldsPlan(builder, block.fields),
                label: labelPlan(block.labels?.singular),
              }
            : ineligible('blocks:reference'),
        ),
      )
      break
    case 'number':
    case 'select':
    case 'text':
      if (field.hasMany) {
        out.m = 1
      }
      break
    case 'relationship':
    case 'upload': {
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
 * The keys of `validate`'s options object upstream adds to `{ ...field }`
 * (fields/hooks/beforeChange/promise.ts); the prepare builds them per call.
 */
const validateOptionKeys = new Set([
  'blockData',
  'collectionSlug',
  'data',
  'event',
  'id',
  'jsonError',
  'operation',
  'overrideAccess',
  'path',
  'preferences',
  'previousValue',
  'req',
  'siblingData',
  'skipCompilation',
])

/**
 * The keys of a field `beforeValidate` / `beforeChange` hook's args the prepare builds per call
 * (fields/hooks/{beforeValidate,beforeChange}/promise.ts); `field` is the plan's snapshot, and a
 * hook reading any other key (`context`, `indexPath`, `schemaPath`, `siblingFields`) stays JS.
 */
const hookArgKeys = new Set([
  'blockData',
  'collection',
  'data',
  'global',
  'operation',
  'originalDoc',
  'overrideAccess',
  'path',
  'previousSiblingDoc',
  'previousValue',
  'req',
  'siblingData',
  'siblingDocWithLocales',
  'skipCompilation',
  'value',
])

/** `plan()` with the builder planning the fields of array / block rows. */
const inRows = <T>(builder: Builder, plan: () => T) => {
  const wasInRows = builder.isInRows
  builder.isInRows = true
  try {
    return plan()
  } finally {
    builder.isInRows = wasInRows
  }
}

class Unsupported {}

/** `{ ...field }[key]`: an own enumerable data property, else `Object.prototype`'s. */
const spreadProperty = (builder: Builder, field: Any, key: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(field, key)
  if (descriptor ? !('value' in descriptor) : objectPrototypeKeys.has(key)) {
    return new Unsupported()
  }
  return descriptor?.enumerable ? watch(builder, field, key) : undefined
}

/**
 * A compiled user function of the write path (FUSED_WRITES.md section 12.7): its `FnId`, the
 * keys it reads of argument `argIndex` (the object upstream builds: `operationKeys` per call by
 * the prepare, any other key `constantKey(key)`'s value, snapshotted here; an `Unsupported` or
 * an `undefined` one of a hook makes it ineligible), or ineligible when it does not compile or
 * may read any key. Compiling here is memoized per function (payload's `init` compiles the
 * config's functions with the Rust core); whether a lane may use it (guards installed, active,
 * sampling) is decided per call (plan.ts, the prepare).
 */
const userFunctionPlan = (
  builder: Builder,
  fn: Any,
  argIndex: number,
  operationKeys: Set<string>,
  reason: string,
  constantKey: (key: string) => unknown,
) => {
  if (typeof fn !== 'function') {
    return ineligible(reason)
  }
  const compiled = compileFunction(fn)
  if (!compiled.ok) {
    return ineligible(`${reason}:compile`)
  }
  if (!builder.isInRows) {
    builder.warmup[reason === 'field:validate' ? 'validators' : 'hooks'].push(compiled.id)
  }
  if (compiled.argKeys.length <= argIndex) {
    return { fn: compiled.id }
  }
  const keys = compiled.argKeys[argIndex]
  if (!keys) {
    return ineligible(`${reason}:args`)
  }
  const props: [string, unknown][] = []
  for (const key of keys) {
    if (key === 'req') {
      builder.readsReq = true
    }
    if (operationKeys.has(key)) {
      continue
    }
    const value = constantKey(key)
    if (value instanceof Unsupported || (operationKeys === hookArgKeys && value === undefined)) {
      return ineligible(`${reason}:key`)
    }
    props.push([key, encodeSnapshot(snapshot(value))])
  }
  return { fn: compiled.id, keys, props }
}

/**
 * A json field's `jsonSchema` as the prepare checks it (crates/payload-fuse-write
 * `prepare/json_schema.rs`): upstream's `validateJSONSchema` runs zod's `fromJSONSchema` on
 * `jsonSchema.schema` (a JSON round trip of it) and `safeParse`s the value; this converts the
 * schema the way `fromJSONSchema` does, for the keywords the prepare models, into its nodes, and
 * makes the collection ineligible (`json:jsonSchema:<keyword>`) for anything else. Without both
 * `uri` and `schema`, `validateJSONSchema` fetches the schema (and replaces `jsonSchema.schema`
 * with the promise): ineligible. A localized json field pushes its `mergeLocaleActions` entry
 * after the validator settles, which takes more ticks with a schema than the prepare models.
 */
const jsonSchemaPlan = (builder: Builder, field: Any) => {
  if (field.localized) {
    return ineligible('json:jsonSchema:localized')
  }
  const jsonSchema = watch(builder, field, 'jsonSchema')
  if (typeof jsonSchema !== 'object' || !watch(builder, jsonSchema, 'uri')) {
    return ineligible('json:jsonSchema:fetch')
  }
  const schema = watch(builder, jsonSchema, 'schema')
  if (!schema) {
    return ineligible('json:jsonSchema:fetch')
  }
  let normalized: unknown
  try {
    normalized = JSON.parse(JSON.stringify(schema))
  } catch {
    return ineligible('json:jsonSchema:json')
  }
  return jsonSchemaNode(normalized)
}

/**
 * The zod keywords the conversion models (`$schema` only picks the draft, which matters for refs;
 * a boolean `exclusiveMinimum` / `exclusiveMaximum` makes `minimum` / `maximum` exclusive in every
 * draft, as zod reads them).
 */
const jsonSchemaKeys = new Set([
  '$comment',
  '$schema',
  'additionalProperties',
  'const',
  'default',
  'description',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'items',
  'maximum',
  'maxItems',
  'maxLength',
  'minimum',
  'minItems',
  'minLength',
  'properties',
  'readOnly',
  'required',
  'type',
])

const isLiteral = (value: unknown) =>
  value === null || ['boolean', 'number', 'string'].includes(typeof value)

/** zod's `convertSchema` (from-json-schema.ts) for the modelled keywords. */
const jsonSchemaNode = (schema: unknown): unknown => {
  if (typeof schema === 'boolean') {
    return { k: schema ? 'any' : 'never' }
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return ineligible('json:jsonSchema:shape')
  }
  const s: Any = schema
  for (const key of Object.keys(s)) {
    // other keys are metadata for zod's registry (no effect on parsing), except the ones it
    // treats (composition, refs, ids, patterns, formats, tuples, ...): not modelled
    if (!jsonSchemaKeys.has(key) && zodKeywords.has(key)) {
      return ineligible(`json:jsonSchema:${key}`)
    }
  }
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || !s.enum.every(isLiteral)) {
      return ineligible('json:jsonSchema:enum')
    }
    return { k: s.enum.length === 0 ? 'never' : 'lit', v: s.enum }
  }
  if (s.const !== undefined) {
    return isLiteral(s.const) ? { k: 'lit', v: [s.const] } : ineligible('json:jsonSchema:const')
  }
  if (Array.isArray(s.type)) {
    const options = s.type.map((type: unknown) => jsonSchemaNode({ ...s, type }))
    return options.length === 0
      ? { k: 'never' }
      : options.length === 1
        ? options[0]
        : { k: 'union', o: options }
  }
  const number = (key: string) => (typeof s[key] === 'number' ? s[key] : undefined)
  switch (s.type) {
    case 'array':
      if (Array.isArray(s.items) || s.prefixItems !== undefined) {
        return ineligible('json:jsonSchema:tuple')
      }
      return {
        e: s.items === undefined ? { k: 'any' } : jsonSchemaNode(s.items),
        k: 'arr',
        max: number('maxItems'),
        min: number('minItems'),
      }
    case 'boolean':
      return { k: 'bool' }
    case 'integer':
    case 'number':
      return {
        gt:
          number('exclusiveMinimum') ??
          (s.exclusiveMinimum === true ? number('minimum') : undefined),
        gte: s.exclusiveMinimum === true ? undefined : number('minimum'),
        int: s.type === 'integer',
        k: 'num',
        lt:
          number('exclusiveMaximum') ??
          (s.exclusiveMaximum === true ? number('maximum') : undefined),
        lte: s.exclusiveMaximum === true ? undefined : number('maximum'),
      }
    case 'null':
      return { k: 'null' }
    case 'object': {
      const properties = s.properties || {}
      if (typeof properties !== 'object' || Array.isArray(properties)) {
        return ineligible('json:jsonSchema:properties')
      }
      if (s.required !== undefined && !Array.isArray(s.required)) {
        // `new Set(schema.required || [])`: a string's characters, a throw for others
        return ineligible('json:jsonSchema:required')
      }
      const required = new Set(s.required ?? [])
      const additional = s.additionalProperties
      if (
        additional !== undefined &&
        typeof additional !== 'boolean' &&
        (typeof additional !== 'object' || additional === null || Array.isArray(additional))
      ) {
        return ineligible('json:jsonSchema:additionalProperties')
      }
      return {
        k: 'obj',
        p: Object.entries(properties).map(([name, property]) =>
          name === '__proto__'
            ? ineligible('json:jsonSchema:__proto__')
            : { n: name, r: required.has(name) ? 1 : undefined, s: jsonSchemaNode(property) },
        ),
        x:
          additional === false
            ? 'strict'
            : typeof additional === 'object'
              ? jsonSchemaNode(additional)
              : 'pass',
      }
    }
    case 'string':
      return { k: 'str', max: number('maxLength'), min: number('minLength') }
    case undefined:
      return { k: 'any' }
    default:
      // zod throws `Unsupported type`: `validateJSONSchema` returns its message
      return ineligible('json:jsonSchema:type')
  }
}

/** The keys zod's `fromJSONSchema` gives a meaning (`RECOGNIZED_KEYS`, plus the `$schema` drafts). */
const zodKeywords = new Set([
  '$anchor',
  '$comment',
  '$defs',
  '$dynamicAnchor',
  '$dynamicRef',
  '$id',
  '$ref',
  '$schema',
  '$vocabulary',
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'default',
  'definitions',
  'dependentRequired',
  'dependentSchemas',
  'description',
  'else',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'id',
  'if',
  'items',
  'maxContains',
  'maximum',
  'maxItems',
  'maxLength',
  'maxProperties',
  'minContains',
  'minimum',
  'minItems',
  'minLength',
  'minProperties',
  'multipleOf',
  'not',
  'nullable',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'readOnly',
  'required',
  'then',
  'type',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
])

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
    } else if (
      type.$isMongooseDocumentArray &&
      !defaultValue.$runBeforeSetters &&
      type.options &&
      Object.hasOwn(type.options, 'default') &&
      type.options.default !== null &&
      type.options.default !== undefined &&
      typeof type.options.default !== 'function'
    ) {
      // a document array's wrapper of its array default (`fn.call(this)` of the array default
      // `[].concat(default)`), a function default that runs after the setters
      const value = [].concat(type.options.default)
      if (!isInertTree(value, false)) {
        ineligible('schema:default')
      }
      out.d = { after: value }
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
