/**
 * The root `int` project plus ./record.setup.ts (see record.sh):
 *
 *   RS_CORE_QUERY_OUT=/tmp/x.jsonl SQLITE_URL=file:/tmp/rs-core-query.db TZ=UTC PAYLOAD_DATABASE=sqlite \
 *     pnpm vitest run -c test/__rs/core-query/vitest.record.config.ts --project int test/<suite>/int.spec.ts
 */
import path from 'node:path'
import { defineConfig } from 'vitest/config'

import rootConfig from '../../../vitest.config.js'

const root = path.resolve(import.meta.dirname, '../../..')
const setup = path.resolve(import.meta.dirname, 'record.setup.ts')

const projects = (rootConfig.test?.projects ?? []).map((project: any) => {
  if (project?.test?.name !== 'int') {
    return project
  }
  return {
    ...project,
    test: { ...project.test, setupFiles: [...(project.test.setupFiles ?? []), setup] },
  }
})

export default defineConfig({
  ...rootConfig,
  root,
  test: { ...rootConfig.test, projects },
})
