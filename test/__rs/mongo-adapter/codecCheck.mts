/**
 * Round trip of the mongo boundary codec with real bson values:
 *   node --experimental-strip-types test/__rs/mongo-adapter/codecCheck.mts
 * encodeMongoTree (engine-bound, codec.ts) -> JSON -> deserializeFromEngine with the call's
 * BsonBoundary (serialize.ts) must give back equal typed values and the same host objects.
 */
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'

import {
  createArgsBoundary,
  createHostObjects,
  createResultBoundary,
  encodeMongoTree,
  getBsonClasses,
} from '../../../packages/engine-rs/src/mongo-adapter/codec.ts'
import { deserializeFromEngine } from '../../../packages/engine-rs/src/serialize.ts'

const mongoose = createRequire(
  new URL('../../../packages/db-mongodb/package.json', import.meta.url),
)('mongoose')
const B = mongoose.mongo.BSON
const classes = getBsonClasses({ connection: mongoose.createConnection() })
const registry = { functions: [] as Function[] }
const session = { endSession() {}, inTransaction: () => true }
const doc = new (class Doc {
  a = 1
})()
const value = {
  arr: [new B.ObjectId(), { $regex: 1 }],
  bad: new Date(NaN),
  big: 5n,
  bin: new B.Binary(Buffer.from('hey'), 4),
  buf: Buffer.from([1, 2, 3]),
  d: new Date(1),
  dec: B.Decimal128.fromString('1.50'),
  esc: { $oid: 'x' },
  id: new B.ObjectId(),
  inf: Infinity,
  long: B.Long.fromNumber(7),
  r: /a.b/gi,
  s: session,
  u: undefined,
}

const roundTrip = (kind: 'args' | 'result', input: unknown) => {
  const hostObjects = createHostObjects()
  const boundary = (kind === 'args' ? createArgsBoundary : createResultBoundary)({
    classes,
    hostObjects,
  })
  const tree = encodeMongoTree({ hostObjectID: boundary.hostObjectID, registry, value: input })
  return {
    back: deserializeFromEngine(JSON.parse(JSON.stringify(tree)), registry, boundary) as any,
    tree,
  }
}

const { back, tree } = roundTrip('args', value)
console.log(JSON.stringify(tree))
const result = roundTrip('result', { doc, plain: { a: 1 } })
const checks = {
  binary:
    back.bin instanceof B.Binary && back.bin.sub_type === 4 && back.bin.buffer.toString() === 'hey',
  buffer: Buffer.isBuffer(back.buf) && !(back.buf instanceof B.Binary),
  bufferMarker: (tree as any).buf.$buffer === 'AQID',
  decimal: back.dec instanceof B.Decimal128 && back.dec.toString() === '1.50',
  deepEqual: isDeepStrictEqual(back, value),
  escape: isDeepStrictEqual(back.esc, { $oid: 'x' }),
  invalidDate: Number.isNaN(back.bad.getTime()),
  longIsHandle: back.long === value.long && (tree as any).long.$hostObject === 0,
  oid: back.id instanceof B.ObjectId && back.id.equals(value.id),
  resultClassInstanceIsHandle:
    result.back.doc === doc && (result.tree as any).doc.$hostObject === 0,
  resultPlainIsData: isDeepStrictEqual(result.back.plain, { a: 1 }),
  sessionIsHandle: back.s === session,
  // must fail on a wrong decoder: decoding without the boundary leaves markers as plain data
  withoutBoundaryDiffers: !isDeepStrictEqual(
    deserializeFromEngine(JSON.parse(JSON.stringify(tree)), registry),
    value,
  ),
}
console.log(checks)
if (Object.values(checks).some((ok) => !ok)) {
  process.exit(1)
}
