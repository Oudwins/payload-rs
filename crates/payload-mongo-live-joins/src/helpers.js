// JS-semantics helpers of payload-mongo-live-joins, compiled once per env with `napi_run_script`
// (crates/payload-mongo-live-joins/src/jsx.rs). Each helper performs exactly the JS operations of
// the upstream expression it names (same reads, same order, V8's own errors), so the Rust port can
// keep control flow while the language semantics stay V8's.
;(() => {
  'use strict'
  const reflectApply = Reflect.apply
  const defineProperty = Object.defineProperty
  const ownKeys = Reflect.ownKeys
  return {
    /** `o[k]` (V8's TypeError for nullish `o`) */
    get: (o, k) => o[k],
    /** `o[k] = v` in module (strict) code */
    set: (o, k, v) => {
      o[k] = v
    },
    /** `` `${v}` `` */
    str: (v) => `${v}`,
    /** a template literal: `parts` evaluated left to right with ToString */
    tpl: (...parts) => {
      let s = ''
      for (const p of parts) {
        s += `${p}`
      }
      return s
    },
    /** `{ ...target, ...source }` tail: CopyDataProperties of `source` into `target` (own enumerable
     * keys incl. symbols, getters invoked once each, `__proto__` stays an own data property). */
    spreadInto: (target, source) => {
      const copy = { ...source }
      for (const k of ownKeys(copy)) {
        defineProperty(target, k, {
          configurable: true,
          enumerable: true,
          value: copy[k],
          writable: true,
        })
      }
      return target
    },
    keys: (o) => Object.keys(o),
    values: (o) => Object.values(o),
    entries: (o) => Object.entries(o),
    isArray: (v) => Array.isArray(v),
    lt: (a, b) => a < b,
    gt: (a, b) => a > b,
    add: (a, b) => a + b,
    sub: (a, b) => a - b,
    mul: (a, b) => a * b,
    looseEq: (a, b) => a == b,
    notAFunction: (expr) => new TypeError(`${expr} is not a function`),
    newError: (message) => new Error(message),
    /** `Promise.all(items)` (global lookup at call time, like upstream) */
    promiseAll: (items) => Promise.all(items),
    /** `Promise.resolve(v)` */
    promiseResolve: (v) => Promise.resolve(v),
    /** `for (const x of v)` with a synchronous body (`cb` returns `true` to `break`). */
    forOfSync: (v, expr, cb) => {
      const method = v === null || v === undefined ? undefined : v[Symbol.iterator]
      if (typeof method !== 'function') {
        throw new TypeError(`${expr} is not iterable`)
      }
      for (const item of { [Symbol.iterator]: () => reflectApply(method, v, []) }) {
        if (cb(item) === true) {
          break
        }
      }
    },
    /** `for (const x of v)` as a generator the engine steps with `next` (bodies that await). */
    *forOf(v, expr) {
      const method = v === null || v === undefined ? undefined : v[Symbol.iterator]
      if (typeof method !== 'function') {
        throw new TypeError(`${expr} is not iterable`)
      }
      for (const item of { [Symbol.iterator]: () => reflectApply(method, v, []) }) {
        yield item
      }
    },
    /** one step of a `forOf` generator: the item, or `done` */
    next: (gen, done) => {
      const r = gen.next()
      return r.done ? done : r.value
    },
    /** IteratorClose after an abrupt loop body (errors of `return` are ignored for a throw) */
    closeLoop: (gen) => {
      try {
        gen.return()
      } catch {
        // a throw completion wins over errors of `return`
      }
    },
    DONE: Symbol('done'),
    /** `target.push(...items)` */
    pushSpread: (target, items) => target.push(...items),
    div: (a, b) => a / b,
    /** `[...new Set(items)]` */
    uniq: (items) => [...new Set(items)],
    /** `str.split(sep)` */
    split: (s, sep) => s.split(sep),
    /** `items.join(sep)` */
    join: (items, sep) => items.join(sep),
    // ---- destructuring patterns of upstream signatures (exact defaults, read order, V8 errors)
    buildJoinAggregationArgs: ({
      adapter,
      collection,
      collectionConfig,
      draftsEnabled,
      joins,
      locale,
      projection,
      versions,
    }) => [
      adapter,
      collection,
      collectionConfig,
      draftsEnabled,
      joins,
      locale,
      projection,
      versions,
    ],
    /** `const { count = false, limit: limitJoin = join.field.defaultLimit ?? 10, page, sort:
     * sortJoin = join.field.defaultSort || collectionConfig.defaultSort, where: whereJoin = {} } = src` */
    polymorphicJoinQuery: (src, join, collectionConfig) => {
      const {
        count = false,
        limit: limitJoin = join.field.defaultLimit ?? 10,
        page,
        sort: sortJoin = join.field.defaultSort || collectionConfig.defaultSort,
        where: whereJoin = {},
      } = src
      return [count, limitJoin, page, sortJoin, whereJoin]
    },
    /** the same pattern without the `count` default (regular joins) */
    joinQuery: (src, join, collectionConfig) => {
      const {
        count,
        limit: limitJoin = join.field.defaultLimit ?? 10,
        page,
        sort: sortJoin = join.field.defaultSort || collectionConfig.defaultSort,
        where: whereJoin = {},
      } = src
      return [count, limitJoin, page, sortJoin, whereJoin]
    },
    resolveJoinsArgs: ({
      adapter,
      collectionSlug,
      docs,
      joins,
      locale,
      projection,
      versions = false,
    }) => [adapter, collectionSlug, docs, joins, locale, projection, versions],
    /** `([joinPath, joinQuery]) => ...` parameter pattern of the `joinPromises` arrow */
    pair: ([a, b]) => [a, b],
    /** `const { collectionSlug, count, dbFieldName, results, sort, useDrafts } = collectionResult` */
    collectionResult: ({ collectionSlug, count, dbFieldName, results, sort, useDrafts }) => [
      collectionSlug,
      count,
      dbFieldName,
      results,
      sort,
      useDrafts,
    ],
    /** `const { grouped, isPolymorphicJoin, joinQuery, limit, localizedJoinPath, skip, totalCount } = joinResult` */
    joinResult: ({
      grouped,
      isPolymorphicJoin,
      joinQuery,
      limit,
      localizedJoinPath,
      skip,
      totalCount,
    }) => [grouped, isPolymorphicJoin, joinQuery, limit, localizedJoinPath, skip, totalCount],
    aggregatePaginateArgs: ({
      adapter,
      collation,
      joinAggregation,
      limit,
      Model,
      page,
      pagination,
      projection,
      query,
      session,
      sort,
      sortAggregation,
      useEstimatedCount,
    }) => [
      adapter,
      collation,
      joinAggregation,
      limit,
      Model,
      page,
      pagination,
      projection,
      query,
      session,
      sort,
      sortAggregation,
      useEstimatedCount,
    ],
    /** `Math.ceil(v)` */
    ceil: (v) => Math.ceil(v),
    MAX_VALUE: Number.MAX_VALUE,
  }
})()
