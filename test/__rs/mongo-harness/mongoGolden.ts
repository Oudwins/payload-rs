import { withMongoClient } from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'
/**
 * MongoDB side of the golden helpers (../harness/golden.ts) for parity.int.spec.ts.
 *
 * - `createMongoNormaliser`: the golden normaliser applied after `toComparable`, so bson values
 *   keep their type (`{"$oid": "<oid:N>"}`, `{"$regex": …}`, `{"$decimal": …}`) instead of being
 *   flattened, and generated ObjectIds still become `<oid:N>` in order of first appearance.
 * - `dumpRows` / `dumpSchema`: read the database of MONGODB_URL through a separate MongoClient
 *   (independent of the adapter under test): every non-system collection sorted by name, its
 *   documents sorted by content then `_id` (see `contentKey`), its indexes (without `ns`) sorted by name and its options.
 */
import { toComparable } from '../../../packages/engine-rs/src/shadow-mongo/comparable.js'
import { createNormaliser } from '../harness/golden.js'

export const createMongoNormaliser = () => {
  const normalise = createNormaliser()
  return (value: unknown) => normalise(toComparable(value))
}

const databaseName = () => new URL(process.env.MONGODB_URL!).pathname.replace(/^\//, '')

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

const listCollections = async (db: any) =>
  ((await db.listCollections().toArray()) as { name: string; options?: unknown; type?: string }[])
    .filter((info) => !info.name.startsWith('system.'))
    .sort(byName)

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/

/**
 * Sort key of a document: its content without `_id` and with every ObjectId (generated array row
 * ids, references) blanked. Documents written by concurrent operations (bulk update creating one
 * version per document in parallel) get ObjectIds in a different counter order on every run, so
 * an `_id` sort is not reproducible; their content is.
 */
const contentKey = (document: Record<string, unknown>) => {
  const { _id: _ignored, ...rest } = document
  return JSON.stringify(toComparable(rest), (_key, value) =>
    typeof value === 'string' && OBJECT_ID_HEX.test(value) ? '<id>' : value,
  )
}

/** Documents of every non-empty collection, sorted by content (see `contentKey`), then `_id`. */
export const dumpRows = () =>
  withMongoClient(async (client: any) => {
    const db = client.db(databaseName())
    const out: Record<string, unknown[]> = {}
    for (const { name } of await listCollections(db)) {
      const documents = (await db
        .collection(name)
        .find({}, { sort: { _id: 1 } })
        .toArray()) as Record<string, unknown>[]
      if (documents.length) {
        const keyed = documents.map((document, index) => ({
          document,
          index,
          key: contentKey(document),
        }))
        keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
        out[name] = keyed.map(({ document }) => document)
      }
    }
    return out
  })

/**
 * Waits for the background index builds mongoose starts per model (`autoIndex`; upstream's
 * `connect` only awaits `ensureIndexes` of collections and versions, not of the globals model),
 * so the schema dump does not race them.
 */
const waitForModelInit = async (payload?: { db: unknown }) => {
  const models = Object.values(
    ((payload?.db as any)?.connection?.models ?? {}) as Record<string, any>,
  )
  await Promise.all(models.map((model) => Promise.resolve(model.init?.()).catch(() => undefined)))
}

/** Collections with their type, options and indexes. */
export const dumpSchema = async (payload?: { db: unknown }) => {
  await waitForModelInit(payload)
  return withMongoClient(async (client: any) => {
    const db = client.db(databaseName())
    const out: Record<string, unknown> = {}
    for (const info of await listCollections(db)) {
      const indexes =
        info.type === 'view'
          ? []
          : ((await db.collection(info.name).indexes()) as { name: string; ns?: unknown }[])
              .map(({ ns: _ns, ...index }) => index)
              .sort(byName)
      out[info.name] = { type: info.type, indexes, options: info.options }
    }
    return out
  })
}
