/**
 * Deliberately wrong host helpers for harness sensitivity checks (`RS_OPS_GLOBAL_MUTANT=<n>`,
 * swapped in for packages/engine-rs/src/ops-global/host.ts by vitest.config.ts; never in normal
 * runs). Each mutant must make compare.mjs report diffs against the TS reference:
 *
 * 1. global read hooks get args without `overrideAccess`
 * 2. one extra microtask before every `initTransaction` result is awaited
 * 3. `globalType` is never stripped from unselected global docs
 * 4. `getAccessResults` settles one tick later
 */
import { createOpsGlobalHost as createRealHost } from '../../../packages/engine-rs/src/ops-global/host.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors the host helper shapes */
type Any = any

export const createOpsGlobalHost = (): Record<string, unknown> => {
  const host: Record<string, Any> = createRealHost()
  const mutant = Number(process.env.RS_OPS_GLOBAL_MUTANT)
  if (mutant === 1) {
    host.globalReadHookArgs = (req: Any, doc: Any, global: Any) => ({
      context: req.context,
      doc,
      global,
      req,
    })
  }
  if (mutant === 2) {
    const initTransaction = host.initTransaction
    host.initTransaction = (req: Any) => initTransaction(req).then((v: Any) => v)
  }
  if (mutant === 3) {
    host.stripGlobalType = () => {}
  }
  if (mutant === 4) {
    const getAccessResults = host.getAccessResults
    host.getAccessResults = (req: Any) => getAccessResults(req).then((v: Any) => v)
  }
  return host
}
