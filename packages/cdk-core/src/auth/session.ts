/**
 * The Node-side half of an HMAC session cookie that a CloudFront Function
 * verifies at the edge. Pure and dependency-free (only `node:crypto`) on
 * purpose: the edge half is a CloudFront Function, which cannot use `atob`,
 * `Buffer`, or JSON parsing cheaply, so every format here is fixed by what
 * that runtime can decode. **Do not "improve" the encodings** — a change here
 * that isn't mirrored at the edge is a session nobody can verify.
 */

import crypto from 'node:crypto'

export const SESSION_COOKIE = '__Host-cdkcore-session'
export const RETURN_COOKIE = '__Host-cdkcore-return'
/** Reserved KeyValueStore key holding the HMAC secret. Never a valid preview hostname. */
export const SESSION_SECRET_KVS_KEY = '__cdkcore-session-secret'

/** `verifyState`'s freshness window, in seconds, either side of `nowMs`. */
export const STATE_MAX_AGE_SECONDS = 600

export interface SessionPayload {
  readonly sub: string
  readonly email: string
  /** Integer seconds since epoch. */
  readonly exp: number
}

function hmacHex(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

/** Guards the length check before `timingSafeEqual`, which throws on a mismatch. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * `v1|<sub>|<email>|<exp>` signed with HMAC-SHA256, lowercase hex. `.` is not
 * banned from `sub`/`email` (email legitimately contains it) because
 * `verifySession` splits the signature off at the LAST `.`, and `exp` is all
 * digits, so the last `.` is always the payload/signature separator.
 */
export function signSession(payload: SessionPayload, secret: string): string {
  if (payload.sub.includes('|')) {
    throw new Error('signSession: sub must not contain "|"')
  }
  if (payload.email.includes('|')) {
    throw new Error('signSession: email must not contain "|"')
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp < 0) {
    throw new Error('signSession: exp must be a non-negative safe integer')
  }
  const body = `v1|${payload.sub}|${payload.email}|${payload.exp}`
  return `${body}.${hmacHex(body, secret)}`
}

/**
 * Inverse of `signSession`. Never throws: anything malformed, tampered, or
 * expired maps to `null`, because an invalid session is an anonymous caller.
 */
export function verifySession(
  value: string | undefined,
  secret: string,
  nowMs = Date.now(),
): SessionPayload | null {
  if (!value) return null
  const dot = value.lastIndexOf('.')
  if (dot === -1) return null
  const body = value.slice(0, dot)
  const signature = value.slice(dot + 1)
  if (!timingSafeEqualHex(signature, hmacHex(body, secret))) return null

  if (!body.startsWith('v1|')) return null
  const parts = body.split('|')
  if (parts.length !== 4) return null
  const [, sub, email, expText] = parts as [string, string, string, string]
  if (!/^[0-9]+$/.test(expText)) return null
  const exp = Number(expText)
  if (!Number.isSafeInteger(exp)) return null
  if (exp * 1000 <= nowMs) return null

  return { sub, email, exp }
}

/** The bytes `signState` signs: `<iat>` or `<iat>~<pr>`. */
export function stateSignedBody(input: { iat: number; pr?: number }): string {
  return input.pr === undefined ? String(input.iat) : `${input.iat}~${input.pr}`
}

/**
 * The signed-in `state` param round-tripped through Cognito. The emitted
 * string and the signed body deliberately disagree on where `pr` sits: it is
 * signed as part of the body (`<iat>~<pr>`) so it can't be swapped, but
 * emitted AFTER the signature (`<iat>.<sig>~<pr>`) so the preview router's
 * regex can recover the PR from the last segment without touching the
 * signature.
 */
export function signState(input: { iat: number; pr?: number }, secret: string): string {
  const body = stateSignedBody(input)
  const signature = hmacHex(body, secret)
  return input.pr === undefined
    ? `${input.iat}.${signature}`
    : `${input.iat}.${signature}~${input.pr}`
}

/**
 * The PKCE `code_verifier` derived from the shared secret and the state's
 * signed body — `HMAC-SHA256(secret, 'pkce|' + stateSignedBody(input))`,
 * lowercase hex (64 chars, a legal RFC 7636 `code_verifier`). The edge has no
 * CSPRNG, so it cannot generate a random verifier itself; instead it derives
 * this exact value (see the CloudFront Function gate) and sends
 * `code_challenge = base64url(SHA-256(verifier))`, and `auth-endpoint.ts`
 * re-derives the same verifier from the `state` it gets back on the
 * callback. Keeps the app client public — no client secret anywhere.
 */
export function pkceVerifier(input: { iat: number; pr?: number }, secret: string): string {
  return hmacHex(`pkce|${stateSignedBody(input)}`, secret)
}

/**
 * Inverse of `signState`. Never throws. Rejects a signature computed over a
 * swapped `pr` (the format exists for exactly this) and any `iat` outside
 * `STATE_MAX_AGE_SECONDS` of `nowMs` in either direction.
 */
export function verifyState(
  state: string | undefined,
  secret: string,
  nowMs = Date.now(),
): { iat: number; pr?: number } | null {
  if (!state) return null
  const dot = state.indexOf('.')
  if (dot === -1) return null
  const iatText = state.slice(0, dot)
  if (!/^[0-9]+$/.test(iatText)) return null
  const iat = Number(iatText)
  if (!Number.isSafeInteger(iat)) return null

  const rest = state.slice(dot + 1)
  const tilde = rest.indexOf('~')
  let signature: string
  let pr: number | undefined
  if (tilde === -1) {
    signature = rest
  } else {
    signature = rest.slice(0, tilde)
    const prText = rest.slice(tilde + 1)
    if (!/^[0-9]+$/.test(prText)) return null
    pr = Number(prText)
    if (!Number.isSafeInteger(pr)) return null
  }

  const body = stateSignedBody({ iat, pr })
  if (!timingSafeEqualHex(signature, hmacHex(body, secret))) return null

  if (Math.abs(nowMs - iat * 1000) > STATE_MAX_AGE_SECONDS * 1000) return null

  return pr === undefined ? { iat } : { iat, pr }
}

/**
 * Parses a raw `Cookie` request header (`a=1; b=2`) into a map. Never throws:
 * tolerates missing values, extra whitespace, and a `=` inside the value
 * (splits on the FIRST `=`).
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
    const value = eq === -1 ? '' : trimmed.slice(eq + 1).trim()
    if (!key) continue
    cookies[key] = value
  }
  return cookies
}

/**
 * Attributes for `SESSION_COOKIE`/`RETURN_COOKIE`. No `Domain`: the
 * `__Host-` prefix forbids one (browsers refuse to set the cookie at all if
 * it's present), so don't add one back in.
 */
export function sessionCookieAttributes(maxAgeSeconds: number): string {
  return `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}
