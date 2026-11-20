/**
 * Rough timing of the Rust port vs upstream on realistic documents (read and write). Skipped
 * unless PAYLOAD_RS_LIVE_TRANSFORM_BENCH=true.
 */
import { describe, expect, it } from 'vitest'

import { transform as transformTS } from '../../../packages/db-mongodb/src/utilities/transform.js'
import { configs, fields, hex, oid } from './cases.js'
import { getLiveTransformBinding } from './native.js'

const isEnabled = process.env.PAYLOAD_RS_LIVE_TRANSFORM_BENCH === 'true'

const readDoc = () => ({
  _id: oid(1),
  __v: 0,
  array: [
    { date: new Date(1), id: 'a', rel: oid(2) },
    { date: new Date(2), id: 'b', relMany: [oid(3), oid(4)] },
  ],
  blocks: [{ blockType: 'inline', rel: oid(5), title: 't' }],
  count: 1,
  date: new Date(0),
  group: { count: 2, rel: oid(6) },
  rel: oid(7),
  relMany: [oid(8), oid(9), oid(10)],
  tab: { count: 3 },
  title: 'title',
})

const writeDoc = () => ({
  array: [{ rel: hex(2) }, { relMany: [hex(3), hex(4)] }],
  count: 1,
  group: { count: 2, rel: hex(6) },
  rel: hex(7),
  relMany: [hex(8), hex(9), hex(10)],
  title: 'title',
})

const time = (fn: () => void, n: number) => {
  const start = process.hrtime.bigint()
  for (let i = 0; i < n; i++) {
    fn()
  }
  return Number(process.hrtime.bigint() - start) / 1e3 / n
}

describe.skipIf(!isEnabled)('payload-mongo-live-transform timing', () => {
  it('should report µs per call for TS and Rust', () => {
    const rs = getLiveTransformBinding()
    const adapter = { payload: { config: configs.plain } }
    const n = 5000
    for (const [label, make, operation] of [
      ['read', readDoc, 'read'],
      ['write', writeDoc, 'write'],
    ] as const) {
      const docs = () => Array.from({ length: n }, make)
      const tsDocs = docs()
      const rsDocs = docs()
      let i = 0
      const ts = time(
        () => transformTS({ adapter, data: tsDocs[i++]!, fields, operation } as any),
        n,
      )
      i = 0
      const native = time(() => rs.transform({ adapter, data: rsDocs[i++]!, fields, operation }), n)
      console.log(
        `[live-transform] ${label}: ts ${ts.toFixed(1)} µs, rs ${native.toFixed(1)} µs per document`,
      )
      expect(native).toBeGreaterThan(0)
    }
  })
})
