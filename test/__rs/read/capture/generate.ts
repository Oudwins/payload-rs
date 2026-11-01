/**
 * Best-effort generic document generator over every field type, used to create
 * extra rich documents (all field types, every locale) for the capture run.
 * Documents that fail validation are skipped by the caller.
 */
import type { FlattenedField, Payload } from 'payload'

type IDs = Record<string, (number | string)[]>

const optionValue = (option: unknown) =>
  typeof option === 'object' && option !== null ? (option as { value: string }).value : option

export const generateData = ({
  fields,
  ids,
  seed,
}: {
  fields: FlattenedField[]
  ids: IDs
  seed: number
}): Record<string, unknown> => {
  const data: Record<string, unknown> = {}

  const relationValue = (field: any, n: number) => {
    const pickID = (slug: string) => {
      const list = ids[slug] ?? []
      return list.length ? list[(seed + n) % list.length] : undefined
    }
    if (Array.isArray(field.relationTo)) {
      const slug = field.relationTo[(seed + n) % field.relationTo.length]
      const value = pickID(slug)
      return value === undefined ? undefined : { relationTo: slug, value }
    }
    return pickID(field.relationTo)
  }

  for (const field of fields as any[]) {
    if (field.virtual || field.name === 'id' || field.admin?.readOnly) {
      continue
    }
    const name = field.name
    switch (field.type) {
      case 'array':
        data[name] = [0, 1].map((i) =>
          generateData({ fields: field.flattenedFields, ids, seed: seed + i + 1 }),
        )
        break
      case 'blocks': {
        const blocks = (field.blocks ?? []).filter((b: unknown) => typeof b === 'object' && b)
        data[name] = blocks.slice(0, 3).map((block: any, i: number) => ({
          blockType: block.slug,
          ...generateData({ fields: block.flattenedFields ?? [], ids, seed: seed + i + 1 }),
        }))
        break
      }
      case 'checkbox':
        data[name] = seed % 2 === 0
        break
      case 'code':
      case 'textarea':
        data[name] = `${name}\n${seed}`
        break
      case 'date':
        data[name] = new Date(Date.UTC(2024, seed % 12, 1 + (seed % 27), 10, 30)).toISOString()
        break
      case 'email':
        data[name] = `gen${seed}-${Math.random().toString(36).slice(2, 8)}@example.com`
        break
      case 'group':
      case 'tab':
        data[name] = generateData({ fields: field.flattenedFields, ids, seed: seed + 1 })
        break
      case 'json':
        data[name] = { nested: { list: [1, 'two', null, true] }, seed }
        break
      case 'number':
        data[name] = field.hasMany ? [seed, seed + 0.5] : seed + 0.25
        break
      case 'point':
        data[name] = [seed % 90, (seed * 2) % 90]
        break
      case 'radio':
      case 'select': {
        const values = (field.options ?? []).map(optionValue)
        if (values.length) {
          data[name] = field.hasMany ? values.slice(0, 2) : values[seed % values.length]
        }
        break
      }
      case 'relationship':
      case 'upload': {
        if (field.hasMany) {
          const values = [relationValue(field, 0), relationValue(field, 1)].filter(Boolean)
          data[name] = values
        } else {
          const value = relationValue(field, 0)
          if (value !== undefined) {
            data[name] = value
          }
        }
        break
      }
      case 'text':
        data[name] = field.hasMany ? [`a${seed}`, `b${seed}`] : `${name}-${seed}`
        break
      default:
        break
    }
  }

  return data
}

export const collectIDs = async (payload: Payload): Promise<IDs> => {
  const ids: IDs = {}
  for (const collection of payload.config.collections) {
    try {
      const { docs } = await payload.find({
        overrideAccess: true,
        collection: collection.slug as any,
        depth: 0,
        limit: 5,
        pagination: false,
        select: {},
      })
      ids[collection.slug] = docs.map((doc: any) => doc.id)
    } catch {
      ids[collection.slug] = []
    }
  }
  return ids
}
