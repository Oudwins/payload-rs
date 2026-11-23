import type { Payload, PayloadRequest, SanitizedConfig } from 'payload'

import {
  addDataAndFileToRequest,
  addLocalesToRequestFromData,
  createPayloadRequestFromWebRequest,
  headersWithCors,
  logError,
  mergeHeaders,
} from 'payload'

import { createDocumentCache } from './documentCache.js'

const handleError = async ({
  err,
  payload,
  req,
}: {
  err: any
  payload: Payload
  req: PayloadRequest
}): Promise<any> => {
  const status = err.originalError?.status || 500
  let errorMessage = err.message
  logError({ err, payload })

  if (!payload.config.debug && status === 500) {
    errorMessage = 'Something went wrong.'
  }

  let response: any = {
    extensions: {
      name: err?.originalError?.name || undefined,
      data: (err && err.originalError && err.originalError.data) || undefined,
      stack: payload.config.debug ? err.stack : undefined,
      statusCode: status,
    },
    locations: err.locations,
    message: errorMessage,
    path: err.path,
  }

  await payload.config.hooks.afterError?.reduce(async (promise, hook) => {
    await promise

    const result = await hook({
      context: req.context,
      error: err,
      graphqlResult: response,
      req,
    })

    if (result) {
      response = result.graphqlResult || response
    }
  }, Promise.resolve())

  return response
}

let cached: { graphql: any; promise: null | Promise<any> } = { graphql: null, promise: null }

const getGraphql = async (config: Promise<SanitizedConfig> | SanitizedConfig) => {
  if (process.env.NODE_ENV === 'development') {
    cached = { graphql: null, promise: null }
  }

  if (cached.graphql) {
    return cached.graphql
  }

  if (!cached.promise) {
    const resolvedConfig = await config
    const graphqlPackage = '@payloadcms/graphql'
    const { configToSchema } = await import(/* @vite-ignore */ graphqlPackage)
    cached.promise = new Promise((resolve) => {
      const schema = configToSchema(resolvedConfig)
      resolve(cached.graphql || schema)
    })
  }

  try {
    cached.graphql = await cached.promise
  } catch (e) {
    cached.promise = null
    throw e
  }

  return cached.graphql
}

type GraphQLRequestState = {
  context: { headers: Record<string, string>; req: PayloadRequest }
  payload: Payload
  req: PayloadRequest
}

/**
 * Per-request state of the graphql-http handler, keyed on the `Request` the handler receives
 * (graphql-http hands it back as `request.raw`), so one handler serves every request.
 */
const requestStates = new WeakMap<Request, GraphQLRequestState>()

/** graphql-http handlers, built once per schema (`getGraphql`'s result). */
const handlers = new WeakMap<object, (request: Request) => Promise<Response>>()

let documentCache: ReturnType<typeof createDocumentCache> | undefined

const getHandler = async (graphql: any) => {
  const cachedHandler = handlers.get(graphql)

  if (cachedHandler) {
    return cachedHandler
  }

  const graphqlHttpHandlerPath = 'graphql-http/lib/use/fetch'
  const { createHandler } = await import(/* @vite-ignore */ graphqlHttpHandlerPath)

  if (!documentCache) {
    const graphqlPackage = 'graphql'
    const { parse, validate } = await import(/* @vite-ignore */ graphqlPackage)
    documentCache = createDocumentCache({ parse, validate })
  }

  const { concatRules, parseWithCache, validateWithCache } = documentCache
  const { schema, validationRules } = graphql

  const handler: (request: Request) => Promise<Response> = createHandler({
    context: (request: any) => requestStates.get(request.raw)!.context,
    onOperation: async (request: any, args: any, result: any) => {
      const { payload, req } = requestStates.get(request.raw)!
      const response =
        typeof payload.extensions === 'function'
          ? await payload.extensions({
              args,
              req: request,
              result,
            })
          : result
      if (response.errors) {
        const errors = await Promise.all(
          response.errors.map((error: any) => {
            return handleError({ err: error, payload, req })
          }),
        )
        return { ...response, errors }
      }
      return response
    },
    parse: parseWithCache,
    schema,
    validate: validateWithCache,
    validationRules: (_: any, args: any, defaultRules: any) =>
      concatRules({ additionalRules: validationRules(args), defaultRules }),
  })

  // a concurrent first request may have built one meanwhile: keep the first
  const existing = handlers.get(graphql)

  if (existing) {
    return existing
  }

  handlers.set(graphql, handler)

  return handler
}

/**
 * Handles GraphQL HTTP requests for TanStack Start apps.
 * Mirrors the behaviour of `@payloadcms/next`'s GraphQL route handler: the graphql-http handler
 * is built once per schema, documents are parsed once per query string and checked against
 * graphql's specified rules once per document (./documentCache.ts).
 */
export const handleGraphQL = async ({
  config,
  request,
}: {
  config: Promise<SanitizedConfig> | SanitizedConfig
  request: Request
}): Promise<Response> => {
  const originalRequest = request.clone()

  const req = await createPayloadRequestFromWebRequest({
    canSetHeaders: true,
    config,
    request,
  })

  const { payload } = req

  if (payload.config.graphQL?.disable) {
    return new Response(null, {
      status: 404,
    })
  }

  await addDataAndFileToRequest(req)
  addLocalesToRequestFromData(req)

  const graphql = await getGraphql(config)
  const handler = await getHandler(graphql)

  const headers: Record<string, string> = {}
  requestStates.set(originalRequest, { context: { headers, req }, payload, req })
  const apiResponse = await handler(originalRequest)

  const resHeaders = headersWithCors({
    headers: new Headers(apiResponse.headers),
    req,
  })

  for (const key of Object.keys(headers)) {
    resHeaders.append(key, headers[key]!)
  }

  return new Response(apiResponse.body, {
    headers: req.responseHeaders ? mergeHeaders(req.responseHeaders, resHeaders) : resHeaders,
    status: apiResponse.status,
  })
}
