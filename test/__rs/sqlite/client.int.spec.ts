/**
 * Differential test: every scenario runs once through `@libsql/client` and
 * once through the Rust runtime (`packages/engine-rs/src/sqlite`), each on its
 * own database file, and the described outcomes must be identical.
 *
 * Run: SQLITE_URL=file:/tmp/rs-sqlite-runtime.db pnpm vitest run --project int test/__rs/sqlite/client.int.spec.ts
 */
import { createClient as createLibsqlClient } from '@libsql/client'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  createClient as createRustClient,
  getNativeSqlite,
  getSqliteConnId,
} from '../../../packages/engine-rs/src/sqlite/index.js'
import { describeValue } from './describe.js'
import { type EngineQuery, orderingScenarios } from './ordering.js'
import { referenceScenarios } from './reference.js'
import {
  configCases,
  type CreateClient,
  type Log,
  makeStep,
  mathScenario,
  scenarios,
} from './scenarios.js'

const dir = '/tmp/rs-sqlite-diff'
fs.mkdirSync(dir, { recursive: true })

const freshUrl = (name: string, impl: string) => {
  const file = `${dir}/${name.replace(/\W+/g, '_')}-${impl}.db`
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(file + suffix, { force: true })
  }
  return `file:${file}`
}

const runScenario = async (
  scenario: (typeof scenarios)[number],
  impl: string,
  createClient: CreateClient,
) => {
  const log: Log = []
  await scenario.run({ createClient, step: makeStep(log), url: freshUrl(scenario.name, impl) })
  return log
}

describe('Rust SQLite runtime vs @libsql/client', () => {
  // Runs first: later scenarios leave unfinished transactions open until GC.
  it('runs one worker for the process and stops it once nothing is open', async () => {
    const workers = () => getNativeSqlite().sqliteStats()[1]
    const waitForWorkers = async (expected: number) => {
      for (let i = 0; i < 200 && workers() !== expected; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      return workers()
    }
    expect(await waitForWorkers(0)).toBe(0)
    const a = createRustClient({ url: freshUrl('workers-a', 'rs') })
    const b = createRustClient({ url: freshUrl('workers-b', 'rs') })
    for (let i = 0; i < 20; i++) {
      const tx = await a.transaction()
      await tx.execute('select 1')
      await tx.commit()
      expect(workers()).toBeLessThanOrEqual(1)
    }
    await b.execute('select 1')
    expect(workers()).toBe(1)
    a.close()
    b.close()
    expect(await waitForWorkers(0)).toBe(0)
  })

  for (const scenario of [...scenarios, mathScenario, ...referenceScenarios]) {
    it(scenario.name, async () => {
      const expected = await runScenario(scenario, 'libsql', createLibsqlClient as CreateClient)
      const actual = await runScenario(scenario, 'rs', createRustClient as CreateClient)
      expect(expected.length).toBeGreaterThan(0)
      expect(actual).toEqual(expected)
    })
  }

  const libsqlQuery: EngineQuery = async (target, sql) =>
    (await target.execute(sql)).rows.map((row: unknown[]) =>
      row[0] === null ? null : String(row[0]),
    )
  const rustQuery: EngineQuery = (target, sql) =>
    getNativeSqlite().sqliteEngineQuery(getSqliteConnId(target), sql)

  for (const scenario of orderingScenarios) {
    it(`ordering: ${scenario.name}`, async () => {
      const run = async (impl: string, createClient: CreateClient, query: EngineQuery) => {
        const log: Log = []
        await scenario.run({
          createClient,
          log,
          query,
          url: freshUrl(`ordering ${scenario.name}`, impl),
        })
        return log
      }
      const expected = await run('libsql', createLibsqlClient as CreateClient, libsqlQuery)
      const actual = await run('rs', createRustClient as CreateClient, rustQuery)
      expect(expected.length).toBeGreaterThan(0)
      expect(actual).toEqual(expected)
    })
  }

  it('config validation', () => {
    const run = (createClient: CreateClient) =>
      configCases.map(([label, config]) => {
        try {
          const client = createClient(config)
          client.close()
          return [label, 'ok']
        } catch (e) {
          return [label, describeValue(e)]
        }
      })
    const expected = run(createLibsqlClient as CreateClient)
    expect(expected.length).toBeGreaterThan(0)
    expect(run(createRustClient as CreateClient)).toEqual(expected)
  })
})
