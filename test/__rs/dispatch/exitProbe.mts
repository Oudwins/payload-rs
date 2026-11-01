/**
 * Guards against crashes during thread-local teardown at process exit: loads every core hook
 * binding from the addon, runs Rust `afterRead` traversals that fill the runtime's tables
 * (persistent references, primitive slots, non-ASCII property keys, descriptor caches, pending
 * tasks), then exits. Must exit with code 0 both on a natural exit and on `process.exit()`.
 *
 *   PAYLOAD_ENGINE_ADDON=/path/payload-engine.node pnpm tsx test/__rs/dispatch/exitProbe.mts [natural|exit|pending]
 */
import { getCoreHooksAfter } from '../../../packages/engine-rs/src/runtime/afterChange/binding.js'
import { getBeforeChangeBinding } from '../../../packages/engine-rs/src/runtime/beforeChange/index.js'
import { getBeforeValidateBinding } from '../../../packages/engine-rs/src/runtime/beforeValidate/index.js'
import { afterRead, getCoreRuntime } from '../../../packages/engine-rs/src/runtime/index.js'

const mode = process.argv[2] ?? 'natural'

getCoreRuntime()
getBeforeValidateBinding()
getBeforeChangeBinding()
getCoreHooksAfter()

let release: (() => void) | undefined
const gate = new Promise<void>((resolve) => (release = resolve))
const fields: any[] = [
  { name: 'títle', type: 'text', defaultValue: 'défault' },
  { name: '名前', type: 'text', hooks: { afterRead: [({ value }: any) => `${value}!`] } },
  { name: 'plain', type: 'text' },
  {
    name: 'rows',
    type: 'array',
    fields: [
      { name: 'id', type: 'text', defaultValue: () => 'row-id' },
      { name: 'ñ', type: 'text', hooks: { afterRead: [async ({ value }: any) => value] } },
    ],
  },
  // never settles in `pending` mode: the leaf's JS `hookedLeaf` and the traversal's Rust task are
  // still suspended at exit
  { name: 'waits', type: 'text', hooks: { afterRead: [() => (mode === 'pending' ? gate : 1)] } },
  // a container's hooks run in its Rust `promise()` task: in `pending` mode that per-field task
  // (afterRead), and a `spawn_tail` task that suspended in its first poll (beforeValidate), are
  // still waiting on a native resume at exit
  {
    name: 'waitsGroup',
    type: 'group',
    fields: [{ name: 'inner', type: 'text' }],
    hooks: {
      afterRead: [({ value }: any) => (mode === 'pending' ? gate : value)],
      beforeValidate: [({ value }: any) => (mode === 'pending' ? gate : value)],
    },
  },
]
const collection = { fields, flattenedFields: fields, slug: 'probe' }
const req: any = {
  context: {},
  payload: { blocks: {}, config: { defaultDepth: 0, localization: false, maxDepth: 10 } },
  user: null,
}
const run = () =>
  afterRead({
    collection: collection as any,
    context: req.context,
    depth: 0,
    doc: { plain: 'p', rows: [{ ñ: 'x' }, { id: 'a', ñ: 'y' }], 名前: 'n' } as any,
    draft: false,
    fallbackLocale: null as any,
    global: null,
    locale: 'en',
    overrideAccess: true,
    req,
    showHiddenFields: false,
  })

const pending = Array.from({ length: 50 }, run)
const validating = Array.from({ length: 10 }, () =>
  getBeforeValidateBinding().beforeValidate({
    collection,
    context: req.context,
    data: { plain: 'p', waitsGroup: { inner: 'i' } },
    doc: {},
    global: null,
    operation: 'update',
    overrideAccess: true,
    req,
  }),
)
if (mode !== 'pending') {
  await Promise.all(validating)
  const docs = await Promise.all(pending)
  if (docs[0]!['名前'] !== 'n!' || docs[0]!['títle'] !== 'défault') {
    throw new Error(`unexpected afterRead result ${JSON.stringify(docs[0])}`)
  }
}
console.log(
  `ran ${pending.length} afterRead traversals (${mode}), stats ${JSON.stringify(getCoreRuntime().stats())}`,
)
void release
if (mode !== 'natural') {
  process.exit(0)
}
