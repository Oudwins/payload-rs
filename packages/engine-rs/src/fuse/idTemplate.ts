import { randomBytes } from 'node:crypto'

/**
 * Serialized MongoDB commands built once for a sentinel id and given each call's id by replacing
 * the sentinel's bytes (the fused writes' by-id statements, src/fuse-write/mongo.ts; the fused
 * reads' by-id `findOne`, ./mongo.ts).
 *
 * The id the templates are built with (a valid ObjectId: the casting takes the branches of any
 * ObjectId id); a call's id replaces it byte for byte, as 12 ObjectId bytes and as 24 hex
 * characters (inside strings too, e.g. the preferences key).
 */
export const sentinelHex = randomBytes(12).toString('hex')
const sentinelBytes = Buffer.from(sentinelHex, 'hex')
const sentinelText = Buffer.from(sentinelHex, 'latin1')

export type Template = { bytes: Buffer; hex: number[]; raw: number[] }

const positionsOf = (bytes: Buffer, needle: Buffer) => {
  const positions: number[] = []
  for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) {
    positions.push(at)
  }
  return positions
}

export const toTemplate = (bytes: Buffer): Template => ({
  bytes,
  hex: positionsOf(bytes, sentinelText),
  raw: positionsOf(bytes, sentinelBytes),
})

/** `template` with the id `hex` (24 lowercase hex characters) in the sentinel's places. */
export const withID = ({ bytes, hex: hexAt, raw }: Template, hex: string) => {
  const out = Buffer.from(bytes)
  const idBytes = Buffer.from(hex, 'hex')
  for (const at of raw) {
    idBytes.copy(out, at)
  }
  for (const at of hexAt) {
    out.write(hex, at, 'latin1')
  }
  return out
}
