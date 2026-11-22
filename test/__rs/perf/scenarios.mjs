/**
 * Every measured scenario of the performance suite (`node test/__rs/perf/run.mjs --list` prints the
 * catalogue). A scenario is
 *
 *   { name, surface, category, shapes?, isCountVariable?, setup?, run, teardown? }
 *
 * `run(ctx, state)` is the timed part; `setup(ctx, iteration)` (untimed) prepares what one
 * iteration consumes (e.g. the document a delete removes) and `teardown(ctx, state, result)`
 * (untimed) undoes what it produced (e.g. deletes a created document), so the collection size stays
 * the measured size. `shapes` limits a scenario to some config shapes (localization, drafts, blocks
 * and joins exist only in `complex`; groups, arrays, rich text and hasMany only from `typical` on).
 *
 * Surfaces: `local` (the Local API, `payload.*`), `rest` (the REST endpoints through
 * `@payloadcms/next/routes`, the handlers a Next app mounts under /api, called in-process with
 * Fetch `Request`s, authenticated with a JWT), `graphql` (`GRAPHQL_POST`, in-process).
 *
 * Categories: read, create, update (whole documents and bulk), partial-update (one field or one
 * part of a document), locale, versions (drafts, publishing, version history), delete, globals,
 * auth, uploads, jobs, validation, custom-endpoints, meta (access, preferences).
 *
 * Hooks, validation and access control run inside these operations: the `hooks` shape adds every
 * collection hook and four field hooks on every field, `complex` adds query-constraint access,
 * field access and custom validation.
 */
import { germanPostData, postData, richText } from './configs.mjs'

const RICH = ['typical', 'complex', 'hooks']
const COMPLEX = ['complex']

const by = (ctx, iteration) => ctx.ids.posts[iteration % ctx.ids.posts.length]
const someIDs = (ctx, iteration, count) =>
  Array.from(
    { length: count },
    (_, offset) => ctx.ids.posts[(iteration * count + offset) % ctx.ids.posts.length],
  )
const freshPost = (ctx) =>
  postData({
    authorIDs: ctx.ids.authors,
    categoryIDs: ctx.ids.categories,
    index: 1_000_000 + ctx.nextIndex(),
    random: ctx.random,
    shape: ctx.shape,
  })
const createPost = (ctx) =>
  ctx.payload.create({ collection: 'posts', data: freshPost(ctx), overrideAccess: true })
const deletePost = (ctx, id) =>
  ctx.payload.delete({ collection: 'posts', id, overrideAccess: true })
const createPosts = async (ctx, count) => {
  const ids = []
  for (let index = 0; index < count; index++) {
    ids.push((await createPost(ctx)).id)
  }
  return ids
}
const find = (ctx, args) => ctx.payload.find({ collection: 'posts', overrideAccess: true, ...args })
const update = (ctx, args) =>
  ctx.payload.update({ collection: 'posts', overrideAccess: true, ...args })

/**
 * A mutation whose effect later scenarios could see (counts, joins, array lengths): its untimed
 * setup also reads the stored values of the fields it changes and its untimed teardown writes them
 * back, so every scenario sees the seeded data however many iterations ran before it.
 * `keysOf(state)`: the fields the scenario changes.
 */
const restoring = (keysOf, scenario) => ({
  ...scenario,
  setup: async (ctx, iteration) => {
    const state = await scenario.setup(ctx, iteration)
    const stored = await ctx.payload.findByID({
      collection: 'posts',
      depth: 0,
      id: state.id,
      overrideAccess: true,
    })
    return { ...state, stored }
  },
  teardown: (ctx, state) =>
    update(ctx, {
      data: Object.fromEntries(keysOf(state).map((key) => [key, state.stored[key] ?? null])),
      id: state.id,
    }),
})

/** A whole document of fresh values, except the fields reads filter on or access depends on. */
const wholeDocument = (ctx) => {
  const { slug: _slug, stage: _stage, views: _views, ...data } = freshPost(ctx)
  return data
}

const latestVersion = async (ctx, parent) =>
  (
    await ctx.payload.findVersions({
      collection: 'posts',
      limit: 1,
      overrideAccess: true,
      sort: '-updatedAt',
      where: { parent: { equals: parent } },
    })
  ).docs[0]

/** Local API. */
const local = [
  // ---- read -----------------------------------------------------------------------------------
  { category: 'read', name: 'find limit 10', run: (ctx) => find(ctx, { depth: 0, limit: 10 }) },
  { category: 'read', name: 'find limit 100', run: (ctx) => find(ctx, { depth: 0, limit: 100 }) },
  {
    category: 'read',
    name: 'find limit 200 pagination false',
    run: (ctx) => find(ctx, { depth: 0, limit: 200, pagination: false }),
  },
  {
    category: 'read',
    name: 'find limit 10 depth 1',
    run: (ctx) => find(ctx, { depth: 1, limit: 10 }),
  },
  {
    category: 'read',
    name: 'find limit 10 depth 2',
    run: (ctx) => find(ctx, { depth: 2, limit: 10 }),
  },
  {
    category: 'read',
    name: 'find limit 10 populate author name',
    run: (ctx) => find(ctx, { depth: 1, limit: 10, populate: { authors: { name: true } } }),
  },
  {
    category: 'read',
    name: 'find where equals (indexed)',
    run: (ctx) => find(ctx, { depth: 0, limit: 10, where: { title: { equals: ctx.titles[0] } } }),
  },
  {
    category: 'read',
    name: 'find where not_equals',
    run: (ctx) =>
      find(ctx, { depth: 0, limit: 10, where: { title: { not_equals: ctx.titles[0] } } }),
  },
  {
    category: 'read',
    name: 'find where in (20 ids)',
    run: (ctx) => find(ctx, { depth: 0, limit: 20, where: { id: { in: someIDs(ctx, 0, 20) } } }),
  },
  {
    category: 'read',
    name: 'find where like',
    run: (ctx) => find(ctx, { depth: 0, limit: 10, where: { title: { like: 'alpha' } } }),
  },
  {
    category: 'read',
    name: 'find where contains',
    run: (ctx) => find(ctx, { depth: 0, limit: 10, where: { title: { contains: 'brav' } } }),
  },
  {
    category: 'read',
    name: 'find where range (greater_than / less_than)',
    run: (ctx) =>
      find(ctx, {
        depth: 0,
        limit: 10,
        where: { and: [{ views: { greater_than: 2000 } }, { views: { less_than: 4000 } }] },
      }),
  },
  {
    category: 'read',
    name: 'find where exists',
    run: (ctx) => find(ctx, { depth: 0, limit: 10, where: { author: { exists: true } } }),
  },
  {
    category: 'read',
    name: 'find where and/or + relationship path',
    run: (ctx) =>
      find(ctx, {
        depth: 0,
        limit: 10,
        where: {
          and: [
            { or: [{ views: { greater_than: 5000 } }, { views: { less_than: 100 } }] },
            { 'author.name': { like: 'author' } },
          ],
        },
      }),
  },
  {
    category: 'read',
    name: 'find where array sub-field',
    shapes: RICH,
    run: (ctx) => find(ctx, { depth: 0, limit: 10, where: { 'tags.tag': { equals: 'alpha' } } }),
  },
  {
    category: 'read',
    name: 'find where group sub-field',
    shapes: RICH,
    run: (ctx) => find(ctx, { depth: 0, limit: 10, where: { 'seo.title': { like: 'bravo' } } }),
  },
  {
    category: 'read',
    name: 'find where hasMany in',
    shapes: RICH,
    run: (ctx) =>
      find(ctx, {
        depth: 0,
        limit: 10,
        where: { categories: { in: [ctx.ids.categories[0], ctx.ids.categories[1]] } },
      }),
  },
  {
    category: 'read',
    name: 'find where date range',
    shapes: RICH,
    run: (ctx) =>
      find(ctx, {
        depth: 0,
        limit: 10,
        where: {
          publishedAt: {
            greater_than_equal: '2024-01-02T00:00:00.000Z',
            less_than: '2024-01-05T00:00:00.000Z',
          },
        },
      }),
  },
  {
    category: 'read',
    name: 'find sort -views limit 50',
    run: (ctx) => find(ctx, { depth: 0, limit: 50, sort: '-views' }),
  },
  {
    category: 'read',
    name: 'find sort by two fields',
    run: (ctx) => find(ctx, { depth: 0, limit: 50, sort: ['author', '-views'] }),
  },
  {
    category: 'read',
    name: 'find select title',
    run: (ctx) => find(ctx, { depth: 0, limit: 50, select: { title: true } }),
  },
  {
    category: 'read',
    name: 'find select nested (seo.title)',
    shapes: RICH,
    run: (ctx) => find(ctx, { depth: 0, limit: 50, select: { seo: { title: true }, title: true } }),
  },
  {
    category: 'read',
    name: 'find page 2',
    run: (ctx) => find(ctx, { depth: 0, limit: 10, page: 2 }),
  },
  {
    category: 'read',
    name: 'find last page',
    run: (ctx) => find(ctx, { depth: 0, limit: 10, page: Math.max(1, Math.ceil(ctx.size / 10)) }),
  },
  {
    category: 'read',
    name: 'find with access control (overrideAccess false)',
    run: (ctx) =>
      ctx.payload.find({
        collection: 'posts',
        depth: 0,
        limit: 10,
        overrideAccess: false,
        user: ctx.user,
      }),
  },
  {
    category: 'read',
    name: 'find authors with join',
    shapes: COMPLEX,
    run: (ctx) =>
      ctx.payload.find({ collection: 'authors', depth: 0, limit: 10, overrideAccess: true }),
  },
  {
    category: 'read',
    name: 'find authors join page 2',
    shapes: COMPLEX,
    run: (ctx) =>
      ctx.payload.find({
        collection: 'authors',
        depth: 0,
        joins: { posts: { limit: 5, page: 2, sort: '-views' } },
        limit: 10,
        overrideAccess: true,
      }),
  },
  {
    category: 'read',
    name: 'count',
    run: (ctx) => ctx.payload.count({ collection: 'posts', overrideAccess: true }),
  },
  {
    category: 'read',
    name: 'count where',
    run: (ctx) =>
      ctx.payload.count({
        collection: 'posts',
        overrideAccess: true,
        where: { views: { greater_than: 5000 } },
      }),
  },
  {
    category: 'read',
    name: 'findByID depth 0',
    setup: by,
    run: (ctx, id) =>
      ctx.payload.findByID({ collection: 'posts', depth: 0, id, overrideAccess: true }),
  },
  {
    category: 'read',
    name: 'findByID depth 2',
    setup: by,
    run: (ctx, id) =>
      ctx.payload.findByID({ collection: 'posts', depth: 2, id, overrideAccess: true }),
  },
  {
    category: 'read',
    name: 'findByID select title',
    setup: by,
    run: (ctx, id) =>
      ctx.payload.findByID({
        collection: 'posts',
        depth: 0,
        id,
        overrideAccess: true,
        select: { title: true },
      }),
  },
  {
    category: 'read',
    name: 'findDistinct author',
    run: (ctx) =>
      ctx.payload.findDistinct({
        collection: 'posts',
        field: 'author',
        limit: 20,
        overrideAccess: true,
      }),
  },
  // ---- create ---------------------------------------------------------------------------------
  {
    category: 'create',
    name: 'create',
    setup: freshPost,
    run: (ctx, data) => ctx.payload.create({ collection: 'posts', data, overrideAccess: true }),
    teardown: (ctx, _state, result) => deletePost(ctx, result.id),
  },
  {
    category: 'create',
    name: 'create (title only)',
    setup: (ctx) => ({
      slug: `title-only-${ctx.nextIndex()}`,
      title: `title only ${ctx.nextIndex()}`,
    }),
    run: (ctx, data) =>
      ctx.payload.create({
        collection: 'posts',
        data: ctx.shape === 'minimal' ? { title: data.title } : data,
        overrideAccess: true,
      }),
    teardown: (ctx, _state, result) => deletePost(ctx, result.id),
  },
  {
    category: 'create',
    name: 'create depth 1 (populated result)',
    setup: freshPost,
    run: (ctx, data) =>
      ctx.payload.create({ collection: 'posts', data, depth: 1, overrideAccess: true }),
    teardown: (ctx, _state, result) => deletePost(ctx, result.id),
  },
  {
    category: 'create',
    name: 'create as draft',
    shapes: COMPLEX,
    setup: freshPost,
    run: (ctx, data) =>
      ctx.payload.create({ collection: 'posts', data, draft: true, overrideAccess: true }),
    teardown: (ctx, _state, result) => deletePost(ctx, result.id),
  },
  {
    category: 'create',
    name: 'duplicate',
    setup: by,
    run: (ctx, id) => ctx.payload.duplicate({ collection: 'posts', id, overrideAccess: true }),
    teardown: (ctx, _state, result) => deletePost(ctx, result.id),
  },
  // ---- update (whole documents, bulk) ---------------------------------------------------------
  restoring((state) => Object.keys(state.data), {
    category: 'update',
    name: 'update by id (whole document)',
    setup: (ctx, iteration) => ({ data: wholeDocument(ctx), id: by(ctx, iteration) }),
    run: (ctx, { data, id }) => update(ctx, { data, id }),
  }),
  {
    category: 'update',
    name: 'update many (10 by where)',
    setup: (ctx, iteration) => ({ ids: someIDs(ctx, iteration, 10), revision: iteration }),
    run: (ctx, { ids, revision }) =>
      update(ctx, { data: { revision }, where: { id: { in: ids } } }),
  },
  {
    category: 'update',
    name: 'update by id depth 1 (populated result)',
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), revision: iteration }),
    run: (ctx, { id, revision }) => update(ctx, { data: { revision }, depth: 1, id }),
  },
  // ---- partial updates ------------------------------------------------------------------------
  {
    category: 'partial-update',
    name: 'update scalar field',
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), revision: iteration }),
    run: (ctx, { id, revision }) => update(ctx, { data: { revision }, id }),
  },
  restoring(() => ['author'], {
    category: 'partial-update',
    name: 'update relationship',
    setup: (ctx, iteration) => ({
      author: ctx.ids.authors[iteration % ctx.ids.authors.length],
      id: by(ctx, iteration),
    }),
    run: (ctx, { author, id }) => update(ctx, { data: { author }, id }),
  }),
  restoring(() => ['categories'], {
    category: 'partial-update',
    name: 'update hasMany relationship',
    shapes: RICH,
    setup: (ctx, iteration) => ({
      categories: [ctx.ids.categories[iteration % 20], ctx.ids.categories[(iteration + 7) % 20]],
      id: by(ctx, iteration),
    }),
    run: (ctx, { categories, id }) => update(ctx, { data: { categories }, id }),
  }),
  restoring(() => ['seo'], {
    category: 'partial-update',
    name: 'update group sub-field',
    shapes: RICH,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), title: `seo ${iteration}` }),
    run: (ctx, { id, title }) => update(ctx, { data: { seo: { title } }, id }),
  }),
  restoring(() => ['tags'], {
    category: 'partial-update',
    name: 'update array (replace rows)',
    shapes: RICH,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), iteration }),
    run: (ctx, { id, iteration }) =>
      update(ctx, { data: { tags: [{ tag: `a${iteration}` }, { tag: `b${iteration}` }] }, id }),
  }),
  restoring(() => ['tags'], {
    category: 'partial-update',
    name: 'update array (append a row)',
    shapes: RICH,
    setup: async (ctx, iteration) => {
      const id = by(ctx, iteration)
      const { tags } = await ctx.payload.findByID({
        collection: 'posts',
        depth: 0,
        id,
        overrideAccess: true,
      })
      return { id, tags: [...tags.slice(0, 5), { tag: `appended ${iteration}` }] }
    },
    run: (ctx, { id, tags }) => update(ctx, { data: { tags }, id }),
  }),
  {
    category: 'partial-update',
    name: 'update rich text',
    shapes: RICH,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), iteration }),
    run: (ctx, { id, iteration }) =>
      update(ctx, { data: { content: richText(`edited ${iteration}`) }, id }),
  },
  restoring(() => ['layout'], {
    category: 'partial-update',
    name: 'update blocks',
    shapes: COMPLEX,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), iteration }),
    run: (ctx, { id, iteration }) =>
      update(ctx, {
        data: {
          layout: [
            { blockType: 'hero', heading: `hero ${iteration}`, subheading: 'edited' },
            { blockType: 'gallery', items: [{ caption: `c${iteration}`, credit: { name: 'x' } }] },
          ],
        },
        id,
      }),
  }),
  {
    category: 'partial-update',
    name: 'update tab field (meta.rating)',
    shapes: COMPLEX,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), rating: iteration % 6 }),
    run: (ctx, { id, rating }) => update(ctx, { data: { meta: { rating } }, id }),
  },
  // ---- locale ---------------------------------------------------------------------------------
  {
    category: 'locale',
    name: 'update in de',
    shapes: COMPLEX,
    setup: by,
    run: (ctx, id) =>
      update(ctx, { data: germanPostData({ random: ctx.random }), id, locale: 'de' }),
  },
  {
    category: 'locale',
    name: 'update in fr (one field)',
    shapes: COMPLEX,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), title: `fr ${iteration}` }),
    run: (ctx, { id, title }) => update(ctx, { data: { title }, id, locale: 'fr' }),
  },
  {
    category: 'locale',
    name: 'find in de (fallback to en)',
    shapes: COMPLEX,
    run: (ctx) => find(ctx, { depth: 0, fallbackLocale: 'en', limit: 10, locale: 'de' }),
  },
  {
    category: 'locale',
    name: 'find in fr without fallback',
    shapes: COMPLEX,
    run: (ctx) => find(ctx, { depth: 0, fallbackLocale: false, limit: 10, locale: 'fr' }),
  },
  {
    category: 'locale',
    name: 'find all locales',
    shapes: COMPLEX,
    run: (ctx) => find(ctx, { depth: 0, limit: 10, locale: 'all' }),
  },
  {
    category: 'locale',
    name: 'findByID all locales',
    shapes: COMPLEX,
    setup: by,
    run: (ctx, id) =>
      ctx.payload.findByID({
        collection: 'posts',
        depth: 0,
        id,
        locale: 'all',
        overrideAccess: true,
      }),
  },
  {
    category: 'locale',
    name: 'find where localized field in de',
    shapes: COMPLEX,
    run: (ctx) =>
      find(ctx, { depth: 0, limit: 10, locale: 'de', where: { title: { like: 'de' } } }),
  },
  // ---- versions / drafts ----------------------------------------------------------------------
  {
    category: 'versions',
    name: 'save draft',
    shapes: COMPLEX,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), revision: iteration }),
    run: (ctx, { id, revision }) => update(ctx, { data: { revision }, draft: true, id }),
  },
  {
    category: 'versions',
    name: 'publish',
    shapes: COMPLEX,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), revision: iteration }),
    run: (ctx, { id, revision }) => update(ctx, { data: { _status: 'published', revision }, id }),
  },
  {
    category: 'versions',
    name: 'find drafts',
    shapes: COMPLEX,
    run: (ctx) => find(ctx, { depth: 0, draft: true, limit: 10 }),
  },
  {
    category: 'versions',
    name: 'findByID draft',
    shapes: COMPLEX,
    setup: by,
    run: (ctx, id) =>
      ctx.payload.findByID({
        collection: 'posts',
        depth: 0,
        draft: true,
        id,
        overrideAccess: true,
      }),
  },
  {
    category: 'versions',
    name: 'findVersions',
    isCountVariable: true,
    shapes: COMPLEX,
    setup: by,
    run: (ctx, id) =>
      ctx.payload.findVersions({
        collection: 'posts',
        limit: 10,
        overrideAccess: true,
        where: { parent: { equals: id } },
      }),
  },
  {
    category: 'versions',
    name: 'findVersions (all, sorted)',
    isCountVariable: true,
    shapes: COMPLEX,
    run: (ctx) =>
      ctx.payload.findVersions({
        collection: 'posts',
        limit: 20,
        overrideAccess: true,
        sort: '-updatedAt',
      }),
  },
  {
    category: 'versions',
    name: 'countVersions',
    isCountVariable: true,
    shapes: COMPLEX,
    setup: by,
    run: (ctx, id) =>
      ctx.payload.countVersions({
        collection: 'posts',
        overrideAccess: true,
        where: { parent: { equals: id } },
      }),
  },
  {
    category: 'versions',
    name: 'findVersionByID',
    shapes: COMPLEX,
    setup: async (ctx, iteration) => (await latestVersion(ctx, by(ctx, iteration))).id,
    run: (ctx, id) =>
      ctx.payload.findVersionByID({ collection: 'posts', id, overrideAccess: true }),
  },
  {
    category: 'versions',
    name: 'restoreVersion',
    shapes: COMPLEX,
    setup: async (ctx, iteration) => (await latestVersion(ctx, by(ctx, iteration))).id,
    run: (ctx, id) => ctx.payload.restoreVersion({ collection: 'posts', id, overrideAccess: true }),
  },
  {
    category: 'versions',
    name: 'findGlobalVersions',
    isCountVariable: true,
    shapes: COMPLEX,
    run: (ctx) =>
      ctx.payload.findGlobalVersions({ limit: 10, overrideAccess: true, slug: 'settings' }),
  },
  {
    category: 'versions',
    name: 'restoreGlobalVersion',
    shapes: COMPLEX,
    setup: async (ctx) =>
      (await ctx.payload.findGlobalVersions({ limit: 1, overrideAccess: true, slug: 'settings' }))
        .docs[0].id,
    run: (ctx, id) =>
      ctx.payload.restoreGlobalVersion({ id, overrideAccess: true, slug: 'settings' }),
  },
  // ---- delete ---------------------------------------------------------------------------------
  {
    category: 'delete',
    name: 'delete by id',
    setup: createPost,
    run: (ctx, doc) => deletePost(ctx, doc.id),
  },
  {
    category: 'delete',
    name: 'delete many (5 by where)',
    setup: (ctx) => createPosts(ctx, 5),
    run: (ctx, ids) =>
      ctx.payload.delete({ collection: 'posts', overrideAccess: true, where: { id: { in: ids } } }),
  },
  // ---- globals --------------------------------------------------------------------------------
  {
    category: 'globals',
    name: 'findGlobal',
    run: (ctx) => ctx.payload.findGlobal({ overrideAccess: true, slug: 'settings' }),
  },
  {
    category: 'globals',
    name: 'findGlobal depth 1',
    run: (ctx) => ctx.payload.findGlobal({ depth: 1, overrideAccess: true, slug: 'settings' }),
  },
  {
    category: 'globals',
    name: 'updateGlobal (one field)',
    setup: (_ctx, iteration) => iteration,
    run: (ctx, iteration) =>
      ctx.payload.updateGlobal({
        data: { postsPerPage: iteration % 50 },
        overrideAccess: true,
        slug: 'settings',
      }),
  },
  {
    category: 'globals',
    name: 'updateGlobal (relationship)',
    setup: by,
    run: (ctx, id) =>
      ctx.payload.updateGlobal({ data: { featured: id }, overrideAccess: true, slug: 'settings' }),
    // later global results populate `featured`: which post it is must not depend on iteration counts
    teardown: (ctx) =>
      ctx.payload.updateGlobal({
        data: { featured: null },
        overrideAccess: true,
        slug: 'settings',
      }),
  },
  // ---- auth -----------------------------------------------------------------------------------
  {
    category: 'auth',
    name: 'login',
    isCountVariable: true,
    run: (ctx) => ctx.payload.login({ collection: 'users', data: ctx.credentials }),
  },
  {
    category: 'auth',
    name: 'auth (JWT)',
    isCountVariable: true,
    run: (ctx) => ctx.payload.auth({ headers: ctx.authHeaders() }),
  },
  {
    category: 'auth',
    name: 'forgotPassword (no email)',
    run: (ctx) =>
      ctx.payload.forgotPassword({
        collection: 'users',
        data: { email: ctx.credentials.email },
        disableEmail: true,
        overrideAccess: true,
      }),
  },
  {
    category: 'auth',
    name: 'resetPassword',
    setup: (ctx) =>
      ctx.payload.forgotPassword({
        collection: 'users',
        data: { email: ctx.credentials.email },
        disableEmail: true,
        overrideAccess: true,
      }),
    run: (ctx, token) =>
      ctx.payload.resetPassword({
        collection: 'users',
        data: { password: ctx.credentials.password, token },
        overrideAccess: true,
      }),
    // a reset ends the user's sessions: the JWT the REST / GraphQL scenarios send is renewed
    teardown: (ctx) => ctx.relogin(),
  },
  {
    category: 'auth',
    name: 'unlock',
    run: (ctx) =>
      ctx.payload.unlock({
        collection: 'users',
        data: { email: ctx.credentials.email },
        overrideAccess: true,
      }),
  },
  // ---- uploads --------------------------------------------------------------------------------
  {
    category: 'uploads',
    name: 'create upload',
    setup: (ctx) => ctx.textFile(`upload-${ctx.nextIndex()}.txt`),
    run: (ctx, file) =>
      ctx.payload.create({
        collection: 'media',
        data: { alt: 'upload' },
        file,
        overrideAccess: true,
      }),
    teardown: (ctx, _file, doc) =>
      ctx.payload.delete({ collection: 'media', id: doc.id, overrideAccess: true }),
  },
  {
    category: 'uploads',
    name: 'find uploads',
    run: (ctx) => ctx.payload.find({ collection: 'media', limit: 20, overrideAccess: true }),
  },
  {
    category: 'uploads',
    name: 'update upload metadata',
    setup: (ctx, iteration) => ({ id: ctx.ids.media[iteration % ctx.ids.media.length], iteration }),
    run: (ctx, { id, iteration }) =>
      ctx.payload.update({
        collection: 'media',
        data: { alt: `alt ${iteration}` },
        id,
        overrideAccess: true,
      }),
  },
  // ---- jobs -----------------------------------------------------------------------------------
  {
    category: 'jobs',
    name: 'jobs queue',
    setup: (_ctx, iteration) => iteration,
    run: (ctx, n) =>
      ctx.payload.jobs.queue({ input: { n }, overrideAccess: true, task: 'perfTask' }),
    teardown: (ctx, _n, job) =>
      ctx.payload.delete({ collection: 'payload-jobs', id: job.id, overrideAccess: true }),
  },
  {
    category: 'jobs',
    name: 'jobs runByID',
    setup: (ctx, iteration) =>
      ctx.payload.jobs.queue({ input: { n: iteration }, overrideAccess: true, task: 'perfTask' }),
    run: (ctx, job) => ctx.payload.jobs.runByID({ id: job.id, overrideAccess: true }),
    // a completed job is deleted by default (deleteJobOnComplete): remove it only if it remains
    teardown: (ctx, job) =>
      ctx.payload.delete({
        collection: 'payload-jobs',
        overrideAccess: true,
        where: { id: { equals: job.id } },
      }),
  },
  // ---- validation -----------------------------------------------------------------------------
  {
    category: 'validation',
    name: 'validate create data',
    setup: freshPost,
    run: (ctx, data) => ctx.payload.validate({ collection: 'posts', data, overrideAccess: true }),
  },
  {
    category: 'validation',
    name: 'validate update of a stored document',
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), revision: iteration }),
    run: (ctx, { id, revision }) =>
      ctx.payload.validate({ collection: 'posts', data: { revision }, id, overrideAccess: true }),
  },
  {
    category: 'validation',
    name: 'validate invalid data (errors)',
    run: (ctx) =>
      ctx.payload.validate({ collection: 'posts', data: { title: '' }, overrideAccess: true }),
  },
]

/** REST endpoints (`/api/...`). */
const rest = [
  // ---- read -----------------------------------------------------------------------------------
  {
    category: 'read',
    name: 'GET /posts limit 10',
    run: (ctx) => ctx.rest('GET', ['posts'], { query: { depth: 0, limit: 10 } }),
  },
  {
    category: 'read',
    name: 'GET /posts limit 100',
    run: (ctx) => ctx.rest('GET', ['posts'], { query: { depth: 0, limit: 100 } }),
  },
  {
    category: 'read',
    name: 'GET /posts limit 10 depth 2',
    run: (ctx) => ctx.rest('GET', ['posts'], { query: { depth: 2, limit: 10 } }),
  },
  {
    category: 'read',
    name: 'GET /posts where',
    run: (ctx) =>
      ctx.rest('GET', ['posts'], {
        query: {
          depth: 0,
          limit: 10,
          where: { and: [{ views: { greater_than: 5000 } }, { title: { like: 'bravo' } }] },
        },
      }),
  },
  {
    category: 'read',
    name: 'GET /posts select + sort',
    run: (ctx) =>
      ctx.rest('GET', ['posts'], {
        query: { depth: 0, limit: 50, select: { title: true }, sort: '-views' },
      }),
  },
  {
    category: 'read',
    name: 'GET /posts/:id',
    setup: by,
    run: (ctx, id) => ctx.rest('GET', ['posts', String(id)], { query: { depth: 1 } }),
  },
  { category: 'read', name: 'GET /posts/count', run: (ctx) => ctx.rest('GET', ['posts', 'count']) },
  // ---- create ---------------------------------------------------------------------------------
  {
    category: 'create',
    name: 'POST /posts',
    setup: freshPost,
    run: (ctx, data) => ctx.rest('POST', ['posts'], { body: data }),
    teardown: (ctx, _state, response) => deletePost(ctx, response.json.doc.id),
  },
  {
    category: 'create',
    name: 'POST /posts/:id/duplicate',
    setup: by,
    run: (ctx, id) => ctx.rest('POST', ['posts', String(id), 'duplicate']),
    teardown: (ctx, _state, response) => deletePost(ctx, response.json.doc.id),
  },
  // ---- update ---------------------------------------------------------------------------------
  {
    category: 'partial-update',
    name: 'PATCH /posts/:id (one field)',
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), revision: iteration }),
    run: (ctx, { id, revision }) =>
      ctx.rest('PATCH', ['posts', String(id)], { body: { revision } }),
  },
  restoring((state) => Object.keys(state.data), {
    category: 'update',
    name: 'PATCH /posts/:id (whole document)',
    setup: (ctx, iteration) => ({ data: wholeDocument(ctx), id: by(ctx, iteration) }),
    run: (ctx, { data, id }) => ctx.rest('PATCH', ['posts', String(id)], { body: data }),
  }),
  {
    category: 'update',
    name: 'PATCH /posts?where (bulk, 10)',
    setup: (ctx, iteration) => ({ ids: someIDs(ctx, iteration, 10), revision: iteration }),
    run: (ctx, { ids, revision }) =>
      ctx.rest('PATCH', ['posts'], { body: { revision }, query: { where: { id: { in: ids } } } }),
  },
  {
    category: 'locale',
    name: 'PATCH /posts/:id?locale=de',
    shapes: COMPLEX,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), title: `de ${iteration}` }),
    run: (ctx, { id, title }) =>
      ctx.rest('PATCH', ['posts', String(id)], { body: { title }, query: { locale: 'de' } }),
  },
  {
    category: 'locale',
    name: 'GET /posts?locale=de',
    shapes: COMPLEX,
    run: (ctx) => ctx.rest('GET', ['posts'], { query: { depth: 0, limit: 10, locale: 'de' } }),
  },
  // ---- versions -------------------------------------------------------------------------------
  {
    category: 'versions',
    name: 'PATCH /posts/:id?draft=true (save draft)',
    shapes: COMPLEX,
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), revision: iteration }),
    run: (ctx, { id, revision }) =>
      ctx.rest('PATCH', ['posts', String(id)], { body: { revision }, query: { draft: true } }),
  },
  {
    category: 'versions',
    name: 'GET /posts/versions',
    isCountVariable: true,
    shapes: COMPLEX,
    run: (ctx) => ctx.rest('GET', ['posts', 'versions'], { query: { limit: 10 } }),
  },
  {
    category: 'versions',
    name: 'GET /posts/versions/:id',
    shapes: COMPLEX,
    setup: async (ctx, iteration) => (await latestVersion(ctx, by(ctx, iteration))).id,
    run: (ctx, id) => ctx.rest('GET', ['posts', 'versions', String(id)]),
  },
  {
    category: 'versions',
    name: 'POST /posts/versions/:id (restore)',
    shapes: COMPLEX,
    setup: async (ctx, iteration) => (await latestVersion(ctx, by(ctx, iteration))).id,
    run: (ctx, id) => ctx.rest('POST', ['posts', 'versions', String(id)]),
  },
  {
    category: 'versions',
    name: 'GET /globals/settings/versions',
    isCountVariable: true,
    shapes: COMPLEX,
    run: (ctx) => ctx.rest('GET', ['globals', 'settings', 'versions'], { query: { limit: 10 } }),
  },
  // ---- delete ---------------------------------------------------------------------------------
  {
    category: 'delete',
    name: 'DELETE /posts/:id',
    setup: createPost,
    run: (ctx, doc) => ctx.rest('DELETE', ['posts', String(doc.id)]),
  },
  {
    category: 'delete',
    name: 'DELETE /posts?where (bulk, 5)',
    setup: (ctx) => createPosts(ctx, 5),
    run: (ctx, ids) => ctx.rest('DELETE', ['posts'], { query: { where: { id: { in: ids } } } }),
  },
  // ---- globals --------------------------------------------------------------------------------
  {
    category: 'globals',
    name: 'GET /globals/settings',
    run: (ctx) => ctx.rest('GET', ['globals', 'settings']),
  },
  {
    category: 'globals',
    name: 'POST /globals/settings',
    setup: (_ctx, iteration) => iteration,
    run: (ctx, iteration) =>
      ctx.rest('POST', ['globals', 'settings'], { body: { postsPerPage: iteration % 50 } }),
  },
  // ---- auth -----------------------------------------------------------------------------------
  {
    category: 'auth',
    name: 'POST /users/login',
    isCountVariable: true,
    run: (ctx) => ctx.rest('POST', ['users', 'login'], { auth: false, body: ctx.credentials }),
  },
  {
    category: 'auth',
    name: 'GET /users/me',
    isCountVariable: true,
    run: (ctx) => ctx.rest('GET', ['users', 'me']),
  },
  {
    category: 'auth',
    name: 'POST /users/refresh-token',
    isCountVariable: true,
    run: (ctx) => ctx.rest('POST', ['users', 'refresh-token']),
  },
  {
    category: 'auth',
    name: 'POST /users/logout',
    run: (ctx) => ctx.rest('POST', ['users', 'logout']),
    // logging out ends the session the other scenarios send
    teardown: (ctx) => ctx.relogin(),
  },
  // ---- uploads --------------------------------------------------------------------------------
  {
    category: 'uploads',
    name: 'POST /media (multipart upload)',
    setup: (ctx) => {
      const file = ctx.textFile(`rest-upload-${ctx.nextIndex()}.txt`)
      const form = new FormData()
      form.append('file', new Blob([file.data], { type: file.mimetype }), file.name)
      form.append('_payload', JSON.stringify({ alt: 'rest upload' }))
      return form
    },
    run: (ctx, form) => ctx.rest('POST', ['media'], { body: form }),
    teardown: (ctx, _form, response) =>
      ctx.payload.delete({ collection: 'media', id: response.json.doc.id, overrideAccess: true }),
  },
  {
    category: 'uploads',
    name: 'GET /media',
    run: (ctx) => ctx.rest('GET', ['media'], { query: { limit: 20 } }),
  },
  // ---- custom endpoints -----------------------------------------------------------------------
  {
    category: 'custom-endpoints',
    name: 'GET /perf/ping (root, no payload call)',
    run: (ctx) => ctx.rest('GET', ['perf', 'ping']),
  },
  {
    category: 'custom-endpoints',
    name: 'POST /perf/echo (root, JSON body)',
    setup: (ctx) => freshPost(ctx),
    run: (ctx, data) => ctx.rest('POST', ['perf', 'echo'], { body: data }),
  },
  {
    category: 'custom-endpoints',
    name: 'GET /perf/latest-posts (root, find depth 1)',
    run: (ctx) => ctx.rest('GET', ['perf', 'latest-posts']),
  },
  {
    category: 'custom-endpoints',
    name: 'GET /posts/perf-stats (collection, count)',
    run: (ctx) => ctx.rest('GET', ['posts', 'perf-stats']),
  },
  {
    category: 'custom-endpoints',
    name: 'POST /posts/:id/touch (collection, update)',
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), revision: iteration }),
    run: (ctx, { id, revision }) =>
      ctx.rest('POST', ['posts', String(id), 'touch'], { query: { revision } }),
  },
  {
    category: 'custom-endpoints',
    name: 'GET /globals/settings/perf-summary (global, findGlobal)',
    run: (ctx) => ctx.rest('GET', ['globals', 'settings', 'perf-summary']),
  },
  // ---- meta -----------------------------------------------------------------------------------
  { category: 'meta', name: 'GET /access', run: (ctx) => ctx.rest('GET', ['access']) },
  {
    category: 'meta',
    name: 'POST /payload-preferences/:key',
    setup: (_ctx, iteration) => iteration,
    run: (ctx, iteration) =>
      ctx.rest('POST', ['payload-preferences', 'perf'], { body: { value: { iteration } } }),
  },
  {
    category: 'meta',
    name: 'GET /payload-preferences/:key',
    run: (ctx) => ctx.rest('GET', ['payload-preferences', 'perf']),
  },
]

/** GraphQL endpoint. */
const graphql = [
  {
    category: 'read',
    name: 'query Posts limit 10',
    run: (ctx) => ctx.graphql(`{ Posts(limit: 10) { totalDocs docs { id title views } } }`),
  },
  {
    category: 'read',
    name: 'query Posts limit 100',
    run: (ctx) => ctx.graphql(`{ Posts(limit: 100) { docs { id title views } } }`),
  },
  {
    category: 'read',
    name: 'query Posts with author',
    run: (ctx) => ctx.graphql(`{ Posts(limit: 10) { docs { id title author { id name } } } }`),
  },
  {
    category: 'read',
    name: 'query Posts where + sort',
    run: (ctx) =>
      ctx.graphql(
        `{ Posts(limit: 10, sort: "-views", where: { views: { greater_than: 5000 } }) { totalDocs docs { id views } } }`,
      ),
  },
  {
    category: 'read',
    name: 'query Post by id',
    setup: by,
    run: (ctx, id) =>
      ctx.graphql(
        `query ($id: ${ctx.idType}!) { Post(id: $id) { id title views author { name } } }`,
        { id },
      ),
  },
  {
    category: 'globals',
    name: 'query Setting',
    run: (ctx) => ctx.graphql(`{ Setting { siteName postsPerPage } }`),
  },
  {
    category: 'auth',
    name: 'query meUser',
    isCountVariable: true,
    run: (ctx) => ctx.graphql(`{ meUser { user { email } } }`),
  },
  {
    category: 'versions',
    name: 'query versionsPosts',
    isCountVariable: true,
    shapes: COMPLEX,
    run: (ctx) => ctx.graphql(`{ versionsPosts(limit: 10) { totalDocs docs { id } } }`),
  },
  {
    category: 'locale',
    name: 'query Posts locale de',
    shapes: COMPLEX,
    run: (ctx) =>
      ctx.graphql(`{ Posts(limit: 10, locale: de, fallbackLocale: en) { docs { id title } } }`),
  },
  {
    category: 'create',
    name: 'mutation createPost',
    setup: freshPost,
    run: (ctx, data) =>
      ctx.graphql(
        `mutation ($title: String!, $views: Float) { createPost(data: { title: $title, views: $views }) { id } }`,
        {
          title: data.title,
          views: data.views,
        },
      ),
    teardown: (ctx, _state, response) => deletePost(ctx, response.json.data.createPost.id),
  },
  {
    category: 'partial-update',
    name: 'mutation updatePost (one field)',
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), revision: iteration }),
    run: (ctx, { id, revision }) =>
      ctx.graphql(
        `mutation ($id: ${ctx.idType}!, $revision: Float) { updatePost(id: $id, data: { revision: $revision }) { id revision } }`,
        { id, revision },
      ),
  },
  {
    category: 'delete',
    name: 'mutation deletePost',
    setup: createPost,
    run: (ctx, doc) =>
      ctx.graphql(`mutation ($id: ${ctx.idType}!) { deletePost(id: $id) { title } }`, {
        id: doc.id,
      }),
  },
  {
    category: 'globals',
    name: 'mutation updateSetting',
    setup: (_ctx, iteration) => iteration,
    run: (ctx, iteration) =>
      ctx.graphql(
        `mutation ($n: Float) { updateSetting(data: { postsPerPage: $n }) { postsPerPage } }`,
        { n: iteration % 50 },
      ),
  },
]

/**
 * Scenarios that change stored data (or sessions). They run after every read-only scenario, so
 * reads see the seeded data whatever the iteration counts were.
 */
const isMutating = (scenario) =>
  /^(create|update|duplicate|delete|save|publish|restore|jobs|forgot|reset|unlock|login|mutation|POST|PATCH|DELETE)/i.test(
    scenario.name,
  )

const all = [
  ...local.map((scenario) => ({ ...scenario, surface: 'local' })),
  ...rest.map((scenario) => ({ ...scenario, surface: 'rest' })),
  ...graphql.map((scenario) => ({ ...scenario, surface: 'graphql' })),
].map((scenario) => ({ ...scenario, isMutating: isMutating(scenario) }))

export const scenarios = [...all.filter((s) => !s.isMutating), ...all.filter((s) => s.isMutating)]

export const categories = [
  'read',
  'create',
  'update',
  'partial-update',
  'locale',
  'versions',
  'delete',
  'globals',
  'auth',
  'uploads',
  'jobs',
  'validation',
  'custom-endpoints',
  'meta',
]

/**
 * A structural summary of a result that does not depend on generated ids or timestamps: object
 * keys (sorted), array lengths, the shape of the first element, and the values of pagination
 * counters. ts and rs must produce equal fingerprints for every scenario. `isCountVariable`
 * (scenarios whose counts depend on how many iterations earlier scenarios ran: version listings,
 * a user's sessions): lengths and counters are left out, the shape is kept.
 */
export const fingerprint = (value, depth = 0, options = {}) => {
  if (value === null || value === undefined) {
    return String(value)
  }
  if (Array.isArray(value)) {
    return {
      first: value.length > 0 && depth < 4 ? fingerprint(value[0], depth + 1, options) : null,
      length: options.isCountVariable ? 'array' : value.length,
    }
  }
  if (value instanceof Date) {
    return 'date'
  }
  if (typeof value === 'object') {
    if (depth >= 4) {
      return 'object'
    }
    const counters = ['totalDocs', 'totalPages', 'page', 'limit', 'hasNextPage', 'hasPrevPage']
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const isKept = options.isCountVariable
        ? ['status', 'valid']
        : [...counters, 'status', 'valid']
      // generated ids used as keys (e.g. `jobStatus` of jobs.runByID): ObjectIds and uuids
      const outKey = /^[0-9a-f]{24}$|^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(key) ? '<id>' : key
      out[outKey] = isKept.includes(key) ? value[key] : fingerprint(value[key], depth + 1, options)
    }
    return out
  }
  return typeof value
}
