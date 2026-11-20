/**
 * Vite plugin that routes `@payloadcms/db-mongodb`'s `transform`, `handleError`, `getCollection`,
 * `getGlobal`, `getDBName` and `isObjectID` through ./swap.ts without editing packages/db-mongodb:
 * each `export const <name> = ...` is renamed and re-exported as `swap('<name>', upstream)`, so every
 * importer goes through the swap (`PAYLOAD_RS_LIVE_TRANSFORM=rs|shadow`; unset = upstream).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const swap = path.join(dirname, 'swap.ts')
const utilities = path.join('packages', 'db-mongodb', 'src', 'utilities')

const targets: Record<string, string[]> = {
  'getDBName.ts': ['getDBName'],
  'getEntity.ts': ['getCollection', 'getGlobal'],
  'handleError.ts': ['handleError'],
  'isObjectID.ts': ['isObjectID'],
  'transform.ts': ['transform'],
}

export const liveTransformPlugin = () => ({
  name: 'rs-mongo-live-transform',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    const file = id.split('?')[0]!
    const entry = Object.entries(targets).find(([name]) =>
      file.endsWith(path.join(utilities, name)),
    )
    if (!entry) {
      return null
    }
    let out = code
    let exports = ''
    for (const name of entry[1]) {
      const marker = new RegExp(`export const ${name}(: [A-Za-z]+)? = `)
      if (!marker.test(out)) {
        throw new Error(`rs-mongo-live-transform: no "export const ${name} = " in ${id}`)
      }
      out = out.replace(marker, `const __rsUpstream_${name}$1 = `)
      exports += `export const ${name} = __rsLiveSwap(${JSON.stringify(name)}, __rsUpstream_${name})\n`
    }
    return {
      code: `${out}\nimport { swap as __rsLiveSwap } from ${JSON.stringify(swap)}\n${exports}`,
      map: null,
    }
  },
})
