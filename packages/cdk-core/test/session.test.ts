import crypto from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  parseCookieHeader,
  pkceVerifier,
  sessionCookieAttributes,
  signSession,
  signState,
  STATE_MAX_AGE_SECONDS,
  stateSignedBody,
  verifySession,
  verifyState,
} from '../src/auth/session.js'

const SECRET = 'test-secret'
const OTHER_SECRET = 'other-secret'

describe('signSession / verifySession', () => {
  it('round-trips sub/email/exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = signSession({ sub: 'abc-123', email: 'alice@example.com', exp }, SECRET)
    expect(verifySession(token, SECRET)).toEqual({ sub: 'abc-123', email: 'alice@example.com', exp })
  })

  it('rejects a tampered payload', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = signSession({ sub: 'abc-123', email: 'alice@example.com', exp }, SECRET)
    const dot = token.lastIndexOf('.')
    const body = token.slice(0, dot)
    const signature = token.slice(dot + 1)
    const tampered = `${body.replace('abc-123', 'mallory')}.${signature}`
    expect(verifySession(tampered, SECRET)).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = signSession({ sub: 'abc-123', email: 'alice@example.com', exp }, SECRET)
    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
    expect(verifySession(tampered, SECRET)).toBeNull()
  })

  it('rejects an expired session', () => {
    const exp = Math.floor(Date.now() / 1000) - 10
    const token = signSession({ sub: 'abc-123', email: 'alice@example.com', exp }, SECRET)
    expect(verifySession(token, SECRET)).toBeNull()
  })

  it('rejects a token signed with the wrong secret', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = signSession({ sub: 'abc-123', email: 'alice@example.com', exp }, OTHER_SECRET)
    expect(verifySession(token, SECRET)).toBeNull()
  })

  it('rejects undefined', () => {
    expect(verifySession(undefined, SECRET)).toBeNull()
  })

  it('rejects the empty string', () => {
    expect(verifySession('', SECRET)).toBeNull()
  })

  it('rejects a value with no "."', () => {
    expect(verifySession('no-dot-here', SECRET)).toBeNull()
  })

  it('rejects a payload that does not start with v1|', () => {
    const body = 'v2|abc|a@b.com|9999999999'
    const token = `${body}.${signSessionRaw(body)}`
    expect(verifySession(token, SECRET)).toBeNull()
  })

  it('rejects a payload without exactly 4 fields', () => {
    const body = 'v1|abc|a@b.com'
    const token = `${body}.${signSessionRaw(body)}`
    expect(verifySession(token, SECRET)).toBeNull()
  })

  it('rejects a non-numeric exp', () => {
    const body = 'v1|abc|a@b.com|soon'
    const token = `${body}.${signSessionRaw(body)}`
    expect(verifySession(token, SECRET)).toBeNull()
  })

  it('handles an email containing "."', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = signSession({ sub: 'abc-123', email: 'alice.smith@example.com', exp }, SECRET)
    expect(verifySession(token, SECRET)).toEqual({
      sub: 'abc-123',
      email: 'alice.smith@example.com',
      exp,
    })
  })

  it('throws on a sub containing "|"', () => {
    expect(() => signSession({ sub: 'a|b', email: 'a@b.com', exp: 1 }, SECRET)).toThrow()
  })

  it('throws on an email containing "|"', () => {
    expect(() => signSession({ sub: 'abc', email: 'a|b@b.com', exp: 1 }, SECRET)).toThrow()
  })

  it('throws on a negative exp', () => {
    expect(() => signSession({ sub: 'abc', email: 'a@b.com', exp: -1 }, SECRET)).toThrow()
  })

  it('throws on a non-integer exp', () => {
    expect(() => signSession({ sub: 'abc', email: 'a@b.com', exp: 1.5 }, SECRET)).toThrow()
  })

  function signSessionRaw(body: string): string {
    // local helper mirroring the module's HMAC, for constructing malformed-but-signed fixtures
    return crypto.createHmac('sha256', SECRET).update(body).digest('hex')
  }
})

describe('signState / verifyState', () => {
  it('round-trips without pr', () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    expect(verifyState(state, SECRET)).toEqual({ iat })
  })

  it('round-trips with pr', () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat, pr: 42 }, SECRET)
    expect(verifyState(state, SECRET)).toEqual({ iat, pr: 42 })
  })

  it('rejects a tampered signature', () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const tampered = state.slice(0, -1) + (state.endsWith('0') ? '1' : '0')
    expect(verifyState(tampered, SECRET)).toBeNull()
  })

  it('rejects a swapped pr (signature covers the original pr)', () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat, pr: 42 }, SECRET)
    const swapped = state.replace(/~42$/, '~43')
    expect(swapped).not.toEqual(state)
    expect(verifyState(swapped, SECRET)).toBeNull()
  })

  it('rejects a stale iat (older than the freshness window)', () => {
    const iat = Math.floor(Date.now() / 1000) - (STATE_MAX_AGE_SECONDS + 60)
    const state = signState({ iat }, SECRET)
    expect(verifyState(state, SECRET)).toBeNull()
  })

  it('rejects a far-future iat', () => {
    const iat = Math.floor(Date.now() / 1000) + (STATE_MAX_AGE_SECONDS + 60)
    const state = signState({ iat }, SECRET)
    expect(verifyState(state, SECRET)).toBeNull()
  })

  it('accepts an iat just inside the freshness window', () => {
    const iat = Math.floor(Date.now() / 1000) - (STATE_MAX_AGE_SECONDS - 5)
    const state = signState({ iat }, SECRET)
    expect(verifyState(state, SECRET)).toEqual({ iat })
  })

  it('rejects undefined and the empty string', () => {
    expect(verifyState(undefined, SECRET)).toBeNull()
    expect(verifyState('', SECRET)).toBeNull()
  })

  it('rejects a wrong secret', () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat, pr: 7 }, OTHER_SECRET)
    expect(verifyState(state, SECRET)).toBeNull()
  })

  it('emits a state matching the preview router allowlist', () => {
    const iat = Math.floor(Date.now() / 1000)
    expect(signState({ iat }, SECRET)).toMatch(/^[A-Za-z0-9._~-]+$/)
    expect(signState({ iat, pr: 123 }, SECRET)).toMatch(/^[A-Za-z0-9._~-]+$/)
  })
})

describe('stateSignedBody', () => {
  it('is just the iat when pr is absent', () => {
    expect(stateSignedBody({ iat: 1234 })).toBe('1234')
  })

  it('is <iat>~<pr> when pr is present', () => {
    expect(stateSignedBody({ iat: 1234, pr: 42 })).toBe('1234~42')
  })
})

describe('pkceVerifier', () => {
  it('is 64 lowercase hex characters', () => {
    const verifier = pkceVerifier({ iat: 1234 }, SECRET)
    expect(verifier).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches the RFC 7636 code_verifier grammar', () => {
    const verifier = pkceVerifier({ iat: 1234, pr: 7 }, SECRET)
    expect(verifier).toMatch(/^[A-Za-z0-9-._~]{43,128}$/)
  })

  it('is deterministic for the same input and secret', () => {
    expect(pkceVerifier({ iat: 1234, pr: 7 }, SECRET)).toBe(pkceVerifier({ iat: 1234, pr: 7 }, SECRET))
  })

  it('differs when pr differs', () => {
    expect(pkceVerifier({ iat: 1234, pr: 7 }, SECRET)).not.toBe(pkceVerifier({ iat: 1234, pr: 8 }, SECRET))
  })

  it('differs when the secret differs', () => {
    expect(pkceVerifier({ iat: 1234 }, SECRET)).not.toBe(pkceVerifier({ iat: 1234 }, OTHER_SECRET))
  })

  it('equals HMAC-SHA256(secret, "pkce|" + stateSignedBody(input)) in hex', () => {
    const input = { iat: 1234, pr: 7 }
    const expected = crypto
      .createHmac('sha256', SECRET)
      .update(`pkce|${stateSignedBody(input)}`)
      .digest('hex')
    expect(pkceVerifier(input, SECRET)).toBe(expected)
  })
})

describe('parseCookieHeader', () => {
  it('parses a realistic header', () => {
    expect(parseCookieHeader('a=1; b=2; c=hello%20world')).toEqual({
      a: '1',
      b: '2',
      c: 'hello%20world',
    })
  })

  it('returns {} for undefined', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
  })

  it('splits on the first "=" so values may contain "="', () => {
    expect(parseCookieHeader('token=abc=def')).toEqual({ token: 'abc=def' })
  })

  it('tolerates junk: stray semicolons, whitespace, empty segments', () => {
    expect(parseCookieHeader('  ; a=1 ;; b = 2 ;')).toEqual({ a: '1', b: '2' })
  })

  it('never throws on garbage input', () => {
    expect(() => parseCookieHeader('=====')).not.toThrow()
  })
})

describe('sessionCookieAttributes', () => {
  it('returns the fixed __Host- compatible attribute string', () => {
    expect(sessionCookieAttributes(3600)).toBe('Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600')
  })
})
