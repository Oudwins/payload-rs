import type { KeyObject } from 'crypto'

import { createHmac, createSecretKey, timingSafeEqual } from 'crypto'
import { decode as decodeBase64url } from 'jose/base64url'

type DecodedJWTPayload = Record<string, unknown>

type VerifiedJWT = {
  payload: DecodedJWTPayload
  protectedHeader: Record<string, unknown>
}

const base64urlSegment = /^[\w-]+$/
const hs256SignatureLength = 43
const strictDecoder = new TextDecoder('utf-8', { fatal: true })
const textEncoder = new TextEncoder()
/** HMAC keys per secret (`null`: a zero-length key, which WebCrypto refuses for HMAC). */
const keysBySecret = new Map<string, KeyObject | null>()

/**
 * Synchronous verification of the tokens Payload issues: compact, HS256, no `crit` header, a
 * canonically encoded signature. Returns what `jwtVerify(token, secretBytes)` (jose, no options)
 * returns when it can tell that jose would succeed, and `undefined` otherwise: the caller then
 * runs jose itself, which stays the authority for every other token (other algorithms,
 * non-canonical encodings, invalid signatures, failing claims).
 *
 * Every check mirrors jose's: the signature is HMAC-SHA256 over the ASCII `header.payload` with the
 * UTF-8 bytes of the secret; the header and the claims set are decoded with jose's base64url
 * decoder, a fatal UTF-8 decoder and `JSON.parse`, and must be plain objects; `iat` / `nbf` / `exp`,
 * when present, must be numbers with `nbf <= now < exp` (no clock tolerance). jose verifies the
 * signature through WebCrypto on the libuv thread pool; avoiding that hop is the point.
 */
export const verifyJWTSync = ({
  secret,
  token,
}: {
  secret: string
  token: string
}): undefined | VerifiedJWT => {
  try {
    const segments = token.split('.')

    if (segments.length !== 3) {
      return undefined
    }

    const [encodedHeader, encodedPayload, signature] = segments as [string, string, string]

    if (
      signature.length !== hs256SignatureLength ||
      !base64urlSegment.test(encodedHeader) ||
      !base64urlSegment.test(encodedPayload) ||
      !base64urlSegment.test(signature)
    ) {
      return undefined
    }

    const key = getKey(secret)

    if (!key) {
      return undefined
    }

    const expectedSignature = createHmac('sha256', key)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url')

    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return undefined
    }

    const protectedHeader = parseJSONSegment(encodedHeader)

    if (!protectedHeader || protectedHeader.alg !== 'HS256' || protectedHeader.crit !== undefined) {
      return undefined
    }

    const payload = parseJSONSegment(encodedPayload)

    if (!payload) {
      return undefined
    }

    const now = Math.floor(Date.now() / 1000)
    const { exp, iat, nbf } = payload

    if (
      (iat !== undefined && typeof iat !== 'number') ||
      (nbf !== undefined && (typeof nbf !== 'number' || nbf > now)) ||
      (exp !== undefined && (typeof exp !== 'number' || exp <= now))
    ) {
      return undefined
    }

    return { payload, protectedHeader }
  } catch {
    return undefined
  }
}

const getKey = (secret: string) => {
  let key = keysBySecret.get(secret)

  if (key === undefined) {
    const keyBytes = textEncoder.encode(secret)

    key = keyBytes.length === 0 ? null : createSecretKey(keyBytes)
    keysBySecret.set(secret, key)
  }

  return key
}

const parseJSONSegment = (segment: string): DecodedJWTPayload | undefined => {
  let parsed: unknown

  try {
    parsed = JSON.parse(strictDecoder.decode(decodeBase64url(segment)))
  } catch {
    return undefined
  }

  return isPlainObject(parsed) ? parsed : undefined
}

/** jose's `isObject`: a non-null object whose prototype is `null` or a direct child of `null`. */
const isPlainObject = (input: unknown): input is DecodedJWTPayload => {
  if (
    typeof input !== 'object' ||
    input === null ||
    Object.prototype.toString.call(input) !== '[object Object]'
  ) {
    return false
  }

  const prototype = Object.getPrototypeOf(input)

  return prototype === null || Object.getPrototypeOf(prototype) === null
}
