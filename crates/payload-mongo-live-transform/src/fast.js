// The fast path of `transform` (packages/db-mongodb/src/utilities/transform.ts with payload's
// `traverseFields`, `fillEmpty: false`), used by the live engine's read and write methods
// (`deps::transform`, register.rs).
//
// Every operation on the DATA (documents, rows, operator objects `$inc` / `$push` / `$addToSet` /
// `$pull`, the adapter) is upstream's expression, evaluated in upstream's order: property reads,
// `in` checks, writes, deletes, `for...in` / `for...of`, `Array.isArray`, `Object.keys` / `values` /
// `entries`, `map` / `filter` on data arrays, `instanceof Date`, `toISOString`, `toHexString`,
// `new Types.ObjectId(...)`, `JSON` round trips, `Number(...)`, `new Date().toISOString()`. So the
// result, the partial mutations before a throw and the thrown values are upstream's for any data,
// getters and proxies included.
//
// What is precomputed: every expression on the CONFIG (field types, names, `localized`, `hasMany`,
// `relationTo`, blocks, tabs, `flattenAllFields`, `config.collections` / `config.blocks` /
// `config.localization` lookups, custom id fields). The engine treats the sanitized config as
// immutable (RUST_CORE_DESIGN.md section 3, "Config"), so these values are the ones upstream reads
// on every evaluation. Plans are cached per fields array (and config).
//
// The built-ins upstream calls on engine-internal values (`some` / `find` / `includes` / `push` /
// `forEach` / `reverse` on config arrays, reserved keys and `Object.keys` results) are not called
// here; `transform` checks that each is still the intrinsic and otherwise runs the exhaustive port
// (`native.slowTransform`, transform.rs), as it does for a config the planner cannot plan (e.g. a
// fields value that is not an array, which upstream throws on only when data reaches it).
;(function () {
  'use strict'
  return function createFastTransform(deps, native) {
    const { flattenAllFields, Types } = deps

    /** Documents / calls per path (`stats()`): fast.js, or the exhaustive port. */
    const counters = { fastDocs: 0, slowCalls: 0, slowDocs: 0 }

    const ArrayProto = Array.prototype
    const intrinsics = [
      [ArrayProto, 'some', ArrayProto.some],
      [ArrayProto, 'find', ArrayProto.find],
      [ArrayProto, 'includes', ArrayProto.includes],
      [ArrayProto, 'push', ArrayProto.push],
      [ArrayProto, 'forEach', ArrayProto.forEach],
      [ArrayProto, 'reverse', ArrayProto.reverse],
      [ArrayProto, 'map', ArrayProto.map],
      [ArrayProto, Symbol.iterator, ArrayProto[Symbol.iterator]],
      [
        Object.getPrototypeOf([][Symbol.iterator]()),
        'next',
        Object.getPrototypeOf([][Symbol.iterator]()).next,
      ],
      [Array, 'isArray', Array.isArray],
      [Object, 'keys', Object.keys],
      [Object, 'hasOwn', Object.hasOwn],
      [String.prototype, 'includes', String.prototype.includes],
    ]
    const intrinsicsIntact = () => {
      for (let i = 0; i < intrinsics.length; i++) {
        const entry = intrinsics[i]
        if (entry[0][entry[1]] !== entry[2]) {
          return false
        }
      }
      return true
    }

    // ---------------------------------------------------------------------------------------------
    // plans (config only)

    /** Thrown by the planner for a config upstream would only evaluate (and maybe throw on) lazily. */
    const UNPLANNABLE = { unplannable: true }
    const need = (condition) => {
      if (!condition) {
        throw UNPLANNABLE
      }
    }

    /** Per config: `{ collections, blocks, localization, localeCodes, localeCodeSet, localeObjectCodes }`. */
    const configPlans = new WeakMap()
    const configPlanOf = (config) => {
      let plan = configPlans.get(config)
      if (plan) {
        return plan
      }
      const collections = config.collections
      const blocks = config.blocks
      const localization = config.localization
      plan = {
        // `config.collections?.find(({ slug }) => ...)`: null when there is no array to search
        blocks:
          blocks == null
            ? null
            : (need(Array.isArray(blocks)),
              blocks.map((block) => ({ block, fields: block.fields, slug: block.slug }))),
        collections:
          collections == null
            ? null
            : (need(Array.isArray(collections)),
              collections.map((collection) => {
                const fields = collection.fields
                need(Array.isArray(fields))
                const customIDField = fields.find(
                  (field) => 'name' in field && field.type !== 'ui' && field.name === 'id',
                )
                return {
                  collection,
                  customIDField,
                  isCustomIDNumber: customIDField?.type === 'number',
                  slug: collection.slug,
                }
              })),
        localeCodes: undefined,
        localeCodeSet: undefined,
        localeObjectCodes: undefined,
        localization,
      }
      if (localization) {
        const codes = localization.localeCodes
        const locales = localization.locales
        need(Array.isArray(codes) && Array.isArray(locales))
        plan.localeCodes = codes.slice()
        plan.localeCodeSet = new Set(codes)
        plan.localeObjectCodes = locales.map(({ code }) => code)
      }
      configPlans.set(config, plan)
      return plan
    }

    /** `config.collections?.find(({ slug }) => slug === relationTo)` for a config string. */
    const findPlannedCollection = (cp, relationTo) => {
      if (!cp.collections) {
        return undefined
      }
      for (const c of cp.collections) {
        if (c.slug === relationTo) {
          return c
        }
      }
      return undefined
    }

    // traverseFields plans: per (fields array, config)
    const traversePlans = new WeakMap()
    const traversePlanOf = (fields, cp) => {
      need(Array.isArray(fields))
      let byConfig = traversePlans.get(fields)
      if (!byConfig) {
        byConfig = new WeakMap()
        traversePlans.set(fields, byConfig)
      }
      let plan = byConfig.get(cp)
      if (plan) {
        return plan
      }
      plan = { entries: [] }
      byConfig.set(cp, plan)
      for (const field of fields) {
        plan.entries.push(traverseEntryOf(field, cp))
      }
      return plan
    }

    const traverseEntryOf = (field, cp) => {
      need(field !== null && typeof field === 'object')
      const type = field.type
      const name = field.name
      const hasName = 'name' in field
      const e = {
        affectsData: hasName && type !== 'ui',
        children: null,
        collectionIsArray: false,
        fieldBlocks: null,
        hasFieldsKey: 'fields' in field,
        hasManyTruthy: 'hasMany' in field && Boolean(field.hasMany),
        hasNameTruthy: hasName && Boolean(name),
        isArray: type === 'array',
        isBlocks: type === 'blocks',
        isDate: type === 'date',
        isGroup: type === 'group',
        isJoin: type === 'join',
        isNumber: type === 'number',
        isRelLike: type === 'relationship' || type === 'upload',
        isTab: type === 'tab',
        isTabs: type === 'tabs' && 'tabs' in field,
        localizable: 'localized' in field && Boolean(field.localized),
        localizedTruthy: Boolean(field.localized),
        name,
        related: undefined,
        relationToIsArray: false,
        relationToIsString: false,
        tabs: null,
      }
      e.hasSubFields = e.isGroup || e.isArray || type === 'row' || type === 'collapsible'
      if (e.isRelLike || e.isJoin) {
        const relationTo = field.relationTo
        e.relationToIsString = typeof relationTo === 'string'
        e.relationToIsArray = Array.isArray(relationTo)
        if (e.relationToIsString) {
          e.related = findPlannedCollection(cp, relationTo)
        }
        if (e.isJoin) {
          e.collectionIsArray = Array.isArray(field.collection)
        }
      }
      if (e.isTabs) {
        const tabs = field.tabs
        need(Array.isArray(tabs))
        e.tabs = tabs.map((tab) => {
          need(tab !== null && typeof tab === 'object')
          return {
            hasName: 'name' in tab,
            hasNameTruthy: 'name' in tab && Boolean(tab.name),
            localizable: 'localized' in tab && Boolean(tab.localized),
            name: tab.name,
            plan: traversePlanOf(tab.fields, cp),
          }
        })
        return e
      }
      if (e.isTab || e.hasSubFields || e.isBlocks) {
        // a group / tab without `fields`: upstream throws once a localized value reaches it
        need(!((e.isTab || e.isGroup) && !e.hasFieldsKey))
        if (e.isBlocks) {
          const blocks = field.blocks
          need(Array.isArray(blocks))
          e.fieldBlocks = blocks.map((b) =>
            typeof b === 'string'
              ? b
              : (need(b !== null && typeof b === 'object'), { fields: b.fields, slug: b.slug }),
          )
          // the fields of every block a row can resolve to (config.blocks first, like upstream)
          e.blockPlans = new Map()
          const planFor = (fields) => {
            if (fields && !e.blockPlans.has(fields)) {
              e.blockPlans.set(fields, traversePlanOf(fields, cp))
            }
          }
          for (const b of cp.blocks ?? []) {
            planFor(b.fields)
          }
          for (const b of e.fieldBlocks) {
            if (typeof b !== 'string') {
              planFor(b.fields)
            }
          }
        } else if (e.isArray || e.hasFieldsKey) {
          e.children = traversePlanOf(field.fields, cp)
        }
      }
      return e
    }

    // stripFields plans: per (flattened fields array, config)
    const stripPlans = new WeakMap()
    const stripPlanOf = (fields, cp) => {
      need(Array.isArray(fields))
      let byConfig = stripPlans.get(fields)
      if (!byConfig) {
        byConfig = new WeakMap()
        stripPlans.set(fields, byConfig)
      }
      let plan = byConfig.get(cp)
      if (plan) {
        return plan
      }
      plan = { entries: [], names: new Set() }
      byConfig.set(cp, plan)
      for (const field of fields) {
        need(field !== null && typeof field === 'object')
        const name = field.name
        if (typeof name === 'string') {
          plan.names.add(name)
        }
        const type = field.type
        const e = {
          blocks: null,
          hasNested: 'flattenedFields' in field || 'blocks' in field,
          isArray: type === 'array',
          isBlocks: type === 'blocks',
          isRows: type === 'array' || type === 'blocks',
          localizable: 'localized' in field && Boolean(field.localized),
          localizedTruthy: Boolean(field.localized),
          name,
          nested: null,
        }
        plan.entries.push(e)
        if (!e.hasNested) {
          continue
        }
        if (e.isArray) {
          e.nested = stripPlanOf(field.flattenedFields, cp)
        } else if (e.isBlocks) {
          const blocks = field.blocks
          need(Array.isArray(blocks))
          e.blocks = blocks.map((each) => {
            const slug =
              typeof each === 'string'
                ? each
                : (need(each !== null && typeof each === 'object'), each.slug)
            let block = each
            if (typeof each === 'string') {
              block = undefined
              for (const b of cp.blocks ?? []) {
                if (b.block.slug === each) {
                  block = b.block
                  break
                }
              }
            }
            const flattened = block ? block.flattenedFields : undefined
            return { block, plan: flattened ? stripPlanOf(flattened, cp) : null, slug }
          })
        } else {
          e.nested = stripPlanOf(field.flattenedFields, cp)
        }
      }
      return plan
    }

    // ---------------------------------------------------------------------------------------------
    // upstream helpers on data

    const isObjectID = (value) =>
      Boolean(
        value &&
        typeof value === 'object' &&
        '_bsontype' in value &&
        value._bsontype === 'ObjectId' &&
        'toHexString' in value &&
        typeof value.toHexString === 'function',
      )

    const isValidRelationObject = (value) =>
      typeof value === 'object' && value !== null && 'relationTo' in value && 'value' in value

    /** `config.collections?.find(({ slug }) => slug === holder.relationTo)` (one read per try). */
    const findCollection = (cx, holder) => {
      const collections = cx.cp.collections
      if (!collections) {
        return undefined
      }
      for (const c of collections) {
        if (c.slug === holder.relationTo) {
          return c
        }
      }
      return undefined
    }

    const convertRelationshipValue = (cx, related, value) => {
      if (cx.isRead) {
        if (isObjectID(value)) {
          return value.toHexString()
        }
        if (
          related.isCustomIDNumber &&
          typeof value === 'bigint' &&
          cx.adapter.useBigIntForNumberIDs
        ) {
          return Number(value)
        }
        return value
      }
      if (related.customIDField) {
        return value
      }
      if (typeof value === 'string') {
        try {
          return new Types.ObjectId(value)
        } catch (e) {
          if (cx.validateRelationships) {
            throw e
          }
          return value
        }
      }
      return value
    }

    const processRelationshipValues = (cx, items, e) =>
      items.map((item) => {
        if (e.relationToIsArray && isValidRelationObject(item)) {
          const relatedCollection = findCollection(cx, item)
          if (relatedCollection) {
            return {
              relationTo: item.relationTo,
              value: convertRelationshipValue(cx, relatedCollection, item.value),
            }
          }
          return item
        }
        if (e.relationToIsString) {
          if (e.related) {
            return convertRelationshipValue(cx, e.related, item)
          }
        }
        return item
      })

    const sanitizeRelationship = (cx, e, locale, ref, value) => {
      if (e.isJoin) {
        if (
          cx.isRead &&
          value &&
          typeof value === 'object' &&
          'docs' in value &&
          Array.isArray(value.docs)
        ) {
          for (let i = 0; i < value.docs.length; i++) {
            const item = value.docs[i]
            if (isObjectID(item)) {
              value.docs[i] = item.toHexString()
            } else if (e.collectionIsArray && item) {
              value.docs[i] = JSON.parse(JSON.stringify(value.docs[i]))
            }
          }
        }
        return value
      }
      let relatedCollection
      let result = value
      if (e.relationToIsString) {
        relatedCollection = e.related
      }
      if (Array.isArray(value)) {
        result = value.map((val) => {
          if (val === null || typeof val === 'undefined') {
            return val
          }
          if (isValidRelationObject(val)) {
            const single = findCollection(cx, val)
            if (single) {
              return {
                relationTo: val.relationTo,
                value: convertRelationshipValue(cx, single, val.value),
              }
            }
          }
          if (relatedCollection) {
            return convertRelationshipValue(cx, relatedCollection, val)
          }
          return val
        })
      } else if (isValidRelationObject(value)) {
        relatedCollection = findCollection(cx, value)
        if (relatedCollection) {
          result = {
            relationTo: value.relationTo,
            value: convertRelationshipValue(cx, relatedCollection, value.value),
          }
        }
      } else if (relatedCollection) {
        result = convertRelationshipValue(cx, relatedCollection, value)
      }
      if (locale) {
        ref[locale] = result
      } else {
        ref[e.name] = result
      }
    }

    const sanitizeDate = (e, locale, ref, value) => {
      if (!value) {
        return
      }
      if (value instanceof Date) {
        value = value.toISOString()
      }
      if (locale) {
        ref[locale] = value
      } else {
        ref[e.name] = value
      }
    }

    const clearEmptyContainer = (parentRef, ref) => {
      if (!parentRef || typeof parentRef !== 'object') {
        return
      }
      if (!ref || typeof ref !== 'object') {
        return
      }
      if (Object.keys(ref).length > 0) {
        return
      }
      const keys = Object.keys(parentRef)
      let containerKey
      for (let i = 0; i < keys.length; i++) {
        if (parentRef[keys[i]] === ref) {
          containerKey = keys[i]
          break
        }
      }
      if (containerKey) {
        parentRef[containerKey] = undefined
      }
    }

    /** `Object.values(value).some((localeValue) => localeValue && typeof ... && operand in localeValue)` */
    const someLocaleHas = (value, operand) => {
      const values = Object.values(value)
      for (let i = 0; i < values.length; i++) {
        const localeValue = values[i]
        if (localeValue && typeof localeValue === 'object' && operand in localeValue) {
          return true
        }
      }
      return false
    }

    /** The `sanitize` callback of transform. `ref` is an object (checked by the traversal). */
    const sanitize = (cx, e, pil, parentPath, incomingParentRef, ref) => {
      const parentRef = incomingParentRef || {}
      const shouldLocalize = e.localizable && !pil

      if (cx.$inc && e.isNumber && cx.isWrite && e.name in ref && ref[e.name]) {
        const value = ref[e.name]
        if (
          value &&
          typeof value === 'object' &&
          '$inc' in value &&
          typeof value.$inc === 'number'
        ) {
          cx.$inc[`${parentPath}${e.name}`] = value.$inc
          delete ref[e.name]
          clearEmptyContainer(parentRef, ref)
        }
      }

      if (cx.$push && e.isArray && cx.isWrite && e.name in ref && ref[e.name]) {
        const value = ref[e.name]
        if (
          value &&
          typeof value === 'object' &&
          ('$push' in value ||
            (cx.cp.localization && shouldLocalize && someLocaleHas(value, '$push')))
        ) {
          if (cx.cp.localization && shouldLocalize) {
            let hasLocaleOperations = false
            Object.entries(value).forEach(([localeKey, localeValue]) => {
              if (localeValue && typeof localeValue === 'object' && '$push' in localeValue) {
                hasLocaleOperations = true
                const push = localeValue.$push
                if (Array.isArray(push)) {
                  cx.$push[`${parentPath}${e.name}.${localeKey}`] = { $each: push }
                } else if (typeof push === 'object') {
                  cx.$push[`${parentPath}${e.name}.${localeKey}`] = push
                }
              }
            })
            if (hasLocaleOperations) {
              delete ref[e.name]
              clearEmptyContainer(parentRef, ref)
            }
          } else if (value && typeof value === 'object' && '$push' in value) {
            const push = value.$push
            if (Array.isArray(push)) {
              cx.$push[`${parentPath}${e.name}`] = { $each: push }
            } else if (typeof push === 'object') {
              cx.$push[`${parentPath}${e.name}`] = push
            }
            delete ref[e.name]
            clearEmptyContainer(parentRef, ref)
          }
        }
      }

      for (let k = 0; k < 2; k++) {
        const target = k === 0 ? cx.$addToSet : cx.$pull
        const operand = k === 0 ? '$push' : '$remove'
        if (
          !(target && e.isRelLike && e.hasManyTruthy && cx.isWrite && e.name in ref && ref[e.name])
        ) {
          continue
        }
        const value = ref[e.name]
        if (
          !(
            value &&
            typeof value === 'object' &&
            (operand in value ||
              (cx.cp.localization && shouldLocalize && someLocaleHas(value, operand)))
          )
        ) {
          continue
        }
        if (cx.cp.localization && shouldLocalize) {
          let hasLocaleOperations = false
          Object.entries(value).forEach(([localeKey, localeValue]) => {
            if (localeValue && typeof localeValue === 'object' && operand in localeValue) {
              hasLocaleOperations = true
              const operandValue = localeValue[operand]
              const localeItems = Array.isArray(operandValue) ? operandValue : [operandValue]
              const processed = processRelationshipValues(cx, localeItems, e)
              target[`${parentPath}${e.name}.${localeKey}`] =
                k === 0 ? { $each: processed } : { $in: processed }
            }
          })
          if (hasLocaleOperations) {
            delete ref[e.name]
            clearEmptyContainer(parentRef, ref)
          }
        } else if (value && typeof value === 'object' && operand in value) {
          const items = Array.isArray(value[operand]) ? value[operand] : [value[operand]]
          const processed = processRelationshipValues(cx, items, e)
          target[`${parentPath}${e.name}`] = k === 0 ? { $each: processed } : { $in: processed }
          delete ref[e.name]
          clearEmptyContainer(parentRef, ref)
        }
      }

      if (e.isDate && cx.isRead && e.name in ref && ref[e.name]) {
        if (cx.cp.localization && shouldLocalize) {
          const fieldRef = ref[e.name]
          if (!fieldRef || typeof fieldRef !== 'object') {
            return
          }
          const codes = cx.cp.localeCodes
          for (let i = 0; i < codes.length; i++) {
            sanitizeDate(e, codes[i], fieldRef, fieldRef[codes[i]])
          }
        } else {
          sanitizeDate(e, undefined, ref, ref[e.name])
        }
      }

      if (e.isRelLike || (cx.isRead && e.isJoin)) {
        if (!ref[e.name]) {
          return
        }
        if (cx.cp.localization && shouldLocalize) {
          const codes = cx.cp.localeObjectCodes
          const fieldRef = ref[e.name]
          if (typeof fieldRef !== 'object') {
            return
          }
          for (let i = 0; i < codes.length; i++) {
            const code = codes[i]
            const value = fieldRef[code]
            if (value) {
              sanitizeRelationship(cx, e, code, fieldRef, value)
            }
          }
        } else {
          sanitizeRelationship(cx, e, undefined, ref, ref[e.name])
        }
      }
    }

    // payload/src/utilities/fieldPath.ts
    const setOwnProperty = (key, target, value) => {
      if (Object.hasOwn(target, key) || !(key in target)) {
        if (!Reflect.set(target, key, value)) {
          throw new TypeError(`Cannot assign to property ${String(key)}`)
        }
        return target
      }
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      })
      return target
    }
    const expandOwnDottedKey = (key, target) => {
      if (!Object.hasOwn(target, key) || !key.includes('.')) {
        return false
      }
      const segments = key.split('.')
      if (segments.some((segment) => segment === '__proto__')) {
        delete target[key]
        return false
      }
      const firstDotIndex = key.indexOf('.')
      const fieldName = key.substring(0, firstDotIndex)
      const remainingPath = key.substring(firstDotIndex + 1)
      if (!Object.hasOwn(target, fieldName) || !target[fieldName]) {
        setOwnProperty(fieldName, target, {})
      }
      const nestedTarget = target[fieldName]
      setOwnProperty(remainingPath, nestedTarget, target[key])
      delete target[key]
      return true
    }

    /** `traverseFields` with `fillEmpty: false`, `leavesFirst: false` and the `sanitize` callback. */
    const traverseFields = (cx, plan, pil, parentPath, parentRef, ref) => {
      if (parentRef === undefined) {
        parentRef = {}
      }
      if (ref === undefined) {
        // `ref = {}`: nothing to read or write on a fresh empty object
        return
      }
      const entries = plan.entries
      for (let i = 0; i < entries.length; i++) {
        if (!ref || typeof ref !== 'object') {
          continue
        }
        const e = entries[i]
        sanitize(cx, e, pil, parentPath, parentRef, ref)

        let currentRef = ref
        let currentParentRef = parentRef

        if (e.isTabs) {
          for (const t of e.tabs) {
            const tabIsLocalized = t.localizable && !pil
            let tabRef = ref
            if (t.hasNameTruthy) {
              if (!ref[t.name] || typeof ref[t.name] !== 'object') {
                continue
              }
              tabRef = tabRef[t.name]
              if (tabIsLocalized) {
                for (const key in tabRef) {
                  if (tabRef[key] && typeof tabRef[key] === 'object') {
                    traverseFields(
                      cx,
                      t.plan,
                      true,
                      cx.paths ? `${parentPath}${t.name}.` : '',
                      currentParentRef,
                      tabRef[key],
                    )
                  }
                }
              }
            }
            if (!tabIsLocalized) {
              traverseFields(
                cx,
                t.plan,
                pil,
                cx.paths && t.hasName ? `${parentPath}${t.name}.` : parentPath,
                currentParentRef,
                tabRef,
              )
            }
          }
          continue
        }

        if (e.isTab || e.hasSubFields || e.isBlocks) {
          if (e.hasNameTruthy) {
            currentParentRef = currentRef
            if (!ref[e.name]) {
              continue
            }
            currentRef = ref[e.name]
          }
          if (
            (e.isTab || e.isGroup) &&
            e.localizable &&
            !pil &&
            currentRef &&
            typeof currentRef === 'object'
          ) {
            if (e.affectsData) {
              for (const key in currentRef) {
                if (currentRef[key]) {
                  traverseFields(
                    cx,
                    e.children,
                    true,
                    cx.paths && e.name ? `${parentPath}${e.name}.` : parentPath,
                    currentParentRef,
                    currentRef[key],
                  )
                }
              }
            } else {
              traverseFields(cx, e.children, pil, '', currentParentRef, currentRef)
            }
            continue
          }
          if ((e.isBlocks || e.isArray) && currentRef && typeof currentRef === 'object') {
            if (e.localizable && !pil) {
              if (Array.isArray(currentRef)) {
                traverseRows(cx, currentRef, e, true, parentPath, currentParentRef)
              } else {
                for (const key in currentRef) {
                  const localeData = currentRef[key]
                  if (!Array.isArray(localeData)) {
                    continue
                  }
                  traverseRows(cx, localeData, e, true, parentPath, currentParentRef)
                }
              }
            } else if (Array.isArray(currentRef)) {
              traverseRows(cx, currentRef, e, pil, parentPath, currentParentRef)
            }
          } else if (currentRef && typeof currentRef === 'object' && e.hasFieldsKey) {
            traverseFields(
              cx,
              e.children,
              pil,
              cx.paths && e.hasNameTruthy ? `${parentPath}${e.name}.` : parentPath,
              currentParentRef,
              currentRef,
            )
          }
        }
      }

      // the dotted-key fallback (`fieldsMatched` is always false: `sanitize` returns nothing)
      if (ref && typeof ref === 'object') {
        const keys = Object.keys(ref)
        for (let i = 0; i < keys.length; i++) {
          if (expandOwnDottedKey(keys[i], ref)) {
            traverseFields(cx, plan, pil, parentPath, parentRef, ref)
          }
        }
      }
    }

    /** `traverseArrayOrBlocksField` with `fillEmpty: false`. */
    const traverseRows = (cx, data, e, pil, parentPath, parentRef) => {
      for (const ref of data) {
        let plan
        if (e.isBlocks && typeof ref?.blockType === 'string') {
          // config?.blocks?.find((b) => b.slug === ref.blockType) ??
          //   field.blocks.find((b) => typeof b !== 'string' && b.slug === ref.blockType)
          let fields
          let block
          if (cx.cp.blocks) {
            for (const b of cx.cp.blocks) {
              if (b.slug === ref.blockType) {
                block = b
                break
              }
            }
          }
          if (block == null) {
            for (const b of e.fieldBlocks) {
              if (typeof b !== 'string' && b.slug === ref.blockType) {
                block = b
                break
              }
            }
          }
          fields = block?.fields
          if (fields) {
            plan = e.blockPlans.get(fields)
          }
        } else if (e.isArray) {
          plan = e.children
        }
        if (plan) {
          traverseFields(
            cx,
            plan,
            pil || e.localizedTruthy,
            cx.paths ? `${parentPath}${e.name}.` : '',
            parentRef,
            ref,
          )
        }
      }
    }

    /** The block of a stripped row: `field.blocks.find(...)` (reads `data.blockType` per try). */
    const stripBlockOf = (e, data) => {
      const blocks = e.blocks
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].slug === data.blockType) {
          return blocks[i]
        }
      }
      return undefined
    }

    /** The row loop of `stripFields`; returns `hasNull`. */
    const stripRows = (cx, rows, e, pil, reservedKeys) => {
      let hasNull = false
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        if (!row || typeof row !== 'object') {
          rows[i] = null
          hasNull = true
          continue
        }
        let plan = null
        if (e.isArray) {
          plan = e.nested
        } else {
          const found = stripBlockOf(e, row)
          if (found && found.block) {
            plan = found.plan
          } else {
            rows[i] = null
            hasNull = true
          }
        }
        if (!plan) {
          continue
        }
        stripFields(cx, row, plan, pil || e.localizedTruthy, reservedKeys)
      }
      return hasNull
    }

    const stripFields = (cx, data, plan, pil, reservedKeys) => {
      const names = plan.names
      for (const k in data) {
        if (!names.has(k) && !reservedKeys.includes(k)) {
          delete data[k]
        }
      }
      const entries = plan.entries
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        reservedKeys = e.isBlocks ? ['blockType'] : []
        const fieldData = data[e.name]
        if (!fieldData || typeof fieldData !== 'object') {
          continue
        }
        if (!e.hasNested) {
          continue
        }
        if (e.localizable && !pil && cx.cp.localization) {
          for (const localeKey in fieldData) {
            if (!cx.cp.localeCodeSet.has(localeKey)) {
              delete fieldData[localeKey]
              continue
            }
            const localeData = fieldData[localeKey]
            if (!localeData || typeof localeData !== 'object') {
              continue
            }
            if (e.isRows) {
              if (!Array.isArray(localeData)) {
                continue
              }
              if (stripRows(cx, localeData, e, pil, reservedKeys)) {
                fieldData[localeKey] = localeData.filter(Boolean)
              }
              continue
            }
            stripFields(cx, localeData, e.nested, pil || e.localizedTruthy, reservedKeys)
          }
          continue
        }
        if (e.isRows) {
          if (!Array.isArray(fieldData)) {
            continue
          }
          if (stripRows(cx, fieldData, e, pil, reservedKeys)) {
            data[e.name] = fieldData.filter(Boolean)
          }
          continue
        }
        stripFields(cx, fieldData, e.nested, pil || e.localizedTruthy, reservedKeys)
      }
    }

    /**
     * The plans of `fields` under `config` (`{ cp, strip, traverse }`), or null when the planner
     * cannot plan them (the exhaustive port then transforms the document). `flattenAllFields` is
     * pure (its cache only memoizes), so calling it here, before upstream would, is not observable.
     */
    const plansOf = (config, fields) => {
      try {
        need(config !== null && typeof config === 'object')
        const cp = configPlanOf(config)
        return {
          cp,
          strip: stripPlanOf(flattenAllFields({ cache: true, fields }), cp),
          traverse: traversePlanOf(fields, cp),
        }
      } catch {
        // UNPLANNABLE, or a config that throws while it is planned (upstream throws only once data
        // reaches it): the exhaustive port runs the document
        return null
      }
    }

    const transformOne = (cx, data, pil) => {
      if (!data) {
        return null
      }
      if (Array.isArray(data)) {
        for (const item of data) {
          transformOne(cx, item, false)
        }
        return undefined
      }
      const adapter = cx.adapter
      const {
        payload: { config },
      } = adapter
      if (config !== cx.config || cx.plans === undefined) {
        cx.config = config
        cx.plans = plansOf(config, cx.fields)
      }
      const plans = cx.plans
      if (plans === null) {
        // the rest of upstream's body for this document, after its `config` read
        counters.slowDocs++
        native.slowTransformDoc(cx.args, data, pil, config)
        return undefined
      }
      counters.fastDocs++
      cx.cp = plans.cp
      if (cx.isRead) {
        delete data['__v']
        data.id = data._id || data.id
        delete data['_id']
        if (isObjectID(data.id)) {
          data.id = data.id.toHexString()
        }
        if (adapter.useBigIntForNumberIDs && typeof data.id === 'bigint') {
          data.id = Number(data.id)
        }
        if (!adapter.allowAdditionalKeys) {
          stripFields(cx, data, plans.strip, false, ['id', 'globalType'])
        }
      }
      if (cx.isWrite && cx.globalSlug) {
        data.globalType = cx.globalSlug
      }
      traverseFields(cx, plans.traverse, pil, '', {}, data)
      if (cx.isWrite) {
        if (typeof data.updatedAt === 'undefined') {
          data.updatedAt = new Date().toISOString()
        } else if (data.updatedAt === null) {
          delete data.updatedAt
        }
      }
      return undefined
    }

    /**
     * `transform(args)` with the args positional (the deps struct of payload-mongo-live), defaults
     * applied like the TS destructuring.
     */
    const transform = (
      $addToSet,
      $inc,
      $pull,
      $push,
      adapter,
      data,
      fields,
      globalSlug,
      operation,
      parentIsLocalized,
      validateRelationships,
    ) => {
      if (parentIsLocalized === undefined) {
        parentIsLocalized = false
      }
      if (validateRelationships === undefined) {
        validateRelationships = true
      }
      const args = {
        $addToSet,
        $inc,
        $pull,
        $push,
        adapter,
        data,
        fields,
        globalSlug,
        operation,
        parentIsLocalized,
        validateRelationships,
      }
      if (!intrinsicsIntact()) {
        counters.slowCalls++
        return native.slowTransform(args)
      }
      const cx = {
        $addToSet,
        $inc,
        $pull,
        $push,
        adapter,
        args,
        config: undefined,
        cp: undefined,
        fields,
        globalSlug,
        isRead: operation === 'read',
        isWrite: operation === 'write',
        // the paths only key the operator objects of writes
        paths: Boolean($addToSet || $inc || $pull || $push),
        plans: undefined,
        validateRelationships,
      }
      return transformOne(cx, data, parentIsLocalized)
    }

    return { stats: () => ({ ...counters }), transform }
  }
})()
