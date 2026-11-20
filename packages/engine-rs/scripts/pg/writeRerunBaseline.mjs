#!/usr/bin/env node
/**
 * Merges the vitest JSON of the files a runSuites.mjs run re-ran alone (`--rerun-failed`,
 * `<out>/results/*.rerun1.json`) into one file with repo-relative names, e.g.
 * .rs-baseline/postgres-uuid-rerun.json. Comparison runs pass it as a second `--baseline` so
 * either outcome of a flaky test is accepted; summaryFromBaselines.mjs reads it as `--rerun`.
 *
 *   node packages/engine-rs/scripts/pg/writeRerunBaseline.mjs /tmp/rs-pg-runs/<tag> <out.json>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const [runDir, outFile] = process.argv.slice(2)
if (!runDir || !outFile) {
  throw new Error('usage: writeRerunBaseline.mjs <run dir> <out.json>')
}

const summary = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'))
const resultsDir = path.join(runDir, 'results')
const testResults = fs
  .readdirSync(resultsDir)
  .filter((name) => name.endsWith('.rerun1.json'))
  .sort()
  .flatMap((name) => {
    const fileResult = JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8'))
      .testResults?.[0]
    return fileResult ? [{ ...fileResult, name: path.relative(root, fileResult.name) }] : []
  })
  .sort((a, b) => a.name.localeCompare(b.name))

fs.writeFileSync(
  path.resolve(outFile),
  JSON.stringify({
    database: summary.options.database,
    engine: summary.options.engine,
    rerunOf: path.relative(root, path.resolve(outFile)).replace(/-rerun\.json$/, '.json'),
    testResults,
  }),
)
process.stdout.write(`${outFile}: ${testResults.length} re-run files\n`)
