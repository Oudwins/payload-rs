// Compares per-test outcomes of two vitest JSON reports (run-upstream.sh output).
// Usage: node test/__rs/core-validate/compare.mjs <reference.json> <candidate.json>
// Exits 1 when any test's status differs or a test exists in only one report.
import fs from 'node:fs'

const load = (file) => {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  const outcomes = new Map()
  for (const suite of report.testResults) {
    for (const test of suite.assertionResults) {
      outcomes.set(test.fullName, test.status)
    }
  }
  return outcomes
}

const [referenceFile, candidateFile] = process.argv.slice(2)
const reference = load(referenceFile)
const candidate = load(candidateFile)
const diffs = []
for (const [name, status] of reference) {
  const other = candidate.get(name)
  if (other !== status) {
    diffs.push(`${name}: ${status} -> ${other ?? 'missing'}`)
  }
}
for (const name of candidate.keys()) {
  if (!reference.has(name)) {
    diffs.push(`${name}: missing -> ${candidate.get(name)}`)
  }
}
const count = (outcomes, status) => [...outcomes.values()].filter((s) => s === status).length
console.log(
  `${candidateFile}: ${reference.size} tests, reference passed ${count(reference, 'passed')}, ` +
    `candidate passed ${count(candidate, 'passed')}, outcome differences ${diffs.length}`,
)
for (const diff of diffs) {
  console.log(`  ${diff}`)
}
process.exitCode = diffs.length ? 1 : 0
