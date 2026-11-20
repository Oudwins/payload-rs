/**
 * Module resolve hook for Node child processes spawned by int tests run with
 * test/__rs/mongo-harness/vitest.config.ts (e.g. the `cli` fixture runs the real Payload CLI in
 * its own process).
 *
 * Those children import modules natively, without the vitest alias, so `test/databaseAdapter.js`
 * would be the shared generated file (written for whatever another run selected). For imports
 * made by test modules (outside this directory) this hook resolves
 * - `test/databaseAdapter.js` to test/__rs/mongo-harness/databaseAdapter.ts
 * - `@payloadcms/db-mongodb` to test/__rs/mongo-harness/childDbMongodb.ts in shadow mode
 *   (configs that build their own `mongooseAdapter`)
 * so the child builds the same adapter as the test process.
 *
 * Registered by childProcessLoader.mjs, which databaseAdapter.ts adds to NODE_OPTIONS.
 */
const DATABASE_ADAPTER_SPECIFIER = /^(\.{1,2}\/)+databaseAdapter\.js$/

/**
 * Synchronous resolve hook for `module.registerHooks`. In-thread hooks run before the async
 * hooks of loaders like tsx or @swc-node/register, which short-circuit resolution without
 * calling the next hook.
 *
 * @param {{ dbMongodbTarget?: string; harnessDir: string; target: string; testDir: string }} paths
 *   `dbMongodbTarget` unset: `@payloadcms/db-mongodb` is not redirected
 */
export const createResolveHook = (paths) =>
  function resolve(specifier, context, nextResolve) {
    const parent = context.parentURL
    const isFromTestModule =
      parent &&
      parent.startsWith(paths.testDir) &&
      !parent.startsWith(paths.harnessDir) &&
      !parent.includes('/node_modules/')
    if (isFromTestModule && paths.dbMongodbTarget && specifier === '@payloadcms/db-mongodb') {
      return { shortCircuit: true, url: paths.dbMongodbTarget }
    }
    // decided before `nextResolve`: on a clean checkout test/databaseAdapter.js (generated,
    // git-ignored) does not exist and the default resolver throws ERR_MODULE_NOT_FOUND
    if (
      isFromTestModule &&
      DATABASE_ADAPTER_SPECIFIER.test(specifier) &&
      new URL(specifier, parent).href === new URL('databaseAdapter.js', paths.testDir).href
    ) {
      return { shortCircuit: true, url: paths.target }
    }
    return nextResolve(specifier, context)
  }
