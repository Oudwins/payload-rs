// JS-semantics helpers of the live model building (crates/payload-mongo-schema/src/live),
// compiled once per env with `napi_run_script`. Each performs exactly the JS operations of the
// upstream expression it names (V8's own semantics and errors); control flow stays in Rust.
;(() => {
  'use strict'
  const reflectApply = Reflect.apply
  const defineProperty = Object.defineProperty
  const ownKeys = Reflect.ownKeys
  return {
    get: (o, k) => o[k],
    set: (o, k, v) => {
      o[k] = v
    },
    /** a template literal over evaluated parts (ToString left to right) */
    tpl: (...parts) => {
      let s = ''
      for (const p of parts) {
        s += `${p}`
      }
      return s
    },
    /** `{ ...target, ...source }` tail: CopyDataProperties of `source` into `target` */
    spreadInto: (target, source) => {
      const copy = { ...source }
      for (const k of ownKeys(copy)) {
        defineProperty(target, k, { configurable: true, enumerable: true, value: copy[k], writable: true })
      }
      return target
    },
    isArray: (v) => Array.isArray(v),
    values: (o) => Object.values(o),
    notAFunction: (expr) => new TypeError(`${expr} is not a function`),
    /** `for (const x of v)` with a synchronous body */
    forOfSync: (v, expr, cb) => {
      const method = v === null || v === undefined ? undefined : v[Symbol.iterator]
      if (typeof method !== 'function') {
        throw new TypeError(`${expr} is not iterable`)
      }
      for (const item of { [Symbol.iterator]: () => reflectApply(method, v, []) }) {
        cb(item)
      }
    },
    /** the `([plugin]) => ...` parameter pattern */
    first: ([a]) => a,
    /** `set.has(v)` */
    setHas: (set, v) => set.has(v),
    /** `s.replace(a, b)` */
    replace: (s, a, b) => s.replace(a, b),
    gt: (a, b) => a > b,
    /** `fieldType in fieldToSchemaMap` / `fieldToSchemaMap[fieldType]` of models/buildSchema.ts:
     * the generator's name, or the inherited value an `Object.prototype` key reaches, or null */
    schemaGenerator: (() => {
      const fieldToSchemaMap = {
        slug: 'slug',
        array: 'array',
        blocks: 'blocks',
        checkbox: 'checkbox',
        code: 'code',
        collapsible: 'collapsible',
        date: 'date',
        email: 'email',
        group: 'group',
        json: 'json',
        number: 'number',
        point: 'point',
        radio: 'radio',
        relationship: 'relationship',
        richText: 'richText',
        row: 'row',
        select: 'select',
        tabs: 'tabs',
        text: 'text',
        textarea: 'textarea',
        upload: 'upload',
      }
      return (fieldType) => {
        if (fieldType in fieldToSchemaMap) {
          const value = fieldToSchemaMap[fieldType]
          return Object.hasOwn(fieldToSchemaMap, fieldType) ? value : { inherited: value }
        }
        return null
      }
    })(),
  }
})()
