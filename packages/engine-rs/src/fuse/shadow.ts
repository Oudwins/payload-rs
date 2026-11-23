/**
 * Lane-shadow comparison (FUSE_CONTRACT.md section 7): a serialization that tells apart
 * everything a caller could observe in a result: key order, own `undefined`, `-0`, `NaN`,
 * `Date`s, class instances, holes and shared identity (a repeated object is written as a
 * back-reference to its first appearance).
 */
export const canonical = (value: unknown): string => {
  const seen = new Map<object, number>()
  const out: string[] = []
  const write = (v: unknown, depth: number): void => {
    if (depth > 200) {
      out.push('<deep>')
      return
    }
    switch (typeof v) {
      case 'bigint':
        out.push(`${v}n`)
        return
      case 'boolean':
        out.push(String(v))
        return
      case 'function':
      case 'symbol':
        out.push(`<${typeof v}>`)
        return
      case 'number':
        out.push(Object.is(v, -0) ? '-0' : String(v))
        return
      case 'string':
        out.push(JSON.stringify(v))
        return
      case 'undefined':
        out.push('undefined')
        return
      default:
        break
    }
    if (v === null) {
      out.push('null')
      return
    }
    const object = v as object
    const ref = seen.get(object)
    if (ref !== undefined) {
      out.push(`#${ref}`)
      return
    }
    seen.set(object, seen.size)
    if (object instanceof Date) {
      out.push(`Date(${object.getTime()})`)
      return
    }
    const prototype = Object.getPrototypeOf(object)
    if (Array.isArray(object)) {
      out.push('[')
      for (let i = 0; i < object.length; i++) {
        if (i > 0) {
          out.push(',')
        }
        if (!(i in object)) {
          out.push('<hole>')
        } else {
          write(object[i], depth + 1)
        }
      }
      out.push(']')
      return
    }
    if (prototype !== Object.prototype && prototype !== null) {
      out.push(`${prototype?.constructor?.name ?? '?'}`)
    }
    out.push('{')
    let first = true
    for (const key of Reflect.ownKeys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!
      if (!first) {
        out.push(',')
      }
      first = false
      out.push(typeof key === 'symbol' ? `[${String(key)}]` : JSON.stringify(key))
      if (!descriptor.enumerable) {
        out.push('(hidden)')
      }
      out.push(':')
      if ('value' in descriptor) {
        write(descriptor.value, depth + 1)
      } else {
        out.push('<accessor>')
      }
    }
    out.push('}')
  }
  write(value, 0)
  return out.join('')
}

/** The first index where two canonical strings differ, with some context (diff logs). */
export const firstDifference = (
  a: string,
  b: string,
): { at: number; exact: string; fused: string } => {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) {
    at++
  }
  const from = Math.max(0, at - 80)
  return { at, exact: a.slice(from, at + 120), fused: b.slice(from, at + 120) }
}
