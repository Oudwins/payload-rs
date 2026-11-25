import type { Payload } from 'payload'

import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

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
})
