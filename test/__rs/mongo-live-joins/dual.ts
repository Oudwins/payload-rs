/**
 * In-situ differential of the joins ports: upstream's `buildJoinAggregation` / `resolveJoins`
 * imports are redirected here (vitest.config.ts). `RS_LIVE_JOINS_MODE`:
 *
 * - `dual` (default): every call runs upstream TS on the caller's inputs and the Rust port on a
 *   snapshot (plain objects / arrays of the mutable inputs copied before the TS run), both traced
 *   (tracer.ts); the outcome is appended to `RS_LIVE_JOINS_REPORT` (JSONL) and the TS outcome is
 *   returned, so the suite runs upstream's behaviour;
 * - `self`: the same with upstream TS as the candidate too (determinism check of the harness);
 * - `rs`: only the Rust port (the suite runs on it);
 * - `ts`: only upstream.
 */
import fs from 'node:fs'

import { engineEntries, rsJoins } from './glue.js'
import { clonePlain, diffOutcomes, runSide } from './tracer.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- upstream signatures */
type Any = any

const mode = process.env.RS_LIVE_JOINS_MODE ?? 'dual'
const reportFile = process.env.RS_LIVE_JOINS_REPORT

const report = (entry: Record<string, unknown>) => {
  if (reportFile) {
    fs.appendFileSync(reportFile, `${JSON.stringify(entry)}\n`)
  }
}

/** Keys of the args whose values the functions mutate or that callers may reuse (copied for the candidate). */
const mutable = ['docs', 'joins', 'projection', 'query'] as const

export const dualRun = async (
  name: 'buildJoinAggregation' | 'resolveJoins',
  upstream: (args: Any) => Promise<Any>,
  args: Any,
): Promise<Any> => {
  if (mode === 'ts') {
    return upstream(args)
  }
  if (mode === 'rs') {
    return rsJoins()[name](args)
  }
  const snapshot: Record<string, Any> = { ...args }
  for (const k of mutable) {
    if (k in snapshot) {
      snapshot[k] = clonePlain(snapshot[k])
    }
  }
  const inputs = (a: Record<string, Any>) => {
    const out: Record<string, Any> = {}
    for (const k of Object.keys(a)) {
      if (typeof a[k] === 'object' && a[k] !== null) {
        out[k] = a[k]
      }
    }
    return out
  }
  const call = (fn: (args: Any) => Promise<Any>, a: Record<string, Any>) => (w: Record<string, Any>) =>
    fn({ ...a, ...w })

  const ts = await runSide('ts', inputs(args), call(upstream, args))
  const before = engineEntries()
  const candidate = mode === 'self' ? upstream : (a: Any) => rsJoins()[name](a)
  const rs = await runSide('rs', inputs(snapshot), call(candidate, snapshot))
  const reachedRust = engineEntries() > before
  const diff = diffOutcomes(ts, rs)
  report({
    candidate: mode === 'self' ? 'ts' : 'rs',
    diff,
    events: ts.events.length,
    name,
    ok: diff === undefined,
    reachedRust,
    threw: ts.threw,
    useJoinAggregations: args.adapter?.useJoinAggregations,
  })
  if (ts.threw) {
    throw ts.thrown
  }
  return ts.value
}
