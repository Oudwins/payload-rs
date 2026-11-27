/**
 * Vite plugin that routes the HTTP fast paths through ./shadow.ts without editing their sources:
 * each `export const <name> = ...` of the target files is renamed and re-exported as
 * `shadow('<name>', upstream)`, so every importer goes through the shadow wrapper.
 *
 * - packages/payload/src/auth/strategies/verifyJWTSync.ts: `verifyJWTSync` (the synchronous HS256
 *   path of the JWT strategy), compared with jose's `jwtVerify`
 * - packages/payload/src/collections/endpoints/fusedResponse.ts: `fusedResponse` (the byte lanes of
 *   the default read handlers), compared byte for byte with the handler's exact path;
 *   `bytesWriteResponse` (the response of a write the fused lane served as bytes), compared with
 *   `Response.json` of the parsed document
 * - packages/next/src/routes/graphql/documentCache.ts: `parseWithCache`, `concatRules`,
 *   `validateWithCache` (the GraphQL document cache), compared with `parse` / `validate` uncached
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const shadow = path.join(dirname, 'shadow.ts')

const targets: Record<string, string[]> = {
  [path.join('packages', 'next', 'src', 'routes', 'graphql', 'documentCache.ts')]: [
    'parseWithCache',
    'concatRules',
    'validateWithCache',
  ],
  [path.join('packages', 'payload', 'src', 'collections', 'endpoints', 'fusedResponse.ts')]: [
    'fusedResponse',
    'bytesWriteResponse',
  ],
  [path.join('packages', 'payload', 'src', 'auth', 'strategies', 'verifyJWTSync.ts')]: [
    'verifyJWTSync',
  ],
}

export const httpLanesPlugin = () => ({
  name: 'rs-http-lanes-shadow',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    const file = id.split('?')[0]!
    const entry = Object.entries(targets).find(([target]) => file.endsWith(target))
    if (!entry) {
      return null
    }
    let out = code
    let exports = ''
    for (const name of entry[1]) {
      const marker = new RegExp(`export const ${name} = `)
      if (!marker.test(out)) {
        throw new Error(`rs-http-lanes-shadow: no "export const ${name} = " in ${id}`)
      }
      out = out.replace(marker, `const __rsUpstream_${name} = `)
      exports += `export const ${name} = __rsHttpShadow(${JSON.stringify(name)}, __rsUpstream_${name})\n`
    }
    return {
      code: `${out}\nimport { shadow as __rsHttpShadow } from ${JSON.stringify(shadow)}\n${exports}`,
      map: null,
    }
  },
})
