import fs from 'node:fs'
import path from 'node:path'

import { toReportValue } from './compare.js'

export type ShadowContext = {
  /** Absolute or repo-relative path of the running test file, if any. */
  testFile?: string
  /** Full name of the running test, if any. */
  testName?: string
}

export type ShadowRecord = {
  [key: string]: unknown
  type: 'divergence' | 'session' | 'stats' | 'unshadowed'
}

export type ShadowReporter = {
  /** Current test file / test name (empty outside a test runner). */
  context: () => ShadowContext
  write: (record: ShadowRecord) => void
}

export type ReportOption =
  | ((record: ShadowContext & ShadowRecord) => void)
  | {
      /** Optional context provider (current test file / test name). */
      context?: () => ShadowContext
      /**
       * Directory for `<test file>.jsonl` files. Default
       * `<cwd>/.rs-baseline/divergences`.
       */
      dir?: string
      /** Explicit file; overrides `dir`. */
      file?: string
      /** Additionally invoked for every record. */
      onRecord?: (record: ShadowContext & ShadowRecord) => void
    }

/** Max characters of a single serialised value kept in a record. */
const MAX_VALUE_CHARS = 8_000

const truncate = (value: unknown) => {
  const json = JSON.stringify(toReportValue(value))
  if (json === undefined || json.length <= MAX_VALUE_CHARS) {
    return json === undefined ? undefined : JSON.parse(json)
  }
  return { $length: json.length, $truncated: json.slice(0, MAX_VALUE_CHARS) }
}

/** Files truncated by this process (a report file is reset once per process). */
const resetFiles = new Set<string>()

export const reportFileName = (testFile: string | undefined, cwd = process.cwd()) => {
  if (!testFile) {
    return 'no-test-file.jsonl'
  }
  const rel = path.isAbsolute(testFile) ? path.relative(cwd, testFile) : testFile
  return `${rel.split(path.sep).join('__')}.jsonl`
}

export function createReporter(option: ReportOption | undefined): ShadowReporter {
  if (typeof option === 'function') {
    return { context: () => ({}), write: (record) => option(record) }
  }
  const context: () => ShadowContext = option?.context ?? (() => ({}))
  const dir = option?.dir ?? path.resolve(process.cwd(), '.rs-baseline', 'divergences')

  return {
    context,
    write(record) {
      const ctx = context()
      const full = { ...record, ...ctx }
      option?.onRecord?.(full)
      const file = option?.file ?? path.join(dir, reportFileName(ctx.testFile))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (!resetFiles.has(file)) {
        resetFiles.add(file)
        fs.writeFileSync(file, '')
      }
      fs.appendFileSync(file, `${JSON.stringify(full)}\n`)
    },
  }
}

export { truncate as truncateForReport }
