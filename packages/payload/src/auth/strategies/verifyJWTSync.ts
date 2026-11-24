import type { KeyObject } from 'crypto'

import { createHmac, createSecretKey, timingSafeEqual } from 'crypto'
import { decode as decodeBase64url } from 'jose/base64url'

type DecodedJWTPayload = Record<string, unknown>

const base64urlSegment = /^[\w-]+$/
const hs256SignatureLength = 43
const strictDecoder = new TextDecoder('utf-8', { fatal: true })
const textEncoder = new TextEncoder()
/** HMAC keys per secret (`null`: a zero-length key, which WebCrypto refuses for HMAC). */
const keysBySecret = new Map<string, KeyObject | null>()

/**
 * Tokens whose signature verified, per secret: the decoded JSON text of their header and claims
 * set (both parse to plain objects, the header is `alg: HS256` without `crit`). Signature, base64url
 * and UTF-8 checks are pure functions of (secret, token), so a repeated token skips them; the
 * objects are parsed again per call and the time claims are checked per call. Only tokens signed
 * with the secret get here, at most `maxVerifiedTokens` per secret (oldest evicted first).
 */
const verifiedTokensBySecret = new Map<string, Map<string, { header: string; payload: string }>>()
const maxVerifiedTokens = 1000

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
export const verifyJWTSync = ({ secret, token }: { secret: string; token: string }) => {
  try {
    const verified = verifiedTokensBySecret.get(secret)?.get(token)

    if (verified) {
      return withValidClaims({
        payload: JSON.parse(verified.payload),
        protectedHeader: JSON.parse(verified.header),
      })
    }

    const [encodedHeader, encodedPayload, signature, ...rest] = token.split('.')

    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      signature === undefined ||
      rest.length > 0 ||
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

    const headerJSON = decodeJSONSegment(encodedHeader)
    const payloadJSON = decodeJSONSegment(encodedPayload)

    if (headerJSON === undefined || payloadJSON === undefined) {
      return undefined
    }

    const protectedHeader = parsePlainObject(headerJSON)

    if (!protectedHeader || protectedHeader.alg !== 'HS256' || protectedHeader.crit !== undefined) {
      return undefined
    }

    const payload = parsePlainObject(payloadJSON)

    if (!payload) {
      return undefined
    }

    rememberVerifiedToken({ header: headerJSON, payload: payloadJSON, secret, token })

    return withValidClaims({ payload, protectedHeader })
  } catch {
    return undefined
  }
}

/** The verified token when its `iat` / `nbf` / `exp` pass jose's checks now, else `undefined`. */
const withValidClaims = ({
  payload,
  protectedHeader,
}: {
  payload: DecodedJWTPayload
  protectedHeader: DecodedJWTPayload
}) => {
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
}

const rememberVerifiedToken = ({
  header,
  payload,
  secret,
  token,
}: {
  header: string
  payload: string
  secret: string
  token: string
}) => {
  let verifiedTokens = verifiedTokensBySecret.get(secret)

  if (!verifiedTokens) {
    verifiedTokens = new Map()
    verifiedTokensBySecret.set(secret, verifiedTokens)
  }

  if (verifiedTokens.size >= maxVerifiedTokens) {
    verifiedTokens.delete(verifiedTokens.keys().next().value!)
  }

  verifiedTokens.set(token, { header, payload })
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

/** A segment's text: jose's base64url decoder, then a fatal UTF-8 decoder. */
const decodeJSONSegment = (segment: string) => {
  try {
    return strictDecoder.decode(decodeBase64url(segment))
  } catch {
    return undefined
  }
}

/** `JSON.parse`, when the result is a plain object. */
const parsePlainObject = (json: string) => {
  let parsed: unknown

  try {
    parsed = JSON.parse(json)
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
