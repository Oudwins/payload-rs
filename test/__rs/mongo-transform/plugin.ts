/**
 * Vite plugin that wraps upstream `transform` (packages/db-mongodb/src/utilities/transform.ts)
 * with the recorder of ./recorder.ts, without editing packages/db-mongodb: the module's
 * `export const transform = ...` is renamed and re-exported through `recordTransform`, so every
 * importer (find, create, updateOne, resolveJoins, ...) and the function's own recursive calls go
 * through the recorder (nested calls are passed straight to upstream).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const recorder = path.join(dirname, 'recorder.ts')
const target = path.join('packages', 'db-mongodb', 'src', 'utilities', 'transform.ts')

export const transformRecorderPlugin = () => ({
  name: 'rs-mongo-transform-recorder',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.split('?')[0]!.endsWith(target)) {
      return null
    }
    const marker = 'export const transform = '
    if (code.split(marker).length !== 2) {
      throw new Error(`rs-mongo-transform-recorder: expected one "${marker}" in ${id}`)
    }
    return {
      code:
        code.replace(marker, 'const __rsUpstreamTransform = ') +
        `\nimport { recordTransform as __rsRecordTransform } from ${JSON.stringify(recorder)}\n` +
        'export const transform = (args) => __rsRecordTransform(__rsUpstreamTransform, args)\n',
      map: null,
    }
  },
})
