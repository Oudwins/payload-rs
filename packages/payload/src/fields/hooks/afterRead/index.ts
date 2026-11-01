import type { SanitizedCollectionConfig } from '../../../collections/config/types.js'
import type { SanitizedGlobalConfig } from '../../../globals/config/types.js'
import type { RequestContext, TypedFallbackLocale } from '../../../index.js'
import type { JsonObject, PayloadRequest, PopulateType, SelectType } from '../../../types/index.js'

import { getSelectMode } from '../../../utilities/getSelectMode.js'
import { traverseFields } from './traverseFields.js'

export type AfterReadArgs<T extends JsonObject> = {
  collection: null | SanitizedCollectionConfig
  context: RequestContext
  currentDepth?: number
  depth: number
  doc: T
  draft: boolean
  fallbackLocale: TypedFallbackLocale
  findMany?: boolean
  /**
   * Controls whether locales should be flattened into the requested locale.
   * E.g.: { [locale]: fields } -> fields
   *
   * @default true
   */
  flattenLocales?: boolean
  global: null | SanitizedGlobalConfig
  locale: string
  overrideAccess: boolean
  populate?: PopulateType
  req: PayloadRequest
  select?: SelectType
  showHiddenFields: boolean
}

type RustCoreHooks = {
  afterRead: <T extends JsonObject>(args: AfterReadArgs<T>) => Promise<T>
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
  afterRead: async function afterRead<T extends JsonObject>(args: AfterReadArgs<T>): Promise<T> {
    const {
      collection,
      context,
      currentDepth: incomingCurrentDepth,
      depth: incomingDepth,
      doc: incomingDoc,
      draft,
      fallbackLocale,
      findMany,
      flattenLocales = true,
      global,
      locale,
      overrideAccess,
      populate,
      req,
      select,
      showHiddenFields,
    } = args

    const fieldPromises: Promise<void>[] = []
    const populationPromises: Promise<void>[] = []

    let depth =
      incomingDepth || incomingDepth === 0
        ? parseInt(String(incomingDepth), 10)
        : req.payload.config.defaultDepth
    if (depth > req.payload.config.maxDepth) {
      depth = req.payload.config.maxDepth
    }

    const currentDepth = incomingCurrentDepth || 1

    traverseFields({
      collection,
      context,
      currentDepth,
      depth,
      doc: incomingDoc,
      draft,
      fallbackLocale,
      fieldDepth: 0,
      fieldPromises,
      fields: (collection?.fields || global?.fields)!,
      findMany: findMany!,
      flattenLocales,
      global,
      locale,
      overrideAccess,
      parentIndexPath: '',
      parentIsLocalized: false,
      parentPath: '',
      parentSchemaPath: '',
      populate,
      populationPromises,
      req,
      select,
      selectMode: select ? getSelectMode(select) : undefined,
      showHiddenFields,
      siblingDoc: incomingDoc,
    })

    /**
     * Await all field and population promises in parallel.
     * A field promise is able to add more field promises to the fieldPromises array, which will not be
     * awaited in the first run.
     * This is why we need to loop again to process the new field promises, until there are no more field promises left.
     */
    let iterations = 0
    while (fieldPromises.length > 0 || populationPromises.length > 0) {
      const currentFieldPromises = fieldPromises.splice(0, fieldPromises.length)
      const currentPopulationPromises = populationPromises.splice(0, populationPromises.length)

      await Promise.all(currentFieldPromises)
      await Promise.all(currentPopulationPromises)

      iterations++
      if (iterations >= 100) {
        throw new Error(
          'Infinite afterRead promise loop detected. A hook is likely adding field promises in an infinitely recursive way.',
        )
      }
    }
    return incomingDoc
  },
}

/**
 * Upstream's `afterRead`, whichever engine is selected: the export when the Rust core engine is
 * not selected, and the TS reference of the Rust port's differential harnesses (test/__rs).
 */
export const upstreamAfterRead = upstream.afterRead

/**
 * This function is responsible for the following actions, in order:
 * - Remove hidden fields from response
 * - Flatten locales into requested locale. If the input doc contains all locales, the output doc after this function will only contain the requested locale.
 * - Sanitize outgoing data (point field, etc.)
 * - Execute field hooks
 * - Execute read access control
 * - Populate relationships
 */

export const afterRead: typeof upstreamAfterRead = isRustCoreEngine
  ? (args) => {
      // A synchronous throw (e.g. the addon failing to load) is a rejection, as from upstream's
      // async function.
      try {
        return rustCoreHooks
          ? rustCoreHooks.afterRead(args)
          : rustCoreHooksLoad!.then((loaded) => {
              loaded.recordDeferredCall()
              return loaded.afterRead(args)
            })
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the thrown value as is
      return Promise.reject(error)
      }
    }
  : upstreamAfterRead
