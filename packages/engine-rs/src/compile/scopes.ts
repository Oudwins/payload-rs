import { Session } from 'node:inspector'

import type { AnyFunction } from './snapshot.js'

/**
 * Reads a function's closure scopes (`[[Scopes]]`: closure, block, script and module scopes, the
 * innermost first) through an in-process inspector session. `Session.post` on the main thread's
 * own session answers synchronously.
 */
type RemoteObject = {
  className?: string
  description?: string
  objectId?: string
  subtype?: string
  type: string
  unserializableValue?: string
  value?: unknown
}

type PropertyDescriptor = { name: string; value?: RemoteObject }

/** One variable of a scope: its value, or why it could not be read. */
export type ScopeVariable = { ok: false; reason: string } | { ok: true; value: unknown }

const transfer = Symbol.for('@payloadcms/engine-rs/compile:transfer')
const objectGroup = 'payload-fn-compile'

let session: Session | undefined

const post = <T>(method: string, params: Record<string, unknown>): T => {
  if (!session) {
    session = new Session()
    session.connect()
  }
  let error: Error | null | undefined
  let result: T | undefined
  let answered = false
  session.post(method, params, (e, r) => {
    answered = true
    error = e
    result = r as T
  })
  if (!answered) {
    throw new Error(`inspector ${method} did not answer synchronously`)
  }
  if (error) {
    throw error
  }
  return result as T
}

const remoteOf = (value: unknown): string => {
  const g = globalThis as Record<symbol, unknown>
  g[transfer] = value
  try {
    const { result } = post<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: `globalThis[Symbol.for('@payloadcms/engine-rs/compile:transfer')]`,
      objectGroup,
    })
    if (!result.objectId) {
      throw new Error('function has no remote object')
    }
    return result.objectId
  } finally {
    delete g[transfer]
  }
}

const valueOf = (remote: RemoteObject): ScopeVariable => {
  if (remote.objectId) {
    const g = globalThis as Record<symbol, unknown>
    post('Runtime.callFunctionOn', {
      functionDeclaration: `function () { globalThis[Symbol.for('@payloadcms/engine-rs/compile:transfer')] = this }`,
      objectGroup,
      objectId: remote.objectId,
    })
    const value = g[transfer]
    delete g[transfer]
    return { ok: true, value }
  }
  if (remote.unserializableValue !== undefined) {
    switch (remote.unserializableValue) {
      case '-0':
        return { ok: true, value: -0 }
      case '-Infinity':
        return { ok: true, value: -Infinity }
      case 'Infinity':
        return { ok: true, value: Infinity }
      case 'NaN':
        return { ok: true, value: NaN }
      default:
        return { ok: false, reason: `unserializable ${remote.unserializableValue}` }
    }
  }
  if (remote.type === 'undefined') {
    return { ok: true, value: undefined }
  }
  if (remote.type === 'object' && remote.subtype === 'null') {
    return { ok: true, value: null }
  }
  if (remote.type === 'string' || remote.type === 'number' || remote.type === 'boolean') {
    return { ok: true, value: remote.value }
  }
  return { ok: false, reason: `scope value of type ${remote.type}` }
}

export type FunctionScopes = {
  /** `name` as the function sees it: `undefined` when it is not in any non-global scope. */
  lookup: (name: string) => ScopeVariable | undefined
  /** Bound functions, class constructors and the like: not compilable. */
  rejection?: string
}

/** The scopes of `fn`; `lookup` reads a variable on demand. */
export const functionScopes = (fn: AnyFunction): FunctionScopes => {
  try {
    const objectId = remoteOf(fn)
    const own = post<{ internalProperties?: PropertyDescriptor[] }>('Runtime.getProperties', {
      objectId,
      ownProperties: true,
    })
    const internal = own.internalProperties ?? []
    if (internal.some((p) => p.name === '[[TargetFunction]]')) {
      return { lookup: () => undefined, rejection: 'bound function' }
    }
    if (internal.some((p) => p.name === '[[IsClassConstructor]]' && p.value?.value === true)) {
      return { lookup: () => undefined, rejection: 'class constructor' }
    }
    const scopesId = internal.find((p) => p.name === '[[Scopes]]')?.value?.objectId
    if (!scopesId) {
      return { lookup: () => undefined, rejection: 'no [[Scopes]]' }
    }
    const list = post<{ result: PropertyDescriptor[] }>('Runtime.getProperties', {
      objectId: scopesId,
      ownProperties: true,
    })
    const variables = new Map<string, RemoteObject>()
    for (const scope of list.result) {
      if (!/^\d+$/.test(scope.name) || !scope.value?.objectId) {
        continue
      }
      if (scope.value.description === 'Global') {
        continue
      }
      const vars = post<{ result: PropertyDescriptor[] }>('Runtime.getProperties', {
        objectId: scope.value.objectId,
        ownProperties: true,
      })
      for (const v of vars.result) {
        if (!variables.has(v.name) && v.value) {
          variables.set(v.name, v.value)
        }
      }
    }
    return {
      lookup: (name) => {
        const remote = variables.get(name)
        return remote ? valueOf(remote) : undefined
      },
    }
  } catch (error) {
    return { lookup: () => undefined, rejection: `inspector: ${(error as Error).message}` }
  }
}

/** Releases the remote objects of the last `functionScopes` calls. */
export const releaseScopes = (): void => {
  if (session) {
    post('Runtime.releaseObjectGroup', { objectGroup })
  }
}
