/**
 * Generic data generators over flattened fields, producing data in the shape the database adapter
 * receives (localized fields as `{ [locale]: value }`), with many variants: canonical values,
 * alternative/edge values (non-string text, numeric dates, populated relationships, unknown block
 * types), nulls, empties, `$push` / `$remove` / `$inc` operations, dotted keys and random mixes.
 */
import { fieldShouldBeLocalized } from 'payload/shared'

export type Variant = 'alt' | 'dotted' | 'empty' | 'full' | 'nulls' | 'ops' | 'random'

type Ctx = {
  configBlocks: any[]
  depth: number
  locales: string[]
  rand: () => number
  variant: Variant
}

const MAX_DEPTH = 5

export const createRandom = (seed: number) => {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const hexID = (ctx: Ctx) =>
  Array.from({ length: 24 }, () => Math.floor(ctx.rand() * 16).toString(16)).join('')

const optionValues = (field: any): unknown[] =>
  (field.options ?? []).map((o: any) => (o && typeof o === 'object' ? o.value : o))

const resolveBlocks = (field: any, ctx: Ctx): any[] =>
  (field.blocks ?? [])
    .map((b: any) => (typeof b === 'string' ? ctx.configBlocks.find((c) => c.slug === b) : b))
    .filter(Boolean)

/** Picks a candidate for the variant. Candidates: [canonical, alt, empty, null, ...extra]. */
const choose = (ctx: Ctx, candidates: unknown[], ops?: unknown): unknown => {
  switch (ctx.variant) {
    case 'alt':
      return candidates[1] ?? candidates[0]
    case 'dotted':
    case 'full':
      return candidates[0]
    case 'empty':
      return candidates[2] ?? candidates[0]
    case 'nulls':
      return null
    case 'ops':
      return ops === undefined ? candidates[0] : ops
    case 'random': {
      const r = ctx.rand()
      if (r < 0.12) {
        return undefined
      }
      if (r < 0.2) {
        return null
      }
      if (ops !== undefined && r < 0.3) {
        return ops
      }
      return candidates[Math.floor(ctx.rand() * candidates.length)]
    }
  }
}

const relationValue = (field: any, n: number, populated: boolean): unknown => {
  if (Array.isArray(field.relationTo)) {
    return { relationTo: field.relationTo[n % field.relationTo.length], value: n }
  }
  return populated ? { id: n, title: `populated ${n}` } : n
}

const genField = (field: any, ctx: Ctx, parentIsLocalized: boolean, salt: number): unknown => {
  const childLocalized = parentIsLocalized || Boolean(field.localized)
  const deeper = { ...ctx, depth: ctx.depth + 1 }

  switch (field.type) {
    case 'array': {
      if (ctx.depth >= MAX_DEPTH) {
        return choose(ctx, [[], null])
      }
      const rows = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          ...genFields(field.flattenedFields ?? [], deeper, childLocalized, salt + i + 1),
          id: hexID(ctx),
        }))
      const row = rows(1)[0]
      return choose(
        ctx,
        [rows(2), rows(3), [], null, rows(1).map(({ id: _id, ...rest }) => rest)],
        ctx.rand() < 0.5 ? { $push: row } : { $push: rows(2) },
      )
    }
    case 'blocks': {
      if (ctx.depth >= MAX_DEPTH) {
        return choose(ctx, [[], null])
      }
      const blocks = resolveBlocks(field, ctx)
      const blockRows = (order: number) =>
        blocks.map((block, i) => ({
          blockName: `block ${i}`,
          blockType: block.slug,
          id: hexID(ctx),
          ...genFields(block.flattenedFields ?? [], deeper, childLocalized, salt + i + order),
        }))
      return choose(ctx, [
        blockRows(0),
        [
          { blockType: 'does-not-exist', id: hexID(ctx) },
          ...blockRows(1).reverse(),
          { blockType: 5, id: hexID(ctx) },
        ],
        [],
        null,
      ])
    }
    case 'checkbox':
      return choose(ctx, [true, false, false, null])
    case 'code':
    case 'email':
    case 'textarea':
      return choose(ctx, [`${field.type}-${salt}@example.com`, `multi\nline "q" ${salt}`, '', null])
    case 'date':
      return choose(ctx, [
        '2024-01-02T03:04:05.000Z',
        1700000000000 + salt,
        '',
        null,
        -1,
        Number.NaN,
        'not a date',
      ])
    case 'group':
    case 'tab': {
      if (ctx.depth >= MAX_DEPTH) {
        return choose(ctx, [{}, null])
      }
      const value = genFields(field.flattenedFields ?? [], deeper, childLocalized, salt)
      return choose(ctx, [value, { ...value, id: `group-id-${salt}` }, {}, null, 'not-an-object'])
    }
    case 'json':
      return choose(ctx, [
        { a: 1, nested: { b: [1, null, 'x'] } },
        [1, 2, { c: 'd' }],
        {},
        null,
        'json string',
        7,
      ])
    case 'number':
      return field.hasMany
        ? choose(ctx, [[1, 2.5, -3], [salt], [], null, [0, 1e21, 1.5e-7]])
        : choose(ctx, [42 + salt, 1.5e-7, 0, null, -0.5, 1e21], { $inc: 2.5 })
    case 'point':
      return choose(ctx, [[10 + salt, 20], [-1.5, 0], [], null])
    case 'radio':
    case 'select': {
      const values = optionValues(field)
      return field.hasMany
        ? choose(ctx, [values.slice(0, 2), values.slice(-1), [], null, 'single'])
        : choose(ctx, [values[0], values[values.length - 1], '', null])
    }
    case 'relationship':
    case 'upload': {
      const one = relationValue(field, 1 + salt, false)
      const alt = relationValue(field, 2 + salt, true)
      if (field.hasMany) {
        return choose(
          ctx,
          [[one, relationValue(field, 3, false)], [alt, one], [], null, one, [null, one]],
          ctx.rand() < 0.5 ? { $push: [one, alt] } : { $remove: ctx.rand() < 0.5 ? one : [one] },
        )
      }
      return choose(ctx, [one, alt, null, null, { id: 0 }])
    }
    case 'richText':
      return choose(ctx, [
        {
          root: {
            type: 'root',
            children: [{ type: 'paragraph', children: [{ type: 'text', text: `rt ${salt}` }] }],
            direction: null,
            format: '',
            indent: 0,
            version: 1,
          },
        },
        [{ children: [{ text: 'slate' }] }],
        null,
        null,
      ])
    case 'text':
      return field.hasMany
        ? choose(ctx, [[`a${salt}`, `b${salt}`], 'not-an-array', [], null, [`only${salt}`]])
        : choose(ctx, [`text ${salt}`, 5 + salt, '', null, { nested: [1, 'x'] }, true])
    default:
      return undefined
  }
}

export const genFields = (
  fields: any[],
  ctx: Ctx,
  parentIsLocalized: boolean,
  salt = 0,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  fields.forEach((field, i) => {
    if (!field?.name || field.name === 'id' || field.type === 'join' || field.type === 'ui') {
      return
    }
    let value: unknown
    if (fieldShouldBeLocalized({ field, parentIsLocalized })) {
      const r = ctx.variant === 'random' ? ctx.rand() : 1
      if (r < 0.05) {
        value = null
      } else {
        const locales = r < 0.2 ? ctx.locales.slice(0, 1) : ctx.locales
        value = Object.fromEntries(
          locales.map((locale, li) => [
            locale,
            genField(field, ctx, parentIsLocalized, salt + i + li * 7),
          ]),
        )
      }
    } else {
      value = genField(field, ctx, parentIsLocalized, salt + i)
    }
    if (value !== undefined || (ctx.variant === 'random' && ctx.rand() < 0.1)) {
      out[field.name] = value
    }
  })
  return out
}

/** Dotted-key payloads (`{ 'group.child': value }`), exercising `expandOwnDottedKey`. */
export const genDotted = (fields: any[], ctx: Ctx): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if ((field.type === 'group' || field.type === 'tab') && field.flattenedFields?.length) {
      const child = field.flattenedFields.find((f: any) => f.name && f.type !== 'join')
      if (child) {
        out[`${field.name}.${child.name}`] = genField(child, ctx, Boolean(field.localized), 1)
      }
    }
  }
  out['unknown.key'] = 'x'
  out['__proto__.polluted'] = 'y'
  return out
}

export const generate = ({
  configBlocks,
  fields,
  locales,
  seed,
  variant,
}: {
  configBlocks: any[]
  fields: any[]
  locales: string[]
  seed: number
  variant: Variant
}): Record<string, unknown> => {
  const ctx: Ctx = { configBlocks, depth: 0, locales, rand: createRandom(seed), variant }
  if (variant === 'dotted') {
    return genDotted(fields, ctx)
  }
  return genFields(fields, ctx, false, seed % 5)
}
