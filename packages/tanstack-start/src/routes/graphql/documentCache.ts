import type { DocumentNode, GraphQLSchema, ValidationRule } from 'graphql'

/**
 * The GraphQL document cache of `@payloadcms/next`'s route (packages/next/src/routes/graphql/
 * documentCache.ts), built from the `graphql` module the handler loads at runtime (this package
 * imports server dependencies dynamically): `parse` memoized per query string, graphql's
 * specified rules memoized per (schema, default rules, document). See that file for why the
 * results equal uncached `parse` / `validate`.
 */
export const createDocumentCache = ({
  parse,
  validate,
}: {
  parse: (query: string) => DocumentNode
  validate: (
    schema: GraphQLSchema,
    document: DocumentNode,
    rules: readonly ValidationRule[],
  ) => readonly unknown[]
}) => {
  /** Query strings are client input: past the bound the oldest entry is evicted. */
  const maxCachedDocuments = 1000
  const documentsByQuery = new Map<string, DocumentNode>()
  const defaultRulesByRules = new WeakMap<readonly ValidationRule[], readonly ValidationRule[]>()
  const defaultRulesResults = new WeakMap<
    GraphQLSchema,
    WeakMap<readonly ValidationRule[], WeakMap<DocumentNode, boolean>>
  >()

  /** Parse errors are not cached: every failing request runs `parse` again. */
  const parseWithCache = (query: string) => {
    const cachedDocument = documentsByQuery.get(query)

    if (cachedDocument) {
      return cachedDocument
    }

    const document = parse(query)

    if (documentsByQuery.size >= maxCachedDocuments) {
      documentsByQuery.delete(documentsByQuery.keys().next().value!)
    }

    documentsByQuery.set(query, document)

    return document
  }

  /** `defaultRules.concat(additionalRules)`, remembering the default prefix. */
  const concatRules = ({
    additionalRules,
    defaultRules,
  }: {
    additionalRules: readonly ValidationRule[]
    defaultRules: readonly ValidationRule[]
  }) => {
    const rules = defaultRules.concat(additionalRules)

    defaultRulesByRules.set(rules, defaultRules)

    return rules
  }

  /**
   * A rule list from `concatRules` whose document passes the default rules is validated with the
   * additional rules only (same errors, same order); anything else with every rule.
   */
  const validateWithCache = (
    schema: GraphQLSchema,
    document: DocumentNode,
    rules: readonly ValidationRule[],
  ) => {
    const defaultRules = defaultRulesByRules.get(rules)

    if (!defaultRules) {
      return validate(schema, document, rules)
    }

    let resultsByRules = defaultRulesResults.get(schema)

    if (!resultsByRules) {
      resultsByRules = new WeakMap()
      defaultRulesResults.set(schema, resultsByRules)
    }

    let resultsByDocument = resultsByRules.get(defaultRules)

    if (!resultsByDocument) {
      resultsByDocument = new WeakMap()
      resultsByRules.set(defaultRules, resultsByDocument)
    }

    let isValidForDefaultRules = resultsByDocument.get(document)

    if (isValidForDefaultRules === undefined) {
      isValidForDefaultRules = validate(schema, document, defaultRules).length === 0
      resultsByDocument.set(document, isValidForDefaultRules)
    }

    if (!isValidForDefaultRules) {
      return validate(schema, document, rules)
    }

    return validate(schema, document, rules.slice(defaultRules.length))
  }

  return { concatRules, parseWithCache, validateWithCache }
}
