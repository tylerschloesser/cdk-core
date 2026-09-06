import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteAuthConfig, SiteConfig } from '../src/config.js'
import { CONFIG_PATH } from '../src/config.js'
import { codeChallengeS256, exchangeCode } from '../src/auth/oidc.js'
import {
  buildAuthorizeUrl,
  formatState,
  getStoredAuth,
  getToken,
  handleCallback,
  parseState,
  PKCE_STORAGE_KEY,
  redirectUriFor,
  resetAuthState,
  resetConfigCache,
  setStoredAuth,
} from '../src/auth/browser.js'

const AUTH: SiteAuthConfig = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf123',
  clientId: 'test-client-id',
  domain: 'example.auth.us-east-1.amazoncognito.com',
}

const PROD: SiteConfig = { site: 'example.com', mode: 'prod', auth: AUTH }
const PREVIEW: SiteConfig = { site: 'example.com', mode: 'preview', pr: 12, auth: AUTH }
const LOCAL: SiteConfig = { site: 'localhost', mode: 'local' }

// A minimal in-memory Storage. Node has neither localStorage nor
// sessionStorage, so every test that goes through browser.ts installs one of
// these on globalThis and removes it afterwards.
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  } as unknown as Storage
}

/** Fakes `fetch` for `/__config.json` and, optionally, `oauth2/token`. */
function installFetch(config: SiteConfig, tokenHandler?: (init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    if (url === CONFIG_PATH) return new Response(JSON.stringify(config), { status: 200 })
    if (url.includes('/oauth2/token')) {
      if (!tokenHandler) throw new Error(`installFetch: no tokenHandler for ${url}`)
      return tokenHandler(init)
    }
    throw new Error(`installFetch: unexpected URL ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  resetConfigCache()
  resetAuthState()
  vi.stubGlobal('localStorage', fakeStorage())
  vi.stubGlobal('sessionStorage', fakeStorage())
  vi.stubGlobal('window', {
    location: { pathname: '/dashboard', search: '?tab=2', assign: vi.fn() },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('redirectUriFor', () => {
  it('is the site\'s own callback in prod', () => {
    expect(redirectUriFor(PROD)).toBe('https://example.com/auth/callback')
  })

  it('is the fixed bounce host in preview, not the PR\'s own hostname', () => {
    expect(redirectUriFor(PREVIEW)).toBe('https://oauth.preview.example.com/')
  })

  it('throws in local mode', () => {
    expect(() => redirectUriFor(LOCAL)).toThrow()
  })

  it('throws in preview mode with no pr', () => {
    expect(() => redirectUriFor({ site: 'example.com', mode: 'preview' })).toThrow()
  })
})

describe('formatState / parseState', () => {
  it('is the bare nonce in prod', () => {
    expect(formatState(PROD, 'nonceXYZ')).toBe('nonceXYZ')
  })

  it('is "<nonce>.<pr>" in preview', () => {
    expect(formatState(PREVIEW, 'nonceXYZ')).toBe('nonceXYZ.12')
  })

  it('throws in preview mode with no pr', () => {
    expect(() => formatState({ site: 'example.com', mode: 'preview' }, 'n')).toThrow()
  })

  it('round-trips a preview state', () => {
    expect(parseState(formatState(PREVIEW, 'nonceXYZ'))).toEqual({ nonce: 'nonceXYZ', pr: 12 })
  })

  it('round-trips a prod state (no pr)', () => {
    expect(parseState(formatState(PROD, 'nonceXYZ'))).toEqual({ nonce: 'nonceXYZ' })
  })

  it.each(['abc.12.34', 'abc.', 'a b.1', ''])('rejects %j', (bad) => {
    expect(parseState(bad)).toBeNull()
  })
})

describe('buildAuthorizeUrl', () => {
  it('is the hosted-UI authorize URL with identity_provider=Google', () => {
    const url = new URL(
      buildAuthorizeUrl(AUTH, {
        redirectUri: 'https://example.com/auth/callback',
        state: 'nonceXYZ.12',
        codeChallenge: 'challenge123',
      }),
    )
    expect(url.host).toBe(AUTH.domain)
    expect(url.pathname).toBe('/oauth2/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(AUTH.clientId)
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('state')).toBe('nonceXYZ.12')
    expect(url.searchParams.get('code_challenge')).toBe('challenge123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('identity_provider')).toBe('Google')
  })
})

describe('codeChallengeS256', () => {
  it('matches the RFC 7636 Appendix B vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(await codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})

describe('exchangeCode', () => {
  it('posts a form-encoded authorization_code request and returns a TokenSet', async () => {
    const fetchMock = installFetch(PROD, () =>
      new Response(
        JSON.stringify({
          id_token: 'id-tok',
          access_token: 'access-tok',
          refresh_token: 'refresh-tok',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )

    const before = Date.now()
    const result = await exchangeCode(AUTH, {
      code: 'code-123',
      verifier: 'verifier-123',
      redirectUri: 'https://example.com/auth/callback',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://${AUTH.domain}/oauth2/token`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    )

    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe(AUTH.clientId)
    expect(body.get('code')).toBe('code-123')
    expect(body.get('redirect_uri')).toBe('https://example.com/auth/callback')
    expect(body.get('code_verifier')).toBe('verifier-123')

    expect(result.idToken).toBe('id-tok')
    expect(result.accessToken).toBe('access-tok')
    expect(result.refreshToken).toBe('refresh-tok')
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000)
  })

  it('throws an error naming the status and the error field on a non-2xx', async () => {
    installFetch(PROD, () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    await expect(
      exchangeCode(AUTH, { code: 'bad', verifier: 'v', redirectUri: 'https://example.com/auth/callback' }),
    ).rejects.toThrow(/invalid_grant/)
  })
})

describe('handleCallback', () => {
  function seedPkce(nonce: string) {
    sessionStorage.setItem(
      PKCE_STORAGE_KEY,
      JSON.stringify({ verifier: 'verifier-123', nonce, returnTo: '/dashboard?tab=2' }),
    )
  }

  it('exchanges the code, stores tokens under cdkcore:auth, and returns returnTo', async () => {
    installFetch(PROD, () =>
      new Response(
        JSON.stringify({
          id_token: 'id-tok',
          access_token: 'access-tok',
          refresh_token: 'refresh-tok',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )
    seedPkce('nonceXYZ')

    const returnTo = await handleCallback('?code=abc&state=nonceXYZ')

    expect(returnTo).toBe('/dashboard?tab=2')
    expect(getStoredAuth()).toEqual({
      idToken: 'id-tok',
      accessToken: 'access-tok',
      refreshToken: 'refresh-tok',
      expiresAt: expect.any(Number),
    })
    // The PKCE entry is one-time use.
    expect(sessionStorage.getItem(PKCE_STORAGE_KEY)).toBeNull()
  })

  it('throws on a mismatched nonce and stores nothing', async () => {
    installFetch(PROD)
    seedPkce('nonceXYZ')

    await expect(handleCallback('?code=abc&state=wrong-nonce')).rejects.toThrow(
      /state does not match/,
    )
    expect(getStoredAuth()).toBeNull()
  })

  it('throws when the provider reports an error', async () => {
    installFetch(PROD)
    await expect(handleCallback('?error=access_denied')).rejects.toThrow(/access_denied/)
    expect(getStoredAuth()).toBeNull()
  })
})

describe('getToken refresh', () => {
  function storedAboutToExpire() {
    setStoredAuth({
      idToken: 'old-id-tok',
      accessToken: 'old-access-tok',
      refreshToken: 'refresh-tok',
      expiresAt: Date.now() + 60_000,
    })
  }

  it('refreshes once and shares the in-flight request across concurrent callers', async () => {
    const fetchMock = installFetch(PROD, () =>
      new Response(
        JSON.stringify({ id_token: 'new-id-tok', access_token: 'new-access-tok', expires_in: 3600 }),
        { status: 200 },
      ),
    )
    storedAboutToExpire()

    const [first, second] = await Promise.all([getToken(), getToken()])

    expect(first).toBe('new-id-tok')
    expect(second).toBe('new-id-tok')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/oauth2/token'))).toHaveLength(1)
    // The old refresh token is carried forward: Cognito does not reissue one.
    expect(getStoredAuth()?.refreshToken).toBe('refresh-tok')
  })

  it('logs out and returns null when the refresh fails', async () => {
    installFetch(PROD, () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    storedAboutToExpire()

    expect(await getToken()).toBeNull()
    expect(getStoredAuth()).toBeNull()
  })
})
