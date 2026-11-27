import { types } from 'node:util'

import type { PathTrie, Resolution } from './native.js'
import type { AnyFunction } from './snapshot.js'

import { getFnIr } from './native.js'
import { functionScopes, releaseScopes } from './scopes.js'
import { FnRef, snapshot } from './snapshot.js'

/** What the compiler made of a function. */
export type CompiledFunction =
  | {
      /** Top-level keys of each argument the function reads (`null`: any). */
      argKeys: (null | string[])[]
      id: number
      isAsync: boolean
      ok: true
    }
  | { ok: false; reason: string }

const compiled = new WeakMap<AnyFunction, { pending: number } | CompiledFunction>()

const maxHelperDepth = 24

/**
 * Intrinsics the interpreter implements, captured when this module loads: a function compiles
 * only while the globals it names and the prototype methods the interpreter models are these.
 */
const pristineGlobals: Record<string, unknown> = {
  Array,
  Boolean,
  Infinity,
  isNaN,
  Math,
  NaN,
  Number,
  Object,
  String,
  undefined,
}
const pristineBuiltins = new Map<string, unknown>([
  ['Array.isArray', Array.isArray],
  ['Boolean', Boolean],
  ['isNaN', isNaN],
  ['Math.abs', Math.abs],
  ['Math.ceil', Math.ceil],
  ['Math.floor', Math.floor],
  ['Math.max', Math.max],
  ['Math.min', Math.min],
  ['Math.round', Math.round],
  ['Number', Number],
  ['Number.isFinite', Number.isFinite],
  ['Number.isInteger', Number.isInteger],
  ['Number.isNaN', Number.isNaN],
  ['Object.entries', Object.entries],
  ['Object.freeze', Object.freeze],
  ['Object.hasOwn', Object.hasOwn],
  ['Object.keys', Object.keys],
  ['Object.values', Object.values],
  ['String', String],
])
const prototypeMethods: [object, PropertyKey[]][] = [
  [
    Array.prototype,
    [
      'some',
      'every',
      'includes',
      'indexOf',
      'find',
      'findIndex',
      'filter',
      'map',
      'join',
      'slice',
      'at',
      'concat',
      'flat',
    ],
  ],
  [
    String.prototype,
    [
      'trim',
      'trimStart',
      'trimEnd',
      'toLowerCase',
      'toUpperCase',
      'slice',
      'substring',
      'startsWith',
      'endsWith',
      'includes',
      'indexOf',
      'replace',
      'replaceAll',
      'split',
      'charAt',
      'at',
      'padStart',
      'padEnd',
      'toString',
      'concat',
      'repeat',
    ],
  ],
  [Number.prototype, ['toString']],
  [RegExp.prototype, ['test', 'exec', Symbol.replace, Symbol.split]],
  [Object.prototype, ['hasOwnProperty', 'toString', 'valueOf']],
  [Array.prototype, [Symbol.iterator]],
  ...(typeof Headers === 'function'
    ? [[Headers.prototype, ['get', 'has', 'entries']] as [object, PropertyKey[]]]
    : []),
  [String.prototype, [Symbol.iterator]],
]
const pristineMethods = prototypeMethods.map(
  ([proto, names]) =>
    [proto, names.map((n): [PropertyKey, unknown] => [n, Reflect.get(proto, n)])] as const,
)

/** Why intrinsics no longer look pristine, or `undefined`. */
const patchedIntrinsics = (): string | undefined => {
  for (const [name, value] of Object.entries(pristineGlobals)) {
    if (!Object.is((globalThis as Record<string, unknown>)[name], value)) {
      return `global ${name} was replaced`
    }
  }
  for (const [path, value] of pristineBuiltins) {
    const [base, member] = path.split('.')
    const current = member
      ? (globalThis as unknown as Record<string, Record<string, unknown>>)[base!]?.[member]
      : (globalThis as unknown as Record<string, unknown>)[base!]
    if (current !== value) {
      return `${path} was replaced`
    }
  }
  for (const [proto, methods] of pristineMethods) {
    for (const [name, value] of methods) {
      if (Reflect.get(proto, name) !== value) {
        return `a prototype method (${String(name)}) was replaced`
      }
    }
  }
  return undefined
}

/**
 * Compiles `fn` (memoized per function object). `label` names it in logs and reports.
 *
 * Assumptions (owner decision D5): the bindings `fn` captures are not reassigned and the objects
 * it captures are not mutated after this call, `fn` is deterministic for its arguments, and the
 * intrinsics stay unpatched (checked here). Guard mode (`guard.ts`) verifies the results.
 */
export const compileFunction = (
  fn: AnyFunction,
  label = fn.name || '<anonymous>',
): CompiledFunction => {
  try {
    return compileInner(fn, label, 0)
  } finally {
    releaseScopes()
  }
}

/** Compiles `fn` when it is a config function a lazy guard install has not compiled yet (guard.ts). */
let compileOnFirstUse: (fn: AnyFunction) => unknown = () => undefined

export const setCompileOnFirstUse = (next: (fn: AnyFunction) => unknown) => {
  compileOnFirstUse = next
}

/**
 * The memoized result for `fn`, without compiling it, except for a config function of a lazy
 * guard install, which compiles on its first use (this lookup, or its first guarded call).
 */
export const getCompiledFunction = (fn: AnyFunction): CompiledFunction | undefined => {
  let entry = compiled.get(fn)
  if (!entry) {
    compileOnFirstUse(fn)
    entry = compiled.get(fn)
  }
  return entry && 'ok' in entry ? entry : undefined
}

const compileInner = (fn: AnyFunction, label: string, depth: number): CompiledFunction => {
  const existing = compiled.get(fn)
  if (existing) {
    if ('pending' in existing) {
      // A cycle (recursive helper): the id is reserved, its IR is installed when it finishes.
      return { id: existing.pending, argKeys: [], isAsync: false, ok: true }
    }
    return existing
  }
  const result = compileUncached(fn, label, depth)
  compiled.set(fn, result)
  return result
}

const reject = (reason: string): CompiledFunction => ({ ok: false, reason })

const compileUncached = (fn: AnyFunction, label: string, depth: number): CompiledFunction => {
  if (typeof fn !== 'function') {
    return reject('not a function')
  }
  if (depth > maxHelperDepth) {
    return reject('helpers nested too deeply')
  }
  if (types.isProxy(fn)) {
    return reject('proxy')
  }
  const patched = patchedIntrinsics()
  if (patched) {
    return reject(patched)
  }
  const fnIr = getFnIr()
  let source: string
  try {
    source = Function.prototype.toString.call(fn)
  } catch {
    return reject('source not available')
  }
  const analysis = fnIr.fnIrAnalyze(source)
  if ('reject' in analysis) {
    return reject(analysis.reject)
  }
  const scopes = functionScopes(fn)
  if (scopes.rejection) {
    return reject(scopes.rejection)
  }
  const id = fnIr.fnIrReserve()
  compiled.set(fn, { pending: id })
  const resolutions: Record<string, Resolution> = {}
  for (const [name, trie] of Object.entries(analysis.free)) {
    const variable = scopes.lookup(name)
    let resolution: Resolution
    if (!variable) {
      resolution = resolveGlobal(name, trie)
    } else if (!variable.ok) {
      resolution = { kind: 'unresolved', reason: `${name}: ${variable.reason}` }
    } else {
      resolution = resolveValue(variable.value, trie, name, depth)
    }
    if (resolution.kind === 'unresolved') {
      fnIr.fnIrDeoptimize(id)
      return reject(resolution.reason)
    }
    resolutions[name] = resolution
  }
  const failure = fnIr.fnIrCompile(id, source, resolutions, label)
  if (failure !== null) {
    fnIr.fnIrDeoptimize(id)
    return reject(failure)
  }
  return { id, argKeys: analysis.argKeys, isAsync: analysis.isAsync, ok: true }
}

const resolveGlobal = (name: string, trie: PathTrie): Resolution => {
  if (!(name in pristineGlobals)) {
    return { kind: 'unresolved', reason: `global ${name}` }
  }
  const value = pristineGlobals[name]
  if (value === undefined || typeof value === 'number') {
    return { kind: 'value', value }
  }
  if (trie.value) {
    return pristineBuiltins.has(name)
      ? { kind: 'builtin', path: name }
      : { kind: 'unresolved', reason: `${name} used as a value` }
  }
  const members: Record<string, Resolution> = {}
  for (const [member, sub] of Object.entries(trie.members)) {
    const path = `${name}.${member}`
    if (!pristineBuiltins.has(path) || Object.keys(sub.members).length > 0) {
      return { kind: 'unresolved', reason: `intrinsic ${path}` }
    }
    members[member] = { kind: 'builtin', path }
  }
  return { kind: 'namespace', members }
}

/** A module namespace object (native ESM, vite SSR, webpack / turbopack interop). */
const isModuleNamespace = (value: object): boolean => {
  if (types.isModuleNamespaceObject(value)) {
    return true
  }
  const own = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag)
  if (own && 'value' in own && own.value === 'Module') {
    return true
  }
  const esModule = Object.getOwnPropertyDescriptor(value, '__esModule')
  return Boolean(esModule && 'value' in esModule && esModule.value === true)
}

const helperRef =
  (depth: number, path: string) =>
  (fn: AnyFunction): FnRef | undefined => {
    const result = compileInner(fn, `${path} (captured)`, depth + 1)
    return result.ok ? new FnRef(result.id) : undefined
  }

const resolveValue = (value: unknown, trie: PathTrie, path: string, depth: number): Resolution => {
  const memberNames = Object.keys(trie.members)
  if (typeof value === 'function') {
    if (memberNames.length > 0) {
      return { kind: 'unresolved', reason: `${path}: property of a function` }
    }
    const result = compileInner(value as AnyFunction, path, depth + 1)
    return result.ok
      ? { id: result.id, kind: 'function' }
      : { kind: 'unresolved', reason: `helper ${path}: ${result.reason}` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || trie.value) {
    return { kind: 'value', value: snapshot(value, { functionRef: helperRef(depth, path) }) }
  }
  // Only read through static members: resolve each member (a namespace), unless a member is
  // inherited (a method of the value itself): then the value is a snapshot.
  const moduleNamespace = isModuleNamespace(value)
  const members: Record<string, Resolution> = {}
  for (const [member, sub] of Object.entries(trie.members)) {
    let memberValue: unknown
    const own = types.isProxy(value) ? undefined : Object.getOwnPropertyDescriptor(value, member)
    if (!own) {
      // Inherited (a method of the value itself) or missing: the value is a snapshot and the
      // member is read at run time.
      return { kind: 'value', value: snapshot(value, { functionRef: helperRef(depth, path) }) }
    }
    if ('value' in own) {
      memberValue = own.value
    } else if (moduleNamespace) {
      // Module namespace getters (live bindings) are pure reads.
      memberValue = (value as Record<string, unknown>)[member]
    } else {
      return { kind: 'unresolved', reason: `${path}.${member} is an accessor` }
    }
    members[member] = resolveValue(memberValue, sub, `${path}.${member}`, depth)
    if (members[member]!.kind === 'unresolved') {
      return members[member]!
    }
  }
  return { kind: 'namespace', members }
}
