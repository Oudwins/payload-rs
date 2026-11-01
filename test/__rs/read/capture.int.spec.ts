/**
 * Captures golden fixtures for the Rust port of drizzle's read transform
 * (crates/payload-sql-read). Boots real Payload with the sqlite adapter for many
 * upstream test configs, seeds them with the suites' own seed functions, creates
 * extra generated documents over every field type (in every locale), reads
 * everything back through the Local API (find/findByID with population, locale 'all',
 * select, drafts, versions, globals, joins) and records every
 * `transform({ adapter, config, data, fields, joinQuery, parentIsLocalized, tableName })`
 * call made by the adapter (reads and the returning reads of writes).
 *
 * Run: SQLITE_URL=file:/tmp/rs-read.db PAYLOAD_ENGINE=ts pnpm test:int:sqlite test/__rs/read/capture.int.spec.ts
 * Optional: RS_READ_CONFIGS=fields,joins to limit the configs.
 * Replay: cargo test -p payload-sql-read --test fixtures
 */
import type { Payload, SanitizedConfig } from 'payload'

import path from 'path'
import { getPayload } from 'payload'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { seedDB } from '../../__helpers/shared/clearAndSeed/seed.js'
import { getTestDataConfig } from '../../__helpers/shared/clearAndSeed/testDataConfig.js'
import { collectIDs, generateData } from './capture/generate.js'
import { flushFixture } from './capture/recorder.js'

vi.mock('../../../packages/drizzle/src/transform/read/index.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../packages/drizzle/src/transform/read/index.js')>()
  const { wrapTransform } = await import('./capture/recorder.js')
  return { ...original, transform: wrapTransform(original.transform) }
})

const defaultConfigs = [
  'fields',
  'localization',
  'relationships',
  'versions',
  'joins',
  'database',
  'select',
  'fields-relationship',
  'nested-fields',
  'array-update',
  'collections-rest',
  'hooks',
  'globals',
  'field-paths',
  'sort',
  'trash',
  'group-by',
  'folders',
  'hierarchy',
  'locked-documents',
  'lexical',
  'plugin-nested-docs',
  'query-presets',
  'auth',
  'uuid-v7',
  'localization-rtl',
  'access-control',
  'dataloader',
  'uploads',
]

const configs = process.env.RS_READ_CONFIGS
  ? process.env.RS_READ_CONFIGS.split(',')
  : defaultConfigs

const summary: Record<string, number | string> = {}

const attempt = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch (error) {
    // Capturing is best effort: hooks/validation of the suites may reject generic operations.
    if (process.env.RS_READ_DEBUG) {
      console.log('[rs-read] skipped:', (error as Error)?.message?.slice(0, 300))
    }
  }
}

const readAll = async (payload: Payload) => {
  const localized = Boolean(payload.config.localization)
  for (const collection of payload.config.collections) {
    const slug = collection.slug as any
    const firstFields = collection.flattenedFields
      .filter((f) => f.name !== 'id' && !('virtual' in f && f.virtual))
      .slice(0, 3)
    await attempt(() => payload.find({ overrideAccess: true, collection: slug, depth: 0, limit: 25 }))
    await attempt(() => payload.find({ overrideAccess: true, collection: slug, depth: 2, limit: 10 }))
    await attempt(() => payload.find({ overrideAccess: true, collection: slug, draft: true, limit: 10 }))
    await attempt(() =>
      payload.find({
        overrideAccess: true,
        collection: slug,
        depth: 0,
        limit: 10,
        select: Object.fromEntries(firstFields.map((f) => [f.name, true])),
      }),
    )
    await attempt(() => payload.find({ overrideAccess: true, collection: slug, depth: 0, joins: false, limit: 10 }))
    if (localized) {
      await attempt(() => payload.find({ overrideAccess: true, collection: slug, depth: 1, limit: 25, locale: 'all' }))
      const otherLocale = payload.config.localization
        ? payload.config.localization.localeCodes[1]
        : undefined
      if (otherLocale) {
        await attempt(() =>
          payload.find({
            overrideAccess: true,
            collection: slug,
            depth: 0,
            fallbackLocale: false,
            limit: 10,
            locale: otherLocale,
          }),
        )
      }
    }
    if (collection.versions) {
      await attempt(() => payload.findVersions({ overrideAccess: true, collection: slug, depth: 0, limit: 25 }))
      if (localized) {
        await attempt(() =>
          payload.findVersions({ overrideAccess: true, collection: slug, depth: 0, limit: 25, locale: 'all' }),
        )
      }
    }
  }
  for (const global of payload.config.globals) {
    const slug = global.slug as any
    await attempt(() => payload.findGlobal({ overrideAccess: true, slug, depth: 1 }))
    if (localized) {
      await attempt(() => payload.findGlobal({ overrideAccess: true, slug, depth: 0, locale: 'all' }))
    }
    if (global.versions) {
      await attempt(() => payload.findGlobalVersions({ overrideAccess: true, slug, depth: 0, limit: 10 }))
    }
  }
}

const generateAndRead = async (payload: Payload) => {
  const ids = await collectIDs(payload)
  const localeCodes = payload.config.localization ? payload.config.localization.localeCodes : []
  for (const collection of payload.config.collections) {
    if (collection.slug.startsWith('payload-') || collection.upload) {
      continue
    }
    for (const seed of [1, 2]) {
      await attempt(async () => {
        const data = generateData({ fields: collection.flattenedFields, ids, seed })
        if (collection.auth && !collection.auth.disableLocalStrategy) {
          data.password = 'test-password'
        }
        const doc = await payload.create({ overrideAccess: true, collection: collection.slug as any, data, depth: 0 })
        for (const [i, locale] of localeCodes.slice(1).entries()) {
          await attempt(() =>
            payload.update({
              overrideAccess: true,
              id: doc.id,
              collection: collection.slug as any,
              data: generateData({ fields: collection.flattenedFields, ids, seed: seed + 10 + i }),
              depth: 0,
              locale,
            }),
          )
        }
        await payload.findByID({
          overrideAccess: true,
          id: doc.id,
          collection: collection.slug as any,
          depth: 1,
          locale: localeCodes.length ? 'all' : undefined,
        })
      })
    }
  }
  for (const global of payload.config.globals) {
    await attempt(async () => {
      await payload.updateGlobal({
        overrideAccess: true,
        slug: global.slug as any,
        data: generateData({ fields: global.flattenedFields, ids, seed: 3 }),
        depth: 0,
      })
      for (const [i, locale] of localeCodes.slice(1).entries()) {
        await attempt(() =>
          payload.updateGlobal({
            overrideAccess: true,
            slug: global.slug as any,
            data: generateData({ fields: global.flattenedFields, ids, seed: 20 + i }),
            depth: 0,
            locale,
          }),
        )
      }
    })
  }
}

describe('capture drizzle read transform fixtures', () => {
  afterAll(() => {
    console.log(`[rs-read] fixtures: ${JSON.stringify(summary)}`)
  })

  for (const name of configs) {
    it(
      name,
      async () => {
        let payload: Payload | undefined
        try {
          const configPath = path.resolve(import.meta.dirname, '../..', name, 'config.ts')
          const { default: configPromise } = (await import(configPath)) as {
            default: Promise<SanitizedConfig> | SanitizedConfig
          }
          payload = await getPayload({
            config: await configPromise,
            cron: false,
            key: `rs-read-${name}`,
          })
          const testData = getTestDataConfig(payload.config)
          await attempt(() =>
            seedDB({
              _payload: payload!,
              alwaysSeed: true,
              collectionSlugs: payload!.config.collections.map(({ slug }) => slug),
              seedFunction: testData?.seed,
              snapshotKey: `rs-read-${name}`,
            }),
          )
          await readAll(payload)
          await generateAndRead(payload)
          await readAll(payload)
        } catch (error) {
          summary[name] = `error: ${(error as Error).message?.slice(0, 200)}`
        } finally {
          await attempt(async () => payload?.destroy())
          const count = flushFixture(name)
          if (typeof summary[name] !== 'string') {
            summary[name] = count
          }
        }
        expect(true).toBe(true)
      },
      900_000,
    )
  }
})
