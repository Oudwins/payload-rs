import { decodeJwt } from 'jose/jwt/decode'

import type { Collection } from '../../collections/config/types.js'
import type { AuthenticatedUser } from '../../index.js'
import type { JoinQuery, PayloadRequest, PopulateType, SelectType } from '../../types/index.js'

import { isRustCoreEngine } from '../../utilities/engineSelection.js'
import { skipCompilation } from '../../utilities/skipCompilation.js'

export type MeOperationResult = {
  collection?: string
  exp?: number
  token?: string
  user?: AuthenticatedUser | null
}

export type Arguments = {
  collection: Collection
  currentToken?: string
  depth?: number
  draft?: boolean
  joins?: JoinQuery
  populate?: PopulateType
  req: PayloadRequest
  select?: SelectType
}

export const meOperationTS = async (args: Arguments): Promise<MeOperationResult> => {
  const { collection, currentToken, depth, draft, joins, populate, req, select } = args

  let result: MeOperationResult = {
    user: null!,
  }

  if (req.user) {
    if (req.user.collection !== collection.config.slug) {
      return {
        user: null!,
      }
    }

    const { pathname } = req
    const isGraphQL = pathname === `/api${req.payload.config.routes.graphQL}`

    const user = (await req.payload.findByID({
      id: req.user.id,
      collection: collection.config.slug,
      depth: isGraphQL ? 0 : (depth ?? collection.config.auth.depth),
      draft,
      joins,
      overrideAccess: false,
      populate,
      req,
      select,
      showHiddenFields: false,
    })) as AuthenticatedUser

    if (user) {
      user.collection = collection.config.slug
      user._strategy = req.user._strategy
    }

    // /////////////////////////////////////
    // me hook - Collection
    // /////////////////////////////////////

    for (const meHook of collection.config.hooks.me) {
      const hookResult = await meHook({ args, skipCompilation, user })

      if (hookResult) {
        result.user = hookResult.user
        result.exp = hookResult.exp

        break
      }
    }

    result.collection = req.user.collection

    if (!result.user) {
      result.user = user

      if (currentToken) {
        const decoded = decodeJwt(currentToken)
        if (decoded) {
          result.exp = decoded.exp
        }
        if (!collection.config.auth.removeTokenFromResponses) {
          result.token = currentToken
        }
      }
    }
  }

  // /////////////////////////////////////
  // After Me - Collection
  // /////////////////////////////////////

  if (collection.config.hooks?.afterMe?.length) {
    for (const hook of collection.config.hooks.afterMe) {
      result =
        (await hook({
          collection: collection?.config,
          context: req.context,
          req,
          response: result,
          skipCompilation,
        })) || result
    }
  }

  return result
}

type RustOperations = {
  meOperation: (args: any) => Promise<any>
  recordDeferredCall: () => void
}

/**
 * Rust engine (`packages/engine-rs/src/ops-global`), selected once at module load:
 * `isRustCoreEngine({ override: 'PAYLOAD_OPS_GLOBAL_ENGINE' })` (Rust unless `PAYLOAD_ENGINE=ts`, utilities/engineSelection.ts).
 * See RUST_OPS_DESIGN.md.
 */
const isRustOperations = isRustCoreEngine({ override: 'PAYLOAD_OPS_GLOBAL_ENGINE' })
const rustOperationsSpecifier = '@payloadcms/engine-rs/ops-global'
let rustOperations: RustOperations | undefined
const rustOperationsLoad: Promise<RustOperations> | undefined = isRustOperations
  ? import('../../utilities/importRustEngine.js')
      .then(({ importRustEngine }) => importRustEngine(rustOperationsSpecifier))
      .then((loaded: RustOperations) => (rustOperations = loaded))
  : undefined
void rustOperationsLoad?.catch(() => {})

export const meOperation: typeof meOperationTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.meOperation(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.meOperation(args)
          })
  : meOperationTS
