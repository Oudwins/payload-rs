/**
 * Config for the targeted find differential suite: drizzle column modes that only exist through
 * `afterSchemaInit` extensions, a reverse one-to-one relation, a polymorphic join and transactions.
 */
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { fileURLToPath } from 'node:url'
import path from 'path'

import { relations } from '../../../../../packages/drizzle/node_modules/drizzle-orm/index.js'
import {
  blob,
  customType,
  integer,
  numeric,
  real,
  sqliteTable,
} from '../../../../../packages/drizzle/node_modules/drizzle-orm/sqlite-core/index.js'
import { buildConfigWithDefaults } from '../../../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export const postsSlug = 'posts'
export const pagesSlug = 'pages'
export const categoriesSlug = 'categories'
export const profilesTable = 'custom_profiles'

const prefixed = customType<{ data: string; driverData: string }>({
  dataType: () => 'text',
  fromDriver: (value) => `custom:${String(value)}:${typeof value}`,
})

const plain = customType<{ data: number; driverData: number }>({
  dataType: () => 'integer',
})

const access = { create: () => true, delete: () => true, read: () => true, update: () => true }

const url = process.env.SQLITE_URL || process.env.DATABASE_URL || 'file:./payload.db'

export default buildConfigWithDefaults({
  config: {
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    collections: [
      {
        slug: categoriesSlug,
        access,
        fields: [
          { name: 'name', type: 'text' },
          {
            name: 'relatedDocs',
            type: 'join',
            collection: [postsSlug, pagesSlug],
            on: 'category',
          },
        ],
      },
      {
        slug: postsSlug,
        access,
        fields: [
          { name: 'title', type: 'text' },
          { name: 'category', type: 'relationship', relationTo: categoriesSlug },
        ],
      },
      {
        slug: pagesSlug,
        access,
        fields: [
          { name: 'title', type: 'text' },
          { name: 'category', type: 'relationship', relationTo: categoriesSlug },
        ],
      },
    ],
    db: sqliteAdapter({
      afterSchemaInit: [
        ({ extendTable, schema }) => {
          const posts = schema.tables[postsSlug]!
          extendTable({
            columns: {
              blobBig: blob('blob_big', { mode: 'bigint' }),
              blobBuf: blob('blob_buf'),
              blobJson: blob('blob_json', { mode: 'json' }),
              custom: prefixed('custom_val'),
              customPlain: plain('custom_plain'),
              isOn: integer('is_on', { mode: 'boolean' }),
              numBig: numeric('num_big', { mode: 'bigint' }),
              numStr: numeric('num_str'),
              realVal: real('real_val'),
              whenMs: integer('when_ms', { mode: 'timestamp_ms' }),
              whenSec: integer('when_sec', { mode: 'timestamp' }),
            },
            table: posts,
          })
          const profiles = sqliteTable(profilesTable, {
            id: integer('id').primaryKey(),
            bio: numeric('bio'),
            postId: integer('post_id'),
          })
          return {
            ...schema,
            relations: {
              ...schema.relations,
              relations_custom_posts_profile: relations(posts, ({ one }) => ({
                profile: one(profiles),
              })),
              relations_custom_profiles: relations(profiles, ({ one }) => ({
                post: one(posts, { fields: [profiles.postId], references: [posts.id] }),
              })),
            },
            tables: { ...schema.tables, [profilesTable]: profiles },
          }
        },
      ],
      client: { url },
      // Operations run in transactions, so the checks run on transaction connections. Not with the
      // real libsql client (PAYLOAD_SQLITE_CLIENT=libsql): Rust then reads through its own
      // connection and cannot see uncommitted rows.
      transactionOptions: process.env.PAYLOAD_SQLITE_CLIENT === 'libsql' ? false : {},
    }),
    typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  },
  suite: 'rs-find-drizzle-columns',
})
