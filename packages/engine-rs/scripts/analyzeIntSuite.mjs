#!/usr/bin/env node
/**
 * Static analysis of the upstream int suite (test/**\/*int.spec.ts, excluding
 * test/__rs) used for test/__rs/README.md: per-file DB gating, feature usage
 * and assertion style. Prints JSON (or markdown with --md).
 *
 *   node packages/engine-rs/scripts/analyzeIntSuite.mjs --md
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const testDir = path.join(root, 'test')

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__rs' || entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.name.endsWith('int.spec.ts')) {
      out.push(full)
    }
  }
  return out
}

const files = walk(testDir).sort()

const features = {
  'Local find': /payload\.find\(/g,
  findByID: /\.findByID\(/g,
  create: /payload\.create\(/g,
  update: /payload\.update\(/g,
  delete: /payload\.delete\(/g,
  count: /payload\.count\(/g,
  findDistinct: /findDistinct\(/g,
  'versions (find/count/byID)':
    /(findVersions|findVersionByID|countVersions|findGlobalVersions|countGlobalVersions)\(/g,
  restoreVersion: /restore(Global)?Version\(/g,
  globals: /(findGlobal|updateGlobal)\(/g,
  'draft: true': /draft: true/g,
  autosave: /autosave/g,
  "locale: 'all'": /locale: 'all'/g,
  'locale:': /\blocale: /g,
  fallbackLocale: /fallbackLocale/g,
  'depth:': /\bdepth: /g,
  'select:': /\bselect: \{/g,
  'populate:': /\bpopulate: \{/g,
  'joins:': /\bjoins: /g,
  'sort:': /\bsort: /g,
  'where:': /\bwhere: /g,
  'limit/page': /\b(limit|page): /g,
  'pagination: false': /pagination: false/g,
  'payload.db.<method>(': /payload\.db\.[a-zA-Z]+\(/g,
  'raw drizzle/execute': /payload\.db\.drizzle|\.execute\(\{/g,
  'REST client': /restClient\.(GET|POST|PATCH|PUT|DELETE)|\bsdk\./g,
  GraphQL: /graphql/gi,
  'overrideAccess: false': /overrideAccess: false/g,
  'expects throw/reject': /rejects\.|toThrow/g,
  'hooks referenced':
    /\b(beforeChange|afterChange|afterRead|beforeValidate|beforeOperation|afterOperation|beforeRead|beforeDelete|afterDelete)\b/g,
}

const operators = [
  'equals',
  'not_equals',
  'in',
  'not_in',
  'all',
  'exists',
  'greater_than',
  'greater_than_equal',
  'less_than',
  'less_than_equal',
  'like',
  'not_like',
  'contains',
  'near',
  'within',
  'intersects',
]

const assertions = {
  'toEqual (loose: ignores undefined props, key order)': /\.toEqual\(/g,
  'toStrictEqual (undefined-aware, no key order)': /\.toStrictEqual\(/g,
  'toMatchObject (subset)': /\.toMatchObject\(/g,
  'toBe (single value)': /\.toBe\(/g,
  toHaveLength: /\.toHaveLength\(/g,
  'toBeDefined/Undefined/Truthy/Falsy': /\.(toBeDefined|toBeUndefined|toBeTruthy|toBeFalsy)\(/g,
  'toHaveProperty / objectContaining': /\.toHaveProperty\(|objectContaining/g,
  snapshots: /toMatch(Inline)?Snapshot/g,
  'Object.keys order checks': /Object\.keys\([^)]*\)\)\.(toEqual|toStrictEqual)/g,
}

const gating = {
  'test.suite db option / test.options': /\{\s*db: ['(]|test\.options/g,
  isMongoose: /isMongoose\(|isMongo\b/g,
  'PAYLOAD_DATABASE checks': /process\.env\.PAYLOAD_DATABASE/g,
  "db.name === 'sqlite'": /db\.name === 'sqlite'/g,
  'skipIf/runIf': /\.(skipIf|runIf)\(/g,
  'it.skip/describe.skip': /\b(it|test|describe)\.skip\b/g,
  'postgres-only': /postgres/gi,
}

const count = (text, re) => (text.match(re) ?? []).length

const perFile = files.map((file) => {
  const text = fs.readFileSync(file, 'utf8')
  const rel = path.relative(root, file)
  return {
    assertions: Object.fromEntries(
      Object.entries(assertions).map(([k, re]) => [k, count(text, re)]),
    ),
    features: Object.fromEntries(Object.entries(features).map(([k, re]) => [k, count(text, re)])),
    file: rel,
    gating: Object.fromEntries(Object.entries(gating).map(([k, re]) => [k, count(text, re)])),
    operators: Object.fromEntries(
      operators.map((op) => [op, count(text, new RegExp(`\\b${op}: `, 'g'))]),
    ),
  }
})

const aggregate = (key) => {
  const out = {}
  for (const f of perFile) {
    for (const [k, v] of Object.entries(f[key])) {
      out[k] ??= { files: 0, hits: 0 }
      out[k].hits += v
      out[k].files += v ? 1 : 0
    }
  }
  return out
}

const result = {
  assertions: aggregate('assertions'),
  features: aggregate('features'),
  files: files.length,
  gating: aggregate('gating'),
  operators: aggregate('operators'),
  perFile,
}

if (process.argv.includes('--md')) {
  const table = (title, obj) =>
    [
      `| ${title} | files | occurrences |`,
      '|---|---|---|',
      ...Object.entries(obj).map(([k, v]) => `| ${k} | ${v.files} | ${v.hits} |`),
      '',
    ].join('\n')
  console.log(`Analysed ${files.length} int spec files (test/__rs excluded).\n`)
  console.log(table('feature', result.features))
  console.log(table('where operator', result.operators))
  console.log(table('assertion', result.assertions))
  console.log(table('gating', result.gating))
} else {
  console.log(JSON.stringify(result, null, 1))
}
