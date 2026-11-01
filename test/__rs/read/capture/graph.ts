/**
 * Inverse of `serializeForEngine` (packages/engine-rs/src/serialize.ts) for replaying fixtures in
 * TS: restores shared object identity (`$ref`, including cycles), own `undefined` properties,
 * non-finite numbers and `$obj` escapes. Functions (`$fn`) become inert placeholders (the read
 * transform never calls config functions).
 */
import { defineOwn } from './encode.js'

type Graph = { objects: unknown[]; root: unknown }

export const decodeGraph = (graph: Graph): any => {
  const refs = new Map<number, unknown>()

  const shellFor = (encoded: unknown): unknown => (Array.isArray(encoded) ? [] : {})

  const fill = (shell: any, encoded: any) => {
    if (Array.isArray(encoded)) {
      for (const item of encoded) {
        shell.push(decode(item))
      }
      return shell
    }
    const entries =
      Object.keys(encoded).length === 1 && '$obj' in encoded ? encoded.$obj : (encoded as object)
    for (const [key, value] of Object.entries(entries)) {
      defineOwn(shell, key, decode(value))
    }
    return shell
  }

  const decodeRef = (id: number) => {
    if (refs.has(id)) {
      return refs.get(id)
    }
    const encoded = graph.objects[id]
    const shell = shellFor(encoded)
    refs.set(id, shell)
    return fill(shell, encoded)
  }

  const decode = (value: any): unknown => {
    if (Array.isArray(value)) {
      return fill([], value)
    }
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const keys = Object.keys(value)
    if (keys.length === 1) {
      switch (keys[0]) {
        case '$fn':
          return function engineFunctionPlaceholder() {}
        case '$num':
          return Number(value.$num)
        case '$obj':
          return fill({}, value)
        case '$ref':
          return decodeRef(value.$ref)
        case '$undefined':
          return undefined
        default:
          break
      }
    }
    return fill({}, value)
  }

  return decode(graph.root)
}

/** Every object reachable from `root` (each once) with one property path to it. */
export const walkObjects = (
  root: unknown,
  visit: (value: Record<PropertyKey, unknown>, path: string[]) => void,
) => {
  const seen = new Set<object>()
  const walk = (value: unknown, path: string[]) => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }
    seen.add(value)
    visit(value as Record<PropertyKey, unknown>, path)
    for (const key of Object.keys(value)) {
      walk((value as Record<string, unknown>)[key], [...path, key])
    }
  }
  walk(root, [])
}

export const resolvePath = (root: any, path: string[]) =>
  path.reduce((value, key) => value?.[key], root)
