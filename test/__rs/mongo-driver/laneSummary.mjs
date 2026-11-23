#!/usr/bin/env node
/**
 * Sums the driver lane counters of a mongo-harness run (`<out>/stats/<file>/mongo-engine-<pid>.json`,
 * written by packages/engine-rs/src/mongo-adapter): reads served by the Rust driver per method,
 * reads handed to the mongoose lane per reason, and (with PAYLOAD_MONGO_DRIVER_VERIFY) the lane
 * differential's comparisons and divergences.
 *
 *   node test/__rs/mongo-driver/laneSummary.mjs /tmp/rs-mongo-runs/<tag> [--divergences]
 *
 * Exits 1 when a divergence was recorded.
 */
import fs from 'node:fs'
import path from 'node:path'

const [outDir, ...flags] = process.argv.slice(2)
if (!outDir) {
  console.error('usage: laneSummary.mjs <run out dir> [--divergences]')
  process.exit(2)
}
const statsRoot = path.join(outDir, 'stats')
const add = (target, source) => {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value
  }
}
const total = { compared: {}, divergent: {}, fallback: {}, served: {} }
const divergences = []
const perFile = []
for (const file of fs.existsSync(statsRoot) ? fs.readdirSync(statsRoot) : []) {
  const fileTotals = { served: 0, divergent: 0 }
  for (const name of fs.readdirSync(path.join(statsRoot, file))) {
    if (!/^mongo-engine-\d+\.json$/.test(name)) continue
    let stats
    try {
      stats = JSON.parse(fs.readFileSync(path.join(statsRoot, file, name), 'utf8'))
    } catch {
      continue
    }
    const lane = stats.driverLane
    if (!lane) continue
    add(total.served, lane.served)
    for (const [method, reasons] of Object.entries(lane.fallback ?? {})) {
      for (const [reason, count] of Object.entries(reasons)) {
        const key = `${method}: ${reason}`
        total.fallback[key] = (total.fallback[key] ?? 0) + count
      }
    }
    fileTotals.served += Object.values(lane.served ?? {}).reduce((a, b) => a + b, 0)
    if (lane.verify) {
      add(total.compared, lane.verify.compared)
      add(total.divergent, lane.verify.divergent)
      add((total.raced ??= {}), lane.verify.raced)
      fileTotals.divergent += Object.values(lane.verify.divergent ?? {}).reduce((a, b) => a + b, 0)
      for (const divergence of lane.verify.divergences ?? []) {
        divergences.push({ file, ...divergence })
      }
    }
  }
  perFile.push({ file, ...fileTotals })
}
const sum = (record) => Object.values(record).reduce((a, b) => a + b, 0)
console.log(`served by the driver: ${sum(total.served)}`, total.served)
console.log(`mongoose lane: ${sum(total.fallback)}`)
for (const [key, count] of Object.entries(total.fallback).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}\t${key}`)
}
if (sum(total.compared)) {
  console.log(`verified: ${sum(total.compared)}`, total.compared)
  console.log(`divergent: ${sum(total.divergent)}`, total.divergent)
  console.log(`raced (lane rerun equals the reference): ${sum(total.raced ?? {})}`)
}
for (const entry of perFile.filter((entry) => entry.divergent)) {
  console.log(`  ${entry.file}: ${entry.divergent} divergent of ${entry.served} served`)
}
if (flags.includes('--divergences')) {
  for (const divergence of divergences) {
    console.log(`\n${divergence.file} ${divergence.method} ${divergence.path}`)
    console.log(`  lane:      ${divergence.lane.slice(0, 600)}`)
    console.log(`  reference: ${divergence.reference.slice(0, 600)}`)
  }
}
process.exit(sum(total.divergent) ? 1 : 0)
