/**
 * Boots an upstream test config with the sqlite adapter and drives `transformForWrite` (directly and
 * through the adapter's create/update/version operations) with generated data for every collection,
 * global and versions table. Requires the transformForWrite module to be wrapped with
 * `wrapTransformForWrite` (vi.mock in the calling spec).
 */
import path from 'node:path'
import { buildVersionCollectionFields, buildVersionGlobalFields, getPayload } from 'payload'
import type { Variant } from './generate.js'

// @ts-expect-error untyped CJS module resolved from the drizzle package
import toSnakeCase from '../../../packages/drizzle/node_modules/to-snake-case/index.js'
import { transformForWrite } from '../../../packages/drizzle/src/transform/write/index.js'
import { flushFixtures, setCaptureLabel } from './capture.js'
import { generate } from './generate.js'

const VARIANTS: Variant[] = ['full', 'alt', 'nulls', 'empty', 'ops', 'dotted']
const RANDOM_SEEDS = Number(process.env.RS_WRITE_RANDOM_SEEDS ?? 10)

type Target = {
  fields: any[]
  tableName: string
}

const attempt = async (fn: () => unknown) => {
  try {
    await fn()
  } catch {
    // errors are captured as fixtures (transform errors) or irrelevant (database errors)
  }
}

export const captureConfig = async ({
  label,
  suite,
}: {
  label: string
  suite: string
}): Promise<{ calls: number; file: string } | null> => {
  setCaptureLabel(label)
  const { default: configPromise } = await import(
    path.resolve(process.cwd(), 'test', suite, 'config.ts')
  )
  const config = await configPromise
  const payload = await getPayload({ config, cron: false, key: `rs-write-${label}` })

  try {
    const adapter = payload.db as any
    const locales: string[] = config.localization ? config.localization.localeCodes : ['en']
    const configBlocks: any[] = config.blocks ?? []
    const gen = (fields: any[], variant: Variant, seed = 1) =>
      generate({ configBlocks, fields, locales, seed, variant })
    const versionsTable = (slug: string) =>
      adapter.tableNameMap.get(`_${toSnakeCase(slug)}${adapter.versionsSuffix}`)

    const targets: Target[] = []
    for (const collection of config.collections) {
      targets.push({
        fields: collection.flattenedFields,
        tableName: adapter.tableNameMap.get(toSnakeCase(collection.slug)),
      })
      if (collection.versions) {
        targets.push({
          fields: buildVersionCollectionFields(config, collection, true),
          tableName: versionsTable(collection.slug),
        })
      }
    }
    for (const global of config.globals) {
      targets.push({
        fields: global.flattenedFields,
        tableName: adapter.tableNameMap.get(toSnakeCase(global.slug)),
      })
      if (global.versions) {
        targets.push({
          fields: buildVersionGlobalFields(config, global, true),
          tableName: versionsTable(global.slug),
        })
      }
    }

    // Direct calls: every variant and random mixes, plus the optional arguments.
    for (const { fields, tableName } of targets) {
      for (const variant of VARIANTS) {
        await attempt(() =>
          transformForWrite({ adapter, data: gen(fields, variant), fields, tableName }),
        )
      }
      for (let seed = 1; seed <= RANDOM_SEEDS; seed++) {
        await attempt(() =>
          transformForWrite({ adapter, data: gen(fields, 'random', seed), fields, tableName }),
        )
      }
      await attempt(() =>
        transformForWrite({
          adapter,
          data: gen(fields, 'full', 3),
          enableAtomicWrites: true,
          fields,
          parentIsLocalized: true,
          path: 'nested.path.',
          tableName,
        }),
      )
      await attempt(() =>
        transformForWrite({
          adapter,
          data: gen(fields, 'ops', 4),
          enableAtomicWrites: true,
          fields,
          tableName,
        }),
      )
    }

    // Adapter views for branches the sqlite test adapter does not take: non-sqlite point
    // columns (`ST_GeomFromGeoJSON`) and `blocksAsJSON`.
    const adapterViews = [
      Object.create(adapter, { name: { value: 'postgres' } }),
      Object.create(adapter, { blocksAsJSON: { value: true } }),
    ]
    for (const view of adapterViews) {
      for (const { fields, tableName } of targets) {
        for (const [variant, seed] of [
          ['full', 1],
          ['alt', 1],
          ['random', 31],
          ['random', 32],
          ['random', 33],
        ] as const) {
          await attempt(() =>
            transformForWrite({ adapter: view, data: gen(fields, variant, seed), fields, tableName }),
          )
        }
      }
    }

    // Through the adapter operations (upsertRow, optimized updateOne path, versions).
    const now = new Date().toISOString()
    for (const collection of config.collections) {
      const fields = collection.flattenedFields
      let id: unknown
      await attempt(async () => {
        id = (await adapter.create({ collection: collection.slug, data: gen(fields, 'full') }))?.id
      })
      for (const [variant, seed] of [
        ['alt', 1],
        ['ops', 2],
        ['random', 21],
        ['random', 22],
      ] as const) {
        await attempt(() =>
          adapter.updateOne({
            id: id ?? 1,
            collection: collection.slug,
            data: gen(fields, variant, seed),
          }),
        )
      }
      if (collection.versions) {
        await attempt(() =>
          adapter.createVersion({
            autosave: false,
            collectionSlug: collection.slug,
            createdAt: now,
            parent: id ?? 1,
            updatedAt: now,
            versionData: gen(fields, 'full', 5),
          }),
        )
      }
    }
    for (const global of config.globals) {
      const fields = global.flattenedFields
      await attempt(() => adapter.createGlobal({ slug: global.slug, data: gen(fields, 'full') }))
      await attempt(() =>
        adapter.updateGlobal({ slug: global.slug, data: gen(fields, 'random', 7) }),
      )
      if (global.versions) {
        await attempt(() =>
          adapter.createGlobalVersion({
            autosave: false,
            createdAt: now,
            globalSlug: global.slug,
            updatedAt: now,
            versionData: gen(fields, 'full', 6),
          }),
        )
      }
    }
  } finally {
    await payload.destroy()
  }

  return flushFixtures()
}
