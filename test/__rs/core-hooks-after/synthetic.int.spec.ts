import type { Payload } from 'payload'

import { registerAfterHooksSuite } from './suite.js'

/** A Proxy that logs every property read, key enumeration and `in` check into `target.__log`. */
const logged = <T extends Record<string, unknown>>(target: T): T => {
  const log: string[] = []
  return new Proxy(Object.assign(target, { __log: log }), {
    get(t, k, r) {
      if (typeof k === 'string' && k !== '__log') {
        log.push(`get:${k}`)
      }
      return Reflect.get(t, k, r)
    },
    has(t, k) {
      log.push(`has:${String(k)}`)
      return Reflect.has(t, k)
    },
    ownKeys(t) {
      log.push('ownKeys')
      return Reflect.ownKeys(t)
    },
    set(t, k, v, r) {
      log.push(`set:${String(k)}`)
      return Reflect.set(t, k, v, r)
    },
  })
}

const richText = (text: string) => ({
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
})

const steps = (context: Record<string, unknown>): string[] =>
  ((context.steps as string[] | undefined) ??= [])

const prepare = (payload: Payload) => {
  const field = (slug: string, name: string) =>
    payload.config.collections
      .find((c) => c.slug === slug)!
      .fields.find((f: any) => f.name === name) as any

  // custom rich text editor hooks next to lexical's, on a copy of the shared editor
  const body = field('changes', 'body')
  body.editor = {
    ...body.editor,
    hooks: {
      ...body.editor.hooks,
      afterChange: [
        ...(body.editor.hooks?.afterChange ?? []),
        async ({ context, parentIsLocalized, path, previousValue, value }: any) => {
          steps(context).push(
            `editor:1:${path.join('.')}:${String(parentIsLocalized)}:${JSON.stringify(previousValue)?.length}`,
          )
          await null
          await null
          return value ? { ...value, editorTouched: true } : value
        },
        ({ context, siblingData, value }: any) => {
          steps(context).push(`editor:2:${typeof siblingData}:${Boolean(value?.editorTouched)}`)
        },
      ],
    },
  }
  // broken editors (sanitization already ran): MissingEditorProp / unsanitized editor errors
  field('brokenEditors', 'missingEditor').editor = undefined
  field('unsanitizedEditor', 'functionEditor').editor = () => ({})
}

registerAfterHooksSuite({
  afterChangeEdgeCases: {
    changes: [
      {
        operation: 'update',
        cases: () => {
          const shared = { groupA: 'shared', deepGroup: { deepA: 'deep' } }
          const same = { id: 'e-same', counter: 2, title: 'same' }
          const getterLog: string[] = []
          return [
            {
              data: {},
              doc: {
                id: 'e-odd-rows',
                rows: [null, 5, , { rowA: 'z' }, Object.freeze({ rowA: 'f' })],
              },
              previousDoc: { id: 'e-odd-rows', rows: ['str', 7, null] },
            },
            {
              data: { group: 5, rows: 'x' },
              doc: { id: 'e-null-containers', group: null, namedTab: null, rows: [{ rowA: 'r' }] },
              previousDoc: { group: 'pg', namedTab: 'pt' },
            },
            { data: {}, doc: { id: 'e-string-group', group: 'str' }, previousDoc: {} },
            {
              data: {},
              doc: { id: 'e-frozen-group', group: Object.freeze({ groupA: 'f' }) },
              previousDoc: {},
            },
            {
              data: { inlineLayout: [{ blockText: 'data-row' }] },
              doc: {
                id: 'e-blocks',
                inlineLayout: [{ blockType: 'nope' }, { blockType: 'inline', blockText: 'x' }],
                layout: [{ blockType: 'referenced', refArray: [{ refRowA: 'q' }], refText: 'r' }],
                localizedLayout: [{ blockType: 'inlineLoc', blockText: 'loc' }],
              },
              previousDoc: { layout: [{ refText: 'old' }] },
            },
            {
              data: {},
              doc: { id: 'e-proto-block', layout: [{ blockType: 'constructor' }] },
              previousDoc: {},
            },
            { data: {}, doc: { id: 'e-null-block', layout: [null] }, previousDoc: {} },
            {
              data: { group: shared },
              doc: { id: 'e-shared', group: shared, namedTab: shared, title: 'shared' },
              previousDoc: { group: shared },
            },
            { data: same, doc: same, previousDoc: same },
            {
              data: {},
              doc: logged({
                id: 'e-proxy',
                group: { groupA: 'g' },
                rows: [{ rowA: 'r' }],
                title: 'px',
              }),
              previousDoc: logged({ group: {}, title: 'old' }),
            },
            {
              data: {},
              doc: {
                id: 'e-getter',
                getterLog,
                get title() {
                  getterLog.push('get:title')
                  return 'G'
                },
                set title(v: unknown) {
                  getterLog.push(`set:title:${String(v)}`)
                },
              },
              previousDoc: {},
            },
            {
              // getNestedValue(siblingDoc, ['group', 'groupA']) finds the shadowing nested key
              data: {},
              doc: { id: 'e-nested-path', group: { group: { groupA: 'shadow' }, groupA: 'real' } },
              previousDoc: { group: { group: { groupA: 'prev-shadow' }, groupA: 'prev' } },
            },
            {
              data: {},
              doc: {
                id: 'e-locale-maps',
                localizedGroup: { en: { locGroupA: 'x' } },
                localizedRows: { en: [{ locRowA: 'r' }] },
                localizedTitle: { en: 'a', es: 'b' },
              },
              previousDoc: {},
            },
            {
              data: { body: richText('data') },
              doc: { id: 'e-rich', body: richText('doc') },
              previousDoc: { body: richText('prev') },
            },
            { data: {}, doc: { id: 'e-rich-null', body: null }, previousDoc: { body: 5 } },
            {
              data: {},
              doc: { id: 'e-path', pathMutator: 'pm', title: 't' },
              previousDoc: { pathMutator: 'old-pm' },
            },
          ]
        },
      },
      {
        operation: 'create',
        cases: () => [
          { data: { title: 'only-data' }, doc: { id: 'e-create', title: 'doc' }, previousDoc: {} },
        ],
      },
    ],
    throwing: [
      {
        operation: 'update',
        cases: () => [
          { data: {}, doc: { after: 'a', before: 'b', syncThrow: 'sync' }, previousDoc: {} },
          { data: {}, doc: { asyncThrow: 'async', group: { throwGroupA: 'x' } }, previousDoc: {} },
          { data: {}, doc: { asyncThrow: 'async', syncThrow: 'sync' }, previousDoc: {} },
        ],
      },
    ],
  },
  configPath: './config.ts',
  duplicateEdgeDocs: {
    changes: [
      () => [
        {
          localizedGroup: { en: null, es: { locGroupA: 'g' } },
          localizedRows: { es: [{ locRowA: 'only-es' }] },
          localizedTitle: 'not-a-map',
        },
        { localizedLayout: { en: [{ blockType: 'nope' }] } },
        { localizedLayout: { en: [{ blockType: 'inlineLoc', blockText: 't' }, null] } },
        { inlineLayout: [Object.freeze({ blockType: 'inline', blockText: 'f' })] },
        { inlineLayout: [{ blockType: 'nope' }, { blockType: 'inline', blockNoDup: 'x' }] },
        { rows: [null, { rowA: 'a' }] },
        Object.freeze({ noDup: 'x', title: 't' }),
        logged({ localizedTitle: { en: 'e' }, rows: [{ rowA: 'r' }], title: 'px' }),
        { group: 'str', localizedTab: 'x', namedTab: 5 },
        {
          localizedRows: { en: [], es: [{ locRowA: 'x' }] },
          localizedTab: { en: { locTabA: 'a' }, es: { locTabA: 'b' } },
        },
        { counter: 1, layout: [{ blockType: 'referenced', refArray: [{ refRowA: 'q' }] }] },
      ],
    ],
    throwing: [
      () => [
        { syncThrow: 'sync' },
        { asyncThrow: 'async' },
        { locRows: { en: [{ boom: 'boom' }], es: [{ boom: 'ok' }] } },
        { asyncThrow: 'async', locRows: { en: [{ boom: 'boom' }] } },
        { locLayout: { en: [{ blockType: 'nope' }] } },
      ],
    ],
  },
  name: 'core-hooks-after: synthetic',
  prepare,
})
