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
 * - `fusedResponse` (byte lanes of the default read handlers): when the lane serves a request,
 *   the exact path runs too and the responses must have the same status, header list (name, value,
 *   in order) and body bytes; the exact response is returned. `bytes:hit:<operation>` counts served
 *   requests, `bytes:exact:<operation>` the others.
 * - `bytesWriteResponse` (the default create / updateByID handlers' response from a write the fused
 *   lane served as bytes; the write itself cannot run twice): the document bytes must be canonical
 *   (`JSON.stringify(JSON.parse(text)) === text`), and the response must have the status, header
 *   list and body bytes of `Response.json({ doc: JSON.parse(text), message }, { headers, status })`
 *   (the handler's exact response for that document); `bytes:hit:write` counts them. That the
 *   document is the exact lane's result is the write lane-shadow's check (`--fuse-writes shadow`,
 *   packages/engine-rs/src/fuse-write `compareBytes`).
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

const describeResponse = async (response: Response) => ({
  body: await response.text(),
  headers: JSON.stringify([...response.headers]),
  status: response.status,
})

type FusedResponseArgs = {
  exact: () => Promise<Response>
  headers: () => Headers
  operation: string
  operationArgs: Record<string, unknown>
}

type BytesWriteResponseArgs = {
  bytes: Uint8Array
  headers: () => Headers
  message: () => unknown
  status: number
}

const wrappers: Record<string, (upstream: any) => any> = {
  bytesWriteResponse: (upstream) => async (args: BytesWriteResponseArgs) => {
    const lane: Response = upstream(args)
    const text = new TextDecoder().decode(args.bytes)
    const isCanonical = JSON.stringify(JSON.parse(text)) === text
    const exact = Response.json(
      { doc: JSON.parse(text), message: args.message() },
      { headers: args.headers(), status: args.status },
    )
    const expected = await describeResponse(exact)
    const actual = await describeResponse(lane.clone())
    if (!isCanonical || JSON.stringify(actual) !== JSON.stringify(expected)) {
      record('bytes:divergence', {
        actual: JSON.stringify(actual).slice(0, 2000),
        expected: JSON.stringify(expected).slice(0, 2000),
        isCanonical,
        operation: 'write',
      })
    } else {
      record('bytes:hit:write')
    }
    return lane
  },
  fusedResponse: (upstream) => async (args: FusedResponseArgs) => {
    const notServed = new Response(null, { status: 599 })
    const runLane = (): Promise<Response> => upstream({ ...args, exact: async () => notServed })
    const lane = await runLane()
    if (lane === notServed) {
      record(`bytes:exact:${args.operation}`)
      return args.exact()
    }
    const exact = await args.exact()
    const expected = await describeResponse(exact.clone())
    let actual = await describeResponse(lane)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      // a concurrent write between the two reads: compare with a lane response made now
      const again = await runLane()
      actual = again === notServed ? actual : await describeResponse(again)
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      record('bytes:divergence', {
        actual: JSON.stringify(actual).slice(0, 2000),
        expected: JSON.stringify(expected).slice(0, 2000),
        operation: args.operation,
      })
    } else {
      record(`bytes:hit:${args.operation}`)
    }
    return exact
  },
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
