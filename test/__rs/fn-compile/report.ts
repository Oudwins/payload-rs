/**
 * Compile-rate report helpers: which functions of a config compile, attributed to the file that
 * defines them (user code in test/ or templates/, Payload, a plugin).
 */
import { Session } from 'node:inspector'
import fs from 'node:fs'
import path from 'node:path'

import { compileFunction, configFunctions } from '../../../packages/engine-rs/src/compile/index.js'
import { functionScopes } from '../../../packages/engine-rs/src/compile/scopes.js'

export type ReportRow = {
  compiled: boolean
  kind: string
  label: string
  name: string
  origin: 'other' | 'payload' | 'plugin' | 'user'
  reason?: string
  source: string
  url: string
}

let session: Session | undefined
const scripts = new Map<string, string>()

const post = <T>(method: string, params: Record<string, unknown> = {}): T => {
  let out: T | undefined
  let error: Error | null = null
  session!.post(method, params, (e, r) => {
    error = e
    out = r as T
  })
  if (error) {
    throw error
  }
  return out as T
}

const ensureSession = () => {
  if (session) {
    return
  }
  session = new Session()
  session.connect()
  session.on('Debugger.scriptParsed', (m) => {
    scripts.set(m.params.scriptId, m.params.url)
  })
  post('Debugger.enable')
}

const transfer = Symbol.for('fn-compile-report:transfer')

/** The URL of the script defining `fn`. */
export const functionUrl = (fn: Function): string => {
  ensureSession()
  const g = globalThis as Record<symbol, unknown>
  g[transfer] = fn
  try {
    const { result } = post<{ result: { objectId: string } }>('Runtime.evaluate', {
      expression: `globalThis[Symbol.for('fn-compile-report:transfer')]`,
      objectGroup: 'fn-compile-report',
    })
    const props = post<{
      internalProperties?: { name: string; value?: { value?: { scriptId: string } } }[]
    }>('Runtime.getProperties', { objectId: result.objectId, ownProperties: true })
    const location = props.internalProperties?.find((p) => p.name === '[[FunctionLocation]]')?.value
      ?.value
    return (location && scripts.get(location.scriptId)) || ''
  } catch {
    return ''
  } finally {
    delete g[transfer]
    post('Runtime.releaseObjectGroup', { objectGroup: 'fn-compile-report' })
  }
}

const originOf = (url: string): ReportRow['origin'] => {
  if (/\/packages\/payload\//.test(url)) {
    return 'payload'
  }
  if (/\/packages\/(plugin-|richtext-|storage-|ui|next|graphql|db-|drizzle)/.test(url)) {
    return 'plugin'
  }
  if (/\/(test|templates)\//.test(url)) {
    return 'user'
  }
  return 'other'
}

/**
 * Payload's sanitization wraps every collection / global access function (`withBaseAccess`, the
 * inherited `readVersions`): the wrapper is what the config holds (and what compiles), the
 * function the user wrote is the closure variable it calls.
 */
const wrappedUserFunction = (fn: Function, url: string): Function | undefined => {
  const names = /withBaseAccess|collections\/config\/defaults|globals\/config\/sanitize/.test(url)
    ? ['documentAccess', 'read', 'effectiveRead']
    : []
  const scopes = functionScopes(fn)
  for (const name of names) {
    const variable = scopes.lookup(name)
    if (variable?.ok && typeof variable.value === 'function') {
      return variable.value
    }
  }
  return undefined
}

export const reportConfig = (config: Record<string, any>): ReportRow[] => {
  const seen = new Set<Function>()
  const rows: ReportRow[] = []
  const add = (fn: Function, kind: string, label: string) => {
    if (seen.has(fn)) {
      return
    }
    seen.add(fn)
    const result = compileFunction(fn, label)
    const url = functionUrl(fn)
    rows.push({
      compiled: result.ok,
      kind,
      label,
      name: fn.name,
      origin: originOf(url),
      ...(result.ok ? {} : { reason: result.reason }),
      source: Function.prototype.toString.call(fn).slice(0, 400),
      url,
    })
    const inner = wrappedUserFunction(fn, url)
    if (inner) {
      add(inner, kind, `${label} (wrapped)`)
    }
  }
  for (const { fn, kind, label } of configFunctions(config)) {
    add(fn, kind, label)
  }
  return rows
}

export const writeReport = (name: string, rows: ReportRow[]) => {
  const dir = path.resolve(process.env.FN_COMPILE_REPORT_DIR ?? '.rs-runs/fn-compile')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(rows, null, 2))
}
