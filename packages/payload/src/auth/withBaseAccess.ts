import type { CollectionAccess } from '../collections/config/types.js'
import type { Access, AccessArgs, AccessResult } from '../config/types.js'
import type { GlobalAccess } from '../globals/config/types.js'

type CommonArgs = {
  access?: Access
  slug: string
}

type AdminAccess = NonNullable<CollectionAccess['admin']>

type Args = (
  | {
      entityType: 'collection'
      operation: Exclude<keyof CollectionAccess, 'admin'>
    }
  | {
      entityType: 'global'
      operation: keyof GlobalAccess
    }
) &
  CommonArgs

const authenticatedAccess: Access = ({ req }) => Boolean(req.user)

/**
 * The functions `withBaseAccess` returned, with the access function each one calls and the slug it
 * adds (a `WeakMap` on `globalThis`, shared by every copy of this module). Used by the Rust
 * engine's fused lanes: without `baseAccess`, a wrapper's result is its access function's on the
 * same arguments plus `slug`, so a lane evaluates that function on only what it reads.
 */
const baseAccessWrappers = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('payload.withBaseAccess')
] ??= new WeakMap()) as WeakMap<Access, { documentAccess: Access; slug: string }>

const registerBaseAccess = (wrapper: Access, documentAccess: Access, slug: string) => {
  baseAccessWrappers.set(wrapper, { slug, documentAccess })
  return wrapper
}

export const withBaseAccess = (options: Args): Access => {
  const documentAccess = options.access ?? authenticatedAccess

  return registerBaseAccess(
    async (args: AccessArgs): Promise<AccessResult> => {
      const accessArgs = {
        ...args,
        slug: options.slug,
      }
      const { baseAccess } = args.req.payload.config
      let baseAccessFunction: Access | undefined

      if (options.entityType === 'collection') {
        baseAccessFunction =
          options.operation === 'validate'
            ? (baseAccess?.collections?.validate ?? baseAccess?.collections?.update)
            : baseAccess?.collections?.[options.operation]
      } else {
        baseAccessFunction =
          options.operation === 'validate'
            ? (baseAccess?.globals?.validate ?? baseAccess?.globals?.update)
            : baseAccess?.globals?.[options.operation]
      }

      if (!baseAccessFunction) {
        return documentAccess(accessArgs)
      }

      const baseResult = await baseAccessFunction(accessArgs)

      if (!baseResult) {
        return false
      }

      if (
        options.entityType === 'collection' &&
        options.operation === 'create' &&
        typeof baseResult === 'object'
      ) {
        throw new Error('baseAccess must return a boolean for collection create operations.')
      }

      const documentResult = await documentAccess(accessArgs)

      if (!documentResult) {
        return false
      }

      if (baseResult === true) {
        return documentResult
      }

      if (documentResult === true) {
        return baseResult
      }

      return {
        and: [baseResult, documentResult],
      }
    },
    documentAccess,
    options.slug,
  )
}

export const withBaseAdminAccess = ({
  slug,
  access,
}: {
  access?: AdminAccess
  slug: string
}): AdminAccess => {
  const documentAccess =
    access ?? (({ req }) => Boolean(req.user && req.payload.config.admin.user === slug))

  return async (args) => {
    const accessArgs = {
      ...args,
      slug,
    }
    const baseAccessFunction = args.req.payload.config.baseAccess?.collections?.admin

    if (!baseAccessFunction) {
      return documentAccess(accessArgs)
    }

    const baseResult = await baseAccessFunction(accessArgs)

    if (!baseResult) {
      return false
    }

    if (typeof baseResult === 'object') {
      throw new Error('baseAccess must return a boolean for collection admin operations.')
    }

    return documentAccess(accessArgs)
  }
}
