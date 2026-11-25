/* eslint-disable @typescript-eslint/no-explicit-any -- sanitized config and request shapes */
import { skipCompilation } from '../../../payload/src/utilities/skipCompilation.js'
import { getCompiledFunction } from '../compile/compileFunction.js'
import { evaluateOnLane, laneFunction } from '../compile/index.js'
import { isInertTree } from './inert.js'

type Any = any

/**
 * Access functions on the fused lanes (FUSE_CONTRACT.md section 2): compiled functions evaluated
 * through `evaluateOnLane`, shared by the reads (index.ts), their population (populate.ts) and
 * the fused writes (src/fuse-write).
 */

/**
 * `executeAccess({ id, slug, req }, collectionConfig.access.read)` by the function compiler
 * (FN_COMPILE_CONTRACT.md): only with call-site guards installed, for an active compiled function
 * whose calls the guard does not need to see now (`lane_should_verify`). The result: `true` (no
 * constraint) or a where constraint; anything else (falsy: `Forbidden` or empty results, a bail,
 * no access function: the default `Boolean(req.user)` wrapper's absence) runs the exact lane.
 */
export const compiledAccess = (
  access: Any,
  id: unknown,
  collectionConfig: Any,
  req: Any,
  data?: unknown,
): { reason: string; value?: undefined } | { reason?: undefined; value: unknown } => {
  if (typeof access !== 'function') {
    return { reason: 'access:none' }
  }
  const evaluated = evaluateOnLane(access, [
    {
      id,
      slug: collectionConfig.slug,
      data,
      isReadingStaticFile: false,
      req,
      skipCompilation,
    },
  ])
  if (!evaluated.ok) {
    return { reason: `access:${evaluated.reason}` }
  }
  const value = evaluated.value
  if (!value) {
    return { reason: 'access:denied' }
  }
  if (typeof value === 'object' && !isInertTree(value, true)) {
    return { reason: 'access:where' }
  }
  return { value }
}

/**
 * A field access function's result for a whole call (`Boolean(await fn({ ..., req, ... }))`):
 * compiled, reading nothing but `req` (`argKeys`), so the same for every document, row and field
 * it is called for; through `evaluateOnLane` (guard sampling). A string: the guard reason (the
 * call runs on the exact lane). Also used by the fused writes (src/fuse-write).
 */
export const evaluateRequestOnlyAccess = (fn: Any, req: Any): boolean | string => {
  if (typeof fn !== 'function') {
    return 'access:field:shape'
  }
  const compiled = getCompiledFunction(fn)
  if (compiled?.ok && !readsOnlyReq(compiled.argKeys)) {
    return 'access:field:args'
  }
  const evaluated = evaluateOnLane(fn, [{ req }])
  if (!evaluated.ok) {
    return `access:field:${evaluated.reason}`
  }
  return Boolean(evaluated.value)
}

const readsOnlyReq = (argKeys: (null | string[])[]) => {
  const [keys] = argKeys
  return argKeys.length <= 1 && keys !== null && (keys ?? []).every((key) => key === 'req')
}

/**
 * The `FnId` of compiled function `fn` for a lane that evaluates it in Rust (the fused
 * `afterRead`'s field read access, population's nested access), or the guard reason: compiled
 * and active (`laneFunction`). Guard sampling is the lane's: the first call of each function in an
 * operation asks `lane_should_verify` (the first 32 checked calls, then 1 in 256 lane calls bail
 * to the exact lane, where the call-site guard verifies the JS result). `ids`: the functions of
 * this operation (the request then carries `accessReq`).
 */
export const laneFunctionID = (fn: Any, ids: Map<unknown, number>) => {
  const known = ids.get(fn)
  if (known !== undefined) {
    return known
  }
  if (typeof fn !== 'function') {
    return 'shape'
  }
  const { entry, reason } = laneFunction(fn)
  if (!entry) {
    return reason
  }
  ids.set(fn, entry.id)
  return entry.id
}

/** `laneFunctionID` of a plan's field `access.read` functions (`plan.fieldAccess`). */
export const laneFieldAccess = (functions: Any[], ids: Map<unknown, number>) => {
  const out: number[] = []
  for (const fn of functions) {
    const id = laneFunctionID(fn, ids)
    if (typeof id === 'string') {
      return `access:field:${id}`
    }
    out.push(id)
  }
  return out
}
