/**
 * Harness sensitivity checks (`RS_OPS_WRITE_MUTANT=n`, shadow mode): deliberately wrong host
 * helpers for the Rust write operations, installed by re-initializing the binding from the test
 * side only (production code has no mutant switches). Each must produce shadow diffs.
 *
 * 1. `initTransaction` resolves one microtask later (an extra `await` tick in the operation).
 * 2. collection beforeValidate/beforeChange hook args without `originalDoc`.
 * 3. the afterChange field traversal is skipped (field afterChange hooks never run).
 * 4. collection afterRead hook args with `overrideAccess` before `doc` (key order).
 * 5. updateDocument does not stamp `updatedAt` before `db.updateOne` (NOT detectable: the key
 *    already exists from the field hook and near-now timestamps are canonicalized as `recent`).
 * 6. auth collections: results do not get the `collection` property.
 * 7. runValidationLifecycle: collection hook args without `originalDoc`.
 * 8. runValidationLifecycle: `onDataProcessed` does not update `processedData` (validation data
 *    from the pre-beforeChange data).
 * 9. runValidationLifecycle: `beforeValidation` (the auth `ensureUsernameOrEmail` callback) is
 *    not passed.
 */
import { initTransaction } from '../../../packages/payload/src/utilities/initTransaction.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors the untyped host helpers */
type Any = any

export const mutantHost = (n: number, host: Record<string, Any>): Record<string, Any> => {
  switch (n) {
    case 1:
      return {
        ...host,
        initTransaction: async (req: Any) => {
          await null
          return initTransaction(req)
        },
      }
    case 2:
      return {
        ...host,
        dataHookArgs: (collection: Any, req: Any, data: Any, operation: Any) => ({
          collection,
          context: req.context,
          data,
          operation,
          req,
        }),
      }
    case 3:
      return { ...host, traversals: { afterChange: (args: Any) => Promise.resolve(args.doc) } }
    case 4:
      return {
        ...host,
        afterReadHookArgs: (collection: Any, req: Any, doc: Any, overrideAccess: Any) => ({
          collection,
          context: req.context,
          overrideAccess,
          doc,
          req,
        }),
      }
    case 5:
      return { ...host, setUpdatedAtNow: () => {} }
    case 6:
      return { ...host, withCollection: (doc: Any) => doc }
    case 7:
      return {
        ...host,
        lifecycleCollectionHookArgs: (
          collection: Any,
          req: Any,
          data: Any,
          validationOperation: Any,
        ) => ({
          collection,
          context: req.context,
          data,
          operation: validationOperation,
          req,
        }),
      }
    case 8:
      return {
        ...host,
        lifecycleBeforeChangeArgs: (...args: Any[]) => {
          const result = host.lifecycleBeforeChangeArgs(...args)
          result.onDataProcessed = () => {}
          return result
        },
      }
    case 9:
      return {
        ...host,
        validateLifecycleCallbacks: (...args: Any[]) => ({
          ...host.validateLifecycleCallbacks(...args),
          beforeValidation: undefined,
        }),
      }
    default:
      throw new Error(`unknown RS_OPS_WRITE_MUTANT ${n}`)
  }
}
