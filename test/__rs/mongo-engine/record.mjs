#!/usr/bin/env node
/**
 * Records the data methods of @payloadcms/db-mongodb (recorder.ts) during upstream int runs on
 * MongoDB with the TS engine, one vitest process per spec file, each on its own database (dropped
 * afterwards). Replay: crates/payload-mongo-engine/tests/replay.rs.
 *
 *   node test/__rs/mongo-engine/record.mjs [--out <dir>] [--jobs <n>] [--tag <prefix>]
 *     [--no-aggregations] <spec files...>
 *
 * Default out: /tmp/rs-mongoengine-fixtures. Per file `<label>-<pid>/` holds config-<n>.json and
 * calls.ndjson; logs go to <out>/logs.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  dropDatabases,
  mongoUrlFor,
} from '../../../packages/engine-rs/scripts/mongo/mongoDatabases.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const argv = process.argv.slice(2)
const options = {
  jobs: 1,
  noAggregations: false,
  out: '/tmp/rs-mongoengine-fixtures',
  tag: `rsme${process.pid}`,
}
const files = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--out') options.out = path.resolve(argv[++i])
  else if (arg === '--jobs') options.jobs = Number(argv[++i])
  else if (arg === '--tag') options.tag = argv[++i]
  else if (arg === '--no-aggregations') options.noAggregations = true
  else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
  else files.push(arg)
}
if (!files.length) {
  throw new Error('no spec files')
}
fs.mkdirSync(path.join(options.out, 'logs'), { recursive: true })

const runFile = (file, index) =>
  new Promise((resolve) => {
    const db = `${options.tag}_${options.noAggregations ? 'n' : 'a'}${index}`
    const label = `${options.noAggregations ? 'noagg-' : ''}${file
      .replace(/^test\//, '')
      .replace(/\.int\.spec\.ts$|\.spec\.ts$/, '')
      .replace(/[/]/g, '_')}`
    const log = fs.openSync(path.join(options.out, 'logs', `${label}.log`), 'w')
    const started = Date.now()
    const env = {
      ...process.env,
      MONGODB_URL: mongoUrlFor(db),
      PAYLOAD_DATABASE: 'mongodb',
      PAYLOAD_RS_MONGO_ENGINE_LABEL: label,
      PAYLOAD_RS_MONGO_ENGINE_RECORD_DIR: options.out,
      PAYLOAD_RS_SKIP_ADAPTER_CODEGEN: 'true',
    }
    // reference side: the TS engine
    env.PAYLOAD_ENGINE = 'ts'
    delete env.PAYLOAD_CORE_ENGINE
    if (options.noAggregations) env.PAYLOAD_RS_MONGO_ENGINE_NO_AGGREGATIONS = 'true'
    else delete env.PAYLOAD_RS_MONGO_ENGINE_NO_AGGREGATIONS
    const child = spawn(
      'pnpm',
      ['test:int', '--config', 'test/__rs/mongo-engine/vitest.config.ts', file],
      {
        cwd: root,
        env,
        stdio: ['ignore', log, log],
      },
    )
    child.on('close', async (code) => {
      fs.closeSync(log)
      await dropDatabases([db]).catch(() => {})
      console.log(`${file}: exit ${code} (${Math.round((Date.now() - started) / 1000)}s)`)
      resolve(code)
    })
  })

const queue = files.map((file, index) => [file, index])
await Promise.all(
  Array.from({ length: Math.max(1, options.jobs) }, async () => {
    while (queue.length) {
      const [file, index] = queue.shift()
      await runFile(file, index)
    }
  }),
)
