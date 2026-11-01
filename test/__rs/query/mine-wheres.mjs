// Extracts every literal `where:` / `sort:` value from the upstream int specs into
// fixtures/mined.json. Only values built purely from literals are kept (identifiers,
// calls and spreads are skipped).
//
// Run: node test/__rs/query/mine-wheres.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.resolve(dirname, '../..')

const specFiles = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__rs') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.name.endsWith('.spec.ts')) {
      specFiles.push(full)
    }
  }
}
walk(testDir)

const NOT_LITERAL = Symbol('notLiteral')

const evaluate = (node) => {
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return node.text
    case ts.SyntaxKind.NumericLiteral:
      return Number(node.text)
    case ts.SyntaxKind.TrueKeyword:
      return true
    case ts.SyntaxKind.FalseKeyword:
      return false
    case ts.SyntaxKind.NullKeyword:
      return null
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const v = evaluate(node.operand)
      if (typeof v !== 'number') {
        return NOT_LITERAL
      }
      return node.operator === ts.SyntaxKind.MinusToken ? -v : v
    }
    case ts.SyntaxKind.ParenthesizedExpression:
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.SatisfiesExpression:
      return evaluate(node.expression)
    case ts.SyntaxKind.ArrayLiteralExpression: {
      const out = []
      for (const el of node.elements) {
        const v = evaluate(el)
        if (v === NOT_LITERAL) {
          return NOT_LITERAL
        }
        out.push(v)
      }
      return out
    }
    case ts.SyntaxKind.ObjectLiteralExpression: {
      const out = {}
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) {
          return NOT_LITERAL
        }
        let key
        if (
          ts.isIdentifier(prop.name) ||
          ts.isStringLiteral(prop.name) ||
          ts.isNumericLiteral(prop.name)
        ) {
          key = prop.name.text
        } else if (ts.isComputedPropertyName(prop.name)) {
          const k = evaluate(prop.name.expression)
          if (typeof k !== 'string') {
            return NOT_LITERAL
          }
          key = k
        } else {
          return NOT_LITERAL
        }
        const v = evaluate(prop.initializer)
        if (v === NOT_LITERAL) {
          return NOT_LITERAL
        }
        out[key] = v
      }
      return out
    }
    default:
      return NOT_LITERAL
  }
}

const wheres = new Map()
const sorts = new Map()

for (const file of specFiles) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
      const name = node.name.text
      if (name === 'where' || name === 'sort') {
        const v = evaluate(node.initializer)
        if (v !== NOT_LITERAL) {
          const target = name === 'where' ? wheres : sorts
          const key = JSON.stringify(v)
          if (!target.has(key)) {
            target.set(key, { file: path.relative(testDir, file), value: v })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const out = {
  sorts: [...sorts.values()],
  wheres: [...wheres.values()].filter((w) => w.value && typeof w.value === 'object'),
}
fs.mkdirSync(path.join(dirname, 'fixtures'), { recursive: true })
fs.writeFileSync(path.join(dirname, 'fixtures', 'mined.json'), JSON.stringify(out, null, 2))
console.log(
  `mined ${out.wheres.length} wheres and ${out.sorts.length} sorts from ${specFiles.length} spec files`,
)
