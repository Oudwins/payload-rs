# SQLite engine contract (Rust ⇄ TS)

Binding interface between `crates/payload-sql-engine` + `crates/payload-node/src/engine.rs`
(Rust side) and `packages/engine-rs/src/adapter/**` (TS side). Either side may extend it;
breaking changes must be written here first.

## Selection (no user-facing API change)

- `packages/engine-rs` exports `withRustEngine(adapterObj: DatabaseAdapterObj): DatabaseAdapterObj`.
  It takes the object returned by `@payloadcms/db-sqlite`'s `sqliteAdapter(args)` and returns one
  whose `init` builds the normal TS adapter and then swaps its engine methods for Rust ones.
- `@payloadcms/db-sqlite`'s `sqliteAdapter(args)` returns `withRustEngine(obj)` when
  `process.env.PAYLOAD_ENGINE === 'rs'`, otherwise the upstream TS adapter, unchanged.
- The shadow harness uses `withRustEngine(sqliteAdapter(args))` as its candidate.
- `engine-rs` must never import `@payloadcms/db-sqlite` (avoids a cycle).

## What stays TS (thin glue) vs Rust

- TS keeps: adapter object shape and every non-engine property, `buildDrizzleTable` from the
  Rust raw schema, `drizzle(client, { schema })`, push (`pushDevSchema`), migrations, `execute`,
  `payload.db.drizzle`/`tables`/`client`. The client is `@payloadcms/engine-rs/sqlite`'s
  Rust-backed `createClient`, so drizzle and the engine share worker connections and ordering.
- Rust does: `buildRawSchema` (once, graph retained) and every data method: `find`, `findOne`,
  `findDistinct`, `count`, `create`, `updateOne`, `updateMany`, `upsert`, `deleteOne`,
  `deleteMany`, `findGlobal`, `createGlobal`, `updateGlobal`, `findVersions`, `findGlobalVersions`,
  `countVersions`, `countGlobalVersions`, `createVersion`, `createGlobalVersion`, `updateVersion`,
  `updateGlobalVersion`, `deleteVersions`, `queryDrafts`, `updateJobs`.
  Transactions: begin/commit/rollback stay TS (drizzle session over the Rust client); Rust
  receives the transaction's connection id.

## napi surface (`crates/payload-node/src/engine.rs`)

```ts
class SqliteEngine {
  /** Decodes the graph once and builds the raw schema; both live as long as the engine. */
  static create(
    graphJson: string,
    optionsJson: string,
    callFunction: (id: number, argJson: string) => string,
  ): SqliteEngine
  /** Same JSON as `buildRawSchema` today (rawTables, rawRelations, tableNameMap, ...). */
  rawSchema(): string
  /** Tells the engine which payload-sqlite client/connection ids belong to this adapter. */
  attachClient(clientId: number): void
  /** Runs one adapter method. `connId` is the client's or the active transaction's connection. */
  call(method: string, argsJson: string, connId: number): Promise<string>
}
```

- `graphJson` = `serializeForEngine({ config: payload.config, collections: { [slug]: { config, customIDType } }, blocks: payload.blocks })`.
- `optionsJson` = sqlite adapter options: `idType`, `autoIncrement`, `blocksAsJSON`,
  `localesSuffix`, `relationshipsSuffix`, `versionsSuffix`, `allowIDOnCreate`, `name`,
  `limitedBoundParameters`, plus anything else a module needs (document additions here).
- `argsJson` = `serializeForEngine(args)` with `req` reduced to the fields the drizzle code
  reads (`locale`, `fallbackLocale`, `transactionID` is resolved to `connId` by TS, `payloadAPI`,
  `context` only if read). Values are typed by the serialize format (`$date`, `$bigint`, `$undefined`, ...).
- Result string = `serializeForEngine`-format JSON of the method's return value; TS decodes it
  with `deserializeFromEngine` so `undefined`, Dates etc. come back exactly.
- Errors reject with an Error whose message is JSON `{ name, message, data }`; TS rebuilds the
  Payload error class (`ValidationError`, `APIError`, `QueryError`, `NotFound`,
  `DrizzleQueryError`-shaped errors, `TypeError`, ...) with identical properties.
- JS callbacks the drizzle code makes (`dbName`/`enumName` functions, `payload.db.*` hooks,
  `beforeSchemaInit`/`afterSchemaInit`) go through `callFunction` (sync) or are kept in TS.

## Rust side (`crates/payload-sql-engine`, implemented)

- `SqliteEngine.create` decodes `graphJson` once (typed: `$date`/`$bigint` stay `Date`/`bigint`),
  builds the `RawSchema` with `payload_engine::sql::schema` and keeps both, plus the drizzle
  relational schema derived from them, for the engine's lifetime. Every call borrows that one
  graph, so `InternalBlockTableNameIndex` lookups by block identity are valid.
- `optionsJson` additions: `blockTableNameIndexes: [path: string[], index: number][]` seeds
  `InternalBlockTableNameIndex` values already on block objects (re-init), as napi `buildRawSchema`.
- `rawSchema()` returns exactly the napi `buildRawSchema` JSON (`rawTables`, `rawTableKeys`,
  `rawRelations`, `tableNameMap` as `[key, value]` pairs, `indexes`, `foreignKeys`,
  `fieldConstraints`, `blockTableNameIndexes`, `columnDefaults`).
- `call` queues one job on the `payload-sqlite` queue of `connId` and runs the whole method inside
  it: find statements through libsql's `executeStmt` port (`tx.execute` checks for transaction
  ids), write statements on the same connection. A method is atomic with respect to other calls
  on that database file, exactly like the TS method's awaited statements in call order.
- `attachClient(clientId)`: afterwards `call` rejects a `connId` that is neither the client nor a
  connection on the client's database file (a transaction of it).
- `call(method, argsJson, connId, contextJson?: string)` (see ENGINE_STATUS.md):
  `contextJson = { allowIDOnCreate, limitedBoundParameters, now, blocksAsJSON? }`. The flags are
  the live adapter properties (tests assign `payload.db.allowIDOnCreate = true` after init) and
  win over `optionsJson`; `now` (`Date.now()` of the caller) is used for every "now" stamp
  (`transformForWrite`'s auto `updatedAt`, `upsertRow`'s `createdAt`, the `updateJobs` claim).
  Without `contextJson` the create-time options and the system clock are used. Verified:
  test/database/int.spec.ts under shadow has 0 divergences with the flags, 211 without.
- Caller-visible `data` mutations the glue makes before the call are not repeated:
  `createGlobal` does not set `data.createdAt` (`create` only sets it when falsy, `updateJobs`'
  `delete data.log` is idempotent).
- `argsJson` is decoded with `$date` → ISO string and `$bigint` → number (what the write / query
  modules were verified with). `req` fields read: `req.locale` (`deleteOne`, `deleteMany`).
- Results are the tree encoding of the return value: own `undefined` keys are kept
  (`{ $undefined: true }`, e.g. `limit` of `find` without a limit, `deleteMany`'s `undefined`),
  user objects whose only key is reserved are `$obj`-escaped.
- Error JSON (`payload_sql_engine::error_json`):
  - `{ name: 'DrizzleQueryError', message, query, params, cause }` for every failed statement
    (find or write path): `params` tree-encoded, `cause` a `NativeError`
    (`{ code, kind: 'sqlite', message, rawCode }`, message without the `CODE: ` prefix).
  - `{ name: 'ValidationError', message, data: { id, collection?, errors: [{ path, tableName }], global? } }`
    for unique violations; `errors[].message` is left out so TS fills `req.t('error:valueMustBeUnique')`.
  - `{ name: 'APIError', message, data, status? }` (`status` only when drizzle passes one, e.g. 400).
  - `{ name: 'QueryError', message, data: [{ path }] }`.
  - `{ name: 'LibsqlError', message, data: NativeError }` when the connection of `connId` is gone.
  - JS built-ins (`TypeError`, `RangeError`, `SyntaxError`) and `Error` as `{ name, message, data: null }`.

### Known differences (Rust side)

- **Concurrent calls on one database file are atomic per method.** A TS method's statements
  interleave with other in-flight methods at every `await` (round-robin under `Promise.all`); a
  Rust method runs as one queue job. Final database state is the same; read-backs of concurrent
  writes to the same row can differ. Seen once in the upstream suites: test/queues/int.spec.ts,
  19 concurrent `updateJobs` `$push`es to one job's `log` return fewer log entries than TS.
- **JS-level interception of the client is bypassed.** Engine statements do not go through
  `payload.db.drizzle.$client.execute`, so monkeypatching it (test/database/sqlite-bound-parameters-limit)
  has no effect on data methods.
- **Caller-visible mutation of arguments beyond the glue's list is not reproduced.** TS also
  mutates `data` inside `transformForWrite` (e.g. array row `id`s moved to `_uuid`) and `select`
  (`createVersion` sets `select.updatedAt = true` with drafts); the engine works on a decoded copy.
