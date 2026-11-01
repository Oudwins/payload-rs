/**
 * The root `int` project plus ./captureSetup.ts, so upstream int suites record transformForWrite
 * fixtures. Run from the repo root:
 *
 *   SQLITE_URL=file:/tmp/rs-write.db PAYLOAD_DATABASE=sqlite DISABLE_LOGGING=true \
 *     pnpm vitest run --config test/__rs/write/vitest.capture.config.ts --project int test/fields/int.spec.ts
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import base from '../../../vitest.config.ts'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const projects = (base.test?.projects ?? []) as any[]
const int = projects.find((p) => p?.test?.name === 'int')

int.test.setupFiles = [...int.test.setupFiles, path.resolve(dirname, 'captureSetup.ts')]
base.test!.projects = [int]

export default base
