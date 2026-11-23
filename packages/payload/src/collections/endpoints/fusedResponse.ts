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
}) => Promise<string | undefined> | string | undefined

// oxlint-disable-next-line typescript/no-explicit-any
type AnyFunction = (...args: any[]) => any

/** The function compiler (`@payloadcms/engine-rs/compile`, RUST_PERF_PLAN.md S6). */
type Compiler = {
  compileFunction: (fn: AnyFunction) => { ok: boolean }
  evaluateCompiled: (
    fn: AnyFunction,
    args: unknown[],
  ) => { ok: false; reason: string } | { ok: true; value: unknown }
  isCompiled: (fn: AnyFunction) => boolean
}

/**
 * The fused lanes' text entry (`@payloadcms/engine-rs/ops`, FUSE_CONTRACT.md "Text results") and
 * the function compiler, loaded like the Rust operations (`isRustCoreEngine()`); unset until
 * loaded, and never with `PAYLOAD_ENGINE=ts`.
 */
let fusedOperationText: FusedOperationText | undefined
let compiler: Compiler | undefined

if (isRustCoreEngine()) {
  void import('../../utilities/importRustEngine.js')
    .then(({ importRustEngine }) =>
      Promise.all([
        importRustEngine('@payloadcms/engine-rs/ops'),
        importRustEngine('@payloadcms/engine-rs/compile'),
      ]),
    )
    .then(([ops, compile]: [{ fusedOperationText?: FusedOperationText }, Compiler]) => {
      compiler = compile
      fusedOperationText = ops.fusedOperationText
    })
    .catch(() => {})
}

/**
 * Guard mode (`PAYLOAD_FN_COMPILE_GUARD`, engine-rs compile/guard.ts) verifies compiled functions at
 * their JS call sites: while it is on, compiled access never replaces a call here.
 */
const isCompileGuardOn = Boolean(process.env.PAYLOAD_FN_COMPILE_GUARD)

/**
 * The response of a default read handler (find / findByID / count) served as bytes by the fused
 * lane (RUST_HTTP_LANES.md 3.3), or `exact()` (the handler's own path) when the lane does not
 * serve the call. The lane's text is canonical (`JSON.stringify(JSON.parse(text))`), i.e. the body
 * `Response.json(result)` writes, and the headers follow `Response.json`: the handler's headers,
 * then `content-type: application/json` when absent. `headers` runs only when the lane serves.
 *
 * `operationArgs` are the arguments the handler passes to the operation; the exact path receives
 * them unchanged. The collection's read access is decided here when that is side-effect free
 * (`isAccessGranted`), so the lane can serve the call as with `overrideAccess` when every other
 * effect of `overrideAccess: false` is a no-op for it (`isAccessFusable`).
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

  let text: string | undefined

  try {
    const laneArgs = isAccessFusable({ operation, operationArgs })
      ? { ...operationArgs, overrideAccess: true }
      : operationArgs
    const pending = lane({ operation, operationArgs: laneArgs })

    text = typeof pending === 'string' || pending === undefined ? pending : await pending
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
 * Whether a read without `overrideAccess` behaves exactly like one with it, given the request:
 *
 * - the collection's read access grants this request with `true` (`isAccessGranted`; the exact
 *   path would call it once and continue with `combineQueries(where, true)`, i.e. the same
 *   `where`);
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
  const { collection, joins, overrideAccess, req, sort, where } = operationArgs

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

  if (
    operation === 'find' &&
    !isPlainSort({ fields: config.flattenedFields, sort: sort || config.defaultSort })
  ) {
    return false
  }

  return isAccessGranted({
    id: operation === 'findByID' ? operationArgs.id : undefined,
    slug: config.slug,
    access: config.access?.read,
    req,
  })
}

/**
 * Whether the read access returns `true` for this request, decided without running user code:
 *
 * - Payload's own `defaultAccess`: a pure function of `req.user` and the config, called here;
 * - a user function the compiler accepted (RUST_PERF_PLAN.md S6 / owner decision D5): its IR is
 *   evaluated on the arguments `executeAccess` passes (`{ id, slug, data, isReadingStaticFile,
 *   req, skipCompilation }`); IR evaluation has no side effects, and the lane only serves when the
 *   result is exactly `true`. Not while guard mode verifies compiled functions at the JS call
 *   sites, and not for a function guard mode de-optimised (`isCompiled`).
 *
 * Anything else (no compiled version, an IR bail, a `Where` or falsy result) sends the request
 * to the exact path, which calls the access function as before.
 */
const isAccessGranted = ({
  id,
  slug,
  access,
  req,
}: {
  access: Access | undefined
  id: unknown
  req: PayloadRequest
  slug: string
}) => {
  if (access === defaultAccess) {
    return defaultAccess({ req }) === true
  }
  if (!access || !compiler || isCompileGuardOn) {
    return false
  }
  if (!compiler.compileFunction(access).ok || !compiler.isCompiled(access)) {
    return false
  }
  const evaluated = compiler.evaluateCompiled(access, [
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
