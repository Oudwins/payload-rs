/**
 * CPU cost per document of the five field traversals, upstream TS vs the Rust core engine, on a
 * typical document (8 leaf types at the top level, in a group, a collapsible, 2 array rows with 2
 * nested rows each and 2 blocks: 88 data leaves), without hooks and with a synchronous hook of
 * every traversal on every leaf. TS and Rust batches alternate in one process; each batch is
 * measured as main-thread CPU time (`process.threadCpuUsage`), the median batch is reported.
 *
 *   PAYLOAD_ENGINE_ADDON=/path/payload-engine.node SQLITE_URL=file:/tmp/x.db \
 *     pnpm test:int:sqlite test/__rs/dispatch/bench.int.spec.ts
 *
 * Use a release build of payload-node for meaningful numbers. BENCH_ROUNDS / BENCH_DOCS tune it.
 */
import fs from 'node:fs'
import inspector from 'node:inspector'
import { expect } from 'vitest'

import { afterChange as afterChangeRS } from '../../../packages/engine-rs/src/runtime/afterChange/index.js'
import { beforeChange as beforeChangeRS } from '../../../packages/engine-rs/src/runtime/beforeChange/index.js'
import { beforeDuplicate as beforeDuplicateRS } from '../../../packages/engine-rs/src/runtime/beforeDuplicate/index.js'
import { beforeValidate as beforeValidateRS } from '../../../packages/engine-rs/src/runtime/beforeValidate/index.js'
import { afterRead as afterReadRS } from '../../../packages/engine-rs/src/runtime/index.js'
import { upstreamAfterChange as afterChangeTS } from '../../../packages/payload/src/fields/hooks/afterChange/index.js'
import { upstreamAfterRead as afterReadTS } from '../../../packages/payload/src/fields/hooks/afterRead/index.js'
import { upstreamBeforeChange as beforeChangeTS } from '../../../packages/payload/src/fields/hooks/beforeChange/index.js'
import { upstreamBeforeDuplicate as beforeDuplicateTS } from '../../../packages/payload/src/fields/hooks/beforeDuplicate/index.js'
import { upstreamBeforeValidate as beforeValidateTS } from '../../../packages/payload/src/fields/hooks/beforeValidate/index.js'
import { createPayloadRequest } from '../../../packages/payload/src/utilities/createPayloadRequest.js'
import { test } from '../../__helpers/int/vitest.js'

const leafValues = (prefix: string) => ({
  [`${prefix}checkbox`]: true,
  [`${prefix}date`]: '2024-01-01T00:00:00.000Z',
  [`${prefix}email`]: 'a@b.co',
  [`${prefix}number`]: 42,
  [`${prefix}select`]: 'b',
  [`${prefix}text`]: 'hello',
  [`${prefix}textarea`]: 'lorem ipsum',
})

const makeDoc = () => ({
  ...leafValues(''),
  ...leafValues('c'),
  id: 1,
  createdAt: '2024-01-01T00:00:00.000Z',
  group: leafValues('g'),
  layout: [0, 1].map((i) => ({
    ...leafValues('b'),
    id: `65a00000000000000000000${i}`,
    blockType: 'content',
  })),
  rows: [0, 1].map((i) => ({
    ...leafValues('r'),
    id: `65b00000000000000000000${i}`,
    nested: [0, 1].map((j) => ({ ...leafValues('n'), id: `65c0000000000000000000${i}${j}` })),
  })),
  updatedAt: '2024-01-01T00:00:00.000Z',
})

test.suite('dispatch: field traversal benchmark', { config: './benchConfig.ts' }, () => {
  test(
    'should report TS vs Rust CPU time per document',
    { timeout: 1_800_000 },
    async ({ payload }) => {
      const rounds = Number(process.env.BENCH_ROUNDS ?? 9)
      const perRound = Number(process.env.BENCH_DOCS ?? 300)
      const req = await createPayloadRequest({ context: {}, payload })
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

      type Run = (collection: any, doc: any) => Promise<unknown>
      const traversals: Record<string, { RS: Run; TS: Run }> = {}
      const pair = (name: string, make: (fn: any) => Run, ts: unknown, rs: unknown) => {
        traversals[name] = { RS: make(rs), TS: make(ts) }
      }
      pair(
        'beforeValidate',
        (fn) => (collection, doc) =>
          fn({
            collection,
            context: req.context,
            data: doc,
            doc: makeDoc(),
            global: null,
            operation: 'update',
            overrideAccess: true,
            req,
          }),
        beforeValidateTS,
        beforeValidateRS,
      )
      pair(
        'beforeChange',
        (fn) => (collection, doc) =>
          fn({
            collection,
            context: req.context,
            data: doc,
            doc: makeDoc(),
            docWithLocales: makeDoc(),
            global: null,
            operation: 'update',
            req,
          }),
        beforeChangeTS,
        beforeChangeRS,
      )
      pair(
        'afterChange',
        (fn) => (collection, doc) =>
          fn({
            collection,
            context: req.context,
            data: makeDoc(),
            doc,
            global: null,
            operation: 'update',
            previousDoc: makeDoc(),
            req,
          }),
        afterChangeTS,
        afterChangeRS,
      )
      pair(
        'afterRead',
        (fn) => (collection, doc) =>
          fn({
            collection,
            context: req.context,
            depth: 0,
            doc,
            draft: false,
            fallbackLocale: null,
            global: null,
            locale: 'en',
            overrideAccess: true,
            req,
            showHiddenFields: false,
          }),
        afterReadTS,
        afterReadRS,
      )
      pair(
        'beforeDuplicate',
        (fn) => (collection, doc) =>
          fn({ collection, context: req.context, doc, overrideAccess: true, req }),
        beforeDuplicateTS,
        beforeDuplicateRS,
      )

      // BENCH_ONLY=<traversal>, BENCH_SLUG=plain|hooked: restrict the table (e.g. for profiling)
      const only = process.env.BENCH_ONLY
      const slugs = process.env.BENCH_SLUG ? [process.env.BENCH_SLUG] : ['plain', 'hooked']
      const table: Record<string, Record<string, string>> = {}
      // BENCH_CPU_PROFILE=<file>: V8 CPU profile of the measured rounds (node:inspector)
      const profileFile = process.env.BENCH_CPU_PROFILE
      const session = profileFile ? new inspector.Session() : undefined
      const post = (method: string, params?: object) =>
        new Promise<any>((resolve, reject) =>
          session!.post(method, params, (error, result) =>
            error ? reject(error) : resolve(result),
          ),
        )
      if (session) {
        session.connect()
        await post('Profiler.enable')
        await post('Profiler.setSamplingInterval', { interval: 100 })
      }
      for (const slug of slugs) {
        const collection = payload.collections[slug]!.config
        for (const [name, engines] of Object.entries(traversals)) {
          if (only && name !== only) {
            continue
          }
          // same output from both engines on this input (a cheap guard against benchmarking a no-op)
          const [ts, rs] = [
            await engines.TS(collection, makeDoc()),
            await engines.RS(collection, makeDoc()),
          ]
          // generated row ids differ between the two runs
          const canonical = (v: unknown) => JSON.stringify(v).replace(/"[0-9a-f]{24}"/g, '"$id"')
          expect(canonical(rs)).toBe(canonical(ts))
          const samples = { RS: [] as number[], TS: [] as number[] }
          for (const fn of Object.values(engines)) {
            for (let i = 0; i < 100; i++) {
              await fn(collection, makeDoc())
            }
          }
          if (session) {
            await post('Profiler.start')
          }
          for (let r = 0; r < rounds; r++) {
            for (const engine of r % 2 ? (['RS', 'TS'] as const) : (['TS', 'RS'] as const)) {
              // BENCH_ENGINE=RS|TS: measure one engine only (profiling)
              if (process.env.BENCH_ENGINE && engine !== process.env.BENCH_ENGINE) {
                samples[engine].push(1)
                continue
              }
              const docs = Array.from({ length: perRound }, makeDoc)
              const start = process.threadCpuUsage()
              for (const doc of docs) {
                await engines[engine](collection, doc)
              }
              const cpu = process.threadCpuUsage(start)
              samples[engine].push((cpu.user + cpu.system) / perRound)
            }
          }
          if (session) {
            const { profile } = await post('Profiler.stop')
            fs.writeFileSync(`${profileFile}.${slug}.${name}.cpuprofile`, JSON.stringify(profile))
          }
          const ts_ = median(samples.TS)
          const rs_ = median(samples.RS)
          table[`${name} (${slug})`] = {
            'RS cpu µs/doc': rs_.toFixed(1),
            'RS/TS': (rs_ / ts_).toFixed(2),
            'TS cpu µs/doc': ts_.toFixed(1),
          }
        }
      }
      console.table(table)
      expect(Object.keys(table)).toHaveLength(only ? slugs.length : 5 * slugs.length)
    },
  )
})
