/**
 * Runs upstream int suites with the upsert recorder installed:
 *
 *   UPSERT_RECORD_OUT=/tmp/x.jsonl SQLITE_URL=file:/tmp/rs-upsert.db PAYLOAD_DATABASE=sqlite \
 *     pnpm vitest run -c test/__rs/upsert/vitest.record.config.ts --project int test/<suite>/int.spec.ts
 *
 * (see record.sh)
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
