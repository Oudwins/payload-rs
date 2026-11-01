import { registerBeforeValidateSuite } from './suite.js'

const existingLayout = () => [
  { id: 'b1', blockType: 'referenced', refText: 'old-1' },
  {
    id: 'b2',
    blockType: 'referenced',
    refArray: [{ id: 'r1', refRowA: 'old-row', refRowB: 5 }],
    refText: 'old-2',
  },
]

registerBeforeValidateSuite({
  configPath: './config.ts',
  extraInputs: {
    interleave: () => {
      // shared by two fields of the same input, fresh per run
      const shared = { groupA: 'shared' }
      return [
        // relationship / upload id coercion
        {
          data: {
            numericRef: { id: '11' },
            numericRefs: [{ id: 11 }, '12', null, , { notId: 1 }],
            polyRef: { relationTo: 'numeric-ids', value: { id: '11' } },
            polyRefs: [
              { relationTo: 'numeric-ids', value: '11' },
              { relationTo: 'nope', value: 1 },
              { relationTo: 'text-ids', value: { id: 't1' } },
              { relationTo: 'numeric-ids', value: { id: { nested: true } } },
            ],
            textRef: { id: 't1' },
          },
          doc: {},
        },
        {
          data: {
            numericRef: '11',
            numericRefs: 'null',
            polyRef: { relationTo: 'text-ids', value: 't1' },
            polyRefs: '',
            textRef: '',
          },
          doc: {},
        },
        {
          data: {
            numericRef: 'none',
            numericRefs: [' 7 ', 'x'],
            polyRef: { relationTo: 'numeric-ids' },
            polyRefs: null,
            textRef: 5,
          },
          doc: {},
        },
        { data: { numericRef: { id: 3, other: 'x' }, polyRef: 'garbage', polyRefs: [5] }, doc: {} },
        { data: { polyRefs: [null] }, doc: {} },
        // numbers / checkboxes / points (JS trim and parseFloat semantics)
        {
          data: {
            allow: 'true',
            count: ' 3.5e2xyz ',
            counts: ['1', 2],
            flag: 'false',
            location: [' 1 ', '', 3, '  4', '0x10'],
          },
          doc: {},
        },
        {
          data: { allow: '', count: '﻿5 ', flag: 'TRUE', location: 'x' },
          doc: {},
        },
        { data: { allow: false, count: '\u0085 5', location: [, '2'] }, doc: {} },
        { data: { count: '   ', location: ['-0', ' Infinity'] }, doc: {} },
        // arrays / blocks set to 0, invalid rows
        { data: { inlineLayout: '0', layout: 0, rows: -0 }, doc: {} },
        {
          data: { rows: [null, 1, { rowA: 'k' }, [], , { rowA: 'z', rowB: ' 2 ' }] },
          doc: { rows: [{ id: 'r1', rowA: 'old' }] },
        },
        {
          data: { inlineLayout: [{ blockType: 'nope' }, { blockType: 'inline', blockText: 't' }] },
          doc: {},
        },
        { data: { layout: [{ blockType: 'constructor' }] }, doc: {} },
        // blockType from the existing row with the same id, nested existing rows
        {
          data: {
            layout: [
              { id: 'b1' },
              { id: 'b2', blockType: 'referenced', refArray: [{ id: 'r1' }, { refRowA: 'new' }] },
              { id: 'b-missing' },
            ],
          },
          doc: { layout: existingLayout() },
        },
        // existingRows.find hits a null row: `'id' in null` TypeError
        {
          data: { layout: [{ id: 'b3', blockType: 'referenced' }] },
          doc: { layout: [null, { id: 'b3' }] },
        },
        // groups and tabs
        { data: { group: 'str', localizedGroup: 5, namedTab: 'tab' }, doc: { group: 'doc-str' } },
        { data: { group: null }, doc: {} },
        { data: { group: Object.freeze({ groupA: 'f' }) }, doc: {} },
        {
          data: { 'group.groupA': 'flat', 'group.deepGroup.deepA': 'deep', 'rows.0.rowA': 'r' },
          doc: {},
        },
        { data: { title: 'frozen doc' }, doc: Object.freeze({}) },
        { data: { group: shared, namedTab: shared, title: 'shared' }, doc: {} },
        // fallbacks cloned from the original doc (shallow copies, nested values shared)
        {
          data: { title: undefined },
          doc: {
            allow: true,
            group: { deepGroup: { deepA: 'kept' }, groupA: 'doc-g' },
            rows: [{ id: 'r1', innerRows: [{ id: 'i1', innerA: 'in' }], rowA: 'x' }, 'prim'],
            secret: 'doc-secret',
            title: 'doc-title',
          },
        },
        { data: { _status: 'draft', title: 'status' }, doc: { _status: 'locked' } },
        { data: { allow: true, denied: 'set', secret: 'set', title: 'T', counter: 2 }, doc: {} },
      ]
    },
    'numeric-ids': () => [
      { data: { id: ' 12.5 ', label: 'x' }, doc: {} },
      { data: { id: 'abc' }, doc: {} },
      { data: { id: 13 }, doc: {} },
    ],
    'text-ids': () => [
      { data: { id: 42 }, doc: {} },
      { data: { id: { toString: () => 'obj' } }, doc: {} },
      { data: { id: true }, doc: {} },
      { data: { id: null }, doc: {} },
      { data: { id: Object.create(null) }, doc: {} },
    ],
    throwing: () => [
      { data: { after: 'a', before: 'b', syncThrow: 'sync' }, doc: {} },
      { data: { asyncThrow: 'async', group: { throwGroupA: 'x' } }, doc: {} },
      { data: { accessThrow: 'access' }, doc: {} },
      { data: { accessThrow: 'access', asyncThrow: 'async', syncThrow: 'sync' }, doc: {} },
    ],
  },
  extraVariants: {
    interleave: [
      {
        name: 'locale-all',
        docMode: 'doc',
        locale: 'all',
        onFieldAccess: true,
        operation: 'update',
        overrideAccess: false,
        withID: true,
      },
    ],
    throwing: [
      {
        name: 'throw-default',
        context: { throwDefault: true },
        docMode: 'empty',
        operation: 'create',
        overrideAccess: true,
      },
    ],
  },
  name: 'core-hooks beforeValidate: synthetic',
})
