/**
 * Local API scenario run inside the packed temp app by `run.mjs` (copied next to the app's
 * package.json so `payload` & co. resolve from the installed tarballs only).
 *
 *   node scenario.mjs sqlite <sqlite file> <out.json>
 *   node scenario.mjs mongodb <mongodb url> <out.json>     (the database is dropped at the end)
 *
 * Covers create / find / findByID / update / delete / count / duplicate with collection and field
 * hooks, localization (en/de, `locale: 'all'`, fallback), drafts and versions, relationships
 * (depth 0/1, a global pointing at a collection), lexical rich text, auth (create, login, `auth`
 * with the token and its permissions), access control (`overrideAccess: false` with and without a
 * user, query-constraint read access) and validation errors. Every step's result or thrown error
 * is recorded in order with the step's start / finish time (`windows`), plus the hook log. Also
 * records every module URL this process resolved, so `run.mjs` can prove that nothing was loaded
 * from the monorepo and which engine modules ran.
 */
import { registerHooks } from 'node:module'

const resolvedURLs = new Set()
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    resolvedURLs.add(result.url)
    return result
  },
})

const [database, location, outFile] = process.argv.slice(2)
if (!['mongodb', 'sqlite'].includes(database) || !location || !outFile) {
  throw new Error('usage: node scenario.mjs sqlite|mongodb <sqlite file | mongodb url> <out.json>')
}

const { writeFileSync } = await import('node:fs')
const { buildConfig, getPayload } = await import('payload')
const { lexicalEditor } = await import('@payloadcms/richtext-lexical')
const db =
  database === 'sqlite'
    ? (await import('@payloadcms/db-sqlite')).sqliteAdapter({ client: { url: `file:${location}` } })
    : (await import('@payloadcms/db-mongodb')).mongooseAdapter({
        ensureIndexes: true,
        url: location,
      })

const hookLog = []
const log = (entry) => hookLog.push({ entry, step: steps.length })

const richText = (text) => ({
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

const config = buildConfig({
  collections: [
    {
      slug: 'users',
      auth: true,
      fields: [{ name: 'name', type: 'text' }],
    },
    {
      // read access is a query constraint, so access-filtered find / count / findByID run
      slug: 'notes',
      access: {
        create: ({ req }) => Boolean(req.user),
        delete: () => false,
        read: ({ req }) => (req.user ? { owner: { equals: req.user.id } } : false),
        update: ({ req }) => (req.user ? { owner: { equals: req.user.id } } : false),
      },
      fields: [
        { name: 'body', type: 'text', required: true },
        {
          name: 'owner',
          type: 'relationship',
          relationTo: 'users',
          hooks: { beforeChange: [({ req, value }) => value ?? req.user?.id] },
        },
        {
          name: 'secret',
          type: 'text',
          access: { read: ({ req }) => req.user?.name === 'Grace' },
        },
      ],
    },
    {
      slug: 'authors',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'bio', type: 'textarea', localized: true },
      ],
    },
    {
      slug: 'posts',
      versions: { drafts: true, maxPerDoc: 5 },
      hooks: {
        beforeChange: [
          ({ data, operation, originalDoc }) => {
            log({ hook: 'collection.beforeChange', operation, id: originalDoc?.id ?? null })
            return { ...data, revision: (originalDoc?.revision ?? 0) + 1 }
          },
        ],
        afterChange: [
          ({ doc, operation }) => {
            log({ hook: 'collection.afterChange', operation, id: doc.id, title: doc.title })
            return doc
          },
        ],
        afterRead: [
          ({ doc }) => {
            doc.readMarker = `read:${doc.id}`
            return doc
          },
        ],
        afterDelete: [({ id }) => log({ hook: 'collection.afterDelete', id })],
      },
      fields: [
        {
          name: 'title',
          type: 'text',
          localized: true,
          required: true,
          hooks: {
            beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
            afterRead: [({ value }) => (typeof value === 'string' ? `${value}!` : value)],
          },
        },
        {
          name: 'slug',
          type: 'text',
          index: true,
          hooks: {
            beforeChange: [
              ({ siblingData, value }) =>
                value ??
                (typeof siblingData.title === 'string'
                  ? siblingData.title.toLowerCase().replaceAll(' ', '-')
                  : value),
            ],
          },
        },
        { name: 'revision', type: 'number', defaultValue: 0 },
        { name: 'author', type: 'relationship', relationTo: 'authors' },
        {
          name: 'related',
          type: 'relationship',
          relationTo: ['authors', 'posts'],
          hasMany: true,
        },
        {
          name: 'tags',
          type: 'array',
          fields: [{ name: 'tag', type: 'text', localized: true }],
        },
        { name: 'content', type: 'richText' },
        {
          name: 'category',
          type: 'select',
          options: ['news', 'opinion'],
          defaultValue: 'news',
        },
        {
          name: 'meta',
          type: 'group',
          fields: [
            { name: 'description', type: 'text', localized: true },
            {
              name: 'score',
              type: 'number',
              validate: (value) => (value == null || value >= 0 ? true : 'score must be >= 0'),
            },
          ],
        },
      ],
    },
  ],
  globals: [
    {
      slug: 'settings',
      fields: [
        { name: 'siteName', type: 'text', localized: true },
        { name: 'featured', type: 'relationship', relationTo: 'posts' },
      ],
    },
  ],
  db,
  editor: lexicalEditor(),
  localization: { defaultLocale: 'en', fallback: true, locales: ['en', 'de'] },
  secret: 'packaging-scenario-secret',
  telemetry: false,
})

const steps = []
const windows = []
const step = async (name, run) => {
  const stepStartedAt = Date.now()
  try {
    steps.push({ name, value: await run() })
  } catch (error) {
    steps.push({ name, error: describeError(error) })
  }
  windows.push([stepStartedAt, Date.now()])
}

const startedAt = Date.now()
const payload = await getPayload({ config })

let author
let post
let second
let user

await step('create author', async () => {
  author = await payload.create({
    overrideAccess: true,
    collection: 'authors',
    data: { bio: 'Writes things', name: 'Ada' },
  })
  return author
})
await step('update author bio (de)', () =>
  payload.update({
    overrideAccess: true,
    collection: 'authors',
    id: author.id,
    data: { bio: 'Schreibt Dinge' },
    locale: 'de',
  }),
)
await step('create post (en)', async () => {
  post = await payload.create({
    overrideAccess: true,
    collection: 'posts',
    data: {
      author: author.id,
      content: richText('Hello rich text'),
      meta: { description: 'first', score: 3 },
      tags: [{ tag: 'alpha' }, { tag: 'beta' }],
      title: '  Hello World  ',
    },
  })
  return post
})
await step('update post (de)', () =>
  payload.update({
    overrideAccess: true,
    collection: 'posts',
    id: post.id,
    data: {
      meta: { description: 'erste' },
      tags: [
        { id: post.tags[0].id, tag: 'alpha-de' },
        { id: post.tags[1].id, tag: 'beta-de' },
      ],
      title: 'Hallo Welt',
    },
    locale: 'de',
  }),
)
await step('create second post with polymorphic hasMany', async () => {
  second = await payload.create({
    overrideAccess: true,
    collection: 'posts',
    data: {
      category: 'opinion',
      related: [
        { relationTo: 'authors', value: author.id },
        { relationTo: 'posts', value: post.id },
      ],
      title: 'Second post',
    },
  })
  return second
})
await step('findByID locale all depth 1', () =>
  payload.findByID({
    overrideAccess: true,
    collection: 'posts',
    id: post.id,
    depth: 1,
    locale: 'all',
  }),
)
await step('findByID de fallback', () =>
  payload.findByID({
    overrideAccess: true,
    collection: 'posts',
    id: second.id,
    depth: 0,
    locale: 'de',
  }),
)
await step('find where/sort/limit depth 1', () =>
  payload.find({
    overrideAccess: true,
    collection: 'posts',
    depth: 1,
    limit: 1,
    page: 2,
    sort: '-title',
    where: { or: [{ title: { like: 'hello' } }, { category: { equals: 'opinion' } }] },
  }),
)
await step('find where relationship + select', () =>
  payload.find({
    overrideAccess: true,
    collection: 'posts',
    depth: 0,
    select: { slug: true, author: true, title: true },
    where: { 'author.name': { equals: 'Ada' } },
  }),
)
await step('save draft', () =>
  payload.update({
    overrideAccess: true,
    collection: 'posts',
    id: post.id,
    data: { title: 'Draft title' },
    draft: true,
  }),
)
await step('findByID published (no draft)', () =>
  payload.findByID({ overrideAccess: true, collection: 'posts', id: post.id, depth: 0 }),
)
await step('findByID draft', () =>
  payload.findByID({
    overrideAccess: true,
    collection: 'posts',
    id: post.id,
    depth: 0,
    draft: true,
  }),
)
await step('findVersions', () =>
  payload.findVersions({
    overrideAccess: true,
    collection: 'posts',
    depth: 0,
    sort: 'createdAt',
    where: { parent: { equals: post.id } },
  }),
)
await step('publish', () =>
  payload.update({
    overrideAccess: true,
    collection: 'posts',
    id: post.id,
    data: { _status: 'published' },
  }),
)
await step('countVersions', () =>
  payload.countVersions({ overrideAccess: true, collection: 'posts' }),
)
await step('count', () =>
  payload.count({
    overrideAccess: true,
    collection: 'posts',
    where: { category: { equals: 'news' } },
  }),
)
await step('validation error (required title)', () =>
  payload.create({ overrideAccess: true, collection: 'posts', data: { title: '' } }),
)
await step('validation error (custom validate)', () =>
  payload.update({
    overrideAccess: true,
    collection: 'posts',
    id: post.id,
    data: { meta: { score: -1 } },
  }),
)
await step('not found', () =>
  payload.findByID({ overrideAccess: true, collection: 'posts', id: 999_999 }),
)
await step('duplicate', () =>
  payload.duplicate({ overrideAccess: true, collection: 'posts', id: second.id, depth: 0 }),
)
await step('bulk update where', () =>
  payload.update({
    overrideAccess: true,
    collection: 'posts',
    data: { category: 'news' },
    where: { category: { equals: 'opinion' } },
  }),
)
await step('update global (en)', () =>
  payload.updateGlobal({
    overrideAccess: true,
    slug: 'settings',
    data: { featured: post.id, siteName: 'My site' },
  }),
)
await step('update global (de)', () =>
  payload.updateGlobal({
    overrideAccess: true,
    slug: 'settings',
    data: { siteName: 'Meine Seite' },
    locale: 'de',
  }),
)
await step('findGlobal locale all depth 1', () =>
  payload.findGlobal({ overrideAccess: true, slug: 'settings', depth: 1, locale: 'all' }),
)
await step('create user', async () => {
  user = await payload.create({
    overrideAccess: true,
    collection: 'users',
    data: { name: 'Grace', email: 'grace@example.com', password: 'correct horse' },
  })
  return user
})
await step('login', () =>
  payload.login({
    overrideAccess: true,
    collection: 'users',
    data: { email: 'grace@example.com', password: 'correct horse' },
  }),
)
let token
let otherUser
await step('auth with token (permissions)', async () => {
  const login = await payload.login({
    collection: 'users',
    data: { email: 'grace@example.com', password: 'correct horse' },
  })
  token = login.token
  return payload.auth({ headers: new Headers({ Authorization: `JWT ${token}` }) })
})
await step('create other user', async () => {
  otherUser = await payload.create({
    overrideAccess: true,
    collection: 'users',
    data: { name: 'Linus', email: 'linus@example.com', password: 'other horse' },
  })
  return otherUser
})
let note
await step('create note as user (access)', async () => {
  note = await payload.create({
    overrideAccess: false,
    collection: 'notes',
    data: { body: 'mine', secret: 'only grace' },
    user,
  })
  return note
})
await step('create note anonymous (access denied)', () =>
  payload.create({ overrideAccess: false, collection: 'notes', data: { body: 'anon' } }),
)
await step('create note as other user', () =>
  payload.create({
    overrideAccess: false,
    collection: 'notes',
    data: { body: 'theirs', secret: 'hidden from linus' },
    user: otherUser,
  }),
)
await step('find notes as user (read constraint)', () =>
  payload.find({ overrideAccess: false, collection: 'notes', depth: 0, user }),
)
await step('find notes as other user (field access)', () =>
  payload.find({ overrideAccess: false, collection: 'notes', depth: 0, user: otherUser }),
)
await step('count notes as user', () =>
  payload.count({ overrideAccess: false, collection: 'notes', user }),
)
await step('findByID note as other user (not found)', () =>
  payload.findByID({ overrideAccess: false, collection: 'notes', id: note.id, user: otherUser }),
)
await step('find notes anonymous (access denied)', () =>
  payload.find({ overrideAccess: false, collection: 'notes' }),
)
await step('update note as other user (no match)', () =>
  payload.update({
    overrideAccess: false,
    collection: 'notes',
    data: { body: 'stolen' },
    user: otherUser,
    where: { id: { equals: note.id } },
  }),
)
await step('delete note as user (access denied)', () =>
  payload.delete({ overrideAccess: false, collection: 'notes', id: note.id, user }),
)
await step('login wrong password', () =>
  payload.login({
    overrideAccess: true,
    collection: 'users',
    data: { email: 'grace@example.com', password: 'nope' },
  }),
)
await step('delete by id', () =>
  payload.delete({ overrideAccess: true, collection: 'posts', id: second.id }),
)
await step('delete where', () =>
  payload.delete({
    overrideAccess: true,
    collection: 'posts',
    where: { title: { like: 'Hello' } },
  }),
)
await step('find after deletes', () =>
  payload.find({ overrideAccess: true, collection: 'posts', depth: 0 }),
)
await step('delete author', () =>
  payload.delete({ overrideAccess: true, collection: 'authors', id: author.id }),
)
// MongoDB runs bulk operations' documents concurrently (`bulkOperationsSingleTransaction` is false
// there), so the hook order within one step is not deterministic upstream either: sorted there, by
// hook and document id (ObjectIds of one process sort in creation order).
await step('hook log', () => {
  const key = ({ entry }) => `${entry.hook}|${entry.operation}|${entry.id}`
  const ordered =
    database === 'mongodb'
      ? hookLog.toSorted(
          (a, b) => a.step - b.step || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0),
        )
      : hookLog
  return ordered.map(({ entry }) => entry)
})

const finishedAt = Date.now()
if (database === 'mongodb') {
  await payload.db.connection.dropDatabase()
}
await payload.destroy()

writeFileSync(
  outFile,
  JSON.stringify({
    finishedAt,
    resolvedURLs: [...resolvedURLs],
    startedAt,
    steps: steps.map((entry) => encode(entry)),
    windows,
  }),
)
process.exit(0)

function describeError(error) {
  if (!(error instanceof Error)) {
    return { thrown: error }
  }
  return {
    name: error.name,
    constructor: error.constructor?.name,
    data: error.data,
    isPublic: error.isPublic,
    message: error.message,
    status: error.status,
  }
}

/** JSON-safe, tagged: undefined, Date, bigint, functions and non-finite numbers survive. */
function encode(value) {
  if (value === undefined) {
    return { $undefined: true }
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0) ? value : { $number: String(value) }
  }
  if (typeof value === 'bigint') {
    return { $bigint: String(value) }
  }
  if (typeof value === 'function') {
    return { $function: value.name }
  }
  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() }
  }
  if (Array.isArray(value)) {
    return value.map((item) => encode(item))
  }
  const out = {}
  for (const key of Object.keys(value)) {
    out[key.startsWith('$') ? `$${key}` : key] = encode(value[key])
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    out.$class = prototype?.constructor?.name ?? 'unknown'
  }
  return out
}
