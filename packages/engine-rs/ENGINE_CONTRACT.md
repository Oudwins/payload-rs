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
  /** The live schema after `beforeSchemaInit` / `afterSchemaInit` (calls in progress keep theirs). */
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
- `callFunction` returns `serializeForEngine(result)`; the engine decodes it typed, so a `Date` or
  `bigint` a JS function returns (a custom column's `fromDriver` / `toDriver`, a `$defaultFn`)
  stays one: decoded columns hold it like drizzle returns it, bound values bind it like libsql's
  `valueToSql` (`date.valueOf()` as a double, a `bigint` as a 64-bit integer).

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
  `call`, on a call thread (same stack as stepped calls) without steps (no interleaving;
  diagnostics and timing comparisons only). JS functions work as in stepped calls. If no thread
  can be started for a call, it runs as a whole on the JS thread.
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
- `resultPatches: true` (with `withMutations`): `result` is plain JSON instead of the tree, and the
  values JSON cannot hold are listed by path: `{ "result": <json>, "patches": [[path, <tree>],
  ...], "mutations": [...] }`. Each such value (`undefined`, non-finite numbers, functions,
  `Date`s, `bigint`s, BSON values, a reference to an object from inside itself) is written as
  `null` in `result` and has one patch, in document order: `path` lists object keys (strings)
  and array indexes (numbers) from the root (`[]` is the root itself), `<tree>` is the value's
  tree encoding. Objects with a single reserved key are not `$obj`-escaped. The glue decodes with
  the one `JSON.parse` of the reply and assigns each patch's `deserializeFromEngine(tree)` at its
  path; the result equals `deserializeFromEngine` of the tree encoding (`JSON.parse` keeps key
  order and creates own data properties, `__proto__` keys included; `-0` is written as `-0`).
  `payload_engine::js::write_patched`, tested against the tree encoding in
  `patched_encoding_equals_the_tree_encoding`.
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
  user objects whose only key is reserved are `$obj`-escaped, `-0` is written as `-0`.
- Depth: values read from the database (json columns, which V8's `JSON.parse` reads at any
  depth) are parsed, transformed, encoded and freed without recursion, and
  `deserializeFromEngine` decodes iteratively, so a 100k-level json value comes back like TS
  returns it (test/__rs/find/engine/engineCalls.int.spec.ts, crates/payload-sql-read/tests/
  deep_json.rs, `deep_json_values_are_read_without_recursion` in payload-sql-engine).

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
  columns: { [key]: { name, columnType, sqlType, primary, mode?, fromDriver?, toDriver?,
  hasDefault?, default?, defaultFn?, onUpdateFn?, generated? } }, relations: { [key]: { type:
  'one' | 'many' | 'one-no-config', fields?, references?, referencedTable, relationName,
  sourceTable } } } }`. `fromDriver` / `toDriver` are the `callFunction` registry ids of a custom
  column's `mapFrom` / `mapTo` (`describeDrizzleSchema(schema, tableNamesMap, register)` with the
  registry's `register`); they are called with the value as a `serializeForEngine` tree, so
  `callFunction` decodes its argument with `deserializeFromEngine`. This is `adapter.tables` for
  everything drizzle resolves at call time: every relational query, every `where` / `sort` column
  (`getTableColumnFromPath`, `buildOrderBy`; values bound through the column's
  `mapToDriverValue`, custom `toDriver` included), every selection (`SQLiteNumericBigInt` →
  `cast(... as text)`, also in `selectDistinct` / `findDistinct` and `returning`), every decoded
  column (`mapResultRow` decodes all selected columns in order), and every write: `insert` lists
  the table's columns in drizzle order (`generated: true` ones, `column.shouldDisableInsert()`,
  left out), `update ... set` lists the set columns and those with `onUpdateFn` in drizzle order,
  values go through the column's `mapToDriverValue` (custom `toDriver` included), `returning`
  decodes like `mapResultRow`.
- Column defaults (what `buildInsertQuery` / `buildUpdateSet` use for a column without a value),
  described when `hasDefault` (`column.hasDefault`) is present:
  - `default`: `column.default` when not nullish, `{ sql: { sql, params } }` for drizzle `SQL`
    (`dialect.sqlToQuery`, params as trees) or `{ value: <tree> }` (bound through the column);
  - `defaultFn` / `onUpdateFn`: `callFunction` ids of functions returning, for `column.defaultFn()`
    / `column.onUpdateFn()`, `{ sql: dialect.sqlToQuery(result) }` when the result is `SQL`, else
    `{ value: result }`. Called with `null`, once per row and column, in statement order
    (`onUpdateFn` for every listed column of an `update`, also when `set` has a value, like
    drizzle).
  - Without `hasDefault` the raw column's defaults are used (`default`, `defaultNow`,
    `defaultRandom` / `defaultV7`), `null` for a column without a raw column.
  The harness's `describeDrizzleSchema` (test/__rs/find/harness.ts) produces all of them; the
  glue's `describeLiveSchema` (packages/engine-rs/src/adapter/schema.ts) must add `hasDefault`,
  `default`, `defaultFn`, `onUpdateFn` and `generated` for columns added or replaced by
  `afterSchemaInit` to be inserted with their defaults.
- `rawTables`: replaces the raw tables the write path takes table names, `delete` statements and
  the raw columns' defaults from (keys and `null` placeholders kept).
- `setLiveSchema` can be called at any time: calls in progress finish on the schema they started
  with (like TS calls that captured the previous drizzle instance), later calls use the new one.
- Verified end to end through napi against the TS adapter (schema hooks renaming a raw column,
  replacing drizzle columns with custom types returning `Date`s / `bigint`s and a bigint numeric,
  and adding drizzle-only columns with `default`, `$defaultFn`, `$onUpdate` and SQL defaults; the
  rows left by the writes are compared column by column): test/__rs/find/engine/engineCalls.int.spec.ts.
- Without `setLiveSchema` the engine uses the schema it derived from its own raw schema (identical
  to the live one when no hook changes it).

### Errors (`payload_sql_engine::error_json`)

- `{ name: 'DrizzleQueryError', message, query, params, cause }` for every failed statement
  (find or write path): `params` are the driver values drizzle passed to the client (after
  `mapToDriverValue`: `Date`s, `bigint`s, booleans as they are), tree-encoded; `cause` a
  `NativeError` (`{ code, kind, message, rawCode }`, message without the `CODE: ` prefix) with
  libsql's kind: statements that return rows (`select`, `... returning`) run with `stmt.all()` in
  libsql, whose bind / step errors escape as the raw native error (`kind: 'native'`); prepare
  errors and errors of statements without rows (`stmt.run()`) are `SqliteError`s
  (`kind: 'sqlite'`). The client's `valueToSql` errors (non-finite numbers, `bigint`s beyond 64
  bits: `kind: 'RangeError'`; `undefined`: `kind: 'TypeError'`) and the binding's error for other
  objects (`kind: 'Error'`, after `prepare`) are causes too, raised when the statement is executed.
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
- **Defaults of drizzle-only columns need the glue's description.** Without `hasDefault` in the
  description (the glue's `describeLiveSchema` does not send it yet), a column added by
  `afterSchemaInit` is inserted as `null` instead of its `default` / `$defaultFn` value.
- **Blob encoders.** Binding a value to a `blob({ mode: 'json' | 'bigint' })` column
  (`Buffer.from(...)`) is an internal error (no `Buffer` value on this side); `blob()` /
  `blob({ mode: 'buffer' })` columns have no encoder and bind the value as it is, like drizzle.
- **Deep arguments.** `argsJson` and host function results are parsed with a nesting limit of
  128 (serde_json): data nested deeper (e.g. a json field written with more than ~125 levels)
  fails with an internal error where TS writes it (until V8's own stack limit in
  `JSON.stringify`). Values read from the database have no depth limit (see "Depth").
- **Lone surrogates.** Strings are UTF-8 on this side: a lone UTF-16 surrogate in a parsed json
  value (`"\ud800"`) becomes U+FFFD.
- **JS functions as conversion methods.** `Number(x)` / `String(x)` of a where value whose own
  `valueOf` / `toString` is a JS function (JS would call it) is an internal error.
- **JS-level interception of the client is bypassed.** Engine statements do not go through
  `payload.db.drizzle.$client.execute`, so monkeypatching it (test/database/sqlite-bound-parameters-limit)
  has no effect on data methods.
- **Caller-visible mutation of arguments beyond the glue's list and `mutations` is not
  reproduced.** TS also mutates `data` inside `transformForWrite` (e.g. array row `id`s moved to
  `_uuid`) and `select` (`createVersion` sets `select.updatedAt = true` with drafts); the engine
  works on a decoded copy. A mutation made before a later failure of the same call is lost.
