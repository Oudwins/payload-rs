#!/usr/bin/env node
/**
 * Adds up the events of HTTP fast path shadow runs (./shadow.ts, PAYLOAD_RS_HTTP_SHADOW_REPORT).
 *
 *   node test/__rs/http-lanes/summarize.mjs <report.jsonl>...
 *
 * Prints the count per event and every divergence; exits 1 when there is a divergence or when a
 * fast path never ran (no `jwt:hit`, no `parse:hit`, no `validate:laneRepeat`; with `--bytes`,
 * no `bytes:hit:*`).
 */
import fs from 'node:fs'

const isBytes = process.argv.includes('--bytes')
const files = process.argv.slice(2).filter((arg) => arg !== '--bytes')
if (!files.length) {
  console.error('usage: summarize.mjs <report.jsonl>...')
  process.exit(2)
}

const counts = {}
const divergences = []
for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) {
      continue
    }
    const entry = JSON.parse(line)
    counts[entry.event] = (counts[entry.event] ?? 0) + 1
    if (entry.event.endsWith(':divergence')) {
      divergences.push(entry)
    }
  }
}

for (const [event, count] of Object.entries(counts).sort()) {
  console.log(`${event.padEnd(24)} ${count}`)
}
for (const divergence of divergences.slice(0, 50)) {
  console.log(`DIVERGENCE ${JSON.stringify(divergence).slice(0, 2000)}`)
}

const missing = ['jwt:hit', 'parse:hit', 'validate:laneRepeat'].filter((event) => !counts[event])
if (isBytes && !Object.keys(counts).some((event) => event.startsWith('bytes:hit:'))) {
  missing.push('bytes:hit:*')
}
if (missing.length) {
  console.log(`fast path never ran: ${missing.join(', ')}`)
}
process.exit(divergences.length || missing.length ? 1 : 0)
