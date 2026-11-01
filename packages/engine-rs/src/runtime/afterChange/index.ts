/**
 * Rust-backed drop-in for `afterChange` from `payload/src/fields/hooks/afterChange/index.ts`
 * (port: crates/payload-core-hooks-after/src/after_change.rs).
 */
import type { afterChange as AfterChangeTS } from '../../../../payload/src/fields/hooks/afterChange/index.js'
import type { JsonObject } from '../../../../payload/src/types/index.js'

import { traverseFields as upstreamTraverseFields } from '../../../../payload/src/fields/hooks/afterChange/traverseFields.js'
import { getCoreHooksAfter } from './binding.js'

export type AfterChangeArgs<T extends JsonObject> = Parameters<typeof AfterChangeTS<T>>[0]

export const afterChange = <T extends JsonObject>(args: AfterChangeArgs<T>): Promise<T> =>
  getCoreHooksAfter().afterChange(args) as Promise<T>

export type AfterChangeTraverseFieldsArgs = Parameters<typeof upstreamTraverseFields>[0]

/**
 * Drop-in for `traverseFields` from `payload/src/fields/hooks/afterChange/traverseFields.ts`
 * (exported by payload as `afterChangeTraverseFields`, called by rich text editor hooks). The
 * parameter is destructured with upstream's pattern (in an async function, so a throw there is a
 * rejection). Non-string paths, which the port holds as Rust strings, run upstream's body.
 */
export const traverseFields = (args: AfterChangeTraverseFieldsArgs): Promise<void> => {
  try {
    const {
      blockData,
      collection,
      context,
      data,
      doc,
      fields,
      global,
      operation,
      parentIndexPath,
      parentIsLocalized,
      parentPath,
      parentSchemaPath,
      previousDoc,
      previousSiblingDoc,
      req,
      siblingData,
      siblingDoc,
      siblingFields,
    } = args
    if (
      typeof parentIndexPath !== 'string' ||
      typeof parentPath !== 'string' ||
      typeof parentSchemaPath !== 'string'
    ) {
      return upstreamTraverseFields({
        blockData,
        collection,
        context,
        data,
        doc,
        fields,
        global,
        operation,
        parentIndexPath,
        parentIsLocalized,
        parentPath,
        parentSchemaPath,
        previousDoc,
        previousSiblingDoc,
        req,
        siblingData,
        siblingDoc,
        siblingFields,
      })
    }
    return getCoreHooksAfter().afterChangeTraverseFields([
      blockData,
      collection,
      context,
      data,
      doc,
      fields,
      global,
      operation,
      parentIndexPath,
      parentIsLocalized,
      parentPath,
      parentSchemaPath,
      previousDoc,
      previousSiblingDoc,
      req,
      siblingData,
      siblingDoc,
      siblingFields,
    ])
  } catch (error) {
    return Promise.reject(error)
  }
}
