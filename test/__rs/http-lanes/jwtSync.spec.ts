/**
 * Differential of the JWT strategy's synchronous HS256 path
 * (packages/payload/src/auth/strategies/verifyJWTSync.ts) against jose's `jwtVerify(token,
 * secretBytes)`, which the strategy called before and still calls for every token the sync path
 * does not decide. Property checked for every token: when the sync path decides, jose accepts the
 * token and returns the same `payload` / `protectedHeader` (as JSON, key order included). Tokens
 * Payload issues must be decided (the fast path ran).
 *
 *   pnpm vitest run --config test/__rs/http-lanes/vitest.config.ts --project http-lanes-unit
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { jwtVerify } from '../../../packages/payload/node_modules/jose/dist/webapi/jwt/verify.js'
import { jwtSign } from '../../../packages/payload/src/auth/jwt.js'
import { verifyJWTSync } from '../../../packages/payload/src/auth/strategies/verifyJWTSync.js'

const secret = '0123456789abcdef0123456789abcdef'
const now = () => Math.floor(Date.now() / 1000)

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url')

const craft = ({
  alg = 'sha256',
  header = { alg: 'HS256', authVersion: 2, typ: 'JWT' },
  payload = { id: 'abc', collection: 'users', exp: now() + 3600, iat: now() },
  signWith = secret,
}: {
  alg?: string
  header?: Buffer | Record<string, unknown> | string | unknown[]
  payload?: Buffer | Record<string, unknown> | string | unknown
  signWith?: string
}) => {
  const encode = (value: unknown) =>
    Buffer.isBuffer(value) ? base64url(value) : base64url(JSON.stringify(value))
  const signingInput = `${encode(header)}.${encode(payload)}`
  return `${signingInput}.${createHmac(alg, signWith).update(signingInput).digest('base64url')}`
}

const decide = async ({ token, key = secret }: { key?: string; token: string }) => {
  const fast = verifyJWTSync({ secret: key, token })
  let jose: string | undefined
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(key))
    jose = JSON.stringify({ payload: verified.payload, protectedHeader: verified.protectedHeader })
  } catch {
    jose = undefined
  }
  if (fast) {
    expect(JSON.stringify(fast)).toBe(jose)
  }
  return { isDecided: Boolean(fast), isJoseOk: jose !== undefined }
}

describe('verifyJWTSync vs jose', () => {
  it('should decide tokens issued by jwtSign', async () => {
    const { token } = await jwtSign({
      fieldsToSign: { id: '6921abc', collection: 'users', email: 'a@b.c', sid: 'x' },
      secret,
      tokenExpiration: 7200,
    })

    expect(await decide({ token })).toEqual({ isDecided: true, isJoseOk: true })
  })

  it('should decide crafted HS256 tokens jose accepts', async () => {
    const cases = [
      craft({}),
      craft({ payload: { id: 1, collection: 'users' } }),
      craft({ payload: { id: 1, nbf: now() - 10, exp: now() + 10 } }),
      craft({ header: { alg: 'HS256', b64: false } }),
      craft({ header: { alg: 'HS256', authVersion: 'x', kid: 'k' } }),
      craft({ payload: { id: 'ünïcödé', collection: '用户', exp: now() + 100 } }),
      craft({ payload: JSON.parse('{"__proto__": {"x": 1}, "id": 1}') }),
      craft({ payload: Buffer.from('{"id":1,"id":2}') }),
      craft({ payload: { nested: { deep: [1, 2, { a: null }] }, exp: now() + 5 } }),
      craft({ payload: { big: 'x'.repeat(20_000) } }),
    ]
    for (const token of cases) {
      expect(await decide({ token })).toEqual({ isDecided: true, isJoseOk: true })
    }
  })

  it('should leave tokens jose rejects undecided', async () => {
    const cases = [
      craft({ payload: { exp: now() - 1 } }),
      craft({ payload: { exp: now() } }),
      craft({ payload: { nbf: now() + 60 } }),
      craft({ payload: { iat: 'yesterday' } }),
      craft({ payload: { exp: String(now() + 100) } }),
      craft({ payload: { nbf: null } }),
      craft({ signWith: 'another secret entirely' }),
      craft({ header: { alg: 'none' } }),
      craft({ header: { typ: 'JWT' } }),
      craft({ header: [1, 2] }),
      craft({ header: 'HS256' }),
      craft({ payload: [1, 2, 3] }),
      craft({ payload: 42 }),
      craft({ payload: null }),
      craft({ payload: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) }),
      craft({ payload: Buffer.from('not json') }),
      craft({ header: { alg: 'HS256', crit: ['exp'] } }),
      craft({ header: { alg: 'HS256', crit: [] } }),
      '',
      'a.b',
      'a.b.c.d',
      `${craft({})}.`,
    ]
    for (const token of cases) {
      const result = await decide({ token })

      expect(result.isDecided).toBe(false)
      expect(result.isJoseOk).toBe(false)
    }
  })

  it('should leave other algorithms and encodings to jose', async () => {
    const hs384 = craft({ alg: 'sha384', header: { alg: 'HS384' } })
    const hs512 = craft({ alg: 'sha512', header: { alg: 'HS512' } })
    const valid = craft({})
    const [header, payload, signature] = valid.split('.') as [string, string, string]
    const cases = [
      hs384,
      hs512,
      craft({ header: { alg: 'HS256', crit: ['b64'], b64: true } }),
      `${header}=.${payload}.${signature}`,
      `${header}.${payload} .${signature}`,
      `${header}.${payload}.${signature}=`,
    ]
    for (const token of cases) {
      expect((await decide({ token })).isDecided).toBe(false)
    }

    expect((await decide({ token: hs384 })).isJoseOk).toBe(true)
    expect((await decide({ token: hs512 })).isJoseOk).toBe(true)
  })

  it('should leave tokens undecided for an empty secret', async () => {
    const token = craft({ signWith: '' })

    expect((await decide({ key: '', token })).isDecided).toBe(false)
  })

  it('should never decide a token jose rejects (random mutations)', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.= +/'
    let seed = 7
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const tokens = [craft({}), craft({ payload: { id: 1, exp: now() + 1000, nbf: now() - 1 } })]
    let decided = 0
    for (let index = 0; index < 3000; index++) {
      const original = tokens[index % tokens.length]!
      const position = Math.floor(random() * original.length)
      const replacement = alphabet[Math.floor(random() * alphabet.length)]!
      const token = original.slice(0, position) + replacement + original.slice(position + 1)
      const result = await decide({ token })
      if (result.isDecided) {
        decided++
      }
    }

    // mutations that leave the token unchanged (same character) stay decided
    expect(decided).toBeGreaterThan(0)
    expect(decided).toBeLessThan(300)
  })
})
