/**
 * Module resolve hook for Node child processes spawned by int tests run with
 * test/__rs/pg-harness/vitest.config.ts (e.g. the `cli` fixture runs the real Payload CLI in its
 * own process).
 *
 * Those children import modules natively, without the vitest alias, so `test/databaseAdapter.js`
 * would be the shared generated file (written for whatever another run selected). Any import made
 * by a test module (outside this directory) that resolves to that file, relative
 * (`../databaseAdapter.js`) or absolute (`path.resolve(dirname, '../databaseAdapter.js')`), is
 * resolved to test/__rs/pg-harness/databaseAdapter.ts instead.
 *
 * Registered by childProcessLoader.mjs, which databaseAdapter.ts adds to NODE_OPTIONS.
 */

/**
 * Synchronous resolve hook for `module.registerHooks`. In-thread hooks run before the async
 * hooks of loaders like tsx or @swc-node/register, which short-circuit resolution without
 * calling the next hook.
 *
 * @param {{ harnessDir: string; target: string; testDir: string }} paths
 */
export const createResolveHook = (paths) => {
  const sharedAdapter = new URL('databaseAdapter.js', paths.testDir).href
  return function resolve(specifier, context, nextResolve) {
    const parent = context.parentURL
    const isFromTestModule =
      parent &&
      parent.startsWith(paths.testDir) &&
      !parent.startsWith(paths.harnessDir) &&
      !parent.includes('/node_modules/')
    const resolved = nextResolve(specifier, context)
    if (isFromTestModule && resolved.url === sharedAdapter) {
      return { shortCircuit: true, url: paths.target }
    }
    return resolved
  }
}
