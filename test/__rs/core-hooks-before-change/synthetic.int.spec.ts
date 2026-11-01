import type { BeforeChangeInput, Variant } from './differential.js'

import { registerBeforeChangeSuite } from './suite.js'

const isCreate = (variant: Variant) => variant.operation === 'create'

/** Wraps edge data into inputs: each entry becomes its own input set (run alone). */
const inputs = (
  variant: Variant,
  entries: {
    data: Record<string, unknown>
    doc?: any
    docWithLocales?: any
    id?: number | string
  }[],
): BeforeChangeInput[][] =>
  entries.map(({ id, data, doc, docWithLocales }) => [
    {
      id: isCreate(variant) ? undefined : (id ?? 'edge'),
      data,
      doc: doc === undefined ? (isCreate(variant) ? {} : { id: id ?? 'edge' }) : doc,
      docWithLocales:
        docWithLocales === undefined
          ? isCreate(variant)
            ? {}
            : { id: id ?? 'edge' }
          : docWithLocales,
    },
  ])

registerBeforeChangeSuite({
  configPath: './config.ts',
  extraInputs: {
    nested: (variant) => {
      const leaf = (p: string) => ({ [`${p}A`]: 'a', [`${p}B`]: 1, [`${p}C`]: 'c' })
      const docA = () => ({
        stash: 'a',
        loc: variant.locale === 'all' ? { en: 'x', es: 'y' } : 'x',
        g: { g2: leaf('g2'), arr: [leaf('arr'), leaf('arr')] },
      })
      const input = (data: Record<string, unknown>) => ({
        id: isCreate(variant) ? undefined : 'edge',
        data,
        doc: isCreate(variant) ? {} : { id: 'edge' },
        docWithLocales: isCreate(variant) ? {} : { id: 'edge', loc: { de: 'old-de' } },
      })
      return [
        [input(docA()), input({ watcher: 'watch' })],
        [input({ watcher: 'watch' }), input(docA()), input({ ...docA(), g: { arr: [] } })],
      ]
    },
    changes: (variant) => {
      const all = variant.locale === 'all'
      return inputs(variant, [
        { data: { title: 'bad', validated: 'bad', labelFalse: 'bad', translatedLabel: 'bad' } },
        { data: { validated: 'false' } },
        { data: { validated: 'number' } },
        { data: { validated: 'object' } },
        { data: { validated: 'empty' } },
        { data: { validated: 'thenable' } },
        { data: { validated: 'throw', title: 'bad' } },
        { data: { conditional: 'bad', showConditional: false } },
        { data: { conditional: 'bad', showConditional: true } },
        {
          data: {
            localizedTitle: all ? { en: 'bad', es: 'ok', xx: 'bad' } : 'bad',
            localizedRequired: all ? {} : null,
          },
        },
        { data: { localizedTitle: all ? { es: 'bad-es' } : 'ok', localizedRequired: 'x' } },
        { data: { localizedRows: null, localizedLayout: null, title: 'fallback' } },
        {
          data: {
            localizedRows: all ? { en: [{ locRowA: 'bad' }], es: null } : [{ locRowA: 'bad' }],
          },
          doc: { id: 'edge', localizedRows: [{ id: 'lr', locRowA: 'old' }] },
          docWithLocales: { id: 'edge', localizedRows: { en: [{ id: 'lr' }], de: [{ id: 'x' }] } },
        },
        { data: { jsonCustom: '{bad', jsonField: '{"ok":1}' } },
        { data: { jsonCustom: '{"ok":true}', jsonField: '{bad' } },
        { data: { location: ['1.5', '2'] } },
        { data: { location: [null, 1] } },
        { data: { location: 'x', numbers: { a: 1 }, single: [1] } },
        { data: { poly: { relationTo: 'authors', value: 1 } } },
        { data: { poly: { relationTo: 'nope', value: 1 } } },
        { data: { poly: { relationTo: 'authors', value: 1, extra: true } } },
        {
          data: {
            poly: Object.assign(Object.create(null), { relationTo: 'changes', value: 'x' }),
          },
        },
        { data: { poly: 'str', author: { a: 1 } } },
        { data: { rows: 5, inlineLayout: 2, layout: 'nope' } },
        { data: { rows: 'str' } },
        {
          data: { rows: [{ id: 'r1', rowA: 'new', rowC: 'x' }, { rowA: 'bad' }] },
          doc: { id: 'edge', rows: [{ id: 'r1', rowA: 'old', rowB: 2 }, { id: 'r2' }] },
          docWithLocales: { id: 'edge', rows: [{ id: 'r1', rowA: 'old-l' }] },
        },
        {
          data: { rows: [{ id: 'r1', rowC: 'x' }] },
          doc: { id: 'edge', rows: [null, { id: 'r1' }] },
        },
        { data: { rows: [null, { rowC: 'x' }] } },
        // eslint-disable-next-line no-sparse-arrays
        { data: { rows: [{ rowC: 'x' }, , 3] } },
        {
          data: {
            layout: [
              { blockType: 'nope' },
              { blockType: 'referenced', refText: 'bad', refArray: [{ refRowA: 'bad' }] },
              { blockType: 'constructor' },
            ],
          },
        },
        {
          data: {
            layout: [{ id: 'b1', refText: 'from-doc-type' }],
          },
          doc: { id: 'edge', layout: [{ id: 'b1', blockType: 'referenced', refText: 'old' }] },
          docWithLocales: { id: 'edge', layout: [{ id: 'b1', blockType: 'referenced' }] },
        },
        { data: { layout: [null] } },
        {
          data: {
            title: 'only-inline',
            inlineLayout: [
              { blockType: 'inline', blockText: 'a' },
              { blockType: 'inlineOther', blockText: 'b' },
              { blockType: 'inlineOther', blockText: 'bad' },
            ],
          },
        },
        {
          data: {
            restrictedLayout: [
              { blockType: 'restrictedA' },
              { blockType: 'restrictedB', blockNumber: -1 },
            ],
          },
        },
        { data: { inlineLayout: [{ blockType: 'inline', blockNumber: -5, blockText: 'bad' }] } },
        { data: { group: null, namedTab: 7, localizedGroup: 'str', localizedTab: null } },
        { data: { group: 'str', deepGroup: 1 } },
        { data: { group: { groupA: 'x' } }, doc: Object.freeze({ id: 'frozen' }) },
        { data: { title: 't' }, doc: { id: 'edge', group: Object.freeze({}) } },
        { data: { title: 't' }, docWithLocales: null },
        { data: { title: 't' }, doc: null },
        { data: { title: 't', counter: 4, thenable: 'null-it' } },
        {
          data: {
            localizedGroup: all
              ? { en: { locGroupA: 'bad' }, es: { locGroupC: null } }
              : { locGroupA: 'bad' },
            localizedTab: all ? { en: { locTabA: 'x' } } : { locTabA: 'x' },
          },
          docWithLocales: {
            id: 'edge',
            localizedGroup: { en: { locGroupC: 'old' }, de: { locGroupC: 'de' } },
            localizedTitle: { en: 'old-en', de: 'old-de' },
          },
        },
        {
          data: { refLocalized: 'x' },
          docWithLocales: { id: 'edge', localizedTitle: 'not-an-object' },
        },
      ])
    },
    settings: (variant) =>
      inputs(variant, [
        { data: { siteName: 'bad', localizedTagline: '' } },
        { data: { localizedTagline: variant.locale === 'all' ? { en: '', es: 'x' } : 'x' } },
        { data: { links: [{ linkA: 'bad' }, { linkC: null }] } },
      ]),
    throwing: (variant) =>
      inputs(variant, [
        { data: { syncThrow: 'sync', before: 'b', after: 'a' } },
        { data: { asyncThrow: 'async', group: { throwGroupA: 'x' } } },
        { data: { validateThrow: 'validate' } },
        { data: { conditionThrow: 'condition' } },
        { data: { freezer: 'freeze', afterFreeze: 'x' } },
        {
          data: {
            syncThrow: 'sync',
            asyncThrow: 'async',
            validateThrow: 'validate',
            conditionThrow: 'condition',
          },
        },
      ]),
  },
  extraVariants: {
    changes: [
      {
        name: 'fields-to-validate-nested',
        fieldsToValidate: ['rows', 'layout', 'group'],
        operation: 'update',
        overrideAccess: false,
      },
      { name: 'locale-de-validate', locale: 'de', operation: 'validate', user: true },
      { name: 'locale-es-skip-hooks', locale: 'es', operation: 'update', skipHooks: true },
    ],
  },
  name: 'core-hooks-before-change: synthetic',
})
