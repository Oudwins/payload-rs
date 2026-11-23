/**
 * Transform plans of the driver lane (MONGO_DRIVER_CONTRACT.md "Transform plans"): the parts of
 * the sanitized config db-mongodb's read `transform` consults, as one JSON document the Rust side
 * decodes once (crates/payload-mongo-driver/src/transform.rs).
 *
 * The plan records exactly the property reads `transform` / `stripFields` / payload's
 * `traverseFields` make on the config (`field.type`, `'name' in field` / `field.name`,
 * `field.localized`, `field.relationTo`, `'fields' in field` / `field.fields`,
 * `'flattenedFields' in field`, `'blocks' in field` / `field.blocks`, `field.tabs`,
 * `field.collection`, `config.blocks`, `config.collections`, `config.localization`). The sanitized
 * config is immutable (as everywhere in the engine), so a plan is built once per entity.
 *
 * Shapes the plan cannot represent exactly make the entity ineligible (`null`): its reads stay on
 * the mongoose lane.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- config objects are walked generically */
type Any = any

/** Keys whose `in` / reads on a plain object reach `Object.prototype`. */
const objectPrototypeKeys = new Set(Object.getOwnPropertyNames(Object.prototype))

type PlanField = Record<string, unknown>

export type TransformPlan = {
  blocks: { fields: number; flattened: null | number; slug: string }[]
  collections: string[]
  configBlocks: number[]
  fields: number
  fieldsArrays: PlanField[][]
  flattened: number
  localization: { localeCodes: string[]; locales: string[] } | null
}

class Ineligible extends Error {}

const ineligible = (reason: string): never => {
  throw new Ineligible(reason)
}

/**
 * Builds the plan of `transform({ fields, operation: 'read' })` for `config`, `flattened` being
 * `flattenAllFields({ cache: true, fields })`. Returns `null` (with the reason) when ineligible.
 */
export const buildTransformPlan = ({
  config,
  fields,
  flattened,
}: {
  config: Any
  fields: Any[]
  flattened: Any[]
}): { plan: null | TransformPlan; reason?: string } => {
  const fieldsArrays: PlanField[][] = []
  const arrayIDs = new Map<unknown, number>()
  const blocks: TransformPlan['blocks'] = []
  const blockIDs = new Map<unknown, number>()

  const block = (value: Any): number => {
    const known = blockIDs.get(value)
    if (known !== undefined) {
      return known
    }
    if (!value || typeof value !== 'object' || typeof value.slug !== 'string') {
      return ineligible('block without a string slug')
    }
    const id = blocks.length
    blockIDs.set(value, id)
    const entry: TransformPlan['blocks'][number] = { slug: value.slug, fields: -1, flattened: null }
    blocks.push(entry)
    entry.fields = array(value.fields)
    if ('flattenedFields' in value && value.flattenedFields !== undefined) {
      entry.flattened = array(value.flattenedFields)
    }
    return id
  }

  const array = (value: unknown): number => {
    const known = arrayIDs.get(value)
    if (known !== undefined) {
      return known
    }
    if (!Array.isArray(value)) {
      return ineligible('fields that are not an array')
    }
    const id = fieldsArrays.length
    arrayIDs.set(value, id)
    const entries: PlanField[] = []
    fieldsArrays.push(entries)
    for (const field of value) {
      entries.push(planField(field))
    }
    return id
  }

  const planField = (field: Any): PlanField => {
    if (!field || typeof field !== 'object' || typeof field.type !== 'string') {
      return ineligible('field without a string type')
    }
    const entry: PlanField = { type: field.type }
    if ('name' in field) {
      if (typeof field.name !== 'string') {
        return ineligible('non-string field name')
      }
      if (objectPrototypeKeys.has(field.name)) {
        return ineligible(`field named ${field.name}`)
      }
      entry.name = field.name
    }
    if (field.localized) {
      entry.localized = true
    }
    if (typeof field.relationTo === 'string') {
      entry.relationTo = field.relationTo
    }
    if (field.type === 'join' && Array.isArray(field.collection)) {
      entry.joinCollectionIsArray = true
    }
    if ('fields' in field) {
      entry.fields = array(field.fields)
    }
    if ('flattenedFields' in field) {
      entry.flattened = array(field.flattenedFields)
    }
    if ('blocks' in field) {
      if (!Array.isArray(field.blocks)) {
        return ineligible('blocks that are not an array')
      }
      entry.hasBlocks = true
      entry.blocks = field.blocks.map((each: Any) =>
        typeof each === 'string' ? { slug: each } : { block: block(each) },
      )
    }
    if (field.type === 'tabs' && 'tabs' in field) {
      if (!Array.isArray(field.tabs)) {
        return ineligible('tabs that are not an array')
      }
      entry.tabs = field.tabs.map((tab: Any) => {
        if (!tab || typeof tab !== 'object') {
          return ineligible('tab that is not an object')
        }
        const planTab: Record<string, unknown> = { fields: array(tab.fields) }
        if ('name' in tab && tab.name) {
          if (typeof tab.name !== 'string' || objectPrototypeKeys.has(tab.name)) {
            return ineligible('tab name')
          }
          planTab.name = tab.name
        }
        if (tab.localized) {
          planTab.localized = true
        }
        return planTab
      })
    }
    return entry
  }

  try {
    const localization = config.localization
      ? {
          localeCodes: strings(config.localization.localeCodes, 'localeCodes'),
          locales: strings(
            (config.localization.locales ?? ineligible('locales')).map(
              (locale: Any) => locale?.code,
            ),
            'locale codes',
          ),
        }
      : null
    const collections = strings(
      (config.collections ?? []).map((collection: Any) => collection?.slug),
      'collection slugs',
    )
    const configBlocks = (config.blocks ?? []).map(block)
    const plan: TransformPlan = {
      blocks,
      collections,
      configBlocks,
      fields: array(fields),
      fieldsArrays,
      flattened: array(flattened),
      localization,
    }
    return { plan }
  } catch (error) {
    if (error instanceof Ineligible) {
      return { plan: null, reason: error.message }
    }
    throw error
  }
}

const strings = (values: unknown, what: string): string[] => {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    return ineligible(what)
  }
  return values as string[]
}
