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
;(function payloadValidateShell(bootstrap, deps) {
  const { ObjectId, validateJSONSchema } = deps

  const NEXT = {}
  const SPECIES = {}
  const species = { C: undefined }
  const symbolIterator = Symbol.iterator
  const symbolSpecies = Symbol.species
  const ArrayPrototype = Array.prototype
  const arrayValues = ArrayPrototype[symbolIterator]
  const ArrayIteratorPrototype = Object.getPrototypeOf([][symbolIterator]())
  const arrayIteratorNext = ArrayIteratorPrototype.next
  const emailRegex =
    /^(?!.*\.\.)[\w!#$%&'*+/=?^`{|}~-](?:[\w!#$%&'*+/=?^`{|}~.-]*[\w!#$%&'*+/=?^`{|}~-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i

  const N = bootstrap({
    NEXT,
    symbols: [symbolIterator],
    arrayIteratorPrototype: ArrayIteratorPrototype,
    arrayValues,
    some: ArrayPrototype.some,
    forEach: ArrayPrototype.forEach,
    filter: ArrayPrototype.filter,
    map: ArrayPrototype.map,
    find: ArrayPrototype.find,
    includes: ArrayPrototype.includes,
    indexOf: ArrayPrototype.indexOf,
    push: ArrayPrototype.push,
    // `GetIterator(items)` of a `for...of`: reads `items[Symbol.iterator]` (as the TS does) and
    // returns `NEXT` when it and `%ArrayIteratorPrototype%.next` are the defaults (the engine then
    // walks the array by index with a live length), else the method for the full protocol.
    arrayIterator: (items) => {
      const method = items[symbolIterator]
      return method === arrayValues && ArrayIteratorPrototype.next === arrayIteratorNext
        ? NEXT
        : method
    },
    // The same for an engine-created array literal (no own `Symbol.iterator`).
    literalIterator: () => {
      const method = ArrayPrototype[symbolIterator]
      return method === arrayValues && ArrayIteratorPrototype.next === arrayIteratorNext
        ? NEXT
        : method
    },
    // The method lookup of a `.filter` / `.map` call; for the builtin on a real array also the
    // `constructor` / `@@species` reads of its `ArraySpeciesCreate`: `NEXT` when they give
    // `%Array%` (or undefined), `SPECIES` with the constructor in `species.C`, else the method.
    SPECIES,
    species,
    speciesMethod: (receiver, name, builtin, isRealArray) => {
      const method = receiver[name]
      if (method !== builtin || !isRealArray) {
        return method
      }
      let C = receiver.constructor
      if ((typeof C === 'object' && C !== null) || typeof C === 'function') {
        C = C[symbolSpecies]
        if (C === null) {
          C = undefined
        }
      }
      if (C === undefined || C === Array) {
        return NEXT
      }
      species.C = C
      return SPECIES
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

  // `typeof` and truthiness of a native's argument, 4 bits each (lib.rs `run`, ops.rs `V`):
  // pure facts about values the shell already holds, so the natives need no Node-API call to
  // classify their arguments.
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
  const run = (native, a, b, c, d, e, f, g, h, i) =>
    native(
      tag(a) +
        16 *
          (tag(b) +
            16 * (tag(c) + 16 * (tag(d) + 16 * (tag(e) + 16 * (tag(f) + 16 * (tag(g) + 16 * (tag(h) + 16 * tag(i)))))))),
      a,
      b,
      c,
      d,
      e,
      f,
      g,
      h,
      i,
    )

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
  ) => run(nText, value, hasMany, fieldMaxLength, maxRows, minLength, minRows, config, t, required)

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
  ) => run(nPassword, value, fieldMaxLength, minLength, config, t, required)

  const confirmPassword = (value, { req: { t }, required, siblingData }) =>
    run(nConfirmPassword, value, t, required, siblingData)

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
  ) => run(nEmail, value, collectionSlug, collections, config, t, required, siblingData)

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
  ) => run(nUsername, value, collectionSlug, collections, config, t, required, siblingData)

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
  ) => run(nTextarea, value, fieldMaxLength, minLength, config, t, required)

  const code = (value, { req: { t }, required }) => run(nCode, value, t, required)

  const json = async (value, { jsonError, jsonSchema, req: { t }, required }) => {
    const result = run(nJson, value, jsonError, jsonSchema, t, required)
    return result === NEXT ? validateJSONSchema({ jsonSchema, value }) : result
  }

  const checkbox = (value, { req: { t }, required }) => run(nCheckbox, value, t, required)

  const date = (value, { name, req: { t }, required, siblingData, timezone }) =>
    run(nDate, value, name, t, required, siblingData, timezone)

  const richText = async (value, options) => run(nRichText, value, options)

  const number = (value, { hasMany, max, maxRows, min, minRows, req: { t }, required }) =>
    run(nNumber, value, hasMany, max, maxRows, min, minRows, t, required)

  const array = (value, { maxRows, minRows, req: { t }, required }) =>
    run(nArray, value, maxRows, minRows, t, required)

  const validateBlocksFilterOptions = async function validateBlocksFilterOptions({
    id,
    data,
    filterOptions,
    req,
    siblingData,
    value,
  }) {
    const allBlockSlugs = run(nAllBlockSlugs, value)

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

    return run(nBlocksFilterResult, allBlockSlugs, allowedBlockSlugs)
  }

  const blocks = async (
    value,
    { id, data, filterOptions, maxRows, minRows, req: { t }, req, required, siblingData },
  ) => {
    const result = run(nBlocks, value, filterOptions, maxRows, minRows, required, t)
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
    return run(nBlocksInvalid, invalidBlockSlugs, t)
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

          const findArgs = run(nFilterOptionsFind, 
            values,
            optionFilter,
            collection,
            falseCollections,
            overrideAccess,
            req,
          )

          if (findArgs !== NEXT) {
            const result = await req.payloadDataLoader.find(findArgs)

            options[collection] = run(nDocIDs, result)
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

      return run(nFilterOptionsResult, values, relationTo, falseCollections, options, t)
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

    const result = run(nRelationship, value, event, maxRows, minRows, relationTo, payload, t, required)
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

    const result = run(nRelationship, value, event, maxRows, minRows, relationTo, payload, t, required)
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

    return run(nSelect, value, filteredOptions, hasMany, t, required)
  }

  const radio = (value, { options, req: { t }, required }) => run(nRadio, value, options, t, required)

  const point = (value = ['', ''], { req: { t }, required }) => run(nPoint, value, t, required)

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
