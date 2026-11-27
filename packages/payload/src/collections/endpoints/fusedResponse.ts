import type { Access } from '../../config/types.js'
import type { FlattenedField } from '../../fields/config/types.js'
import type { PayloadRequest, Where } from '../../types/index.js'
import type { Collection } from '../config/types.js'

import { defaultAccess } from '../../auth/defaultAccess.js'
import { isRustCoreEngine } from '../../utilities/engineSelection.js'
import { httpStatus } from '../../utilities/httpStatus.js'
import { skipCompilation } from '../../utilities/skipCompilation.js'

type FusedOperation = 'count' | 'find' | 'findByID'

/** The arguments a default read handler passes to its operation. */
type ReadOperationArgs = {
  collection: Collection
  id?: number | string
  joins?: unknown
  overrideAccess?: boolean
  req: PayloadRequest
  sort?: unknown
  where?: Where
} & Record<string, unknown>

type FusedOperationText = (args: {
  operation: FusedOperation
  operationArgs: ReadOperationArgs
}) => Promise<string | Uint8Array<ArrayBuffer> | undefined> | string | undefined

type FusedWriteOperation = 'create' | 'updateByID'

/**
 * `@payloadcms/engine-rs/ops-write` `fusedWriteResult`: the operation, resolving with the UTF-8
 * bytes of `JSON.stringify(result)` when the fused write lane served it, else with the result.
 */
type FusedWriteResult = (args: {
  operation: FusedWriteOperation
  operationArgs: Record<string, unknown>
}) => Promise<{ bytes: Uint8Array<ArrayBuffer> } | { doc: unknown }>

// oxlint-disable-next-line typescript/no-explicit-any
type AnyFunction = (...args: any[]) => any

/** The function compiler (`@payloadcms/engine-rs/compile`, RUST_PERF_PLAN.md S6). */
type Compiler = {
  evaluateOnLane: (
    fn: AnyFunction,
    args: unknown[],
  ) => { ok: false; reason: string } | { ok: true; value: unknown }
}

/**
 * The fused lanes' text entry (`@payloadcms/engine-rs/ops`, FUSE_CONTRACT.md "Text results") and
 * the function compiler, loaded like the Rust operations (`isRustCoreEngine()`); unset until
 * loaded, and never with `PAYLOAD_ENGINE=ts`.
 */
let fusedOperationText: FusedOperationText | undefined
let fusedWriteResult: FusedWriteResult | undefined
let compiler: Compiler | undefined

if (isRustCoreEngine()) {
  void import('../../utilities/importRustEngine.js')
    .then(({ importRustEngine }) =>
      Promise.all([
        importRustEngine('@payloadcms/engine-rs/ops'),
        importRustEngine('@payloadcms/engine-rs/compile'),
        importRustEngine('@payloadcms/engine-rs/ops-write'),
      ]),
    )
    .then(
      ([ops, compile, opsWrite]: [
        { fusedOperationText?: FusedOperationText },
        Compiler,
        { fusedWriteResult?: FusedWriteResult },
      ]) => {
        compiler = compile
        fusedOperationText = ops.fusedOperationText
        fusedWriteResult = opsWrite.fusedWriteResult
      },
    )
    .catch(() => {})
}

/**
 * The response of a default read handler (find / findByID / count) served as bytes by the fused
 * lane (RUST_HTTP_LANES.md 3.3), or `exact()` (the handler's own path) when the lane does not
 * serve the call. The lane's text is canonical (`JSON.stringify(JSON.parse(text))`), i.e. the body
 * `Response.json(result)` writes (as a string, or as its UTF-8 bytes from an asynchronous backend,
 * RUST_HTTP_LANES.md section 6), and the headers follow `Response.json`: the handler's headers,
 * then `content-type: application/json` when absent. `headers` runs only when the lane serves.
 *
 * `operationArgs` are the arguments the handler passes to the operation; the exact path receives
 * them unchanged. The collection's read access is decided here when that is side-effect free
 * (`isAccessGranted`), so the lane can serve the call as with `overrideAccess` when every other
 * effect of `overrideAccess: false` is a no-op for it (`isAccessFusable`). The lane runs first and
 * access is decided only for a call it served: a served fused read runs no JS and has no other
 * effect, so its text is simply dropped (and the exact path runs) unless the access is `true`.
 * Requests the lane cannot serve (no fused backend for the database, a guard) pay no access
 * evaluation.
 */
export const fusedResponse = async ({
  exact,
  headers,
  operation,
  operationArgs,
}: {
  exact: () => Promise<Response>
  headers: () => Headers
  operation: FusedOperation
  operationArgs: ReadOperationArgs
}): Promise<Response> => {
  const lane = fusedOperationText

  if (!lane) {
    return exact()
  }

  let text: string | Uint8Array<ArrayBuffer> | undefined

  try {
    const isFusable = isAccessFusable({ operation, operationArgs })
    const laneArgs = isFusable ? { ...operationArgs, overrideAccess: true } : operationArgs
    const pending = lane({ operation, operationArgs: laneArgs })

    text = typeof pending === 'string' || pending === undefined ? pending : await pending

    if (text !== undefined && isFusable && !isAccessGranted({ operation, operationArgs })) {
      text = undefined
    }
  } catch {
    text = undefined
  }

  if (text === undefined) {
    return exact()
  }

  const responseHeaders = headers()

  if (!responseHeaders.has('content-type')) {
    responseHeaders.append('content-type', 'application/json')
  }

  return new Response(text, { headers: responseHeaders, status: httpStatus.OK })
}

/**
 * The response of a default create / updateByID handler, `Response.json({ doc, message },
 * { headers, status })`, with the document as bytes when the fused write lane serves the call
 * (RUST_HTTP_LANES.md section 6). `exact` is the handler's operation call, made when the Rust
 * engine is not loaded; otherwise the engine's `fusedWriteResult` runs the same operation and
 * gives its result either as the bytes of `JSON.stringify(doc)` or as the document. `message`
 * and `headers` are called once each, after the operation, in that order (as the handler's
 * `Response.json` arguments evaluate).
 *
 * A served write leaves the request dataloader without the result's populated documents and a
 * create leaves `req.data` without `beforeValidate`'s in-place changes (the materialized lane
 * reproduces both): no code reads them after the operation (the handler only translates its
 * message, `handleEndpoints` only merges headers).
 */
export const fusedWriteResponse = async ({
  exact,
  headers,
  message,
  operation,
  operationArgs,
  status,
}: {
  exact: () => Promise<unknown>
  headers: () => Headers
  message: () => unknown
  operation: FusedWriteOperation
  operationArgs: Record<string, unknown>
  status: number
}): Promise<Response> => {
  const lane = fusedWriteResult
  const outcome = lane ? await lane({ operation, operationArgs }) : { doc: await exact() }

  if ('doc' in outcome) {
    return Response.json({ doc: outcome.doc, message: message() }, { headers: headers(), status })
  }

  return bytesWriteResponse({ bytes: outcome.bytes, headers, message, status })
}

const encoder = new TextEncoder()

/** `{"doc":` */
const docPrefix = encoder.encode('{"doc":')

/**
 * `Response.json({ doc, message: message() }, { headers: headers(), status })` for the document
 * whose `JSON.stringify` is `bytes`: the body `{"doc":<bytes>,"message":<message as JSON>}` for a
 * string message (what `JSON.stringify` writes for the object), with `Response.json`'s headers
 * (the handler's, then `content-type: application/json` when absent). Any other message goes
 * through `Response.json` with the document parsed (canonical text: its stringify is `bytes`).
 */
export const bytesWriteResponse = ({
  bytes,
  headers,
  message,
  status,
}: {
  bytes: Uint8Array<ArrayBuffer>
  headers: () => Headers
  message: () => unknown
  status: number
}): Response => {
  const text = message()
  const responseHeaders = headers()

  if (typeof text !== 'string') {
    return Response.json(
      { doc: JSON.parse(new TextDecoder().decode(bytes)), message: text },
      { headers: responseHeaders, status },
    )
  }

  if (!responseHeaders.has('content-type')) {
    responseHeaders.append('content-type', 'application/json')
  }

  const suffix = encoder.encode(`,"message":${JSON.stringify(text)}}`)
  const body = new Uint8Array(docPrefix.length + bytes.length + suffix.length)

  body.set(docPrefix)
  body.set(bytes, docPrefix.length)
  body.set(suffix, docPrefix.length + bytes.length)

  return new Response(body, { headers: responseHeaders, status })
}

/**
 * Whether a read without `overrideAccess` behaves exactly like one with it, given the request and
 * a read access that grants it with `true` (`isAccessGranted`, decided after the lane ran; the
 * exact path would call the access once and continue with `combineQueries(where, true)`, i.e. the
 * same `where`):
 *
 * - no field has read access (with `overrideAccess: false` afterRead and path validation read it);
 * - `where` and the effective sort (`sort || defaultSort`) only name top-level fields that are not
 *   relationship / upload / join fields, nor `hash` / `salt` (path validation without
 *   `overrideAccess` evaluates this collection's permissions, i.e. `defaultAccess` again, runs the
 *   related collection's read access for paths through a relationship and rejects credential
 *   paths of auth collections);
 * - no `joins` argument (join sanitization reads the joined collections' access).
 */
const isAccessFusable = ({
  operation,
  operationArgs,
}: {
  operation: FusedOperation
  operationArgs: ReadOperationArgs
}) => {
  const { collection, joins, overrideAccess, sort, where } = operationArgs

  if (overrideAccess || joins !== undefined) {
    return false
  }

  const config = collection?.config

  if (!config || !hasNoFieldAccess(config)) {
    return false
  }

  if (operation !== 'findByID') {
    if (!isPlainWhere({ fields: config.flattenedFields, where })) {
      return false
    }
  }

  return (
    operation !== 'find' ||
    isPlainSort({ fields: config.flattenedFields, sort: sort || config.defaultSort })
  )
}

/**
 * Whether the read access returns `true` for this request, decided without running user code:
 *
 * - Payload's own `defaultAccess`: a pure function of `req.user` and the config, called here;
 * - a user function the compiler accepted (RUST_PERF_PLAN.md S6 / owner decision D5): its IR is
 *   evaluated on the arguments `executeAccess` passes (`{ id, slug, data, isReadingStaticFile,
 *   req, skipCompilation }`); IR evaluation has no side effects, and the lane only serves when the
 *   result is exactly `true`. As on the fused lane (`evaluateOnLane`): only with guard mode's call
 *   sites installed, for an active function, and not for calls the guard samples (those run the
 *   exact path, where the guard verifies them).
 *
 * Anything else (no compiled version, an IR bail, a `Where` or falsy result) sends the request
 * to the exact path, which calls the access function as before.
 */
const isAccessGranted = ({
  operation,
  operationArgs,
}: {
  operation: FusedOperation
  operationArgs: ReadOperationArgs
}) => {
  const { collection, req } = operationArgs
  const { slug, access: accessConfig } = collection.config
  const access = accessConfig?.read
  const id = operation === 'findByID' ? operationArgs.id : undefined

  if (access === defaultAccess) {
    return defaultAccess({ req }) === true
  }
  if (!access || !compiler) {
    return false
  }
  const evaluated = compiler.evaluateOnLane(access, [
    { id, slug, data: undefined, isReadingStaticFile: false, req, skipCompilation },
  ])
  return evaluated.ok && evaluated.value === true
}

const noFieldAccessByConfig = new WeakMap<object, boolean>()

const hasNoFieldAccess = (config: Collection['config']) => {
  let result = noFieldAccessByConfig.get(config)

  if (result === undefined) {
    result = fieldsHaveNoAccess(config.flattenedFields)
    noFieldAccessByConfig.set(config, result)
  }

  return result
}

/**
 * No field (through groups, tabs, arrays and inline blocks) has read access (`access.read`;
 * sanitization gives every field an `access` object); block references count as access.
 */
const fieldsHaveNoAccess = (fields: FlattenedField[]): boolean =>
  fields.every((field) => {
    if ('access' in field && field.access?.read) {
      return false
    }
    if (field.type === 'blocks') {
      return field.blocks.every(
        (block) => typeof block !== 'string' && fieldsHaveNoAccess(block.flattenedFields),
      )
    }
    if ('flattenedFields' in field && Array.isArray(field.flattenedFields)) {
      return fieldsHaveNoAccess(field.flattenedFields)
    }
    return true
  })

const relationTypes = new Set(['join', 'relationship', 'upload'])

/** Rejected without `overrideAccess` on auth collections (path validation). */
const credentialPaths = new Set(['hash', 'salt'])

const isPlainPath = ({ fields, path }: { fields: FlattenedField[]; path: string }) => {
  if (path === 'id') {
    return true
  }
  if (credentialPaths.has(path)) {
    return false
  }
  const field = fields.find((each) => each.name === path)
  return field !== undefined && !relationTypes.has(field.type)
}

const isPlainWhere = ({ fields, where }: { fields: FlattenedField[]; where: unknown }): boolean => {
  if (where === undefined || where === null) {
    return true
  }
  if (typeof where !== 'object' || Array.isArray(where)) {
    return false
  }
  for (const [key, value] of Object.entries(where)) {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(value) || !value.every((item) => isPlainWhere({ fields, where: item }))) {
        return false
      }
    } else if (!isPlainPath({ fields, path: key })) {
      return false
    }
  }
  return true
}

const isPlainSort = ({ fields, sort }: { fields: FlattenedField[]; sort: unknown }) => {
  if (sort === undefined || sort === null || sort === '') {
    return true
  }
  const paths = typeof sort === 'string' ? sort.split(',') : sort
  return (
    Array.isArray(paths) &&
    paths.every(
      (path) =>
        typeof path === 'string' &&
        isPlainPath({ fields, path: path.startsWith('-') ? path.slice(1) : path }),
    )
  )
}
