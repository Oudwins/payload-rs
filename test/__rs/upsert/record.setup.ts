/**
 * Vitest setup file (see vitest.record.config.ts) wrapping the @payloadcms/drizzle write path with
 * the recorder. Each factory imports the original module and replaces the recorded exports.
 */
import { afterAll, vi } from 'vitest'

vi.mock(import('../../../packages/drizzle/src/index.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { markRollback, wrapOperation } = await import('./recorder.js')
  const { hasDraftsEnabled } = await import('payload/shared')
  const methods = [
    'create',
    'createGlobal',
    'createGlobalVersion',
    'createVersion',
    'deleteMany',
    'deleteOne',
    'deleteVersions',
    'updateGlobal',
    'updateGlobalVersion',
    'updateJobs',
    'updateMany',
    'updateOne',
    'updateVersion',
    'upsert',
  ] as const
  const wrapped: Record<string, unknown> = {}
  for (const method of methods) {
    wrapped[method] = wrapOperation(method, (mod as any)[method], hasDraftsEnabled)
  }
  const rollbackTransaction = (mod as any).rollbackTransaction
  wrapped.rollbackTransaction = async function (this: any, ...args: unknown[]) {
    markRollback(this)
    return rollbackTransaction.apply(this, args)
  }
  return { ...mod, ...wrapped }
})

vi.mock(import('../../../packages/drizzle/src/upsertRow/index.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapUpsertRow } = await import('./recorder.js')
  return { ...mod, upsertRow: wrapUpsertRow(mod.upsertRow) }
})

vi.mock(
  import('../../../packages/drizzle/src/transform/write/index.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapTransformForWrite } = await import('./recorder.js')
    return { ...mod, transformForWrite: wrapTransformForWrite(mod.transformForWrite) }
  },
)

vi.mock(
  import('../../../packages/drizzle/src/upsertRow/shouldUseOptimizedUpsertRow.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapShouldUse } = await import('./recorder.js')
    return { ...mod, shouldUseOptimizedUpsertRow: wrapShouldUse(mod.shouldUseOptimizedUpsertRow) }
  },
)

vi.mock(
  import('../../../packages/drizzle/src/find/buildFindManyArgs.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapBuildFindManyArgs } = await import('./recorder.js')
    return { ...mod, buildFindManyArgs: wrapBuildFindManyArgs(mod.buildFindManyArgs) }
  },
)

vi.mock(import('../../../packages/drizzle/src/queries/buildQuery.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapBuildQuery } = await import('./recorder.js')
  return { ...mod, buildQuery: wrapBuildQuery(mod.buildQuery) }
})

vi.mock(
  import('../../../packages/drizzle/src/queries/selectDistinct.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapSelectDistinct } = await import('./recorder.js')
    return { ...mod, selectDistinct: wrapSelectDistinct(mod.selectDistinct) }
  },
)

vi.mock(import('../../../packages/drizzle/src/find/findMany.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapFindMany } = await import('./recorder.js')
  return { ...mod, findMany: wrapFindMany(mod.findMany) }
})

vi.mock(import('../../../packages/drizzle/src/transform/read/index.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapReadTransform } = await import('./recorder.js')
  return { ...mod, transform: wrapReadTransform(mod.transform) }
})

afterAll(async () => {
  const { flushRecording } = await import('./recorder.js')
  flushRecording()
})
