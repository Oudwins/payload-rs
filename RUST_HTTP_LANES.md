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

Implemented as a test-only wrapper (test/__rs/http-lanes/shadow.ts, routed in by the vite plugin
of test/__rs/http-lanes, SQLite runs through `vitest.sqlite.config.ts`): every request the byte lane
serves also runs the handler's exact path; status, the header list (names, values, order) and the
body bytes must be equal, and the exact response is returned. `PAYLOAD_RS_HTTP_SHADOW_REPORT`
collects `bytes:hit:<operation>`, `bytes:exact:<operation>` and `bytes:divergence` events;
`summarize.mjs --bytes` fails on a divergence or when no request was served. The fused lane's own
counters (`PAYLOAD_RS_FUSE_STATS_DIR`) give `count:text` / `find:text` / `findByID:text` hits and
the guard reasons of the requests it did not serve.

### 3.7 Projections (not measured; sums of measured parts)

| request (MongoDB, typical) | TS before | after step 1 (measured) | with fused lanes + bytes + speculative auth |
| -------------------------- | --------- | ----------------------- | ------------------------------------------- |
| `GET /posts/:id`           | 3.49 ms   | 2.93 ms                 | ~0.35-0.45 ms                               |
| `GET /posts limit 100`     | 10.70 ms  | 9.39 ms                 | ~1.3-1.6 ms                                 |
| GraphQL `Posts` limit 10   | 3.57 ms   | 2.69 ms                 | ~0.5-0.7 ms                                 |

## 4. Status of step 2 (round 3)

- **REST byte lanes: implemented** in upstream's default `find` / `findByID` / `count` handlers
  (`packages/payload/src/collections/endpoints/fusedResponse.ts`). `globals/endpoints` is not wired:
  `fusedOperationText` returns `undefined` for `findGlobal` so far.
- **Access.** The fused lane serves `overrideAccess: false` calls only through compiled access, which
  it does not implement yet (`fuse/compiled.ts` `isCompiledAccess` is `false`; access is checked per
  config, not per call). The handler decides read access itself when that runs no user code:
  Payload's own `defaultAccess` (pure), or a function the compiler accepted, evaluated as IR on the
  arguments `executeAccess` would pass (D5; not while `PAYLOAD_FN_COMPILE_GUARD` verifies call
  sites). Only a result of exactly `true` takes the lane, and only when every other effect of
  `overrideAccess: false` is a no-op for the request: no field read access, `where` and the effective
  sort on top-level non-relationship fields (not `hash` / `salt`), no `joins`. The lane then runs
  with `overrideAccess: true`; anything else (a `Where` result, a bail) runs the handler's exact path,
  which calls the access function as before. When the fused lane gets per-call compiled access, this
  pre-decision can go.
- **Coverage today: SQLite only** (the only fused backend). MongoDB and PostgreSQL requests run the
  exact path, plus the lane's guards (a few microseconds). On SQLite, A's v1 guards decide most
  misses: `populate` (REST's default depth with relationship fields; the perf scenarios that pass
  `depth: 0` are served), field read access, `transaction`.
- **Auth user lookup (task 2):** the JWT strategy's `payload.findByID` already goes through the
  fused lane (`fuseFindByID`, a web-`Request` req passes A's guard): on SQLite every lookup of the
  perf user is served (0.09 ms local, the strategy 0.12 ms). MongoDB / PostgreSQL need a fused
  backend.
- **Speculative auth (C1, accepted): not implemented.** It needs an asynchronous fused backend. On
  SQLite both reads are synchronous native calls on the JS thread, so they cannot overlap; on
  MongoDB / PostgreSQL there is no fused read to overlap with. It becomes worthwhile with B's
  MongoDB lane or a PostgreSQL backend (design in 3.4).
- **GraphQL plans (3.5): not implemented.** They meet the same two limits (access with
  `overrideAccess: false` through the resolvers, population) and need a selection-to-select
  compiler.
- **tanstack-start:** the GraphQL handler change of step 1 (one graphql-http handler per schema,
  the document cache as a factory over the dynamically loaded `graphql`).

Verification (2026-11-23, the 31 REST / GraphQL suite files of WP C): MongoDB, SQLite and
PostgreSQL, default engine and `--engine ts`, all 31/31 equal to the TS baselines; the SQLite byte
shadow 31/31 equal to the baseline with 10 served requests (`count` 2, `findByID` 8) and 0
divergences (status, headers, body bytes); the unit differentials (JWT, both document caches) 16/16.

Decisions taken (owner, 2026-11-23): C1 accepted, C2 accepted, C3 assigned to WP C.

## 5. MongoDB request path (2026-11-24, default engine: Rust core + B's driver lane)

Profiled with `--cpu-prof` in the perf bench (`PAYLOAD_ENGINE` unset, typical shape, 1k posts):
REST `GET /posts limit 10` costs 1.06 ms of JS-thread time per request, against 0.42 ms for the
same Local `find`. Per request (µs of JS thread):

| area                                                                                                          | µs  |
| ------------------------------------------------------------------------------------------------------------- | --- |
| engine-rs ops / runtime JS (afterRead plans, host helpers)                                                    | 164 |
| B's driver lane JS (`outcome`: `JSON.parse` of the result text, ~48; `lanePaginate`, `laneFindOne`)           | 163 |
| resumed Rust core tasks (`awaitValue`)                                                                        | 132 |
| undici: `Response.json`'s stringify ~43, the bench client's `response.json()` ~53, Request / Headers          | 166 |
| mongoose / mongodb / bson (query building still goes through mongoose `Query` in the lane)                    | 92  |
| payload `afterRead` field code (relationship population promises)                                             | 54  |
| payload request build and routing (`createPayloadRequestFromWebRequest`, `handleEndpoints`, `formatAdminURL`) | 46  |
| fused-lane guards (`prepare`: once for the byte lane, once in the operation)                                  | 33  |
| JWT strategy (after the memo below)                                                                           | 14  |

Before the changes below, two of WP C's own pieces were the largest request-path costs outside the
engine: the byte lane's read-access pre-decision (~150 µs per REST read: `evaluateCompiled` snapshots
the whole access argument, `req` included, and it ran on MongoDB, where the lane cannot serve yet)
and the JWT check (~48 µs under load).

- **Byte lanes decide access only for calls the lane served** (the structural checks stay first;
  the lane runs with `overrideAccess: true` only when they pass, and its text is dropped unless the
  access is exactly `true`). A served fused read runs no JS, so nothing observable changes; requests
  the lane cannot serve pay no access evaluation.
- **The JWT strategy remembers verified signatures** per (secret, token): the decoded header and
  claims text of tokens whose HMAC verified (at most 1,000 per secret, only tokens signed with the
  secret). Objects are parsed per call and the time claims checked per call.

**Throughput.** Every throughput scenario runs at an event-loop utilization of 1.00 at both x8 and
x64, on both engines, and requests per second equal 1000 / (JS-thread ms per request) (typical
`findByID` rs: 0.170 ms, 5,880 predicted, 5,886 measured). The limit is the JS thread from
concurrency 8 on: not the mongoose pool (an exhausted pool leaves the loop idle) and not the
database. Napi crossings count as JS-thread time (they run on it). Throughput therefore moves with
JS-thread time per request only: REST `GET /posts limit 10` x64 went from 862 to 1,117 req/s
(2.00x -> 2.48x TS) with the two changes above.

**Measured** (perf suite, MongoDB, typical + complex, 1k posts; TS median / Rust median per
scenario, geometric means per category; before = b1527366, after = the two changes above, same
machine state, nothing else changed):

| surface | category         | n   | before | after  |
| ------- | ---------------- | --- | ------ | ------ |
| REST    | all              | 69  | 1.033x | 1.075x |
| REST    | read             | 14  | 1.107x | 1.249x |
| REST    | uploads          | 4   | 0.946x | 1.169x |
| REST    | delete           | 4   | 0.773x | 0.878x |
| REST    | custom-endpoints | 12  | 1.191x | 1.208x |
| GraphQL | all              | 24  | 1.081x | 1.158x |
| GraphQL | read             | 10  | 1.282x | 1.295x |
| GraphQL | auth             | 2   | 1.184x | 1.281x |
| GraphQL | globals          | 4   | 0.972x | 1.108x |

Throughput (rs, typical): REST `GET /posts limit 10` x64 862 -> 1,117 req/s (JS thread per
request 1.160 -> 0.895 ms); Local `find limit 10` x64 2,407 -> 2,654 req/s; `findByID` x64 5,886
(unchanged: no HTTP layer). Write categories (create, update, partial-update) move within run noise
(0.88-0.96x on both sides); the changes do not touch them beyond the shared auth path.

Verification (2026-11-24): full MongoDB harness, default engine, 135 files: 3329 / 165 / 422 against
the 3330 / 164 / 422 baseline. The one difference is the Redis KV test (no Redis server was running;
it fails the same way with `--engine ts`). Load errors without test differences: storage emulators,
localstack, the hmr Next dev server. CLI test names differ only by the worktree path. Parity goldens
503 / 503; MongoDB adapter shadow (rs candidate) over the 31 REST / GraphQL files: 0 divergences in
the test processes; 2 in the CLI child processes of `plugin-mcp/instructions`, identical at the
base commit without these changes. SQLite byte shadow 31 / 31, 10 served, 0 divergences; HTTP lanes
unit differentials 18 / 18.

**For the fused MongoDB backend (A) and the driver lane (B):**

- The byte lanes (`fusedResponse`) and the auth user lookup (`fuseFindByID`) are backend-agnostic:
  `fusedOperationText` may return a promise, nothing else is needed on WP C's side.
- GraphQL reads cannot take any fused lane today: the resolvers pass
  `isolateObjectProperty(req, [...])`, a `Proxy`, which the fused guard rejects (`req:object`).
  Accepting Payload's own isolation proxies (e.g. registered in a `WeakSet` by
  `isolateObjectProperty`) is the prerequisite for GraphQL plans.
- Calls without `overrideAccess` need per-call compiled access in the lane (`isCompiledAccess` is
  per config today); `evaluateCompiled` with `argKeys: [null]` copies every key of the argument,
  `req` included: an access function that ignores its argument should not snapshot it.
- A cheap "does this `payload.db` have a fused target" export would let the byte lane skip its
  guard pass on databases without a backend (~15 µs per REST read).
- The lane's remaining JS: `JSON.parse` of the result (removed entirely by text results through
  the byte lanes) and mongoose `Query` construction for the filter.
