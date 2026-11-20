import type { Collection } from '../../collections/config/types.js'
import type { PayloadRequest } from '../../types/index.js'

import { APIError, Forbidden } from '../../errors/index.js'
import { appendNonTrashedFilter } from '../../utilities/appendNonTrashedFilter.js'
import { assertNoValidationWrite } from '../../utilities/assertNoValidationWrite.js'
import { commitTransaction } from '../../utilities/commitTransaction.js'
import { httpStatus } from '../../utilities/httpStatus.js'
import { initTransaction } from '../../utilities/initTransaction.js'
import { killTransaction } from '../../utilities/killTransaction.js'

export type Args = {
  collection: Collection
  req: PayloadRequest
  token: string
}

export const verifyEmailOperationTS = async (args: Args): Promise<boolean> => {
  const { collection, req, token } = args

  assertNoValidationWrite(req)

  if (collection.config.auth.disableLocalStrategy) {
    throw new Forbidden(req.t)
  }
  if (!Object.prototype.hasOwnProperty.call(args, 'token')) {
    throw new APIError('Missing required data.', httpStatus.BAD_REQUEST)
  }

  try {
    const shouldCommit = await initTransaction(req)

    const where = appendNonTrashedFilter({
      enableTrash: Boolean(collection.config.trash),
      trash: false,
      where: {
        _verificationToken: { equals: token },
      },
    })

    const user = await req.payload.db.findOne<any>({
      collection: collection.config.slug,
      req,
      where,
    })

    if (!user) {
      throw new APIError('Verification token is invalid.', httpStatus.FORBIDDEN)
    }

    // Ensure updatedAt date is always updated
    user.updatedAt = new Date().toISOString()

    await req.payload.db.updateOne({
      id: user.id,
      collection: collection.config.slug,
      data: {
        ...user,
        _verificationToken: null,
        _verified: true,
      },
      req,
      returning: false,
    })

    if (shouldCommit) {
      await commitTransaction(req)
    }

    return true
  } catch (error: unknown) {
    await killTransaction(req)
    throw error
  }
}

type RustOperations = {
  recordDeferredCall: () => void
  verifyEmailOperation: (args: any) => Promise<any>
}

/**
 * Rust engine (`packages/engine-rs/src/ops-global`), selected once at module load:
 * `PAYLOAD_OPS_GLOBAL_ENGINE=rs|ts`, else `PAYLOAD_CORE_ENGINE=rs|ts`, else `PAYLOAD_ENGINE=rs`.
 * See RUST_OPS_DESIGN.md.
 */
const isRustOperations =
  (process.env.PAYLOAD_OPS_GLOBAL_ENGINE ||
    process.env.PAYLOAD_CORE_ENGINE ||
    process.env.PAYLOAD_ENGINE) === 'rs'
const rustOperationsSpecifier = '@payloadcms/engine-rs/ops-global'
let rustOperations: RustOperations | undefined
const rustOperationsLoad: Promise<RustOperations> | undefined = isRustOperations
  ? import('../../utilities/importRustEngine.js')
      .then(({ importRustEngine }) => importRustEngine(rustOperationsSpecifier))
      .then((loaded: RustOperations) => (rustOperations = loaded))
  : undefined
void rustOperationsLoad?.catch(() => {})

export const verifyEmailOperation: typeof verifyEmailOperationTS = isRustOperations
  ? (args) =>
      rustOperations
        ? rustOperations.verifyEmailOperation(args)
        : rustOperationsLoad!.then((loaded) => {
            loaded.recordDeferredCall()
            return loaded.verifyEmailOperation(args)
          })
  : verifyEmailOperationTS
