/**
 * Turns on Node's on-disk compile cache (`module.enableCompileCache()`), so modules loaded after
 * payload (database adapters and the rich text editor imported after it, modules imported on
 * first use) are compiled once per version instead of on every start. Modules linked in the same
 * static import graph as payload are compiled before this can run. A no-op when the cache is
 * already enabled (`NODE_COMPILE_CACHE`), disabled (`NODE_DISABLE_COMPILE_CACHE`) or unavailable
 * (outside Node.js).
 */
export const enableCompileCache = (): void => {
  if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return
  }
  process.getBuiltinModule('node:module')?.enableCompileCache?.()
}
