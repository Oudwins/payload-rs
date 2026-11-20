/**
 * MongoDB side of the golden helpers (../harness/golden.ts) for parity.int.spec.ts.
 *
 * - `createMongoNormaliser`: values go through `toComparable` first, so bson values keep their
 *   type (`{"$oid": "<oid:N>"}`, `{"$regex": …}`, `{"$decimal": …}`) and user objects carrying a
 *   marker key are wrapped (`{"$obj": …}`: never equal to a typed value). Then the golden JSON
 *   spelling of ../harness/golden.ts (`$undefined`, `$date`, `$error`, `$bytes`, ...) with
 *   24-hex strings numbered `<oid:N>` in order of first appearance. Unlike the SQLite normaliser
 *   no string is rewritten otherwise (no drizzle table-alias rule).
 * - `dumpRows` / `dumpSchema`: read the database of MONGODB_URL through a separate MongoClient
 *   (independent of the adapter under test): every non-system collection sorted by name, its
 *   documents sorted by content then `_id` (see `contentKey`), its indexes (without `ns`) sorted by name and its options.
 */
import { withMongoClient } from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'
import { toComparable } from '../../../packages/engine-rs/src/shadow-mongo/comparable.js'
import { withoutRacedGlobalType } from '../../../packages/engine-rs/src/shadow-mongo/index.js'

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/

export const createMongoNormaliser = () => {
  const ids = new Map<string, string>()
  const normalise = (value: unknown, seen: WeakSet<object>): unknown => {
    if (value === undefined) {
      return { $undefined: true }
    }
    if (typeof value === 'string') {
      if (!OBJECT_ID_HEX.test(value)) {
        return value
      }
      if (!ids.has(value)) {
        ids.set(value, `<oid:${ids.size + 1}>`)
      }
      return ids.get(value)
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : { $number: String(value) }
    }
    if (typeof value === 'bigint') {
      return { $bigint: value.toString() }
    }
    if (typeof value === 'function') {
      return { $function: true }
    }
    if (value === null || typeof value !== 'object') {
      return value
    }
    if (seen.has(value)) {
      return { $circular: true }
    }
    seen.add(value)
    try {
      if (value instanceof Date) {
        return { $date: value.toISOString() }
      }
      if (value instanceof Error) {
        const e = value as { data?: unknown; status?: unknown } & Error
        return {
          $error: normalise(
            toComparable({
              class: e.constructor?.name,
              data: e.data,
              message: e.message,
              name: e.name,
              status: e.status,
            }),
            seen,
          ),
        }
      }
      if (value instanceof Uint8Array) {
        return { $bytes: Buffer.from(value).toString('base64') }
      }
      if (Array.isArray(value)) {
        return value.map((item) => normalise(item, seen))
      }
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value)) {
        out[key] = normalise((value as Record<string, unknown>)[key], seen)
      }
      return out
    } finally {
      seen.delete(value)
    }
  }
  return Object.assign((value: unknown) => normalise(toComparable(value), new WeakSet()), {
    /** `<oid:N>` of a 24-hex value seen so far (undefined when not seen yet). */
    idName: (hex: string) => ids.get(hex),
  })
}

const databaseName = () => new URL(process.env.MONGODB_URL!).pathname.replace(/^\//, '')

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

const listCollections = async (db: any) =>
  ((await db.listCollections().toArray()) as { name: string; options?: unknown; type?: string }[])
    .filter((info) => !info.name.startsWith('system.'))
    .sort(byName)

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
  if ((payload?.db as any)?.connection?.readyState !== 1) {
    return
  }
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
              .map(({ ns: _ns, ...index }) => withoutRacedGlobalType(index))
              .sort(byName)
      out[info.name] = { type: info.type, indexes, options: info.options }
    }
    return out
  })
}
