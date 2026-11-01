#!/usr/bin/env node
/**
 * Compares the outcome files two runs of test/__rs/core-mongo/objectid/objectid.int.spec.ts wrote
 * (`RS_CORE_MONGO_OUTCOMES`): the TS reference and the `PAYLOAD_CORE_ENGINE=rs` run. Exits 1 on a
 * missing or empty file, the same file given twice (a run compared with itself proves nothing) or
 * any differing outcome.
 *
 *   node test/__rs/core-mongo/compareOutcomes.mjs <ts.json> <rs.json>
 */
import fs from 'node:fs'
import path from 'node:path'

const [tsFile, rsFile] = process.argv.slice(2)
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
const ts = read(tsFile)
const rs = read(rsFile)
let failed = false
if (!ts?.length || !rs?.length) {
  console.log(`FAIL missing or empty outcomes (ts ${ts?.length}, rs ${rs?.length})`)
  process.exit(1)
}
if (path.resolve(tsFile) === path.resolve(rsFile)) {
  console.log('FAIL the two outcome files are the same file')
  process.exit(1)
}
let differing = 0
for (let i = 0; i < Math.max(ts.length, rs.length); i++) {
  if (ts[i] !== rs[i]) {
    differing++
    if (differing <= 10) {
      console.log(`DIFF #${i}\n  ts: ${ts[i]?.slice(0, 1500)}\n  rs: ${rs[i]?.slice(0, 1500)}`)
    }
    failed = true
  }
}
const errors = ts.filter((o) => / err /.test(o.split(' seen ')[0])).length
console.log(
  `${ts.length} outcomes compared (${errors} errors in the reference), ${differing} differ`,
)
process.exit(failed ? 1 : 0)
