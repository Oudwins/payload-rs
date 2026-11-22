/**
 * Every measured scenario of the performance suite. A scenario is
 *
 *   { name, surface, shapes?, setup?, run, teardown? }
 *
 * `run(ctx, state)` is the timed part; `setup(ctx, iteration)` (untimed) prepares what one
 * iteration consumes (e.g. the document a delete removes) and `teardown(ctx, state, result)`
 * (untimed) undoes what it produced (e.g. deletes a created document), so the collection size stays
 * the measured size. `shapes` limits a scenario to some config shapes.
 *
 * Surfaces:
 * - `local`    the Local API (`payload.*`)
 * - `rest`     the REST endpoints, through `@payloadcms/next/routes` (the handlers a Next app mounts
 *              under /api), called in-process with Fetch `Request`s
 * - `graphql`  the GraphQL endpoint (`GRAPHQL_POST`), in-process
 * - `startup`  (run.mjs) import + `getPayload` in fresh processes
 *
 * Hooks and validation are measured through the `hooks` / `complex` config shapes, whose documents
 * run every collection hook and field hook on every operation above.
 */
import { germanPostData, postData } from './configs.mjs'

const by = (ctx, iteration) => ctx.ids.posts[iteration % ctx.ids.posts.length]
const someIDs = (ctx, iteration, count) =>
  Array.from(
    { length: count },
    (_, offset) => ctx.ids.posts[(iteration * count + offset) % ctx.ids.posts.length],
  )
const freshPost = (ctx, iteration) =>
  postData({
    authorIDs: ctx.ids.authors,
    categoryIDs: ctx.ids.categories,
    index: 1_000_000 + ctx.nextIndex(),
    random: ctx.random,
    shape: ctx.shape,
  })
const deletePost = (ctx, id) =>
  ctx.payload.delete({ overrideAccess: true, collection: 'posts', id })

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

/** Local API: every collection, global, version and auth operation. */
const local = [
  {
    name: 'find limit 10',
    run: (ctx) =>
      ctx.payload.find({ overrideAccess: true, collection: 'posts', depth: 0, limit: 10 }),
  },
  {
    name: 'find limit 100',
    run: (ctx) =>
      ctx.payload.find({ overrideAccess: true, collection: 'posts', depth: 0, limit: 100 }),
  },
  {
    name: 'find limit 10 depth 2',
    run: (ctx) =>
      ctx.payload.find({ overrideAccess: true, collection: 'posts', depth: 2, limit: 10 }),
  },
  {
    name: 'find where equals (indexed)',
    run: (ctx) =>
      ctx.payload.find({
        overrideAccess: true,
        collection: 'posts',
        depth: 0,
        limit: 10,
        where: { title: { equals: ctx.titles[0] } },
      }),
  },
  {
    name: 'find where like',
    run: (ctx) =>
      ctx.payload.find({
        overrideAccess: true,
        collection: 'posts',
        depth: 0,
        limit: 10,
        where: { title: { like: 'alpha' } },
      }),
  },
  {
    name: 'find where and/or + relationship path',
    run: (ctx) =>
      ctx.payload.find({
        collection: 'posts',
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
    name: 'find sort -views limit 50',
    run: (ctx) =>
      ctx.payload.find({
        overrideAccess: true,
        collection: 'posts',
        depth: 0,
        limit: 50,
        sort: '-views',
      }),
  },
  {
    name: 'find select title',
    run: (ctx) =>
      ctx.payload.find({
        overrideAccess: true,
        collection: 'posts',
        depth: 0,
        limit: 50,
        select: { title: true },
      }),
  },
  {
    name: 'find last page',
    run: (ctx) =>
      ctx.payload.find({
        overrideAccess: true,
        collection: 'posts',
        depth: 0,
        limit: 10,
        page: Math.max(1, Math.ceil(ctx.size / 10)),
      }),
  },
  {
    name: 'find all locales',
    shapes: ['complex'],
    run: (ctx) =>
      ctx.payload.find({
        overrideAccess: true,
        collection: 'posts',
        depth: 0,
        limit: 10,
        locale: 'all',
      }),
  },
  {
    name: 'find drafts',
    shapes: ['complex'],
    run: (ctx) =>
      ctx.payload.find({
        overrideAccess: true,
        collection: 'posts',
        depth: 0,
        draft: true,
        limit: 10,
      }),
  },
  {
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
    name: 'find authors with join',
    shapes: ['complex'],
    run: (ctx) =>
      ctx.payload.find({ overrideAccess: true, collection: 'authors', depth: 0, limit: 10 }),
  },
  { name: 'count', run: (ctx) => ctx.payload.count({ overrideAccess: true, collection: 'posts' }) },
  {
    name: 'count where',
    run: (ctx) =>
      ctx.payload.count({
        overrideAccess: true,
        collection: 'posts',
        where: { views: { greater_than: 5000 } },
      }),
  },
  {
    name: 'findByID depth 0',
    run: (ctx, state) =>
      ctx.payload.findByID({ overrideAccess: true, collection: 'posts', depth: 0, id: state }),
    setup: by,
  },
  {
    name: 'findByID depth 2',
    run: (ctx, state) =>
      ctx.payload.findByID({ overrideAccess: true, collection: 'posts', depth: 2, id: state }),
    setup: by,
  },
  {
    name: 'findDistinct author',
    run: (ctx) =>
      ctx.payload.findDistinct({
        overrideAccess: true,
        collection: 'posts',
        field: 'author',
        limit: 20,
      }),
  },
  {
    name: 'create',
    setup: freshPost,
    run: (ctx, data) => ctx.payload.create({ overrideAccess: true, collection: 'posts', data }),
    teardown: (ctx, _state, result) => deletePost(ctx, result.id),
  },
  {
    name: 'validate (no write)',
    setup: freshPost,
    run: (ctx, data) => ctx.payload.validate({ overrideAccess: true, collection: 'posts', data }),
  },
  {
    name: 'update by id',
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), views: iteration }),
    run: (ctx, { id, views }) =>
      ctx.payload.update({ overrideAccess: true, collection: 'posts', data: { views }, id }),
  },
  {
    name: 'update by id (de locale)',
    shapes: ['complex'],
    setup: (ctx, iteration) => ({ id: by(ctx, iteration) }),
    run: (ctx, { id }) =>
      ctx.payload.update({
        overrideAccess: true,
        collection: 'posts',
        data: germanPostData({ random: ctx.random }),
        id,
        locale: 'de',
      }),
  },
  {
    name: 'update many (10 by where)',
    setup: (ctx, iteration) => ({ ids: someIDs(ctx, iteration, 10), views: iteration }),
    run: (ctx, { ids, views }) =>
      ctx.payload.update({
        overrideAccess: true,
        collection: 'posts',
        data: { views },
        where: { id: { in: ids } },
      }),
  },
  {
    name: 'delete by id',
    setup: (ctx, iteration) =>
      ctx.payload.create({
        overrideAccess: true,
        collection: 'posts',
        data: freshPost(ctx, iteration),
      }),
    run: (ctx, doc) => deletePost(ctx, doc.id),
  },
  {
    name: 'delete many (5 by where)',
    setup: async (ctx, iteration) => {
      const created = []
      for (let index = 0; index < 5; index++) {
        created.push(
          (
            await ctx.payload.create({
              overrideAccess: true,
              collection: 'posts',
              data: freshPost(ctx, iteration),
            })
          ).id,
        )
      }
      return created
    },
    run: (ctx, ids) =>
      ctx.payload.delete({ overrideAccess: true, collection: 'posts', where: { id: { in: ids } } }),
  },
  {
    name: 'duplicate',
    setup: by,
    run: (ctx, id) => ctx.payload.duplicate({ overrideAccess: true, collection: 'posts', id }),
    teardown: (ctx, _state, result) => deletePost(ctx, result.id),
  },
  {
    name: 'findVersions',
    isCountVariable: true,
    shapes: ['complex'],
    setup: by,
    run: (ctx, id) =>
      ctx.payload.findVersions({
        overrideAccess: true,
        collection: 'posts',
        limit: 10,
        where: { parent: { equals: id } },
      }),
  },
  {
    name: 'restoreVersion',
    shapes: ['complex'],
    setup: async (ctx, iteration) => {
      const { docs } = await ctx.payload.findVersions({
        collection: 'posts',
        limit: 1,
        where: { parent: { equals: by(ctx, iteration) } },
      })
      return docs[0].id
    },
    run: (ctx, versionID) =>
      ctx.payload.restoreVersion({ overrideAccess: true, collection: 'posts', id: versionID }),
  },
  {
    name: 'countVersions',
    isCountVariable: true,
    shapes: ['complex'],
    setup: by,
    run: (ctx, id) =>
      ctx.payload.countVersions({
        collection: 'posts',
        overrideAccess: true,
        where: { parent: { equals: id } },
      }),
  },
  {
    name: 'findVersionByID',
    shapes: ['complex'],
    setup: async (ctx, iteration) => (await latestVersion(ctx, by(ctx, iteration))).id,
    run: (ctx, id) =>
      ctx.payload.findVersionByID({ collection: 'posts', id, overrideAccess: true }),
  },
  {
    name: 'findGlobalVersions',
    isCountVariable: true,
    shapes: ['complex'],
    run: (ctx) =>
      ctx.payload.findGlobalVersions({ limit: 10, overrideAccess: true, slug: 'settings' }),
  },
  {
    name: 'restoreGlobalVersion',
    shapes: ['complex'],
    setup: async (ctx) =>
      (await ctx.payload.findGlobalVersions({ limit: 1, overrideAccess: true, slug: 'settings' }))
        .docs[0].id,
    run: (ctx, id) =>
      ctx.payload.restoreGlobalVersion({ id, overrideAccess: true, slug: 'settings' }),
  },
  {
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
    name: 'find uploads',
    run: (ctx) => ctx.payload.find({ collection: 'media', limit: 20, overrideAccess: true }),
  },
  {
    name: 'jobs queue',
    setup: (_ctx, iteration) => iteration,
    run: (ctx, n) =>
      ctx.payload.jobs.queue({ input: { n }, overrideAccess: true, task: 'perfTask' }),
    teardown: (ctx, _n, job) =>
      ctx.payload.delete({ collection: 'payload-jobs', id: job.id, overrideAccess: true }),
  },
  {
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
  {
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
    name: 'unlock',
    run: (ctx) =>
      ctx.payload.unlock({
        collection: 'users',
        data: { email: ctx.credentials.email },
        overrideAccess: true,
      }),
  },
  {
    name: 'findGlobal',
    run: (ctx) => ctx.payload.findGlobal({ overrideAccess: true, slug: 'settings' }),
  },
  {
    name: 'updateGlobal',
    setup: (_ctx, iteration) => iteration,
    run: (ctx, iteration) =>
      ctx.payload.updateGlobal({
        overrideAccess: true,
        data: { postsPerPage: iteration % 50 },
        slug: 'settings',
      }),
  },
  {
    name: 'login',
    run: (ctx) => ctx.payload.login({ collection: 'users', data: ctx.credentials }),
  },
  { name: 'auth (JWT)', run: (ctx) => ctx.payload.auth({ headers: ctx.authHeaders() }) },
]

/** REST endpoints (`/api/...`). */
const rest = [
  {
    name: 'GET /posts limit 10',
    run: (ctx) => ctx.rest('GET', ['posts'], { query: { depth: 0, limit: 10 } }),
  },
  {
    name: 'GET /posts limit 10 depth 2',
    run: (ctx) => ctx.rest('GET', ['posts'], { query: { depth: 2, limit: 10 } }),
  },
  {
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
    name: 'GET /posts/:id',
    setup: by,
    run: (ctx, id) => ctx.rest('GET', ['posts', String(id)], { query: { depth: 1 } }),
  },
  { name: 'GET /posts/count', run: (ctx) => ctx.rest('GET', ['posts', 'count']) },
  {
    name: 'POST /posts',
    setup: freshPost,
    run: (ctx, data) => ctx.rest('POST', ['posts'], { body: data }),
    teardown: async (ctx, _state, response) => deletePost(ctx, response.json.doc.id),
  },
  {
    name: 'PATCH /posts/:id',
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), views: iteration }),
    run: (ctx, { id, views }) => ctx.rest('PATCH', ['posts', String(id)], { body: { views } }),
  },
  {
    name: 'DELETE /posts/:id',
    setup: (ctx, iteration) =>
      ctx.payload.create({
        overrideAccess: true,
        collection: 'posts',
        data: freshPost(ctx, iteration),
      }),
    run: (ctx, doc) => ctx.rest('DELETE', ['posts', String(doc.id)]),
  },
  {
    name: 'GET /posts/versions',
    isCountVariable: true,
    shapes: ['complex'],
    run: (ctx) => ctx.rest('GET', ['posts', 'versions'], { query: { limit: 10 } }),
  },
  {
    name: 'GET /posts/versions/:id',
    shapes: ['complex'],
    setup: async (ctx, iteration) => (await latestVersion(ctx, by(ctx, iteration))).id,
    run: (ctx, id) => ctx.rest('GET', ['posts', 'versions', String(id)]),
  },
  {
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
  { name: 'GET /media', run: (ctx) => ctx.rest('GET', ['media'], { query: { limit: 20 } }) },
  {
    name: 'POST /payload-preferences/:key',
    setup: (_ctx, iteration) => iteration,
    run: (ctx, iteration) =>
      ctx.rest('POST', ['payload-preferences', 'perf'], { body: { value: { iteration } } }),
  },
  {
    name: 'GET /payload-preferences/:key',
    run: (ctx) => ctx.rest('GET', ['payload-preferences', 'perf']),
  },
  { name: 'GET /globals/settings', run: (ctx) => ctx.rest('GET', ['globals', 'settings']) },
  {
    name: 'POST /users/login',
    run: (ctx) => ctx.rest('POST', ['users', 'login'], { auth: false, body: ctx.credentials }),
  },
  { name: 'GET /users/me', run: (ctx) => ctx.rest('GET', ['users', 'me']) },
  { name: 'POST /users/refresh-token', run: (ctx) => ctx.rest('POST', ['users', 'refresh-token']) },
  { name: 'GET /access', run: (ctx) => ctx.rest('GET', ['access']) },
]

/** GraphQL endpoint. */
const graphql = [
  {
    name: 'query Posts limit 10',
    run: (ctx) => ctx.graphql(`{ Posts(limit: 10) { totalDocs docs { id title views } } }`),
  },
  {
    name: 'query Posts with author',
    run: (ctx) => ctx.graphql(`{ Posts(limit: 10) { docs { id title author { id name } } } }`),
  },
  {
    name: 'query Post by id',
    setup: by,
    run: (ctx, id) =>
      ctx.graphql(
        `query ($id: ${ctx.idType}!) { Post(id: $id) { id title views author { name } } }`,
        { id },
      ),
  },
  {
    name: 'mutation updatePost',
    setup: (ctx, iteration) => ({ id: by(ctx, iteration), views: iteration }),
    run: (ctx, { id, views }) =>
      ctx.graphql(
        `mutation ($id: ${ctx.idType}!, $views: Float) { updatePost(id: $id, data: { views: $views }) { id views } }`,
        {
          id,
          views,
        },
      ),
  },
  {
    name: 'query versionsPosts',
    isCountVariable: true,
    shapes: ['complex'],
    run: (ctx) => ctx.graphql(`{ versionsPosts(limit: 10) { totalDocs docs { id } } }`),
  },
  {
    name: 'mutation createPost',
    setup: (ctx, iteration) => freshPost(ctx, iteration),
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
]

export const scenarios = [
  ...local.map((scenario) => ({ ...scenario, surface: 'local' })),
  ...rest.map((scenario) => ({ ...scenario, surface: 'rest' })),
  ...graphql.map((scenario) => ({ ...scenario, surface: 'graphql' })),
]

/**
 * A structural summary of a result that does not depend on generated ids or timestamps: object
 * keys (sorted), array lengths, the shape of the first element, and the values of pagination
 * counters. ts and rs must produce equal fingerprints for every scenario. `isCountVariable`
 * (scenarios listing versions, whose number depends on how many updates earlier scenarios made):
 * lengths and counters are left out, the shape is kept.
 */
export const fingerprint = (value, depth = 0, options = {}) => {
  if (value === null || value === undefined) {
    return String(value)
  }
  if (Array.isArray(value)) {
    return {
      length: options.isCountVariable ? 'array' : value.length,
      first: value.length > 0 && depth < 4 ? fingerprint(value[0], depth + 1, options) : null,
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
