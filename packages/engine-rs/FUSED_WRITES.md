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

- `slug`, `localization` (`null` or `{ defaultLocale, localeCodes }`), `timestamps`, `versions` (`null` or `{ max }`: `getVersionsMax`), `drafts` (`null` or
  `{ autosave, localizeStatus, validate }` of the sanitized `versions.drafts`; added 2026-11-25 by
  WP-L), `defaultIDType`,
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

Added 2026-11-26 (WP-O): a `tabs` field's `tabs` are field entries of type `tab` (upstream's
`{ ...tab, type: 'tab' }`; a named tab has `n`, `l`, its hooks, `access` and static `d` like any
named field, its label as sanitization leaves it, `toWords(name)` by default); `u` marks a
`unique` field; `json` fields (`t: 'json'`, `val: 'json'`); an `upload` field is written as
`t: 'relationship'` with `val: 'upload'` (upstream's write path treats `relationship || upload`
alike, and the two validators are the same code).

Ineligible (the plan builder returns a reason): user functions anywhere on the write path that are
not in `payloadOwnFunctions` / `defaultFieldValidators` (hooks, `validate`, `defaultValue`,
`access`, `admin.condition`, `filterOptions`) other than the compiled ones of 12.7 (field
`validate`, field `beforeValidate` / `beforeChange` hooks, a relationship's function
`filterOptions`), custom ID fields, `localization.filterAvailableLocales`,
`drafts.schedulePublish`, upload / auth collections, join fields, blocks (until their discriminators are modelled),
point / code fields, a localized unnamed group (`group:unnamed:localized`: the hooks hand its
fields `parentIsLocalized || field.localized`, the transforms' `traverseFields` does not), json
fields whose `jsonSchema` the plan does not convert (`json:jsonSchema:<keyword>`, section 12.6), rich text other than lexical with
default features (step 3), a tab with an `admin.condition`, mongoose schema features the casting does not model (setters other
than `_id`'s, function defaults other than mongoose's own array / document array ones,
discriminators, maps, `Decimal128`, `Buffer`, `BigInt`, non-strict schemas).

### 12.2 The call context

```rust
pub struct WriteCtx<'a> {
  /// `req.user` as authorship reads it: `Some((user.collection, user.id))` when both are set.
  pub user: Option<(String, JsVal)>,
  pub override_access: bool,
  /// `req.context` at the start of the operation (read: `isRestoringVersion`,
  /// `_submittedAuthorshipFields`).
  pub context: &'a JsVal,
  /// `req.locale`: `Some` exactly when the config is localized (`'all'` / `'*'` bail). Added
  /// 2026-11-25 (localization).
  pub locale: Option<&'a str>,
  /// `req.t` (payload-core-validate `Translate`) and `req.i18n` (`language`, `fallbackLanguage`):
  /// only used to build a validation error; `None` makes every validation failure a bail.
  pub t: Option<&'a dyn Translate>,
  pub language: &'a str,
  pub fallback_language: &'a [String],
  /// Clock and ObjectId readings (12.3).
  pub entropy: &'a mut dyn Entropy,
  /// The operation's `draft` / `autosave` arguments (added 2026-11-25, WP-L, drafts): with
  /// drafts `draft` decides `isSavingDraft`; `autosave` is the version's `autosave`.
  pub draft: bool,
  pub autosave: bool,
}
```

### 12.3 Nondeterminism: clock and ObjectIds

```rust
pub enum IdUse { Row, Document, Version }
pub trait Entropy {
  /// One upstream `new Date()` (ms since the epoch).
  fn now(&mut self) -> Result<f64, Bail>;
  /// One upstream `new ObjectId()`: `Row` = bson-objectid in `baseIDField` (row ids),
  /// `Document` / `Version` = mongoose's `_id` default (js-bson) of the main / version insert.
  fn object_id(&mut self, used_for: IdUse) -> Result<[u8; 12], Bail>;
}
pub struct SystemEntropy;            // the live lane: SystemTime + bson's ObjectId::new()
pub struct RecordedEntropy {         // the shadow: replays readings in order; a missing one or a
  pub clock: VecDeque<f64>,          // reading of another kind bails
  pub ids: VecDeque<(IdUse, [u8; 12])>,
}
```

The library asks for readings exactly where upstream takes them, in upstream's order, and only
when upstream takes them, so a shadow that records the exact lane's readings (in order, per kind)
replays them one to one:

- create: row ids (beforeValidate `defaultValue`, then beforeChange `value || new ObjectId()`, in
  upstream's microtask order, which is the order the library's executor reproduces), `db.create`'s
  `createdAt` (only when `data.createdAt` is falsy), the write transform's `updatedAt` (only when
  `undefined`), the document `_id` (`new Model(data)`, a default mongoose applies before the
  setters, so `_id` is the first key), then with versions `saveVersion`'s `now` and the version
  `_id`;
- updateByID: row ids, `dataToUpdate.updatedAt`, then with versions `saveVersion`'s `now` and the
  version `_id`; a draft save (`isSavingDraft`, no `updateOne`) takes no `updatedAt`.

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
  /// update: a draft save (added 2026-11-25, WP-L): no main statement (`doc` empty,
  /// `stored_after` `None`), the version built from beforeChange's result.
  pub draft: bool,
  /// With versions: `documents[0]` of `insert _<slug>_versions` and the latest-flip
  /// `updateMany` (`q`, `u`) createVersion sends after it.
  pub version: Option<VersionWrite>,
}
pub struct VersionWrite { pub doc: bson::Document, pub flip_filter: bson::Document, pub flip_update: bson::Document }

/// The `ValidationError` upstream throws from `beforeChange`; WP-H throws
/// `new ValidationError({ id, collection, errors, global: undefined, req }, req.t)` (the message
/// is the class's; `data` then has upstream's keys, `global` included).
pub struct Invalid { pub collection: String, pub id: Option<JsVal>, pub errors: Vec<FieldError> }
pub struct FieldError { pub label: String, pub message: String, pub path: String }

/// Not modelled for this input: run the exact lane with the untouched arguments.
pub struct Bail(pub String);
```

`data`, `doc_with_locales`, `original_doc` are `JsVal` trees as the fused lanes decode them
(`payload_engine::js`; `Date`s as typed values, ObjectIds as BSON values; `-0` survives the
boundary as `{ "$num": "-0" }`, which `JSON.stringify` alone loses). A `Bail` is returned before
anything is observable: the library never touches its inputs (it works on its own copies).

`flip_update` is empty when mongoose's cast drops every key of `{ $unset: { latest: 1 } }` (no
`latest` path: collections without drafts); mongoose then sends no `update` command at all, so the
driver sends the flip only when `flip_update` is not empty.

Drafts (WP-L, 2026-11-25). `isSavingDraft` is the prepare's: create `draft && drafts`, update
`draft && drafts && data._status !== 'published'` (`publishAllLocales` is then false; the
argument itself is guarded by the dispatch). A draft save first writes `data._status = 'draft'`
(create: into the caller's data, part of `caller_data`), then skips every validation unless
`drafts.validate`. beforeValidate's `onFieldAccess` result for the path `_status` decides
create's `docWithLocalesForFields` (`{}` when reached and allowed, else `{ _status: {} }`, which
also decides `_isNewDoc`). A draft-save update builds the version from beforeChange's result
with `versionData.updatedAt = now` (timestamps) and returns `draft: true`; the version's
`autosave` is `ctx.autosave` (`updateLatestVersion` is not modelled: the dispatch guards
`autosave`). A localized config with drafts whose operation publishes all locales
(`!draft && !(localizeStatus && locale !== 'all')`, i.e. collections without localized fields:
sanitization sets `localizeStatus` exactly when there are) runs upstream's
`validateLocalWithLocaleKeyedData` after beforeChange (WP-O, 2026-11-26): per locale code
(`resolveValidationLocales('all')`), on its own heap, beforeChange's result flattened to that
locale (`flattenDataByLocale`) goes through beforeChange again as runValidationLifecycle runs it
with `skipMutationHooks` (`skipHooks`: no field or editor hooks, so no readings;
`isValidationOperation`: no localized-fallback skip; the operation `create` / `update`, the
pass's `req.locale`; create: `doc` and `docWithLocales` one `{}`; update: `{ ...data, id }`,
`docWithLocales` the operation's as beforeChange left it, `originalDoc` its `originalDoc` for
the request's locale, else `docWithLocales` flattened). A pass without errors is unobservable
(cloned request, context and data); any error bails (`drafts:localizedPublish:invalid`: the
exact lane throws the aggregated, deduplicated `ValidationError`). `validateUniqueConstraints`
reads the database: since WP-W the passes return its `fieldValueExists` lookups (section 13,
WP-W) and a unique compound index bails (`drafts:localizedPublish:uniqueIndex`; before WP-W the
check of a collection without unique fields was skipped).
The passes' `mergeLocaleActions` only change their discarded data and are not run. Bails: with `localizeStatus` a
beforeChange `_status` that is a string (`drafts:statusString`) and an update that is not a
draft save and publishes the request's locale (`buildLocalizedPublishData` reads the main
document, `drafts:localePublish`). For an update the caller passes `docWithLocales` /
`originalDoc` of the stored document upstream reads (with drafts the latest version, see
section 13) and `stored` the main document the `$set` applies to.

Which data reaches `prepare_create`: the operation's `args.data`. The Local API hands the
operation `deepCopyObjectSimple(data)`, so `caller_data` is what upstream leaves in that copy
(observable only to callers of the operations themselves, e.g. REST's `req.data`).

The JSON entry `prepare_json(planJson, requestJson, storedBson)` (napi `fuseWritePrepare`,
`src/prepare/text.rs` documents the texts) runs either entry point with a `RecordedEntropy`; the
corpus uses it and the shadow can too.

How the traversals stay upstream-exact: `beforeValidate` / `beforeChange` run as one task per
upstream `async` function on a small model of the JS heap (objects by reference, insertion order,
own `undefined` properties) and of V8's microtask queue (`exec.rs`: an async call runs to its first
await, `await` resumes one job after its operand settles, `Promise.all` one job after its last
element). Upstream's fields write their fallback values after one, two or three awaits depending on
the field (`getFallbackValue` / `getDefaultValue` are async), so the property order of `data`, the
order of validation errors and the order of row id readings follow the tick counts, not the field
order; the model reproduces them.

### 12.5 What each step ports (status in 12.6)

Files: `crates/payload-fuse-write/src/prepare/` (`plan.rs` the plan, `before_validate.rs`,
`before_change.rs`, `ops.rs` the operation steps and the version, `transform.rs` the write
transform, `mongoose.rs` casting / documents / `castUpdate` / the `$set` MongoDB applies,
`read.rs` the read transform of the version data, `exec.rs` / `heap.rs` the JS model).

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

### 12.6 Status (2026-11-26)

Ported and in the corpus, per field kind (no drafts):

| kind                                       | beforeValidate                         | validator                     | write transform / mongoose                                         |
| ------------------------------------------ | -------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| text, textarea, email (hasMany text)       | fallback, defaults, row `id` toString  | text / textarea / email       | String cast, arrays                                                |
| number (hasMany)                           | number strings (`parseFloat`, `''`)    | number                        | Number cast, Int32 / Double, `-0`                                  |
| checkbox                                   | `'true'` / `'false'` / `''`            | checkbox                      | Boolean cast (mongoose's sets)                                     |
| select (hasMany)                           | -                                      | select                        | String cast, enum check on insert                                  |
| date                                       | -                                      | date (no timezone)            | Date cast (V8 `Date.parse`)                                        |
| relationship (single, hasMany, poly)       | `''` / `'none'` / `'null'`, `{ id }`   | relationship                  | ObjectIds, Mixed for poly                                          |
| array (row ids from the registry)          | `0` / `'0'`, rows, `getExistingRowDoc` | array                         | document arrays                                                    |
| blocks (the field's own blocks)            | block lookup, `blockType`              | blocks (no `filterOptions`)   | embedded discriminators, block `minimize`                          |
| group, row, collapsible, unnamed tabs      | placeholders, traversal                | `() => true`                  | single nested subdocuments                                         |
| unnamed groups (WP-S)                      | the parent's sibling data / doc        | none (no data)                | the parent's level (as a row)                                      |
| radio (WP-S)                               | -                                      | radio                         | String cast, enum check on insert                                  |
| named tabs (localized or not, WP-O)        | as a named group                       | none (tabs have no validate)  | single nested subdocuments, locale-keyed when localized            |
| json (no `jsonSchema`, WP-O)               | fallback, defaults                     | json (strings bail)           | Mixed; `$` / dotted keys bail                                      |
| upload fields (WP-O)                       | as relationship                        | upload                        | as relationship                                                    |
| createdBy / updatedBy (registry hooks)     | submitted marks in `req.context`       | relationship                  | Mixed                                                              |
| createdAt / updatedAt                      | -                                      | none                          | Date cast, stamps from the readings                                |
| richText (lexical, features without hooks) | `req.context.internal.richText[path]`  | `hasText`, `validateNodes`    | Mixed                                                              |
| localized fields and containers            | -                                      | localized array / blocks skip | `mergeLocaleActions`, locale-keyed transforms, locale subdocuments |

Lexical node validations ported (registered in `payloadOwnFunctions` by richtext-lexical):
heading (enabled tags), list, listItem, relationship (enabled collections), upload (enabled
collections, `isValidID`; collections with upload fields need form state and bail). Link /
autolink and block / inline block validations run `fieldSchemasToFormState` (@payloadcms/ui form
state of the node's fields): not ported, documents holding them bail.

Corpus (TS engine as reference; `test/__rs/fuse-writes/int.spec.ts` and `localized/int.spec.ts`):
the `minimal` and `typical` perf shapes (typical with lexical content), `kinds`, `rich`, `pages`
(blocks) and a localized config (localized scalars, relationships, rich text, groups, arrays and
blocks, localized fields in non-localized containers; creates and updates in en / de / fr, stored
documents with every locale filled, unknown locale keys), and since WP-L collections with drafts
(both configs). 214 cases: 199 equal (145 written, 54 invalid; compared: insert / findAndModify BSON bytes, the stored document, the version insert,
`req.context`, the operation's data, the error's message and data), 15 bails, 0 differences.
Crate unit tests: `cargo test -p payload-fuse-write`.

Bails (the exact lane runs): data holding `id` / `_id` on create, dotted keys (`unflattenData`),
`null` / non-object array or block rows (upstream logs a warning), `null` / non-object groups,
relationship values that are not 24-hex strings at the write transform (upstream throws the BSON
error), number custom IDs on related collections, field `access.create` / `.update` without
`overrideAccess` other than compiled functions reading only `req` (the dispatch evaluates each
once per call, `evaluateRequestOnlyAccess`, and sends `fieldAccess`: per write-plan `access`
index the operation's result, `null` without a function; beforeValidate then deletes a denied
field and takes `getFallbackValue({ isDocumentValueAllowed })` as upstream), an existing `req.context._submittedAuthorshipFields` or `req.context.internal`,
`req.locale` `'all'`, `Date` values a validator stringifies, a cast mongoose rejects, an enum
violation, operator values (`$inc`, `$push`, `$remove`), any validation failure without `ctx.t`,
rich text given as a string, nodes with ids, link / block node types.

Drafts (WP-L): creates (published, default status, draft saves with and without draft
validation), draft-save updates, publishes over a latest draft, a localized `_status`
(`localizeStatus`) in one locale, collections with drafts but no localized fields on a localized
config (draft saves); corpus groups `drafts` (14: 11 written, 3 invalid) and `localized drafts`
(9: 7 written, 2 bails by design: `drafts:localePublish`, `drafts:localizedPublish`).

WP-O (2026-11-26): named tabs, the all-locales publish validation (12.4), json and upload fields;
corpus groups `tabbed create` / `tabbed update` (21), `localized tabs` (11), `all locales
publish` (11), `json create` / `json update` (15), `upload create` (10). The corpus is now 282
cases: 259 equal (193 written, 66 invalid), 23 bails, 0 differences.

Not yet: autosave (`updateLatestVersion`), a locale publish with `localizeStatus`
(`buildLocalizedPublishData`), global block references, link and block node validations (form
state), a function `filterOptions` given a value (section 13, WP-O; an empty value: 12.7).

For WP-H, per operation: lexical's `afterChange` hook is the identity for every input the library
accepts (no node ids, so its `originalNodeIDMap` is empty); the field `afterChange` traversal has
no other own hooks on eligible collections.

### 12.7 Compiled user functions (WP-P, 2026-11-26)

User functions on the write path that the function compiler compiles (FN_COMPILE_CONTRACT.md,
owner decision D5) run in the prepare, at upstream's point and with upstream's argument object,
as one tick each (`await callUserFunction(fn, ...)` of a call that settles at once). Files:
`prepare/user_fn.rs` (argument objects, evaluation), `writePlan.ts` `userFunctionPlan`.

- **Plan**: a field's `val` (validate) or an entry of its `hooks.beforeValidate` /
  `hooks.beforeChange` is `{ fn, keys, props }`: the `FnId` (`compileFunction`, memoized per
  function; payload's `init` compiles the config's functions with the Rust core), the keys the
  function reads of its argument object (`argKeys`; `keys` absent: it takes no such argument;
  `null`, i.e. it may read any key: ineligible `...:args`), and `props`: the keys that are not
  built per call, as `encodeSnapshot(snapshot(...))` taken when the plan is built (validate:
  `{ ...field }[key]`, the field's own enumerable data property, watched; hooks: `field` only,
  `{ ...tab, type: 'tab' }` for a tab; any other hook key, e.g. `context`, `indexPath`,
  `schemaPath`, `siblingFields`, is ineligible `...:key`). A function that does not compile is
  ineligible (`...:compile`). plan.ts accepts a user function only when a lane may use it
  (`laneFunction`: guards installed, compiled, active).
- **Per call** (`Run::user_fn_lane_call`): the first use of a function in a prepare call bails
  when it is de-optimised (`fn:inactive`) or when guard mode wants to see the call
  (`lane_should_verify`: the first 32 checked calls, then 1 in 256: `fn:verify`; the exact lane's
  call-site guard verifies). A create bails before any statement, an update inside its
  transaction before writing (the driver aborts).
- **validate** (beforeChange, after `hasInvalidFieldValueShape`, when validation is not
  skipped): `fn(value, options)` with `options` a partial object of the keys it reads:
  `id`, `blockData` (the enclosing block row), `collectionSlug`, `data`
  (`deepMergeWithSourceArrays(originalDoc, data)` of the traversal's top-level values at that
  moment), `event: 'submit'`, `jsonError` (`undefined`: a json string bails earlier),
  `operation`, `overrideAccess`, `path` (segments), `preferences: { fields: {} }`,
  `previousValue` (`siblingDoc[name]`), `req`, `siblingData` (`deepMergeWithSourceArrays(siblingDoc,
  siblingData)`), `skipCompilation`, and the field properties of `props`. A string result is the
  error message (the field's error as for the default validators), anything else is valid. The
  merge is deepmerge's (`isMergeableObject`, target keys first, source arrays kept by
  reference, inherited `Object.prototype` names skipped); `Date` targets with object sources and
  other typed values (ObjectIds) bail. All heap values of one call are exported with one memo and
  converted together, so objects shared in JS stay `===` for the function (`value ===
  siblingData[name]` of an array holds as in JS).
- **Field hooks** (`beforeValidate` after the fallback value, `beforeChange` before
  `hasInvalidFieldValueShape`, both before access / validation as upstream): `hook(args)` with
  the keys it reads of `blockData` (beforeChange; beforeValidate does not track it: bails),
  `collection` (a partial `{ slug }`), `data` (the traversal's top-level data, live, not
  merged), `field`, `global: null`, `operation`, `originalDoc`, `overrideAccess`, `path`,
  `previousSiblingDoc`, `previousValue`, `req`, `siblingData`, `siblingDocWithLocales`
  (beforeChange), `skipCompilation`, `value` (beforeValidate: the fallback for an undefined
  value). The `_status` path bails (upstream passes `docForHooks`). The result upstream assigns
  to `siblingData[name]` when not `undefined`: a primitive, or `value` itself (the same
  object, `Arc::ptr_eq`); any other object bails (`fn:hook:result`: JS would assign that object,
  shared with what the hook took it from).
- **`req`**: the dispatch sends `encodeSnapshot(snapshotRequest(req))` when a function of the
  plan reads `req` (`readsReq`); the prepare drops `context` (Payload's own hooks write to it
  during the operation: reading it bails). The all-locales publish validation (12.4) runs its
  passes on a new `createPayloadRequest`: a function reading `req` bails there.
- **Bails**: the evaluation's (`fn:throws`, `fn:value not in the snapshot`, ...), more than one
  tick (`fn:ticks`: an `await`, an adopted promise), a missing request (`fn:req`).
- **Function `filterOptions`** of a relationship / upload field: `validateFilterOptions` calls it
  (and reads the database) only for a truthy value; the plan marks the field (`fof`) and the
  prepare bails there (`filterOptions:function`), so writes leaving the relationship empty are
  fused. `req.payloadAPI` is not needed for this and stays out of the snapshot.
- Not compiled into the prepare: field `afterChange` and collection hooks (`beforeValidate`,
  `beforeChange`, `afterChange`, `beforeRead` / `afterRead` of the result read); the perf
  suite's hooks shape increments a captured counter in every hook, a side effect the compiler
  rejects.

Corpus groups `validated create` / `validated update` (41 cases: value-only, `req`,
`previousValue`, `data` / `siblingData` merges with stored documents, `blockData`, `path` and
field properties, an async validator, error order of several failures; bails: an `await`, a
throwing validator, function `filterOptions` with a value) and `field hooks create` / `field
hooks update` (18: trimming, values from `data` / `siblingData` / `previousValue` /
`previousSiblingDoc` / `originalDoc` / `collection`, a constant hook, a hook before a validator,
block rows; bails: a hook returning a copied array, `blockData` in beforeValidate). The corpus
is 348 cases: 316 equal (230 written, 86 invalid), 32 bails, 0 differences.

WP-S (2026-11-26): unnamed groups (beforeValidate and beforeChange traverse their fields on the
parent's sibling data / doc / `docWithLocales` under the parent's path, labelled
`getTranslatedLabel(field.label || 'group')` unless `label: false`; the write and read transforms
and `flattenDataByLocale` treat them as rows; a localized unnamed group stays ineligible) and
radio fields (the `radio` validator, a String path with an enum). Corpus groups `grouped create`
/ `grouped update` (28: unnamed groups with labels, `label: false`, nested in a named group and in
array rows, radios) and `localized unnamed groups` (9: test/versions' `Drafts` shape, a localized
unique title in an unnamed group). The corpus is 385 cases: 351 equal (254 written, 97 invalid),
34 bails (the 2 new ones: radio values mongoose's enum rejects), 0 differences.

WP-V (2026-11-26):

- **json fields with a `jsonSchema`.** Upstream's `json` validator returns
  `validateJSONSchema({ jsonSchema, value })` for a non-empty value: zod's `fromJSONSchema` of
  `jsonSchema.schema` (after a JSON round trip), then `safeParse`. The write plan converts the
  schema the way `fromJSONSchema` does (`jsonSchemaPlan` / `jsonSchemaNode` in writePlan.ts) into
  nodes the prepare checks (`prepare/json_schema.rs`, given to the validator as `vo.jsonSchema`
  and evaluated by its host's `validate_json_schema`): booleans, `enum` / `const` of primitives
  (`Set#has`), `type` (one or a list: a union), strings with `minLength` / `maxLength` (code
  points, as zod's `codePointLength`), `number` / `integer` (safe integers) with `minimum` /
  `maximum` / `exclusiveMinimum` / `exclusiveMaximum` (numbers, or booleans making the bound
  exclusive), `boolean`, `null`, objects (`properties`, `required`, `additionalProperties` false:
  strict, a schema: a catchall, otherwise passthrough), arrays (`items` as one schema, `minItems`
  / `maxItems`), no `type`: any; `default`, `description`, `readOnly`, `$comment`, `$schema` and
  keys zod only records as metadata change nothing. Any other zod keyword (`$ref`, `$id`, composition,
  `pattern`, `format`, tuples, `uniqueItems`, `patternProperties`, ...) is ineligible
  (`json:jsonSchema:<keyword>`), as is a schema `validateJSONSchema` fetches (no `uri` or no
  `schema`) and a localized json field (its `mergeLocaleActions` entry is pushed after the
  validator settles, which takes more ticks with a schema than the prepare models; for any other
  field the validator's ticks are the field's last step and order nothing). A value zod accepts is
  valid; one it rejects bails (`jsonSchema:invalid`: the exact lane builds zod's message), as do an
  absent required key, `undefined`, typed values and `__proto__` keys.
- **Dates with timezones.** Sanitization inserts a `<name>_tz` select after the date (not
  sanitized itself: no `validate`, so upstream validates nothing for it; its options are the
  mongoose enum), a field of the plan like any other. The date validator reads `timezone` and
  `siblingData[`${name}_tz`]` (required timezones); the plan sends `vo.timezone` and the prepare
  passes that key of `deepMergeWithSourceArrays(siblingDoc, siblingData)` (the source's value
  when it has the key, else the target's).
- **Document array defaults** (`plan:schema:default`, test/fields' arrays and blocks with a
  `defaultValue`): mongoose wraps a document array's array default in a function default without
  `$runBeforeSetters`, which it applies after `$set(obj)` when the path is still `undefined`
  (`PathDefault::AfterSetters`, before the reorder by `schema.tree`). The plan takes the value from
  `schemaType.options.default` (`[].concat(default)`).
- **Row ids of default rows** (dispatch): a create's `countMissingRowIds` counts the rows of an
  array / blocks field's `defaultValue` when `data` lacks the field (beforeValidate's fallback on
  a create) and the fields of a missing named group / tab (beforeValidate's `{}` placeholder);
  these creates bailed `entropy:objectId` before.

Corpus groups `json schema create` / `json schema update` (32: test/fields' schema, every
modelled keyword, values zod rejects, empty and scalar values, stored invalid values), `array
defaults create` / `array defaults update` (7), `timezone create` / `timezone update` (20:
required timezones, defaults, a single supported timezone, offsets, rows, groups, blocks, values
the enum rejects), plus the plan's ineligibility for `pattern`. The corpus is 444 cases: 388 equal
(281 written, 107 invalid), 56 bails (the new ones: values zod rejects, enum violations, an
absent required key, a string json, a null group, an update whose stored document lacks a
defaulted array), 0 differences.

## 13. Dispatch, drivers and the write lane-shadow (WP-H, WP-J, WP-K, WP-L, WP-O, WP-P, WP-S, WP-U, WP-V, WP-W, status 2026-11-27)

## 13. Dispatch, drivers and the write lane-shadow (WP-H, WP-J, WP-K, WP-L, WP-O, WP-P, WP-S, WP-U, WP-V, WP-X, status 2026-11-27)

Built and on by default since WP-K (`PAYLOAD_RS_FUSE_WRITES=off` restores the exact lane for
every write; WP-J's default-on commit was held until update-many / delete-many were fused, see
below). create, updateByID, deleteByID, update-many and delete-many run on WP-I's prepare,
section 12:

| part                   | where                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| dispatch               | `src/fuse-write/index.ts` `fuseWrite`, called first by every `ops-write` drop-in               |
| write plan             | `src/fuse-write/plan.ts` (WeakMap per `collection`, `volatile` triples)                        |
| MongoDB target         | `src/fuse-write/mongo.ts` (registered by `installDriverLane`), registry `targets.ts`           |
| counters               | `src/fuse-write/stats.ts`: `fuse-writes-<pid>.json`, diffs in `fuse-writes-diffs-<pid>.jsonl`  |
| operation drivers      | `crates/payload-fuse-write/src/ops.rs` (create), `by_id.rs` (by id), `bulk.rs` (many)          |
| shadow state reads     | `crates/payload-fuse-write/src/state.rs`, `exec_shadowed` in `lib.rs`                          |
| Rust prepare interface | `crates/payload-fuse-write/src/prepare_stub.rs` (stub: bails `prepare:stub`)                   |
| bindings               | `fuseWriteMongoOp`, `fuseWriteMongoFind`, `fuseWriteMongoState` (`payload-node/fuse_write.rs`) |
| harness                | `runSuites.mjs --fuse-writes <mode> --fuse-writes-prepare <ts\|rs>`; `test/__rs/fuse-writes`   |

Switches: `PAYLOAD_RS_FUSE_WRITES=off|on|shadow` (default `on` since WP-K, 2026-11-25);
`PAYLOAD_RS_FUSE_WRITES_PREPARE=ts` selects the **temporary TS prepare** (upstream's own
`beforeValidate` / `beforeChange`, db-mongodb `create` / `createVersion` and mongoose's document
casting, without their I/O); otherwise WP-I's Rust prepare, which the operation drivers run
inside the fused write on the driver runtime (creates since WP-Y, by-id and bulk updates since
WP-J; `fuseWritePrepare` remains the JSON entry of the corpus tests). The TS
prepare is never a default: it exists to prove the drivers, the transaction and the shadow.

**Eligibility** (plan, per collection): no collection hooks on any write path, no root
`afterError`; every field hook / `defaultValue` function in `payloadOwnFunctions`, every
`validate` in `defaultFieldValidators`, or (since WP-P) a compiled `validate` / field
`beforeValidate` / `beforeChange` hook a lane may use (section 12.7); no `filterOptions`
function other than a relationship's / upload's (12.7), join, point, virtual field,
block references; not upload, auth, scheduled publish (`drafts.schedulePublish`), custom ID,
no `select` function; WP-A's read plan eligible. **Guards** (per call): inert args and `data` (no Dates yet),
accepted `req` kinds, no `transactionID`, no `disableTransaction`, no `autosave` (`draft` since
WP-L, see Drafts below) /
`duplicateFromID` / `publishAllLocales` / `selectedLocales` / `select` / `req.file`, no `id` in
data; `overrideAccess` or `access.create` compiled and truthy; the result read must be
buildable (checked before the prepare: field read access compiled per call, population's nested
finds only on collections that grant read with `true`, see FUSE_CONTRACT.md section 3); target: write and read methods unchanged since
the lane was installed, a replica set, `transactionOptions !== false`, no tracing / verify.

**create** (driver `ops.rs`): `insert` of the document, then with versions `insert` of the
version and the latest flip `update` (`$unset: { latest: 1 }`, filter as `createVersion`), no
max-versions find; then `run_document` (the fused `findByID` request of the new id: afterRead and
population in the transaction), then the commit. JS replays what upstream mutates in place
(`args.data` by `beforeValidate`, `req.context` by Payload's own hooks: the TS prepare works on
copies so a bail leaves both untouched; the Rust prepare only reads them, as one JSON text, so
since WP-AA it is given them uncopied when the context is a plain object, the context writes being
assigned after a successful write), primes the dataloader with keys carrying a fresh transaction
id (upstream's population runs inside the operation's transaction) and deletes
`req.transactionID` like `commitTransaction`.

**WriteCtx** (`captureCreateCtx`, the Rust prepare's input): clock readings and ObjectIds in
upstream's order: `createdAt` (unless given), `updatedAt` (write transform, unless given), the
document's `_id`, `saveVersion`'s `now`, the version's `_id`. Row ids (`bson-objectid`, read by
`beforeValidate` before all of these) must be pre-generated per row without an id, in traversal
order, once WP-I's plan says how many; until then the Rust path bails for data with
`createdAt` / `updatedAt`. The op request for the Rust prepare is
`{ op: 'create', c, vc?, wp: <write plan id>, p: <prepare request: data, context, clock, ids,
user?, locale?, ...>, ut? | ub? }` (`ut` the all-locales publish validation's unique-lookup
templates, `ub` why there are none); the driver runs `prepare_create` first (a bail, a
validation failure or unused readings abort before any statement) and resolves with `[text,
state | '', contextWrites, callerData]`. Outside the shadow the dispatch takes the document's
ObjectId in its guards (the same synchronous run as the prepare's other readings), so the
guards' result read is the one sent. With the TS prepare `{ op, c, doc, v?: { c, doc } }`.

**Write lane-shadow**: the fused lane runs first (its readings recorded on replay tapes), reads the
touched collections inside its transaction (the document by `_id`, its versions by `parent`,
canonical extended JSON: BSON types and key order) and aborts; then the exact lane runs with the
readings replayed (clock, bson `getInc`, `bson-objectid` row ids: new `objectIds` channel) and its
result is returned. Compared: result (canonical), populated dataloader keys / cached objects / req
state, raw state after the exact lane's commit, the operation's `data` and `req.context` (the
fused copies replayed onto the state before the call), reading counts (the exact lane's
transaction uuid is exempt, D4), and errors when both throw. Counted: `hits`, `bails`, `guards`,
`ineligible`, `sameError`, `diffs`.

**updateByID** and **deleteByID** (WP-J, driver `crates/payload-fuse-write/src/by_id.rs`; the
TS side `prepareByID` in `src/fuse-write/mongo.ts`, dispatch `fuseByID` in `index.ts`). One
Rust-owned transaction, no JS turn between the statements, the prepare running inside it:

1. the stored document: the result read's `findOne` (the same read as
   `getLatestCollectionVersion` / deleteByID's `findOne`: same where, no select or joins), in the
   transaction; none bails (`byID:notFound`, the exact lane throws `NotFound`);
2. updateByID: `docWithLocales` (the driver crate's read transform of the stored BSON) and
   `originalDoc` (`payload_fuse::after_read_original`: depth 0, `fallbackLocale: null`,
   `showHiddenFields` and `overrideAccess` true), then WP-I's `prepare_update`
   (`prepare_update_request`, the plan registered once through `fuseWriteRegisterPlan`); a bail,
   unused readings or a validation error bail before anything is written. The prepare runs
   before the lock check: it is pure, so the order is unobservable, and a bail then leaves the
   locks alone;
3. `checkDocumentLockStatus`: with `overrideLock: false` (REST) the lock `find` without a session,
   which bails on any lock of the document (`byID:locked`: the exact lane decides whether it is
   live and throws `Locked`); then the lock `delete` without a session, as upstream (committed at
   once; a later bail reruns the exact lane, whose delete then finds nothing). The write
   lane-shadow sends it inside its aborted transaction instead, so the exact lane's own delete is
   compared;
4. updateByID: `findAndModify` (`remove: false, new: true, upsert: false, update`, the Node
   driver's key order), whose `value` must equal the prepare's `stored_after` byte for byte
   (`byID:storedAfter`: the version would have been built from another document); with
   versions the version insert, the latest flip (none without drafts) and `enforceMaxVersions`'
   find (`skip: max, limit: 1`, sort `updatedAt: -1, createdAt: -1` as the driver lane sends it);
   since WP-S, when it finds a version with an `updatedAt`, its `deleteVersions` in the
   transaction (below). The result is
   saveVersion's returned version: the version insert's `version` with `_id = parent` through the
   collection's read transform (`id` last, as `sanitizeInternalFields` and `createdVersion.id =
   parent` leave it); without versions the `findAndModify` value;
5. deleteByID: `deleteVersions` (`delete` of the parent's versions), `findAndModify` with
   `remove: true` (its value is the result's document), the preferences `delete`
   (`key: { $in: ['collection-<slug>-<id>'] }`, non-auth); scheduled publish needs drafts
   (ineligible);
6. the result's `afterRead` / population in the transaction, the commit. JS assigns the
   prepare's `req.context` writes (updateByID works on a deep copy of `data`: nothing else to
   replay), primes the dataloader (deleteByID's afterRead passes `draft: undefined`, so its keys
   hold `null`) and deletes `req.transactionID`.

The statements' filters are mongoose's casts (`castQuery` of the driver lane) of db-mongodb's
`buildQuery` for `{ id: { equals } }`, the locks' `document.relationTo` / `document.value`, the
versions' `parent` and the preferences key, built once per collection model with a sentinel
ObjectId and given each call's id by replacing the sentinel's 12 bytes and 24 hex characters in
the serialized template (`withID`).

Readings (12.3) of updateByID, taken by JS in upstream's order: row ids, `dataToUpdate.updatedAt`,
mongoose's `now` in the `findOneAndUpdate` pre hook `_setTimestampsOnUpdate` (schemas with
timestamps; the value is unused because db-mongodb passes `timestamps: false`, but the shadow's
tapes need the reading), with versions `saveVersion`'s `now` and the version's `_id`. deleteByID
takes none (the lock check's clock reading only happens when a lock exists, which bails).

Guards besides the create's: a 24-hex lowercase id, no `trash` argument and no `deletedAt` in the
data of a trash collection, no `autosave` / `publishAllLocales` / `unpublishAllLocales`
(`draft` allowed since WP-L), deletes of a collection with `schedulePublish` guarded, a plain `req.context`, and without `overrideAccess` a compiled `access.update` /
`access.delete` that grants (`true`, or since WP-W a where constraint, combined into the
stored-document read). State reads add the locked documents of the id (`document.value` as ObjectId or string)
and, for deletes, the preferences key.

Verification of updateByID / deleteByID: the lane suites test/__rs/fuse-writes-lane (typical,
unversioned, locks with `overrideLock` true and false, errors, localized typical with blocks
updated in two locales) at 0 differences; the MongoDB harness with `--fuse shadow --fuse-writes
shadow` equals `.rs-baseline/mongodb-all.json` (3330 / 164 / 422) with 2810 creates, 68
updateByID and 162 deleteByID compared and 0 lane-shadow differences.

**Widened (WP-J)**: a config's global blocks no longer make every collection ineligible (the
write plan carries `globalBlocks`; a row whose `blockType` is a global slug bails in
`block_to_match`, since upstream's lookup `req.payload.blocks[blockType] ?? field.blocks.find(...)`
prefers it, in beforeValidate, beforeChange and the write transform's `traverseFields`). A
relationship's static `filterOptions` (a where, `true`, `false`) reaches the validator in `vo`:
`validateFilterOptions` returns `true` without I/O for an empty value (no awaits, so the tick
count is unchanged), and any other value reaches `payloadDataLoader.find`, which the prepare's
`NoHost` refuses (a bail). Function `filterOptions` stay ineligible.

**Widened for REST and GraphQL (WP-C, 2026-11-25)**: calls without `overrideAccess` used to stop
at `access:fields` for every collection (sanitization gives every field an `access` object with a
`validate` key, and authorship adds `createdBy` / `updatedBy` with `create` / `update: () =>
false`) and at `access:populate` for any relationship field. Now field write access runs in the
prepare from the dispatch's per-call results (above), the population guard applies only when the
result read populates, and population without `overrideAccess` is fused when the loaded
collections grant read with `true` (FUSE_CONTRACT.md section 3). GraphQL mutations (depth 0)
reach the lane; REST writes at the default depth 2 still guard on `read`: their result populates
`createdBy` from the users collection, whose `sessions` field has a document-reading read access
(`user?.id === doc?.id`). The lane-shadow's replay of the fused copies onto the caller's `data`
now also reproduces key order (a denied field is deleted and re-added after the others).

**REST writes at depth 2 (WP-M, 2026-11-25)**: the result read's `afterRead` now evaluates
document-reading field read access per document in Rust, and population's nested finds evaluate
the related collections' compiled read access where they run (`false`, e.g. the users' default
access for an anonymous request, reads nothing; FUSE_CONTRACT.md sections 2, 3 and 9). The
`read` guard no longer stops REST creates / updates whose result populates the users; guard
sampling of those functions bails the write (transaction aborted, exact lane) on the calls it
samples. No change to the write side: `src/fuse-write` is untouched. Measured (full MongoDB
harness, `--fuse shadow --fuse-writes shadow`, 0 lane differences): the write guard `read` drops
from 326 to 73 (the rest: relationships' `transaction`); collections-rest's REST writes now reach
the prepare and stop at `plan:tabs:named` instead. Reads: the `populate:access` (261) and
`access:field:args` (22) guards are gone, fused read hits 3441 -> 3467. Perf suite (MongoDB, 1k
posts, typical, 3 runs, `ts/rs` geometric means): REST create 1.21, update 1.25, partial-update
1.68, delete 1.16; auth and reads unchanged within the run-to-run spread (`auth (JWT)` and
`meUser` are bimodal per process on both trees).

**update-many and delete-many** (WP-K, driver `crates/payload-fuse-write/src/bulk.rs`, TS
`runBulk` / `prepareBulk` in `src/fuse-write/mongo.ts`, dispatch `fuseBulk` in `index.ts`). Two
native calls on one Rust-owned transaction, because the per-document statements need the ids the
operation's find returns:

1. `fuseWriteMongoFind`: update.ts / delete.ts's `payload.db.find` (`pagination: false`; update
   with its `limit` and `sort`), the fused `find` reads of `fusedPageRequest` (src/fuse/index.ts),
   in the transaction; it returns the ids and the documents' BSON (no JS ran yet that a bail
   would have to undo: a bail aborts and the exact lane reruns);
2. JS builds, for exactly those documents: update-many one updateByID request per document
   (`prepareByID` with the document's id: its cast filters and the prepare request with its
   readings, taken document by document in the find's order); delete-many delete.ts's cast
   filters for all ids (`id in`, the locks' `document.value in`, the versions' `parent in`, the
   preferences' `key in`);
3. `fuseWriteMongoOp` (`op: 'updateMany' | 'deleteMany'`) on the same transaction:
   - update-many: per document what updateByID runs after its stored read
     (`by_id::update_document`: `prepare_update` on the find's document, whose `docWithLocales`
     is the `leanWithId` read transform, the lock check, `findAndModify`, the version statements,
     `enforceMaxVersions`' find). Upstream runs the documents concurrently (`Promise.all`); the
     driver runs them in the find's order (D1: each document's statements and effects are
     upstream's, only the interleaving between documents differs). The documents share
     `req.context`: the call is fused only when every document's prepare writes the same context
     values (authorship's submitted marks, `_isNewDoc`, lexical's `internal.richText`), which
     JS then assigns once; otherwise `bulk:context`;
   - delete-many (`deleteDocumentsInBulk`): with `overrideLock: false` the locks `find` (any
     lock bails), the locks `delete` (no session), `deleteCollectionVersions`, the documents'
     `delete`; for zero documents none of these;
   - the results' `afterRead` once over all documents (`payload_fuse_mongo::run_documents`, one
     page of the fused `find` core): population shares the nested reads and objects across the
     documents like upstream's request dataloader does across its concurrent per-document
     `afterRead`s (update's `draft: false`, delete's `draft: undefined`);
   - delete-many: `deleteUserPreferences` (also for zero documents), then the commit.

The result is `{ docs, errors: [] }` (a document upstream would report in `errors`, e.g. a
validation failure, bails first). Guards besides the by-id ones: a `where` the fused reads accept
(`isAcceptedWhere`), no `bulkOperationsSingleTransaction`, no `select`, no `req.operation ===
'validate'`, no `_payloadManagedDeletedUploads` in `req.context`; update: no row ids in `data`
(`copyDataWithFreshRowIDs` keeps an id only when the document has it), no `disableBulkEdit`
without `overrideAccess`, no relationship to the collection itself when the results populate
(upstream's documents would read each other in an interleaving-dependent order).

The write lane-shadow of the bulk writes compares as the by-id one (state reads per document:
the document, its versions, locks, preferences), except that a bulk update's clock readings,
version ObjectIds and row ids reach the documents in the exact lane's interleaving: when the
result or the state differ, both are compared again with every value a taped reading generated
replaced by its kind (`<clock>`, `<oid>`, `<row>`; replay.ts `recorded()`) and each state group's
documents sorted; equal then counts `updateMany:interleaved`, anything else is a difference.
Every reading must still be replayed exactly once.

The bulk regression (below, `update many` 0.91x and `delete many` 0.77x with only the by-id
writes fused) is not the Node driver's idle connection: in the perf suite, a `ping` through
mongoose's connection after the fused setup does not recover it, while a 20 ms `setTimeout`
after exact setups slows the next delete on both variants (8.5 -> 15.5-18.9 ms) and a 20 ms busy
wait does not. The next statement after the process sat idle pays the wake-up (CPU power state,
scheduler); fused setups leave the JS thread idle while the Rust runtime works. Fusing the bulk
writes themselves is the remedy.

**Default on** (`PAYLOAD_RS_FUSE_WRITES` unset, WP-K). Bars on the final tree (2026-11-25,
release addon, mongod 8.2 rs0):

- MongoDB harness, `--engine default`: 3330 / 164 / 422, equal to `.rs-baseline/mongodb-all.json`
  (test/cli differs only by the worktree path; storage emulators and hmr absent; the
  plugin-ecommerce settlement test passed). Fused writes served: 2983 creates, 71 updateByID, 162
  deleteByID, 3 update-many, 188 delete-many.
- The harness with `--fuse shadow --fuse-writes shadow`: 3330 / 164 / 422, the same calls
  compared, 0 lane-shadow differences (an earlier run's one difference, test/cli's delete-many
  of `payload-migrations`, was the replay counting the driver's own pool-event clock readings in
  source-mapped stacks, `mongodb/src/`; replay.ts now skips those like `mongodb/lib/`).
- The 8 shadow files: 971 / 0 / 46, 0 divergences. Parity 503/503 in two of three runs; the
  third failed only `update > updateMany where` (per-document compare, the exact lane: tracing
  keeps the fused lanes off; its `<oid:N>` numbering follows the documents' interleaving).
  Parity and the golden dumps need `PAYLOAD_RS_MONGO_SERVER` set to the same server as
  `MONGODB_URL` (else every dump reads the default server: 55 failures on any engine). Driver
  lane 4/4, glue 33/33 (`PAYLOAD_ENGINE=ts`), the fuse-writes corpus 12/12 (`PAYLOAD_ENGINE=ts`),
  the lane suites 29/29 (default and shadow), packaging OK.

**Drafts** (WP-L, 2026-11-25). Collections with `versions.drafts` are eligible (not with
`schedulePublish`); WP-I's prepare models `isSavingDraft` (section 12.4). Per operation:

- create: `draft` is no longer a guard (`autosave` is: `updateLatestVersion`). The statements
  are the create's; the version's `autosave` is the argument's, and the latest flip now sends
  its update (the version schema has `latest`). The result read passes `draft` to the
  population only: `fusedFindByIDRequest` (an operation's result) no longer refuses `draft` on a
  collection with drafts, since afterRead runs on the written document.
- updateByID: the stored-document read is `getLatestCollectionVersion`'s: first the parent's
  latest version (template `lv`: updateByID's where with `appendVersionToQueryKey`, combined
  with `parent` and `latest: true`, db-mongodb `findVersions` with `limit: 1`, `-updatedAt`,
  cast like `mf`), in the transaction; when it finds one, `docWithLocales` / `originalDoc` come
  from its `version` with `_id = parent` (the read transform's trailing `id` is upstream's
  `version.id = id`); otherwise the result read's `findOne` as before. A draft save then sends
  no `findAndModify`: the lock check, the version insert, the latest flip, `enforceMaxVersions`'
  find; its readings are row ids, `saveVersion`'s `now` and the version `_id` (no
  `dataToUpdate.updatedAt`, no mongoose `now`). A publish whose inputs came from the latest
  version sends the `findAndModify` built from them and runs the prepare again with the
  returned main document as `stored` (same inputs and readings: its `$set` must equal the first
  one byte for byte, its `stored_after` the returned document), so the version is built from
  the main document upstream's `updateOne` returns, without a read upstream does not send.
- deleteByID / delete-many: unchanged statements (`deleteCollectionVersions` covers drafts).
- update-many: as before (`draft` stays a guard: upstream then reads `queryDrafts`); its
  documents are the main documents (update.ts reads `payload.db.find`).
- Guards: `drafts:localizedPublish` (a localized config, drafts, and `!draft && !(localizeStatus
  && locale !== 'all')`: upstream validates every locale with
  `validateLocalWithLocaleKeyedData`; since WP-O only with the TS prepare, the Rust prepare
  runs that validation, section 12.4); the prepare bails `drafts:localePublish` (with
  `localizeStatus` an update that is not a draft save and publishes the request's locale) and
  `drafts:statusString`.

Verification: corpus groups `drafts` / `localized drafts` (section 12.6), lane suites
`drafts.int.spec.ts` (published / default / draft creates, draft validation, draft saves,
publish over a latest draft, a draft update sending `published`, population of a draft save,
`maxPerDoc`, deletes) and `drafts-localized.int.spec.ts` (localized status, a draft in another
locale, a locale update left as a draft, a locale publish, a collection without localized
fields), 0 differences in shadow.

The MongoDB harness with `--fuse shadow --fuse-writes shadow` (WP-L's final tree, release
addon): 3330 / 164 / 422, equal to `.rs-baseline/mongodb-all.json` (test/cli differs by the
worktree path; storage emulators and hmr absent), 0 lane-shadow differences, 0 fused-write
differences. Fused writes compared: 3247 creates, 85 updateByID, 229 deleteByID, 4 update-many,
207 delete-many (WP-K: 2983 / 71 / 162 / 3 / 185, so drafts add 264 creates, 14 updateByID, 67
deleteByID, 1 update-many, 22 delete-many). The 1319 `drafts` ineligible calls are gone; what
stays on the exact lane: the guard `drafts:localizedPublish` 599 (creates and updates that
publish all locales of a localized config: `validateLocalWithLocaleKeyedData`), the prepare's
`drafts:localePublish` 13, `args:options` 115 (incl. `autosave`, `publishAllLocales`); the
collections with `schedulePublish` in the harness also have function `filterOptions`
(`field:filterOptions` 554, previously counted under `drafts`).
The harness with `--engine default` (fused writes on): 3330 / 164 / 422, equal to the baseline
(the plugin-ecommerce settlement test passed); fused writes served: 3246 creates, 85
updateByID, 229 deleteByID, 4 update-many, 207 delete-many.

Perf (WP-L, test/__rs/perf, MongoDB 1k posts, release addon, packed install verified against
the builds: engine-rs dist, payload and db-mongodb dist and the addon identical; `ts/rs`, `off`
= `rs-fused-off` → `on`; per scenario the median of 3 passes, geometric mean per category):

| shape   | surface | create      | update      | partial-update | delete      | versions    |
| ------- | ------- | ----------- | ----------- | -------------- | ----------- | ----------- |
| typical | local   | 1.17 → 1.32 | 1.05 → 1.89 | 1.04 → 1.68    | 1.00 → 0.97 | -           |
| typical | rest    | 1.06 → 1.07 | 0.98 → 0.93 | 0.94 → 0.91    | 0.93 → 0.73 | -           |
| typical | graphql | 1.06 → 0.92 | -           | 0.99 → 1.46    | 1.01 → 1.16 | -           |
| complex | local   | 1.05 → 1.06 | 1.01 → 1.03 | 1.02 → 1.04    | 0.99 → 1.02 | 1.04 → 1.14 |
| complex | rest    | 1.00 → 0.99 | 1.03 → 1.05 | 1.01 → 1.03    | 0.95 → 0.91 | 1.11 → 1.11 |
| complex | graphql | 1.06 → 1.06 | -           | 1.06 → 1.08    | 0.96 → 0.99 | 1.18 → 1.20 |
| hooks   | local   | 1.06 → 1.09 | 0.97 → 0.99 | 0.97 → 0.98    | 0.96 → 0.97 | -           |
| hooks   | rest    | 0.98 → 1.02 | 1.01 → 0.99 | 0.97 → 0.96    | 0.86 → 0.95 | -           |
| hooks   | graphql | 1.03 → 1.06 | -           | 0.97 → 0.99    | -           | -           |

The perf suite's drafts (`complex`: `save draft`, `publish`, the REST draft `PATCH`) stay on the
exact lane: the complex shape has a named tab and a user `validate` (`plan:tabs:named`,
`field:validate`), and its publishes would validate all locales. The passes disagree far more
than the code paths do: typical `delete by id` was 0.89 → 2.01 in the first pass (WP-K: 1.83)
and 0.98 → 1.04, 1.12 → 1.10 in the next two (and 0.96 → 0.91 in a fourth), with the TS times
the same in all four (6.7-7.8 ms) and the same installed builds; the fused deletes ran (the
harness counts them). The first pass ran right after the verification runs, the later ones on
an idle machine: this is WP-K's idle-wake effect (the JS thread idles while the Rust runtime
works, and the next statement pays the wake-up), so single-machine ratios of the fused lanes
are only comparable under the same load.

Remaining bails in the shadow harness, largest first (WP-L's run):
`plan:localization:filterAvailableLocales` 189, `plan:field:json` 141, `plan:date:timezone` 131,
`plan:field:upload` 107, `plan:field:slug` 78, `plan:tabs:named` 76,
`prepare:relationship:numberIDs` 49, `populate:related` 46, `plan:field:condition` 43,
`plan:field:ui` 38; guards: `transaction` 753, `drafts:localizedPublish` 599, `file` 464, `read`
326, `disableTransaction` 292, `access:verify` 176, `trash` 167, `data:id` 158, `args:options`
115; ineligible: `hooks:beforeRead` 666, `field:filterOptions` 554, `hooks:afterRead` 521,
`hooks:beforeOperation` 371, `joins` 269, `auth` 254. (WP-K's run had `drafts` 1319 ineligible.)

What is left for drafts, largest first: publishing all locales of a localized config (599 calls:
`validateLocalWithLocaleKeyedData` runs a second validation lifecycle per locale with a cloned
`req.context`; a port would rerun beforeValidate / beforeChange on the locale-keyed data and
bail on any error), autosave (`updateLatestVersion`: the latest version's find, then either
`updateVersion`'s `findOneAndUpdate` with the found version's `createdAt`, or a new version;
the version `_id` reading is only taken on the second branch, so the dispatch cannot take it
ahead of the native call as the other readings are; it needs the readings taken at the
decision, or a second native call), a locale publish with `localizeStatus` (13:
`buildLocalizedPublishData` on the main document read with `locale: 'all'`), update-many with
`draft` (`queryDrafts`).

**Widened (WP-O, 2026-11-26)**: named tabs, the all-locales publish validation, json and upload
fields, configs with `localization.filterAvailableLocales` (section 12; the dispatch and the
drivers are unchanged except that the `drafts:localizedPublish` guard now applies to the TS
prepare only). On the way, the harness's test/localization `tabs` collection showed that
mongoose computes `minimize` per subdocument from its own schema on the save path (a group
inside a localized tab keeps its `{}` under the locale wrapper, whose schema minimizes): the
document building no longer inherits a parent's `minimize` (corpus cases added).

The MongoDB harness with `--fuse shadow --fuse-writes shadow` (release addon): 3330 / 164 /
422, equal to `.rs-baseline/mongodb-all.json` (test/cli differs by the worktree path; storage
emulators and hmr absent), 0 lane-shadow differences, 0 fused-write differences. Fused writes
compared: 3858 creates, 167 updateByID, 229 deleteByID, 6 update-many, 210 delete-many (WP-L:
3247 / 85 / 229 / 4 / 207). Gone: `plan:tabs:named` 312 (WP-M's count), the guard
`drafts:localizedPublish` 599, `plan:localization:filterAvailableLocales` 149, `plan:field:upload` 117. What these now reach instead, largest first: `prepare:drafts:localizedPublish:unique` 90
(`validateUniqueConstraints` would read the database: a read in the Rust transaction, as
upstream's `fieldValueExists`, would lift it), `plan:json:jsonSchema` 141 (every json field of
the harness has a `jsonSchema`: zod), `plan:field:condition` 65, `plan:field:code` 33,
`plan:group:unnamed` 32, `populate:related` 142 (the read side). Remaining largest overall:
guards `transaction` 761, `file` 605, `disableTransaction` 292, `access:verify` 183; ineligible
`hooks:beforeRead` 777, `hooks:afterRead` 623, `field:filterOptions` 554, `hooks:beforeOperation`
378; bails `plan:date:timezone` 131.

Also at 0 differences on the final tree: the harness with `--engine default` (3330 / 164 / 422,
equal to the baseline, the plugin-ecommerce settlement test passed; fused writes served 3857
creates, 167 updateByID, 229 deleteByID, 6 update-many, 210 delete-many), the 8 shadow files
(971 / 0 / 46, 0 divergences), parity 503/503, driver lane 4/4, glue 33/33, the corpus 21/21
(`PAYLOAD_ENGINE=ts`, 289 cases: 266 equal, 23 bails), the lane suites 69/69 (default and
shadow; new: named tabs in two locales, a named tab's required field, json / upload / named tab
writes, all-locales publishes incl. update-many and an invalid one, a config with
`filterAvailableLocales`), packaging OK.

Perf (WP-O, test/__rs/perf, MongoDB 1k posts, release addon, packed install verified against
the builds: the addon, engine-rs, payload and db-mongodb dist identical; `ts/rs`, `off` =
`rs-fused-off` → `on`; per scenario the median of 3 passes, geometric mean per category):

| shape   | surface | create      | update      | partial-update | delete      | versions    | locale      |
| ------- | ------- | ----------- | ----------- | -------------- | ----------- | ----------- | ----------- |
| typical | local   | 1.09 → 1.47 | 1.01 → 2.31 | 0.98 → 1.57    | 0.96 → 1.01 | -           | -           |
| typical | rest    | 0.94 → 1.18 | 0.95 → 1.36 | 0.89 → 1.74    | 0.95 → 1.02 | -           | -           |
| typical | graphql | 1.10 → 1.27 | -           | 1.01 → 1.35    | 0.97 → 1.29 | -           | -           |
| complex | local   | 1.02 → 1.03 | 0.99 → 1.01 | 1.00 → 1.01    | 0.97 → 1.00 | 1.11 → 1.07 | 1.40 → 1.29 |
| complex | rest    | 0.93 → 0.96 | 0.99 → 1.01 | 0.94 → 0.96    | 0.99 → 0.89 | 1.01 → 0.97 | 1.17 → 1.09 |
| complex | graphql | 1.06 → 1.04 | -           | 1.07 → 1.02    | 1.01 → 0.93 | 0.97 → 0.94 | 1.22 → 1.12 |

The complex shape still runs no fused write: beside its named tab it has a user `validate`
(`field:validate`), and its versions scenarios publish with drafts on a non-localized config, so
its on / off columns run the same code and differ by the run-to-run spread (the typical REST
gains over WP-L's table are WP-M's depth-2 result reads, the write side being unchanged there).

Not built (WP-O), with what each needs:

- **Function `filterOptions`** (WP-P: calls whose value is empty are fused, 12.7; what follows is for a value. WP-O counted 554, of which 484 in test/versions' `Drafts`: `({ req }) =>
  req.payloadAPI === 'REST' ? req.method === 'POST' : true`). Three parts: (1) the compiled
  function evaluated in the dispatch per `relationTo` (`evaluateRequestOnlyAccess`-style, guard
  sampling kept); this one reads `req.payloadAPI`, which `capturedRequest` (compile/snapshot.ts)
  and `payload_fn_ir::lanes::request` do not carry yet, and functions reading `data` /
  `siblingData` / `id` would need the validation data (`deepMergeWithSourceArrays(doc, data)`),
  which exists only inside the prepare; (2) the validator's `payloadDataLoader.find({ collection,
  depth: 0, disableErrors: true, limit: 0, overrideAccess, pagination: false, where: { and: [{ id:
  { in } }, filter] } })` run as a fused `find` in the Rust transaction: the prepare is pure, so
  it would return the lookups it needs and the drivers would run them and call it again with the
  results (creates prepare in JS before the transaction today, so the create driver would take
  the prepare request too); (3) `payloadDataLoader.find` caches its promise in the request's
  dataloader closure (`findQueries`): a later identical find on the same request reuses it, which
  the fused lane cannot prime from outside. The ticks of `validateFilterOptions` (two awaited
  calls) only matter with other validation errors (error order), where the prepare would bail.
- **Autosave** (in `args:options`): creates are the plain create with `version.autosave = true`
  plus upstream's `updateLatestVersion` find (`findVersions`, `parent` of the new id, `-updatedAt`,
  `limit: 1`), which finds nothing for a generated id; skipping it is a command-stream change like
  the approved max-versions skip, so the create driver should send it (and bail on a result).
  updateByID draft saves need a second native call: the first (in the transaction) runs the
  stored reads and that find and returns whether the latest version has `autosave: true`; JS
  then takes the readings of the branch upstream takes (`updateVersion`: no version `_id`, no
  `enforceMaxVersions`; else a new version) and the second call sends `findOneAndUpdate` of the
  latest version (`{ createdAt: <its createdAt>, latest: true, parent, updatedAt: now, version }`,
  db-mongodb `updateVersion`) or the version insert.

**Compiled user functions (WP-P, 2026-11-26)**: section 12.7 (validators, field hooks, function
`filterOptions` with an empty value). The dispatch is otherwise unchanged except for a backoff:
two driver bails come only after the statements ran (abort, then the exact lane reruns the
call) and tend to repeat for a collection: `populate:related` (the result read loads a
collection the fused reads do not serve, e.g. the perf suite's `authors` with its join field,
whenever a document holds such a relationship value) and `byID:maxVersions` (a document past
`maxPerDoc` versions: the exact lane deletes the old versions). After one of them the run lanes
back off per collection and kind of call (`backoff:<reason>` guards: the next 1, 2, 4, ... up to
64 calls whose result read can reach an unserved collection, respectively updates, run the exact
lane directly; such a call the lane runs through resets it, so a GraphQL write at depth 0 is not
held back by the Local API's populating ones); the shadow lanes do not back off. The complex shape exposed both once its validator compiled: every
Local / REST write populates `author`, and its documents pass `maxPerDoc: 10` during the run;
without the backoff its partial updates measured 0.84x of TS against 1.06x with fused writes
off. A static guard on the population alone cost about 650 harness hits (collections whose
relationships to unserved collections are mostly empty). Enforcing `maxPerDoc` in the driver
(upstream's `deleteVersions({ updatedAt: { less_than_equal }, parent })` after the find) and
joins in population would turn these into fused writes.

Measured, full MongoDB harness (WP-O's runs → WP-P's, release-independent counts):

| run                                      | hits        | bails      | guards      | ineligible  |
| ---------------------------------------- | ----------- | ---------- | ----------- | ----------- |
| `--fuse shadow --fuse-writes shadow`     | 4459 → 4497 | 905 → 1413 | 2411 → 2505 | 4301 → 3666 |
| `--engine default` (fused writes served) | 4458 → 4488 | 905 → 1340 | 2413 → 2587 | 4312 → 3681 |

Ineligible reasons that moved (shadow run): `field:filterOptions` 554 → 39, `field:validate` 215
→ 195, `field:hooks:beforeChange` 104 → 30, `field:hooks:beforeValidate` 46 → 0 (of the 150
field-hook-ineligible calls 120 pass that reason; the collection hooks, `hooks:beforeRead` 673,
`hooks:afterRead`, `hooks:beforeOperation` 377, are unchanged: their functions have side effects
or are not compiled). The newly eligible calls mostly stop at the next unmodelled feature:
`plan:group:unnamed` 32 → 454 (test/versions' `Drafts`: an unnamed group, which the write plan
does not model yet; the largest single lever left on this path), `prepare:fn:verify` 67 (guard
sampling's first calls), `drafts:schedulePublish` 76 (deletes); hits +38 (shadow) / +30
(default; there the backoff guards 82 calls, `backoff:populate:related`, and the late
`populate:related` bails drop from 122 to 50). Bars on the final tree: both harness runs 3330 / 164 / 422, equal to
`.rs-baseline/mongodb-all.json` (test/cli differs by the worktree path; storage emulators and hmr
absent; one earlier default run during a machine load spike, 15-minute load average 31, had three
90 s timeouts in queues/schedules, trash and upload-transformers, clean when rerun alone, and the
rerun of the whole harness was clean), 0 lane-shadow and 0 fused-write differences; the 8 shadow files 971 / 0 / 46, 0
divergences; parity 503/503; driver lane 4/4; glue 33/33; HTTP lanes 18/18; fn-compile 39/39;
the corpus 25/25 (348 cases, 316 equal, 32 bails); the lane suites 75/75 (default) and the write
lane suites 60/60 (shadow; new `validate.int.spec.ts`: value-only, `req`, `previousValue`
validators past guard sampling, compiled field hooks, an opted-out validator); packaging OK.

Perf (WP-P, test/__rs/perf, MongoDB 1k posts, release addon, packed install verified against
the builds: the addon, engine-rs, payload and db-mongodb dist identical; `ts/rs`, `off` =
`rs-fused-off` → `on`; per scenario the median of 3 passes, geometric mean per category):

| shape   | surface | create      | update      | partial-update | delete      | versions    | locale      |
| ------- | ------- | ----------- | ----------- | -------------- | ----------- | ----------- | ----------- |
| complex | local   | 1.18 → 1.19 | 1.13 → 1.01 | 1.14 → 1.10    | 1.02 → 0.97 | 1.10 → 0.99 | 1.34 → 1.35 |
| complex | rest    | 1.10 → 1.01 | 1.08 → 1.05 | 1.15 → 1.06    | 1.01 → 0.98 | 1.19 → 1.04 | 1.42 → 1.32 |
| complex | graphql | 1.06 → 1.41 | -           | 1.04 → 1.00    | 0.96 → 1.20 | 0.96 → 0.97 | 1.51 → 1.26 |
| hooks   | local   | 1.20 → 1.23 | 1.08 → 1.10 | 1.01 → 1.04    | 1.05 → 1.04 | -           | -           |
| hooks   | rest    | 1.04 → 1.11 | 0.97 → 0.98 | 0.92 → 0.89    | 0.91 → 0.91 | -           | -           |
| hooks   | graphql | 1.03 → 1.11 | -           | 0.96 → 0.98    | -           | -           | -           |

The complex shape's writes now fuse where their result read does not populate: GraphQL
`createPost` 1.41x and `deletePost` 1.20x of TS (both 1.0 with fused writes off; `updatePost`
stays on the exact lane: the collection's update access returns a where constraint). Its Local
API and REST writes (default depth 2) populate `author`, and the `authors` collection has a join
field, which the fused reads do not serve: they run the exact lane through the backoff, at the
`off` speed (the passes spread by up to 20% per scenario; before the backoff its partial updates
were 0.84x against 1.06x off). The hooks shape never fuses a write (every hook increments a
captured counter): its on / off columns run the same code. An earlier set of three passes put the
hooks rows at 0.89-1.15 on both sides, the spread of single processes on this machine.

**WP-S (2026-11-26)**: unnamed groups and radio fields in the prepare (section 12.6),
`maxPerDoc` in the update drivers, join fields in fused population and `findByID`
(FUSE_CONTRACT.md section 8).

- **maxPerDoc** (`by_id.rs`, also update-many's documents): after the version statements,
  `enforceMaxVersions`' find; when it returns a version whose `updatedAt` is a Date (`null` /
  absent: upstream deletes nothing; anything else bails `byID:maxVersions:updatedAt`), the
  `delete` of `deleteVersions` in the transaction: the template `md` is db-mongodb's `buildQuery`
  of `{ updatedAt: { less_than_equal }, parent: { equals } }` (the found version's read-transformed
  ISO string, which the cast turns back into the same Date), cast by mongoose, built with the
  sentinel id and a sentinel date `ms` that the driver replaces by the found `updatedAt`. The
  `byID:maxVersions` backoff is gone with the bail.
- **Joins**: the read plans of collections with join fields are eligible on MongoDB (other
  adapters: `joins`); the core populates a join's `docs` like `relationshipPopulationPromise`.
  Population's nested finds of a collection with joins and `findOne` reads run db-mongodb's join
  aggregation (`aggregatePaginate` with `buildJoinAggregation`'s stages, re-stated for one
  collection, `where: {}`, not localized, no drafts), in the fused write's transaction for a
  write's result read (driver crate: the additive `aggregate_docs_raw`). The complex shape's
  Local API writes, which populate `author` at depth 2, now fuse. Not served yet:
  without `overrideAccess` (`mongo:populate:joins:access`: `sanitizeJoinQuery` runs the joined
  collection's read access, a where constraint in the complex shape: its REST writes still back
  off on `populate:related`), `find` with join stages (`joins:find`: `aggregatePaginate`'s result
  meta), join queries with values (`joins:where` / `sort` / `limit`), localized joins.
- **Write lane-shadow**: shadowed by-id writes of one document run one at a time
  (`serializedPerDocument`): test/versions' 100 parallel draft saves of one document (now fused:
  the unnamed group) otherwise reported write conflicts of the exact lane caused by the other
  calls' shadow transactions, and state reads that saw the other calls' versions (52 differences
  in the first run, 0 after). Outside shadow mode, a write conflict in the fused transaction aborts
  it and the call reruns on the exact lane (D1: which of the racing calls fail is an interleaving
  outcome on both lanes).

Measured, full MongoDB harness with `--fuse shadow --fuse-writes shadow` (WP-P's run `wpp_mf3` →
WP-S's `wps_mf`; test/versions rerun alone after the shadow fix: 153 / 0 / 0, 0 differences):

| lane   | hits        | bails       | guards      | ineligible  |
| ------ | ----------- | ----------- | ----------- | ----------- |
| writes | 4508 → 4853 | 1434 → 1040 | 2661 → 2663 | 3813 → 3811 |
| reads  | 3448 → 3469 | 277 → 283   | 5273 → 5283 | 3188 → 2959 |

Writes: updateByID 168 → 433, create 3887 → 3962; `plan:group:unnamed` 454 → 0,
`plan:field:radio` 6 → 0, `byID:maxVersions` 2 → 0, `populate:related` 142 → 129. Reads:
ineligible `joins` 285 → 102, findByID hits 920 → 948, `populate:related` 27 → 24; new guards
`mongo:joins:find` 21, `mongo:joins:localized` 4, `mongo:joins:where` 2. The newly eligible
`Drafts` calls next stop at `plan:schema:default` 40 and, in the race test, write conflicts
(42 bails). Largest left on the write path: `plan:json:jsonSchema` 141, `plan:date:timezone` 131,
`populate:related` 129 (REST writes populating a collection with joins), guards `transaction`
765, `file` 605; ineligible collection hooks (`hooks:beforeRead` 777, `hooks:afterRead` 623).

Bars on the final tree (release addon, mongod 8.2 rs0): the harness with `--engine default`
3330 / 164 / 422, equal to `.rs-baseline/mongodb-all.json` (test/cli differs by the worktree path;
storage emulators and hmr absent; fused writes served: 3953 creates, 525 updateByID, 234
deleteByID, 4 update-many, 216 delete-many; fused read hits 3460), the harness with both shadows
3330 / 164 / 422 and 0 lane differences (above); the 8 shadow files 971 / 0 / 46, 0 divergences;
parity 503/503 (twice); driver lane 4/4; glue 33/33; HTTP lanes 18/18; fn-compile 39/39; the
corpus 28/28 (385 cases); the lane suites 89/89 in default and with both shadows (new:
`fuse-populate/joins.int.spec.ts`, Drafts-shaped unnamed groups and radios in
`drafts-localized`, `maxPerDoc` past the limit with and without drafts, incl. update-many, in
`drafts`); SQLite with `--fuse shadow` equal to `.rs-baseline/sqlite-all.json` by relative path
(test/cli: the worktree path; create-payload-app: 11 baseline failures pass), 0 lane
differences; packaging OK.

Perf (WP-S, test/__rs/perf, MongoDB 1k posts, release addon, packed install verified against
the builds, 3 interleaved rounds per cell, CPUs 22-31; `ts/rs` per category: the geometric mean
of the per-round geomeans of the scenarios' TS / variant medians, [95% t interval over the
rounds]; `off` = `rs-fused-off` → `on`):

| shape   | surface | read                                | create                              | update                              | partial-update                      | delete                              |
| ------- | ------- | ----------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| typical | local   | 1.41 [1.36-1.45] → 1.37 [1.09-1.73] | 1.10 [1.07-1.13] → 1.35 [0.90-2.03] | 1.03 [0.99-1.08] → 1.83 [1.34-2.50] | 1.00 [0.94-1.06] → 1.79 [0.87-3.70] | 1.00 [0.93-1.07] → 1.15 [0.46-2.91] |
| typical | rest    | 1.44 [1.43-1.46] → 1.49 [1.25-1.77] | 1.03 [0.91-1.15] → 1.13 [0.59-2.14] | 0.98 [0.92-1.04] → 1.15 [0.81-1.65] | 1.03 [0.96-1.11] → 1.53 [1.19-1.96] | 0.96 [0.79-1.17] → 0.82 [0.52-1.31] |
| typical | graphql | 1.19 [0.91-1.55] → 1.20 [0.81-1.78] | 1.08 [0.98-1.19] → 0.90 [0.82-0.99] | -                                   | 0.99 [0.96-1.03] → 1.38 [0.55-3.44] | 0.96 [0.91-1.02] → 1.07 [0.43-2.69] |
| complex | local   | 1.30 [0.92-1.84] → 1.33 [1.09-1.63] | 1.09 [1.07-1.12] → 1.29 [1.18-1.41] | 1.06 [1.03-1.09] → 1.62 [1.42-1.85] | 1.04 [1.00-1.09] → 1.46 [1.40-1.52] | 1.00 [0.99-1.01] → 1.04 [0.70-1.53] |
| complex | rest    | 0.95 [0.63-1.42] → 0.97 [0.71-1.31] | 1.04 [0.93-1.17] → 0.96 [0.94-0.99] | 1.03 [0.91-1.16] → 0.96 [0.88-1.06] | 1.01 [0.91-1.12] → 0.98 [0.92-1.04] | 0.96 [0.83-1.11] → 0.90 [0.80-1.00] |
| complex | graphql | 1.18 [0.95-1.47] → 1.11 [0.83-1.47] | 1.10 [0.97-1.23] → 1.06 [0.70-1.62] | -                                   | 1.05 [1.02-1.08] → 0.98 [0.89-1.07] | 0.98 [0.84-1.14] → 1.12 [0.76-1.64] |

The complex shape's Local API writes are now fused (WP-P: 1.0-1.2 on both sides): per round,
`create` 1.85 / 1.87 / 2.21 (off 1.07-1.13), `create depth 1` 1.83 / 1.99 / 1.32, `update by id`
1.31-1.52, `update many` 1.92-2.11, the partial updates 1.29-1.59 (off 0.95-1.10). Its REST writes
still populate `author` without `overrideAccess` and back off on `populate:related`
(`mongo:populate:joins:access`), at the `off` speed. Wide intervals of the typical `on` cells come
from single slow processes: typical `DELETE /posts?where` measured 16.5-16.7 ms in all three
rounds of the full run (TS 10.4-10.8, off 10.1-11.7) and 11.4 / 11.4 / 16.9 ms run alone (TS
10.8-11.2), where the slow process was also slow on its other fused writes (`POST /posts` 12.4
against 5.7-6.0 ms): the per-process placement / wake-up mode of the perf README, not a code path
of this change (typical has no versions, joins or unnamed groups).

What is left (WP-S), largest first: REST / GraphQL population of collections with joins without
`overrideAccess` (evaluate the joined collection's compiled read access per call like
`relatedEntry`'s `access`, `$match` = the uncast `buildFilter` of the where; complex REST writes
and reads), `find` with join stages (`aggregatePaginate`'s result meta in payload-fuse-mongo),
join queries with `limit` / `sort` / `where` values, `plan:json:jsonSchema` 141,
`plan:date:timezone` 131, `plan:schema:default` 40 (the `Drafts` collection's next stop), the
collection hooks (not compiled: side effects).

**WP-V (2026-11-26)**: two suspected fused-write regressions of WP-S's perf run, and the write
plan widened at its largest remaining bails (section 12.6: json schemas, timezones, document array
defaults; the dispatch's row-id count of default rows).

Regressions, measured with focused interleaved A/Bs (test/__rs/perf, typical, 1k posts, `ts`,
`rs`, `rs-fused-off`, 5 processes per engine, wall and CPU per op; `ts/x` geomean over the rounds
[95% t interval]) on two CPU sets (16-19 and 18-21, E-cores; the main session's and WP-U's
harness runs were busy on 0-15 and 22-31), plus each lane alone with `perf stat` user-space
instructions and cycles counted over the timed iterations only (4 processes per engine, CPUs
16-19):

| scenario                  | CPUs  | `ts/rs` wall     | `ts/rs` CPU      | `ts/off` wall    | alone: ms, M instr. / op (rs, off, ts) |
| ------------------------- | ----- | ---------------- | ---------------- | ---------------- | -------------------------------------- |
| GraphQL `createPost`      | 16-19 | 1.50 [1.35-1.66] | 1.61 [1.34-1.94] | 1.12 [1.06-1.18] | 3.79 / 10.9, 5.42 / 11.5, 6.30 / 13.7  |
| GraphQL `createPost`      | 18-21 | 1.29 [1.27-1.31] | 1.61 [1.45-1.79] | 1.03 [0.93-1.14] |                                        |
| `DELETE /posts?where` (5) | 16-19 | 0.97 [0.92-1.03] | 0.83 [0.81-0.86] | 0.98 [0.91-1.06] | 9.43 / 16.5, 10.19 / 15.4, 9.87 / 18.8 |
| `DELETE /posts?where` (5) | 18-21 | 0.92 [0.85-1.00] | 0.85 [0.77-0.93] | 0.98 [0.89-1.07] |                                        |

- **GraphQL create: ruled out.** The fused create is 1.3-1.5x of TS and ~1.4x of fused writes
  off on both CPU sets, and does fewer instructions and cycles than either (10.3 M cycles against
  13.8 off and 15.3 TS). WP-S's 0.90x [0.82-0.99] came from its run's placement and load.
- **REST bulk delete: not a fused write.** `DELETE /posts?where` carries no `overrideAccess` and
  the typical posts populate relationships: the bulk dispatch guards it (`access:populate`, the
  bulk writes have no per-call field access / population access yet, unlike the by-id ones), so
  `rs` and `rs-fused-off` run the same exact-lane delete. In 25 processes on two CPU sets no
  process showed WP-S's 16.6 ms mode; wall time is at TS's (alone 9.4 ms against TS 9.9). The
  `rs` processes use ~15% more CPU per op in the window than TS: with setups whose creates run on
  the exact lane (`disableTransaction`), `rs` and `off` are equal (6.6 against 6.9 ms CPU, 15.9
  against 15.3 M instructions: the bulk dispatch's checks before its guard), so the rest is the
  Rust threads of the setup's fused creates finishing while the timed delete runs, not work of
  the delete. Nothing to fix on the write path; fusing it needs the bulk writes' field and
  population access per call (the by-id writes' WP-C / WP-M treatment).

Widening (`--fuse shadow --fuse-writes shadow`, the full harness; WP-S's run `wps_mf` → WP-V's
`wpv_mf`): `plan:json:jsonSchema` 141 → 0, `plan:date:timezone` 131 → 0, `plan:schema:default`
40 → 0 (all of them test/fields' calls, not test/versions'), and the creates of default rows that
then stopped at `prepare:entropy:objectId` (34) → 0. test/fields' fused writes 102 → 412 hits
(creates 8 → 310, updateByID 1 → 9); its remaining bails are `plan:field:slug` 78,
`plan:field:ui` 37, `prepare:fn:verify` 33 (guard sampling). Over the files neither run reran
(27 reruns, most of them load timeouts: the machine's load average reached 235 during the run),
write hits 4333 → 5243, bails 990 → 667, 0 lane differences (WP-S's run had 52, before its
serialization fix). Fused writes served with `--engine default` (`wpv_m`): 4254 creates, 533
updateByID, 234 deleteByID, 4 update-many, 216 delete-many (WP-S: 3953 / 525 / 234 / 4 / 216).

Bars on the final tree (release addon, mongod 8.2 rs0): the harness with `--engine default` and
with both shadows 3330 / 164 / 422 with each file's solo rerun, equal to
`.rs-baseline/mongodb-all.json` (test/cli differs by the worktree path; storage emulators and hmr
absent), 0 lane-shadow differences; the 8 shadow files 971 / 0 / 46, 0 divergences; parity
503/503 (twice); driver lane 4/4; glue 33/33; HTTP lanes 18/18; fn-compile 39/39; the corpus
35/35 (444 cases); the lane suites 91/91 in default and with both shadows (new: a json schema
and timezone collection through create / update / update-many / delete with invalid inputs,
array / blocks / group defaults); packaging OK.

Perf (WP-V, test/__rs/perf, MongoDB 1k posts, release addon, packed install verified against
the builds, 3 interleaved rounds per cell, CPUs 16-21, write categories only; `ts/rs` per
category: the geometric mean of the per-round geomeans of the scenarios' TS / variant medians,
[95% t interval over the rounds]; `off` = `rs-fused-off` → `on`):

| shape   | surface | create                              | update                              | partial-update                      | delete                              |
| ------- | ------- | ----------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| typical | local   | 1.10 [1.02-1.18] → 1.52 [1.31-1.78] | 0.99 [0.97-1.02] → 1.90 [1.35-2.70] | 1.00 [0.93-1.08] → 1.91 [1.41-2.58] | 0.99 [0.91-1.07] → 1.45 [1.25-1.68] |
| typical | rest    | 1.02 [0.89-1.16] → 1.17 [0.99-1.38] | 1.01 [0.97-1.05] → 1.06 [0.73-1.54] | 1.00 [0.89-1.11] → 1.75 [1.06-2.91] | 0.98 [0.85-1.13] → 1.05 [0.70-1.58] |
| typical | graphql | 1.08 [0.89-1.30] → 1.21 [0.67-2.18] | -                                   | 0.99 [0.94-1.04] → 1.80 [1.18-2.74] | 0.98 [0.84-1.15] → 1.11 [0.57-2.15] |
| complex | local   | 1.10 [1.05-1.14] → 1.41 [1.02-1.94] | 1.07 [1.05-1.10] → 1.89 [1.11-3.23] | 1.05 [1.02-1.07] → 1.84 [1.14-2.95] | 1.02 [0.95-1.09] → 1.26 [0.86-1.86] |
| complex | rest    | 1.04 [1.00-1.09] → 0.97 [0.85-1.09] | 1.06 [0.96-1.16] → 0.97 [0.88-1.07] | 1.01 [0.94-1.09] → 0.95 [0.90-0.99] | 1.00 [0.99-1.01] → 0.96 [0.88-1.04] |
| complex | graphql | 1.14 [1.05-1.24] → 1.42 [1.02-1.96] | -                                   | 1.07 [1.05-1.10] → 0.98 [0.95-1.01] | 0.97 [0.89-1.05] → 0.98 [0.71-1.36] |

All write scenarios together (`rs` against TS): typical 1.52x [1.31-1.76] (14 confidently faster,
0 slower), complex 1.39x [1.11-1.74] (11 faster, 3 slower). The three confidently slower ones are
complex: REST `DELETE /posts/:id` 0.89x [0.80-1.00] and `PATCH /posts/:id (one field)` 0.95x
[0.90-0.99], Local `create as draft` 0.96x [0.93-0.99]; on them `rs-fused-off` was 5-9% faster
than `rs` (0.94-1.03x of TS), so the fused dispatch costs there. Counted in a bench process (stats
dir), the complex REST by-id writes mostly run the exact lane after the dispatch's checks (guard
sampling of the compiled access in the scenarios' first calls, `access:verify` 64;
`access:where` 20; `prepare:fn:verify` 35; `backoff:populate:related` 18), and 5 of about 110 run
the fused statements, bail `populate:related` (joins without `overrideAccess`, WP-U's) and rerun:
the cost of those attempts and of the checks, in scenarios short enough that sampling's first 32
calls dominate. `create as draft` was not attributed. The typical shape (no json
schemas, timezones or array defaults) runs the same write code as before this package.

What is left (WP-V), on the write side: the bulk writes without `overrideAccess` (field access
per call, population access, `access:populate` / `access:fields`), localized json fields with a
schema, the schema keywords not converted (`pattern` / `format` need JS regex and zod's formats),
`plan:field:slug` 78, `prepare:drafts:localizedPublish:unique` 90, `plan:field:condition` 75,
`populate:related` (joins without `overrideAccess`, WP-U).

**WP-U (2026-11-26)**: join fields without `overrideAccess`, finds with join stages, join query
values and localized joins on the read side (FUSE_CONTRACT.md sections 3, 8 and 9); the write
dispatch is unchanged. `sanitizeJoinQuery` is re-stated by `fusedJoinQuery` (src/fuse/joins.ts):
the joined collections' compiled read access is combined into each join's `where` (evaluated
through `evaluateOnLane` by the operation's own read; predicted for population's nested finds and
evaluated again by the core where each one runs, `nested_join_access`, guard sampling there), and
the caller's `joins` object gets upstream's in-place changes replayed. A nested find whose
collection's read access returns a where (predicted only for functions seen returning one)
combines it into its reads (`accessFilter` / `accessMatch`, checked by the core). `find` with join
stages runs `aggregatePaginate` with its result meta in Rust (`aggregate_page_result`). Found on
the way: findByID's own population keys carry its `overrideAccess = false` default (a REST
findByID's keys held `null`), the nested aggregations send `aggregatePaginate`'s `$skip: 0`, and a
join field's own `where` reaches its `$match`.

Measured, full MongoDB harness with `--fuse shadow --fuse-writes shadow` (WP-S's `wps_mf` →
WP-U's `wpu_mf2`; reads hits / bails / guards / ineligible): 3469 / 283 / 5283 / 2959 → 3566 /
277 / 5286 / 2995, findByID hits 948 → 974, find 2477 → 2540; gone: `mongo:joins:find` 21,
`mongo:joins:localized` 4, `mongo:joins:where` 2; new: `joins:access:verify` 3 (guard sampling).
Writes: hits 4853 → 4947 (updateByID 433 → 526), `populate:related` 129 → 126 (what remains are
result reads loading collections whose read plans are ineligible: uploads, polymorphic joins,
collection hooks). Lane differences 0 (both lanes).

Bars on the final tree (release addon, mongod 8.2 rs0): the harness with `--engine default` 3330 /
164 / 422, equal to `.rs-baseline/mongodb-all.json` (test/cli differs by the worktree path; storage
emulators and hmr absent; fused read hits 3512, fused writes 3954 creates, 485 updateByID, 234
deleteByID, 4 update-many, 216 delete-many), the harness with both shadows 3330 / 164 / 422 and 0
lane differences; the 8 shadow files 971 / 0 / 46, 0 divergences; parity 503/503 (twice); driver
lane 4/4; glue 33/33; HTTP lanes 18/18; fn-compile 39/39; the corpus 28/28; the lane suites 94/94
in default and with both shadows (new: `fuse-populate/joins-access.int.spec.ts`: a where-returning
and a denying joined access at depth 3, REST reads of a collection with joins incl. a paginated
find, the replayed `joins` object, join query `limit` / `page` / `count` / `sort` / `where`,
localized joins; 22/22 of fuse-populate on the TS engine); SQLite with `--fuse shadow` equal to
`.rs-baseline/sqlite-all.json` by relative path (test/cli: the worktree path; create-payload-app:
11 baseline failures pass), 0 lane differences; packaging OK.

Perf (WP-U, test/__rs/perf, MongoDB 1k posts, release addon, packed install verified against the
builds, 3 interleaved rounds per cell, CPUs 22-31; `ts/rs` per category as in WP-S's table, [95% t
interval over the rounds]; before = rust-engine-port at ff46138b, after = this tree):

| shape   | surface | read                                | create                              | update                              | partial-update                      | delete                              |
| ------- | ------- | ----------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| typical | local   | 1.52 [1.26-1.85] → 1.68 [1.56-1.81] | 1.50 [1.32-1.70] → 1.60 [1.47-1.74] | 2.23 [1.73-2.88] → 2.37 [2.25-2.50] | 2.12 [1.63-2.75] → 2.21 [1.74-2.80] | 1.40 [0.58-3.35] → 1.52 [1.29-1.81] |
| typical | rest    | 1.49 [1.32-1.69] → 1.51 [1.39-1.64] | 1.30 [1.12-1.51] → 1.12 [0.62-2.02] | 1.38 [1.34-1.42] → 1.27 [1.14-1.43] | 1.87 [1.39-2.51] → 1.82 [1.40-2.37] | 1.25 [1.02-1.53] → 1.18 [0.69-2.01] |
| typical | graphql | 1.27 [1.04-1.56] → 1.22 [1.02-1.45] | 1.29 [0.87-1.92] → 1.10 [0.59-2.04] | -                                   | 1.82 [1.08-3.09] → 1.73 [1.24-2.43] | 1.24 [0.75-2.03] → 1.06 [0.65-1.75] |
| complex | local   | 1.62 [1.50-1.74] → 1.69 [1.60-1.78] | 1.38 [1.19-1.60] → 1.51 [1.47-1.56] | 2.19 [1.70-2.83] → 2.45 [2.42-2.47] | 1.90 [1.29-2.79] → 2.19 [2.03-2.37] | 1.45 [1.24-1.69] → 1.32 [1.27-1.37] |
| complex | rest    | 1.12 [0.97-1.30] → 1.30 [1.10-1.53] | 0.99 [0.88-1.11] → 1.18 [0.82-1.71] | 0.96 [0.93-0.99] → 0.95 [0.95-0.95] | 0.95 [0.83-1.09] → 0.91 [0.86-0.95] | 0.89 [0.74-1.07] → 1.17 [1.03-1.32] |
| complex | graphql | 1.31 [1.07-1.61] → 1.31 [1.10-1.55] | 1.59 [1.35-1.87] → 1.34 [0.80-2.26] | -                                   | 0.97 [0.93-1.00] → 0.96 [0.87-1.05] | 1.06 [0.53-2.13] → 1.26 [1.03-1.54] |

Per round, complex REST (before → after): `GET /posts/:id` 0.60 / 0.68 / 0.61 → 1.13 / 1.29 / 1.07
(its default depth 2 populates `author`, whose join to the posts now fuses), `GET /posts limit 10
depth 2` 1.00 / 0.82 / 1.02 → 1.18 / 1.30 / 1.11, `POST /posts` 0.92 / 1.04 / 0.96 → 0.94 / 1.64 /
1.70, `DELETE /posts/:id` 0.99 / 0.91 / 0.86 → 1.25 / 1.51 / 1.53. The complex REST updates
(`PATCH /posts/:id`, 0.86-0.93) stay on the exact lane: the posts' update access returns a where
constraint, which the write guard refuses (`access.update` must compile to `true`). The typical
and GraphQL cells run the same code on both trees; their differences are within the intervals.
A first set of post-change rounds measured the depth-2 REST read at 0.82-1.04: per call, the
population request predicted every related collection's read access in JS (an evaluation with a
request snapshot each) and the text lane built a populating request before refusing it; only
functions seen returning a where are predicted now, the nested backends are cached and the text
lane refuses before building (second commit).

What is left (WP-U): where-returning update / delete access in the fused writes (the complex
REST `PATCH`), write result reads loading collections with ineligible read plans
(`populate:related` 126), polymorphic joins (`joins` ineligible 129 read calls), join queries with
relationship-path `where`s (sub-queries), `locale: 'all'` joins, joins of draft collections read
with `draft`.

**WP-V, second round (2026-11-26)**:

- **Bulk writes without `overrideAccess`.** update-many / delete-many no longer guard
  `access:fields` / `access:populate`: their result read (`fusedPageRequest`, now read as an
  operation result) takes the call's `overrideAccess`, with the compiled field read access and
  population access per call as the by-id writes' result reads. Two upstream behaviours the
  REST path exposed: `disableBulkDelete` without `overrideAccess` throws in delete.ts (guarded,
  `disableBulkDelete`; this guard was missing before, a latent difference for collections without
  relationships), and with `overrideLock: false` `getLockedDocumentIds` reads the clock after its
  lock find (the bulk delete now takes that reading, which the write lane-shadow caught as an
  unmatched clock reading). Lane suite: REST `PATCH` / `DELETE /notices?where` and Local
  update-many / delete-many with a user, field read access and population of a collection whose
  read access depends on the user, a `disableBulkDelete` collection (403).
- **Work that cannot succeed is skipped before it starts.**
  - `populate:unserved`: `populationRequest` now also returns the collections it leaves
    unserved (`unserved`); a create or update whose `data` references one is guarded before the
    native call. The unserved collections of a read shape (depth, draft, `overrideAccess`,
    `payloadAPI`, locales; no `populate`) are remembered per read plan, so later calls of that
    shape decide the guard and the `populate:related` backoff before building their result
    read. A stale entry can only send a call to the exact lane.
  - The by-id drivers check the stored document right after its read: a value at a stored path
    of a relationship to an unserved collection (`up`, from the dispatch) bails before any
    statement, where it used to bail after the writes and their abort.
  - `fn:warmup`: the write plan lists the compiled user functions every prepare uses (field
    hooks and, unless the call skips validation, validators of fields outside array / block
    rows). While one is still in guard sampling's first calls or de-optimised
    (`fnIrLaneInWarmup`, which counts nothing, the first branch of `lane_should_verify`),
    creates and updates skip their prepare; updates no longer open a transaction only to bail
    `fn:verify`.
- **`create as draft` (complex)**: its draft result read populates `author`, and `authors` (a
  join on a localized collection) is unserved under drafts; with the backoff reset by the
  scenario's successful teardown deletes every few calls ran the fused statements, bailed
  `populate:related` and reran. Now `populate:unserved` (50 of 50 calls in a bench process).

Measured, full harness with both shadows (`wpv_mf` → `wpv2_mf`, first runs only): write hits
5242 → 5244, bails 663 → 512 (`populate:related` 109 → 16, `prepare:fn:verify` 67 → 0,
`fn:warmup` 0 → 74), guards `populate:unserved` 0 → 155, `access:populate` 7 → 0,
`access:fields` 3 → 0; 0 lane differences.

Perf (5 interleaved rounds, CPUs 16-21; `off/rs`: `rs-fused-off` median / `rs` median, > 1 is `rs`
faster): typical REST `DELETE /posts/:id` 1.74 [1.40-2.15], `PATCH /posts/:id` 2.02
[1.85-2.20], `DELETE /posts?where` 1.12 [0.85-1.47], `PATCH /posts?where` 0.98 [0.95-1.02];
complex REST `DELETE /posts/:id` 0.93 [0.89-0.97], `PATCH /posts/:id (one field)` 0.97
[0.96-0.99], `PATCH /posts?where` 0.94 [0.90-0.98], `DELETE /posts?where` 0.88 [0.74-1.04],
Local `create as draft` 0.97 [0.95-1.00] (it was 0.95 [0.93-0.97] before this round). The bar
(≥ `rs-fused-off`) is not met on the complex ones. In a CPU profile of guarded draft creates
(exact teardowns, so both variants run the same exact lane) the whole dispatch is 0.29 ms per
call (0.18 of it the result read, now skipped for known shapes), while `rs` measured 1.3 ms wall
and 1.8 ms CPU above `rs-fused-off` (GC counts and times equal). Most of the gap is therefore
outside the JS dispatch: process state the fused seeding and setups leave (the Rust runtime's
threads, see the idle-wake effect above) is the remaining suspect, not confirmed. The REST
bulk writes of both shapes mostly run inside the access functions' sampling window in the perf
suite's ~20-iteration scenarios (`access:verify`), so they run the exact lane there.

Not done in this round: `plan:field:slug` (78: generateSlug's hook reads the database through
`fieldValueExists` / `getUniqueFieldValue` / `getSlugFallbackValue` and slugifies),
`prepare:drafts:localizedPublish:unique` (90: `validateUniqueConstraints` runs a `payload.find`
per unique value outside the transaction, `limit: 2`, `depth: 0`, `overrideAccess: true`; a
conflict only ever bails, so the prepare can return the lookups it needs, field path, locale and
value, for the drivers to run without a session before any statement, with filters templated in
JS from db-mongodb's `buildQuery` of `{ [path]: { equals } }` and the value substituted
natively), localized json fields with a schema, and the `pattern` / `format` keywords.

**WP-W (2026-11-27)**: where-constraint update / delete access, the all-locales publish
validation's unique lookups, slug fields.

- **Update / delete access returning a where** (the perf suite's complex posts). Upstream
  (updateByID.ts, deleteByID.ts) combines the access result with the id
  (`combineQueries({ id: { equals } }, accessResults)`) only in the stored-document read:
  `getLatestCollectionVersion` (with drafts first the latest version's `findVersions` with the
  where's version keys, then the main `findOne`) or deleteByID's `findOne`; the `updateOne` /
  `deleteOne` filters are the id alone. No document: `Forbidden` with a where policy, else
  `NotFound`. The dispatch evaluates the compiled access per call (`evaluateCompiledAccess`,
  guard sampling through `evaluateOnLane`) and the result read's `findOne` takes the combined
  where (`fusedFindByIDRequest(args, storedAccess)`, encoded by the fused reads' `buildFilter` /
  mongoose cast; its `afterRead` still runs on the written document); with drafts the request
  carries `tl`, the latest version's find built for that where (`latestAccessTemplate`, a cache
  per versions model, where and locale, with the sentinel id). A miss bails `byID:notFound` in the
  transaction and the exact lane throws upstream's `Forbidden` / `NotFound`. update-many /
  delete-many: update.ts / delete.ts combine the result into the bulk find
  (`combineQueries(where, accessResult)`), so the fused find does too; a where that
  `sanitizeWhereQuery` would rewrite (virtual paths) guards `access:where:sanitize`. The
  `access:where` guard is gone.
- **Unique lookups of the all-locales publish validation** (`prepare:drafts:localizedPublish:unique`,
  test/database's `categories`). `validateUniqueConstraints` runs per locale pass on
  `deepMergeWithSourceArraysIgnoringUndefined(originalDoc, beforeChange's result)`: one
  `fieldValueExists` (`payload.find`, `limit: 2`, `depth: 0`, `overrideAccess: true`,
  `pagination: false`, the pass's locale, without the transaction) per unique field with a value
  that is not `null` / `undefined`, a conflict (`docs.some((doc) => doc.id !== id)`) a
  `ValidationError`. The prepare (`prepare/unique.rs`) collects these lookups in `traverseFields`
  order (`PreparedWrite.unique`; rows of arrays / blocks holding unique fields, localized groups
  / tabs and dotted keys bail) instead of bailing for every collection with a unique field; the
  create driver (`ops::unique_lookups`, `u` / `ut`) and `by_id::update_document` (also each
  document of an update-many) run them with no session before any statement
  (`crates/payload-fuse-write/src/unique.rs`); a conflict bails
  (`drafts:localizedPublish:unique:conflict`, the exact lane throws). The finds are templates
  per unique path and locale (`uniqueLookupTemplates`: db-mongodb's `buildQuery` of `{ [path]: {
  equals } }` with a sentinel string, number or ObjectId, mongoose's cast, the find operation's
  default sort, `limit: 2`); the driver puts the value in the sentinel's place (strings, numbers
  as js-bson serializes them, 24-hex relationship ids as ObjectId and string). A unique compound
  index (`sanitizedIndexes`) now bails `drafts:localizedPublish:uniqueIndex`: the prepare used to
  skip that check for collections without unique fields.
- **Slug fields** (`plan:field:slug`, test/fields). A `slug` field is a text field whose
  `beforeChange` is `generateSlug` (`slugBeforeChange`, `:custom` with a `slugify` option) and
  whose validator is the `() => true` `validations.slug`. Every branch of the hook but two reads
  the database (`fieldValueExists`, `getUniqueFieldValue`, `getSlugFallbackValue`, and
  `fillEmptyLocalizedSlugs` on creates); the prepare runs the two that do not, on updates: a value
  that `slugify` (payload `utilities/slugify.ts`, ECMAScript `trim`) turns into the stored slug
  (`originalDoc[name]`, the top-level document's) returns it after one more tick (`await
  slugify(value)`), and no usable value with a stored slug returns the stored slug. Everything
  else bails exactly there: creates and new values `slug:lookup`, a custom `slugify` reached
  `slug:slugify`, a non-string value `slug:value`; a `req.context` holding
  `_slugDuplicateFallbackFields` (a duplicate's mark, which the hook consumes) bails
  `context:slugDuplicate` before the prepare. Slug fields count as unique strings for the unique lookups above.

Corpus (`PAYLOAD_ENGINE=ts`): groups `unique publish` (16, localized config: unique text,
number in a group and relationship in nested named tabs and a row; creates and updates with and
without values, taken values, values from the stored document, a draft, rows, a unique compound
index) and `slugs` (12); the harness records upstream's `fieldValueExists` finds and compares them
with the prepare's lookups (as multisets: the passes may run concurrently), and a lookup upstream
found taken counts as a bail (`unique:conflict`, the drivers bail there). 472 cases: 402 equal (295
written, 107 invalid), 70 bails, 0 differences. Lane suites: a where-constraint collection by id,
REST, update-many, delete-many and drafts (`Forbidden` for a stored document outside the
constraint, a latest version outside it falling back to the main document), unique lookups on
creates, updates and an update-many with a conflict, slug updates kept / taken / renamed.

Measured, full MongoDB harness with `--fuse shadow --fuse-writes shadow` (`wpv2_mf` → `wpw_mf`):
write hits 5255 → 5352 (creates 4264 → 4353, updateByID 533 → 541), bails 512 → 416
(`prepare:drafts:localizedPublish:unique` 90 → 0, none of test/database's calls has a unique
value; `plan:field:slug` 78 → `prepare:slug:lookup` 65 and `prepare:slug:slugify` 5: test/fields'
slug writes are mostly creates, which always look up), guards 2838 → 2836, ineligible 3814 →
3807; 0 lane-shadow differences, 0 fused-write differences.

Bars on the final tree (release addon, mongod 8.2 rs0): the harness with `--engine default` 3330 /
164 / 422, equal to `.rs-baseline/mongodb-all.json` (test/cli differs by the worktree path;
storage emulators and hmr absent; the plugin-ecommerce settlement test passed; fused writes
served: 4351 creates, 541 updateByID, 234 deleteByID, 6 update-many, 215 delete-many), the harness
with both shadows 3330 / 164 / 422 and 0 lane differences (above; run before the last commit, which
only adds the `context:slugDuplicate` bail); the 8 shadow files 971 / 0 / 46, 0 divergences; parity
503/503 (twice); driver lane 4/4; glue 33/33; HTTP lanes 18/18; fn-compile 39/39; the corpus 37/37;
the lane suites 101/101 in default and with both shadows, the write lane suites 70/70 on the TS
engine; packaging OK.

Perf (WP-W, test/__rs/perf, MongoDB 1k posts, release addon, packed install verified against the
builds, 3 interleaved rounds per cell, CPUs 22-31, write categories; `ts/x` per category: the
geometric mean of the per-round geomeans of the scenarios' TS / variant medians, [95% t interval
over the rounds]; `off` = `rs-fused-off` → `on`):

| shape   | surface | create                              | update                              | partial-update                      | delete                              |
| ------- | ------- | ----------------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| typical | local   | 1.11 [1.08-1.15] → 1.46 [0.86-2.48] | 1.02 [0.98-1.07] → 2.30 [1.89-2.80] | 1.02 [0.97-1.08] → 2.07 [1.52-2.82] | 0.97 [0.91-1.03] → 1.63 [1.33-1.99] |
| typical | rest    | 1.05 [1.00-1.10] → 1.17 [0.83-1.66] | 1.01 [0.84-1.21] → 1.23 [1.08-1.40] | 1.04 [0.95-1.14] → 1.50 [0.97-2.30] | 0.97 [0.84-1.13] → 1.29 [0.94-1.77] |
| typical | graphql | 1.11 [0.97-1.28] → 1.51 [1.19-1.92] | -                                   | 1.01 [0.95-1.08] → 1.89 [1.55-2.30] | 1.03 [0.74-1.45] → 1.39 [0.99-1.96] |
| complex | local   | 1.09 [1.05-1.13] → 1.41 [1.40-1.42] | 1.04 [1.03-1.06] → 1.98 [1.13-3.45] | 1.04 [1.03-1.04] → 1.70 [1.34-2.15] | 0.99 [0.90-1.09] → 1.22 [0.78-1.91] |
| complex | rest    | 1.02 [0.95-1.09] → 1.21 [0.83-1.77] | 1.04 [0.90-1.19] → 1.49 [1.32-1.69] | 1.04 [0.98-1.12] → 1.73 [1.06-2.80] | 0.99 [0.97-1.01] → 1.13 [0.70-1.82] |
| complex | graphql | 1.06 [0.98-1.15] → 1.17 [0.58-2.34] | -                                   | 1.04 [1.00-1.08] → 1.57 [1.11-2.21] | 0.97 [0.91-1.03] → 1.09 [0.90-1.31] |

The complex shape's where-constraint updates now fuse: REST `PATCH /posts/:id (one field)` 1.73
[1.06-2.80] (WP-V: 0.95 [0.90-0.99], WP-U 0.91-0.95), `PATCH /posts?where (bulk, 10)` 2.18
[1.38-3.45] (WP-V: 0.94 `off/rs`), GraphQL `updatePost` 1.57 [1.11-2.21] (WP-V: 0.98); with fused
writes off all three are 0.98-1.10. The whole-document REST `PATCH` is 1.02 [0.53-1.95] (one slow
round). Of the 55 write scenarios none is confidently slower than TS, 27 are confidently faster.
The perf shapes have no slug fields and no unique fields on a localized drafts collection: the
other two parts of WP-W do not run in this suite.

What is left (WP-W), on the write side: slug creates and new slug values (generateSlug's lookups
decide the value: an iterative prepare that suspends on each `fieldValueExists`, with the hook's
I/O ordering against its sibling fields modelled), a custom `slugify` (a user function the
compiler would have to run outside a guarded call site), unique fields in array / block rows and
localized containers of an all-locales publish, unique compound indexes, `plan:field:condition`
64, `plan:field:ui` 38, `plan:field:code` 33.

**WP-X (2026-11-27)**: the three complex scenarios where `rs` is below `rs-fused-off` with the
fused lane guarded (REST `DELETE /posts/:id`, `PATCH /posts/:id (one field)`, Local `create as
draft`). Measured in bench processes of the perf app (release addon, complex, 1k posts, CPUs 16-21)
with per-thread CPU from `/proc/self/task/*/schedstat` and context switches in the timed op window
and between ops, and `perf stat` user-space cycles and instructions counted over the timed op
windows only (`--control` fifo):

- **The Rust threads are idle during the guarded op and between ops**: 0.001-0.002 ms CPU and
  0.05-0.08 context switches per `create as draft` on the driver runtime's threads, 0 between ops
  (nothing of the setups' and teardowns' fused writes still runs: commit, session check-in and
  cursor cleanup finish before the promise resolves or within the same few microseconds). An idle
  process: Rust threads 0.14 ms/s CPU and 4.4 wakeups/s (the Rust driver's pool maintenance and
  monitors), the JS thread 1.6 ms/s and 10.7 wakeups/s (mostly the Node driver's 100 ms pool
  timer): the second pool's monitoring is ~0.02% of a core. Nothing spins. A call after 20 ms idle
  pays ~0.4 ms on both engines (`findByID` depth 0: rs 0.60 → 1.06 ms, ts 0.81 → 1.21; `count`: rs
  0.33 → 0.69, ts 0.36 → 0.74): the machine's and mongod's wake-up, not the Rust runtime's.
- **The dispatch is small**: in a CPU profile of the timed loop, the guarded create's `fuseWrite`
  (`checkCreate`) is 0.05-0.07 ms per call.
- **The gap is the JS exact lane's JIT warmth.** In an `rs` process the seeding (1000 fused
  creates), the setups and the teardowns run in Rust, so the JS of the exact write path (payload's
  operation, mongoose casting and save, the Node driver's command path) has run far fewer times
  than in an `rs-fused-off` process when a guarded scenario starts: V8 still tiers it up during the
  timed iterations (`--trace-opt`: the Node driver's `prepareCommand`, `checkOut`, `selectServer`
  reach TurboFan only in the timed window after 1500 warm-up creates in `rs`, before it in `off`;
  363 against 194 compilations in 200 timed calls after 100 warm-up calls). With the suite's 3
  warm-up calls, `create as draft` runs 40.2 M user instructions per op in `rs` against 31.4 M in
  `off`, the V8 compiler threads use 3.1 against 1.5 ms CPU per op. Seeding on the exact lane
  (`select`, which guards the fused create) and exact setups / teardowns (`disableTransaction`) in
  an `rs` process bring the instructions to `off`'s (PATCH and create as draft: CPU -1.4 to -1.6 ms
  per op). In the steady state (1500 warm-up calls, 4 interleaved rounds) `create as draft` is
  equal: `rs`/`off` wall 0.990 [0.906-1.082], CPU 1.066 [0.951-1.196]; with exact seeding and
  setups CPU 0.996 [0.974-1.018].
- **What is left after warm-up is clock frequency**: at equal instructions and cycles, the fused
  teardowns leave the JS thread idle while the Rust threads work, and its core then runs at a lower
  effective clock (2.80-2.85 against 2.95-3.03 GHz, +0.45 ms task-clock per op, the idle-wake
  effect above). Under load (throughput) it does not occur.
- In the perf suite (write categories, complex, 5 rounds, CPUs 16-21; `off/rs`), every scenario
  that stays on the exact lane is below 1 with the default `--warmup 3` (create as draft 0.912
  [0.883-0.942], duplicate 0.933, REST duplicate 0.952, `PATCH /posts/:id` one field 0.919
  [0.880-0.961] / whole 0.901, `PATCH ?where` 0.938, GraphQL `updatePost` 0.934) and moves to 1
  with `--warmup 100` (0.942, 0.943, 0.985, 0.981 [0.904-1.065] / 0.932, 0.998, 0.941): a
  property of comparing processes whose exact lanes ran different amounts of JS, not work the
  fused dispatch or the Rust runtime adds. REST `DELETE /posts/:id` runs fused in these processes
  (1.075 [0.778-1.485], with `--warmup 100` 1.589 [1.201-2.103]).

Changed: the driver runtime's default worker count (`PAYLOAD_MONGO_DRIVER_THREADS` unset) is half
the CPUs the process may run on, 2 to 3 (it was 2). The fused reads' transforms run on these
workers: `find limit 10` (complex, depth 0) uses ~0.8 ms of Rust CPU per request, so 2 workers
capped it at ~2500 req/s. Interleaved A/Bs of the release addon (`new`/`base`, [95% t interval]):

| CPUs (rounds) | `find limit 10` x8 / x64                  | `findByID` x8 / x64                       | REST `GET /posts` x8 / x64                | `create` x8 / x64                         |
| ------------- | ----------------------------------------- | ----------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| 16-21 (5)     | 1.399 [1.381-1.419] / 1.453 [1.440-1.466] | 1.013 [0.971-1.057] / 1.047 [1.028-1.067] | 1.004 [0.994-1.015] / 1.025 [1.006-1.046] | 0.990 [0.956-1.025] / 0.999 [0.962-1.037] |
| 24-29 (3)     | 1.365 [1.305-1.429] / 1.446 [1.403-1.490] | 1.011 [0.932-1.097] / 1.075 [0.997-1.158] | 0.989 [0.955-1.025] / 1.012 [0.980-1.044] | 0.956 [0.849-1.077] / 1.012 [0.927-1.106] |

CPU per request: `findByID` +8-10% (x8 1.100 [1.060-1.142], x64 1.084 [1.069-1.100] on 16-21;
the third worker's extra wake-ups), REST x8 +3%, the others within ±2%. Sequential (10 read and
write scenarios, 5 rounds on each set): `find limit 100` 0.885 [0.862-0.909] (16-21) and 0.889
[0.844-0.936] (24-29), every other interval includes 1. Rejected: 4 workers on 6 CPUs (`create` x8
0.948 [0.913-0.984], `findByID` CPU +20%) and 3 workers on 4 CPUs (`findByID` x8 0.900
[0.854-0.948]); 1 worker halves `find limit 10` throughput. 24-29 was used briefly for the
placement A/B (load average 3-5 from other jobs).

Bars on the final tree (release addon, mongod 8.2 rs0 on :27048, every run pinned to CPUs 16-21,
so the driver runtime ran 3 workers): the harness with `--engine default` and with both shadows
3330 / 164 / 422, equal to `.rs-baseline/mongodb-all.json` (test/cli differs by the worktree path;
storage emulators and hmr absent), 0 lane-shadow differences; the 8 shadow files 971 / 0 / 46, 0
divergences; parity 503/503 (twice); driver lane 4/4; glue 33/33; HTTP lanes 18/18; fn-compile
39/39; the corpus 35/35; the lane suites 98/98 in default and with both shadows; packaging OK.
SQLite and Postgres do not use the driver runtime.

**Merged statements (WP-AE, 2026-11-28)**: the drivers send a fused write's independent
statements in fewer round trips, inside the same Rust-owned transaction (D9, applied to MongoDB;
`crates/payload-fuse-write/src/lib.rs` `send_writes`, `by_id.rs` `merged_update`, `bulk.rs`
`merged_updates`). `PAYLOAD_RS_FUSE_WRITES_MERGE=off` restores one command per statement (a
measurement switch; perf engine variant `rs-merge-off`). What merges:

- **Writes in a row become one `bulkWrite`** (MongoDB 8.0's multi-collection command on `admin`,
  `ordered: true`, `errorsOnly: false`): each `insert` / `update` / `delete` command's entries
  become its ops in order, so every collection gets the same writes in the same order. A command
  with any other option is sent alone. An op error bails like a write error of the separate
  command did (the transaction is aborted, the exact lane reruns); each op's `n` is checked where
  the separate command's result was read.
- **The lock delete moves into the transaction**, as the first op of the first write after the
  lock check. Upstream sends it without a session, committed at once; inside the transaction it
  commits with the write. The final state is the same: on success both are deleted, and on a bail
  the abort keeps the locks, which the exact lane's rerun then deletes itself (with the separate
  delete it found nothing left). For concurrent readers, the locks disappear at the commit instead
  of a little earlier during the operation. The write lane-shadow already sent it this way.
- **The lock `find`** (`overrideLock: false`) runs beside that first write, on another connection
  without a session. A lock bails, and the abort undoes the write, so the outcome is the one of the
  find first. The bulk writes look for the locks of all their documents in one `find`
  (`$or` of each document's filter, `limit: 1`): any lock bails, as each document's find would.
- **updateByID's main update** is sent as an `update` op (`findAndModify`'s update, `multi: false`)
  in the `bulkWrite` with the version insert and the latest flip. The document after it is then
  read in one `aggregate` together with `enforceMaxVersions`' find: `$match` of the update's query,
  `$limit: 1`, `$replaceWith: { d: '$$ROOT' }`, and the max-versions find as a `$lookup` pipeline
  (`$match`, `$sort`, `$skip`, `$limit`, `$project` of `updatedAt`). The document must equal the
  prepare's `stored_after` byte for byte, as `findAndModify`'s value had to. Within the
  transaction's snapshot nothing else changes it: a concurrent write is a write conflict, which
  bails. `$unionWith` is not allowed in a transaction, and `$lookup` is.
- **deleteByID** has its stored-document `findOne` read the whole document (no projection), so the
  removed document is that `findOne`'s document. The lock delete, `deleteVersions`, the document's
  `delete` (`limit: 1`, `n` must be 1) and the preferences `delete` are one `bulkWrite`.
- **Creates** send the document insert, the version insert and the latest flip as one `bulkWrite`.
- **update-many** runs every document's prepare first (pure; a draft save, unique lookups, no
  versions or a max-versions `find` with a non-positive limit keep the per-document statements). It
  then sends one `bulkWrite` of every document's statements in the find's order, with one lock
  `find` beside it. One `aggregate` per 4 MB of stored documents follows, whose `$facet` holds each
  document's read-back stages. Each document's own statements keep their order; between documents
  the interleaving differs, which D1 allows, as with the per-document sequence.
- **delete-many**: the lock delete, `deleteCollectionVersions` and the documents' `delete` are one
  `bulkWrite`, beside the lock `find`. The preferences delete stays after the results' `afterRead`:
  population could read that collection.

Round trips per operation, before → after:

| operation (typical, versions on) | before                                                                                           | after                                                                    | saved        |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------ |
| create                           | insert, version insert, (latest flip with drafts), P, commit                                     | bulkWrite, P, commit                                                     | 1-2          |
| updateByID                       | findOne, (lock find), lock delete, findAndModify, version insert, (flip), max find, P, commit    | findOne, bulkWrite (+ lock find), aggregate, P, commit                   | 2-4          |
| updateByID, draft save           | latest find, (findOne), (lock find), lock delete, version insert, flip, max find, P, commit      | latest find, (findOne), bulkWrite (+ lock find), max find, P, commit     | 2-3          |
| updateByID, publish over a draft | latest find, (lock find), lock delete, findAndModify, version insert, flip, max find, P, commit  | latest find, findAndModify (+ lock find), bulkWrite, max find, P, commit | 2-3          |
| updateByID, no versions          | findOne, (lock find), lock delete, findAndModify, P, commit                                      | findOne, findAndModify (+ lock find), lock delete, P, commit             | 0-1          |
| deleteByID                       | findOne, (lock find), lock delete, delete versions, findAndModify, delete preferences, P, commit | findOne, bulkWrite (+ lock find), P, commit                              | 3-4          |
| update-many (n documents)        | find, n × ((lock find), lock delete, findAndModify, version insert, max find), P, commit         | find, bulkWrite (+ lock find), aggregate, P, commit                      | 4n-2 to 5n-2 |
| delete-many                      | find, (lock find), lock delete, delete versions, delete documents, P, delete preferences, commit | find, bulkWrite (+ lock find), P, delete preferences, commit             | 2-3          |

P is the result read's population finds (none at depth 0); the max-versions delete (only once a
document has more than `maxPerDoc` versions) and the all-locales publish validation's unique
lookups are unchanged. "+ lock find" is concurrent, not an extra round trip.

Perf suite (WP-K, 2026-11-25, test/__rs/perf, MongoDB 1k posts, release addon, packed install
verified against the builds: engine-rs dist, payload and db-mongodb dist files and the addon
byte-identical; `ts/rs` ratios, per scenario the median of 3 processes per variant, geometric
mean per category; `off` is the engine variant `rs-fused-off`, `on` the default):

| shape   | surface | create      | update      | partial-update | delete      | globals     |
| ------- | ------- | ----------- | ----------- | -------------- | ----------- | ----------- |
| typical | local   | 1.14 → 1.70 | 0.98 → 2.00 | 0.97 → 2.24    | 0.97 → 1.66 | 1.22 → 1.25 |
| typical | rest    | 0.98 → 0.93 | 0.98 → 0.98 | 0.86 → 0.81    | 0.94 → 0.94 | 1.24 → 1.31 |
| typical | graphql | 1.11 → 1.09 | -           | 1.00 → 0.94    | 0.97 → 0.95 | 1.07 → 1.13 |
| complex | local   | 1.00 → 1.00 | 0.96 → 0.98 | 0.97 → 0.97    | 0.91 → 0.94 | 1.11 → 1.23 |
| complex | rest    | 0.89 → 0.94 | 0.98 → 0.97 | 0.88 → 0.91    | 0.85 → 0.97 | 1.16 → 1.28 |
| complex | graphql | 1.03 → 1.04 | -           | 1.05 → 1.04    | 0.90 → 1.00 | 1.12 → 1.05 |
| hooks   | local   | 1.03 → 1.04 | 0.93 → 0.97 | 0.96 → 0.99    | 0.95 → 0.98 | 1.21 → 1.21 |
| hooks   | rest    | 0.99 → 1.00 | 0.98 → 0.98 | 0.95 → 0.94    | 0.98 → 0.96 | 1.22 → 1.37 |
| hooks   | graphql | 1.02 → 1.07 | -           | 0.90 → 0.99    | -           | 1.14 → 0.95 |

complex `locale` (local / rest / graphql): 1.33 → 1.29, 1.31 → 1.21, 1.41 → 1.29 (reads and a
localized `PATCH`, not fused); `versions`: 1.01 → 0.97, 1.05 → 1.04, 0.93 → 0.99.

Per scenario (typical, Local API, off → on): update many (10 by where) 0.99x → 2.33x (52.9 →
22.5 ms), delete many (5 by where) 1.00x → 1.50x (8.8 → 5.9 ms), update by id 0.94-1.00x →
1.68-2.03x, partial updates 0.96-1.26x → 2.04-2.71x, create 1.11-1.22x → 2.00-2.10x, delete by id
0.94x → 1.83x. Only the typical shape's Local API calls reach the lanes: complex and hooks are
ineligible (user hooks, where-constraint access), REST and GraphQL writes are refused by the
request guards (WP-C). On those paths on and off run the same code; their differences are within
the run-to-run spread (single processes on a shared machine, up to ~10% between the three runs),
the largest being REST / GraphQL calls of the typical shape (0.93-0.94 vs 0.98-1.00), consistent
with the idle-wake effect above after the setups' fused Local API writes.

WP-J's measurement with only the by-id writes fused (bulk update 0.91x, delete many 0.77x) is
superseded by the table above.

Measured (2026-11-24, creates, WP-I's prepare, release addon, mongod 8.2 rs0 on loopback, cores
22-31; vitest micro-benchmark of 300 creates after 30 warm-up, p50, not the perf suite):

| shape (non-localized)        | TS      | rs, fused off | rs, fused on | fused vs TS |
| ---------------------------- | ------- | ------------- | ------------ | ----------- |
| minimal, depth 0             | 3.8-4.3 | 3.8-3.9       | 1.96-2.03    | ~2.0x       |
| minimal, depth 2 (populates) | 4.7-4.9 | 4.3-4.5       | 2.8-3.2      | ~1.6x       |
| typical, depth 0             | 6.2     | 5.4           | 3.4          | ~1.85x      |
| typical, depth 2             | 7.0     | 6.3           | 4.3          | ~1.6x       |

Verification of the create slice: the MongoDB harness with `--fuse shadow --fuse-writes shadow`
equals `.rs-baseline/mongodb-all.json` (3330 / 164 / 422; test/cli differs by the worktree path,
storage emulators absent) with 2810 fused creates compared and 0 lane-shadow differences; the lane
suites test/__rs/fuse-writes-lane (minimal, typical, rows, unversioned, localized typical with
blocks) at 0 differences.
