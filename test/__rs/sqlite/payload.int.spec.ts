/**
 * Runs a real Payload sqlite instance on the Rust SQLite runtime. The
 * `@libsql/client` import of `@payloadcms/db-sqlite` is replaced with
 * `vi.mock`, so this works under the regular int project:
 *
 *   SQLITE_URL=file:/tmp/rs-sqlite-runtime.db pnpm test:int:sqlite test/__rs/sqlite/payload.int.spec.ts
 */
import type { Payload } from 'payload'

import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { sql } from '@payloadcms/db-sqlite/drizzle'
import path from 'node:path'
import { buildConfig, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { getNativeSqlite, Sqlite3Client } from '../../../packages/engine-rs/src/sqlite/index.js'

vi.mock('@libsql/client', async () => import('../../../packages/engine-rs/src/sqlite/libsql.js'))

const dbFile = path.resolve('/tmp', `rs-sqlite-payload-${process.pid}.db`)

let payload: Payload

describe('Payload on the Rust SQLite runtime', () => {
  beforeAll(async () => {
    const config = await buildConfig({
      collections: [
        {
          slug: 'posts',
          access: { create: () => true, delete: () => true, read: () => true, update: () => true },
          fields: [
            { name: 'title', type: 'text', unique: true },
            { name: 'views', type: 'number' },
            { name: 'published', type: 'checkbox' },
            { name: 'tags', type: 'array', fields: [{ name: 'tag', type: 'text' }] },
            { name: 'meta', type: 'json' },
            { name: 'related', type: 'relationship', hasMany: true, relationTo: 'posts' },
            {
              name: 'layout',
              type: 'blocks',
              blocks: [{ slug: 'hero', fields: [{ name: 'heading', type: 'text' }] }],
            },
            { name: 'publishedAt', type: 'date' },
            { name: 'localizedTitle', type: 'text', localized: true },
          ],
          versions: { drafts: true },
        },
      ],
      db: sqliteAdapter({ client: { url: `file:${dbFile}` }, transactionOptions: {} }),
      globals: [{ slug: 'settings', access: { read: () => true, update: () => true }, fields: [{ name: 'siteName', type: 'text' }] }],
      localization: { defaultLocale: 'en', locales: ['en', 'de'] },
      secret: 'rs-sqlite',
    })
    payload = await getPayload({ config })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('uses the Rust client', () => {
    expect(payload.db.client).toBeInstanceOf(Sqlite3Client)
    expect(payload.db.drizzle.$client).toBe(payload.db.client)
    expect(getNativeSqlite().sqliteStats()[0]).toBeGreaterThan(0)
  })

  it('creates, reads, updates and deletes documents', async () => {
    const a = await payload.create({
      collection: 'posts',
      data: {
        layout: [{ blockType: 'hero', heading: 'Hi' }],
        meta: { nested: [1, 'two', { three: true }] },
        published: true,
        publishedAt: '2024-01-02T03:04:05.678Z',
        tags: [{ tag: 'x' }, { tag: 'y' }],
        title: 'first',
        views: 1.5,
      },
    })
    const b = await payload.create({ collection: 'posts', data: { related: [a.id], title: 'second', views: 2 } })
    expect(a.tags?.map((t) => t.tag)).toEqual(['x', 'y'])
    expect(a.meta).toEqual({ nested: [1, 'two', { three: true }] })
    expect(a.published).toBe(true)
    expect(a.publishedAt).toBe('2024-01-02T03:04:05.678Z')
    expect(a.layout?.[0]?.heading).toBe('Hi')

    const found = await payload.find({ collection: 'posts', sort: '-views', where: { views: { greater_than: 1 } } })
    expect(found.docs.map((d) => d.title)).toEqual(['second', 'first'])
    expect(found.totalDocs).toBe(2)

    const withRel = await payload.findByID({ id: b.id, collection: 'posts', depth: 1 })
    expect((withRel.related?.[0] as { title: string }).title).toBe('first')

    const updated = await payload.update({ id: a.id, collection: 'posts', data: { views: 10 } })
    expect(updated.views).toBe(10)

    await payload.update({ id: a.id, collection: 'posts', data: { localizedTitle: 'Hallo' }, locale: 'de' })
    const de = await payload.findByID({ id: a.id, collection: 'posts', locale: 'de' })
    expect(de.localizedTitle).toBe('Hallo')

    const versions = await payload.findVersions({ collection: 'posts', where: { parent: { equals: a.id } } })
    expect(versions.totalDocs).toBeGreaterThan(0)

    await expect(payload.create({ collection: 'posts', data: { title: 'first' } })).rejects.toMatchObject({
      name: 'ValidationError',
    })

    await payload.updateGlobal({ data: { siteName: 'rs' }, slug: 'settings' })
    expect((await payload.findGlobal({ slug: 'settings' })).siteName).toBe('rs')

    await payload.delete({ id: b.id, collection: 'posts' })
    expect((await payload.count({ collection: 'posts' })).totalDocs).toBe(1)
  })

  it('runs transactions (commit and rollback)', async () => {
    const req = { payload } as any
    await payload.db.beginTransaction().then(async (id) => {
      req.transactionID = id
      await payload.create({ collection: 'posts', data: { title: 'in-tx' }, req })
      await payload.db.rollbackTransaction(id!)
    })
    expect((await payload.find({ collection: 'posts', where: { title: { equals: 'in-tx' } } })).totalDocs).toBe(0)

    const id = await payload.db.beginTransaction()
    const req2 = { payload, transactionID: id } as any
    await payload.create({ collection: 'posts', data: { title: 'committed' }, req: req2 })
    await payload.db.commitTransaction(id!)
    expect((await payload.find({ collection: 'posts', where: { title: { equals: 'committed' } } })).totalDocs).toBe(1)
  })

  it('reads outside a transaction while it commits (no SQLITE_BUSY)', async () => {
    for (let i = 0; i < 10; i++) {
      const id = await payload.db.beginTransaction()
      const req = { payload, transactionID: id } as any
      await payload.create({ collection: 'posts', data: { title: `race-${i}` }, req })
      const [committed, read] = await Promise.allSettled([
        payload.db.commitTransaction(id!),
        payload.find({ collection: 'posts', where: { title: { like: 'race-' } } }),
      ])
      expect(committed.status).toBe('fulfilled')
      expect(read.status).toBe('fulfilled')
    }
    expect((await payload.count({ collection: 'posts', where: { title: { like: 'race-' } } })).totalDocs).toBe(10)
  })

  it('exposes payload.db.drizzle', async () => {
    const rows = await payload.db.drizzle.all<{ n: number }>(sql`select count(*) as n from posts`)
    expect(rows[0]!.n).toBeGreaterThan(0)
    const res = await payload.db.drizzle.run(sql`update posts set views = 3 where title = 'committed'`)
    expect(res.rowsAffected).toBe(1)
  })
})
