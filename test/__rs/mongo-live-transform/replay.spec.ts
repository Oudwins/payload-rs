import mongoose from 'mongoose'
/**
 * Regression on the recorded corpus of the stage-1 port (test/__rs/mongo-transform/fixtures: real
 * upstream `transform` calls recorded during upstream int runs on MongoDB, plus synthetic ones):
 * every recorded call is decoded into live JS objects (typed bson, shared references, own
 * `__proto__` keys) twice and run through the TS reference and the Rust port with the recording
 * proxies of the live differential (./world.ts), comparing trap logs, final state with identity,
 * return value and thrown value. The TS run must also reproduce the recorded outcome (return value
 * and error name / message), so the decoded inputs are the recorded ones.
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/livetransform-addon/payload-engine.node \
 *     pnpm vitest run --config test/__rs/mongo-live-transform/vitest.config.ts --project live-transform-unit replay
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { World } from './world.js'

import { transform as transformTS } from '../../../packages/db-mongodb/src/utilities/transform.js'
import { getLiveTransformBinding } from './native.js'
import { createWorld } from './world.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir =
  process.env.PAYLOAD_RS_LIVE_TRANSFORM_FIXTURES ||
  path.resolve(dirname, '../mongo-transform/fixtures')

const BSON = (mongoose.mongo as any).BSON

type Graph = { objects: unknown[]; root: unknown }

/** Decodes a `serializeForEngine` graph (with `$ref` sharing) into fresh live objects. */
const decodeGraph = (graph: Graph, fn: (id: number) => unknown) => {
  const refs = new Map<number, unknown>()
  const setKey = (out: object, key: string, value: unknown) =>
    Object.defineProperty(out, key, { configurable: true, enumerable: true, value, writable: true })
  const container = (v: unknown, fill: (out: unknown) => void): unknown => {
    const typed = leaf(v)
    if (typed !== NOT_LEAF) {
      return typed
    }
    if (Array.isArray(v)) {
      const out: unknown[] = []
      fill(out)
      v.forEach((item, i) => {
        out[i] = decode(item)
      })
      return out
    }
    const entries = Object.entries(v as object)
    const source =
      entries.length === 1 && entries[0]![0] === '$obj' ? (entries[0]![1] as object) : v
    const out = {}
    fill(out)
    for (const [key, item] of Object.entries(source as object)) {
      setKey(out, key, decode(item))
    }
    return out
  }
  const NOT_LEAF = Symbol('notLeaf')
  const leaf = (v: unknown): unknown => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return NOT_LEAF
    }
    const entries = Object.entries(v)
    if (entries.length !== 1) {
      return NOT_LEAF
    }
    const [key, inner] = entries[0]! as [string, any]
    switch (key) {
      case '$bigint':
        return BigInt(inner)
      case '$binary':
        return new BSON.Binary(Buffer.from(inner.base64, 'base64'), inner.subType)
      case '$buffer':
        return Buffer.from(inner, 'base64')
      case '$date':
        return new Date(inner === null ? Number.NaN : inner)
      case '$decimal':
        return BSON.Decimal128.fromString(inner)
      case '$fn':
        return fn(inner)
      case '$num':
        return Number(inner)
      case '$oid':
        return new mongoose.Types.ObjectId(inner)
      case '$regex':
        return new RegExp(inner.source, inner.flags)
      case '$undefined':
        return undefined
    }
    return NOT_LEAF
  }
  const decode = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') {
      return v
    }
    if (!Array.isArray(v)) {
      const entries = Object.entries(v)
      if (entries.length === 1 && entries[0]![0] === '$ref') {
        const id = entries[0]![1] as number
        if (refs.has(id)) {
          return refs.get(id)
        }
        return container(graph.objects[id], (out) => refs.set(id, out))
      }
    }
    return container(v, () => {})
  }
  return decode(graph.root)
}

type Recorded = {
  before: Graph
  config: number
  error: { message: string; name: null | string } | null
  fields: number
  file: string
  flags: Record<string, boolean>
  meta: Graph
  ret: string
}

const load = () => {
  const calls: Recorded[] = []
  const configs = new Map<string, unknown>()
  const fields = new Map<string, unknown>()
  if (!fs.existsSync(fixturesDir)) {
    return { calls, configs, fields }
  }
  for (const suite of fs.readdirSync(fixturesDir)) {
    const dir = path.join(fixturesDir, suite)
    if (!fs.statSync(dir).isDirectory()) {
      continue
    }
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
      const file = `${suite}/${name}`
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        const entry = JSON.parse(line)
        const placeholder = (id: number) => {
          const f = function recordedFunction() {}
          Object.defineProperty(f, 'name', { value: `fn${id}` })
          return f
        }
        if (entry.t === 'config') {
          configs.set(`${file}:${entry.id}`, decodeGraph(entry.graph, placeholder))
        } else if (entry.t === 'fields') {
          if (entry.ref) {
            const config = configs.get(`${file}:${entry.config}`) as Record<string, any>
            fields.set(`${file}:${entry.id}`, config[entry.ref[0]][entry.ref[1]].fields)
          } else {
            fields.set(`${file}:${entry.id}`, decodeGraph(entry.graph, placeholder))
          }
        } else if (entry.t === 'call') {
          calls.push({ ...entry, file })
        }
      }
    }
  }
  return { calls, configs, fields }
}

const rs = getLiveTransformBinding()

const run = (
  w: World,
  impl: (args: any) => unknown,
  call: Recorded,
  corpus: ReturnType<typeof load>,
) => {
  const fns = new Map<number, unknown>()
  const placeholder = (id: number) => {
    if (!fns.has(id)) {
      const f = function recordedFunction() {}
      Object.defineProperty(f, 'name', { value: `fn${id}` })
      fns.set(id, f)
    }
    return fns.get(id)
  }
  const state = w.wrap(decodeGraph(call.before, placeholder) as Record<string, unknown>, 'state')
  const meta = decodeGraph(call.meta, placeholder) as Record<string, unknown>
  const config = corpus.configs.get(`${call.file}:${call.config}`)
  const adapter = w.shallowWrap({ payload: { config }, ...call.flags }, 'adapter')
  const args = w.shallowWrap(
    {
      $addToSet: state.$addToSet,
      $inc: state.$inc,
      $pull: state.$pull,
      $push: state.$push,
      adapter,
      data: state.data,
      fields: corpus.fields.get(`${call.file}:${call.fields}`),
      globalSlug: meta.globalSlug,
      operation: meta.operation,
      parentIsLocalized: meta.parentIsLocalized,
      validateRelationships: meta.validateRelationships,
    },
    'args',
  )
  let result: unknown
  let error: unknown
  let threw = false
  w.start()
  try {
    result = impl(args)
  } catch (e) {
    threw = true
    error = e
  }
  w.stop()
  return {
    error,
    json: JSON.stringify({
      error: threw ? w.describeError(error) : undefined,
      events: w.events,
      result: w.describe({ result }).result,
      state: w.describe({ state }),
      threw,
    }),
    result,
    threw,
  }
}

describe('payload-mongo-live-transform recorded corpus regression', () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: new Date('2026-01-02T03:04:05.678Z'), toFake: ['Date'] })
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('should match upstream on every recorded call', () => {
    const corpus = load()
    let events = 0
    let tsDeviatesFromRecording = 0
    const mismatches: string[] = []
    for (const call of corpus.calls) {
      const ts = run(createWorld(), transformTS as any, call, corpus)
      const native = run(createWorld(), rs.transform, call, corpus)
      events += (JSON.parse(ts.json).events as unknown[]).length
      const recordedRet = call.ret
      const tsRet = ts.threw
        ? undefined
        : ts.result === null
          ? 'null'
          : ts.result === undefined
            ? 'undefined'
            : 'other'
      const tsError = ts.threw
        ? { message: (ts.error as Error)?.message, name: (ts.error as Error)?.name ?? null }
        : null
      if (
        call.error
          ? JSON.stringify([tsError?.name, tsError?.message]) !==
            JSON.stringify([call.error.name, call.error.message])
          : ts.threw || tsRet !== recordedRet
      ) {
        tsDeviatesFromRecording++
        if (tsDeviatesFromRecording <= 10) {
          console.log(
            `  TS deviates ${call.file}: recorded ${JSON.stringify(call.error)} / ${recordedRet}, now ${JSON.stringify(tsError)} / ${tsRet}`,
          )
        }
      }
      if (ts.json !== native.json) {
        mismatches.push(
          `${call.file}: ts ${ts.json.slice(0, 1500)}\n rs ${native.json.slice(0, 1500)}`,
        )
      }
    }
    console.log(
      `[live-transform] recorded corpus: ${corpus.calls.length} calls from ${fixturesDir}, ${events} recorded operations, ${mismatches.length} mismatches, ${tsDeviatesFromRecording} TS runs deviating from the recording`,
    )
    for (const m of mismatches.slice(0, 3)) {
      console.log(`  MISMATCH ${m}`)
    }
    expect(corpus.calls.length).toBeGreaterThan(1000)
    expect(tsDeviatesFromRecording).toBe(0)
    expect(mismatches).toEqual([])
  })
})
