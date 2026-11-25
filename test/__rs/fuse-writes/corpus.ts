/**
 * The corpus driver of the write-side library's differential tests (int.spec.ts, localized/):
 * seeds, runs every case through the harness, counts the outcomes and writes the report.
 */
import type { Payload } from 'payload'

import { writeFileSync } from 'node:fs'
import { expect } from 'vitest'

import { BSON, type CaseResult, ensureMonitoring, runCase } from './harness.js'

export type Case = {
  collection: string
  data: Record<string, unknown>
  /** The operation's `draft` argument. */
  draft?: boolean
  locale?: string
  name: string
  /**
   * A raw stored document (inserted through the driver) or Payload data to create first (with
   * `draft`: as a draft), then `updates` applied to it (drafts: versions after the main document).
   */
  seed?: {
    data?: Record<string, unknown>
    draft?: boolean
    raw?: Record<string, unknown>
    updates?: { data: Record<string, unknown>; draft?: boolean }[]
  }
  user?: boolean
}

const summary: Record<string, Record<string, number>> = {}
const report: string[] = []

const record = (group: string, name: string, result: CaseResult) => {
  const counts = (summary[group] ??= {})
  const key = result.kind === 'equal' ? `equal:${result.outcome}` : result.kind
  counts[key] = (counts[key] ?? 0) + 1
  if (result.kind === 'bail') {
    report.push(`${group} / ${name}: bail ${result.reason}`)
  }
  if (result.kind === 'diff') {
    report.push(`${group} / ${name}: DIFF\n${result.diffs.join('\n')}`)
  }
}

export const fixtures = async (payload: Payload) => {
  const author = await payload.create({
    collection: 'authors',
    data: { name: 'a' },
    overrideAccess: true,
  })
  const author2 = await payload.create({
    collection: 'authors',
    data: { name: 'b' },
    overrideAccess: true,
  })
  const category = await payload.create({
    collection: 'categories',
    data: { title: 'c' },
    overrideAccess: true,
  })
  const category2 = await payload.create({
    collection: 'categories',
    data: { title: 'd' },
    overrideAccess: true,
  })
  const user = await payload.create({
    collection: 'users',
    data: { email: 'fuse@writes.test', password: 'secret' },
    overrideAccess: true,
  })
  return {
    author: String(author.id),
    author2: String(author2.id),
    category: String(category.id),
    category2: String(category2.id),
    user: { ...user, collection: 'users' },
  }
}

export type Fixtures = Awaited<ReturnType<typeof fixtures>>

export const runAll = async (payload: Payload, group: string, cases: Case[], f: Fixtures) => {
  ensureMonitoring(payload)
  for (const c of cases) {
    let id: string | undefined
    if (c.seed?.data) {
      const seeded = await payload.create({
        collection: c.collection as any,
        data: c.seed.data as any,
        draft: c.seed.draft,
        locale: c.locale,
        overrideAccess: true,
      })
      id = String(seeded.id)
      for (const update of c.seed.updates ?? []) {
        await payload.update({
          id,
          collection: c.collection as any,
          data: update.data as any,
          draft: update.draft,
          locale: c.locale,
          overrideAccess: true,
        })
      }
    } else if (c.seed?.raw) {
      const _id = new BSON.ObjectId()
      await payload.db.connection
        .db!.collection(payload.db.collections[c.collection]!.collection.name)
        .insertOne({ _id, ...c.seed.raw })
      id = _id.toHexString()
    }
    const result = await runCase({
      collection: c.collection,
      data: c.data,
      draft: c.draft,
      id,
      locale: c.locale,
      payload,
      user: c.user ? f.user : undefined,
    })
    record(group, c.name, result)
  }
}

/** Writes the cumulative report and fails on any difference of `group`. */
export const finish = (group: string) => {
  writeFileSync(
    // one report per spec file (each has its own module state)
    `${process.env.PAYLOAD_RS_FUSE_WRITES_REPORT ?? '/tmp/fuse-writes-corpus.txt'}${expect.getState().testPath?.includes('/localized/') ? '.localized' : ''}`,
    `${JSON.stringify(summary, null, 1)}\n${report.join('\n')}\n`,
  )
  const diffs = report.filter((line) => line.startsWith(`${group} / `) && line.includes(': DIFF'))
  expect(diffs).toEqual([])
}
