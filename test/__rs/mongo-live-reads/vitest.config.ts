/**
 * Upstream int suites on MongoDB with the read data methods served by the live Rust engine
 * (crates/payload-mongo-live): the mongo harness config (test/__rs/mongo-harness/vitest.config.ts)
 * with `databaseAdapter.js` resolved to ./databaseAdapter.ts.
 *
 *   node test/__rs/mongo-harness/runSuites.mjs --config test/__rs/mongo-live-reads/vitest.config.ts \
 *     --addon /tmp/livereads-addon/payload-engine.node --tag livereads --baseline .rs-baseline/mongodb-all.json <files>
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import harness from '../mongo-harness/vitest.config.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const projects = (harness.test?.projects ?? []).map((project: any) => ({
  ...project,
  resolve: {
    ...project.resolve,
    alias: [
      {
        find: /^(\.{1,2}\/)+databaseAdapter\.js$/,
        replacement: path.resolve(dirname, 'databaseAdapter.ts'),
      },
      ...(project.resolve?.alias ?? []).slice(1),
    ],
  },
}))

export default { ...harness, test: { ...harness.test, projects } }
