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
  /** The live schema after `beforeSchemaInit` / `afterSchemaInit` (call during init, before any `call`). */
  setLiveSchema(descriptionJson: string): void
  /** Tells the engine which payload-sqlite client/connection ids belong to this adapter. */
  attachClient(clientId: number): void
  /** Runs one adapter method. `connId` is the client's or the active transaction's connection. */
  call(method: string, argsJson: string, connId: number, contextJson?: string): Promise<string>
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
  `fieldConstraints`, `blockTableNameIndexes`, `columnDefaults`), plus
  `undefinedProperties: string[][]`: paths below `rawTables` of the own properties upstream holds
  `undefined` in, which JSON drops (the `unique` key of indexes built for fields and compound
  indexes, always their last key). The glue applies them after `JSON.parse`
  (`path.slice(0, -1).reduce((o, k) => o[k], rawTables)[path.at(-1)] = undefined`), which appends
  the key last, as upstream has it. Verified against TS `buildRawSchema` for every
  `test/*/config.ts` (test/__rs/find/engine/rawSchemaUndefined.int.spec.ts).
- `attachClient(clientId)`: afterwards `call` rejects a `connId` that is neither the client nor a
  connection on the client's database file (a transaction of it).

### `call`: statement-granular execution

drizzle's methods `await` every statement; with the `libsql` binding the statement runs
synchronously when it is issued and its promise is already settled, so concurrent operations
interleave statement by statement in microtask order. `call` reproduces this
(`payload_sql_engine::stepped`):

- The method runs on a (pooled) thread of its own and stops after each statement (a _step_). The
  first step runs synchronously inside `call`; each later step runs from a native promise job
  (`resolvedPromise.then(step)`, one microtask, not replaceable by fake timers); the returned
  promise is resolved / rejected synchronously by the step that finishes (no macrotask). While a
  step runs, the JS thread waits (as during a synchronous libsql statement).
- Every statement, find path and write path (payload-sql-upsert's executor) alike, is its own job
  on the `payload-sqlite` queue of `connId`, queued when the method reaches it (so in call order
  with every TS client statement) and run on the connection the id addresses at that moment, like
  `client.execute` / `tx.execute`: a client's `#getDb()` (re-opened after a transaction took the
  previous connection, so a call on the client continues on the new connection when a transaction
  begins between its statements, as in libsql) or the transaction's connection (`tx.execute`'s
  closed check first). Find statements use libsql's `executeStmt` port; write statements use
  rusqlite on the same connection with libsql's error kinds. Nothing is held between statements.
- A step ends after every statement (also a failed one), so every `await` of a statement in the TS
  method (drizzle awaits each one, no `Promise.all`) is a step boundary, including the statements
  of one `upsertRow`.
- `PAYLOAD_RS_ENGINE_ATOMIC=true` (read once by the addon) runs every call as a whole inside
  `call`, on the JS thread, without steps (no interleaving; diagnostics and timing comparisons
  only). JS functions work as in stepped calls. If no thread can be started for a call, it runs
  like that too.
- JS functions the method calls (custom column `fromDriver` / `toDriver`, see `setLiveSchema`) run
  on the JS thread through `callFunction` while the step waits. They may use the clients
  synchronously and may start other engine calls (no statement holds the queue meanwhile).
- `contextJson = { allowIDOnCreate, limitedBoundParameters, now, blocksAsJSON?, withMutations? }`.
  The flags are the live adapter properties (tests assign `payload.db.allowIDOnCreate = true` after
  init) and win over `optionsJson`; `now` (`Date.now()` of the caller) is used for every "now"
  stamp (`transformForWrite`'s auto `updatedAt`, `upsertRow`'s `createdAt`, the `updateJobs`
  claim). Without `contextJson` the create-time options and the system clock are used.
- `withMutations: true`: the result is `{ "result": <tree>, "mutations": [[path, <tree>], ...] }`
  instead of the bare tree: caller-visible mutations of `args` the engine made and the glue does
  not repeat, to apply on the caller's objects (`args[path[0]][path[1]]... = value`) when the
  promise resolves. Reported: `updateGlobal` without a global row (`upsertRow({ operation:
  'create' })`) sets `data.createdAt` when it is falsy: `[["data", "createdAt"], "<ISO now>"]`.
  Without the flag the result is the bare tree (mutations dropped).
- Caller-visible `data` mutations the glue makes before the call are not repeated:
  `createGlobal` does not set `data.createdAt` (`create` only sets it when falsy, `updateJobs`'
  `delete data.log` is idempotent).
- `argsJson` is decoded typed: `$date` is a `Date`, `$bigint` a `bigint`, as the TS method
  receives them (a `Date` for a text field is stored as `JSON.stringify(date)`, an invalid `Date`
  for a date field throws `RangeError`, a `Date` where value binds its time value, a `bigint` one a
  64-bit integer or libsql's `RangeError`). `req` fields read: `req.locale` (`deleteOne`,
  `deleteMany`).
- Results are the tree encoding of the return value: own `undefined` keys are kept
  (`{ $undefined: true }`, e.g. `limit` of `find` without a limit, `deleteMany`'s `undefined`),
  user objects whose only key is reserved are `$obj`-escaped.

### `setLiveSchema(descriptionJson)`

`beforeSchemaInit` / `afterSchemaInit` can add or change tables, columns and relations. After
`executeSchemaHooks({ type: 'afterSchemaInit' })` the glue passes the live schema:

```ts
engine.setLiveSchema(
  JSON.stringify({
    // describeDrizzleSchema (test/__rs/find/harness.ts) of the relational schema drizzle was given:
    // drizzle(client, { schema: adapter.schema }) -> db._.schema / db._.tableNamesMap
    drizzle: describeDrizzleSchema(db._.schema, db._.tableNamesMap),
    // adapter.rawTables after beforeSchemaInit (plain JSON), optional
    rawTables: adapter.rawTables,
  }),
)
```

- `drizzle` (`DrizzleSchema::from_json`, payload-sql-query `drizzle`): `{ [tsName]: { dbName,
  columns: { [key]: { name, columnType, sqlType, primary, mode?, fromDriver?, toDriver? } },
  relations: { [key]: { type: 'one' | 'many' | 'one-no-config', fields?, references?,
  referencedTable, relationName, sourceTable } } } }`. `fromDriver` / `toDriver` are the
  `callFunction` registry ids of a custom column's `mapFrom` / `mapTo`
  (`describeDrizzleSchema(schema, tableNamesMap, register)` with the registry's `register`); they
  are called with the value as a `serializeForEngine` tree, so `callFunction` decodes its argument
  with `deserializeFromEngine`. This is `adapter.tables` for everything drizzle resolves at call
  time: every relational query, every `where` / `sort` column (`getTableColumnFromPath`,
  `buildOrderBy`; values bound through the column's `mapToDriverValue`, custom `toDriver`
  included), every selection (`SQLiteNumericBigInt` → `cast(... as text)`, also in
  `selectDistinct` / `findDistinct`) and every decoded column (`mapResultRow` decodes all selected
  columns in order).
- `rawTables`: replaces the raw tables the write path builds `insert` / `update` / `delete`
  statements and returned columns from (keys and `null` placeholders kept).
- Verified end to end through napi against the TS adapter (schema hooks renaming a raw column and
  replacing drizzle columns with a custom type and a bigint numeric):
  test/__rs/find/engine/engineCalls.int.spec.ts.
- Without `setLiveSchema` the engine uses the schema it derived from its own raw schema (identical
  to the live one when no hook changes it).

### Errors (`payload_sql_engine::error_json`)

- `{ name: 'DrizzleQueryError', message, query, params, cause }` for every failed statement
  (find or write path): `params` tree-encoded, `cause` a `NativeError`
  (`{ code, kind, message, rawCode }`, message without the `CODE: ` prefix) with libsql's kind:
  statements that return rows (`select`, `... returning`) run with `stmt.all()` in libsql, whose
  bind / step errors escape as the raw native error (`kind: 'native'`); prepare errors and errors
  of statements without rows (`stmt.run()`) are `SqliteError`s (`kind: 'sqlite'`).
- `{ name: 'ValidationError', message, data: { id, collection?, errors: [{ path, tableName }], global? } }`
  for unique violations; `errors[].message` is left out so TS fills `req.t('error:valueMustBeUnique')`.
- `{ name: 'APIError', message, data, status? }` (`status` only when drizzle passes one, e.g. 400).
- `{ name: 'QueryError', message, data: [{ path }] }`.
- A statement whose connection is gone (closed client, finished transaction) fails like any other
  driver error: `DrizzleQueryError` whose `cause` is libsql's error.
- JS built-ins (`TypeError`, `RangeError`, `SyntaxError`) and `Error` as `{ name, message, data: null }`.

### Known differences (Rust side)

- **Microtask distances.** A step boundary is one microtask; drizzle and Payload put several
  microtasks between two statements of one method. Concurrent calls of the same method (or of
  methods with the same statement sequence) interleave exactly like TS; a call racing TS code with
  a different number of awaits can be ordered differently.
- **Columns added to drizzle tables only (`afterSchemaInit` `extendTable`) are read, not
  written.** Relational queries, `where` / `sort` columns, selections and decoding use the live
  drizzle schema, but the write path builds `insert` / `update` statements from raw tables
  (`setLiveSchema`'s `rawTables`, i.e. `beforeSchemaInit` changes) and encodes values with the raw
  column types: drizzle would also list the extra columns there and encode values with the drizzle
  column (custom `toDriver`).
- **Blob columns and `bigint` where values on the find path.** Binding a value to a drizzle blob
  column (`Buffer.from(...)`) is an internal error (no `Buffer` value on this side). A `bigint`
  where value of a find statement is bound as a double (exact on the write path's selects, which
  bind it as a 64-bit integer).
- **JS functions as conversion methods.** `Number(x)` / `String(x)` of a where value whose own
  `valueOf` / `toString` is a JS function (JS would call it) is an internal error.
- **JS-level interception of the client is bypassed.** Engine statements do not go through
  `payload.db.drizzle.$client.execute`, so monkeypatching it (test/database/sqlite-bound-parameters-limit)
  has no effect on data methods.
- **Caller-visible mutation of arguments beyond the glue's list and `mutations` is not
  reproduced.** TS also mutates `data` inside `transformForWrite` (e.g. array row `id`s moved to
  `_uuid`) and `select` (`createVersion` sets `select.updatedAt = true` with drafts); the engine
  works on a decoded copy. A mutation made before a later failure of the same call is lost.
