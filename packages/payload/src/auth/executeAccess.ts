import type { Access, AccessResult } from '../config/types.js'
import type { PayloadRequest } from '../types/index.js'

import { Forbidden } from '../errors/index.js'
import { callUserFunction } from '../utilities/callUserFunction.js'
import { skipCompilation } from '../utilities/skipCompilation.js'

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
      const resolvedConstraint = await callUserFunction(
        access,
        undefined,
        [
          {
            id,
            slug,
            data,
            isReadingStaticFile,
            req,
            skipCompilation,
          },
        ],
        'access',
      )

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
 * Upstream's `executeAccess`, whichever engine is selected, and the TS reference of the Rust port's
 * differential harnesses (test/__rs).
 */
export const executeAccessTS = upstream.executeAccess

/**
 * Upstream's TS function under every engine. The Rust operations call their own port
 * (crates/payload-core-ops `common::execute_access`) without crossing into JS; for the callers in
 * JS (entity permissions, llm instructions, join access, ...) the port's Node-API crossings and
 * engine task cost several times the TS function's own work.
 */
export const executeAccess = executeAccessTS
