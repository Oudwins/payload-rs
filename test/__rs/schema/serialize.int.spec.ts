/**
 * `serializeForEngine` / `deserializeFromEngine` keep own `__proto__` keys (an own data property,
 * not the prototype accessor) everywhere a user value can carry one: a `where` from
 * `JSON.parse`, shared and nested objects, objects whose only key is reserved, and results
 * decoded back. crates/payload-engine/tests/proto_keys.rs decodes the same wire format in Rust.
 */
import { expect } from 'vitest'

import {
  createFunctionRegistry,
  deserializeFromEngine,
  serializeForEngine,
} from '../../../packages/engine-rs/src/serialize.js'
import { test } from '../../__helpers/int/vitest.js'

const hasOwnProto = (v: unknown) =>
  typeof v === 'object' && v !== null && Object.prototype.hasOwnProperty.call(v, '__proto__')

test.suite('serializeForEngine own __proto__ keys', {}, () => {
  test('should emit the wire format the Rust decoder test uses', () => {
    const shared = JSON.parse('{"__proto__":1}')
    const value = {
      where: JSON.parse('{"__proto__":{"equals":"x"}}'),
      a: shared,
      b: shared,
      only: JSON.parse('{"__proto__":{"$date":1}}'),
      esc: { $date: 'x' },
    }

    expect(serializeForEngine(value, createFunctionRegistry())).toBe(
      '{"objects":[{"__proto__":1}],"root":{"where":{"__proto__":{"equals":"x"}},"a":{"$ref":0},"b":{"$ref":0},"only":{"__proto__":{"$obj":{"$date":1}}},"esc":{"$obj":{"$date":"x"}}}}',
    )
  })

  test('should keep own __proto__ keys through a round trip', () => {
    const where = JSON.parse('{"and":[{"__proto__":{"equals":"x"}}],"title":{"__proto__":1}}')
    const { root } = JSON.parse(serializeForEngine({ where }, createFunctionRegistry()))
    const back = deserializeFromEngine(root) as any

    expect(hasOwnProto(back.where.and[0])).toBe(true)
    expect(Object.getPrototypeOf(back.where.and[0])).toBe(Object.prototype)
    expect(back.where.and[0]['__proto__']).toEqual({ equals: 'x' })
    expect(hasOwnProto(back.where.title)).toBe(true)
    expect(Object.keys(back.where.title)).toEqual(['__proto__'])
  })

  test('should not treat an inherited __proto__ accessor as a key', () => {
    const { root } = JSON.parse(
      serializeForEngine({ where: { title: 1 } }, createFunctionRegistry()),
    )

    expect(Object.keys(root.where)).toEqual(['title'])
  })
})
