/* eslint-disable @typescript-eslint/no-explicit-any -- sanitized config and request shapes */
import { skipCompilation } from '../../../payload/src/utilities/skipCompilation.js'
import { getCompiledFunction } from '../compile/compileFunction.js'
import { evaluateOnLane } from '../compile/index.js'
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
