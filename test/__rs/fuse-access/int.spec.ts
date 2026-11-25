import type { Payload } from 'payload'

import { expect } from 'vitest'

import { fuseStats } from '../../../packages/engine-rs/src/fuse/index.js'
import { test } from '../../__helpers/int/vitest.js'

type FuseWriteStats = {
  diffs: number
  guards: Record<string, number>
  hits: Record<string, number>
}

const fuseWriteStats = (): FuseWriteStats | undefined =>
  Reflect.get(globalThis, Symbol.for('@payloadcms/engine-rs/fuse-write-stats'))

/** Whether the fused lanes run in this process (the Rust engine with them on). */
const isFused = () => process.env.PAYLOAD_ENGINE !== 'ts' && process.env.PAYLOAD_RS_FUSE !== 'off'

const total = (counts: Record<string, number> | undefined) =>
  Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0)

/**
 * Field and collection access without `overrideAccess` (reads, and the fused writes' field write
 * access and population), run often enough that the compiled
 * functions pass guard mode's first verified calls and the fused lanes serve the rest
 * (FUSE_CONTRACT.md section 2). Run with `PAYLOAD_RS_FUSE=shadow` (the runners' `--fuse shadow`)
 * every fused read is also compared with the exact lane.
 */
const rounds = 40

// depth 0: population needs `overrideAccess` (FUSE_CONTRACT.md section 9)

const seed = async (payload: Payload) => {
  const reader = await payload.create({
    overrideAccess: true,
    collection: 'users',
    data: { email: 'reader@payloadcms.com', password: 'test' },
  })
  const other = await payload.create({
    overrideAccess: true,
    collection: 'users',
    data: { email: 'other@payloadcms.com', password: 'test' },
  })
  const noteData = (title: string, stage: string) => ({
    title,
    stage,
    group: { inner: 'inner', other: 'other' },
    layout: [{ blockType: 'hero' as const, caption: 'caption', heading: 'heading' }],
    meta: { note: 'note', shown: 'shown' },
    flat: 'flat',
    rows: [{ cell: 'cell', plain: 'plain' }],
  })
  const published = await payload.create({
    overrideAccess: true,
    collection: 'notes',
    data: { ...noteData('published', 'published'), secret: 'stored secret' },
  })
  const archived = await payload.create({
    overrideAccess: true,
    collection: 'notes',
    data: noteData('archived', 'archived'),
  })
  return { archived, other, published, reader }
}

test.suite('fuse-access', { config: './config.ts' }, () => {
  test('should remove denied fields and skip their defaults', async ({ payload }) => {
    const { archived, other, published, reader } = await seed(payload)

    for (let i = 0; i < rounds; i++) {
      const anonymous = await payload.find({ collection: 'notes', depth: 0, overrideAccess: false })
      const asReader = await payload.find({
        collection: 'notes',
        depth: 0,
        overrideAccess: false,
        user: reader,
      })
      const asOther = await payload.find({
        collection: 'notes',
        depth: 0,
        overrideAccess: false,
        user: other,
      })

      expect(anonymous.docs.map((doc) => doc.id)).toEqual([published.id])
      const [anonymousDoc] = anonymous.docs
      expect(anonymousDoc).not.toHaveProperty('secret')
      expect(anonymousDoc!.open).toBe('open default')
      expect(anonymousDoc!.group).toEqual({ other: 'other' })
      expect(anonymousDoc!.rows![0]).toEqual({ id: expect.anything(), plain: 'plain' })
      expect(anonymousDoc!.meta).toEqual({ shown: 'shown' })
      expect(anonymousDoc).not.toHaveProperty('flat')
      expect(anonymousDoc!.layout![0]).not.toHaveProperty('heading')

      expect(asReader.docs.map((doc) => doc.id).sort()).toEqual([archived.id, published.id].sort())
      const readerArchived = asReader.docs.find((doc) => doc.id === archived.id)!
      expect(readerArchived.secret).toBe('secret default')
      expect(readerArchived.rows![0]!.cell).toBe('cell')
      expect(readerArchived.flat).toBe('flat')
      expect(readerArchived.layout![0]!.heading).toBe('heading')

      const otherPublished = asOther.docs.find((doc) => doc.id === published.id)!
      expect(otherPublished.secret).toBe('stored secret')
      expect(otherPublished.meta!.note).toBe('note')
      expect(otherPublished.rows![0]).not.toHaveProperty('cell')
      expect(otherPublished).not.toHaveProperty('flat')
    }
  })

  test('should apply field access on findByID', async ({ payload }) => {
    const { published, reader } = await seed(payload)

    for (let i = 0; i < rounds; i++) {
      const anonymous = await payload.findByID({
        id: published.id,
        collection: 'notes',
        depth: 0,
        overrideAccess: false,
      })
      const asReader = await payload.findByID({
        id: published.id,
        collection: 'notes',
        depth: 0,
        overrideAccess: false,
        user: reader,
      })

      expect(anonymous).not.toHaveProperty('secret')
      expect(anonymous.group).toEqual({ other: 'other' })
      expect(asReader.secret).toBe('stored secret')
      expect(asReader.group!.inner).toBe('inner')
    }
  })

  test('should count with the access constraint', async ({ payload }) => {
    const { reader } = await seed(payload)

    for (let i = 0; i < rounds; i++) {
      const anonymous = await payload.count({ collection: 'notes', overrideAccess: false })
      const asReader = await payload.count({
        collection: 'notes',
        overrideAccess: false,
        user: reader,
      })

      expect(anonymous.totalDocs).toBe(1)
      expect(asReader.totalDocs).toBe(2)
    }
  })

  test('should apply field write access and populate without overrideAccess', async ({
    payload,
  }) => {
    const { reader } = await seed(payload)
    const tag = await payload.create({
      collection: 'tags',
      data: { name: 'tag' },
      overrideAccess: true,
    })

    for (let i = 0; i < rounds; i++) {
      const created = await payload.create({
        collection: 'entries',
        data: { locked: 'sent', signedInOnly: 'first', tag: tag.id, title: `entry ${i}` },
        depth: i % 2,
        overrideAccess: false,
        user: reader,
      })
      const updated = await payload.update({
        id: created.id,
        collection: 'entries',
        data: { locked: 'changed', signedInOnly: 'second' },
        depth: 0,
        overrideAccess: false,
        user: reader,
      })
      const anonymous = await payload.update({
        id: created.id,
        collection: 'entries',
        data: { signedInOnly: 'third', title: 'renamed' },
        depth: 1,
        overrideAccess: false,
      })

      expect(created.locked).toBe('locked default')
      expect(created.signedInOnly).toBe('first')
      expect(created.tag).toEqual(i % 2 ? expect.objectContaining({ name: 'tag' }) : tag.id)
      expect(updated.locked).toBe('locked default')
      expect(updated.signedInOnly).toBe('second')
      expect(anonymous.signedInOnly).toBe('second')
      expect(anonymous.title).toBe('renamed')
      expect(anonymous.tag).toEqual(expect.objectContaining({ name: 'tag' }))
    }
  })

  test('should populate without overrideAccess', async ({ payload }) => {
    const { reader } = await seed(payload)
    const tag = await payload.create({
      collection: 'tags',
      data: { name: 'tag' },
      overrideAccess: true,
    })

    for (let i = 0; i < rounds; i++) {
      const created = await payload.create({
        collection: 'links',
        data: { tag: tag.id, title: `link ${i}` },
        depth: 1,
        overrideAccess: false,
        user: reader,
      })
      const found = await payload.find({ collection: 'links', depth: 1, overrideAccess: false })
      const byID = await payload.findByID({
        id: created.id,
        collection: 'links',
        depth: 1,
        overrideAccess: false,
        user: reader,
      })

      expect(created.tag).toEqual(expect.objectContaining({ id: tag.id, name: 'tag' }))
      expect(found.docs.every((doc) => typeof doc.tag === 'object')).toBe(true)
      expect(byID.tag).toEqual(expect.objectContaining({ id: tag.id }))
    }
  })

  test('should call field access that reads the document per document', async ({ payload }) => {
    await payload.create({
      overrideAccess: true,
      collection: 'doc-access',
      data: { onlyWhenShown: 'a', title: 'show' },
    })
    await payload.create({
      overrideAccess: true,
      collection: 'doc-access',
      data: { onlyWhenShown: 'b', title: 'hide' },
    })

    for (let i = 0; i < rounds; i++) {
      const result = await payload.find({
        collection: 'doc-access',
        depth: 0,
        overrideAccess: false,
      })
      const byTitle = Object.fromEntries(result.docs.map((doc) => [doc.title, doc]))

      expect(byTitle.show!.onlyWhenShown).toBe('a')
      expect(byTitle.hide).not.toHaveProperty('onlyWhenShown')
    }
  })

  test('should apply document, sibling and block field access in upstream order', async ({
    payload,
  }) => {
    const hitsBefore = total(fuseStats.hits)
    const tag = await payload.create({
      collection: 'tags',
      data: { name: 'tag' },
      overrideAccess: true,
    })
    const link = await payload.create({
      collection: 'links',
      data: { title: 'link' },
      overrideAccess: true,
    })
    const created = await payload.create({
      overrideAccess: true,
      collection: 'row-access',
      data: {
        denied: [{ value: 'stored' }],
        layout: [
          { blockType: 'card', inner: { note: 'shown note' }, public: true },
          { blockType: 'card', inner: { note: 'hidden note' }, public: false },
        ],
        rows: [
          { secret: 'shown secret', visible: true },
          { secret: 'hidden secret', visible: false },
        ],
        first: tag.id,
        second: link.id,
        title: 'doc',
      },
    })
    // a document stored before `later` and `afterDefault` existed: `later` is filled with `{}`
    // synchronously, `afterDefault` one tick after its default call
    await Reflect.get(payload.db, 'collections')['row-access'].updateOne(
      { _id: created.id },
      { $unset: { afterDefault: '', later: '' } },
    )
    const reader = await payload.create({
      overrideAccess: true,
      collection: 'users',
      data: { email: 'rows@payloadcms.com', password: 'test' },
    })

    for (let i = 0; i < rounds; i++) {
      const [doc] = (
        await payload.find({ collection: 'row-access', depth: 0, overrideAccess: false })
      ).docs
      const byID = await payload.findByID({
        id: created.id,
        collection: 'row-access',
        depth: 0,
        overrideAccess: false,
        user: reader,
      })

      expect(doc!.denied).toEqual([])
      // `denied` is refilled one tick after its access call: after `later` (synchronous) and
      // before the default of `afterDefault`
      const keys = Object.keys(doc!)
      expect(keys.indexOf('later')).toBeLessThan(keys.indexOf('denied'))
      expect(keys.indexOf('denied')).toBeLessThan(keys.indexOf('afterDefault'))
      expect(doc!.afterDefault).toBe('after')
      expect(doc!.rows!.map((row) => row.secret)).toEqual(['shown secret', undefined])
      expect(Object.keys(doc!.rows![1]!)).toEqual(['visible', 'id'])
      expect(doc!.layout!.map((block) => block.inner?.note)).toEqual(['shown note', undefined])
      expect(doc).not.toHaveProperty('signedInWithID')
      expect(byID.signedInWithID).toBeUndefined()
      expect(Object.keys(byID)).toEqual(Object.keys(doc!))

      // `first` loads one tick after its access call, after `second`
      const populated = await payload.find({
        collection: 'row-access',
        depth: 1,
        overrideAccess: false,
      })

      expect(populated.docs[0]!.first).toEqual(expect.objectContaining({ id: tag.id }))
      expect(populated.docs[0]!.second).toEqual(expect.objectContaining({ id: link.id }))
    }

    if (isFused()) {
      expect(total(fuseStats.hits) - hitsBefore).toBeGreaterThan(rounds)
    }
  })

  test('should read auth collections with the sessions field access', async ({ payload }) => {
    const hitsBefore = total(fuseStats.hits)
    const me = await payload.create({
      overrideAccess: true,
      collection: 'users',
      data: { email: 'me@payloadcms.com', password: 'test' },
    })
    await payload.create({
      overrideAccess: true,
      collection: 'users',
      data: { email: 'someone@payloadcms.com', password: 'test' },
    })
    await payload.login({ collection: 'users', data: { email: me.email, password: 'test' } })
    await payload.login({
      collection: 'users',
      data: { email: 'someone@payloadcms.com', password: 'test' },
    })

    for (let i = 0; i < rounds; i++) {
      const found = await payload.find({
        collection: 'users',
        depth: 0,
        overrideAccess: false,
        sort: undefined,
        user: me,
      })
      const mine = found.docs.find((doc) => doc.id === me.id)!
      const theirs = found.docs.find((doc) => doc.id !== me.id)!

      expect(mine.sessions).toHaveLength(1)
      expect(theirs.sessions).toEqual([])
    }

    if (isFused()) {
      expect(total(fuseStats.hits) - hitsBefore).toBeGreaterThan(0)
    }
  })

  test('should populate the users at depth 2 without overrideAccess', async ({
    payload,
    restClient,
  }) => {
    const writeHitsBefore = fuseWriteStats()?.hits.create ?? 0
    const me = await payload.create({
      overrideAccess: true,
      collection: 'users',
      data: { email: 'author@payloadcms.com', password: 'test' },
    })
    await restClient.login({
      slug: 'users',
      credentials: { email: 'author@payloadcms.com', password: 'test' },
    })

    for (let i = 0; i < rounds; i++) {
      const local = await payload.create({
        collection: 'authored',
        data: { title: `local ${i}` },
        overrideAccess: false,
        user: me,
      })
      const response = await restClient.POST('/authored', {
        body: JSON.stringify({ title: `rest ${i}` }),
      })
      const { doc: rest } = await response.json()

      expect(local.createdBy).toEqual({
        relationTo: 'users',
        value: expect.objectContaining({ id: me.id }),
      })
      expect(response.status).toBe(201)
      expect(rest.createdBy.value).toEqual(expect.objectContaining({ id: me.id }))
      expect(rest.createdBy.value.sessions).toHaveLength(1)

      // anonymous: the users' read access is `false`, so the nested find of `createdBy` (depth 2)
      // returns no documents and the relationship keeps its id
      const anonymous = await payload.create({
        collection: 'authored',
        data: { parent: local.id, title: `anonymous ${i}` },
        overrideAccess: false,
      })

      expect(anonymous.createdBy).toBeUndefined()
      expect(anonymous.parent).toEqual(
        expect.objectContaining({ createdBy: { relationTo: 'users', value: me.id }, id: local.id }),
      )
    }

    if (isFused() && process.env.PAYLOAD_RS_FUSE_WRITES !== 'off') {
      expect((fuseWriteStats()?.hits.create ?? 0) - writeHitsBefore).toBeGreaterThan(0)
    }
  })
})
