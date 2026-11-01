import type { SanitizedCollectionConfig } from '../../../collections/config/types.js'
import type { SanitizedGlobalConfig } from '../../../globals/config/types.js'
import type { RequestContext } from '../../../index.js'
import type { JsonObject, PayloadRequest } from '../../../types/index.js'

import { traverseFields } from './traverseFields.js'

type Args<T extends JsonObject> = {
  collection: null | SanitizedCollectionConfig
  context: RequestContext
  /**
   * The data before hooks
   */
  data: T
  /**
   * The data after hooks
   */
  doc: T
  global: null | SanitizedGlobalConfig
  operation: 'create' | 'update'
  previousDoc: T
  req: PayloadRequest
}

type RustCoreHooks = {
  afterChange: <T extends JsonObject>(args: Args<T>) => Promise<T>
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
  afterChange: async <T extends JsonObject>({
    collection,
    context,
    data,
    doc: incomingDoc,
    global,
    operation,
    previousDoc,
    req,
  }: Args<T>): Promise<T> => {
    await traverseFields({
      collection,
      context,
      data,
      doc: incomingDoc,
      fields: (collection?.fields || global?.fields)!,
      global,
      operation,
      parentIndexPath: '',
      parentIsLocalized: false,
      parentPath: '',
      parentSchemaPath: '',
      previousDoc,
      previousSiblingDoc: previousDoc,
      req,
      siblingData: data,
      siblingDoc: incomingDoc,
    })

    return incomingDoc
  },
}

/**
 * Upstream's `afterChange`, whichever engine is selected: the export when the Rust core engine is
 * not selected, and the TS reference of the Rust port's differential harnesses (test/__rs).
 */
export const upstreamAfterChange = upstream.afterChange

/**
 * This function is responsible for the following actions, in order:
 * - Execute field hooks
 */
export const afterChange: typeof upstreamAfterChange = isRustCoreEngine
  ? (args) => {
      // A synchronous throw (e.g. the addon failing to load) is a rejection, as from upstream's
      // async function.
      try {
        return rustCoreHooks
          ? rustCoreHooks.afterChange(args)
          : rustCoreHooksLoad!.then((loaded) => {
              loaded.recordDeferredCall()
              return loaded.afterChange(args)
            })
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the thrown value as is
        return Promise.reject(error)
      }
    }
  : upstreamAfterChange
