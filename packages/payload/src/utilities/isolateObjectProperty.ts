/**
 * Creates a proxy for the given object that has its own property
 */
export function isolateObjectProperty<T extends object>(object: T, key: (keyof T)[] | keyof T): T {
  const keys = Array.isArray(key) ? key : [key]
  const delegate = {} as T

  // Initialize delegate with the keys, if they exist in the original object
  for (const k of keys) {
    if (k in object) {
      delegate[k] = object[k]
    }
  }

  const handler: ProxyHandler<T> = {
    deleteProperty(target, p): boolean {
      return Reflect.deleteProperty(keys.includes(p as keyof T) ? delegate : target, p)
    },
    get(target, p, receiver) {
      if (keys.includes(p as keyof T)) {
        return Reflect.get(delegate, p, receiver)
      }
      // Use target as receiver to preserve private field access (e.g., Request#headers in Node 24+)
      return Reflect.get(target, p, target)
    },
    has(target, p) {
      return Reflect.has(keys.includes(p as keyof T) ? delegate : target, p)
    },
    set(target, p, newValue, _receiver) {
      if (keys.includes(p as keyof T)) {
        // in case of transactionID we must ignore any receiver, because
        // "If provided and target does not have a setter for propertyKey, the property will be set on receiver instead."
        return Reflect.set(delegate, p, newValue)
      }
      return Reflect.set(target, p, newValue, target)
    },
  }
  const proxy = new Proxy(object, handler)
  isolatedObjects.set(proxy, { delegate, keys, target: object })
  return proxy
}

/**
 * The proxies `isolateObjectProperty` created, with what they forward to (a `WeakMap` on
 * `globalThis`, shared by every copy of this module). Used by the Rust engine's fused lanes to
 * read a request through Payload's own proxy without running unknown code.
 */
const isolatedObjects = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('payload.isolateObjectProperty')
] ??= new WeakMap()) as WeakMap<object, { delegate: object; keys: PropertyKey[]; target: object }>
