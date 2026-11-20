/**
 * Test-side access to the live Mongo query port (crates/payload-mongo-live-query,
 * `mongoLiveQueryBinding()` of the engine addon). The binding and its host helpers are initialized
 * by production's `getMongoLive()` (packages/engine-rs/src/mongo-live/index.ts ->
 * `initMongoLiveQuery`, host `createMongoLiveQueryHost` in packages/engine-rs/src/mongo-live/query.ts,
 * the single copy). This module exposes drop-ins with the upstream signatures of
 * `@payloadcms/db-mongodb`'s query builders for the differentials and vitest.port.config.ts.
 */
import { createRequire } from 'node:module'

import { getMongoLive } from '../../../packages/engine-rs/src/mongo-live/index.js'
import {
  getMongoLiveQueryBinding,
  type MongoLiveQueryBinding,
} from '../../../packages/engine-rs/src/mongo-live/query.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- the drop-ins keep the upstream generics */
type Any = any

export const getMongoLiveQuery = (): MongoLiveQueryBinding => {
  getMongoLive()
  const binding = getMongoLiveQueryBinding()
  if (!binding) {
    throw new Error('the engine addon does not export mongoLiveQueryBinding')
  }
  return binding
}

/**
 * Calls of the drop-ins per function. With `PAYLOAD_RS_LIVE_QUERY_STATS_FILE` set, the first call of
 * each drop-in in a process appends `{ fn, pid }` to that file (proves a suite run with
 * vitest.port.config.ts went through the port).
 */
export const liveQueryCalls: Record<string, number> = {}
const statsFile = process.env.PAYLOAD_RS_LIVE_QUERY_STATS_FILE
const counted =
  <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
  (...args: A): R => {
    liveQueryCalls[name] = (liveQueryCalls[name] ?? 0) + 1
    if (statsFile && liveQueryCalls[name] === 1) {
      createRequire(import.meta.url)('node:fs').appendFileSync(
        statsFile,
        `${JSON.stringify({ fn: name, pid: process.pid })}\n`,
      )
    }
    return fn(...args)
  }

// Drop-ins with the upstream signatures.
export const buildQuery = counted('buildQuery', (args: Any): Promise<Any> => getMongoLiveQuery().buildQuery(args))
export const parseParams = (args: Any): Promise<Any> => getMongoLiveQuery().parseParams(args)
export const buildAndOrConditions = (args: Any): Promise<Any> =>
  getMongoLiveQuery().buildAndOrConditions(args)
export const buildSearchParam = counted('buildSearchParam', (args: Any): Promise<Any> =>
  getMongoLiveQuery().buildSearchParam(args))
export const sanitizeQueryValue = (args: Any): Any => getMongoLiveQuery().sanitizeQueryValue(args)
export const buildSortParam = counted('buildSortParam', (args: Any): Any => getMongoLiveQuery().buildSortParam(args))
export const getLocalizedSortProperty = counted('getLocalizedSortProperty', (args: Any): string =>
  getMongoLiveQuery().getLocalizedSortProperty(args))
export const buildProjectionFromSelect = counted('buildProjectionFromSelect', (args: Any): Any =>
  getMongoLiveQuery().buildProjectionFromSelect(args))
export const getBuildQueryPlugin = counted('getBuildQueryPlugin', (args?: Any): ((schema: Any) => void) =>
  getMongoLiveQuery().getBuildQueryPlugin(args))
