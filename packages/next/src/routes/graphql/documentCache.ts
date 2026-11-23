import type { DocumentNode, GraphQLError, GraphQLSchema, ValidationRule } from 'graphql'

import { parse, validate } from 'graphql'

/**
 * Upper bound of cached documents. Query strings are client input: past the bound the oldest
 * entry is evicted, so memory stays bounded whatever clients send.
 */
const maxCachedDocuments = 1000

const documentsByQuery = new Map<string, DocumentNode>()

/**
 * Rule lists built by `concatRules`, mapped to the default rules (graphql's `specifiedRules` as
 * graphql-http passes them) they start with.
 */
const defaultRulesByRules = new WeakMap<readonly ValidationRule[], readonly ValidationRule[]>()

/**
 * Whether a document passes the default rules against a schema. graphql's specified rules read
 * only the schema and the document, so the answer is a pure function of the three. Keyed on the
 * document object of `parseWithCache`, so an evicted document drops its entries too.
 */
const defaultRulesResults = new WeakMap<
  GraphQLSchema,
  WeakMap<readonly ValidationRule[], WeakMap<DocumentNode, boolean>>
>()

/**
 * `graphql.parse`, memoized per query string. `parse` is pure: the same string always yields an
 * equal document, and graphql-js never mutates a document while validating or executing it.
 * Parse errors are not cached: every failing request runs `parse` again and gets its own error.
 */
export const parseWithCache = (query: string): DocumentNode => {
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

/**
 * `defaultRules.concat(additionalRules)`, remembered so `validateWithCache` knows which prefix of
 * the list is the default rules.
 */
export const concatRules = ({
  additionalRules,
  defaultRules,
}: {
  additionalRules: readonly ValidationRule[]
  defaultRules: readonly ValidationRule[]
}): ValidationRule[] => {
  const rules = defaultRules.concat(additionalRules)

  defaultRulesByRules.set(rules, defaultRules)

  return rules
}

/**
 * `graphql.validate` with the default rules memoized per (schema, default rules, document).
 *
 * For a rule list built by `concatRules` whose document passes the default rules, validating
 * with every rule gives the same result as validating with the additional rules alone: the
 * default rules report nothing, rules share no state other than the (read-only) type info, and
 * the additional rules run in the same order. The additional rules (query complexity, which
 * depends on the variables, the introspection rule, `config.graphQL.validationRules`) still run
 * on every request. A document that fails the default rules, or any other rule list, is validated
 * with every rule, exactly as without the cache.
 */
export const validateWithCache = (
  schema: GraphQLSchema,
  document: DocumentNode,
  rules: readonly ValidationRule[],
): readonly GraphQLError[] => {
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
