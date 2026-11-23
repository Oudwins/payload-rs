/**
 * Helpers imported by corpus.int.spec.ts: under vitest the import becomes a member read on a
 * captured module object (`__vi_import_0__.checkRole`), the same shape as bundled code.
 */
type User = { id?: number | string; roles?: string[] } | null | undefined

export const checkRole = (allRoles: string[] = [], user?: User): boolean => {
  if (user && allRoles) {
    return allRoles.some((role) => {
      return user?.roles?.some((individualRole) => {
        return individualRole === role
      })
    })
  }

  return false
}

export const tenantField = 'tenant'

export const roles = { admin: 'admin', editor: 'editor' } as const

export function isAdmin(user: User): boolean {
  return Boolean(user?.roles?.includes(roles.admin))
}

export const asyncIsAdmin = async (user: User): Promise<boolean> => isAdmin(user)

export const slugify = (value: string): string =>
  value
    .replace(/ /g, '-')
    .replace(/[^\w-]+/g, '')
    .toLowerCase()

let mutable = 1
export const readsMutable = () => mutable
export const bumpMutable = () => {
  mutable++
}
