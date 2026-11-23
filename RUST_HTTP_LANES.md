<!-- WP C (RUST_PERF_PLAN.md S2): fixed per-request cost of REST / GraphQL, and the byte-response contract on top of the fused lanes (packages/engine-rs/FUSE_CONTRACT.md). -->

# HTTP lanes: fixed request cost and byte responses

## 1. Where the fixed cost of a request goes (measured)

MongoDB, typical shape, TS engine, in-process handlers (`REST_GET` / `GRAPHQL_POST` with a JWT), medians
of 3,000 sequential requests on cores 16-21, before step 1:

| part                                                                                         | ms                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| REST request without auth (`createPayloadRequestFromWebRequest`, routing, response)          | 0.07                                       |
| JWT strategy: `jwtVerify` (jose, WebCrypto on the libuv pool)                                | 0.06 CPU, 0.14 more latency (the pool hop) |
| JWT strategy: `payload.findByID` of the user (every request)                                 | 0.38-0.41                                  |
| GraphQL: `parse` + `validate` (`KnownTypeNamesRule` copies the type map per request)         | ~0.5-0.6                                   |
| GraphQL: the rest (complexity rule, `request.clone()`, double body parse, double `Response`) | ~0.1                                       |

The URL, `qs`, i18n (`initI18n` is memoized), cookies and CORS are a few microseconds each: moving
request parsing to Rust (as S2 first proposed) would gain under 0.05 ms. The cost that matters is in
the auth read and in the operation itself.

## 2. Step 1 (implemented, exact, both engines)

- **GraphQL document cache** (`packages/next/src/routes/graphql/documentCache.ts`): the
  `graphql-http` handler is built once per schema (`getGraphql`'s result, per-request state in a
  `WeakMap` keyed by the `Request` graphql-http hands back as `request.raw`); `parse` is memoized per
  query string (bounded, 1,000 entries; parse errors are not cached); graphql's specified rules are
  memoized per (schema, default rule list, document) as a pass / fail bit. A document that passes
  them is validated per request with the additional rules only (query complexity, which reads the
  variables, the introspection rule, `config.graphQL.validationRules`), which gives the same errors
  in the same order (the specified rules report nothing; rules share only the read-only type info).
  A document that fails them, or a rule list not built by the handler, is validated with every rule
  as before.
- **Synchronous HS256 verification** (`packages/payload/src/auth/strategies/verifyJWTSync.ts`):
  decides only tokens jose would accept (compact, `alg: HS256`, no `crit`, the signature string equal
  to the canonical base64url HMAC, header and claims decoded with jose's own base64url decoder, a
  fatal UTF-8 decoder, `JSON.parse`, plain-object checks, `iat` / `nbf` / `exp` as jose checks them
  without options). Everything else (other algorithms, non-canonical encodings, invalid signatures,
  failing claims) goes to `jwtVerify` exactly as before. The strategy swallows every verification
  error, so the observable outcome is only "accepted with this payload" or not.
- **Endpoint matchers** (`handleEndpoints`): path-to-regexp matchers compiled once per path string
  (the regexps have no `g` flag: pure), instead of once per endpoint per request.

Verification: `test/__rs/http-lanes` (unit differentials against jose / graphql-js; a vite plugin
that routes the three fast paths through shadow wrappers comparing each call with the exact
reference, with hit counters).

## 3. Step 2: byte responses (design and contract)

Goal: for a fused operation (FUSE_CONTRACT.md), the response body is the native JSON text; JS never
materializes the result. For `find` limit 100 this removes `JSON.parse` (~0.57 ms) and
`JSON.stringify` (~0.77 ms) per request on top of what the fused lane saves.

### 3.1 Canonical text (addition to FUSE_CONTRACT.md section 5)

A request flag `"canonical": true` asks the core for text that satisfies

    text === JSON.stringify(JSON.parse(text))

byte for byte (the body upstream would send is `JSON.stringify(result)` via `Response.json`). Rules
beyond the current materialization rules:

- no whitespace; keys in JavaScript property order: integer-like keys (`"0"`.. `"4294967294"`)
  first in ascending numeric order, then the rest in insertion order (what `JSON.parse` +
  `JSON.stringify` produce);
- numbers as ECMAScript `Number::toString`: shortest round trip, `1e+21` from 1e21 up, `1e-7` below
  1e-6, `-0` written as `0` (the fused JS-materialized lane writes `-0`: the two modes differ here);
- strings escaped like `JSON.stringify` (well-formed): `\"`, `\\`, `\b` `\f` `\n` `\r` `\t`, other
  code points below U+0020 as `\u00xx` (lowercase hex), lone surrogates as `\udxxx` (lowercase),
  everything else raw (including `/`, U+2028, U+2029 and non-ASCII);
- a value `JSON.stringify` would drop or change (own `undefined`, functions, `NaN`, `Infinity`,
  `toJSON` objects, bigint) is a bail, as today.

### 3.2 TS entry

`packages/engine-rs/src/fuse` exports (A owns it; C calls it):

```ts
/** The final JSON text of the operation's result when the fused lane serves the call, else undefined. */
fusedOperationText(args: { operation: 'count' | 'find' | 'findByID' | 'findGlobal'; operationArgs: ... }): Promise<string | undefined> | string | undefined
```

`undefined` means "not served" (ineligible, guard failed, bail) and has run nothing observable;
the caller then runs the exact operation as today. The function applies the same guards as the
JS-materialized fused lane, plus one HTTP-specific relaxation: a `PayloadRequest` built from a web
`Request` (a `Request` instance with Payload's properties assigned by
`createPayloadRequestFromWebRequest`) passes the inertness guard when the properties the
reduction reads (`locale`, `fallbackLocale`, `payloadAPI`, `transactionID`, `user`, `query`) are own
data properties holding inert values. Today's guard (plain objects only) rejects every HTTP request.

### 3.3 REST

In upstream's default handlers only (a user-replaced endpoint handler is untouched):
`collections/endpoints/{find,findByID,count}.ts`, `globals/endpoints/findOne.ts`.

```ts
const params = parseParams(req.query)            // unchanged: it mutates req.query in place
const text = await fusedOperationText({ ... })   // same arguments the exact call gets
if (text !== undefined) {
  const headers = headersWithCors({ headers: new Headers(), req })
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return new Response(text, { headers, status: httpStatus.OK })
}
// exact path as today
```

This is `Response.json`'s header semantics (content type added only when absent). `handleEndpoints`
keeps re-wrapping the body stream (`new Response(response.body, ...)`), so the HTTP framing users
see (a stream body: chunked transfer, no `Content-Length`) stays as upstream's. Errors never reach
the lane: any anomaly is a bail and the exact path produces upstream's error, `afterError` hooks
included.

### 3.4 Speculative auth

Today a request runs the user read (`payload.findByID` in the JWT strategy), then the operation:
two sequential round trips. When

- the auth strategies are exactly `[local-jwt]`, the token was decided by `verifyJWTSync` (so the
  user id and collection are known synchronously), and the user `findByID` is itself fused-eligible;
- the operation's access result depends only on whether a user exists (no access function, the
  default `Boolean(user)`, or a compiled function whose IR reads no other user field, WP D),

the user read and the main read are issued concurrently and the main result is discarded unless
the user read returns a user that passes the strategy's checks (`_verified`, session id). Latency
becomes max(user read, main read) instead of their sum (~0.15-0.4 ms per request). **Owner decision
needed (C1):** the two reads belong to two operations of one request (the strategy's and the
handler's); their order on the wire changes. Nothing inside either operation changes.

### 3.5 GraphQL

The document cache gives a stable `DocumentNode` per query string, so a plan can be compiled once
per (schema, document, operationName) and cached in a `WeakMap` on the document:

- v1 shape: one operation, `query`, one root field that is a collection `find` / `findByID` or a
  global `findOne` resolver Payload built (identity check on the schema field's `resolve`), no
  fragments on unions (polymorphic relationships), no directives other than `@include` / `@skip` on
  variables (decided per request), no `__typename` on unions;
- the selection set gives the `select` (what `buildSelectForCollection*` derives) and the output
  shape; the core emits `{"data":{"<alias>":...}}` with graphql-js's completion semantics: field
  order of the selection set, aliases, scalar serialization (`String` coerces numbers, `Int` / `Float`
  range checks, Payload's `JSON` and `DateTime` scalars, enum values through the schema's
  `GraphQLEnumType` value -> name map), `null` for missing nullable fields; a non-null violation,
  any resolver error or a partial result is a bail;
- arguments are coerced by graphql-js as today (`getArgumentValues` against the cached document and
  the request's variables), then passed to the fused call exactly as the resolver passes them
  (`draft`, `sort.split(',')`, `locale`, `fallbackLocale`, `pagination`, ...);
- `payload.extensions` set to a function (it receives the result object) or any `afterError` hook
  when errors are possible: not eligible.

Request parsing and validation (cached) still run per request in graphql-http before the plan, so
their errors stay exact. The plan runs as graphql-http's `execute` option (`args => plan ?
lane(args) : execute(args)`); a bail calls graphql-js's `execute` with the same `args`. To keep the
body bytes, the lane's result does not go through `makeResponse`'s `JSON.stringify` (`JSON.rawJSON`
only takes primitives): Payload's `onOperation` returns graphql-http's response tuple itself,
`[`{"data":${text}}`, { headers: { 'content-type': <accepted media type> }, status: 200, statusText:
'OK' }]`, exactly what `makeResponse` builds for a result without errors (the accepted media type is
computed from the `Accept` header with graphql-http's algorithm, or recorded by a `parseRequestParams`
wrapper).

### 3.6 Shadow and counters

`PAYLOAD_RS_HTTP_LANES=shadow` (verification only): every request served by a byte lane also runs
the exact path; compared are status, the sorted header list and the body bytes; counters
`hits[route]`, `bails[reason]`, `diffs` like FUSE_CONTRACT.md section 7 (`PAYLOAD_RS_HTTP_STATS_DIR`).
A suite run proves the lane ran by non-zero `hits` per file.

### 3.7 Projections (not measured; sums of measured parts)

| request (MongoDB, typical) | TS before | after step 1 (measured) | with fused lanes + bytes + speculative auth |
| -------------------------- | --------- | ----------------------- | ------------------------------------------- |
| `GET /posts/:id`           | 3.49 ms   | 2.93 ms                 | ~0.35-0.45 ms                               |
| `GET /posts limit 100`     | 10.70 ms  | 9.39 ms                 | ~1.3-1.6 ms                                 |
| GraphQL `Posts` limit 10   | 3.57 ms   | 2.69 ms                 | ~0.5-0.7 ms                                 |

## 4. Decisions needed

- **C1** speculative auth (3.4): concurrent user and main reads.
- **C2** a second HS256 verification implementation in the JWT strategy (2): security-relevant
  code that duplicates jose's checks for the tokens Payload issues; jose stays the authority for
  everything else.
- **C3** byte lanes live in upstream's default endpoint handlers (`packages/payload/src/collections/endpoints`,
  `globals/endpoints`): outside WP C's files, so the owner (or A) must assign them.
