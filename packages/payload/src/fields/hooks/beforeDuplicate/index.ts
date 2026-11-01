import type { SanitizedCollectionConfig } from '../../../collections/config/types.js'
import type { RequestContext } from '../../../index.js'
import type { JsonObject, PayloadRequest } from '../../../types/index.js'

import { traverseFields } from './traverseFields.js'

type Args<T extends JsonObject> = {
  collection: null | SanitizedCollectionConfig
  context: RequestContext
  doc?: T
  id?: number | string
  overrideAccess: boolean
  req: PayloadRequest
}

type RustCoreHooks = {
  beforeDuplicate: <T extends JsonObject>(args: Args<T>) => Promise<T>
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
  beforeDuplicate: async <T extends JsonObject>({
    id,
    collection,
    context,
    doc,
    overrideAccess,
    req,
  }: Args<T>): Promise<T> => {
    await traverseFields({
      id,
      collection,
      context,
      doc,
      fields: collection!.fields,
      overrideAccess,
      parentIndexPath: '',
      parentIsLocalized: false,
      parentPath: '',
      parentSchemaPath: '',
      req,
      siblingDoc: doc!,
    })

    return doc!
  },
}

/**
 * Upstream's `beforeDuplicate`, whichever engine is selected: the export when the Rust core engine is
 * not selected, and the TS reference of the Rust port's differential harnesses (test/__rs).
 */
export const upstreamBeforeDuplicate = upstream.beforeDuplicate

/**
 * This function is responsible for running beforeDuplicate hooks
 * against a document including all locale data.
 * It will run each field's beforeDuplicate hook
 * and return the resulting docWithLocales.
 */
export const beforeDuplicate: typeof upstreamBeforeDuplicate = isRustCoreEngine
  ? (args) => {
      // A synchronous throw (e.g. the addon failing to load) is a rejection, as from upstream's
      // async function.
      try {
        return rustCoreHooks
          ? rustCoreHooks.beforeDuplicate(args)
          : rustCoreHooksLoad!.then((loaded) => {
              loaded.recordDeferredCall()
              return loaded.beforeDuplicate(args)
            })
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the thrown value as is
        return Promise.reject(error)
      }
    }
  : upstreamBeforeDuplicate
