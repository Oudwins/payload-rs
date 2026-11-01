import type { SanitizedCollectionConfig } from '../../../collections/config/types.js'
import type { SanitizedGlobalConfig } from '../../../globals/config/types.js'
import type { BeforeValidateOperation, JsonObject, PayloadRequest } from '../../../types/index.js'

import { type RequestContext } from '../../../index.js'
import { traverseFields } from './traverseFields.js'

type Args<T extends JsonObject> = {
  collection: null | SanitizedCollectionConfig
  context: RequestContext
  data: T
  doc?: T
  docForHooks?: T
  duplicate?: boolean
  global: null | SanitizedGlobalConfig
  id?: number | string
  onFieldAccess?: (args: { accessResult: boolean; path: string }) => void
  operation: BeforeValidateOperation
  overrideAccess: boolean
  req: PayloadRequest
}

type RustCoreHooks = {
  beforeValidate: <T extends JsonObject>(args: Args<T>) => Promise<T>
  recordDeferredCall: () => void
}

/**
 * Rust core engine (`packages/engine-rs/src/runtime/hooks.ts`), selected once at module load:
 * `PAYLOAD_CORE_ENGINE=rs|ts`, else `PAYLOAD_ENGINE=rs`. See RUST_PORT.md.
 */
const isRustCoreEngine = (process.env.PAYLOAD_CORE_ENGINE || process.env.PAYLOAD_ENGINE) === 'rs'
const rustCoreHooksSpecifier = '../../../../../engine-rs/src/runtime/hooks.js'
let rustCoreHooks: RustCoreHooks | undefined
const rustCoreHooksLoad: Promise<RustCoreHooks> | undefined = isRustCoreEngine
  ? import(/* @vite-ignore */ /* webpackIgnore: true */ rustCoreHooksSpecifier).then(
      (loaded: RustCoreHooks) => (rustCoreHooks = loaded),
    )
  : undefined
void rustCoreHooksLoad?.catch(() => {})

const upstream = {
  beforeValidate: async <T extends JsonObject>({
    id,
    collection,
    context,
    data: incomingData,
    doc,
    docForHooks,
    global,
    onFieldAccess,
    operation,
    overrideAccess,
    req,
  }: Args<T>): Promise<T> => {
    await traverseFields({
      id,
      collection,
      context,
      data: incomingData,
      doc,
      docForHooks,
      fields: (collection?.fields || global?.fields)!,
      global,
      onFieldAccess,
      operation,
      overrideAccess,
      parentIndexPath: '',
      parentIsLocalized: false,
      parentPath: '',
      parentSchemaPath: '',
      req,
      siblingData: incomingData,
      siblingDoc: doc!,
    })

    return incomingData
  },
}

/**
 * Upstream's `beforeValidate`, whichever engine is selected: the export when the Rust core engine is
 * not selected, and the TS reference of the Rust port's differential harnesses (test/__rs).
 */
export const upstreamBeforeValidate = upstream.beforeValidate

/**
 * This function is responsible for the following actions, in order:
 * - Sanitize incoming data
 * - Execute field hooks
 * - Execute field access control
 * - Merge original document data into incoming data
 * - Compute default values for undefined fields
 */
export const beforeValidate: typeof upstreamBeforeValidate = isRustCoreEngine
  ? (args) => {
      // A synchronous throw (e.g. the addon failing to load) is a rejection, as from upstream's
      // async function.
      try {
        return rustCoreHooks
          ? rustCoreHooks.beforeValidate(args)
          : rustCoreHooksLoad!.then((loaded) => {
              loaded.recordDeferredCall()
              return loaded.beforeValidate(args)
            })
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the thrown value as is
        return Promise.reject(error)
      }
    }
  : upstreamBeforeValidate
