/**
 * The `int` project (via test/__rs/harness/vitest.config.ts: own database adapter module, no
 * shared codegen) with payload's global and auth operation modules and the four field traversal
 * modules redirected, for every importer, to `wrap/*.ts` (same exports; the operation / traversal
 * traced by trace.ts when `RS_OPS_GLOBAL_TRACE=<dir>` is set). The engine is chosen by payload's
 * own dispatch (`PAYLOAD_OPS_GLOBAL_ENGINE=rs` for the Rust global/auth operations); see run.sh.
 *
 * `RS_OPS_GLOBAL_MUTANT=<n>` additionally replaces packages/engine-rs/src/ops-global/host.ts by
 * mutantHost.ts (harness sensitivity checks only).
 */
import type { Plugin } from 'vite'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

import harness from '../harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dirname, '../../..')
const wrapDir = path.resolve(dirname, 'wrap')
const targets = new Map<string, string>(
  (
    JSON.parse(fs.readFileSync(path.join(wrapDir, 'targets.json'), 'utf8')) as [string, string][]
  ).map(([source, wrapper]) => [path.resolve(root, source), path.join(wrapDir, wrapper)]),
)
const opsGlobalHost = path.resolve(root, 'packages/engine-rs/src/ops-global/host.ts')
const mutantHost = path.resolve(dirname, 'mutantHost.ts')
const basenames = new Set([...targets.keys()].map((file) => path.basename(file, '.ts')))
const sourcePattern = new RegExp(`(${[...basenames].join('|')}|host)(\\.js|\\.ts)?$`)

const tracePlugin = (): Plugin => ({
  name: 'rs-core-ops-global',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || !sourcePattern.test(source)) {
      return null
    }
    if (importer.startsWith(wrapDir) || importer === mutantHost) {
      return null
    }
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    if (!resolved) {
      return null
    }
    if (resolved.id === opsGlobalHost) {
      return process.env.RS_OPS_GLOBAL_MUTANT ? mutantHost : null
    }
    return targets.get(resolved.id) ?? null
  },
})

const intProject = (harness.test?.projects ?? [])[0] as Record<string, any>

export default defineConfig({
  ...harness,
  test: {
    ...harness.test,
    projects: [
      {
        ...intProject,
        plugins: [...(intProject.plugins ?? []), tracePlugin()],
      },
    ],
  },
})
