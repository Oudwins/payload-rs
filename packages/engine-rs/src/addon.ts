import { createRequire } from 'node:module'

/**
 * `../addon.cjs` (the package root, from both `src/` and `dist/`): the one resolution and instance
 * of the engine addon for the whole process (see that file).
 */
const addonModule = createRequire(import.meta.url)('../addon.cjs') as {
  coreRuntimeAddonPath: () => string
  engineAddonPath: () => string
  loadCoreRuntimeAddon: () => unknown
  loadedEngineAddonPath: () => string
  loadEngineAddon: () => unknown
  platformPackageName: () => string
}

export const {
  coreRuntimeAddonPath,
  engineAddonPath,
  loadCoreRuntimeAddon,
  loadedEngineAddonPath,
  loadEngineAddon,
  platformPackageName,
} = addonModule
