#!/usr/bin/env node
/**
 * Runtime JS-semantics differential (no database): each runtime primitive of
 * crates/payload-core-runtime (await, tail await, strict delete / set, literals, current-global
 * built-ins, intrinsic errors, engine closures, nesting depth) against the native TS construct it
 * stands for, on the same live inputs: constructor / `then` / species reads, microtask ticks,
 * proxy trap counts, inherited setter calls, error class identity, call counts of patched globals.
 * Every comparison also runs a negative control (the pre-phase-J algorithm, emulated in JS) that
 * must differ on at least one case, so a vacuous comparison fails.
 *
 *   node --expose-gc test/__rs/core-runtime/semantics.mjs <addon>
 *
 * `<addon>` exports `coreRuntimeBinding()` (payload-node or the runtime's dev_addon example).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const addonPath = process.argv[2] ?? process.env.PAYLOAD_ENGINE_ADDON
if (!addonPath) {
  throw new Error('usage: semantics.mjs <addon>')
}
const binding = require(addonPath).coreRuntimeBinding()
const P = binding.probes
if (!P) {
  throw new Error(`${addonPath} has no runtime probes (built before phase J)`)
}
// The runtime's JS-semantic property helpers, exactly as packages/engine-rs/src/runtime installs
// them (strict module code); the other host entries are unused by the probes.
binding.init(
  new Proxy(
    {
      del: (target, key) => {
        'use strict'
        delete target[key]
      },
      get: (target, key) => target[key],
      set: (target, key, value) => {
        'use strict'
        target[key] = value
      },
    },
    { get: (t, k) => (k in t ? t[k] : () => {}) },
  ),
)

const IntrinsicTypeError = TypeError
const intrinsicThen = Promise.prototype.then
const intrinsicResolve = Promise.resolve.bind(Promise)
let failures = 0
let compared = 0
const results = []

const report = (name, ok, detail) => {
  compared++
  if (!ok) {
    failures++
  }
  results.push({ detail, name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     ${JSON.stringify(detail)}`}`)
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// --- microtask clock -----------------------------------------------------------------------
let tick = 0
const startClock = (n = 300) => {
  tick = 0
  const pump = () => {
    if (tick < n) {
      tick++
      queueMicrotask(pump)
    }
  }
  queueMicrotask(pump)
}
const drain = () => new Promise((resolve) => setImmediate(resolve))

// --- await ---------------------------------------------------------------------------------
// Each case builds fresh inputs and an event log; `variant(value)` must return a promise of the
// awaited value (the native async function, the Rust task, or the legacy emulation).
const awaitCases = () => {
  const cases = {}
  const withCtorGetter = (p, log, behaviour = () => Promise) => {
    let reads = 0
    Object.defineProperty(p, 'constructor', {
      configurable: true,
      get() {
        reads++
        log.push(`constructor#${reads}@${tick}`)
        return behaviour(reads)
      },
    })
    return p
  }
  cases['native fulfilled, constructor getter'] = (log) => withCtorGetter(Promise.resolve(1), log)
  cases['native rejected, constructor getter'] = (log) => {
    const p = Promise.reject(new Error('r'))
    p.catch(() => {})
    return withCtorGetter(p, log)
  }
  cases['native, constructor throws on 2nd read'] = (log) =>
    withCtorGetter(Promise.resolve(2), log, (n) => {
      if (n > 1) {
        throw new Error('second constructor read')
      }
      return Promise
    })
  cases['native pending, settles after 5 ticks'] = (log) => {
    let resolve
    const p = new Promise((r) => (resolve = r))
    let n = 0
    const later = () => (++n < 5 ? queueMicrotask(later) : resolve('late'))
    queueMicrotask(later)
    return withCtorGetter(p, log)
  }
  cases['native with own then (not called by await)'] = (log) => {
    const p = Promise.resolve(3)
    p.then = function (...args) {
      log.push(`own then@${tick}`)
      return intrinsicThen.apply(this, args)
    }
    return withCtorGetter(p, log)
  }
  cases['thenable (then getter + call)'] = (log) => {
    const t = {}
    Object.defineProperty(t, 'then', {
      get() {
        log.push(`then get@${tick}`)
        return (res) => {
          log.push(`then call@${tick}`)
          res(4)
        }
      },
    })
    return t
  }
  cases['thenable throwing then getter'] = (log) => {
    const t = {}
    Object.defineProperty(t, 'then', {
      get() {
        log.push(`then get@${tick}`)
        throw new Error('then getter')
      },
    })
    return t
  }
  cases['non-promise number'] = () => 5
  cases['undefined'] = () => undefined
  cases['plain object'] = () => ({ a: 1 })
  cases['subclassed promise (species + then)'] = (log) => {
    class Sub extends Promise {
      static get [Symbol.species]() {
        log.push(`Sub species@${tick}`)
        return Promise
      }
      then(...args) {
        log.push(`Sub then@${tick}`)
        return super.then(...args)
      }
    }
    return Sub.resolve(6)
  }
  cases['native, Promise[Symbol.species] getter'] = (log) => {
    const p = Promise.resolve(7)
    log.speciesLog = true
    return p
  }
  return cases
}

const nativeAwait = async (v) => await v
// pre-phase-J executor: PromiseResolve + %Promise.prototype.then% resuming the task, whose
// promise then settles with the result (napi deferred)
const legacyAwait = (v) =>
  new Promise((resolve, reject) => {
    Reflect.apply(intrinsicThen, intrinsicResolve(v), [resolve, reject])
  })

const runAwaitCase = async (make, variant, repeat = 1) => {
  const log = []
  const value = make(log)
  let restoreSpecies
  if (log.speciesLog) {
    const desc = Object.getOwnPropertyDescriptor(Promise, Symbol.species)
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get() {
        log.push(`Promise species@${tick}`)
        return Promise
      },
    })
    restoreSpecies = () => Object.defineProperty(Promise, Symbol.species, desc)
  }
  startClock()
  let promise
  try {
    promise = variant(value, repeat)
  } catch (e) {
    log.push(`sync throw ${e?.message}`)
  }
  log.push(
    `returned ${Object.getPrototypeOf(promise ?? {}) === Promise.prototype ? 'Promise' : 'other'}`,
  )
  await Reflect.apply(intrinsicThen, promise, [
    (v) => log.push(`fulfilled ${JSON.stringify(v)}@${tick}`),
    (e) => log.push(`rejected ${e?.message}@${tick}`),
  ])
  restoreSpecies?.()
  await drain()
  return log.filter((e) => typeof e === 'string')
}

const nativeAwaitN = async (v, n) => {
  let last
  for (let i = 0; i < n; i++) {
    last = await v
  }
  return last
}
const legacyAwaitN = async (v, n) => {
  // not tick-exact for n > 1 (the legacy task never re-wrapped): only used as a control
  let last
  for (let i = 0; i < n; i++) {
    last = await legacyAwait(v)
  }
  return last
}

const checkAwait = async () => {
  const cases = awaitCases()
  let controlDiffers = 0
  for (const [name, make] of Object.entries(cases)) {
    const ts = await runAwaitCase(make, (v) => nativeAwait(v))
    const rs = await runAwaitCase(make, (v) => P.awaitOnce(v))
    const legacy = await runAwaitCase(make, (v) => legacyAwait(v))
    report(`await: ${name}`, same(ts, rs), { rs, ts })
    if (!same(ts, legacy)) {
      controlDiffers++
    }
    const ts3 = await runAwaitCase(make, (v) => nativeAwaitN(v, 3))
    const rs3 = await runAwaitCase(make, (v) => P.awaitN(v, 3))
    report(`await x3: ${name}`, same(ts3, rs3), { rs3, ts3 })
  }
  report('await: negative control (legacy then-based await) detected', controlDiffers > 0, {
    controlDiffers,
  })
}

// --- tail await ----------------------------------------------------------------------------
const checkTail = async () => {
  const cases = awaitCases()
  let controlDiffers = 0
  const nativeTail = async (p, v) => {
    await p
    return v
  }
  const legacyTail = (p, v) => Reflect.apply(intrinsicThen, p, [() => v])
  for (const [name, make] of Object.entries(cases)) {
    // spawn_tail is only used with native promises (Promise.all / engine task promises)
    const probeValue = make([])
    if (!(probeValue instanceof Promise)) {
      continue
    }
    const ts = await runAwaitCase(make, (p) => nativeTail(p, 'v'))
    const rs = await runAwaitCase(make, (p) => P.awaitTail(p, 'v'))
    const legacy = await runAwaitCase(make, (p) => legacyTail(p, 'v'))
    report(`tail await: ${name}`, same(ts, rs), { rs, ts })
    if (!same(ts, legacy)) {
      controlDiffers++
    }
  }
  report('tail await: negative control (legacy then) detected', controlDiffers > 0, {
    controlDiffers,
  })
}

// --- strict delete / set -------------------------------------------------------------------
const outcome = (fn) => {
  try {
    const v = fn()
    return { ok: v === undefined ? 'undefined' : typeof v }
  } catch (e) {
    return {
      class: e instanceof IntrinsicTypeError ? 'TypeError' : e?.constructor?.name,
      msg: e?.message,
    }
  }
}

const checkDelete = () => {
  const make = (log) => {
    let calls = 0
    return new Proxy(
      { log: 1 },
      {
        deleteProperty(target, key) {
          calls++
          log.push(`deleteProperty ${String(key)} #${calls}`)
          if (calls === 1) {
            return false
          }
          return Reflect.deleteProperty(target, key)
        },
      },
    )
  }
  const tsDelete = (o, k) => {
    'use strict'
    delete o[k]
  }
  const legacyDelete = (o, k) => {
    if (Reflect.deleteProperty(o, k)) {
      return
    }
    tsDelete(o, k)
  }
  const run = (del) => {
    const log = []
    const o = make(log)
    log.push(outcome(() => del(o, 'log')))
    log.push(`has ${'log' in o}`)
    return log
  }
  const ts = run(tsDelete)
  const rs = run((o, k) => P.del(o, k))
  report('delete: proxy trap false then true', same(ts, rs), { rs, ts })
  const frozen = () => {
    const log = []
    const o = Object.freeze({ a: 1 })
    return [outcome(() => tsDelete(o, 'a')), log]
  }
  const fts = frozen()
  const frs = (() => [outcome(() => P.del(Object.freeze({ a: 1 }), 'a')), []])()
  report('delete: frozen object throws TypeError', same(fts, frs), { frs, fts })
  const prim = [outcome(() => tsDelete('str', 'length')), outcome(() => tsDelete(5, 'x'))]
  const primRs = [outcome(() => P.del('str', 'length')), outcome(() => P.del(5, 'x'))]
  report('delete: primitives', same(prim, primRs), { prim, primRs })
  report(
    'delete: negative control (sloppy delete + strict retry) detected',
    !same(ts, run(legacyDelete)),
    {},
  )
}

const checkSet = () => {
  const tsSet = (o, k, v) => {
    'use strict'
    o[k] = v
  }
  const scenarios = {
    frozen: () => Object.freeze({ a: 1 }),
    getterOnly: () => Object.defineProperty({}, 'a', { get: () => 1 }),
    inheritedSetter: (log) =>
      Object.create({
        set a(v) {
          log.push(`setter ${v}`)
        },
      }),
    primitive: () => 'str',
    proxy: (log) =>
      new Proxy(
        {},
        {
          set(t, k, v) {
            log.push(`set trap ${String(k)}`)
            return false
          },
        },
      ),
  }
  for (const [name, make] of Object.entries(scenarios)) {
    const run = (set) => {
      const log = []
      const o = make(log)
      log.push(outcome(() => set(o, 'a', 2)))
      return log
    }
    const ts = run(tsSet)
    const rs = run((o, k, v) => P.set(o, k, v))
    report(`set: ${name}`, same(ts, rs), { rs, ts })
  }
}

// --- literals ------------------------------------------------------------------------------
const checkLiterals = () => {
  // not an array: pushing into an array would itself run the inherited index setter
  const log = {
    entries: '',
    length: 0,
    push(e) {
      this.entries += `${e};`
      this.length++
    },
  }
  const install = (proto, key) => {
    const before = Object.getOwnPropertyDescriptor(proto, key)
    Object.defineProperty(proto, key, {
      configurable: true,
      get() {
        log.push(`inherited get ${key}`)
      },
      set(v) {
        log.push(`inherited set ${key}=${v}`)
      },
    })
    return () => (before ? Object.defineProperty(proto, key, before) : delete proto[key])
  }
  const describe = (o) =>
    Object.fromEntries(
      Reflect.ownKeys(o).map((k) => {
        const d = Object.getOwnPropertyDescriptor(o, k)
        return [String(k), { c: d.configurable, e: d.enumerable, v: d.value, w: d.writable }]
      }),
    )
  const restores = [
    install(Object.prototype, 'session'),
    install(Object.prototype, 'after'),
    install(Array.prototype, '0'),
  ]
  try {
    const ts = describe({ session: 's', after: 1 })
    const rs = describe(P.literal('session', 's'))
    report(
      'literal: inherited setters do not run, own data props',
      same(ts, rs) && log.length === 0,
      { log, rs, ts },
    )
    const legacy = (() => {
      const o = {}
      o.session = 's'
      o.after = 1
      return describe(o)
    })()
    report(
      'literal: negative control ([[Set]] fill) detected',
      !same(ts, legacy) || log.length > 0,
      { legacy },
    )
    log.length = 0
    log.entries = ''
    const tsArr = describe(['a', 'b'])
    const rsArr = describe(P.arrayLiteral('a', 'b'))
    report(
      'array literal: inherited index setter does not run',
      same(tsArr, rsArr) && log.length === 0,
      { log, rsArr, tsArr },
    )
  } finally {
    restores.forEach((r) => r())
  }
}

// --- intrinsic errors / current globals ----------------------------------------------------
const checkGlobals = () => {
  const savedTypeError = globalThis.TypeError
  class FakeTypeError extends Error {}
  globalThis.TypeError = FakeTypeError
  let ts, rs
  try {
    try {
      const f = 0
      f()
    } catch (e) {
      ts = { intrinsic: e instanceof IntrinsicTypeError, message: e.message }
    }
    try {
      P.callFn(0, 'f')
    } catch (e) {
      rs = { intrinsic: e instanceof IntrinsicTypeError, message: e.message }
    }
  } finally {
    globalThis.TypeError = savedTypeError
  }
  report('not a function: intrinsic TypeError despite replaced global', same(ts, rs), { rs, ts })

  const savedKeys = Object.keys
  const calls = []
  Object.keys = function (o) {
    calls.push('keys')
    return savedKeys(o)
  }
  let tsKeys, rsKeys
  try {
    tsKeys = [Object.keys({ a: 1, b: 2 }), calls.length]
    calls.length = 0
    rsKeys = [P.objectKeys({ a: 1, b: 2 }), calls.length]
  } finally {
    Object.keys = savedKeys
  }
  report('Object.keys: current global called once', same(tsKeys, rsKeys), { rsKeys, tsKeys })

  const savedIsArray = Array.isArray
  let isArrayCalls = 0
  Array.isArray = (v) => {
    isArrayCalls++
    return savedIsArray(v)
  }
  let tsIs, rsIs
  try {
    const proxyArr = new Proxy([], {})
    tsIs = [Array.isArray(proxyArr), Array.isArray({}), isArrayCalls]
    isArrayCalls = 0
    rsIs = [P.isArray(proxyArr), P.isArray({}), isArrayCalls]
  } finally {
    Array.isArray = savedIsArray
  }
  report('Array.isArray: current global, proxies of arrays', same(tsIs, rsIs), { rsIs, tsIs })

  const hasRun = (has) => {
    const log = []
    const proxy = new Proxy({}, { has: (t, k) => (log.push(`has ${String(k)}`), k === 'name') })
    log.push(
      has(proxy, 'name'),
      outcome(() => has(1, 'name')),
      outcome(() => has('abc', 'length')),
    )
    return log
  }
  const tsHas = hasRun((o, k) => k in o)
  const rsHas = hasRun((o, k) => P.has(o, k))
  report('in: proxy has trap, intrinsic TypeError for primitives', same(tsHas, rsHas), {
    rsHas,
    tsHas,
  })

  const pushRun = (push) => {
    const log = []
    const arr = []
    arr.push = function (v) {
      log.push(`own push ${v}`)
      return Array.prototype.push.call(this, v)
    }
    log.push(push(arr, 1))
    log.push(outcome(() => push(Object.freeze([]), 2)))
    return log
  }
  const tsPush = pushRun((a, v) => a.push(v))
  const rsPush = pushRun((a, v) => P.push(a, v))
  report('push: own push method / frozen array', same(tsPush, rsPush), { rsPush, tsPush })
}

// --- closures ------------------------------------------------------------------------------
const checkClosures = async () => {
  const counter = { n: 0 }
  // retained + recursive + re-entrant: g(n) = n === 0 ? 0 : 1 + g(n - 1)
  const g = P.closure((self, n) => (n === 0 ? 0 : 1 + self(n - 1)), counter)
  const first = g(5)
  await drain()
  const later = g(50)
  report(
    'closure: retained, recursive, called after its creating call',
    first === 5 && later === 50 && counter.n === 57,
    {
      counter,
      first,
      later,
    },
  )
  const a2 = P.arrow(2)
  const shape = {
    isConstructible: (() => {
      try {
        Reflect.construct(String, [], a2)
        return true
      } catch {
        return false
      }
    })(),
    length: a2.length,
    name: a2.name,
    prototype: Object.hasOwn(a2, 'prototype'),
    result: a2(1, 2),
    toStringArrow: Function.prototype.toString.call(a2).includes('=>'),
  }
  const tsArrow = (a, b) => [a, b]
  const tsShape = {
    isConstructible: false,
    length: tsArrow.length,
    name: '',
    prototype: Object.hasOwn(tsArrow, 'prototype'),
    result: [1, 2],
    toStringArrow: true,
  }
  report('arrow: length / name / no prototype / not constructible', same(shape, tsShape), {
    shape,
    tsShape,
  })
  if (typeof globalThis.gc !== 'function') {
    report('closure: GC-tied lifetime (needs --expose-gc)', false, {})
    return
  }
  const before = P.liveClosures()
  for (let i = 0; i < 2000; i++) {
    P.countedClosure()(i)
  }
  const created = P.liveClosures() - before
  for (let i = 0; i < 10 && P.liveClosures() > before; i++) {
    globalThis.gc()
    await drain()
    await new Promise((r) => setTimeout(r, 10))
  }
  const after = P.liveClosures() - before
  report('closure: freed by the GC finalizer once unreachable', created === 2000 && after < 2000, {
    after,
    created,
  })
}

// --- nesting depth -------------------------------------------------------------------------
const maxDepth = async (run) => {
  let lo = 1
  let hi = 1
  const ok = async (n) => {
    try {
      await run(n)
      return true
    } catch (e) {
      if (!(e instanceof RangeError)) {
        throw e
      }
      return false
    }
  }
  while (hi < 1 << 20 && (await ok(hi))) {
    lo = hi
    hi *= 2
  }
  if (hi >= 1 << 20) {
    return Infinity
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (await ok(mid)) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return lo
}

const checkDepth = async () => {
  const leaf = () => 'leaf'
  const tsLevel = async (n) => (n === 0 ? leaf() : tsLevel(n - 1))
  const ts = await maxDepth((n) => tsLevel(n))
  const rsSpawn = await maxDepth((n) => P.nest(n, leaf))
  const rs = await maxDepth((n) => P.nestCall(n, leaf))
  console.log(`     nested async depth: ts ${ts}, rs call ${rs}, rs recursive spawn ${rsSpawn}`)
  report(
    'depth: nested engine calls accept every depth nested TS async functions accept',
    rs >= ts,
    { rs, ts },
  )
  report(
    'depth: nested engine calls still overflow (RangeError) at a comparable depth',
    rs < ts * 4,
    { rs, ts },
  )
  report('depth: negative control (recursive spawn) is shallower than TS', rsSpawn < ts, {
    rsSpawn,
    ts,
  })
  // same result as TS at a depth both accept
  const tsValue = await tsLevel(100)
  const rsValue = await P.nestCall(100, leaf)
  report('depth: nested call result', tsValue === rsValue, { rsValue, tsValue })
}

await checkAwait()
await checkTail()
checkDelete()
checkSet()
checkLiterals()
checkGlobals()
await checkClosures()
await checkDepth()

console.log(`\n${compared} comparisons, ${failures} failed`)
if (compared === 0 || failures > 0) {
  process.exitCode = 1
}
