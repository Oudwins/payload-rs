/**
 * Canonical, type-preserving description of values returned/thrown by a
 * libsql-style client, used to diff `@libsql/client` against the Rust runtime.
 */
export const describeValue = (value: unknown, depth = 0): unknown => {
  if (depth > 6) {
    return '<deep>'
  }
  if (value === undefined) {
    return { undefined: true }
  }
  if (value === null) {
    return null
  }
  switch (typeof value) {
    case 'bigint':
      return { bigint: value.toString() }
    case 'boolean':
    case 'string':
      return value
    case 'function':
      return { function: value.name }
    case 'number':
      return Object.is(value, -0)
        ? { number: '-0' }
        : Number.isNaN(value)
          ? { number: 'NaN' }
          : value
    case 'symbol':
      return { symbol: String(value) }
  }
  if (value instanceof ArrayBuffer) {
    return { arrayBuffer: Array.from(new Uint8Array(value)), resizable: value.resizable }
  }
  if (Buffer.isBuffer(value)) {
    return { buffer: Array.from(value) }
  }
  if (value instanceof Error) {
    const err = value as {
      cause?: unknown
      code?: unknown
      libsqlError?: unknown
      rawCode?: unknown
    } & Error
    return {
      cause: err.cause === undefined ? undefined : describeValue(err.cause, depth + 1),
      class: err.constructor.name,
      code: describeValue(err.code),
      instanceofError: true,
      keys: Object.keys(err),
      libsqlError: describeValue(err.libsqlError),
      message: err.message,
      name: err.name,
      ownNames: Object.getOwnPropertyNames(err).filter((k) => k !== 'stack'),
      rawCode: describeValue(err.rawCode),
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => describeValue(v, depth + 1))
  }
  const obj = value as Record<string, unknown>
  const className = obj.constructor?.name
  if (className === 'ResultSetImpl') {
    const rs = obj as {
      columns: string[]
      columnTypes: string[]
      lastInsertRowid: unknown
      rows: unknown[]
      rowsAffected: number
    }
    return {
      class: className,
      columns: rs.columns,
      columnTypes: rs.columnTypes,
      json: JSON.stringify(rs),
      keys: Object.keys(rs),
      lastInsertRowid: describeValue(rs.lastInsertRowid),
      rows: rs.rows.map((row) => describeRow(row)),
      rowsAreArray: Array.isArray(rs.rows),
      rowsAffected: rs.rowsAffected,
    }
  }
  const out: Record<string, unknown> = { class: className ?? null }
  for (const key of Object.keys(obj)) {
    out[key] = describeValue(obj[key], depth + 1)
  }
  return out
}

export const describeRow = (row: unknown) => {
  const r = row as { length: number } & Record<number | string, unknown>
  const descriptors = Object.getOwnPropertyDescriptors(r)
  return {
    descriptors: Object.fromEntries(
      Reflect.ownKeys(descriptors).map((k) => {
        const d = descriptors[k as string]!
        return [
          String(k),
          [d.enumerable, d.writable, d.configurable, describeValue(d.value)] as const,
        ]
      }),
    ),
    indexed: Array.prototype.slice.call(r).map((v) => describeValue(v)),
    json: JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    keys: Object.keys(r),
    length: r.length,
    proto: Object.getPrototypeOf(r) === Object.prototype,
  }
}
