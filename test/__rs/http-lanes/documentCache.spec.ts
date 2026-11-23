/**
 * Differential of the GraphQL document caches (packages/next/src/routes/graphql/documentCache.ts
 * and the tanstack-start factory, packages/tanstack-start/src/routes/graphql/documentCache.ts)
 * against uncached graphql-js: for every (query, variables) case, run twice (memo miss, then hit)
 * and interleaved with other variables, `validateWithCache(schema, parseWithCache(query), rules)`
 * must serialize exactly like `validate(schema, parse(query), rules)`, with the rules built the way
 * the GraphQL route builds them (graphql's specified rules, then Payload's complexity rule, which
 * reads the variables, then custom rules).
 *
 *   pnpm vitest run --config test/__rs/http-lanes/vitest.config.ts --project http-lanes-unit
 */
import type { ValidationRule } from 'graphql'

import {
  GraphQLError,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse,
  specifiedRules,
  validate,
} from 'graphql'
import { describe, expect, it } from 'vitest'

import {
  createComplexityRule,
  fieldExtensionsEstimator,
  simpleEstimator,
} from '../../../packages/graphql/src/packages/graphql-query-complexity/index.js'
import * as nextDocumentCache from '../../../packages/next/src/routes/graphql/documentCache.js'
import { createDocumentCache } from '../../../packages/tanstack-start/src/routes/graphql/documentCache.js'

const Author: GraphQLObjectType = new GraphQLObjectType({
  name: 'Author',
  fields: () => ({
    name: { type: GraphQLString },
    posts: {
      args: { limit: { type: GraphQLInt } },
      extensions: {
        complexity: ({ args, childComplexity }: { args: any; childComplexity: number }) =>
          childComplexity * (args.limit ?? 10),
      },
      type: new GraphQLList(Post),
    },
  }),
})

const Post: GraphQLObjectType = new GraphQLObjectType({
  name: 'Post',
  fields: () => ({
    author: { type: Author },
    id: { type: new GraphQLNonNull(GraphQLString) },
    title: { type: GraphQLString },
    views: { type: GraphQLInt },
  }),
})

const schema = new GraphQLSchema({
  mutation: new GraphQLObjectType({
    name: 'Mutation',
    fields: {
      createPost: { args: { title: { type: new GraphQLNonNull(GraphQLString) } }, type: Post },
    },
  }),
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      Post: { args: { id: { type: new GraphQLNonNull(GraphQLString) } }, type: Post },
      Posts: {
        args: { limit: { type: GraphQLInt }, where: { type: GraphQLString } },
        extensions: {
          complexity: ({ args, childComplexity }: { args: any; childComplexity: number }) =>
            childComplexity * (args.limit ?? 10),
        },
        type: new GraphQLList(Post),
      },
    },
  }),
})

const NoTitle: ValidationRule = (context) => ({
  Field(node) {
    if (node.name.value === 'title' && context.getDocument().definitions.length > 1) {
      context.reportError(new GraphQLError('custom: title in a multi-operation document'))
    }
  },
})

const additionalRules = ({
  isCustomRule,
  variables,
}: {
  isCustomRule: boolean
  variables?: Record<string, unknown>
}): ValidationRule[] => [
  createComplexityRule({
    estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
    maximumComplexity: 200,
    variables,
  }),
  ...(isCustomRule ? [NoTitle] : []),
]

const queries = [
  '{ Posts(limit: 10) { id title views } }',
  '{ Posts(limit: 100) { id title author { name } } }',
  'query ($limit: Int) { Posts(limit: $limit) { id title } }',
  'query ($limit: Int, $deep: Boolean!) { Posts(limit: $limit) { id author @include(if: $deep) { posts(limit: 50) { id } } } }',
  'query ($id: String!) { Post(id: $id) { id title author { name } } }',
  'query A { Posts { id } } query B { Post(id: "1") { title } }',
  'mutation { createPost(title: "x") { id title } }',
  'fragment F on Post { id title } { Posts { ...F } }',
  '{ __schema { types { name } } }',
  // invalid for the specified rules
  '{ Posts { id unknownField } }',
  'query ($x: UnknownType) { Posts { id } }',
  '{ Post { id } }',
  'query ($unused: Int) { Posts { id } }',
  'fragment A on Post { ...B } fragment B on Post { ...A } { Posts { ...A } }',
  'query A { Posts { id } } query A { Posts { title } }',
  '{ Posts(limit: "ten") { id } }',
  '{ Posts { id } } { Posts { title } }',
]

const variableSets: (Record<string, unknown> | undefined)[] = [
  undefined,
  { limit: 1 },
  { limit: 30 },
  { deep: false, limit: 2 },
  { deep: true, limit: 2 },
  { deep: true, limit: 1 },
  { id: '1' },
]

const serialize = (errors: readonly GraphQLError[]) => JSON.stringify(errors.map((e) => e.toJSON()))

/** The errors as JSON, or what was thrown (upstream's complexity rule overflows on fragment cycles). */
const outcome = (validateRun: () => readonly GraphQLError[]) => {
  try {
    return serialize(validateRun())
  } catch (error) {
    return `threw ${(error as Error).name}: ${(error as Error).message}`
  }
}

const implementations = {
  next: nextDocumentCache,
  'tanstack-start': createDocumentCache({ parse, validate }),
}

describe.each(Object.entries(implementations))(
  'GraphQL document cache (%s) vs uncached graphql-js',
  (_, { concatRules, parseWithCache, validateWithCache }) => {
    it('should validate like uncached graphql-js for every query, variables and rule set', () => {
      let compared = 0
      for (let round = 0; round < 3; round++) {
        for (const isCustomRule of [false, true]) {
          for (const variables of variableSets) {
            for (const query of queries) {
              const cached = outcome(() =>
                validateWithCache(
                  schema,
                  parseWithCache(query),
                  concatRules({
                    additionalRules: additionalRules({ isCustomRule, variables }),
                    defaultRules: specifiedRules,
                  }),
                ),
              )
              const reference = outcome(() =>
                validate(
                  schema,
                  parse(query),
                  specifiedRules.concat(additionalRules({ isCustomRule, variables })),
                ),
              )

              expect(cached).toBe(reference)
              compared++
            }
          }
        }
      }

      expect(compared).toBe(3 * 2 * variableSets.length * queries.length)
    })

    it('should report complexity errors that depend on the variables', () => {
      const query = 'query ($limit: Int) { Posts(limit: $limit) { id title } }'
      const errorsFor = (limit: number) =>
        validateWithCache(
          schema,
          parseWithCache(query),
          concatRules({
            additionalRules: additionalRules({ isCustomRule: false, variables: { limit } }),
            defaultRules: specifiedRules,
          }),
        ).map((error) => error.message)

      expect(errorsFor(5)).toEqual([])
      expect(errorsFor(500)).toEqual([
        'The query exceeds the maximum complexity of 200. Actual complexity is 1000',
      ])
      expect(errorsFor(5)).toEqual([])
    })

    it('should validate rule lists not built by concatRules with every rule', () => {
      const query = '{ Posts { id unknownField } }'
      const rules = specifiedRules.concat(additionalRules({ isCustomRule: true }))

      expect(serialize(validateWithCache(schema, parseWithCache(query), rules))).toBe(
        serialize(validate(schema, parse(query), rules)),
      )
    })

    it('should return one document per query string and parse failing queries every time', () => {
      const query = '{ Posts { id } }'

      expect(parseWithCache(query)).toBe(parseWithCache(query))
      expect(JSON.stringify(parseWithCache(query))).toBe(JSON.stringify(parse(query)))

      const failures = [0, 1].map(() => {
        try {
          parseWithCache('{ Posts { id }')
        } catch (error) {
          return error as GraphQLError
        }
        return undefined
      })

      expect(failures[0]).toBeInstanceOf(GraphQLError)
      expect(failures[0]).not.toBe(failures[1])
      expect(failures[0]?.message).toBe(failures[1]?.message)
    })

    it('should keep documents equal to a fresh parse past the cache bound', () => {
      const many = Array.from({ length: 1500 }, (_, index) => `{ Posts(limit: ${index}) { id } }`)
      for (const query of [...many, ...many]) {
        expect(JSON.stringify(parseWithCache(query))).toBe(JSON.stringify(parse(query)))
      }
    })
  },
)
