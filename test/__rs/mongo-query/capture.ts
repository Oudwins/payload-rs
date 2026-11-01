/**
 * Captures the calls of the TS query builders made by upstream int suites (test/__rs/mongo-query/
 * vitest.capture.config.ts resolves the db-mongodb imports to ./wrap/*). With RS_MQ_CAPTURE_DIR
 * set, every top-level `parseParams` (= `buildQuery` and `Model.buildQuery`), `buildSortParam` and
 * `buildProjectionFromSelect` call is recorded (recorder.ts) and each Payload instance's cases are
 * written to `<dir>/<RS_MQ_CAPTURE_TAG>-<pid>-<n>.json.gz` when the process exits, in the fixture
 * format of crates/payload-mongo-query/tests/replay/mod.rs. Without it the wrappers pass through.
 */
import type { Payload } from 'payload'

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { serializeForEngine } from '../../../packages/engine-rs/src/serialize.js'
import { createRecorder, modelInfo, type RecordedCase, type Recorder, serializeEnv } from './recorder.js'

const dir = process.env.RS_MQ_CAPTURE_DIR
const tag = process.env.RS_MQ_CAPTURE_TAG || 'capture'
const maxCases = Number(process.env.RS_MQ_CAPTURE_MAX || 15000)

type State = {
  cases: RecordedCase[]
  disableFallbackSort: boolean
  fieldSetByContent: Map<string, number>
  fieldSetByIdentity: WeakMap<object, number>
  fieldSets: unknown[]
  payload: Payload
  recorder: Recorder
  seen: Set<string>
}

const states: State[] = []
const statesByPayload = new WeakMap<object, State>()

const stateOf = (payload: Payload): State => {
  let state = statesByPayload.get(payload)
  if (!state) {
    state = {
      cases: [],
      disableFallbackSort: Boolean((payload.db as any).disableFallbackSort),
      fieldSetByContent: new Map(),
      fieldSetByIdentity: new WeakMap(),
      fieldSets: [],
      payload,
      recorder: createRecorder(payload),
      seen: new Set(),
    }
    statesByPayload.set(payload, state)
    states.push(state)
    if (process.env.RS_MQ_CAPTURE_DEBUG) {
      process.stderr.write(`[rs mongo query capture] recording payload instance ${states.length - 1}\n`)
    }
  }
  return state
}

/** Index of a field set, deduplicated by identity and then by content. */
const fieldSetOf = (state: State, fields: unknown): number => {
  if (!fields || typeof fields !== 'object') {
    return -1
  }
  let i = state.fieldSetByIdentity.get(fields)
  if (i === undefined) {
    const content = serializeForEngine(fields, state.recorder.registry)
    i = state.fieldSetByContent.get(content)
    if (i === undefined) {
      i = state.fieldSets.push(fields) - 1
      state.fieldSetByContent.set(content, i)
    }
    state.fieldSetByIdentity.set(fields, i)
  }
  return i
}

const capture = async <T>(
  payload: Payload,
  kind: RecordedCase['kind'],
  args: Record<string, unknown>,
  run: () => T,
): Promise<T> => {
  const state = stateOf(payload)
  const { case: recorded, error, value } = await state.recorder.record(kind, args, run)
  const key = `${kind}:${JSON.stringify(recorded.args)}`
  if (state.cases.length < maxCases && !state.seen.has(key)) {
    state.seen.add(key)
    state.cases.push(recorded)
    scheduleFlush()
  }
  if (recorded.error) {
    throw error
  }
  return value as T
}

const isEnabled = (payload: Payload | undefined) =>
  Boolean(dir && payload && payload.db && (payload.db as any).name === 'mongoose')

export const captureParseParams = <T>(args: any, original: (args: any) => Promise<T>): Promise<T> => {
  const payload = args?.payload as Payload | undefined
  if (!isEnabled(payload) || stateOf(payload!).recorder.isActive()) {
    return original(args)
  }
  const state = stateOf(payload!)
  return capture(
    payload!,
    'parseParams',
    {
      collectionSlug: args.collectionSlug,
      fieldSet: fieldSetOf(state, args.fields),
      globalSlug: args.globalSlug,
      locale: args.locale,
      parentIsLocalized: args.parentIsLocalized,
      where: args.where,
    },
    () => original(args),
  )
}

export const captureSync = <T>(
  kind: 'projection' | 'sort',
  args: any,
  original: (args: any) => T,
): T => {
  const payload = args?.adapter?.payload as Payload | undefined
  if (!isEnabled(payload) || args.config !== undefined && args.config !== payload!.config) {
    return original(args)
  }
  const state = stateOf(payload!)
  const recorder = state.recorder
  if (kind === 'projection') {
    const recordArgs = { fieldSet: fieldSetOf(state, args.fields), select: args.select }
    const before = recorder.serialize(recordArgs)
    let value: T
    try {
      value = original(args)
    } catch (e) {
      push(state, { args: before, error: errorOf(e), hostOps: [], id: state.cases.length, kind })
      throw e
    }
    push(state, { args: before, hostOps: [], id: state.cases.length, kind, result: recorder.serialize(value) })
    return value
  }
  const sortAggregation: unknown[] | undefined = args.sortAggregation
  const initial = sortAggregation?.length ?? 0
  const recordArgs = {
    fieldSet: fieldSetOf(state, args.fields),
    locale: args.locale,
    parentIsLocalized: args.parentIsLocalized,
    sort: args.sort,
    timestamps: args.timestamps,
    withAggregation: Boolean(sortAggregation),
  }
  const before = recorder.serialize(recordArgs)
  let value: T
  try {
    value = original(args)
  } catch (e) {
    push(state, { args: before, error: errorOf(e), hostOps: [], id: state.cases.length, kind })
    throw e
  }
  const after = recorder.serialize(recordArgs)
  const result = recorder.serialize(
    sortAggregation ? { sort: value, sortAggregation: sortAggregation.slice(initial) } : { sort: value },
  )
  push(state, {
    args: before,
    ...(JSON.stringify(after) !== JSON.stringify(before) ? { argsAfter: after } : {}),
    hostOps: [],
    id: state.cases.length,
    kind,
    result,
  })
  return value
}

const errorOf = (e: unknown) => {
  const err = e as { message?: unknown; name?: unknown; status?: unknown }
  return {
    name: String(err?.name ?? 'Error'),
    message: String(err?.message ?? e),
    ...(typeof err?.status === 'number' ? { status: err.status } : {}),
  }
}

const push = (state: State, recorded: RecordedCase) => {
  const key = `${recorded.kind}:${JSON.stringify(recorded.args)}`
  if (state.cases.length < maxCases && !state.seen.has(key)) {
    state.seen.add(key)
    state.cases.push({ ...recorded, id: state.cases.length })
    scheduleFlush()
  }
}

let flushTimer: NodeJS.Timeout | undefined

/** Writes every Payload instance's fixture (again: the latest state wins). */
export const flush = () => {
  flushTimer = undefined
  if (!dir) {
    return
  }
  fs.mkdirSync(dir, { recursive: true })
  states.forEach((state, n) => {
    if (!state.cases.length || (state as any).flushed === state.cases.length) {
      return
    }
    const file = path.join(dir, `${tag}-${process.pid}-${n}`)
    try {
      const cases = state.cases.map((c, id) => ({ ...c, id }))
      const fixture = {
        cases,
        disableFallbackSort: state.disableFallbackSort,
        graph: serializeEnv(state.recorder, state.payload, state.fieldSets),
        modelInfo: modelInfo(state.payload),
        suite: `${tag}-${process.pid}-${n}`,
      }
      fs.writeFileSync(`${file}.json.gz`, zlib.gzipSync(JSON.stringify(fixture)))
      ;(state as any).flushed = state.cases.length
    } catch (e) {
      fs.writeFileSync(`${file}.error.txt`, String((e as Error)?.stack ?? e))
    }
  })
}

let lastFlush = Date.now()

/**
 * Flushes once recording has been idle for 5 s, at the latest 60 s after the previous flush
 * (vitest's fork pool may not run `exit` handlers; serializing the config graph is not cheap).
 */
const scheduleFlush = () => {
  if (flushTimer && Date.now() - lastFlush < 60_000) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      lastFlush = Date.now()
      flush()
    }, 5000)
    flushTimer.unref()
  }
}

if (dir) {
  process.on('exit', flush)
  process.on('beforeExit', flush)
}
