/**
 * Lane differential (MONGO_DRIVER_CONTRACT.md "Verification"): with
 * `PAYLOAD_MONGO_DRIVER_VERIFY=true` every read the driver lane serves is also run on the mongoose
 * lane with the same arguments, after the lane's result, and the two results are compared exactly:
 * key order, own `undefined` keys, `typeof`, prototypes (plain object / array / Date / bson
 * classes), numbers by `Object.is`. Divergences are counted and the first ones kept (with the
 * method and both values) for the stats file; `PAYLOAD_MONGO_DRIVER_VERIFY=strict` throws on the
 * first one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- results are arbitrary documents */
type Any = any

export const verifyMode = (): 'off' | 'record' | 'strict' => {
  const value = process.env.PAYLOAD_MONGO_DRIVER_VERIFY
  if (value === 'strict') {
    return 'strict'
  }
  return value === 'true' ? 'record' : 'off'
}

export const verifyStats = {
  compared: {} as Record<string, number>,
  /** Mismatches where the lane, run again after the reference, equals it (a concurrent write). */
  divergences: [] as { lane: string; method: string; path: string; reference: string }[],
  divergent: {} as Record<string, number>,
  raced: {} as Record<string, number>,
}

const describe = (value: unknown): string => {
  try {
    const text = JSON.stringify(value, (_key, v) =>
      typeof v === 'bigint' ? `${v}n` : v === undefined ? '<undefined>' : v,
    )
    return text === undefined ? String(value) : text.slice(0, 2000)
  } catch {
    return String(value)
  }
}

const kindOf = (value: unknown): string => {
  if (value === null) {
    return 'null'
  }
  if (typeof value !== 'object') {
    return typeof value
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  const proto = Object.getPrototypeOf(value)
  if (proto === Object.prototype || proto === null) {
    return 'object'
  }
  return (value as Any)?._bsontype ?? proto?.constructor?.name ?? 'object'
}

/** The first difference between `lane` and `reference`, as a path, or `undefined`. */
export const firstDifference = (
  lane: unknown,
  reference: unknown,
  path = '$',
): string | undefined => {
  const laneKind = kindOf(lane)
  const referenceKind = kindOf(reference)
  if (laneKind !== referenceKind) {
    return `${path}: ${laneKind} vs ${referenceKind}`
  }
  if (laneKind === 'number') {
    return Object.is(lane, reference)
      ? undefined
      : `${path}: ${String(lane)} vs ${String(reference)}`
  }
  if (laneKind === 'array') {
    const a = lane as unknown[]
    const b = reference as unknown[]
    if (a.length !== b.length) {
      return `${path}: length ${a.length} vs ${b.length}`
    }
    for (let index = 0; index < a.length; index++) {
      if (Object.hasOwn(a, index) !== Object.hasOwn(b, index)) {
        return `${path}[${index}]: hole`
      }
      const difference = firstDifference(a[index], b[index], `${path}[${index}]`)
      if (difference) {
        return difference
      }
    }
    return undefined
  }
  if (laneKind === 'object') {
    const a = Reflect.ownKeys(lane as object)
    const b = Reflect.ownKeys(reference as object)
    if (a.length !== b.length || a.some((key, index) => key !== b[index])) {
      return `${path}: keys ${describe(a.map(String))} vs ${describe(b.map(String))}`
    }
    for (const key of a) {
      const difference = firstDifference(
        (lane as Any)[key],
        (reference as Any)[key],
        `${path}.${String(key)}`,
      )
      if (difference) {
        return difference
      }
    }
    return undefined
  }
  if (laneKind === 'Date') {
    return Object.is((lane as Date).getTime(), (reference as Date).getTime())
      ? undefined
      : `${path}: date`
  }
  if (primitiveKinds.has(laneKind)) {
    return lane === reference ? undefined : `${path}: ${describe(lane)} vs ${describe(reference)}`
  }
  // bson instances: their JSON forms
  return describe(lane) === describe(reference) ? undefined : `${path}: ${laneKind} value`
}

const primitiveKinds = new Set([
  'bigint',
  'boolean',
  'function',
  'null',
  'string',
  'symbol',
  'undefined',
])

/**
 * Compares a served result with the mongoose lane's; records (or throws on) a divergence. A
 * mismatch is re-checked with `rerun` (the lane once more, after the reference): when that equals
 * the reference, data changed between the two reads (a race, counted separately).
 */
export const verifyResult = async ({
  lane,
  method,
  reference,
  rerun,
}: {
  lane: unknown
  method: string
  reference: unknown
  rerun: () => Promise<unknown>
}) => {
  verifyStats.compared[method] = (verifyStats.compared[method] ?? 0) + 1
  const difference = firstDifference(lane, reference)
  if (!difference) {
    return
  }
  if (!firstDifference(await rerun(), reference)) {
    verifyStats.raced[method] = (verifyStats.raced[method] ?? 0) + 1
    return
  }
  verifyStats.divergent[method] = (verifyStats.divergent[method] ?? 0) + 1
  if (verifyStats.divergences.length < 50) {
    verifyStats.divergences.push({
      lane: describe(lane),
      method,
      path: difference,
      reference: describe(reference),
    })
  }
  if (verifyMode() === 'strict') {
    throw new Error(`driver lane divergence in ${method} at ${difference}`)
  }
}
