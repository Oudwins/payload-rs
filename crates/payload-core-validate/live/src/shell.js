'use strict'
// Payload's default field validators (packages/payload/src/fields/validations.ts) on the Rust
// natives of crates/payload-core-validate/live (lib.rs `natives!`). Evaluated once per
// `validateBinding(deps)` call with `napi_run_script`; the completion value is this function.
//
// Every validator here has the upstream name, parameter list (so `length`, defaults and the
// destructuring reads / V8 messages are the same) and kind (sync arrow / async arrow / async
// function). The bodies call the natives with the destructured bindings; the natives make every
// other read, call and decision of the TS body. `await` stays here, at the upstream position, so
// async validators are real async functions with upstream's microtask ticks. A native returns
// `NEXT` where the TS body continues past an await or a call this shell makes.
//
// A native call is `nX(tags <marker>, ...bindings)`: the tag word describes the first 7 bindings
// (`pk`; the bindings after those are passed untagged), and lib.rs replaces each marker (a `K:x` comment) with the strings native `x` uses
// (keys.rs), so the engine creates no property key per call.
;(function payloadValidateShell(bootstrap, deps) {
  const { ObjectId, validateJSONSchema } = deps

  const NEXT = {}
  // Slow-path results of the method / iteration helpers, read by the engine right after the
  // helper returns (no user code runs in between).
  const box = { a: undefined, m: undefined, n: undefined, r: undefined }
  const isArray = Array.isArray
  const symbolIterator = Symbol.iterator
  const ArrayPrototype = Array.prototype
  const arrayValues = ArrayPrototype[symbolIterator]
  const ArrayIteratorPrototype = Object.getPrototypeOf([][symbolIterator]())
  const arrayIteratorNext = ArrayIteratorPrototype.next
  const isProxy =
    globalThis.process?.getBuiltinModule?.('node:util')?.types?.isProxy ?? (() => true)
  // `f.call(thisArg, ...args)` without looking `call` up.
  const callFunction = Function.prototype.call.bind(Function.prototype.call)
  const emailRegex =
    /^(?!.*\.\.)[\w!#$%&'*+/=?^`{|}~-](?:[\w!#$%&'*+/=?^`{|}~.-]*[\w!#$%&'*+/=?^`{|}~-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i

  const N = bootstrap({
    NEXT,
    box,
    arrayIteratorPrototype: ArrayIteratorPrototype,
    arrayValues,
    some: ArrayPrototype.some,
    forEach: ArrayPrototype.forEach,
    filter: ArrayPrototype.filter,
    map: ArrayPrototype.map,
    find: ArrayPrototype.find,
    includes: ArrayPrototype.includes,
    indexOf: ArrayPrototype.indexOf,
    // `receiver[name](element)` when the method found (as the TS looks it up) is the builtin
    // `builtin`: the builtin calls `element`, which runs the engine's closure. Else `NEXT` with
    // the method in `box.m` (the engine calls it with a fresh function).
    callArray: (receiver, name, builtin) => {
      const method = receiver[name]
      if (method !== builtin) {
        box.m = method
        return NEXT
      }
      return callFunction(method, receiver, element)
    },
    // The same with a value argument (`includes` / `indexOf`).
    callArrayWith: (receiver, name, builtin, value) => {
      const method = receiver[name]
      if (method !== builtin) {
        box.m = method
        return NEXT
      }
      return callFunction(method, receiver, value)
    },
    // `[item][name](element)` (the literal also in `box.a` when the method is not the builtin).
    callLiteral: (item, name, builtin) => {
      const items = [item]
      const method = items[name]
      if (method !== builtin) {
        box.a = items
        box.m = method
        return NEXT
      }
      return callFunction(method, items, element)
    },
    // The `for...of` loops of the TS over arrays, one per loop so V8 names the TS expression in
    // its errors. The body is the engine's `callback`; `NEXT` is "no return out of the loop".
    forOfStringsToValidate: (stringsToValidate) => {
      for (const stringValue of stringsToValidate) {
        const result = callback(stringValue)
        if (result !== NEXT) {
          return result
        }
      }
      return NEXT
    },
    forOfNumbersToValidate: (numbersToValidate) => {
      for (const number of numbersToValidate) {
        const result = callback(number)
        if (result !== NEXT) {
          return result
        }
      }
      return NEXT
    },
    forOfAllBlockSlugs: (allBlockSlugs) => {
      for (const blockSlug of allBlockSlugs) {
        const result = callback(blockSlug)
        if (result !== NEXT) {
          return result
        }
      }
      return NEXT
    },
    forOfValue: (value) => {
      for (const item of value) {
        const result = callback(item)
        if (result !== NEXT) {
          return result
        }
      }
      return NEXT
    },
    // The same for an engine-created array literal (no own `Symbol.iterator`).
    literalIter: () => {
      const method = ArrayPrototype[symbolIterator]
      if (method !== arrayValues) {
        box.m = method
        return 1
      }
      const next = ArrayIteratorPrototype.next
      if (next !== arrayIteratorNext) {
        box.n = next
        return 2
      }
      return 0
    },
    // `const [a, b] = entry` for `count` consecutive engine-created entries: the `GetIterator`
    // reads and, after the two default steps, `IteratorClose`'s `return` read, entry by entry.
    // Returns `4 * done + code`: `done` entries had only defaults, entry `done` (when < count)
    // stopped with code 1 (method in `box.m`), 2 (`next` in `box.n`) or 3 (`return` in `box.r`).
    literalPairs: (count) => {
      for (let i = 0; i < count; i++) {
        const method = ArrayPrototype[symbolIterator]
        if (method !== arrayValues) {
          box.m = method
          return i * 4 + 1
        }
        const next = ArrayIteratorPrototype.next
        if (next !== arrayIteratorNext) {
          box.n = next
          return i * 4 + 2
        }
        const ret = ArrayIteratorPrototype.return
        if (ret !== undefined && ret !== null) {
          box.r = ret
          return i * 4 + 3
        }
      }
      return count * 4
    },
    get: (o, key) => o[key],
    isArray: (value) => Array.isArray(value),
    lt: (a, b) => a < b,
    gt: (a, b) => a > b,
    String: (value) => String(value),
    Number: (value) => Number(value),
    dateParse: (value) => Date.parse(value),
    emailTest: (value) => emailRegex.test(value),
    objectIdIsValid: (value) => ObjectId.isValid(value),
    objectIdHex: (value) => new ObjectId(value).toHexString(),
    findCollection: (config, collectionSlug) =>
      config.collections.find(({ slug }) => slug === collectionSlug),
    objectKeysLength: (value) => Object.keys(value).length,
    error: (message) => new Error(message),
    typeError: (message) => new TypeError(message),
    duplicatesMessage: (duplicates, t) =>
      duplicates.reduce((err, duplicate, i) => {
        return `${err} ${JSON.stringify(duplicate)}${i < duplicates.length - 1 ? ',' : ''}`
      }, t('validation:invalidSelections')),
    invalidRelationshipsMessage: (invalidRelationships) =>
      `This relationship field has the following invalid relationships: ${invalidRelationships
        .map((err, invalid) => {
          return `${err} ${JSON.stringify(invalid)}`
        })
        .join(', ')}`,
    invalidSelectionsMessage: (invalidRelationships, t) =>
      invalidRelationships.reduce((err, invalid, i) => {
        return `${err} ${JSON.stringify(invalid)}${
          invalidRelationships.length === i + 1 ? ',' : ''
        } `
      }, t('validation:invalidSelections')),
  })

  // Runs the closure the engine set around the helper call that reaches it.
  const { callback } = N
  // What builtin array methods get: a builtin calls a native function through V8's slow API path,
  // an optimized JS function calls it directly.
  const element = (value) => callback(value)
  const {
    allBlockSlugs: nAllBlockSlugs,
    array: nArray,
    blocks: nBlocks,
    blocksFilterResult: nBlocksFilterResult,
    blocksInvalid: nBlocksInvalid,
    checkbox: nCheckbox,
    code: nCode,
    confirmPassword: nConfirmPassword,
    date: nDate,
    docIDs: nDocIDs,
    email: nEmail,
    filterOptionsFind: nFilterOptionsFind,
    filterOptionsResult: nFilterOptionsResult,
    json: nJson,
    number: nNumber,
    password: nPassword,
    point: nPoint,
    radio: nRadio,
    relationship: nRelationship,
    richText: nRichText,
    select: nSelect,
    text: nText,
    textarea: nTextarea,
    username: nUsername,
  } = N

  // `typeof` and truthiness of a binding, 4 bits (ops.rs `V`): pure facts about values the shell
  // already holds, so the natives need no Node-API call to classify them.
  const tag = (v) =>
    typeof v === 'string'
      ? v === ''
        ? 6
        : 7
      : v === undefined
        ? 0
        : v === null
          ? 1
          : v === true
            ? 2
            : v === false
              ? 3
              : typeof v === 'number'
                ? v === 0 || v !== v
                  ? 4
                  : 5
                : typeof v === 'object'
                  ? 8
                  : typeof v === 'function'
                    ? 9
                    : typeof v === 'symbol'
                      ? 10
                      : v
                        ? 11
                        : 12
  // `tag` plus `Array.isArray` for an object: 13 when it is true, 14 for an object that is not a
  // proxy (never an array), 15 for a proxy (its `Array.isArray` is asked where the TS asks it).
  // The intrinsic `Array.isArray` reads nothing and throws only for a revoked proxy.
  const atag = (v) => {
    if (typeof v !== 'object' || v === null) {
      return tag(v)
    }
    try {
      if (isArray(v)) {
        return 13
      }
    } catch {
      return 15
    }
    return isProxy(v) ? 15 : 14
  }
  // Tags of up to 7 bindings in one small integer (a Smi).
  const pk = (a, b, c, d, e, f, g) =>
    tag(a) |
    (tag(b) << 4) |
    (tag(c) << 8) |
    (tag(d) << 12) |
    (tag(e) << 16) |
    (tag(f) << 20) |
    (tag(g) << 24)

  const text = (
    value,
    {
      hasMany,
      maxLength: fieldMaxLength,
      maxRows,
      minLength,
      minRows,
      req: {
        payload: { config },
        t,
      },
      required,
    },
  ) =>
    nText(
      pk(value, hasMany, fieldMaxLength, minLength, required, config, t) /*K:text*/,
      value,
      hasMany,
      fieldMaxLength,
      minLength,
      required,
      config,
      t,
      maxRows,
      minRows,
    )

  const slug = () => true

  const password = (
    value,
    {
      maxLength: fieldMaxLength,
      minLength = 3,
      req: {
        payload: { config },
        t,
      },
      required,
    },
  ) =>
    nPassword(
      pk(value, fieldMaxLength, minLength, config, t, required) /*K:password*/,
      value,
      fieldMaxLength,
      minLength,
      config,
      t,
      required,
    )

  const confirmPassword = (value, { req: { t }, required, siblingData }) =>
    nConfirmPassword(
      pk(value, t, required, siblingData) /*K:confirmPassword*/,
      value,
      t,
      required,
      siblingData,
    )

  const email = (
    value,
    {
      collectionSlug,
      req: {
        payload: { collections, config },
        t,
      },
      required,
      siblingData,
    },
  ) =>
    nEmail(
      pk(value, collectionSlug, collections, config, t, required, siblingData) /*K:email*/,
      value,
      collectionSlug,
      collections,
      config,
      t,
      required,
      siblingData,
    )

  const username = (
    value,
    {
      collectionSlug,
      req: {
        payload: { collections, config },
        t,
      },
      required,
      siblingData,
    },
  ) =>
    nUsername(
      pk(value, collectionSlug, collections, config, t, required, siblingData) /*K:username*/,
      value,
      collectionSlug,
      collections,
      config,
      t,
      required,
      siblingData,
    )

  const textarea = (
    value,
    {
      maxLength: fieldMaxLength,
      minLength,
      req: {
        payload: { config },
        t,
      },
      required,
    },
  ) =>
    nTextarea(
      pk(value, fieldMaxLength, minLength, config, t, required) /*K:textarea*/,
      value,
      fieldMaxLength,
      minLength,
      config,
      t,
      required,
    )

  const code = (value, { req: { t }, required }) =>
    nCode(pk(value, t, required) /*K:code*/, value, t, required)

  const json = async (value, { jsonError, jsonSchema, req: { t }, required }) => {
    const result = nJson(
      pk(value, jsonError, jsonSchema, t, required) /*K:json*/,
      value,
      jsonError,
      jsonSchema,
      t,
      required,
    )
    return result === NEXT ? validateJSONSchema({ jsonSchema, value }) : result
  }

  const checkbox = (value, { req: { t }, required }) =>
    nCheckbox(pk(value, t, required) /*K:checkbox*/, value, t, required)

  const date = (value, { name, req: { t }, required, siblingData, timezone }) =>
    nDate(
      pk(value, name, t, required, siblingData, timezone) /*K:date*/,
      value,
      name,
      t,
      required,
      siblingData,
      timezone,
    )

  const richText = async (value, options) =>
    nRichText(pk(value, options) /*K:richText*/, value, options)

  const number = (value, { hasMany, max, maxRows, min, minRows, req: { t }, required }) =>
    nNumber(
      pk(value, hasMany, max, min, required, t, maxRows) /*K:number*/,
      value,
      hasMany,
      max,
      min,
      required,
      t,
      maxRows,
      minRows,
    )

  const array = (value, { maxRows, minRows, req: { t }, required }) =>
    nArray(
      pk(value, maxRows, minRows, t, required) /*K:array*/,
      value,
      maxRows,
      minRows,
      t,
      required,
    )

  const validateBlocksFilterOptions = async function validateBlocksFilterOptions({
    id,
    data,
    filterOptions,
    req,
    siblingData,
    value,
  }) {
    const allBlockSlugs = nAllBlockSlugs(pk(value) /*K:allBlockSlugs*/, value)

    let allowedBlockSlugs = undefined

    if (typeof filterOptions === 'function') {
      const result = await filterOptions({
        id,
        data,
        req,
        siblingData,
        user: req.user,
      })
      if (result !== true && Array.isArray(result)) {
        allowedBlockSlugs = result
      }
    } else if (Array.isArray(filterOptions)) {
      allowedBlockSlugs = filterOptions
    }

    return nBlocksFilterResult(
      pk(allBlockSlugs, allowedBlockSlugs) /*K:blocksFilterResult*/,
      allBlockSlugs,
      allowedBlockSlugs,
    )
  }

  const blocks = async (
    value,
    { id, data, filterOptions, maxRows, minRows, req: { t }, req, required, siblingData },
  ) => {
    const result = nBlocks(
      pk(value, filterOptions, maxRows, minRows, required, t) /*K:blocks*/,
      value,
      filterOptions,
      maxRows,
      minRows,
      required,
      t,
    )
    if (result !== NEXT) {
      return result
    }
    const { invalidBlockSlugs } = await validateBlocksFilterOptions({
      id,
      data,
      filterOptions,
      req,
      siblingData,
      value,
    })
    return nBlocksInvalid(pk(invalidBlockSlugs, t) /*K:blocksInvalid*/, invalidBlockSlugs, t)
  }

  const validateFilterOptions = async (
    value,
    {
      id,
      blockData,
      data,
      filterOptions,
      overrideAccess,
      relationTo,
      req,
      req: { t, user },
      siblingData,
    },
  ) => {
    if (typeof filterOptions !== 'undefined' && value) {
      const options = {}

      const falseCollections = []
      const collections = !Array.isArray(relationTo) ? [relationTo] : relationTo
      const values = Array.isArray(value) ? value : [value]

      for (const collection of collections) {
        try {
          let optionFilter =
            typeof filterOptions === 'function'
              ? await filterOptions({
                  id,
                  blockData,
                  data,
                  relationTo: collection,
                  req,
                  siblingData,
                  user,
                })
              : filterOptions

          if (optionFilter === true) {
            optionFilter = null
          }

          const findArgs = nFilterOptionsFind(
            pk(values, optionFilter, collection, falseCollections, overrideAccess, req) /*K:filterOptionsFind*/,
            values,
            optionFilter,
            collection,
            falseCollections,
            overrideAccess,
            req,
          )

          if (findArgs !== NEXT) {
            const result = await req.payloadDataLoader.find(findArgs)

            options[collection] = nDocIDs(pk(result) /*K:docIDs*/, result)
          } else {
            options[collection] = []
          }
        } catch (err) {
          req.payload.logger.error({
            err,
            msg: `Error validating filter options for collection ${collection}`,
          })
          options[collection] = []
        }
      }

      return nFilterOptionsResult(
        pk(values, relationTo, falseCollections, options, t) /*K:filterOptionsResult*/,
        values,
        relationTo,
        falseCollections,
        options,
        t,
      )
    }

    return true
  }

  const upload = async (value, options) => {
    const {
      event,
      maxRows,
      minRows,
      relationTo,
      req: { payload, t },
      required,
    } = options

    const result = nRelationship(
      atag(value) | (pk(event, relationTo, required, t, payload, maxRows) << 4) /*K:relationship*/,
      value,
      event,
      relationTo,
      required,
      t,
      payload,
      maxRows,
      minRows,
    )
    return result !== NEXT ? result : validateFilterOptions(value, options)
  }

  const relationship = async (value, options) => {
    const {
      event,
      maxRows,
      minRows,
      relationTo,
      req: { payload, t },
      required,
    } = options

    const result = nRelationship(
      atag(value) | (pk(event, relationTo, required, t, payload, maxRows) << 4) /*K:relationship*/,
      value,
      event,
      relationTo,
      required,
      t,
      payload,
      maxRows,
      minRows,
    )
    return result !== NEXT ? result : validateFilterOptions(value, options)
  }

  const select = async (
    value,
    { data, filterOptions, hasMany, options, req, req: { t }, required, siblingData },
  ) => {
    const filteredOptions =
      typeof filterOptions === 'function'
        ? await filterOptions({
            data,
            options,
            req,
            siblingData,
          })
        : options

    return nSelect(
      pk(value, filteredOptions, hasMany, t, required) /*K:select*/,
      value,
      filteredOptions,
      hasMany,
      t,
      required,
    )
  }

  const radio = (value, { options, req: { t }, required }) =>
    nRadio(pk(value, options, t, required) /*K:radio*/, value, options, t, required)

  const point = (value = ['', ''], { req: { t }, required }) =>
    nPoint(pk(value, t, required) /*K:point*/, value, t, required)

  return {
    array,
    blocks,
    checkbox,
    code,
    confirmPassword,
    date,
    email,
    json,
    number,
    password,
    point,
    radio,
    relationship,
    richText,
    select,
    slug,
    text,
    textarea,
    upload,
    username,
    validateBlocksFilterOptions,
  }
})
