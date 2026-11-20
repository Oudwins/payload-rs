import type { SanitizedCollectionConfig } from '../../../collections/config/types.js'
import type { ValidationFieldError } from '../../../errors/index.js'
import type { SanitizedGlobalConfig } from '../../../globals/config/types.js'
import type { RequestContext } from '../../../index.js'
import type { FieldOperation, JsonObject, PayloadRequest } from '../../../types/index.js'

import { ValidationError } from '../../../errors/index.js'
import { deepCopyObjectSimple } from '../../../utilities/deepCopyObject.js'
import { recordNewDoc } from '../../baseFields/authorship/index.js'
import { traverseFields } from './traverseFields.js'

export type Args<T extends JsonObject> = {
  collection: null | SanitizedCollectionConfig
  context: RequestContext
  data: T
  doc: T
  docWithLocales: JsonObject
  /**
   * Names of the top-level fields submitted by the caller. When present, validation skips other
   * top-level fields and validates all nested fields below each submitted field.
   */
  fieldsToValidate?: ReadonlySet<string>
  global: null | SanitizedGlobalConfig
  id?: number | string
  isValidationOperation?: boolean
  onDataProcessed?: (data: T) => void
  operation: FieldOperation
  overrideAccess?: boolean
  req: PayloadRequest
  skipHooks?: boolean
  skipValidation?: boolean
}

type RustCoreHooks = {
  beforeChange: <T extends JsonObject>(args: Args<T>) => Promise<T>
  recordDeferredCall: () => void
}

/**
 * Rust core engine (`packages/engine-rs/src/runtime/hooks.ts`), selected once at module load:
 * `PAYLOAD_CORE_ENGINE=rs|ts`, else `PAYLOAD_ENGINE=rs`. See RUST_PORT.md.
 */
const isRustCoreEngine = (process.env.PAYLOAD_CORE_ENGINE || process.env.PAYLOAD_ENGINE) === 'rs'
const rustCoreHooksSpecifier = '@payloadcms/engine-rs/runtime/hooks'
let rustCoreHooks: RustCoreHooks | undefined
const rustCoreHooksLoad: Promise<RustCoreHooks> | undefined = isRustCoreEngine
  ? import('../../../utilities/importRustEngine.js')
      .then(({ importRustEngine }) => importRustEngine(rustCoreHooksSpecifier))
      .then((loaded: RustCoreHooks) => (rustCoreHooks = loaded))
  : undefined
void rustCoreHooksLoad?.catch(() => {})

const upstream = {
  beforeChange: async <T extends JsonObject>({
    id,
    collection,
    context,
    data: incomingData,
    doc,
    docWithLocales,
    fieldsToValidate: submittedTopLevelFieldNames,
    global,
    isValidationOperation,
    onDataProcessed,
    operation,
    overrideAccess,
    req,
    skipHooks,
    skipValidation,
  }: Args<T>): Promise<T> => {
    const data = deepCopyObjectSimple(incomingData)
    const mergeLocaleActions: (() => Promise<void> | void)[] = []
    const errors: ValidationFieldError[] = []

    // Record the first-write flag before traversal mutates `docWithLocales`, so `createdBy` is
    // stamped reliably.
    recordNewDoc(context, !docWithLocales || Object.keys(docWithLocales).length === 0)

    await traverseFields({
      id,
      collection,
      context,
      data,
      doc,
      docWithLocales,
      errors,
      fieldLabelPath: '',
      fields: (collection?.fields || global?.fields)!,
      global,
      isValidationOperation,
      mergeLocaleActions,
      operation,
      overrideAccess: overrideAccess!,
      parentIndexPath: '',
      parentIsLocalized: false,
      parentPath: '',
      parentSchemaPath: '',
      req,
      siblingData: data,
      siblingDoc: doc,
      siblingDocWithLocales: docWithLocales,
      skipHooks,
      skipValidation,
      submittedTopLevelFieldNames,
    })

    if (errors.length > 0) {
      throw new ValidationError(
        {
          id,
          collection: collection?.slug,
          errors,
          global: global?.slug,
          req,
        },
        req.t,
      )
    }

    onDataProcessed?.(data)

    for (const action of mergeLocaleActions) {
      await action()
    }

    return data
  },
}

/**
 * Upstream's `beforeChange`, whichever engine is selected: the export when the Rust core engine is
 * not selected, and the TS reference of the Rust port's differential harnesses (test/__rs).
 */
export const upstreamBeforeChange = upstream.beforeChange

/**
 * This function is responsible for the following actions, in order:
 * - Run condition
 * - Execute field hooks
 * - Validate data
 * - Transform data for storage
 * - Unflatten locales. The input `data` is the normal document for one locale. The output result will become the document with locales.
 */

export const beforeChange: typeof upstreamBeforeChange = isRustCoreEngine
  ? (args) => {
      // A synchronous throw (e.g. the addon failing to load) is a rejection, as from upstream's
      // async function.
      try {
        return rustCoreHooks
          ? rustCoreHooks.beforeChange(args)
          : rustCoreHooksLoad!.then((loaded) => {
              loaded.recordDeferredCall()
              return loaded.beforeChange(args)
            })
      } catch (error) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the thrown value as is
        return Promise.reject(error)
      }
    }
  : upstreamBeforeChange
