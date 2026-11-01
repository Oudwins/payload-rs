import { Types } from 'mongoose'
/**
 * Records upstream `handleError`, `getDBName`, `getCollection` / `getGlobal` and `isObjectID`
 * (packages/db-mongodb/src/utilities) on a set of inputs, for
 * crates/payload-mongo-transform/tests/utilities.rs. Written to
 * `$PAYLOAD_RS_MONGO_TRANSFORM_RECORD_DIR/utilities.json` (`unit` project of ./vitest.config.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { getDBName } from '../../../packages/db-mongodb/src/utilities/getDBName.js'
import { getCollection, getGlobal } from '../../../packages/db-mongodb/src/utilities/getEntity.js'
import { handleError } from '../../../packages/db-mongodb/src/utilities/handleError.js'
import { isObjectID } from '../../../packages/db-mongodb/src/utilities/isObjectID.js'
import {
  createEntryReader,
  createFunctionRegistry,
  serializeForEngine,
} from '../../../packages/engine-rs/src/serialize.js'

const tree = (value: unknown) =>
  JSON.parse(serializeForEngine(value, createFunctionRegistry(), createEntryReader(), {}))

const thrown = (fn: () => unknown) => {
  try {
    return { ok: tree(fn()) }
  } catch (error: any) {
    return { error: { name: error?.name, message: error?.message, data: tree(error?.data) } }
  }
}

describe('db-mongodb utilities (recorded for the Rust replay)', () => {
  it('should record utility results', () => {
    const localization = { localeCodes: ['en', 'es', 'de-at'] }
    const errors: unknown[] = [
      { code: 11000, keyValue: { email: 'a' }, message: 'x' },
      { code: 11000, keyValue: { 'slug.en': 'a', other: 1 } },
      { code: 11000, keyValue: { 'group.title.de-at': 'a' } },
      { code: 11000, keyValue: { 'title.fr': 'a' } },
      { code: 11000, keyValue: {} },
      {
        code: 11000,
        keyValue: null,
        message: 'E11000 duplicate key error collection: db.posts index: title.es_1 dup key',
      },
      { code: 11000, keyValue: 'str', message: 'index:   nested.field_1' },
      { code: 11000, message: 'index: _id_' },
      { code: 11000, message: 'no index info' },
      { code: 11000, message: 'index: a\nb_1 then index: c_1' },
      { code: 11000, message: 42 },
      { code: 11000 },
      { code: '11000', keyValue: { email: 'a' } },
      { code: 11001, keyValue: { email: 'a' } },
      { message: 'plain' },
      { code: 11000, keyValue: { '2': 'a', b: 1 } },
    ]
    const handleErrorCases = errors.flatMap((error) =>
      [
        { collection: 'posts', localization },
        { global: 'menu', localization },
        { collection: 'posts' },
      ].map((options) => ({
        error: tree(error),
        options: tree(options),
        result: thrown(() =>
          handleError({
            collection: options.collection,
            error,
            global: options.global,
            req: options.localization
              ? { payload: { config: { localization: options.localization } } }
              : undefined,
          } as any),
        ),
      })),
    )

    const dbNameConfigs: any[] = [
      { slug: 'posts' },
      { name: 'menu', slug: 'ignored' },
      { dbName: 'custom', slug: 'posts' },
      { enumName: 'enum', dbName: 'db', slug: 's' },
      { dbName: 'db', slug: 's' },
      { dbName: '', slug: 's' },
      {},
      { name: null, slug: '' },
    ]
    const getDBNameCases = dbNameConfigs.flatMap((config) =>
      (['dbName', 'enumName'] as const).flatMap((target) =>
        [false, true].map((versions) => ({
          config: tree(config),
          result: thrown(() => getDBName({ config, target, versions })),
          target,
          versions,
        })),
      ),
    )

    const adapter: any = {
      collections: { posts: {} },
      globals: {},
      payload: {
        collections: {
          pages: { config: { slug: 'pages' }, customIDType: 'text' },
          posts: { config: { slug: 'posts' }, customIDType: undefined },
        },
        config: { globals: [{ slug: 'menu' }, { slug: 'footer' }] },
      },
      versions: { menu: {}, posts: {} },
    }
    const entityCases = [
      ...['posts', 'pages', 'missing'].flatMap((slug) =>
        [false, true].map((versions) => ({
          kind: 'collection',
          result: thrown(() => {
            const { collectionConfig, customIDType, Model } = getCollection({
              adapter,
              collectionSlug: slug,
              versions,
            })
            return {
              collectionConfig,
              customIDType,
              model: Model === adapter.collections[slug] ? 'collections' : 'versions',
            }
          }),
          slug,
          versions,
        })),
      ),
      ...['menu', 'footer', 'missing'].flatMap((slug) =>
        [false, true].map((versions) => ({
          kind: 'global',
          result: thrown(() => {
            const { globalConfig, Model } = getGlobal({
              adapter,
              globalSlug: slug,
              versions,
            } as any)
            return { globalConfig, model: Model === adapter.globals ? 'globals' : 'versions' }
          }),
          slug,
          versions,
        })),
      ),
    ]
    const models = {
      collections: Object.keys(adapter.collections),
      versions: Object.keys(adapter.versions),
    }

    const objectIDCases = [
      new Types.ObjectId(),
      // (bson look-alike plain objects cannot cross the typed boundary encoding)
      { a: 1 },
      new Types.Decimal128('1.5'),
      'abcdefabcdefabcdefabcdef',
      null,
      0,
      [],
    ].map((value) => ({ result: isObjectID(value), value: tree(value) }))

    const dir = process.env.PAYLOAD_RS_MONGO_TRANSFORM_RECORD_DIR
    if (dir) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'utilities.json'),
        JSON.stringify({
          entityCases,
          entityInput: tree({
            collections: adapter.payload.collections,
            config: adapter.payload.config,
            models,
          }),
          getDBNameCases,
          handleErrorCases,
          objectIDCases,
        }),
      )
    }
    expect(handleErrorCases.length).toBeGreaterThan(0)
  })
})
