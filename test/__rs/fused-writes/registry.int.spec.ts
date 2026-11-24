/**
 * The registry of Payload's own field functions (payload `payloadOwnFunctions`, owner decision
 * 2026-11-24, packages/engine-rs/FUSED_WRITES.md section 4): every function sanitization or
 * richtext-lexical installs is registered by identity with what it does; user functions are not.
 * No database needed (the config is only sanitized).
 *
 *   pnpm test:int --config test/__rs/mongo-harness/vitest.config.ts test/__rs/fused-writes/registry.int.spec.ts
 */
import type { CollectionConfig, Field } from 'payload'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { payloadOwnFunctions } from 'payload/internal'
import { describe, expect, it } from 'vitest'

const userHook = ({ value }: { value?: unknown }) => value
const userValidate = () => true as const

const posts: CollectionConfig = {
  slug: 'posts',
  fields: [
    { name: 'title', type: 'text', hooks: { beforeChange: [userHook] }, validate: userValidate },
    { name: 'slug', type: 'slug', useAsSlug: 'title' } as unknown as Field,
    { name: 'content', type: 'richText' },
    { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text' }] },
  ],
}

const flatten = (fields: any[]): any[] =>
  fields.flatMap((field) => [field, ...(field.fields ? flatten(field.fields) : [])])

describe('payloadOwnFunctions', () => {
  it("registers Payload's own field functions and no user function", async () => {
    const config = await buildConfig({
      collections: [posts],
      db: mongooseAdapter({ url: 'mongodb://127.0.0.1:1/registry' }),
      editor: lexicalEditor(),
      secret: 'registry',
      telemetry: false,
    })
    const fields = flatten(config.collections.find((c) => c.slug === 'posts')!.fields)
    const byName = (name: string) => fields.filter((field) => field.name === name)
    const kinds = (fn: unknown) => payloadOwnFunctions.get(fn as object)?.kind

    const [title] = byName('title')
    expect(kinds(title.hooks.beforeChange[0])).toBeUndefined()
    expect(kinds(title.validate)).toBeUndefined()

    const [slug] = byName('slug')
    expect(payloadOwnFunctions.get(slug.hooks.beforeChange[0])).toMatchObject({
      kind: 'slugBeforeChange',
      options: { name: 'slug', useAsSlug: 'title' },
    })
    expect(kinds(slug.hooks.beforeDuplicate[0])).toBe('slugBeforeDuplicate')

    const rowID = fields.find((field) => field.name === 'id' && field.hooks?.beforeChange)
    expect(kinds(rowID.defaultValue)).toBe('rowIdDefaultValue')
    expect(kinds(rowID.hooks.beforeChange[0])).toBe('rowIdBeforeChange')
    expect(kinds(rowID.hooks.beforeDuplicate[0])).toBe('rowIdBeforeDuplicate')

    for (const name of ['createdBy', 'updatedBy']) {
      const [field] = byName(name)
      expect(payloadOwnFunctions.get(field.hooks.beforeChange[0])).toEqual({
        field: name,
        kind: 'authorshipBeforeChange',
      })
      expect(payloadOwnFunctions.get(field.hooks.beforeValidate[0])).toEqual({
        field: name,
        kind: 'authorshipBeforeValidate',
      })
      expect(kinds(field.hooks.beforeDuplicate[0])).toBe('authorshipBeforeDuplicate')
    }

    const [content] = byName('content')
    for (const hook of ['afterChange', 'afterRead', 'beforeChange', 'beforeValidate'] as const) {
      for (const fn of content.editor.hooks[hook]) {
        expect(payloadOwnFunctions.get(fn)).toMatchObject({ hook, kind: 'lexicalHook' })
      }
    }
  })
})
