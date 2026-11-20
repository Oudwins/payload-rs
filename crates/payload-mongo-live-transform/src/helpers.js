// JS expressions of packages/db-mongodb/src/utilities/{transform,handleError,getEntity,getDBName}.ts
// and packages/payload/src/utilities/{traverseFields,fieldPath}.ts whose evaluation must be V8's:
// every built-in (`Array.isArray`, `Object.keys` / `values` / `entries` / `hasOwn`, `Array.prototype`
// `some` / `find` / `map` / `filter` / `forEach` / `includes` / `push` / `reverse`, `String.prototype`
// methods, `for...of` iterators, destructuring, spreads, `in`, `instanceof`, `JSON`, `Number`,
// `Boolean`, `new Date()`) is looked up when the upstream expression runs, on the live values. Each
// helper is the upstream expression (same identifiers where V8 puts source text into messages);
// control flow and recursion stay in Rust (live.rs / transform.rs). Callbacks that user code can
// keep or re-enter (the ones passed to `some` / `find` / `map` / `forEach`) are plain JS closures
// here, calling the stateless native functions of `native` with every value they close over.
;(function () {
  'use strict'
  return function createLiveTransformHelpers(deps, native) {
    const { APIError, flattenAllFields, Types, ValidationError } = deps

    // packages/payload/src/fields/config/types.ts
    const fieldIsPresentationalOnly = (field) => field.type === 'ui'
    const fieldAffectsData = (field) => 'name' in field && !fieldIsPresentationalOnly(field)
    const fieldHasSubFields = (field) =>
      field.type === 'group' ||
      field.type === 'array' ||
      field.type === 'row' ||
      field.type === 'collapsible'
    const tabHasName = (tab) => 'name' in tab
    const fieldShouldBeLocalized = ({ field, parentIsLocalized }) =>
      Boolean('localized' in field && field.localized && !parentIsLocalized)

    // packages/payload/src/utilities/fieldPath.ts
    const unsupportedFieldPathSegments = new Set(['__proto__'])
    const hasUnsupportedFieldPathSegment = ({ segments }) =>
      segments.some((segment) => unsupportedFieldPathSegments.has(segment))
    const setOwnProperty = ({ key, target, value }) => {
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
    const expandOwnDottedKey = ({ key, target }) => {
      if (!Object.hasOwn(target, key) || !key.includes('.')) {
        return false
      }

      const segments = key.split('.')

      if (hasUnsupportedFieldPathSegment({ segments })) {
        delete target[key]
        return false
      }

      const firstDotIndex = key.indexOf('.')
      const fieldName = key.substring(0, firstDotIndex)
      const remainingPath = key.substring(firstDotIndex + 1)

      if (!Object.hasOwn(target, fieldName) || !target[fieldName]) {
        setOwnProperty({ key: fieldName, target, value: {} })
      }

      const nestedTarget = target[fieldName]

      setOwnProperty({ key: remainingPath, target: nestedTarget, value: target[key] })
      delete target[key]

      return true
    }

    // packages/payload/src/utilities/traverseFields.ts as transform runs it (`fillEmpty: false`,
    // `leavesFirst: false`, a callback that never returns truthy): the `fields.some` loop over the
    // per-field body (native.traverseField) and the dotted-key fallback. The recursion of the
    // fallback stays in JS like upstream's (no native frames per level, so the stack depth at
    // which it overflows is upstream's).
    const traverseFields = (
      fields,
      state,
      parentIsLocalized,
      parentPath,
      parentRef = {},
      ref = {},
      isTopLevel,
    ) => {
      const fieldsMatched = fields.some((field) =>
        native.traverseField(
          state,
          field,
          parentIsLocalized,
          parentPath,
          parentRef,
          ref,
          isTopLevel,
        ),
      )
      if (!fieldsMatched && ref && typeof ref === 'object') {
        Object.keys(ref).forEach((key) => {
          if (expandOwnDottedKey({ key, target: ref })) {
            traverseFields(fields, state, parentIsLocalized, parentPath, parentRef, ref, false)
          }
        })
      }
    }

    return {
      // ---------------------------------------------------------------------------------------
      // generic
      get: (o, k) => o[k],
      set: (o, k, v) => {
        o[k] = v
      },
      del: (o, k) => {
        delete o[k]
      },
      has: (k, o) => k in o,
      isArray: (v) => Array.isArray(v),
      forIn: (o, cb) => {
        for (const k in o) {
          cb(k)
        }
      },
      forOf: (iterable, cb) => {
        for (const item of iterable) {
          cb(item)
        }
      },
      lessThan: (a, b) => a < b,
      toPropertyString: (value) => `${value}`,
      notAFunction: (expression) => new TypeError(`${expression} is not a function`),
      object: () => ({}),

      // ---------------------------------------------------------------------------------------
      // transform
      destructureTransformArgs: ({
        $addToSet,
        $inc,
        $pull,
        $push,
        adapter,
        data,
        fields,
        globalSlug,
        operation,
        parentIsLocalized = false,
        validateRelationships = true,
      }) => [
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
      ],
      configOf: (adapter) => {
        const {
          payload: { config },
        } = adapter
        return config
      },
      docState: (
        $addToSet,
        $inc,
        $pull,
        $push,
        adapter,
        config,
        operation,
        validateRelationships,
      ) => ({
        $addToSet,
        $inc,
        $pull,
        $push,
        adapter,
        config,
        operation,
        validateRelationships,
      }),
      flattenAllFields: (fields) => flattenAllFields({ cache: true, fields }),
      toNumber: (value) => Number(value),
      nowISOString: () => new Date().toISOString(),

      // ---------------------------------------------------------------------------------------
      // stripFields
      topReservedKeys: () => ['id', 'globalType'],
      newReservedKeys: () => [],
      stripKeyCondition: (fields, k, reservedKeys) =>
        !fields.some((field) => field.name === k) && !reservedKeys.includes(k),
      fieldValue: (data, field) => data[field.name],
      shouldBeLocalized: (field, parentIsLocalized) =>
        fieldShouldBeLocalized({ field, parentIsLocalized }),
      pushBlockType: (field, reservedKeys) => {
        if (field.type === 'blocks') {
          reservedKeys.push('blockType')
        }
      },
      hasNestedFields: (field) => 'flattenedFields' in field || 'blocks' in field,
      localeCodeMissing: (config, localeKey) =>
        !config.localization.localeCodes.some((code) => code === localeKey),
      isRowsField: (field) => field.type === 'array' || field.type === 'blocks',
      isArrayField: (field) => field.type === 'array',
      findStripBlock: (config, field, data) => {
        const blockOrSlug = field.blocks.find((each) => {
          const slug = typeof each === 'string' ? each : each.slug
          return slug === data.blockType
        })
        const maybeBlock =
          typeof blockOrSlug === 'string'
            ? config.blocks?.find((each) => each.slug === blockOrSlug)
            : blockOrSlug
        return maybeBlock
      },
      filterBoolean: (localeData) => localeData.filter(Boolean),
      assignFiltered: (data, field, fieldData) => {
        data[field.name] = fieldData.filter(Boolean)
      },

      // ---------------------------------------------------------------------------------------
      // traverseFields (fillEmpty: false, leavesFirst: false)
      traverseFields,
      runCallbackStack: () => {
        const callbackStack = []
        callbackStack.reverse().forEach((cb) => {
          cb()
        })
      },
      isTabsField: (field) => field.type === 'tabs' && 'tabs' in field,
      namedTab: (tab) => 'name' in tab && tab.name,
      tabRefMissing: (ref, tab) => !ref[tab.name] || typeof ref[tab.name] !== 'object',
      spreadTab: (tab) => ({ ...tab, type: 'tab' }),
      tabPath: (parentPath, tab) => (tabHasName(tab) ? `${parentPath}${tab.name}.` : parentPath),
      childPath: (parentPath, holder) => `${parentPath}${holder.name}.`,
      hasSubFieldsOrBlocks: (field) =>
        field.type === 'tab' || fieldHasSubFields(field) || field.type === 'blocks',
      namedField: (field) => 'name' in field && field.name,
      localizedGroupCondition: (field, parentIsLocalized, currentRef) =>
        (field.type === 'tab' || field.type === 'group') &&
        fieldShouldBeLocalized({ field, parentIsLocalized }) &&
        currentRef &&
        typeof currentRef === 'object',
      affectsData: (field) => fieldAffectsData(field),
      optionalNamePath: (parentPath, field) =>
        field.name ? `${parentPath}${field.name}.` : parentPath,
      rowsCondition: (field, currentRef) =>
        (field.type === 'blocks' || field.type === 'array') &&
        currentRef &&
        typeof currentRef === 'object',
      fieldsCondition: (field, currentRef) =>
        currentRef && typeof currentRef === 'object' && 'fields' in field,
      namedPath: (parentPath, field) =>
        'name' in field && field.name ? `${parentPath}${field.name}.` : parentPath,
      isBlockRow: (field, ref) => field.type === 'blocks' && typeof ref?.blockType === 'string',
      findRowBlock: (config, field, ref) =>
        config?.blocks?.find((b) => b.slug === ref.blockType) ??
        field.blocks.find((b) => typeof b !== 'string' && b.slug === ref.blockType),
      optionalFields: (block) => block?.fields,
      localizedOr: (parentIsLocalized, field) => parentIsLocalized || field.localized,

      // ---------------------------------------------------------------------------------------
      // the `sanitize` callback
      clearEmptyContainer: (parentRef, ref) => {
        if (!parentRef || typeof parentRef !== 'object') {
          return
        }
        if (!ref || typeof ref !== 'object') {
          return
        }
        if (Object.keys(ref).length > 0) {
          return
        }
        const containerKey = Object.keys(parentRef).find((k) => parentRef[k] === ref)
        if (containerKey) {
          parentRef[containerKey] = undefined
        }
      },
      incCondition: ($inc, field, operation, ref) =>
        $inc &&
        field.type === 'number' &&
        operation === 'write' &&
        field.name in ref &&
        ref[field.name],
      isIncValue: (value) =>
        value && typeof value === 'object' && '$inc' in value && typeof value.$inc === 'number',
      pathKey: (parentPath, field) => `${parentPath}${field.name}`,
      localePathKey: (parentPath, field, localeKey) => `${parentPath}${field.name}.${localeKey}`,
      deleteFieldOf: (ref, field) => {
        delete ref[field.name]
      },
      pushCondition: ($push, field, operation, ref) =>
        $push &&
        field.type === 'array' &&
        operation === 'write' &&
        field.name in ref &&
        ref[field.name],
      relationshipOperationCondition: (target, field, operation, ref) =>
        target &&
        (field.type === 'relationship' || field.type === 'upload') &&
        'hasMany' in field &&
        field.hasMany &&
        operation === 'write' &&
        field.name in ref &&
        ref[field.name],
      operationValueCondition: (config, field, parentIsLocalized, value, operand) =>
        value &&
        typeof value === 'object' &&
        (operand in value ||
          (config.localization &&
            fieldShouldBeLocalized({ field, parentIsLocalized }) &&
            Object.values(value).some(
              (localeValue) =>
                localeValue && typeof localeValue === 'object' && operand in localeValue,
            ))),
      localizedCondition: (config, field, parentIsLocalized) =>
        config.localization && fieldShouldBeLocalized({ field, parentIsLocalized }),
      hasOperand: (value, operand) => value && typeof value === 'object' && operand in value,
      localeOperations: (value, state, field, parentPath, kind) => {
        let hasLocaleOperations = false
        Object.entries(value).forEach(([localeKey, localeValue]) => {
          if (native.localeOperation(state, field, parentPath, kind, localeKey, localeValue)) {
            hasLocaleOperations = true
          }
        })
        return hasLocaleOperations
      },
      operandItems: (value, operand) =>
        Array.isArray(value[operand]) ? value[operand] : [value[operand]],
      itemsOf: (push) => (Array.isArray(push) ? push : [push]),
      each: (items) => ({ $each: items }),
      in: (items) => ({ $in: items }),
      processRelationshipValues: (items, state, field) =>
        items.map((item) => native.processRelationshipItem(state, field, item)),
      dateCondition: (field, operation, ref) =>
        field.type === 'date' && operation === 'read' && field.name in ref && ref[field.name],
      isDate: (value) => value instanceof Date,
      toISOString: (value) => value.toISOString(),
      setFieldOf: (ref, field, value) => {
        ref[field.name] = value
      },
      relationshipTypeCondition: (field, operation) =>
        field.type === 'relationship' ||
        field.type === 'upload' ||
        (operation === 'read' && field.type === 'join'),
      forOfCodes: (locales, cb) => {
        for (const { code } of locales) {
          cb(code)
        }
      },

      // sanitizeRelationship / convertRelationshipValue / processRelationshipValues
      isJoinField: (field) => field.type === 'join',
      joinDocsCondition: (operation, value) =>
        operation === 'read' &&
        value &&
        typeof value === 'object' &&
        'docs' in value &&
        Array.isArray(value.docs),
      polymorphicJoinItem: (field, item) => Array.isArray(field.collection) && item,
      jsonRoundTrip: (value) => JSON.parse(JSON.stringify(value)),
      findCollection: (config, holder) =>
        config.collections?.find(({ slug }) => slug === holder.relationTo),
      mapRelationshipValues: (value, state, field, relatedCollection) =>
        value.map((val) => native.mapRelationshipValue(state, field, relatedCollection, val)),
      relationObject: (relationTo, value) => ({ relationTo, value }),
      customIDField: (relatedCollection) =>
        relatedCollection.fields.find((field) => fieldAffectsData(field) && field.name === 'id'),
      customIDIsNumber: (customIDField) => customIDField?.type === 'number',
      newObjectId: (value) => new Types.ObjectId(value),

      // ---------------------------------------------------------------------------------------
      // handleError
      destructureHandleError: ({ collection, error, global, req }) => [
        collection,
        error,
        global,
        req,
      ],
      firstKey: (keyValue) => Object.keys(keyValue)[0] ?? '',
      extractFieldFromMessage: (message) => {
        // eslint-disable-next-line regexp/no-super-linear-backtracking
        const match = message.match(/index:\s*(.*?)_/)
        if (match && match[1]) {
          return match[1]
        }
        return null
      },
      lastIndexOfDot: (path) => path.lastIndexOf('.'),
      substringAfterIndex: (path, lastDotIndex) => path.substring(lastDotIndex + 1),
      substringToIndex: (path, lastDotIndex) => path.substring(0, lastDotIndex),
      validationErrorData: (collection, message, path, global) => ({
        collection,
        errors: [
          {
            message,
            path,
          },
        ],
        global,
      }),
      newValidationError: (data, t) => new ValidationError(data, t),

      // ---------------------------------------------------------------------------------------
      // getEntity / getDBName
      destructureGetCollection: ({ adapter, collectionSlug, versions = false }) => [
        adapter,
        collectionSlug,
        versions,
      ],
      destructureGetGlobal: ({ adapter, globalSlug, versions = false }) => [
        adapter,
        globalSlug,
        versions,
      ],
      destructureGetDBName: ({
        config: { name, slug },
        config,
        target = 'dbName',
        versions = false,
      }) => [name, slug, config, target, versions],
      findGlobal: (adapter, globalSlug) =>
        adapter.payload.config.globals.find((each) => each.slug === globalSlug),
      newAPIError: (message) => new APIError(message),
      collectionEntity: (collectionConfig, customIDType, Model) => ({
        collectionConfig,
        customIDType,
        Model,
      }),
      globalEntity: (globalConfig, Model) => ({ globalConfig, Model }),
    }
  }
})()
