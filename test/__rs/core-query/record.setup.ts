/**
 * Vitest setup file (see vitest.record.config.ts): replaces the payload query/select utilities and
 * the host functions they call with recording wrappers (./recorder.ts).
 */
import { afterAll, vi } from 'vitest'

const src = '../../../packages/payload/src'

vi.mock(import('../../../packages/payload/src/database/combineQueries.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  return {
    ...mod,
    combineQueries: wrapSync('combineQueries', mod.combineQueries, (where, access) => ({
      data: { access, where },
    })),
  }
})

vi.mock(import('../../../packages/payload/src/database/sanitizeWhereQuery.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  return {
    ...mod,
    sanitizeWhereQuery: wrapSync('sanitizeWhereQuery', mod.sanitizeWhereQuery, (args) => ({
      cfg: { fields: args.fields },
      data: { where: args.where },
      payload: args.payload,
    })),
  }
})

vi.mock(import('../../../packages/payload/src/database/getLocalizedPaths.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  return {
    ...mod,
    getLocalizedPaths: wrapSync(
      'getLocalizedPaths',
      mod.getLocalizedPaths,
      (args) => ({
        cfg: { fields: args.fields },
        data: { locale: args.locale },
        payload: args.payload,
        scalars: {
          collectionSlug: args.collectionSlug,
          globalSlug: args.globalSlug,
          incomingPath: args.incomingPath,
          overrideAccess: args.overrideAccess,
          parentIsLocalized: args.parentIsLocalized,
          showHiddenFields: args.showHiddenFields,
        },
      }),
      { cfgResult: true },
    ),
  }
})

vi.mock(import('../../../packages/payload/src/utilities/getFieldByPath.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  return {
    ...mod,
    getFieldByPath: wrapSync(
      'getFieldByPath',
      mod.getFieldByPath,
      (args) => {
        const cached: Map<string, any> | undefined = (globalThis as any)._payload
        const payload = args.config
          ? [...(cached?.values() ?? [])].map((v) => v?.payload ?? v).find((p) => p?.config === args.config)
          : undefined
        if (args.config && !payload) {
          throw new Error('unknown config')
        }
        return {
          cfg: { fields: args.fields },
          payload,
          probe: args.fields,
          scalars: {
            hasConfig: Boolean(args.config),
            includeRelationships: args.includeRelationships,
            localizedPath: args.localizedPath,
            path: args.path,
          },
        }
      },
      { cfgResult: true },
    ),
  }
})

vi.mock(
  import('../../../packages/payload/src/collections/operations/utilities/sanitizeSortQuery.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapSync } = await import('./recorder.js')
    return {
      ...mod,
      sanitizeSortQuery: wrapSync('sanitizeSortQuery', mod.sanitizeSortQuery, (args) => ({
        cfg: { fields: args.fields },
        data: { sort: args.sort },
        probe: args.fields,
      })),
    }
  },
)

vi.mock(import('../../../packages/payload/src/utilities/sanitizeSelect.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  return {
    ...mod,
    sanitizeSelect: wrapSync('sanitizeSelect', mod.sanitizeSelect, (args) => ({
      cfg: { fields: args.fields },
      data: { select: args.select },
      probe: args.fields,
      scalars: { versions: args.versions },
    })),
  }
})

vi.mock(import('../../../packages/payload/src/utilities/resolveSelect.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  const { encodeData, encodeError } = await import('./encode.js')
  return {
    ...mod,
    resolveSelect: wrapSync(
      'resolveSelect',
      mod.resolveSelect as any,
      (args: any) => ({
        cfg: { config: args.config },
        data: { select: args.select },
        payload: args.req?.payload,
        scalars: { operation: args.operation },
      }),
      {
        wrapArgs: (args: any[], host) => {
          const [first] = args
          if (typeof first?.config !== 'function') {
            return args
          }
          const config = first.config
          return [
            {
              ...first,
              config: (fnArgs: any) => {
                const call: Record<string, unknown> = { kind: 'select', operation: fnArgs.operation }
                host.push(call)
                try {
                  const value = config(fnArgs)
                  call.ok = encodeData(value)
                  call.same = value === fnArgs.select && typeof value === 'object' && value !== null
                  return value
                } catch (e) {
                  call.err = encodeError(e)
                  throw e
                }
              },
            },
          ]
        },
      },
    ),
  }
})

vi.mock(import('../../../packages/payload/src/utilities/getSelectMode.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  return {
    ...mod,
    getSelectMode: wrapSync('getSelectMode', mod.getSelectMode, (select) => ({ data: { select } })),
  }
})

vi.mock(import('../../../packages/payload/src/utilities/stripUnselectedFields.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  return {
    ...mod,
    stripUnselectedFields: wrapSync('stripUnselectedFields', mod.stripUnselectedFields, (args) => ({
      cfg: { field: args.field },
      data: { select: args.select, siblingDoc: args.siblingDoc },
      probe: args.field,
      scalars: { selectMode: args.selectMode },
    })),
  }
})

vi.mock(import('../../../packages/payload/src/utilities/appendNonTrashedFilter.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  return {
    ...mod,
    appendNonTrashedFilter: wrapSync('appendNonTrashedFilter', mod.appendNonTrashedFilter, (args) => ({
      data: { enableTrash: args.enableTrash, trash: args.trash, where: args.where },
      scalars: { deletedAtPath: args.deletedAtPath },
    })),
  }
})

vi.mock(
  import('../../../packages/payload/src/versions/drafts/appendVersionToQueryKey.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapSync } = await import('./recorder.js')
    return {
      ...mod,
      appendGlobalVersionToQueryKey: wrapSync(
        'appendGlobalVersionToQueryKey',
        mod.appendGlobalVersionToQueryKey,
        (query) => ({ data: { query } }),
      ),
      appendVersionToQueryKey: wrapSync('appendVersionToQueryKey', mod.appendVersionToQueryKey, (query) => ({
        data: { query },
      })),
    }
  },
)

vi.mock(import('../../../packages/payload/src/versions/drafts/getQueryDraftsSort.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapSync } = await import('./recorder.js')
  return {
    ...mod,
    getQueryDraftsSort: wrapSync('getQueryDraftsSort', mod.getQueryDraftsSort, (args) => ({
      cfg: { collectionConfig: args.collectionConfig },
      data: { sort: args.sort },
      probe: args.collectionConfig,
    })),
  }
})

vi.mock(
  import('../../../packages/payload/src/versions/drafts/getQueryDraftsSelect.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapSync } = await import('./recorder.js')
    return {
      ...mod,
      getQueryDraftsSelect: wrapSync('getQueryDraftsSelect', mod.getQueryDraftsSelect, (args) => ({
        data: { select: args.select },
      })),
    }
  },
)

const validatorScalars = (args: any) => ({
  overrideAccess: args.overrideAccess,
  polymorphicJoin: args.polymorphicJoin,
  showHiddenFields: args.showHiddenFields,
})

vi.mock(
  import('../../../packages/payload/src/database/queryValidation/validateQueryPaths.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapAsync } = await import('./recorder.js')
    return {
      ...mod,
      validateQueryPaths: wrapAsync('validateQueryPaths', mod.validateQueryPaths, (args: any) => ({
        cfg: {
          collectionConfig: args.collectionConfig,
          globalConfig: args.globalConfig,
          versionFields: args.versionFields,
        },
        data: { errors: args.errors, locale: args.req.locale, policies: args.policies, where: args.where },
        payload: args.req.payload,
        req: args.req,
        scalars: validatorScalars(args),
      })),
    }
  },
)

vi.mock(
  import('../../../packages/payload/src/database/queryValidation/validateSortQuery.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { wrapAsync } = await import('./recorder.js')
    return {
      ...mod,
      validateSortQuery: wrapAsync('validateSortQuery', mod.validateSortQuery, (args: any) => ({
        cfg: {
          collectionConfig: args.collectionConfig,
          globalConfig: args.globalConfig,
          versionFields: args.versionFields,
        },
        data: { locale: args.req.locale, sort: args.sort },
        payload: args.req.payload,
        req: args.req,
        scalars: validatorScalars(args),
      })),
    }
  },
)

vi.mock(import('../../../packages/payload/src/database/sanitizeJoinQuery.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapAsync } = await import('./recorder.js')
  return {
    ...mod,
    sanitizeJoinQuery: wrapAsync('sanitizeJoinQuery', mod.sanitizeJoinQuery, (args: any) => ({
      cfg: { collectionConfig: args.collectionConfig },
      data: { joins: args.joins, locale: args.req.locale },
      payload: args.req.payload,
      req: args.req,
      scalars: { overrideAccess: args.overrideAccess },
    })),
  }
})

vi.mock(
  import('../../../packages/payload/src/utilities/getEntityPermissions/getEntityPermissions.js'),
  async (importOriginal) => {
    const mod = await importOriginal()
    const { hostObjectID, wrapHost } = await import('./recorder.js')
    return {
      ...mod,
      getEntityPermissions: wrapHost('permissions', mod.getEntityPermissions, (store, args: any) => ({
        blockRefs: hostObjectID(store, args.blockReferencesPermissions),
        entityType: args.entityType,
        fetchData: args.fetchData,
        isolated: args.req !== store.req,
        operations: args.operations,
        slug: args.entity?.slug,
      })),
    }
  },
)

vi.mock(import('../../../packages/payload/src/auth/executeAccess.js'), async (importOriginal) => {
  const mod = await importOriginal()
  const { wrapHost } = await import('./recorder.js')
  return {
    ...mod,
    executeAccess: wrapHost('access', mod.executeAccess, (store, args: any, access: unknown) => ({
      access: store.accessID(access),
      disableErrors: args.disableErrors,
      slug: args.slug,
    })),
  }
})

afterAll(async () => {
  const { flush } = await import('./recorder.js')
  flush()
})

export {}
void src
