import { describe, expect, it, vi } from 'vitest'

import { handleAuthRequest } from '../src/handlers/auth-endpoint.js'
import type {
  AuthEndpointConfig,
  AuthEndpointPorts,
  AuthEndpointRequest,
} from '../src/handlers/auth-endpoint.js'
import type { TokenSet } from '../src/auth/oidc.js'
import type { AuthUser, Verifier, VerifierConfig } from '../src/auth/server.js'
import {
  pkceVerifier,
  RETURN_COOKIE,
  SESSION_COOKIE,
  signState,
  STATE_MAX_AGE_SECONDS,
  verifySession,
} from '../src/auth/session.js'
import { ID_TOKEN_HEADER } from '../src/config.js'

const SECRET = 'test-session-secret'

const CONFIG: AuthEndpointConfig = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf123',
  clientId: 'browser-client,machine-client',
  hostedUiDomain: 'cdk-core.auth.us-east-1.amazoncognito.com',
  edgeClientId: 'edge-client',
  redirectUri: 'https://example.com/auth/callback',
  sessionSecret: SECRET,
  sessionTtlSeconds: 3600,
}

const TOKENS: TokenSet = {
  idToken: 'fake-id-token',
  accessToken: 'fake-access-token',
  expiresAt: Date.now() + 3600_000,
}

const USER: AuthUser = { sub: 'user-123', email: 'alice@example.com' }

function fakePorts(overrides: Partial<AuthEndpointPorts> = {}): AuthEndpointPorts {
  const exchangeCode = vi.fn(async () => TOKENS) as unknown as AuthEndpointPorts['exchangeCode']
  const verify = vi.fn(async () => USER) as unknown as Verifier['verify']
  const createVerifier = vi.fn(
    (_config: VerifierConfig) => ({ verify }) as Verifier,
  ) as unknown as AuthEndpointPorts['createVerifier']
  return { exchangeCode, createVerifier, ...overrides }
}

function request(overrides: Partial<AuthEndpointRequest> = {}): AuthEndpointRequest {
  return {
    path: '/auth/callback',
    query: {},
    headers: {},
    cookieHeader: undefined,
    ...overrides,
  }
}

function getSetCookies(cookies: string[], name: string): string[] {
  return cookies.filter((c) => c.startsWith(`${name}=`))
}

describe('handleAuthRequest — GET /auth/callback', () => {
  it('happy path: valid state -> 302 to "/", a verifiable session cookie, return cookie cleared', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const ports = fakePorts()

    const res = await handleAuthRequest(
      request({ query: { code: 'auth-code', state } }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(res.headers['cache-control']).toBe('no-store')

    const sessionCookies = getSetCookies(res.cookies, SESSION_COOKIE)
    expect(sessionCookies).toHaveLength(1)
    const cookieValue = sessionCookies[0]!.split(';')[0]!.split('=').slice(1).join('=')
    const payload = verifySession(cookieValue, SECRET)
    expect(payload).toEqual({ sub: USER.sub, email: USER.email, exp: expect.any(Number) })

    const returnCookies = getSetCookies(res.cookies, RETURN_COOKIE)
    expect(returnCookies).toHaveLength(1)
    expect(returnCookies[0]).toContain('Max-Age=0')
  })

  it('exchanges the code with the verifier derived from the state (the value the edge also derives)', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const pr = 42
    const state = signState({ iat, pr }, SECRET)
    const ports = fakePorts()

    await handleAuthRequest(request({ query: { code: 'auth-code', state } }), CONFIG, ports)

    const expectedVerifier = pkceVerifier({ iat, pr }, SECRET)
    expect(ports.exchangeCode).toHaveBeenCalledWith(
      { issuer: CONFIG.issuer, clientId: CONFIG.edgeClientId, domain: CONFIG.hostedUiDomain },
      { code: 'auth-code', verifier: expectedVerifier, redirectUri: CONFIG.redirectUri },
    )
  })

  it('honours a valid __Host-cdkcore-return of /item/123', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const ports = fakePorts()

    const res = await handleAuthRequest(
      request({
        query: { code: 'auth-code', state },
        cookieHeader: `${RETURN_COOKIE}=/item/123`,
      }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/item/123')
  })

  it('rejects a return cookie of //evil.com, falling back to "/"', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const ports = fakePorts()

    const res = await handleAuthRequest(
      request({
        query: { code: 'auth-code', state },
        cookieHeader: `${RETURN_COOKIE}=//evil.com`,
      }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
  })

  // A protocol-relative redirect written with a backslash. The WHATWG URL
  // parser treats `\` as `/` for http(s), so a browser resolves
  // `Location: /\evil.com` to the host `evil.com` exactly as it would `//`.
  // Blocking only `//` is the version of this check that looks right and is
  // not.
  it('rejects a return cookie of /\\evil.com, falling back to "/"', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const ports = fakePorts()

    const res = await handleAuthRequest(
      request({
        query: { code: 'auth-code', state },
        cookieHeader: `${RETURN_COOKIE}=/\\evil.com`,
      }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
  })

  it('rejects a return cookie carrying a control character', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const ports = fakePorts()

    const res = await handleAuthRequest(
      request({
        query: { code: 'auth-code', state },
        cookieHeader: `${RETURN_COOKIE}=/ok\r\nx-injected: 1`,
      }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
  })

  it('rejects a return cookie of https://evil.com, falling back to "/"', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const ports = fakePorts()

    const res = await handleAuthRequest(
      request({
        query: { code: 'auth-code', state },
        cookieHeader: `${RETURN_COOKIE}=https://evil.com`,
      }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
  })

  it('rejects a tampered state -> 400, no Set-Cookie', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const tampered = state.slice(0, -1) + (state.endsWith('0') ? '1' : '0')
    const ports = fakePorts()

    const res = await handleAuthRequest(
      request({ query: { code: 'auth-code', state: tampered } }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(400)
    expect(res.cookies).toEqual([])
    expect(ports.exchangeCode).not.toHaveBeenCalled()
  })

  it('rejects an absent state -> 400, no Set-Cookie', async () => {
    const ports = fakePorts()

    const res = await handleAuthRequest(request({ query: { code: 'auth-code' } }), CONFIG, ports)

    expect(res.statusCode).toBe(400)
    expect(res.cookies).toEqual([])
    expect(ports.exchangeCode).not.toHaveBeenCalled()
  })

  it('rejects a stale state -> 400, no Set-Cookie', async () => {
    const iat = Math.floor(Date.now() / 1000) - (STATE_MAX_AGE_SECONDS + 60)
    const state = signState({ iat }, SECRET)
    const ports = fakePorts()

    const res = await handleAuthRequest(
      request({ query: { code: 'auth-code', state } }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(400)
    expect(res.cookies).toEqual([])
    expect(ports.exchangeCode).not.toHaveBeenCalled()
  })

  it('reports an oauth error param as a 400 without touching the ports', async () => {
    const ports = fakePorts()

    const res = await handleAuthRequest(
      request({ query: { error: 'access_denied', state: 'whatever' } }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('access_denied')
    expect(ports.exchangeCode).not.toHaveBeenCalled()
  })

  it('maps a token-exchange failure to 502', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const ports = fakePorts({
      exchangeCode: vi.fn(async () => {
        throw new Error('invalid_grant')
      }) as unknown as AuthEndpointPorts['exchangeCode'],
    })

    const res = await handleAuthRequest(
      request({ query: { code: 'auth-code', state } }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(502)
    expect(res.cookies).toEqual([])
  })

  it('maps an id-token verification failure to 502', async () => {
    const iat = Math.floor(Date.now() / 1000)
    const state = signState({ iat }, SECRET)
    const failingVerify = vi.fn(async () => {
      throw new Error('bad signature')
    }) as unknown as Verifier['verify']
    const ports = fakePorts({
      createVerifier: vi.fn(() => ({ verify: failingVerify })) as unknown as AuthEndpointPorts['createVerifier'],
    })

    const res = await handleAuthRequest(
      request({ query: { code: 'auth-code', state } }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(502)
    expect(res.cookies).toEqual([])
  })
})

describe('handleAuthRequest — GET /auth/logout', () => {
  it('302s to /auth/goodbye and clears the session cookie', async () => {
    const ports = fakePorts()
    const res = await handleAuthRequest(request({ path: '/auth/logout' }), CONFIG, ports)

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/auth/goodbye')
    expect(res.headers['cache-control']).toBe('no-store')
    const cleared = getSetCookies(res.cookies, SESSION_COOKIE)
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toContain('Max-Age=0')
  })
})

describe('handleAuthRequest — GET /auth/goodbye', () => {
  it('200s with an html page', async () => {
    const ports = fakePorts()
    const res = await handleAuthRequest(request({ path: '/auth/goodbye' }), CONFIG, ports)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toContain('Signed out')
  })
})

describe('handleAuthRequest — GET /auth/session', () => {
  it('a good token -> 204 with a session cookie', async () => {
    const ports = fakePorts()
    const res = await handleAuthRequest(
      request({ path: '/auth/session', headers: { [ID_TOKEN_HEADER]: 'good-token' } }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(204)
    expect(res.headers['cache-control']).toBe('no-store')
    const sessionCookies = getSetCookies(res.cookies, SESSION_COOKIE)
    expect(sessionCookies).toHaveLength(1)
    expect(ports.createVerifier).toHaveBeenCalledWith({ issuer: CONFIG.issuer, clientId: CONFIG.clientId })
  })

  it('a bad token -> 401, no cookie', async () => {
    const failingVerify = vi.fn(async () => {
      throw new Error('invalid token')
    }) as unknown as Verifier['verify']
    const ports = fakePorts({
      createVerifier: vi.fn(() => ({ verify: failingVerify })) as unknown as AuthEndpointPorts['createVerifier'],
    })

    const res = await handleAuthRequest(
      request({ path: '/auth/session', headers: { [ID_TOKEN_HEADER]: 'bad-token' } }),
      CONFIG,
      ports,
    )

    expect(res.statusCode).toBe(401)
    expect(res.cookies).toEqual([])
  })

  it('a missing token -> 401, no cookie', async () => {
    const ports = fakePorts()
    const res = await handleAuthRequest(request({ path: '/auth/session' }), CONFIG, ports)

    expect(res.statusCode).toBe(401)
    expect(res.cookies).toEqual([])
  })
})

describe('handleAuthRequest — unknown routes', () => {
  it('404s under /auth/', async () => {
    const ports = fakePorts()
    const res = await handleAuthRequest(request({ path: '/auth/whatever' }), CONFIG, ports)
    expect(res.statusCode).toBe(404)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

describe('every response', () => {
  const routes: Partial<AuthEndpointRequest>[] = [
    { path: '/auth/callback', query: {} },
    { path: '/auth/logout' },
    { path: '/auth/goodbye' },
    { path: '/auth/session' },
    { path: '/auth/whatever' },
  ]

  it('carries cache-control: no-store', async () => {
    const ports = fakePorts()
    for (const overrides of routes) {
      const res = await handleAuthRequest(request(overrides), CONFIG, ports)
      expect(res.headers['cache-control']).toBe('no-store')
    }
  })
})
