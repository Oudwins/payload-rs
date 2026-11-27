import type { Payload, PayloadRequest } from 'payload'

import { createRequire } from 'node:module'
import {
  createOperation,
  createPayloadRequest,
  updateByIDOperation,
  ValidationError,
} from 'payload'

import { loadEngineAddon } from '../../../packages/engine-rs/src/addon.js'
import { getFnIr } from '../../../packages/engine-rs/src/compile/native.js'
import {
  encodeSnapshot,
  snapshotRequest,
} from '../../../packages/engine-rs/src/compile/snapshot.js'
import { buildWritePlan } from '../../../packages/engine-rs/src/fuse-write/writePlan.js'
import { deserializeFromEngine } from '../../../packages/engine-rs/src/serialize.js'
import { afterRead } from '../../../packages/payload/src/fields/hooks/afterRead/index.js'
import { deepCopyObjectSimple } from '../../../packages/payload/src/utilities/deepCopyObject.js'
import { getLatestCollectionVersion } from '../../../packages/payload/src/versions/getLatestCollectionVersion.js'

/**
 * The differential harness of the write-side library (packages/engine-rs/FUSED_WRITES.md section
 * 12): runs one upstream `create` / `update` on the TS engine with the clock and the row ids
 * recorded, replays the same readings into `fuseWritePrepare`, and compares the BSON mongoose
 * sends (insert / findAndModify, the version insert, the latest flip), the stored document after
 * the update, the caller's `data` after the operation, `req.context`, and the validation error.
 */

type Addon = {
  fuseWritePrepare: (plan: string, request: string, stored?: Buffer) => string
}

type Command = { command: any; name: string; reply?: any }

export type CaseResult =
  | { diffs: string[]; kind: 'diff' }
  | { kind: 'bail'; reason: string }
  | { kind: 'equal'; outcome: 'invalid' | 'written' }

const payloadRequire = createRequire(
  new URL('../../../packages/payload/package.json', import.meta.url),
)
const RowObjectId = payloadRequire('bson-objectid')

/** The driver's bson (db-mongodb's `mongodb`), the one that serializes the commands. */
export const { BSON } = createRequire(
  new URL('../../../packages/db-mongodb/package.json', import.meta.url),
)('mongodb')

const RealDate = Date

const plans = new Map<string, string>()

const planOf = (payload: Payload, slug: string) => {
  let plan = plans.get(slug)
  if (!plan) {
    // the compiled user functions of the plans are evaluated on every call: this corpus is
    // their verification (no guard sampling)
    getFnIr().fnIrSetPolicy(0, 0)
    const built = buildWritePlan({ collection: payload.collections[slug], payload })
    if (!built.json) {
      throw new Error(`${slug}: write plan ineligible: ${built.reason}`)
    }
    plan = built.json
    plans.set(slug, plan)
  }
  return plan
}

const hex = (doc: unknown) => Buffer.from(BSON.serialize(doc as BSON.Document)).toString('hex')

/**
 * Plain data in the boundary's tree encoding (`decode_value_bson`, the format `encode_value`
 * writes): `undefined`, non-finite numbers and `-0`, `Date`s and ObjectIds marked.
 */
const encode = (value: unknown): unknown => {
  if (value === undefined) {
    return { $undefined: true }
  }
  if (typeof value === 'number') {
    if (Object.is(value, -0)) {
      return { $num: '-0' }
    }
    return Number.isFinite(value) ? value : { $num: String(value) }
  }
  if (value instanceof RealDate) {
    return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() }
  }
  if (Array.isArray(value)) {
    return value.map(encode)
  }
  if (typeof value === 'object' && value !== null) {
    if ((value as { _bsontype?: string })._bsontype === 'ObjectId') {
      return { $oid: String(value) }
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error(`encode: ${Object.prototype.toString.call(value)}`)
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = encode(item)
    }
    const keys = Object.keys(out)
    return keys.length === 1 && keys[0]!.startsWith('$') ? { $obj: out } : out
  }
  return value
}

/** Key order, `undefined`, `-0` and `Date`s visible. */
export const canon = (value: unknown): string => {
  if (value === undefined) {
    return 'undefined'
  }
  if (typeof value === 'number') {
    return Object.is(value, -0) ? '-0' : String(value)
  }
  if (value instanceof RealDate) {
    return `Date(${value.getTime()})`
  }
  if (Array.isArray(value)) {
    return `[${value.map(canon).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    if ((value as { _bsontype?: string })._bsontype === 'ObjectId') {
      return `ObjectId(${String(value)})`
    }
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** The file of the frame that called `new Date()`. */
const callerFile = () => {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 4
  const stack = new Error().stack ?? ''
  Error.stackTraceLimit = limit
  return stack.split('\n')[3] ?? ''
}

const modelledClock = [
  'db-mongodb/src/create.ts',
  'db-mongodb/src/utilities/transform.ts',
  'db-mongodb/src/createVersion.ts',
  'payload/src/versions/saveVersion.ts',
  'payload/src/collections/operations/utilities/update.ts',
]

type Recording = { clock: number[]; rows: string[] }

/** Runs `body` with `new Date()` and bson-objectid's generator recorded (and made distinct). */
const recording = async <T>(body: () => Promise<T>) => {
  const recorded: Recording = { clock: [], rows: [] }
  let tick = 0
  const base = RealDate.UTC(2026, 0, 2, 3, 4, 5, 600)
  // a Proxy, so every date is a genuine `Date` (a subclass serializes differently)
  const FakeDate = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length > 0) {
        return Reflect.construct(target, args, newTarget)
      }
      const ms = base + ++tick * 1001
      const file = callerFile()
      if (modelledClock.some((path) => file.includes(path))) {
        recorded.clock.push(ms)
      }
      return Reflect.construct(target, [ms], newTarget)
    },
  })
  const generate = RowObjectId.prototype.generate
  let counter = 0
  RowObjectId.prototype.generate = function () {
    counter++
    const bytes = Buffer.alloc(12)
    bytes.writeUInt32BE(0x6a000000 + counter, 0)
    bytes.writeUInt32BE(0xabcdef01, 4)
    bytes.writeUInt32BE(counter, 8)
    recorded.rows.push(bytes.toString('hex'))
    return String.fromCharCode(...bytes)
  }
  globalThis.Date = FakeDate
  try {
    const value = await body().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    return { recorded, value }
  } finally {
    globalThis.Date = RealDate
    RowObjectId.prototype.generate = generate
  }
}

const captureCommands = async <T>(payload: Payload, body: () => Promise<T>) => {
  const client = payload.db.connection.getClient()
  const commands: Command[] = []
  const byId = new Map<number, Command>()
  const watched = new Set(['delete', 'findAndModify', 'insert', 'update'])
  const started = (event: any) => {
    if (watched.has(event.commandName)) {
      const entry: Command = {
        command: event.command,
        name: `${event.commandName} ${event.command[event.commandName]}`,
      }
      commands.push(entry)
      byId.set(event.requestId, entry)
    }
  }
  const succeeded = (event: any) => {
    const entry = byId.get(event.requestId)
    if (entry) {
      entry.reply = event.reply
    }
  }
  client.on('commandStarted', started)
  client.on('commandSucceeded', succeeded)
  try {
    return { commands, result: await body() }
  } finally {
    client.off('commandStarted', started)
    client.off('commandSucceeded', succeeded)
  }
}

export const ensureMonitoring = (payload: Payload) => {
  const client = payload.db.connection.getClient() as any
  if (!client.options?.monitorCommands) {
    throw new Error('the harness needs a client with monitorCommands')
  }
}

type CaseArgs = {
  collection: string
  data: Record<string, unknown>
  /** The operation's `draft` argument. */
  draft?: boolean
  id?: number | string
  /** `req.locale` (localized configs). */
  locale?: string
  overrideAccess?: boolean
  payload: Payload
  user?: Record<string, unknown>
}

const makeReq = async ({
  locale,
  payload,
  user,
}: {
  locale?: string
  payload: Payload
  user?: Record<string, unknown>
}) => createPayloadRequest({ locale, payload, user: user as any })

/** Runs one case on both lanes and compares. */
export const runCase = async ({
  collection,
  data,
  draft,
  id,
  locale,
  overrideAccess = true,
  payload,
  user,
}: CaseArgs): Promise<CaseResult> => {
  const plan = planOf(payload, collection)
  const op = id === undefined ? 'create' : 'update'
  const req = await makeReq({ locale, payload, user })
  const callerData = data
  const inputData = deepCopyObjectSimple(data)
  let stored: Buffer | undefined
  let docWithLocales: unknown
  let originalDoc: unknown
  if (op === 'update') {
    const raw = await payload.db.connection
      .collection(payload.db.collections[collection]!.collection.name)
      .findOne({ _id: new BSON.ObjectId(String(id)) }, { raw: true } as any)
    stored = raw as unknown as Buffer
    // updateByID's stored-document read (with drafts: the latest version)
    docWithLocales = await getLatestCollectionVersion({
      id: id!,
      config: payload.collections[collection]!.config,
      payload,
      query: { collection, locale: locale!, where: { and: [{ id: { equals: id } }] } },
    })
    const readReq = await makeReq({ locale, payload, user })
    originalDoc = await afterRead({
      collection: payload.collections[collection]!.config,
      context: readReq.context,
      depth: 0,
      doc: deepCopyObjectSimple(docWithLocales as any),
      draft: false,
      fallbackLocale: null as any,
      global: null,
      locale: readReq.locale!,
      overrideAccess: true,
      req: readReq,
      showHiddenFields: true,
    })
  }
  const contextBefore = { ...req.context }
  // the all-locales publish validation's `fieldValueExists` finds (`limit: 2`, `depth: 0`,
  // `pagination: false`): what they looked up and whether another document holds the value
  const lookups: { conflict: boolean; key: string }[] = []
  const find = payload.find
  payload.find = async function (this: Payload, args: any) {
    const found = await find.call(this, args)
    if (args.limit === 2 && args.depth === 0 && args.pagination === false) {
      const [[path, condition]] = Object.entries(args.where) as [string, any][]
      lookups.push({
        conflict: found.docs.some((doc: any) => doc.id !== id),
        key: canon([path, args.locale, condition.equals]),
      })
    }
    return found
  } as typeof find
  const { recorded, value } = await recording(() =>
    captureCommands(payload, () =>
      // the operations themselves: the Local API would hand them a copy of `data`
      op === 'create'
        ? createOperation({
            collection: payload.collections[collection]!,
            data: callerData as any,
            draft,
            overrideAccess,
            req,
          })
        : updateByIDOperation({
            collection: payload.collections[collection]!,
            data: callerData as any,
            draft,
            id: id!,
            overrideAccess,
            req,
          }),
    ),
  ).finally(() => {
    payload.find = find
  })
  const commands = 'result' in value ? value.result.commands : []
  const slugCollection = payload.db.collections[collection]!.collection.name
  const versionCollection = payload.db.versions[collection]?.collection.name
  const main = commands.find(
    (c) => c.name === `${op === 'create' ? 'insert' : 'findAndModify'} ${slugCollection}`,
  )
  const versionInsert = commands.find((c) => c.name === `insert ${versionCollection}`)
  const flip = commands.find((c) => c.name === `update ${versionCollection}`)
  // a ValidationError of the all-locales publish validation's unique lookups is thrown before
  // the statements' readings: the prepare (which only returns the lookups) gets stand-ins
  const isInvalid =
    'error' in value &&
    value.error instanceof ValidationError &&
    lookups.some(({ conflict }) => conflict)
  const ids: [string, string][] = recorded.rows.map((row) => ['row', row])
  if (op === 'create' && main) {
    ids.push(['document', String(main.command.documents[0]._id)])
  }
  if (versionInsert) {
    ids.push(['version', String(versionInsert.command.documents[0]._id)])
  }
  if (isInvalid) {
    if (op === 'create') {
      ids.push(['document', new BSON.ObjectId().toHexString()])
    }
    ids.push(['version', new BSON.ObjectId().toHexString()])
  }
  const request = {
    clock: isInvalid
      ? [...recorded.clock, ...[1, 2, 3, 4].map((n) => recorded.clock.length + n)]
      : recorded.clock,
    context: encode(contextBefore),
    data: encode(inputData),
    docWithLocales: op === 'update' ? encode(docWithLocales) : undefined,
    draft: Boolean(draft),
    fallbackLanguage: req.i18n.fallbackLanguage,
    id: op === 'update' ? encode(id) : undefined,
    ids,
    language: req.i18n.language,
    locale: req.locale ?? undefined,
    op,
    originalDoc: op === 'update' ? encode(originalDoc) : undefined,
    overrideAccess,
    req: encodeSnapshot(snapshotRequest(req)),
    translations: req.i18n.translations,
    user: user ? [user.collection, encode(user.id)] : undefined,
  }
  const addon = loadEngineAddon() as Addon
  const out = JSON.parse(addon.fuseWritePrepare(plan, JSON.stringify(request), stored))
  if (out.bail) {
    return { kind: 'bail', reason: out.bail }
  }
  const diffs: string[] = []
  const rustLookups = (out.unique ?? []).map(([path, locale, val]: [string, string, unknown]) =>
    canon([path, locale, deserializeFromEngine(val, [])]),
  )
  if (lookups.length || rustLookups.length) {
    const upstream = lookups.map(({ key }) => key).sort()
    if (canon(upstream) !== canon([...rustLookups].sort())) {
      diffs.push(`unique lookups:\n  upstream ${upstream}\n  rust     ${rustLookups}`)
      return { diffs, kind: 'diff' }
    }
    if (lookups.some(({ conflict }) => conflict)) {
      // the drivers run the lookups and bail on a conflict; upstream throws its ValidationError
      return 'error' in value && value.error instanceof ValidationError && !out.invalid
        ? { kind: 'bail', reason: 'unique:conflict' }
        : { diffs: ['a unique conflict upstream did not throw for'], kind: 'diff' }
    }
  }
  const check = (what: string, expected: unknown, actual: unknown) => {
    if (expected !== actual) {
      diffs.push(`${what}:\n  upstream ${String(expected)}\n  rust     ${String(actual)}`)
    }
  }
  if (op === 'create') {
    check('callerData', canon(callerData), canon(deserializeFromEngine(out.callerData, [])))
  }
  const contextAfter: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(req.context)) {
    if (!(key in contextBefore) || contextBefore[key] !== val) {
      contextAfter[key] = val
    }
  }
  check(
    'context',
    canon(contextAfter),
    canon(
      Object.fromEntries(
        out.contextWrites.map(([key, val]: [string, unknown]) => [
          key,
          deserializeFromEngine(val, []),
        ]),
      ),
    ),
  )
  if ('error' in value) {
    const error = value.error as any
    if (!(error instanceof ValidationError)) {
      diffs.push(
        `upstream threw ${error?.name}: ${error?.message}; rust ${out.invalid ? 'invalid' : 'wrote'}`,
      )
      return { diffs, kind: 'diff' }
    }
    if (!out.invalid) {
      diffs.push(`upstream ValidationError ${canon(error.data)}; rust wrote`)
      return { diffs, kind: 'diff' }
    }
    check('errors', canon(error.data.errors), canon(out.invalid.errors))
    const rebuilt = new ValidationError(
      {
        id,
        collection: out.invalid.collection,
        errors: out.invalid.errors,
        global: undefined,
        req,
      },
      req.t,
    )
    check('error.message', error.message, rebuilt.message)
    check('error.data', canon(error.data), canon(rebuilt.data))
    return diffs.length ? { diffs, kind: 'diff' } : { kind: 'equal', outcome: 'invalid' }
  }
  if (out.invalid) {
    diffs.push(`rust invalid ${canon(out.invalid.errors)}; upstream wrote`)
    return { diffs, kind: 'diff' }
  }
  if (out.draft) {
    // a draft save sends no findAndModify
    if (main) {
      diffs.push('rust: draft save; upstream sent the main statement')
    }
  } else if (!main) {
    diffs.push('no main statement captured')
    return { diffs, kind: 'diff' }
  } else if (op === 'create') {
    check('insert', canonOf(main.command.documents[0]), canonHex(out.doc))
    check('insert bytes', hex(main.command.documents[0]), out.doc)
  } else {
    check('findAndModify.update', canonOf(main.command.update), canonHex(out.doc))
    check('findAndModify.update bytes', hex(main.command.update), out.doc)
    check('findAndModify.value', canonOf(main.reply?.value), canonHex(out.storedAfter))
    check('findAndModify.value bytes', hex(main.reply?.value), out.storedAfter)
  }
  if (versionInsert || out.version) {
    check(
      'version insert',
      canonOf(versionInsert?.command.documents[0]),
      canonHex(out.version?.doc),
    )
    check('version insert bytes', hex(versionInsert?.command.documents[0] ?? {}), out.version?.doc)
    const flipUpdate = out.version
      ? BSON.deserialize(Buffer.from(out.version.flipUpdate, 'hex'))
      : {}
    if (Object.keys(flipUpdate).length || flip) {
      check('flip filter', canonOf(flip?.command.updates[0].q), canonHex(out.version?.flipFilter))
      check('flip update', canonOf(flip?.command.updates[0].u), canon(flipUpdate))
    }
  }
  check('clock readings left', 0, out.clockLeft)
  check('ids left', 0, out.idsLeft)
  return diffs.length ? { diffs, kind: 'diff' } : { kind: 'equal', outcome: 'written' }
}

/** `canon` of what the driver serializes (mongoose documents and arrays hold cycles). */
const canonOf = (doc: unknown) => (doc === undefined ? 'undefined' : canonHex(hex(doc)))

const canonHex = (text: string | undefined) =>
  text === undefined
    ? 'undefined'
    : canon(BSON.deserialize(Buffer.from(text, 'hex'), { promoteValues: true }))

export type { PayloadRequest }
