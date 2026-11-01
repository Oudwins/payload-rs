/**
 * The live query port's TS side lives in `packages/engine-rs/src/query` (production code, used by
 * the Rust read operations). The harness and shims here import it through this module.
 */
export type { CoreQueryBinding } from '../../../packages/engine-rs/src/query/index.js'
export {
  combineQueries,
  getCoreQueryBinding,
  getFieldByPath,
  getLocalizedPaths,
  prefixWherePaths,
  sanitizeJoinQuery,
  sanitizeWhereQuery,
  validateQueryPaths,
  validateSearchParam,
  validateSortQuery,
} from '../../../packages/engine-rs/src/query/index.js'
