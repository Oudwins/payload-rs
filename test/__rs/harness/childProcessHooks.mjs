/**
 * Module resolve hook for Node child processes spawned by shadow-mode int tests
 * (e.g. the `cli` fixture runs the real Payload CLI in its own process,
 * test/queues spawns a job worker).
 *
 * Those children import modules natively, without the vitest alias of
 * test/__rs/harness/vitest.config.ts, so their writes would hit only the
 * reference database. For imports made by test modules (outside this
 * directory) this hook resolves
 * - `test/databaseAdapter.js` to test/__rs/harness/databaseAdapter.ts
 * - `@payloadcms/db-sqlite` to test/__rs/harness/childDbSqlite.ts (configs that
 *   build their own `sqliteAdapter`)
 * so the child runs the same shadow adapter (reference + candidate) as the
 * test process.
 *
 * Registered by childProcessLoader.mjs, which databaseAdapter.ts adds to
 * NODE_OPTIONS in shadow mode.
 */
const DATABASE_ADAPTER_SPECIFIER = /^(\.{1,2}\/)+databaseAdapter\.js$/

/**
 * Synchronous resolve hook for `module.registerHooks`. In-thread hooks run
 * before the async hooks of loaders like tsx or @swc-node/register, which
 * short-circuit resolution without calling the next hook.
 *
 * @param {{ dbSqliteTarget?: string; harnessDir: string; target: string; testDir: string }} paths
 *   `dbSqliteTarget` unset: `@payloadcms/db-sqlite` is not redirected
 */
export const createResolveHook = (paths) =>
  function resolve(specifier, context, nextResolve) {
    const parent = context.parentURL
    const isFromTestModule =
      parent &&
      parent.startsWith(paths.testDir) &&
      !parent.startsWith(paths.harnessDir) &&
      !parent.includes('/node_modules/')
    if (isFromTestModule && paths.dbSqliteTarget && specifier === '@payloadcms/db-sqlite') {
      return { shortCircuit: true, url: paths.dbSqliteTarget }
    }
    const resolved = nextResolve(specifier, context)
    if (
      isFromTestModule &&
      DATABASE_ADAPTER_SPECIFIER.test(specifier) &&
      resolved.url === new URL('databaseAdapter.js', paths.testDir).href
    ) {
      return { shortCircuit: true, url: paths.target }
    }
    return resolved
  }
