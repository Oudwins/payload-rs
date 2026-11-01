/**
 * Differential check of the own `undefined` properties of the engine's raw schema
 * (ENGINE_CONTRACT.md, `rawSchema().undefinedProperties`): for every loadable `test/<suite>/config.ts`
 * and id variant, the upstream TS `buildRawSchema` and `SqliteEngine.rawSchema()` with
 * `undefinedProperties` applied must produce the same `rawTables`, compared with own keys in order
 * and `undefined` distinguished from missing keys.
 *
 *   PAYLOAD_ENGINE_ADDON=/tmp/x/payload-engine.node SQLITE_URL=file:/tmp/rs-engine.db \
 *     pnpm test:int:sqlite --config test/__rs/harness/vitest.config.ts \
 *     test/__rs/find/engine/rawSchemaUndefined.int.spec.ts
 */
import type { SanitizedConfig } from 'payload'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { traverseFields } from 'payload'
import { fieldAffectsData } from 'payload/shared'
import { afterAll, describe, expect, it } from 'vitest'

import { buildRawSchema } from '../../../../packages/drizzle/src/schema/buildRawSchema.js'
import { setColumnID } from '../../../../packages/drizzle/src/sqlite/schema/setColumnID.js'
import { InternalBlockTableNameIndex } from '../../../../packages/drizzle/src/utilities/validateExistingBlockIsIdentical.js'
import { buildEngineInput } from '../../../../packages/engine-rs/src/adapter/schema.js'
import { getNativeEngine } from '../../../../packages/engine-rs/src/native.js'
import {
  createFunctionRegistry,
  serializeForEngine,
} from '../../../../packages/engine-rs/src/serialize.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.resolve(dirname, '../../..')
const suites = fs
  .readdirSync(testDir)
  .filter((dir) => fs.existsSync(path.join(testDir, dir, 'config.ts')))
  .sort()

const variants = [
  { name: 'number', autoIncrement: true, blocksAsJSON: false, idType: 'number' },
  { name: 'uuid', autoIncrement: false, blocksAsJSON: false, idType: 'uuid' },
  { name: 'blocksAsJSON', autoIncrement: true, blocksAsJSON: true, idType: 'number' },
] as const

/** Mirrors the `payload.collections` / `payload.blocks` setup in `BasePayload.init`. */
const buildPayloadLike = (config: SanitizedConfig) => {
  const collections: Record<string, { config: unknown; customIDType: string | undefined }> = {}
  for (const collection of config.collections) {
    let customIDType: string | undefined = undefined
    traverseFields({
      callback: ({ field }) => {
        if (
          ['array', 'blocks', 'group'].includes(field.type) ||
          (field.type === 'tab' && 'name' in field)
        ) {
          return true
        }
        if (!fieldAffectsData(field)) {
          return
        }
        if (field.name === 'id') {
          customIDType = field.type
          return true
        }
      },
      config,
      fields: collection.fields,
      parentIsLocalized: false,
    })
    collections[collection.slug] = { config: collection, customIDType }
  }
  const blocks = Object.fromEntries((config.blocks ?? []).map((block) => [block.slug, block]))
  return { blocks, collections, config }
}

/** Removes `InternalBlockTableNameIndex` (set by a schema run) from every reachable object. */
const clearBlockIndexes = (root: unknown) => {
  const seen = new Set<object>()
  const walk = (v: unknown) => {
    if (typeof v !== 'object' || v === null || seen.has(v)) {
      return
    }
    seen.add(v)
    if (Object.prototype.hasOwnProperty.call(v, InternalBlockTableNameIndex)) {
      delete (v as any)[InternalBlockTableNameIndex]
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(v))) {
      if ('value' in descriptor) {
        walk(descriptor.value)
      }
    }
  }
  walk(root)
}

const adapterState = (
  payload: ReturnType<typeof buildPayloadLike>,
  variant: (typeof variants)[number],
) => ({
  name: 'sqlite',
  autoIncrement: variant.autoIncrement,
  blocksAsJSON: variant.blocksAsJSON,
  fieldConstraints: {} as Record<string, Record<string, string>>,
  foreignKeys: new Set<string>(),
  idType: variant.idType,
  indexes: new Set<string>(),
  localesSuffix: '_locales',
  payload,
  rawRelations: {} as Record<string, any>,
  rawTables: {} as Record<string, any>,
  relationshipsSuffix: '_rels',
  tableNameMap: new Map<string, string>(),
  versionsSuffix: '_v',
})

/** Own keys in order, `undefined` as a marker (missing keys stay missing). */
const describeStrict = (value: unknown): unknown => {
  if (value === undefined) {
    return { $undefined: true }
  }
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'bigint' ? { $bigint: String(value) } : value
  }
  if (Array.isArray(value)) {
    return value.map(describeStrict)
  }
  return Object.keys(value).map((key) => [key, describeStrict((value as any)[key])])
}

/** Paths of own properties holding `undefined`. */
const undefinedPaths = (value: unknown, at: string[] = [], out: string[][] = []): string[][] => {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      const item = (value as any)[key]
      if (item === undefined) {
        out.push([...at, key])
      } else {
        undefinedPaths(item, [...at, key], out)
      }
    }
  }
  return out
}

const report = { compared: 0, failedToLoad: [] as string[], undefinedProperties: 0, variants: 0 }

describe('engine rawSchema keeps own undefined properties', () => {
  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log(`[rs-raw-schema-undefined] ${JSON.stringify(report)}`)
  })

  it('finds suites and the native engine', () => {
    expect(suites.length).toBeGreaterThan(0)
    expect(
      getNativeEngine().SqliteEngine,
      'PAYLOAD_ENGINE_ADDON must point at the addon',
    ).toBeTypeOf('function')
  })

  for (const suite of suites) {
    it(suite, { timeout: 300000 }, async () => {
      let config: SanitizedConfig
      try {
        const mod = await import(pathToFileURL(path.join(testDir, suite, 'config.ts')).href)
        config = await mod.default
        if (!config?.collections) {
          throw new Error('default export is not a sanitized config')
        }
      } catch (error) {
        report.failedToLoad.push(suite)
        throw new Error(`test/${suite}/config.ts failed to load`, { cause: error })
      }
      const payload = buildPayloadLike(config)
      for (const variant of variants) {
        clearBlockIndexes(payload)
        const ts = adapterState(payload, variant)
        let tsError: unknown
        try {
          buildRawSchema({ adapter: ts as any, setColumnID })
        } catch (error) {
          tsError = error
        }

        clearBlockIndexes(payload)
        const registry = createFunctionRegistry()
        const { graphJson, optionsJson } = buildEngineInput({
          adapter: adapterState(payload, variant) as any,
          registry,
        })
        const callFunction = (id: number, argJSON: string) =>
          serializeForEngine(registry.functions[id]!(JSON.parse(argJSON)), registry)
        let raw: any
        try {
          raw = JSON.parse(
            getNativeEngine()
              .SqliteEngine!.create(graphJson, optionsJson, callFunction)
              .rawSchema(),
          )
        } catch (error) {
          expect(
            tsError,
            `${suite} [${variant.name}] only the engine failed: ${error}`,
          ).toBeDefined()
          continue
        }
        expect(tsError, `${suite} [${variant.name}] only TS failed`).toBeUndefined()

        const rawTables: Record<string, any> = {}
        for (const key of raw.rawTableKeys as string[]) {
          rawTables[key] = raw.rawTables[key]
        }
        for (const property of raw.undefinedProperties as string[][]) {
          const target = property.slice(0, -1).reduce((o: any, key) => o[key], rawTables)
          target[property.at(-1)!] = undefined
        }
        report.undefinedProperties += raw.undefinedProperties.length

        expect(undefinedPaths(rawTables), `${suite} [${variant.name}] undefined paths`).toEqual(
          undefinedPaths(ts.rawTables),
        )
        // defaults whose JS value JSON cannot carry are compared by schema.int.spec.ts
        // (`columnDefaults`); leave them out on both sides
        const tsTables = structuredClone(ts.rawTables)
        for (const [table, column] of raw.columnDefaults as [string, string][]) {
          delete tsTables[table].columns[column].default
          delete rawTables[table].columns[column].default
        }
        expect(describeStrict(rawTables), `${suite} [${variant.name}] rawTables`).toEqual(
          describeStrict(tsTables),
        )
        report.variants++
      }
      report.compared++
    })
  }

  it('compared suites and found own undefined properties', () => {
    expect(report.compared).toBeGreaterThan(0)
    expect(report.undefinedProperties).toBeGreaterThan(0)
  })
})
