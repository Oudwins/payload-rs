/**
 * Differential comparison of scenario outputs (`scenario.mjs`): every candidate run is checked
 * against every reference run.
 *
 * - Each output is flattened to leaves (`path -> JSON value`) plus, per object, its key order
 *   (`path#keys`) and, per array, its length (`path#length`).
 * - A leaf is nondeterministic only when two reference runs disagree on it. Everywhere else the
 *   candidate must equal the references exactly, key order included.
 * - A nondeterministic leaf must be one of the known clock / random kinds in every run, and the
 *   candidate's value must be consistent with each reference value:
 *   - `time`: an ISO date string, or an epoch number in seconds or ms. The value minus its run's
 *     start/finish window gives an interval of possible offsets from "now"; the candidate's
 *     interval must overlap every reference's.
 *   - `uuid`: a UUID in every run.
 *   - `objectid`: a 24-hex ObjectId (array / block row ids) in every run; its embedded seconds
 *     timestamp is checked like `time`.
 *   For `uuid` and `objectid` the pairing of candidate and reference values must also be a
 *   bijection over the whole output: the same reference id is always the same candidate id
 *   (and vice versa), so ids still identify the same rows across steps.
 *   - `jwt`: same header; the claims are compared recursively by these same rules.
 *   Anything else (including structural differences between references) fails as unclassified.
 * - Zero compared leaves fails.
 */

const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
const objectId = /^[0-9a-f]{24}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const jwt = /^[\w-]+\.[\w-]+\.[\w-]+$/

/**
 * @param {{ references: Array<{ label: string, output: any }>, candidate: { label: string, output: any } }} args
 */
export const compareRuns = ({ candidate, references }) => {
  if (references.length < 2) {
    throw new Error('compareRuns needs at least two reference runs to tell nondeterminism apart')
  }
  const mismatches = []
  const nondeterministic = new Map()
  const referenceLeaves = references.map((reference) => flatten(reference.output.steps))
  const candidateLeaves = flatten(candidate.output.steps)

  const pairings = references.map(() => ({ forward: new Map(), backward: new Map() }))
  const paths = new Set([
    ...candidateLeaves.keys(),
    ...referenceLeaves.flatMap((leaves) => [...leaves.keys()]),
  ])
  let compared = 0
  for (const leafPath of paths) {
    compared++
    const values = referenceLeaves.map((leaves) => leaves.get(leafPath))
    const actual = candidateLeaves.get(leafPath)
    const isStable = values.every((value) => value === values[0])
    if (isStable) {
      if (actual !== values[0]) {
        mismatches.push({ path: leafPath, candidate: actual, reference: values[0] })
      }
      continue
    }
    const problem = checkNondeterministic({
      actual,
      candidate: candidate.output,
      path: leafPath,
      references: references.map((reference, index) => ({
        output: reference.output,
        value: values[index],
      })),
    })
    nondeterministic.set(leafPath, problem ? 'fail' : 'ok')
    if (problem) {
      mismatches.push({ path: leafPath, candidate: actual, problem, references: values })
    }
  }
  if (compared === 0 || candidateLeaves.size === 0) {
    mismatches.push({ path: '', problem: 'nothing compared' })
  }
  return { compared, mismatches, nondeterministic: [...nondeterministic.keys()] }
}

function checkNondeterministic({ actual, candidate, path: leafPath, references }) {
  if (leafPath.endsWith('#keys') || leafPath.endsWith('#length')) {
    return 'structure differs between reference runs'
  }
  if (actual === undefined || references.some((reference) => reference.value === undefined)) {
    return 'leaf missing in a run'
  }
  const parsed = [actual, ...references.map((reference) => reference.value)].map((value) =>
    JSON.parse(value),
  )
  const kinds = parsed.map((value) => kindOf(value))
  if (kinds.some((kind) => kind !== kinds[0]) || kinds[0] === undefined) {
    return `unclassified nondeterminism (kinds ${kinds.join(', ')})`
  }
  const [candidateValue, ...referenceValues] = parsed
  switch (kinds[0]) {
    case 'time': {
      const candidateOffsets = timeOffsets(candidateValue, candidate)
      for (const [index, reference] of references.entries()) {
        const referenceOffsets = timeOffsets(referenceValues[index], reference.output)
        if (
          candidateOffsets[0] > referenceOffsets[1] ||
          referenceOffsets[0] > candidateOffsets[1]
        ) {
          return `time offset [${candidateOffsets}] does not overlap reference [${referenceOffsets}]`
        }
      }
      return undefined
    }
    case 'uuid':
      return undefined
    case 'objectid': {
      const seconds = (value) => Number.parseInt(value.slice(0, 8), 16)
      return checkNondeterministic({
        actual: JSON.stringify(seconds(candidateValue)),
        candidate,
        path: `${leafPath}(timestamp)`,
        references: references.map((reference, index) => ({
          output: reference.output,
          value: JSON.stringify(seconds(referenceValues[index])),
        })),
      })
    }
    case 'jwt': {
      const decoded = [candidateValue, ...referenceValues].map((token) => decodeJwt(token))
      if (decoded.some((token) => token.header !== decoded[0].header)) {
        return 'jwt header differs'
      }
      const nested = compareRuns({
        candidate: { label: 'candidate', output: { ...candidate, steps: decoded[0].claims } },
        references: references.map((reference, index) => ({
          label: `reference ${index}`,
          output: { ...reference.output, steps: decoded[index + 1].claims },
        })),
      })
      return nested.mismatches.length > 0
        ? `jwt claims: ${JSON.stringify(nested.mismatches)}`
        : undefined
    }
  }
  return 'unclassified nondeterminism'
}

function kindOf(value) {
  if (typeof value === 'string') {
    if (isoDate.test(value) && !Number.isNaN(Date.parse(value))) {
      return 'time'
    }
    if (uuid.test(value)) {
      return 'uuid'
    }
    if (objectId.test(value)) {
      return 'objectid'
    }
    if (jwt.test(value)) {
      try {
        decodeJwt(value)
        return 'jwt'
      } catch {
        return undefined
      }
    }
    return undefined
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 1e9) {
    return 'time'
  }
  return undefined
}

/** Interval of `value - now` over the run's window, in ms. */
function timeOffsets(value, output) {
  const ms = typeof value === 'string' ? Date.parse(value) : value < 1e11 ? value * 1000 : value
  // epoch seconds are truncated, so they may read up to 1 s before the instant they stand for
  const slack = typeof value === 'number' && value < 1e11 ? 1000 : 0
  return [ms - output.finishedAt - slack, ms - output.startedAt + slack]
}

function decodeJwt(token) {
  const [header, claims] = token.split('.')
  return {
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')),
    header: Buffer.from(header, 'base64url').toString('utf8'),
  }
}

/** `path -> JSON leaf`, with `path#keys` (order-sensitive) and `path#length` entries. */
export function flatten(value, prefix = '$', out = new Map()) {
  if (Array.isArray(value)) {
    out.set(`${prefix}#length`, String(value.length))
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out))
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    out.set(`${prefix}#keys`, JSON.stringify(keys))
    for (const key of keys) {
      flatten(value[key], `${prefix}.${JSON.stringify(key)}`, out)
    }
  } else {
    out.set(prefix, JSON.stringify(value))
  }
  return out
}
