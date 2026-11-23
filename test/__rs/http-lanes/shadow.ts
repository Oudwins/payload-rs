/**
 * Shadow wrappers of the HTTP fast paths (see ./plugin.ts). Every call runs the fast path, then the
 * exact reference, and compares:
 *
 * - `verifyJWTSync`: a decided token (`{ payload, protectedHeader }`) must verify with jose's
 *   `jwtVerify(token, secretBytes)` to the same JSON; an undecided one is counted (`fallback`), with
 *   `fallbackJoseOk` when jose accepts it (exact, but the fast path missed).
 * - `parseWithCache`: the returned document must serialize like a fresh `parse(query)`; `hit`
 *   counts documents returned before (the cache served them).
 * - `validateWithCache`: the returned errors must serialize like `validate(schema, document, rules)`
 *   with every rule uncached; `lane` counts rule lists built by `concatRules` (the memoized path),
 *   `laneRepeat` those whose (schema, document) was validated before (a memo hit).
 *
 * One JSON line per event goes to PAYLOAD_RS_HTTP_SHADOW_REPORT (appended; unset: counted in
 * memory only, `shadowCounters()`); ./summarize.mjs adds them up.
 */
import type { DocumentNode, GraphQLError, GraphQLSchema, ValidationRule } from 'graphql'

import { parse, validate } from 'graphql'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const joseVerifyPath = createRequire(path.join(root, 'packages/payload/package.json')).resolve(
  'jose/jwt/verify',
)
const reportFile = process.env.PAYLOAD_RS_HTTP_SHADOW_REPORT
const counters: Record<string, number> = {}

export const shadowCounters = () => ({ ...counters })

const record = (event: string, details?: Record<string, unknown>) => {
  counters[event] = (counters[event] ?? 0) + 1
  if (reportFile) {
    appendFileSync(reportFile, `${JSON.stringify({ event, test: currentTest(), ...details })}\n`)
  }
}

const currentTest = () => {
  try {
    return (globalThis as any).expect?.getState?.().currentTestName
  } catch {
    return undefined
  }
}

const errorsJSON = (errors: readonly GraphQLError[]) =>
  JSON.stringify(errors.map((error) => error.toJSON()))

const seenDocuments = new WeakSet<DocumentNode>()
const laneRules = new WeakSet<readonly ValidationRule[]>()
const validatedDocuments = new WeakMap<GraphQLSchema, WeakSet<DocumentNode>>()

const wrappers: Record<string, (upstream: any) => any> = {
  concatRules: (upstream) => (args: unknown) => {
    const rules = upstream(args)
    laneRules.add(rules)
    return rules
  },
  parseWithCache: (upstream) => (query: string) => {
    const document: DocumentNode = upstream(query)
    const isHit = seenDocuments.has(document)
    seenDocuments.add(document)
    const fresh = parse(query)
    if (JSON.stringify(fresh) !== JSON.stringify(document)) {
      record('parse:divergence', { query })
    } else {
      record(isHit ? 'parse:hit' : 'parse:miss')
    }
    return document
  },
  validateWithCache:
    (upstream) =>
    (schema: GraphQLSchema, document: DocumentNode, rules: readonly ValidationRule[]) => {
      const result: readonly GraphQLError[] = upstream(schema, document, rules)
      let documents = validatedDocuments.get(schema)
      if (!documents) {
        documents = new WeakSet()
        validatedDocuments.set(schema, documents)
      }
      const isRepeat = documents.has(document)
      documents.add(document)
      let reference: string
      try {
        reference = errorsJSON(validate(schema, document, rules))
      } catch (error) {
        record('validate:divergence', { reason: `reference threw ${String(error)}` })
        return result
      }
      const actual = errorsJSON(result)
      if (actual !== reference) {
        record('validate:divergence', { actual, reference })
      } else if (laneRules.has(rules)) {
        record(isRepeat ? 'validate:laneRepeat' : 'validate:lane', {
          errors: result.length,
        })
      } else {
        record('validate:other')
      }
      return result
    },
  verifyJWTSync: (upstream) => (args: { secret: string; token: string }) => {
    const result = upstream(args)
    void import(joseVerifyPath).then(({ jwtVerify }) =>
      jwtVerify(args.token, new TextEncoder().encode(args.secret)).then(
        (verified: { payload: unknown; protectedHeader: unknown }) => {
          if (!result) {
            record('jwt:fallbackJoseOk')
            return
          }
          const reference = JSON.stringify({
            payload: verified.payload,
            protectedHeader: verified.protectedHeader,
          })
          if (reference !== JSON.stringify(result)) {
            record('jwt:divergence', { actual: JSON.stringify(result), reference })
          } else {
            record('jwt:hit')
          }
        },
        (error: unknown) => {
          if (result) {
            record('jwt:divergence', { reason: `jose rejected: ${String(error)}` })
          } else {
            record('jwt:fallback')
          }
        },
      ),
    )
    return result
  },
}

export const shadow = <T>(name: string, upstream: T): T => {
  const wrap = wrappers[name]
  if (!wrap) {
    throw new Error(`rs-http-lanes-shadow: no wrapper for ${name}`)
  }
  return wrap(upstream)
}
