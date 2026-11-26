import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Compiled user validators on the fused writes (packages/engine-rs/FUSED_WRITES.md section 12.7):
 * `rated` has the perf suite's complex-shape validator, one reading `req` and one reading the
 * stored value; `optedOut` a validator that opts out of compilation (the exact lane); `hooked`
 * compiled field hooks computing values from their arguments.
 */
export default buildConfigWithDefaults({
  suite: 'fuse-writes-lane-validate',
  config: {
    admin: {
      importMap: {
        baseDir: path.resolve(dirname),
      },
    },
    collections: [
      { slug: 'users', auth: true, fields: [] },
      {
        slug: 'rated',
        fields: [
          { name: 'title', type: 'text', required: true },
          {
            name: 'rating',
            type: 'number',
            max: 5,
            min: 0,
            validate: (value: unknown) =>
              value === undefined ||
              value === null ||
              Number.isInteger(value) ||
              'whole numbers only',
          },
          {
            name: 'owner',
            type: 'text',
            validate: (value: unknown, { req }: any) =>
              value === undefined || value === req.user?.email || 'not your email',
          },
          {
            name: 'code',
            type: 'text',
            validate: (value: unknown, { previousValue }: any) =>
              previousValue !== 'locked' || value === 'locked' || 'code is locked',
          },
        ],
      },
      {
        slug: 'hooked',
        fields: [
          {
            name: 'title',
            type: 'text',
            hooks: {
              beforeValidate: [
                ({ value }: any) => (typeof value === 'string' ? value.trim() : value),
              ],
            },
          },
          {
            name: 'slug',
            type: 'text',
            hooks: {
              beforeChange: [
                ({ data, value }: any) =>
                  value ?? (typeof data.title === 'string' ? data.title.toLowerCase() : undefined),
              ],
            },
          },
          {
            name: 'meta',
            type: 'group',
            fields: [
              {
                name: 'kept',
                type: 'text',
                hooks: {
                  beforeChange: [
                    ({ previousValue, value }: any) =>
                      value === undefined ? previousValue : value,
                  ],
                },
              },
            ],
          },
        ],
      },
      {
        slug: 'optedOut',
        fields: [
          {
            name: 'title',
            type: 'text',
            validate: (value: unknown, { skipCompilation }: any) => {
              skipCompilation?.()
              return value !== 'bad' || 'bad title'
            },
          },
        ],
      },
    ],
  },
})
