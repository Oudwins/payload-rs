#!/usr/bin/env node
/**
 * Runs upstream int spec files on MongoDB (upstream TS engine: PAYLOAD_ENGINE /
 * PAYLOAD_CORE_ENGINE unset) through test/__rs/mongo-transform/vitest.config.ts, recording every
 * `transform` call (./recorder.ts), one database per file (dropped afterwards).
 *
 *   node test/__rs/mongo-transform/record.mjs [--out /tmp/rs-mongo-transform] [--jobs 2] \
 *     [--tag rsmt] [--unit] [files...]
 *
 * Recordings: <out>/<file slug>/<pid>-<thread>.jsonl; logs: <out>/<file slug>.log. Replay with
 *   PAYLOAD_RS_MONGO_TRANSFORM_FIXTURES=<out> cargo test -p payload-mongo-transform --test replay -- --nocapture
 *
 * Suites that spawn child processes importing test/databaseAdapter.js are skipped while
 * /tmp/rs-phase-f-done does not exist (test/__rs/mongo-harness/runSuites.mjs CHILD_PROCESS_SUITES).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  dropDatabases,
  mongoUrlFor,
} from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'

/** Copy of CHILD_PROCESS_SUITES in test/__rs/mongo-harness/runSuites.mjs (a script, not importable). */
const CHILD_PROCESS_SUITES = [
  'test/cli/int.spec.ts',
  'test/create-payload-app/int.spec.ts',
  'test/database/migrations-cli.int.spec.ts',
  'test/llm-instructions/cli.int.spec.ts',
  'test/loader/int.spec.ts',
  'test/plugin-mcp/instructions.int.spec.ts',
  'test/queues/cli.int.spec.ts',
  'test/queues/int.spec.ts',
]

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const argv = process.argv.slice(2)
const options = { jobs: 1, out: '/tmp/rs-mongo-transform', tag: `rsmt${process.pid}`, unit: false }
const files = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--out') options.out = path.resolve(argv[++i])
  else if (arg === '--jobs') options.jobs = Number(argv[++i])
  else if (arg === '--tag') options.tag = argv[++i]
  else if (arg === '--unit') options.unit = true
  else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
  else files.push(arg)
}

const allowChild = fs.existsSync('/tmp/rs-phase-f-done')
const queue = files.filter((file) => {
  if (!allowChild && CHILD_PROCESS_SUITES.includes(file)) {
    console.log(`skip ${file} (spawns child processes; /tmp/rs-phase-f-done missing)`)
    return false
  }
  return true
})
if (options.unit) {
  queue.unshift(
    'packages/db-mongodb/src/utilities/transform.spec.ts',
    'test/__rs/mongo-transform/synthetic.spec.ts',
    'test/__rs/mongo-transform/utilities.spec.ts',
  )
}

const slugOf = (file) => file.replace(/[^a-zA-Z0-9]+/g, '_')
fs.mkdirSync(options.out, { recursive: true })

let counter = 0
const run = (file) =>
  new Promise((resolve) => {
    const slug = slugOf(file)
    const dbName = `${options.tag}_${++counter}`
    const recordDir = path.join(options.out, slug)
    fs.rmSync(recordDir, { force: true, recursive: true })
    const isUnit = !file.endsWith('int.spec.ts')
    const env = {
      ...process.env,
      MONGODB_URL: mongoUrlFor(dbName),
      PAYLOAD_DATABASE: 'mongodb',
      PAYLOAD_RS_MONGO_TRANSFORM_RECORD_DIR: recordDir,
      TZ: 'UTC',
    }
    for (const key of [
      'DATABASE_URL',
      'PAYLOAD_CORE_ENGINE',
      'PAYLOAD_ENGINE',
      'PAYLOAD_ENGINE_ADDON',
    ]) {
      delete env[key]
    }
    const args = isUnit
      ? [
          'vitest',
          'run',
          '--project',
          'unit',
          '--config',
          'test/__rs/mongo-transform/vitest.config.ts',
          file,
        ]
      : [
          'test:int',
          '--config',
          'test/__rs/mongo-transform/vitest.config.ts',
          '--project',
          'int',
          file,
        ]
    const started = Date.now()
    const child = spawn(isUnit ? 'npx' : 'pnpm', args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const log = fs.createWriteStream(path.join(options.out, `${slug}.log`))
    child.stdout.pipe(log)
    child.stderr.pipe(log)
    child.on('close', async (code) => {
      if (!isUnit) {
        await dropDatabases([dbName]).catch(() => {})
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(0)
      console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${file} (${seconds}s, exit ${code})`)
      resolve()
    })
  })

/** Free bytes on the volume of `options.out` (runs stop below 4 GB: the disk is shared). */
const freeBytes = () => {
  const stats = fs.statfsSync(options.out)
  return stats.bavail * stats.bsize
}

const workers = Array.from({ length: Math.max(1, options.jobs) }, async () => {
  while (queue.length) {
    if (freeBytes() < 4e9) {
      console.log(`STOP: less than 4 GB free, ${queue.length} files not run: ${queue.join(' ')}`)
      queue.length = 0
      return
    }
    await run(queue.shift())
  }
})
await Promise.all(workers)
