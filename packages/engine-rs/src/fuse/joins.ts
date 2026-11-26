/**
 * payload's `sanitizeJoinQuery` (database/sanitizeJoinQuery.ts) for the fused reads of a
 * collection with join fields (FUSE_CONTRACT.md section 8): the `JoinQuery` the operation passes
 * to `payload.db.find` / `findOne`, with each joined collection's read access combined into its
 * join's `where` like upstream, and what the call needs to reproduce it.
 *
 * Without `overrideAccess` the joined collections' read access must be compiled. An operation's
 * own read evaluates it through `evaluateOnLane` (guard sampling: a sampled call runs the exact
 * lane); population's nested finds (`predict`) evaluate it here only to build their join stages
 * from the result, and the core evaluates it again where each nested find runs (guard sampling
 * there, crates/payload-fuse `nested_join_access`), bailing when it differs.
 *
 * Upstream mutates the caller's `joins` object: `replay` applies the same changes after a fused
 * call (D2).
 */
import { combineQueries } from '../../../payload/src/database/combineQueries.js'
import { sanitizeWhereQuery } from '../../../payload/src/database/sanitizeWhereQuery.js'
import { deepCopyObjectSimple } from '../../../payload/src/utilities/deepCopyObject.js'
import { skipCompilation } from '../../../payload/src/utilities/skipCompilation.js'
import { evaluateCompiled, evaluateOnLane, laneFunction } from '../compile/index.js'
import { isInertTree, isPlainDataObject } from './inert.js'
import { isAcceptedWhere } from './where.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- sanitized config shapes */
type Any = any

/** A joined collection's read access the sanitization evaluated, in its order. */
export type JoinAccess = { fn: unknown; result: unknown; slug: string }

/** Whether `sanitizeJoinQuery` has join fields to sanitize (polymorphic joins are ineligible). */
export const hasJoins = (collectionConfig: Any) =>
  Object.keys(collectionConfig.joins ?? {}).length > 0

class JoinGuard extends Error {}

const guard = (reason: string): never => {
  throw new JoinGuard(reason)
}

/**
 * The sanitized `joins` of a read of `collectionConfig` (`joins`: the operation's argument, an
 * inert tree), the access results it holds and the replay of upstream's changes to `joins`, or the
 * guard reason.
 */
export const fusedJoinQuery = ({
  collectionConfig,
  joins,
  overrideAccess,
  payload,
  predict,
  req,
}: {
  collectionConfig: Any
  joins: unknown
  overrideAccess: boolean
  payload: Any
  /** population's nested finds: evaluated again natively where each one runs */
  predict: boolean
  req: Any
}) => {
  if (joins === false) {
    return { access: [], joins: false, replay: () => {} }
  }
  const access: JoinAccess[] = []
  const sanitized: Any = joins ? structuredClone(joins) : {}
  try {
    sanitize({
      accessResult: (joinCollectionConfig) => {
        const result = evaluateAccess(joinCollectionConfig, req, predict)
        access.push({
          slug: joinCollectionConfig.slug,
          fn: joinCollectionConfig.access.read,
          result,
        })
        return structuredClone(result)
      },
      collectionConfig,
      joinsQuery: sanitized,
      overrideAccess,
      payload,
    })
  } catch (error) {
    if (error instanceof JoinGuard) {
      return error.message
    }
    throw error
  }
  /** The same changes on the caller's `joins` (a plain object), with the recorded results. */
  const replay = (target: unknown) => {
    if (!isPlainDataObject(target)) {
      return
    }
    let index = 0
    sanitize({
      accessResult: () => structuredClone(access[index++]!.result),
      collectionConfig,
      joinsQuery: target,
      overrideAccess,
      payload,
    })
  }
  return { access, joins: sanitized, replay }
}

/**
 * `sanitizeJoinQuery` on `joinsQuery` (changed in place, as upstream does), with the access
 * results of `accessResult`; `validateQueryPaths` / `validateSortQuery` only where they accept
 * without errors or field access calls (else a guard).
 */
const sanitize = ({
  accessResult,
  collectionConfig,
  joinsQuery,
  overrideAccess,
  payload,
}: {
  accessResult: (joinCollectionConfig: Any) => Any
  collectionConfig: Any
  joinsQuery: Any
  overrideAccess: boolean
  payload: Any
}) => {
  for (const collectionSlug in collectionConfig.joins) {
    for (const join of collectionConfig.joins[collectionSlug]) {
      const { joinPath } = join
      if (joinsQuery[joinPath] === false) {
        continue
      }
      const joinCollectionConfig = payload.collections[collectionSlug].config
      const result = overrideAccess ? true : accessResult(joinCollectionConfig)
      if (result === false) {
        joinsQuery[joinPath] = false
        continue
      }
      if (!joinsQuery[joinPath]) {
        joinsQuery[joinPath] = {}
      }
      const joinQuery = joinsQuery[joinPath]
      if (!isPlainDataObject(joinQuery)) {
        guard('joins:query')
      }
      if (!joinQuery.where) {
        joinQuery.where = {}
      }
      if (join.field.where) {
        joinQuery.where = combineQueries(joinQuery.where, deepCopyObjectSimple(join.field.where))
      }
      if (
        !isAcceptedWhere({
          fields: joinCollectionConfig.flattenedFields,
          idOnly: !overrideAccess,
          payload,
          where: joinQuery.where,
        })
      ) {
        guard('joins:where')
      }
      if (
        !overrideAccess &&
        (joinQuery.sort || join.field.defaultSort || joinCollectionConfig.defaultSort)
      ) {
        // validateSortQuery checks the sort path's field read access
        guard('joins:access:sort')
      }
      if (typeof result === 'object') {
        sanitizeWhereQuery({
          fields: joinCollectionConfig.flattenedFields,
          payload,
          where: result,
        })
        joinQuery.where = combineQueries(joinQuery.where, result)
      }
    }
  }
}

/**
 * `executeAccess({ slug, disableErrors: true, req }, joinCollectionConfig.access.read)` by the
 * function compiler: `true`, `false` or a where constraint (a plain JSON tree); anything else is a
 * guard.
 */
const evaluateAccess = (joinCollectionConfig: Any, req: Any, predict: boolean) => {
  const fn = joinCollectionConfig.access?.read
  if (typeof fn !== 'function') {
    return guard('joins:access:none')
  }
  const args = [
    {
      id: undefined,
      slug: joinCollectionConfig.slug,
      data: undefined,
      isReadingStaticFile: false,
      req,
      skipCompilation,
    },
  ]
  const evaluated = predict ? predictOnLane(fn, args) : evaluateOnLane(fn, args)
  if (!evaluated.ok) {
    return guard(`joins:access:${evaluated.reason}`)
  }
  const value = evaluated.value
  if (
    value !== true &&
    value !== false &&
    !(isPlainDataObject(value) && isInertTree(value, false))
  ) {
    return guard('joins:access:result')
  }
  if (typeof value === 'object') {
    returnsWhere.add(fn)
  }
  return value
}

/**
 * Read access functions seen returning a where constraint (on a lane, or reported by the core's
 * `populate:access:where:<slug>` bail): only these are predicted for population's nested finds,
 * the others are evaluated by the core alone (a performance decision: a prediction costs an
 * evaluation in JS per call).
 */
const returnsWhere = new WeakSet<object>()

/** Records that `fn` returned a where constraint. */
export const noteAccessWhere = (fn: unknown) => {
  if (typeof fn === 'function') {
    returnsWhere.add(fn)
  }
}

/** The core's bail for an unpredicted where of collection `slug`'s read access (`!` + reason). */
export const noteAccessWhereBail = (payload: Any, text: string) => {
  const prefix = '!populate:access:where:'
  if (text.startsWith(prefix)) {
    const slug = text.slice(prefix.length)
    if (payload && Object.hasOwn(payload.collections, slug)) {
      noteAccessWhere(payload.collections[slug].config.access?.read)
    }
  }
}

/**
 * The where constraint a nested find's `executeAccess` of `collectionConfig`'s read access would
 * return for `req` (population, src/fuse/populate.ts: the core evaluates it again where the nested
 * find runs, `populate::nested_access`); `undefined` when it is not one (a boolean, which the
 * core evaluates on its own, a function not seen returning a where, or no prediction).
 */
export const predictedAccessWhere = (collectionConfig: Any, req: Any) => {
  if (!returnsWhere.has(collectionConfig.access?.read)) {
    return undefined
  }
  try {
    const value: Any = evaluateAccess(collectionConfig, req, true)
    return typeof value === 'object' ? value : undefined
  } catch (error) {
    if (error instanceof JoinGuard) {
      return undefined
    }
    throw error
  }
}

/**
 * `evaluateOnLane` without its `lane_should_verify`: the lane that runs the function samples
 * where it calls it (`laneFunction`: guards installed, compiled, active).
 */
const predictOnLane = (fn: Any, args: unknown[]) => {
  const { entry, reason } = laneFunction(fn)
  if (!entry) {
    return guard(`joins:access:${reason}`)
  }
  return evaluateCompiled(fn, args)
}
