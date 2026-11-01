/**
 * Recording driver for crates/payload-mongo-joins (run through record.mjs, MongoDB only): Local API
 * calls on the joins test config that reach the join / pagination branches the upstream suites
 * barely use (locale 'all' joins, `count`, `page`, `limit: 0`, sort variants, polymorphic joins
 * with pages, drafts joins, findDistinct over relationships / hasMany / localized fields). The
 * assertions only check that the calls succeed; correctness is the replay's job.
 */
import { expect } from 'vitest'

import { test } from '../../__helpers/int/vitest.js'

test.suite('mongo-joins coverage', { config: '../../joins/config.ts', db: 'mongo' }, () => {
  test('should resolve joins through every branch', async ({ payload }) => {
    const localizedCategory = await payload.create({
      collection: 'localized-categories', overrideAccess: true,
      data: { name: 'loc' },
    })
    for (let i = 0; i < 4; i++) {
      const post = await payload.create({
        collection: 'localized-posts', overrideAccess: true,
        data: { category: localizedCategory.id, title: `en ${i}` },
        locale: 'en',
      })
      await payload.update({
        collection: 'localized-posts', overrideAccess: true,
        data: { category: localizedCategory.id, title: `es ${i}` },
        id: post.id,
        locale: 'es',
      })
    }

    const categories = []
    for (let i = 0; i < 3; i++) {
      categories.push(await payload.create({ collection: 'categories', overrideAccess: true, data: { name: `c${i}` } }))
    }
    for (let i = 0; i < 7; i++) {
      await payload.create({
        collection: 'posts', overrideAccess: true,
        data: {
          categories: [categories[i % 3]!.id, categories[(i + 1) % 3]!.id],
          categoriesLocalized: [categories[i % 2]!.id],
          category: categories[i % 3]!.id,
          localizedText: `text ${i % 4}`,
          polymorphic: { relationTo: 'categories', value: categories[i % 2]!.id },
          title: `post ${i}`,
        },
      })
    }

    const parent = await payload.create({ collection: 'multiple-collections-parents', overrideAccess: true, data: {} })
    for (let i = 0; i < 5; i++) {
      await payload.create({
        collection: i % 2 ? 'multiple-collections-1' : 'multiple-collections-2',
        overrideAccess: true,
        data: { parent: parent.id, title: `child ${i}` },
      })
    }

    const categoryVersion = await payload.create({
      collection: 'categories-versions', overrideAccess: true,
      data: { title: 'cv' },
    })
    for (let i = 0; i < 3; i++) {
      await payload.create({
        collection: 'versions', overrideAccess: true,
        data: {
          categoryVersion: categoryVersion.id,
          categoryVersions: [categoryVersion.id],
          title: `v${i}`,
        },
        draft: i === 2,
      })
    }

    const calls: Promise<unknown>[] = [
      payload.find({ collection: 'localized-categories', overrideAccess: true, locale: 'all' }),
      payload.find({
        collection: 'localized-categories', overrideAccess: true,
        joins: { relatedPosts: { count: true, limit: 2, page: 2 } },
        locale: 'all',
      }),
      payload.find({
        collection: 'localized-categories', overrideAccess: true,
        joins: { relatedPosts: { count: true, limit: 0 } },
        locale: 'es',
      }),
      payload.find({ collection: 'categories', overrideAccess: true, locale: 'all' }),
      payload.find({
        collection: 'categories', overrideAccess: true,
        joins: {
          hasManyPosts: { count: true, limit: 2, page: 2, sort: '-title' },
          hasManyPostsLocalized: { count: true, sort: 'title' },
          relatedPosts: { count: true, limit: 0, sort: ['title', '-createdAt'] },
        },
      }),
      payload.find({
        collection: 'categories', overrideAccess: true,
        joins: {
          relatedPosts: { count: true, limit: 3, where: { title: { not_equals: 'post 1' } } },
        },
        locale: 'es',
      }),
      payload.find({ collection: 'categories', overrideAccess: true, joins: false }),
      payload.find({ collection: 'categories', overrideAccess: true, select: { name: true } }),
      payload.find({ collection: 'categories', overrideAccess: true, limit: 2, page: 2, sort: 'name' }),
      payload.findByID({
        collection: 'categories', overrideAccess: true,
        id: categories[0]!.id,
        joins: { hasManyPosts: { count: true, limit: 1 } },
      }),
      payload.find({
        collection: 'multiple-collections-parents', overrideAccess: true,
        joins: { children: { count: true, limit: 2, page: 2, sort: 'title' } },
      }),
      payload.find({
        collection: 'multiple-collections-parents', overrideAccess: true,
        joins: {
          children: {
            count: true,
            limit: 0,
            where: { relationTo: { in: ['multiple-collections-1'] } },
          },
        },
      }),
      payload.find({
        collection: 'multiple-collections-parents', overrideAccess: true,
        joins: { children: { sort: '-title', where: { title: { like: 'child' } } } },
      }),
      payload.find({ collection: 'categories-versions', overrideAccess: true, draft: true }),
      payload.find({
        collection: 'categories-versions', overrideAccess: true,
        draft: true,
        joins: { relatedVersions: { count: true, limit: 1, page: 2 } },
      }),
      payload.findByID({ collection: 'categories-versions', overrideAccess: true, draft: true, id: categoryVersion.id }),
      payload.findDistinct({ collection: 'posts', overrideAccess: true, field: 'category' }),
      payload.findDistinct({ collection: 'posts', overrideAccess: true, field: 'categories', limit: 2, page: 1 }),
      payload.findDistinct({ collection: 'posts', overrideAccess: true, field: 'categories', sort: '-title' }),
      payload.findDistinct({ collection: 'posts', overrideAccess: true, field: 'category.name', sort: 'category.name' }),
      payload.findDistinct({ collection: 'posts', overrideAccess: true, field: 'category.id' }),
      payload.findDistinct({
        collection: 'posts', overrideAccess: true,
        field: 'localizedText',
        locale: 'es',
        limit: 3,
        page: 2,
      }),
      payload.findDistinct({
        collection: 'posts', overrideAccess: true,
        field: 'title',
        sort: '-title',
        where: { title: { not_equals: 'post 0' } },
      }),
      payload.findDistinct({ collection: 'posts', overrideAccess: true, field: 'polymorphic' }),
    ]

    for (const call of calls) {
      await expect(call).resolves.toBeDefined()
    }
  })
})
