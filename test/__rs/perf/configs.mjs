/**
 * Payload configs of the performance suite and their seed data (plain JS: runs in the installed
 * perf app, see run.mjs). Every config shape has a `posts` collection (the one whose size varies),
 * `authors`, `categories`, an auth collection `users` and a `settings` global, so every scenario
 * runs on every shape; the shapes differ in what a document carries and what runs around it:
 *
 * - `minimal`  flat posts (title, views), no hooks, no relationships beyond `author`
 * - `typical`  a blog: rich text (lexical), select / date / checkbox, unique slug, author and
 *              hasMany categories, an array, a group
 * - `complex`  typical plus localization (en / de / fr), versions with drafts, blocks with nested
 *              arrays, tabs, a join field (authors -> posts), access control returning query
 *              constraints, field-level access and custom validation
 * - `hooks`    typical with every collection hook and beforeValidate / beforeChange / afterChange /
 *              afterRead field hooks on every field (cheap, mostly synchronous transforms)
 * - `wide-<n>` (startup only) n collections of typical posts fields
 *
 * Seed data is deterministic (a seeded PRNG): ts and rs runs see the same documents.
 */

export const configShapes = ['minimal', 'typical', 'complex', 'hooks']

/** `wide-10` etc.: startup-only shapes. */
export const isWideShape = (shape) => /^wide-\d+$/.test(shape)

export const richText = (text) => ({
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        textFormat: 0,
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
})

/** mulberry32: a small seeded PRNG, so seed data is identical between processes. */
export const createRandom = (seed) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const words = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
  'quebec',
  'romeo',
  'sierra',
  'tango',
]
const statuses = ['draft', 'review', 'published', 'archived']

const pick = (random, list) => list[Math.floor(random() * list.length)]
const sentence = (random, count) =>
  Array.from({ length: count }, () => pick(random, words)).join(' ')

/**
 * The `buildConfig` input for `shape`. `editor`: the lexical editor (imported by the caller from
 * the installed richtext-lexical). `hookCounter` counts hook invocations (reported per scenario so
 * ts and rs can be compared). `uploadDir`: the `media` collection's static dir.
 */
export const buildConfigInput = ({ db, editor, hookCounter, shape, uploadDir }) => {
  if (isWideShape(shape)) {
    const count = Number(shape.slice('wide-'.length))
    return {
      ...base({ db, editor }),
      collections: [
        users(),
        authors({ shape: 'typical' }),
        categories(),
        media({ uploadDir }),
        // the first is `posts`: the settings global relates to it
        ...Array.from({ length: count }, (_, index) => ({
          slug: index === 0 ? 'posts' : `wide-${index}`,
          fields: postFields({ editor, shape: 'typical' }),
        })),
      ],
      globals: [settings({ shape: 'typical' })],
      jobs,
    }
  }
  const hooks = shape === 'hooks' ? collectionHooks(hookCounter) : undefined
  return {
    ...base({ db, editor }),
    collections: [
      users(),
      authors({ shape }),
      categories(),
      {
        slug: 'posts',
        access: postAccess(shape),
        endpoints: postEndpoints,
        hooks,
        versions: shape === 'complex' ? { drafts: true, maxPerDoc: 10 } : undefined,
        fields: withFieldHooks(
          postFields({ editor, shape }),
          shape === 'hooks' ? hookCounter : undefined,
        ),
      },
      media({ uploadDir }),
    ],
    globals: [settings({ shape })],
    jobs,
    localization:
      shape === 'complex'
        ? { defaultLocale: 'en', fallback: true, locales: ['en', 'de', 'fr'] }
        : undefined,
  }
}

const base = ({ db, editor }) => ({
  admin: { disable: true },
  db,
  editor,
  endpoints: rootEndpoints,
  graphQL: { disablePlaygroundInProduction: true },
  secret: 'payload-perf-suite-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})

const users = () => ({
  slug: 'users',
  access: { read: () => true },
  auth: true,
  fields: [{ name: 'name', type: 'text' }],
})

const authors = ({ shape }) => ({
  slug: 'authors',
  access: { create: () => true, read: () => true, update: () => true },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'bio', type: 'textarea', localized: shape === 'complex' },
    ...(shape === 'complex'
      ? [{ name: 'posts', type: 'join', collection: 'posts', on: 'author', defaultLimit: 10 }]
      : []),
  ],
})

const categories = () => ({
  slug: 'categories',
  access: { read: () => true },
  fields: [{ name: 'title', type: 'text', required: true }],
})

const media = ({ uploadDir }) => ({
  slug: 'media',
  access: { create: () => true, delete: () => true, read: () => true, update: () => true },
  fields: [{ name: 'alt', type: 'text' }],
  upload: { staticDir: uploadDir },
})

/** One task, queued and run by the jobs scenarios. */
const jobs = {
  tasks: [
    {
      slug: 'perfTask',
      handler: ({ input }) => ({ output: { doubled: input.n * 2 } }),
      inputSchema: [{ name: 'n', type: 'number', required: true }],
      outputSchema: [{ name: 'doubled', type: 'number' }],
    },
  ],
}

/**
 * Custom endpoints (a user's own API surface): they run payload operations through `req.payload`,
 * so the engine serves them like any built-in endpoint.
 */
const postEndpoints = [
  {
    handler: async (req) => {
      const { totalDocs } = await req.payload.count({ collection: 'posts', overrideAccess: true })
      return Response.json({ totalDocs })
    },
    method: 'get',
    path: '/perf-stats',
  },
  {
    handler: async (req) => {
      const doc = await req.payload.update({
        collection: 'posts',
        data: { revision: Number(req.searchParams?.get('revision') ?? 0) },
        id: req.routeParams.id,
        overrideAccess: true,
        req,
      })
      return Response.json({ id: doc.id, revision: doc.revision })
    },
    method: 'post',
    path: '/:id/touch',
  },
]

const rootEndpoints = [
  { handler: () => Response.json({ ok: true }), method: 'get', path: '/perf/ping' },
  {
    handler: async (req) => Response.json({ received: await req.json() }),
    method: 'post',
    path: '/perf/echo',
  },
  {
    handler: async (req) => {
      const { docs } = await req.payload.find({
        collection: 'posts',
        depth: 1,
        limit: 10,
        overrideAccess: true,
        req,
      })
      return Response.json({ titles: docs.map((doc) => doc.title) })
    },
    method: 'get',
    path: '/perf/latest-posts',
  },
]

const settings = ({ shape }) => ({
  slug: 'settings',
  access: { read: () => true, readVersions: () => true, update: () => true },
  endpoints: [
    {
      handler: async (req) =>
        Response.json(
          await req.payload.findGlobal({ overrideAccess: true, req, slug: 'settings' }),
        ),
      method: 'get',
      path: '/perf-summary',
    },
  ],
  versions: shape === 'complex' ? { max: 50 } : undefined,
  fields: [
    { name: 'siteName', type: 'text' },
    { name: 'postsPerPage', type: 'number' },
    { name: 'featured', type: 'relationship', relationTo: 'posts' },
  ],
})

/** `complex`: query-constraint read / update access and a create check, like real apps. */
const postAccess = (shape) =>
  shape === 'complex'
    ? {
        create: ({ req }) => Boolean(req.user),
        delete: () => true,
        read: () => ({ stage: { not_equals: 'archived' } }),
        update: () => ({ views: { greater_than_equal: 0 } }),
      }
    : { create: () => true, delete: () => true, read: () => true, update: () => true }

const postFields = ({ editor, shape }) => {
  const isLocalized = shape === 'complex'
  const fields = [
    { name: 'title', type: 'text', index: true, localized: isLocalized, required: true },
    { name: 'views', type: 'number', defaultValue: 0 },
    // what the update scenarios write: no scenario filters or sorts on it, so reads see the same
    // documents however many updates ran
    { name: 'revision', type: 'number', defaultValue: 0 },
    { name: 'author', type: 'relationship', relationTo: 'authors' },
  ]
  if (shape === 'minimal') {
    return fields
  }
  fields.push(
    { name: 'slug', type: 'text', index: true, unique: true },
    { name: 'excerpt', type: 'textarea', localized: isLocalized },
    { name: 'content', type: 'richText', editor, localized: isLocalized },
    {
      name: 'stage',
      type: 'select',
      defaultValue: 'draft',
      index: true,
      options: statuses.map((value) => ({ label: value, value })),
    },
    { name: 'publishedAt', type: 'date', index: true },
    { name: 'featured', type: 'checkbox', defaultValue: false },
    { name: 'categories', type: 'relationship', hasMany: true, relationTo: 'categories' },
    { name: 'tags', type: 'array', fields: [{ name: 'tag', type: 'text' }] },
    {
      name: 'seo',
      type: 'group',
      fields: [
        { name: 'title', type: 'text', localized: isLocalized },
        { name: 'description', type: 'textarea', localized: isLocalized },
      ],
    },
  )
  if (shape === 'complex') {
    fields.push({
      type: 'tabs',
      tabs: [
        {
          label: 'Layout',
          fields: [
            {
              name: 'layout',
              type: 'blocks',
              blocks: [
                {
                  slug: 'hero',
                  fields: [
                    { name: 'heading', type: 'text', localized: true },
                    { name: 'subheading', type: 'textarea' },
                  ],
                },
                { slug: 'content', fields: [{ name: 'body', type: 'richText', editor }] },
                {
                  slug: 'gallery',
                  fields: [
                    {
                      name: 'items',
                      type: 'array',
                      fields: [
                        { name: 'caption', type: 'text' },
                        { name: 'credit', type: 'group', fields: [{ name: 'name', type: 'text' }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          name: 'meta',
          label: 'Meta',
          fields: [
            {
              name: 'internalNote',
              type: 'text',
              access: { read: ({ req }) => Boolean(req.user) },
            },
            {
              name: 'rating',
              type: 'number',
              max: 5,
              min: 0,
              validate: (value) =>
                value === undefined ||
                value === null ||
                Number.isInteger(value) ||
                'whole numbers only',
            },
          ],
        },
      ],
    })
  }
  return fields
}

/** `hooks`: every collection hook, each counted. */
const collectionHooks = (hookCounter) => {
  const count = (name) => hookCounter && (hookCounter[name] = (hookCounter[name] ?? 0) + 1)
  return {
    afterChange: [({ doc }) => (count('afterChange'), doc)],
    // returns the document: a truthy return value replaces the deleted document in the result
    afterDelete: [({ doc }) => (count('afterDelete'), doc)],
    afterOperation: [({ result }) => (count('afterOperation'), result)],
    afterRead: [({ doc }) => (count('afterRead'), doc)],
    beforeChange: [({ data }) => (count('beforeChange'), data)],
    beforeDelete: [() => count('beforeDelete')],
    beforeOperation: [({ args }) => (count('beforeOperation'), args)],
    beforeRead: [({ doc }) => (count('beforeRead'), doc)],
    beforeValidate: [
      async ({ data }) => {
        count('beforeValidate')
        await Promise.resolve()
        return data
      },
    ],
  }
}

/** `hooks`: field hooks on every named field, recursively (arrays / groups). */
const withFieldHooks = (fields, hookCounter) => {
  if (!hookCounter) {
    return fields
  }
  const count = (name) => (hookCounter[name] = (hookCounter[name] ?? 0) + 1)
  return fields.map((field) => {
    const nested = field.fields ? { fields: withFieldHooks(field.fields, hookCounter) } : {}
    if (!field.name || field.type === 'join') {
      return { ...field, ...nested }
    }
    return {
      ...field,
      ...nested,
      hooks: {
        afterChange: [({ value }) => (count('field.afterChange'), value)],
        afterRead: [({ value }) => (count('field.afterRead'), value)],
        beforeChange: [({ value }) => (count('field.beforeChange'), value)],
        beforeValidate: [
          ({ value }) => (
            count('field.beforeValidate'),
            typeof value === 'string' ? value.trim() : value
          ),
        ],
      },
    }
  })
}

/** Deterministic post data number `index` for `shape` (ids of authors / categories passed in). */
export const postData = ({ authorIDs, categoryIDs, index, random, shape }) => {
  const data = {
    title: `${sentence(random, 3)} ${index}`,
    views: Math.floor(random() * 10_000),
    author: authorIDs[index % authorIDs.length],
  }
  if (shape === 'minimal') {
    return data
  }
  Object.assign(data, {
    slug: `post-${index}`,
    excerpt: sentence(random, 12),
    content: richText(sentence(random, 30)),
    stage: statuses[index % statuses.length],
    publishedAt: new Date(Date.UTC(2024, 0, 1) + index * 3_600_000).toISOString(),
    featured: index % 7 === 0,
    categories: [
      categoryIDs[index % categoryIDs.length],
      categoryIDs[(index * 3 + 1) % categoryIDs.length],
    ],
    tags: Array.from({ length: 3 }, () => ({ tag: pick(random, words) })),
    seo: { title: sentence(random, 4), description: sentence(random, 10) },
  })
  if (shape === 'complex') {
    Object.assign(data, {
      layout: [
        { blockType: 'hero', heading: sentence(random, 3), subheading: sentence(random, 8) },
        { blockType: 'content', body: richText(sentence(random, 20)) },
        {
          blockType: 'gallery',
          items: Array.from({ length: 3 }, () => ({
            caption: sentence(random, 4),
            credit: { name: pick(random, words) },
          })),
        },
      ],
      meta: { internalNote: sentence(random, 5), rating: index % 6 },
    })
  }
  return data
}

/** Localized values the complex shape writes for `de` after creating in `en`. */
export const germanPostData = ({ random }) => ({
  title: `de ${sentence(random, 3)}`,
  excerpt: sentence(random, 8),
  seo: { title: `de ${sentence(random, 3)}` },
})

export const authorCount = (size) => Math.max(10, Math.floor(size / 20))
export const categoryCount = 20
