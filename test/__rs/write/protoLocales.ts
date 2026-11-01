/**
 * Golden fixtures for locale keys that collide with `Object.prototype` properties
 * (`constructor`, `toString`, `__proto__`, ...) in localized fields, localized groups (forced
 * locale) and localized arrays. TS writes those values onto the inherited object instead of a
 * locale row (and pollutes the prototype, which is cleaned up after every call here).
 *
 *   pnpm tsx test/__rs/write/protoLocales.ts   # writes fixtures/manual__proto-locales.json.gz
 */
import { transformForWrite } from '../../../packages/drizzle/src/transform/write/index.js'
import { flushFixtures, wrapTransformForWrite } from './capture.js'

const PROTO_KEYS = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']

const textField = (name: string, localized?: boolean) => ({
  name,
  type: 'text',
  ...(localized ? { localized } : {}),
})

const fields = [
  textField('title', true),
  { name: 'count', type: 'number', localized: true },
  {
    name: 'meta',
    type: 'group',
    localized: true,
    flattenedFields: [textField('description'), textField('keywords')],
  },
  {
    name: 'items',
    type: 'array',
    localized: true,
    flattenedFields: [textField('label')],
  },
]

const adapter = {
  name: 'sqlite',
  blocksAsJSON: false,
  payload: { config: { blocks: [] } },
  tableNameMap: new Map([
    ['posts', 'posts'],
    ['posts_items', 'posts_items'],
  ]),
  tables: { posts: {}, posts_items: {} },
}

const run = wrapTransformForWrite(transformForWrite as any)

const cleanup = () => {
  const names = ['title', 'count', 'description', 'keywords', 'label', '_uuid', '_locale']
  for (const key of PROTO_KEYS) {
    const target = key === '__proto__' ? Object.prototype : (Object.prototype as any)[key]
    for (const name of names) {
      delete target[name]
    }
  }
}

const inputs: string[] = []
for (const key of PROTO_KEYS) {
  inputs.push(`{"title":{"${key}":"x","en":"y"}}`)
  inputs.push(`{"title":{"en":"y","${key}":"x"},"count":{"${key}":3,"de":4}}`)
  inputs.push(`{"meta":{"${key}":{"description":"d","keywords":"k"},"en":{"description":"e"}}}`)
  inputs.push(`{"items":{"${key}":[{"id":"a","label":"l"}],"en":[{"id":"b","label":"m"}]}}`)
}
inputs.push(`{"title":{"constructor":"x","toString":"t","__proto__":"p"}}`)

for (const input of inputs) {
  try {
    run({ adapter, data: JSON.parse(input), fields, tableName: 'posts' })
  } catch {
    // captured as a fixture error
  } finally {
    cleanup()
  }
}

const written = flushFixtures('manual__proto-locales')
// eslint-disable-next-line no-console
console.log(written)
