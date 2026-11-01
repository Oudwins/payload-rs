/**
 * Rewrites a vitest config built on test/__rs/harness/vitest.config.ts (int project with the
 * `databaseAdapter.js` alias) so that alias resolves to the MongoDB adapter of this directory.
 * Used by the core harness configs (test/__rs/core-*) when RS_CORE_DB=mongodb.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const mongoAdapter = path.resolve(dirname, 'databaseAdapter.ts')
const aliasPattern = /^(\.{1,2}\/)+databaseAdapter\.js$/

export const withMongo = <T extends Record<string, any>>(config: T): T => {
  const projects = (config.test?.projects ?? []).map((project: Record<string, any>) => {
    const alias = project.resolve?.alias
    if (!Array.isArray(alias)) {
      throw new Error('withMongo: expected an alias array on the int project')
    }
    let replaced = 0
    const nextAlias = alias.map((entry: { find: unknown; replacement: string }) => {
      if (entry.find instanceof RegExp && entry.find.source === aliasPattern.source) {
        replaced++
        return { ...entry, replacement: mongoAdapter }
      }
      return entry
    })
    if (replaced !== 1) {
      throw new Error(`withMongo: expected one databaseAdapter.js alias, found ${replaced}`)
    }
    return {
      ...project,
      resolve: { ...project.resolve, alias: nextAlias },
      // MongoDB I/O on a loaded machine: the 90 s default lets a slow test time out on one side
      // only, and its leftover work then runs into the next test
      test: { ...project.test, testTimeout: Math.max(project.test?.testTimeout ?? 0, 900_000) },
    }
  })
  return { ...config, test: { ...config.test, projects } }
}
