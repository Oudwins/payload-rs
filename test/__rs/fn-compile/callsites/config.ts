/**
 * Config of callsites.int.spec.ts: one collection whose access functions, field access, field hooks
 * and validator compile, so guard mode must see every call Payload makes to them (Rust core and
 * TS call sites alike).
 */
import path from 'path'
import { fileURLToPath } from 'url'

import { buildConfigWithDefaults } from '../../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// Guard mode is read by payload's `init`; set before the config is initialized.
process.env.PAYLOAD_FN_COMPILE_GUARD ??= 'all'

export const access = {
  create: ({ req: { user } }: any) => Boolean(user),
  read: ({ req: { user } }: any) => (user ? true : { title: { equals: 'public' } }),
  update: ({ req: { user } }: any) => (user ? { owner: { equals: user.id } } : false),
}
export const fieldAccessRead = ({ req: { user } }: any) => Boolean(user)
export const trimHook = ({ value }: any) => (typeof value === 'string' ? value.trim() : value)
export const titleValidate = (value: any) =>
  (typeof value === 'string' && value.length > 0) || 'required'

export default buildConfigWithDefaults({
  config: {
    admin: { importMap: { baseDir: path.resolve(dirname) } },
    collections: [
      {
        access,
        fields: [
          {
            name: 'title',
            type: 'text',
            hooks: { beforeChange: [trimHook] },
            validate: titleValidate,
          },
          { name: 'owner', type: 'text' },
          { name: 'secret', type: 'text', access: { read: fieldAccessRead } },
        ],
        slug: 'guarded',
      },
    ],
    typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  },
  suite: 'fn-compile-callsites',
})
