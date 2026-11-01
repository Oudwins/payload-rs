/**
 * Config for test/__rs/dispatch/bench.int.spec.ts: the same "typical" document shape in two
 * collections, one without field hooks and one with a synchronous hook of every traversal on every
 * data leaf (beforeValidate, beforeChange, afterChange, afterRead, beforeDuplicate).
 */
import type { CollectionConfig, Field, FieldHook } from 'payload'

import { fileURLToPath } from 'node:url'
import path from 'path'

import { buildConfigWithDefaults } from '../../buildConfigWithDefaults.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const passThrough: FieldHook = ({ value }) => value
const hooks = {
  afterChange: [passThrough],
  afterRead: [passThrough],
  beforeChange: [passThrough],
  beforeDuplicate: [passThrough],
  beforeValidate: [passThrough],
}

const leaves = (prefix: string, hooked: boolean): Field[] =>
  [
    { name: `${prefix}text`, type: 'text' },
    { name: `${prefix}number`, type: 'number' },
    { name: `${prefix}select`, type: 'select', options: ['a', 'b', 'c'] },
    { name: `${prefix}checkbox`, type: 'checkbox' },
    { name: `${prefix}date`, type: 'date' },
    { name: `${prefix}default`, type: 'text', defaultValue: 'x' },
    { name: `${prefix}textarea`, type: 'textarea' },
    { name: `${prefix}email`, type: 'email' },
  ].map((field) => (hooked ? { ...field, hooks } : field)) as Field[]

const fields = (hooked: boolean): Field[] => [
  ...leaves('', hooked),
  { name: 'group', type: 'group', fields: leaves('g', hooked) },
  { type: 'collapsible', label: 'c', fields: leaves('c', hooked) },
  {
    name: 'rows',
    type: 'array',
    fields: [
      ...leaves('r', hooked),
      { name: 'nested', type: 'array', fields: leaves('n', hooked) },
    ],
  },
  {
    name: 'layout',
    type: 'blocks',
    blocks: [{ slug: 'content', fields: leaves('b', hooked) }],
  },
]

const collections: CollectionConfig[] = [
  { slug: 'plain', fields: fields(false) },
  { slug: 'hooked', fields: fields(true) },
]

export default buildConfigWithDefaults({
  config: {
    collections,
    typescript: { autoGenerate: false, outputFile: path.resolve(dirname, 'payload-types.ts') },
  },
  suite: '__rs/dispatch',
})
