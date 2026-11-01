/**
 * Golden-output helpers for parity.int.spec.ts.
 *
 * Values are normalised into JSON that keeps everything user visible:
 * key order, `undefined` vs missing (`{"$undefined":true}`), Dates
 * (`{"$date": iso}`), errors (`{"$error": {class,name,message,status,data}}`).
 *
 * The only normalisation of data is for values that differ between two runs
 * of the same engine: generated 24-hex ObjectIds (array/block row ids) are
 * replaced by `<oid:N>` in order of first appearance in the suite, so equal
 * ids stay equal and distinct ids stay distinct. Timestamps are made
 * deterministic by the suite (fake Date clock), not normalised. Random drizzle
 * table aliases (uuid-based, visible in SQL error messages) become `<alias:N>`.
 *
 * PAYLOAD_RS_UPDATE_GOLDEN=1 rewrites the golden files instead of asserting.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect } from 'vitest'

export const updateGolden = process.env.PAYLOAD_RS_UPDATE_GOLDEN === '1'

const OBJECT_ID = /^[0-9a-f]{24}$/
/** drizzle getTableAlias(): toSnakeCase(uuid()) — appears in SQL error messages */
const TABLE_ALIAS = /[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}/g

/** Replaces random drizzle table aliases by `<alias:N>` (numbered per string). */
export const normaliseAliases = (value: string) => {
  const seen = new Map<string, string>()
  return value.replace(TABLE_ALIAS, (match) => {
    if (!seen.has(match)) {
      seen.set(match, `<alias:${seen.size + 1}>`)
    }
    return seen.get(match)!
  })
}

export const createNormaliser = () => {
  const ids = new Map<string, string>()
  const normalise = (value: unknown, seen = new WeakSet<object>()): unknown => {
    if (value === undefined) {
      return { $undefined: true }
    }
    if (typeof value === 'string') {
      if (OBJECT_ID.test(value)) {
        if (!ids.has(value)) {
          ids.set(value, `<oid:${ids.size + 1}>`)
        }
        return ids.get(value)
      }
      return normaliseAliases(value)
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
            {
              class: e.constructor?.name,
              data: e.data,
              message: e.message,
              name: e.name,
              status: e.status,
            },
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
  return normalise
}

/** Runs fn and returns its normalised result or thrown error. */
export const capture = async (
  normalise: ReturnType<typeof createNormaliser>,
  fn: () => Promise<unknown> | unknown,
) => {
  try {
    return normalise(await fn())
  } catch (error) {
    return normalise(error instanceof Error ? error : new Error(String(error)))
  }
}

export const createGoldenStore = (dir: string) => {
  const loaded = new Map<string, Record<string, unknown>>()
  const pending = new Map<string, Record<string, unknown>>()

  const load = (section: string) => {
    if (!loaded.has(section)) {
      const file = path.join(dir, `${section}.json`)
      loaded.set(section, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {})
    }
    return loaded.get(section)!
  }

  return {
    check(section: string, name: string, actual: unknown) {
      if (updateGolden) {
        const bucket = pending.get(section) ?? {}
        bucket[name] = actual
        pending.set(section, bucket)
        return
      }
      const golden = load(section)
      if (!(name in golden)) {
        throw new Error(
          `No golden output for ${section} > ${name}. Run with PAYLOAD_RS_UPDATE_GOLDEN=1 against the TS engine.`,
        )
      }
      const expected = golden[name]
      const a = JSON.stringify(actual)
      const g = JSON.stringify(expected)
      if (a !== g) {
        // structural diff first (readable), then the exact string (key order)
        expect(actual, `${section} > ${name}`).toStrictEqual(expected)
        expect(a, `${section} > ${name} (key order)`).toBe(g)
      }
    },
    write() {
      if (!updateGolden) {
        return
      }
      fs.mkdirSync(dir, { recursive: true })
      for (const [section, cases] of pending) {
        fs.writeFileSync(path.join(dir, `${section}.json`), `${JSON.stringify(cases, null, 1)}\n`)
      }
    },
  }
}

/** Path of the SQLite file used by the int suite. */
export const sqliteFilePath = () => {
  const url = process.env.SQLITE_URL || process.env.DATABASE_URL || 'file:./payload.db'
  return path.resolve(url.replace(/^file:/, ''))
}

/**
 * Reads every table of the database file directly (independent of the
 * adapter under test): rows ordered by rowid, as plain objects.
 */
export const dumpRows = (file = sqliteFilePath()) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
    const out: Record<string, unknown[]> = {}
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()
      if (rows.length) {
        out[name] = rows.map((row) => ({ ...row }))
      }
    }
    return out
  } finally {
    db.close()
  }
}

/** Structural schema: columns, indexes and foreign keys of every table. */
export const dumpSchema = (file = sqliteFilePath()) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
    const out: Record<string, unknown> = {}
    for (const { name } of tables) {
      const indexes = (
        db.prepare(`PRAGMA index_list("${name}")`).all() as { name: string; unique: number }[]
      )
        .map((index) => ({
          name: index.name,
          columns: (
            db.prepare(`PRAGMA index_info("${index.name}")`).all() as { name: string }[]
          ).map((c) => c.name),
          unique: index.unique,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      out[name] = {
        columns: db
          .prepare(`PRAGMA table_info("${name}")`)
          .all()
          .map((c) => ({ ...c })),
        foreignKeys: db
          .prepare(`PRAGMA foreign_key_list("${name}")`)
          .all()
          .map((fk) => ({ ...fk })),
        indexes,
      }
    }
    return out
  } finally {
    db.close()
  }
}
