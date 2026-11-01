/**
 * Replays every recorded call of the read-transform fixtures through the REAL TypeScript
 * `transform` (packages/drizzle/src/transform/read) in the current process time zone and writes
 * the per-zone expectations `fixtures/tz/<Zone_Name>.json` used by
 * `cargo test -p payload-sql-read` (tests/fixtures.rs, tests/schema_linked.rs).
 *
 * A fixture's stored outputs are the TS outputs in its capture zone (`timeZone`). For another zone,
 * the overlay lists the calls whose TS output differs there (only local-time date parsing differs).
 * When the process zone equals a fixture's capture zone the replay must reproduce every stored
 * output exactly; any difference fails the run (proves the replay is faithful).
 *
 *   for tz in UTC Europe/Lisbon America/New_York; do
 *     TZ=$tz pnpm tsx test/__rs/read/capture/replay.ts
 *   done
 * Optional args: fixture names to limit the replay (no overlay is written then).
 */
import fs from 'fs'
import path from 'path'

import { transform } from '../../../../packages/drizzle/src/transform/read/index.js'
import { InternalBlockTableNameIndex } from '../../../../packages/drizzle/src/utilities/validateExistingBlockIsIdentical.js'
import { decodeTree, encodeTree } from './encode.js'
import { decodeGraph, resolvePath, walkObjects } from './graph.js'

const fixturesDir = path.resolve(import.meta.dirname, '../fixtures')
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
const only = process.argv.slice(2)

const listFixtures = (): string[] => {
  const names: string[] = []
  for (const sub of ['', 'schema-linked']) {
    const dir = path.join(fixturesDir, sub)
    if (!fs.existsSync(dir)) {
      continue
    }
    for (const file of fs.readdirSync(dir).sort()) {
      if (file.endsWith('.json')) {
        names.push(path.join(sub, file.replace(/\.json$/, '')))
      }
    }
  }
  return names.filter((name) => only.length === 0 || only.includes(name))
}

/** Turns the recorder's `__rsBlockTableNameIndex` back into `block[InternalBlockTableNameIndex]`. */
const restoreBlockIndexes = (root: unknown) => {
  walkObjects(root, (value) => {
    if (Object.prototype.hasOwnProperty.call(value, '__rsBlockTableNameIndex')) {
      value[InternalBlockTableNameIndex] = value.__rsBlockTableNameIndex
      delete value.__rsBlockTableNameIndex
    }
  })
  return root
}

const buildContexts = (fixture: any, isLinked: boolean) =>
  fixture.contexts.map((context: any) => {
    if (isLinked) {
      const root = decodeGraph(context.graph)
      for (const [blockPath, index] of context.blockIndexes) {
        resolvePath(root, blockPath)[InternalBlockTableNameIndex] = index
      }
      const config = root.config
      return {
        adapter: {
          blocksAsJSON: context.blocksAsJSON,
          payload: { blocks: root.blocks, collections: root.collections, config },
          tableNameMap: new Map(Object.entries(context.tableNameMap)),
        },
        config,
        fields: root.fields,
      }
    }
    const config = decodeGraph(context.config)
    return {
      adapter: {
        blocksAsJSON: context.blocksAsJSON,
        payload: {
          blocks: restoreBlockIndexes(decodeGraph(context.blocks)),
          collections: context.collections,
          config,
        },
        tableNameMap: new Map(Object.entries(context.tableNameMap)),
      },
      config,
      fields: undefined,
    }
  })

const replayCall = (call: any, context: any, fields: unknown) => {
  try {
    const result = transform({
      adapter: context.adapter,
      config: context.config,
      data: decodeTree(call.data) as Record<string, unknown>,
      fields: fields as any,
      joinQuery: decodeTree(call.joinQuery) as any,
      parentIsLocalized: decodeTree(call.parentIsLocalized) as boolean,
      tableName: call.tableName,
    })
    return { output: encodeTree(result) }
  } catch (error) {
    return {
      error: {
        message: (error as Error)?.message,
        name: (error as Error)?.constructor?.name ?? 'Error',
      },
    }
  }
}

const sameOutcome = (call: any, outcome: any) => {
  if ('error' in call) {
    return 'error' in outcome && outcome.error.name === call.error.name
  }
  return 'output' in outcome && JSON.stringify(outcome.output) === JSON.stringify(call.output)
}

const overlay: Record<
  string,
  { calls: number; captureTimeZone: string; overrides: Record<string, unknown> }
> = {}
let total = 0
let differing = 0
const fidelityFailures: string[] = []

for (const name of listFixtures()) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8'))
  const isLinked = name.startsWith('schema-linked')
  const captureZone: string = fixture.timeZone
  const contexts = buildContexts(fixture, isLinked)
  const fieldsCache = new Map<number, unknown>()
  const fieldsFor = (call: any) => {
    if (isLinked) {
      return contexts[call.context].fields[call.fields]
    }
    if (!fieldsCache.has(call.fields)) {
      fieldsCache.set(call.fields, restoreBlockIndexes(decodeGraph(fixture.fields[call.fields])))
    }
    return fieldsCache.get(call.fields)
  }
  const overrides: Record<string, unknown> = {}
  fixture.calls.forEach((call: any, i: number) => {
    const outcome = replayCall(call, contexts[call.context], fieldsFor(call))
    total++
    if (!sameOutcome(call, outcome)) {
      differing++
      if (captureZone === zone) {
        fidelityFailures.push(`${name}#${i}`)
      }
      overrides[i] = outcome
    }
  })
  overlay[name] = { calls: fixture.calls.length, captureTimeZone: captureZone, overrides }
  console.log(
    `[rs-read replay ${zone}] ${name} (captured in ${captureZone}): ${Object.keys(overrides).length} of ${fixture.calls.length} differ`,
  )
}

console.log(
  `[rs-read replay ${zone}] TOTAL ${total} calls, ${differing} differ from the stored outputs`,
)
if (fidelityFailures.length) {
  console.error(
    `replay does not reproduce outputs in their capture zone: ${fidelityFailures.slice(0, 20).join(', ')}`,
  )
  process.exit(1)
}
if (only.length === 0) {
  const tzDir = path.join(fixturesDir, 'tz')
  fs.mkdirSync(tzDir, { recursive: true })
  const file = path.join(tzDir, `${zone.replace(/\//g, '_')}.json`)
  fs.writeFileSync(file, JSON.stringify({ version: 1, timeZone: zone, fixtures: overlay }))
  console.log(`[rs-read replay ${zone}] wrote ${path.relative(process.cwd(), file)}`)
}
