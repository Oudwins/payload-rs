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
 *   - `time`: an ISO date string, or an epoch number in seconds or ms. Each run records the
 *     start / finish time of every step (`windows`). A value's birth steps are the steps whose
 *     window contains it (epoch seconds: the second it truncates); the candidate's and each
 *     reference's birth steps must intersect, so a timestamp from the wrong step (e.g. an update
 *     returning the create's `updatedAt`) fails. A value inside no window (e.g. a JWT `exp`) is
 *     compared by its offset from the run's start / finish instead.
 *   - `uuid`: a UUID in every run.
 *   - `objectid`: a 24-hex ObjectId (row / document ids) in every run; its embedded seconds
 *     timestamp is checked like `time`.
 *   - `prefixed id`: `<prefix>:<objectid | uuid>` (a hook writing a document id into a string):
 *     the prefix must be equal, the id is paired like below.
 *   For `uuid` and `objectid` the pairing of candidate and reference values must be a bijection
 *   over the whole output, JWT claims included: the same reference id is always the same
 *   candidate id and vice versa, so ids still identify the same rows / sessions across steps.
 *   - `jwt`: same header; the claims are compared recursively by these same rules.
 *   Anything else (including structural differences between references) fails as unclassified.
 * - Zero compared leaves fails.
 */

const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
const objectId = /^[0-9a-f]{24}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const jwt = /^[\w-]+\.[\w-]+\.[\w-]+$/
const prefixedId =
  /^([^\s]*:)([0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

function splitPrefixedId(value) {
  const match = prefixedId.exec(value)
  return [match[1], match[2]]
}

/**
 * @param {{ references: Array<{ label: string, output: any }>, candidate: { label: string, output: any } }} args
 */
export const compareRuns = ({ candidate, references }) => {
  if (references.length < 2) {
    throw new Error('compareRuns needs at least two reference runs to tell nondeterminism apart')
  }
  const pairings = references.map(() => ({ backward: new Map(), forward: new Map() }))
  return compareLeaves({
    candidate: { leaves: flatten(candidate.output.steps), output: candidate.output },
    pairings,
    references: references.map((reference) => ({
      leaves: flatten(reference.output.steps),
      output: reference.output,
    })),
  })
}

function compareLeaves({ candidate, pairings, references }) {
  const mismatches = []
  const nondeterministic = new Map()
  const paths = new Set([
    ...candidate.leaves.keys(),
    ...references.flatMap((reference) => [...reference.leaves.keys()]),
  ])
  let compared = 0
  for (const leafPath of paths) {
    compared++
    const values = references.map((reference) => reference.leaves.get(leafPath))
    const actual = candidate.leaves.get(leafPath)
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
      pairings,
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
  if (compared === 0 || candidate.leaves.size === 0) {
    mismatches.push({ path: '', problem: 'nothing compared' })
  }
  return { compared, mismatches, nondeterministic: [...nondeterministic.keys()] }
}

function checkNondeterministic({ actual, candidate, pairings, path: leafPath, references }) {
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
    case 'time':
      return checkTime({ candidate, candidateValue, references, referenceValues })
    case 'uuid':
      return checkPairing({ candidateValue, pairings, referenceValues })
    case 'prefixed id': {
      const [candidatePrefix, candidateId] = splitPrefixedId(candidateValue)
      const split = referenceValues.map((value) => splitPrefixedId(value))
      if (split.some(([prefix]) => prefix !== candidatePrefix)) {
        return 'prefix of a prefixed id differs'
      }
      return checkPairing({
        candidateValue: candidateId,
        pairings,
        referenceValues: split.map(([, id]) => id),
      })
    }
    case 'objectid': {
      const seconds = (value) => Number.parseInt(value.slice(0, 8), 16)
      return (
        checkPairing({ candidateValue, pairings, referenceValues }) ??
        checkTime({
          candidate,
          candidateValue: seconds(candidateValue),
          references,
          referenceValues: referenceValues.map((value) => seconds(value)),
        })
      )
    }
    case 'jwt': {
      const decoded = [candidateValue, ...referenceValues].map((token) => decodeJwt(token))
      if (decoded.some((token) => token.header !== decoded[0].header)) {
        return 'jwt header differs'
      }
      const nested = compareLeaves({
        candidate: { leaves: flatten(decoded[0].claims), output: candidate },
        pairings,
        references: references.map((reference, index) => ({
          leaves: flatten(decoded[index + 1].claims),
          output: reference.output,
        })),
      })
      return nested.mismatches.length > 0
        ? `jwt claims: ${JSON.stringify(nested.mismatches)}`
        : undefined
    }
  }
  return 'unclassified nondeterminism'
}

/** One-to-one id correspondence between the candidate and each reference, across the output. */
function checkPairing({ candidateValue, pairings, referenceValues }) {
  for (const [index, referenceValue] of referenceValues.entries()) {
    const { backward, forward } = pairings[index]
    const pairedReference = forward.get(candidateValue)
    const pairedCandidate = backward.get(referenceValue)
    if (pairedReference !== undefined && pairedReference !== referenceValue) {
      return `id ${candidateValue} already stands for ${pairedReference} in reference ${index + 1}, not ${referenceValue}`
    }
    if (pairedCandidate !== undefined && pairedCandidate !== candidateValue) {
      return `reference ${index + 1} id ${referenceValue} already stands for ${pairedCandidate}, not ${candidateValue}`
    }
    forward.set(candidateValue, referenceValue)
    backward.set(referenceValue, candidateValue)
  }
  return undefined
}

function checkTime({ candidate, candidateValue, references, referenceValues }) {
  const candidateRange = timeRange(candidateValue)
  const candidateSteps = birthSteps(candidateRange, candidate)
  for (const [index, reference] of references.entries()) {
    const referenceRange = timeRange(referenceValues[index])
    const referenceSteps = birthSteps(referenceRange, reference.output)
    if (candidateSteps.length > 0 || referenceSteps.length > 0) {
      if (!candidateSteps.some((stepIndex) => referenceSteps.includes(stepIndex))) {
        return `time from step(s) [${candidateSteps}], reference ${index + 1} from step(s) [${referenceSteps}]`
      }
      continue
    }
    const candidateOffsets = offsets(candidateRange, candidate)
    const referenceOffsets = offsets(referenceRange, reference.output)
    if (candidateOffsets[0] > referenceOffsets[1] || referenceOffsets[0] > candidateOffsets[1]) {
      return `time offset [${candidateOffsets}] does not overlap reference [${referenceOffsets}]`
    }
  }
  return undefined
}

/** `[earliest, latest]` instant (ms) a time value can stand for (epoch seconds truncate). */
function timeRange(value) {
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return [ms, ms]
  }
  return value < 1e11 ? [value * 1000, value * 1000 + 999] : [value, value]
}

/** Indices of the steps whose [start, finish] window overlaps `range`. */
function birthSteps(range, output) {
  return (output.windows ?? []).flatMap(([start, finish], index) =>
    range[0] <= finish && range[1] >= start ? [index] : [],
  )
}

/** Interval of `value - now` over the run's window, in ms. */
function offsets(range, output) {
  return [range[0] - output.finishedAt, range[1] - output.startedAt]
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
    if (prefixedId.test(value)) {
      return 'prefixed id'
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
