import { registerDifferentialSuite } from './suite.js'

registerDifferentialSuite({
  configPath: './config.ts',
  extraDocs: {
    plain: () => {
      class GetterError extends Error {}
      const withGetters: Record<string, unknown> = { id: 'edge-plain-getters', topNum: 1 }
      Object.defineProperty(withGetters, 'topText', {
        enumerable: true,
        get() {
          throw new GetterError('getter throw')
        },
      })
      let reads = 0
      Object.defineProperty(withGetters, 'tailText', {
        configurable: true,
        enumerable: true,
        get: () => `read ${++reads}`,
      })
      return [
        withGetters,
        Object.freeze({ id: 'edge-plain-frozen', hiddenText: 'frozen', topText: 't' }),
        {
          id: 'edge-plain-rows',
          defaultRows: [null, , {}, 0, { dText: 'x', dDef: 'set' }],
          mixedRows: [, null, { mText: 'z' }],
          plainRows: [null, 5, 'str', , { rText: 'x' }, false],
        },
        {
          id: 'edge-plain-shapes',
          hookedHidden: { nested: true },
          plainGroup: 'not an object',
          topJson: { deep: { a: 1 } },
          topNum: null,
        },
      ]
    },
    interleave: () => {
      // shared by two fields of the same doc, fresh per run
      const shared = { a: 1 }
      return [
        { id: 'edge-null-group', group: null },
        { id: 'edge-odd-rows', rows: [null, 5, { rowA: 'z' }, , { rowB: 2 }] },
        {
          id: 'edge-unknown-blocks',
          layout: [{ blockType: 'nope' }, { blockType: 'referenced', refText: 'r' }],
          inlineLayout: [{ blockType: 'referenced' }, { blockType: 'inline' }],
        },
        {
          id: 'edge-blocks',
          inlineLayout: [{ blockType: 'inline', blockText: 'one', blockSecret: 's', id: 'b1' }],
          layout: [
            {
              blockType: 'referenced',
              refText: 'ref',
              refArray: [{ refRowA: 'r' }, null],
              id: 'b2',
            },
          ],
          localizedLayout: { en: [{ blockType: 'inlineLoc', blockText: 'loc' }], es: [] },
        },
        { id: 'edge-proto-block', layout: [{ blockType: 'constructor' }] },
        { id: 'edge-null-block', layout: [null] },
        { id: 'edge-string-groups', group: 'str', localizedGroup: 'abc', namedTab: 7 },
        { id: 'edge-points', location: { coordinates: [1] } },
        { id: 'edge-point-string', location: 'x' },
        { id: 'edge-frozen', group: Object.freeze({ groupA: 'f' }) },
        { id: 'edge-shared', group: { deepGroup: shared }, namedTab: shared, title: 'shared' },
        {
          id: 'edge-localized-objects',
          localizedTitle: { en: '', es: 'es', de: null },
          localizedRows: { en: [{ locRowA: 'e' }], es: [] },
          localizedGroup: { en: { locGroupA: 'ge' }, es: null },
        },
        { id: 'edge-allowed', allow: true, denied: 'visible', secret: 's', title: 'T', counter: 2 },
      ]
    },
    throwing: () => [
      { id: 'edge-sync', syncThrow: 'sync', before: 'b', after: 'a' },
      { id: 'edge-async', asyncThrow: 'async', group: { throwGroupA: 'x' } },
      { id: 'edge-access', accessThrow: 'access' },
      { id: 'edge-all', syncThrow: 'sync', asyncThrow: 'async', accessThrow: 'access' },
    ],
  },
  extraVariants: {
    plain: [
      {
        name: 'select-plain-include',
        depth: 0,
        overrideAccess: true,
        select: {
          topText: true,
          hiddenText: true,
          plainRows: { rText: true },
          defaultRows: { dDef: true },
          plainGroup: { gText: true, id: true },
          multiHook: true,
        },
        showHiddenFields: false,
      },
      {
        name: 'select-plain-exclude',
        depth: 0,
        overrideAccess: false,
        select: { topNum: false, plainRows: { rNum: false }, hookedDefault: false, id: false },
        showHiddenFields: true,
      },
    ],
    interleave: [
      {
        name: 'select-blocks',
        depth: 0,
        overrideAccess: true,
        select: {
          inlineLayout: { inline: { blockText: true } },
          layout: { referenced: { refText: true } },
          rows: { rowA: true },
          group: { groupA: true },
        },
        showHiddenFields: false,
      },
      {
        name: 'select-blocks-exclude',
        depth: 0,
        overrideAccess: false,
        select: { layout: { referenced: false }, group: { deepGroup: false } },
        showHiddenFields: true,
      },
      {
        name: 'select-blocks-true',
        depth: 1,
        overrideAccess: true,
        select: { layout: true, authorName: true, author: true },
        showHiddenFields: false,
      },
      {
        name: 'all-hidden-depth1',
        depth: 1,
        locale: 'all',
        overrideAccess: false,
        showHiddenFields: true,
      },
    ],
  },
  name: 'core-runtime afterRead: synthetic',
})
