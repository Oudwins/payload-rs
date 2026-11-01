import type { Access, AccessResult } from '../config/types.js'
import type { PayloadRequest } from '../types/index.js'

import { Forbidden } from '../errors/index.js'

type OperationArgs = {
  data?: any
  disableErrors?: boolean
  id?: number | string
  isReadingStaticFile?: boolean
  req: PayloadRequest
  slug: string
}

const upstream = {
  executeAccess: async (
    { id, slug, data, disableErrors, isReadingStaticFile = false, req }: OperationArgs,
    access?: Access,
  ): Promise<AccessResult> => {
    if (access) {
      const resolvedConstraint = await access({
        id,
        slug,
        data,
        isReadingStaticFile,
        req,
      })

      if (!resolvedConstraint) {
        if (!disableErrors) {
          throw new Forbidden(req.t)
        }
      }

      return resolvedConstraint
    }

    if (req.user) {
      return true
    }

    if (!disableErrors) {
      throw new Forbidden(req.t)
    }
    return false
  },
}

/**
 * Upstream's `executeAccess`, whichever engine is selected: the export when the Rust engine is not
 * selected, and the TS reference of the Rust port's differential harnesses (test/__rs).
 */
export const executeAccessTS = upstream.executeAccess

type RustOperations = {
  executeAccess: typeof executeAccessTS
  recordDeferredCall: () => void
}

/**
 * Rust engine (`packages/engine-rs/src/ops`, crates/payload-core-ops `common::execute_access`),
 * selected once at module load: `PAYLOAD_CORE_ENGINE=rs|ts`, else `PAYLOAD_ENGINE=rs`. See
 * RUST_OPS_DESIGN.md.
 */
const isRustOperations = (process.env.PAYLOAD_CORE_ENGINE || process.env.PAYLOAD_ENGINE) === 'rs'
const rustOperationsSpecifier = '../../../engine-rs/src/ops/index.js'
let rustOperations: RustOperations | undefined
const rustOperationsLoad: Promise<RustOperations> | undefined = isRustOperations
  ? import(/* @vite-ignore */ /* webpackIgnore: true */ rustOperationsSpecifier).then(
      (loaded: RustOperations) => (rustOperations = loaded),
    )
  : undefined
void rustOperationsLoad?.catch(() => {})

export const executeAccess: typeof executeAccessTS = isRustOperations
  ? (args, access) =>
      rustOperations
        ? rustOperations.executeAccess(args, access)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.executeAccess(args, access)
          })
  : executeAccessTS
