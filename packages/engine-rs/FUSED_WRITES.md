# Fused MongoDB writes: design (not built)

Status: design for an owner decision, together with D4 (RUST_PERF_PLAN.md section 5). No default
changes. Measurements are from WP-G (2026-11-24, MongoDB 8.2 single-node replica set on loopback,
13th-gen Intel E-cores 22-31, perf configs of test/__rs/perf at 1k posts; medians of 5 processes per
variant, so differences under ~3% are noise).

## 1. Why the current write path cannot beat TS by much

A Local API `update` by id of the `typical` shape is 9.2-9.9 ms on TS. Its command stream is the
same on both engines:

| step                                                                                      | where                             |
| ----------------------------------------------------------------------------------------- | --------------------------------- |
| `find posts` (the stored document, `getLatestCollectionVersion`)                          | in the transaction                |
| `delete payload-locked-documents` (expired locks)                                         | outside (no session)              |
| `findAndModify posts` (`updateOne`, `returnDocument: 'after'`)                            | in the transaction                |
| `insert _posts_versions` (`saveVersion`; v4 enables versions by default, `maxPerDoc` 100) | in the transaction                |
| `find _posts_versions` (`enforceMaxVersions`: `page: max + 1, limit: 1`)                  | in the transaction                |
| `find authors`, `find categories` (depth-2 population of the result)                      | in the transaction                |
| `commitTransaction`                                                                       | 1.4-2.1 ms median, p90 2.3-3.2 ms |

Per update, TS spends ~6.2 ms of JS-thread CPU (mongoose 1.7, Node driver 1.1, js-bson 0.45,
payload core 1.0, deepmerge 0.45, db-mongodb 0.35) and waits ~3 ms on the server. Statements take
0.4-0.8 ms each in the flow (server time plus loopback), the commit 1.5 ms.

What was tried and measured:

- **D4 as I/O only** (`PAYLOAD_MONGO_RUST_TXN=true`, prototype in `mongo-driver/rustTxn.ts`): the
  transaction on the Rust client, mongoose still casting and building documents, every statement's
  command sent through the Rust client. CPU per update 7.05 -> 4.7 ms, but wall time barely moved
  (typical: create 0.88x -> 0.91x of TS, update 0.93x -> 0.94x, delete 0.81x -> 0.95x; bulk update of
  10 documents 1.31x): the JS thread now waits more (each statement crosses to the tokio runtime and
  back, ~0.15 ms more than the Node driver in this flow), which eats the CPU saved.
- **In-transaction reads on the driver lane** (default since 2026-11-24, owner decision: Node
  driver I/O in the session plus the Rust transform) and **upstream's TS query / transform
  functions inside the live write methods** (default since 2026-11-24): together typical create
  0.87x -> 0.95x of TS, update 0.87x -> 0.96-0.99x, delete 0.83x -> 0.94x (7 and 5 processes per
  variant). The rest of the gap is the Rust core's per-operation cost and the live write methods'
  own crossings (upstream's write methods instead: about +2-4%, but test/__rs/mongo-adapter
  requires the live write binding).

These reach TS speed, not beyond it: mongoose casting and documents, the Node driver, the round
trips and the commit stay.

So a multiple needs the write itself off mongoose and off the JS heap: a fused write.

## 2. What a fused write is

A write operation (`create`, `update` / `updateByID`, `delete` / `deleteByID`, `duplicate`,
`restoreVersion`, `updateGlobal`) that runs no user JS runs as one native task, like a fused read
(FUSE_CONTRACT.md):

1. JS captures the arguments once (inert-argument guard of the fused reads) and calls the lane.
2. Rust runs the core operation (the existing `payload-core-ops-write` order of steps) on a Rust
   value tree of `data`: beforeValidate, the default validators, beforeChange, the write transform,
   the version data, population and afterRead, all from per-collection plans.
3. Rust owns the transaction (D4) on the driver lane's client and sends the statements itself.
4. The result comes back as JSON text (one `JSON.parse`), plus the mutation list D2 replays onto the
   caller's `data` where upstream mutates it.

Anything the lane does not model is a bail before the first statement: the call reruns on today's
exact lane with the untouched arguments. A failure after the first statement aborts the Rust
transaction first, then reruns on the exact lane (the abort makes the database state the one before
the call; see section 7 for what else must be undone).

## 3. Eligibility (per collection config, re-checked per call)

Decided once per `collection.config` object, cached in a `WeakMap` with `volatile` triples like the
fused reads, so a hook pushed at runtime sends the call to the exact lane:

- no collection hooks on the operation's path (`beforeOperation`, `beforeValidate`, `beforeChange`,
  `afterChange`, `afterRead`, `afterOperation`, `beforeDelete`, `afterDelete`, `afterError`) and no
  root `hooks.afterError`, unless every function in them is compiled (FN_COMPILE_CONTRACT.md) and
  pure (no `req.payload` calls);
- every field function on the path is Payload's own (section 4) or compiled;
- access: `overrideAccess` truthy, or the access function compiled (query-constraint results are
  where clauses, which the fused read lanes already evaluate);
- not an upload collection (file I/O), not an auth collection for `create` (password hashing and
  verification e-mails: CPU-bound and JS), no `versions.drafts.schedulePublish` (jobs), no join
  fields written, no custom ID type unless its cast is modelled;
- the adapter is the Rust engine's with a driver lane client on a replica set, `payload.db.*` data
  methods and the mongoose models are pristine (the driver lane's `isPristineModel` plus the
  document middleware the write path would hit: `save`, `validate`, `updateOne`, `findOneAndUpdate`,
  `deleteOne`, `deleteMany` hooks; mongoose plugins beyond db-mongodb's own);
- per call: inert arguments, no `req.transactionID` (a transaction user code shares stays on
  mongoose), no `disableTransaction` (or then: the single-statement rule of D6 decides).

## 4. Payload's own functions versus user functions

The sanitized config mixes user functions with functions Payload installs. A fused write has to
know which is which, by identity, without reading source text:

| function                                                                  | installed by                              | registry today                                                |
| ------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| default field validators (`field.validate` wrappers, `() => true` stubs)  | `fields/config/sanitize.ts`               | `defaultFieldValidators` (WeakMap, used by `mergeElision.ts`) |
| array / block row `id`: `defaultValue`, `beforeChange`, `beforeDuplicate` | `fields/baseFields/baseIDField.ts`        | none (one shared object: identity of `baseIDField.hooks.*`)   |
| `createdBy` / `updatedBy` hooks                                           | `fields/baseFields/authorship`            | none                                                          |
| slug field `beforeChange` / `beforeDuplicate`                             | `fields/config/sanitize.ts` (`useAsSlug`) | none                                                          |
| rich text editor hooks (lexical)                                          | `@payloadcms/richtext-lexical`            | the `afterRead` marker of the fused reads only                |
| collection access wrappers (`withBaseAccess`)                             | collection sanitization                   | compiled together with the user function (WP D)               |

Proposal: one internal registry module in payload, `payload/src/utilities/payloadOwnFunctions.ts`,
a `WeakMap<Function, { kind, port }>` filled where Payload creates the function (the sites above;
lexical registers its hooks and the node types whose features have no hooks). `port` names the Rust
implementation the fused lane uses (`'idDefault'`, `'idBeforeChange'`, `'createdBy'`,
`'slugify(<options>)'`, `'validate:<type>'`, ...). It is additive and not user-facing (D10-style
internal state, no config change). Everything not in it and not compiled by WP D (`isCompiled(fn)`,
looked up at call time) is user JS and makes the call ineligible.

WP D covers user access functions, hooks and validators that compile (`() => true`, role checks,
owner constraints, trims and slugifies); hooks stamping dates (`new Date()`) do not compile (the
guard cannot compare a clock) and stay on the exact lane unless the registry gives Payload's own
date-stamping hooks a port that reads the operation's single clock reading.

## 5. Casting and document building in Rust

Today mongoose does this on the JS heap: `new Model(data)` (schema casting, `_id`, defaults,
`minimize: false`, `timestamps: false`), `doc.validate()` (cast errors become a `ValidationError`
that db-mongodb's `handleError` turns into Payload's), `doc.toObject()` / `$toObject` for the insert,
and `castUpdate` / `_castConditions` for `findOneAndUpdate`, `updateMany`, `deleteMany`.

The fused lane needs a Rust port of exactly that, driven by a per-collection **write plan** built
from the mongoose schema db-mongodb builds (`buildSchema`: the schema's paths, their SchemaType
classes and options), not from the Payload config, so it follows whatever mongoose would do:

- casting per SchemaType: `String`, `Number` (incl. strings that parse), `Boolean` (mongoose's
  truthy / falsy string sets), `Date` (ISO strings, numbers), `ObjectId` (24-hex strings, 12-byte
  values; anything else is a cast error), `Decimal128`, `Buffer`, `Mixed` (as is), arrays and
  subdocument arrays (row `_id: false` as db-mongodb sets it), nested paths, `enum` is not enforced
  by db-mongodb schemas (Payload validates);
- documents: key order of `$toObject` (schema path order for set paths, then `_id` placement the
  way mongoose inserts it), `minimize: false` keeps `{}`, `undefined` values dropped, `null` kept;
- the write transform of db-mongodb (`transform({ operation: 'write' })`: relationship ids to
  ObjectIds, `$inc` / `$push` / `$addToSet` / `$pull` extraction) on the Rust value tree (the read
  transform is already ported for the driver lane);
- errors: a cast error is a bail (the exact lane produces mongoose's `ValidationError` text), a
  duplicate key (`E11000`) is a bail after the abort (the exact lane reproduces `handleError`'s
  `ValidationError` with the field path).

The read side after the write (the `findAndModify` result, population) is the driver lane's
existing Rust transform plus the fused read core's afterRead / population.

## 6. The version write and the max-versions check

v4 enables versions on every collection (`maxPerDoc` 100 by default), so every create / update is
at least two writes plus a read. Upstream order (saveVersion, enforceMaxVersions):

1. main statement (`insert` / `findAndModify`),
2. `insert` into `_<slug>_versions` (version data = the stored document after the main write, with
   `latest: true`, `parent`, `createdAt` / `updatedAt` of one clock reading), then `updateMany`
   unsetting `latest` on older versions of the parent (createVersion.ts),
3. `find _<slug>_versions` with `sort: -updatedAt, skip: max, limit: 1`; when it returns a document,
   `deleteMany` of the versions at or before its `updatedAt`.

In a fused write, inside the Rust transaction:

- 1 and 2 cannot merge into one command (different collections), but they can be pipelined: the
  version document is fully determined by the main statement's result, and both run in one
  transaction, so the version insert can be sent as soon as the main result is back without a JS
  turn (saves one JS round trip, not a server round trip);
- for a `create` whose `_id` was generated by the lane (not a custom ID, not `allowIDOnCreate`), the
  parent has no versions before this transaction, so step 3 cannot find a document while `max >= 1`
  and can be skipped (proof obligation: generated ObjectIds are unique; a raw-inserted orphan
  version with that parent is impossible). For updates step 3 stays (it is one indexed read);
- the latest-flip `updateMany` stays (its filter is the parent and `_id: { $ne }`).

## 7. Rust-owned transactions (D4)

- One `ClientSession` per fused write on the driver lane's client, started lazily with the first
  statement (prototype: `crates/payload-mongo-driver/src/client.rs` `txn_begin` / `txn_command` /
  `txn_end`); `transactionOptions` mapped like the client options; commit with the client's write
  concern (server default `majority`), the driver's commit retry, abort on any failure.
- Invisible to user code by construction: eligibility excludes every path where user JS could see
  `req.transactionID` or `payload.db.sessions`. The prototype's stand-in in `payload.db.sessions`
  is not needed in the fused lane (no JS runs inside).
- Statements of one transaction run one at a time (one session); population reads that upstream
  issues concurrently (dataloader batches) are sequential inside it, which costs nothing measurable
  (they are sequential in upstream's flow too, see the timeline in the WP-G report).
- After a failure after the first statement: abort, then rerun on the exact lane. What must be
  replayed or undone besides the database: nothing else may have happened (no JS ran; the clock was
  read once and the rerun reads it again, which upstream also does on a retry).

## 8. Estimated floor per operation (typical, 1k posts)

From the measured parts: statements 0.4-0.8 ms each in the flow (loopback; ~0.25 ms when back to
back), the commit ~1.5 ms, Rust CPU for planning, casting, transforms and JSON a few tens of
microseconds per document, one argument capture and one `JSON.parse` on the JS thread (~0.05 ms).

| operation (typical)   | TS today | statements in the transaction                                                              | fused floor | expected  |
| --------------------- | -------- | ------------------------------------------------------------------------------------------ | ----------- | --------- |
| update by id (scalar) | ~9.3 ms  | find, findAndModify, insert, find, 2 population finds + lock delete outside                | ~4.0-5.5 ms | ~1.7-2.3x |
| create                | ~7.5 ms  | insert, insert, (find skipped), 2 population finds                                         | ~3.0-4.5 ms | ~1.7-2.5x |
| delete by id          | ~6.3 ms  | find, delete versions, findAndModify, delete preferences, 2 population finds + lock delete | ~4.0-5.0 ms | ~1.3-1.6x |
| update many (10)      | ~50 ms   | per document as above                                                                      | ~20-25 ms   | ~2-2.5x   |

The commit is ~30% of every fused floor; only a server with cheaper durable commits (or
`writeConcern` changes, not allowed) moves it. Throughput gains are larger than latency gains: the
JS thread does ~0.1 ms per write instead of ~6 ms.

## 9. What must be proven equal

The fused write lane needs a lane-shadow mode like the fused reads: every fused write also runs on
the exact lane against a second database, and the following are compared:

- the returned document (key order, types, `-0`, dates as strings) and the error (class, message,
  `data`) for every failure the exact lane produces (validation, cast, duplicate key, not found,
  forbidden);
- the stored documents after the call, raw BSON per collection touched (main collection, versions,
  locked documents, preferences): field order, BSON types (ObjectId vs string, Date vs string,
  Int32 vs Double for numbers mongoose casts), `latest` flags, the version `parent`;
- the command stream where tests read it (test/joins reads `system.profile`; the version and
  max-versions statements; D6 / D4 accepted that sessions and `txnNumber` differ);
- the mutations of the caller's `data` (D2 replay) and of `req.context`;
- hook call counts of Payload's own functions (authorship, slug, row ids) and the values they
  produce;
- clock readings: `createdAt` / `updatedAt` of the document and of its version come from the same
  readings as upstream's (one per upstream `new Date()`);
- the per-SchemaType casting table of section 5 against mongoose, as a differential corpus (every
  field type of test/fields and test/database, including the raw-document tests: unknown keys,
  unknown blocks, localized values as objects);
- concurrency: two fused writes on the same document produce a WriteConflict (TransientTransaction)
  error where upstream does; that error is a bail (the exact lane reruns and reports upstream's).

Plus the existing bars: the upstream MongoDB suite equal to the TS baseline, shadow at 0
divergences, the parity goldens, and hit counters proving the fused lane ran.

## 10. Decisions for the owner

- D4 (Rust-owned transactions) is only worth approving together with fused writes: as I/O only it
  gains 0-15%.
- The internal registry of Payload's own functions (section 4): additive, internal, touches
  payload's sanitization and richtext-lexical.
- Skipping `enforceMaxVersions` for creates with generated ids (section 6): same database effects,
  one statement fewer (a command-stream change like D6).

## 11. Implementation plan (status 2026-11-24)

Done (merged or ready): in-transaction reads on the driver lane, upstream write methods, the
max-versions skip (`PAYLOAD_RS_SKIP_MAX_VERSIONS`), the own-function registry
(`payloadOwnFunctions`), the D4 prototype's transaction API on the Rust client
(`txn_begin` / `txn_command` / `txn_end`), WP-A's fused Mongo reads with population
(`crates/payload-fuse`, `crates/payload-fuse-mongo`, `src/fuse/mongo.ts`, `populate.ts`).

What the first slice (create / updateByID / deleteByID, typical shape) still needs. Unlike the
fused reads, whose core only ports `afterRead`, a fused write needs the write-side traversals on
Rust value trees (`JsVal`); the Rust core's existing ports run on live JS objects through Node-API
and cannot run without JS:

| piece                                                                                                                                                                                                                                                                            | module                                                | reuse                                                                 | size                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| write plan + eligibility (registry, `defaultFieldValidators`, hooks, access, upload / auth, joins)                                                                                                                                                                               | `src/fuse-write/plan.ts`                              | WP-A's `fuse/plan.ts` field plan, `volatile` triples                  | small                                                                               |
| TS dispatch, guards, `PAYLOAD_RS_FUSE_WRITES=off                                                                                                                                                                                                                                 | on                                                    | shadow`, counters                                                     | `src/fuse-write/index.ts`, hook in `ops-write/index.ts` (`runInAdapterTransaction`) | `fuse/inert.ts`, `fuse/stats.ts` | small |
| `beforeValidate` on `JsVal` (static defaults, row ids via the registry, relationship value sanitizing, authorship submitted marks)                                                                                                                                               | `crates/payload-fuse-write/src/before_validate.rs`    | the Rust core's `payload-core-hooks-validate` logic, transliterated   | medium                                                                              |
| default validators on `JsVal` (text / textarea / number / select / date / checkbox / email / relationship / array / group)                                                                                                                                                       | `.../validate.rs`                                     | `payload-core-validate` (already Rust, pure functions where possible) | medium                                                                              |
| lexical `beforeValidate` / validate / `beforeChange` / `afterChange` with default features: bail on node types that have feature hooks or validations (link, upload, relationship nodes), pass the rest                                                                          | `.../lexical.rs`                                      | WP-A's `lx` node lists                                                | medium                                                                              |
| `beforeChange` on `JsVal` (merge with the stored document for updates, locales, timestamps, authorship `setCreatedBy` / `setUpdatedBy`)                                                                                                                                          | `.../before_change.rs`                                | `payload-core-hooks-change` logic                                     | large                                                                               |
| db-mongodb write transform + mongoose casting from the schema's write plan (section 5)                                                                                                                                                                                           | `.../cast.rs` + TS plan from `Model.schema`           | the driver lane's read transform plan format                          | large                                                                               |
| operation drivers: create (insert, version insert + latest flip, max-versions plan flag), updateByID (find stored doc, lock check, findAndModify, version), deleteByID (find, locks, versions, delete, preferences) in one Rust-owned transaction; result afterRead + population | `.../ops.rs` on the driver client                     | `payload-fuse` `after_read`, `populate`; D4 txn API                   | large                                                                               |
| write lane-shadow (section 9): fused lane on database A, exact lane on database B with the same clock / ObjectId readings replayed, raw BSON of every touched collection, result, error                                                                                          | `src/fuse-write/shadow.ts` + `test/__rs/fuse-writes/` | `shadow-mongo/replay.ts`, `trace.ts`                                  | medium                                                                              |

Order: plan + dispatch + shadow harness first (shadow mode compares nothing until a lane serves),
then create on a scalar-only collection with versions (the `minimal` shape: text, number,
relationship, authorship), then updateByID and deleteByID, then the typical shape's arrays, groups,
hasMany relationships, select / date / checkbox and lexical with default features, then
localization, then update-many.

## 12. The write-side steps on Rust values (`crates/payload-fuse-write`, WP-I)

Binding interface between the pure write-side library (WP-I) and the operation drivers, dispatch
and shadow (WP-H). No Node-API, no JS, no I/O: every input is a value, every nondeterministic
reading comes from the caller. Breaking changes are written here first.

### 12.1 The write plan

`buildWritePlan({ collection, payload })` (`packages/engine-rs/src/fuse-write/writePlan.ts`) turns
the sanitized collection config plus db-mongodb's mongoose models (`payload.db.collections[slug]`
and `payload.db.versions[slug]`, read through `Model.schema`) into JSON text, or
`{ plan: null, reason }` when the collection's write path holds anything the library does not
model (that reason is an eligibility reason for WP-H's stats). Build it once per
`collection.config` (immutable after init) and register it once:

```rust
pub fn register_write_plan(json: &str) -> Result<u32, String>;
pub fn write_plan(id: u32) -> Option<Arc<WritePlan>>;
```

The JSON (`v: 1`) holds:

- `slug`, `timestamps`, `versions` (`null` or `{ max }`: `getVersionsMax`), `defaultIDType`,
  `defaultMaxTextLength`, `relations` (`{ [slug]: { customIDType } }` of every collection a
  relationship field reaches, for the validators and the write transform);
- `fields`: `collection.fields` in config order, each with its type, name, `required`, `hasMany`,
  `relationTo`, sub fields, the static `defaultValue` (or `rowId` for the registry's
  `rowIdDefaultValue`), Payload's own hooks by registry kind (`rowIdBeforeChange`,
  `authorshipBeforeValidate` / `authorshipBeforeChange` with their field), the default validator
  by name (`defaultFieldValidators`: the payload-core-validate `Validator`, or `true` for the
  `() => true` stubs) with the field properties that validator reads, and the label (string,
  language map, `false`, or `null` for a function label: an error on that field bails);
- `schema` / `versionSchema`: the mongoose schemas as the casting needs them (12.5): the key order
  of `schema.tree`, every path's SchemaType (`instance`, sub schema of document arrays, static
  `default`), nested paths, `versionKey`, `strict`.

Ineligible (the plan builder returns a reason): user functions anywhere on the write path that are
not in `payloadOwnFunctions` / `defaultFieldValidators` (hooks, `validate`, `defaultValue`,
`access`, `admin.condition`, `filterOptions`), custom ID fields, localization (until step 4),
drafts, upload / auth collections, join fields, blocks (until their discriminators are modelled),
point / json / code / radio / upload fields, rich text other than lexical with default features
(step 3), `timezone` dates, mongoose schema features the casting does not model (setters other
than `_id`'s, discriminators, maps, `Decimal128`, `Buffer`, `BigInt`, non-strict schemas).

### 12.2 The call context

```rust
pub struct WriteCtx<'a> {
  /// `req.user` as authorship reads it: `Some((user.collection, user.id))` when both are set.
  pub user: Option<(String, JsVal)>,
  pub override_access: bool,
  /// `req.context` at the start of the operation (read: `isRestoringVersion`,
  /// `_submittedAuthorshipFields`).
  pub context: &'a JsVal,
  /// `req.t` (payload-core-validate `Translate`) and `req.i18n` (`language`, `fallbackLanguage`):
  /// only used to build a validation error; `None` makes every validation failure a bail.
  pub t: Option<&'a dyn Translate>,
  pub language: &'a str,
  pub fallback_language: &'a [String],
  /// Clock and ObjectId readings (12.3).
  pub entropy: &'a mut dyn Entropy,
}
```

### 12.3 Nondeterminism: clock and ObjectIds

```rust
pub enum IdUse { Row, Document, Version }
pub trait Entropy {
  /// One upstream `new Date()` (ms since the epoch).
  fn now(&mut self) -> f64;
  /// One upstream `new ObjectId()`: `Row` = bson-objectid in `baseIDField` (row ids),
  /// `Document` / `Version` = mongoose's `_id` default (js-bson) of the main / version insert.
  fn object_id(&mut self, used_for: IdUse) -> [u8; 12];
}
pub struct SystemEntropy;            // the live lane: SystemTime + bson's ObjectId::new()
pub struct RecordedEntropy { .. }    // the shadow: replays recorded readings, bails when exhausted
```

The library asks for readings exactly where upstream takes them, in upstream's order, and only
when upstream takes them, so a shadow that records the exact lane's readings (in order, per kind)
replays them one to one:

- create: row ids (beforeValidate `defaultValue`, then beforeChange `value || new ObjectId()`, in
  traversal order), `db.create`'s `createdAt` (only when `data.createdAt` is falsy), the write
  transform's `updatedAt` (only when `undefined`), the document `_id` (`new Model(data)`), then
  with versions `saveVersion`'s `now` and the version `_id`;
- updateByID: row ids, `dataToUpdate.updatedAt`, then with versions `saveVersion`'s `now` and the
  version `_id`.

The lock check (`checkDocumentLockStatus`), `getLatestCollectionVersion`, `enforceMaxVersions`,
population and afterRead stay with WP-H's drivers and take no readings here.

### 12.4 Entry points

```rust
pub fn prepare_create(plan: &WritePlan, data: &JsVal, ctx: &mut WriteCtx) -> Result<Prepared, Bail>;
pub fn prepare_update(plan: &WritePlan, id: &JsVal, data: &JsVal, input: &UpdateInput, ctx: &mut WriteCtx)
  -> Result<Prepared, Bail>;

pub struct UpdateInput {
  /// The stored document as the find returned it (field order as stored).
  pub stored: bson::Document,
  /// `docWithLocales`: `stored` after db-mongodb's read transform (`getLatestCollectionVersion`).
  pub doc_with_locales: JsVal,
  /// `originalDoc`: `afterRead({ depth: 0, doc: deepCopy(docWithLocales), overrideAccess: true,
  /// showHiddenFields: true, ... })` (payload-fuse `after_read`).
  pub original_doc: JsVal,
}

pub struct Prepared {
  /// What upstream does to the caller's objects before it fails or writes (D2 replay):
  /// create: the caller's `data` after `beforeValidate` (upstream mutates it in place);
  /// update: `None` (updateByID deep-copies `data` first).
  pub caller_data: Option<JsVal>,
  /// `req.context` keys upstream sets, in order, with their final values
  /// (`_submittedAuthorshipFields`, `_isNewDoc`).
  pub context_writes: Vec<(String, JsVal)>,
  pub outcome: Result<PreparedWrite, Invalid>,
}

pub struct PreparedWrite {
  /// create: `documents[0]` of `insert <slug>`; update: the `update` of `findAndModify <slug>`
  /// (`{ $set: ... }` after mongoose's `castUpdate`). Key order and BSON types as the Node driver
  /// serializes what mongoose produces (Int32 / Double like js-bson, ObjectId, Date).
  pub doc: bson::Document,
  /// update: the document `findAndModify` returns (`stored` with the `$set` applied).
  pub stored_after: Option<bson::Document>,
  /// With versions: `documents[0]` of `insert _<slug>_versions` and the latest-flip
  /// `updateMany` (`q`, `u`) createVersion sends after it.
  pub version: Option<VersionWrite>,
}
pub struct VersionWrite { pub doc: bson::Document, pub flip_filter: bson::Document, pub flip_update: bson::Document }

/// The `ValidationError` upstream throws from `beforeChange`; WP-H throws
/// `new ValidationError({ id, collection, errors, req }, req.t)` (the message is the class's).
pub struct Invalid { pub collection: String, pub id: Option<JsVal>, pub errors: Vec<FieldError> }
pub struct FieldError { pub label: String, pub message: String, pub path: String }

/// Not modelled for this input: run the exact lane with the untouched arguments.
pub struct Bail(pub String);
```

`data`, `doc_with_locales`, `original_doc` are `JsVal` trees as the fused lanes decode them
(`payload_engine::js`; `Date`s as typed values). A `Bail` is returned before anything is
observable: the library never touches its inputs (it works on its own copies).

### 12.5 What each step ports (status in 12.6)

1. `beforeValidate` (fields/hooks/beforeValidate): `unflattenData`, the per-type value sanitizing
   (number strings, checkbox strings, relationship values, empty rows), fallback values from the
   stored document / static defaults / the registry row id default, authorship's submitted marks,
   group / array traversal with `getExistingRowDoc`.
2. `beforeChange` (fields/hooks/beforeChange): `deepCopyObjectSimple`, `recordNewDoc`, the
   registry's `beforeChange` hooks (row id, `setCreatedBy` / `setUpdatedBy`),
   `hasInvalidFieldValueShape`, the default validators (payload-core-validate on the options
   object upstream builds), error labels (`buildFieldLabel`, `getTranslatedLabel`).
3. The operation's own steps: create `db.create` (`createdAt`), updateByID `{ ...data, id }` and
   `dataToUpdate.updatedAt`, `saveVersion` / `createVersion`'s version data.
4. db-mongodb `transform({ operation: 'write' })`: relationship ids to ObjectIds (custom ID types
   kept), `updatedAt`; data holding `$inc` / `$push` / `$addToSet` / `$pull` / `$remove` bails.
5. mongoose: `new Model(data)` + `$toObject` (strict paths, `getKeysInSchemaOrder`, schema-tree
   order, static defaults, `_id`, `versionKey`, `minimize: false`), `castUpdate` for `$set`
   (reverse key order of the sugar, strict / virtual paths dropped, nested objects cast in place),
   and the SchemaType casts (`String`, `Number`, `Boolean`, `Date` via V8's `Date.parse`,
   `ObjectId`, `Mixed`, document arrays with `_id: false`); a cast error is a bail.
