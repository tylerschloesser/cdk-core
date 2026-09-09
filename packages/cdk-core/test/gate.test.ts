import { createHmac } from 'node:crypto'
import * as nodeCrypto from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { renderGateSource } from '../src/router/gate.js'

/**
 * `renderGateSource` emits a *fragment* — `gate` reads free variables `crypto`
 * and `kvs` that its caller (the router / the SPA function) is responsible
 * for declaring. To execute it standalone here we inject Node's real
 * `node:crypto` and a fake `kvs` as parameters to `new Function`, the same
 * pattern `router.test.ts` uses for `cf`.
 *
 * These tests recompute the HMAC themselves with `node:crypto` rather than
 * importing `src/auth/session.ts` (owned by a concurrent change) — the only
 * contract this file depends on is the wire format documented in
 * `gate.ts`'s module comment: cookie value `<payload>.<hexHmacOfPayload>`,
 * where `payload` ends with `|<expSeconds>`.
 */
function loadGate(
  source: string,
  kvsStore: Record<string, string>,
): (request: Record<string, unknown>, pr: string) => Promise<Record<string, unknown> | null> {
  const fakeKvs = {
    get: async (key: string) => {
      const value = kvsStore[key]
      if (value === undefined) throw new Error(`KeyNotFound: ${key}`)
      return value
    },
  }
  const factory = new Function('crypto', 'kvs', `${source}\nreturn gate`) as (
    cryptoArg: unknown,
    kvsArg: unknown,
  ) => (request: Record<string, unknown>, pr: string) => Promise<Record<string, unknown> | null>
  return factory(nodeCrypto, fakeKvs)
}

const SECRET = 'edge-secret'
const SECRET_KEY = '__cdkcore-session-secret'
const SESSION_COOKIE = '__Host-cdkcore-session'

function signSession(secret: string, expSeconds: number): string {
  const payload = `sub123|${expSeconds}`
  const sig = createHmac('sha256', secret).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function req(
  uri: string,
  opts: {
    headers?: Record<string, { value: string }>
    cookies?: Record<string, { value: string }>
  } = {},
): Record<string, unknown> {
  return {
    uri,
    headers: opts.headers ?? {},
    cookies: opts.cookies ?? {},
  }
}

const GATE_PROPS = {
  hostedUiDomain: 'cdk-core.auth.us-east-1.amazoncognito.com',
  clientId: 'edgeclient123',
  redirectUri: 'https://oauth.preview.cdk-core.ty.ler.dev/',
}

describe('renderGateSource', () => {
  it('builds AUTHORIZE from the hosted UI domain, client id and redirect_uri at synth time', () => {
    const source = renderGateSource(GATE_PROPS)
    expect(source).toContain('cdk-core.auth.us-east-1.amazoncognito.com/oauth2/authorize')
    expect(source).toContain('client_id=edgeclient123')
    expect(source).toContain('identity_provider=Google')
    expect(source).toContain(encodeURIComponent('https://oauth.preview.cdk-core.ty.ler.dev/'))
  })

  it('never puts await inside a call\'s argument list', () => {
    const source = renderGateSource(GATE_PROPS)
    expect(source).not.toMatch(/\(\s*await\b/)
    expect(source).not.toMatch(/,\s*await\b/)
  })

  it('omits the pr branches entirely when preview is not set', () => {
    const source = renderGateSource(GATE_PROPS)
    expect(source).not.toContain('~\' + pr')
    expect(source).not.toContain("if (pr)")
  })

  it('emits the pr branches when preview is set', () => {
    const source = renderGateSource({ ...GATE_PROPS, preview: true })
    expect(source).toContain('if (pr)')
    expect(source).toContain("'~' + pr")
  })
})

describe('gate(request, pr), executed', () => {
  const source = renderGateSource(GATE_PROPS)

  it('lets /auth and /auth/* through ungated, even with no cookie and no KVS secret at all', async () => {
    const gate = loadGate(source, {})
    expect(await gate(req('/auth'), '')).toBeNull()
    expect(await gate(req('/auth/callback'), '')).toBeNull()
    expect(await gate(req('/auth/'), '')).toBeNull()
  })

  it('passes through a request with a valid, unexpired session cookie', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const cookie = signSession(SECRET, Math.floor(Date.now() / 1000) + 3600)
    const out = await gate(req('/', { cookies: { [SESSION_COOKIE]: { value: cookie } } }), '')
    expect(out).toBeNull()
  })

  it('redirects a top-level navigation with no cookie to the hosted UI authorize endpoint', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const out = await gate(req('/', { headers: { 'sec-fetch-mode': { value: 'navigate' } } }), '')
    expect(out?.statusCode).toBe(302)
    const headers = out!.headers as Record<string, { value: string }>
    expect(headers.location?.value.startsWith('https://cdk-core.auth.us-east-1.amazoncognito.com/oauth2/authorize')).toBe(
      true,
    )
    expect((headers['cache-control'] as { value: string }).value).toBe('no-store')
  })

  it('redirects when sec-fetch-mode is absent (curl) too', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const out = await gate(req('/'), '')
    expect(out?.statusCode).toBe(302)
  })

  it('401s a subresource fetch (sec-fetch-mode: cors) with no cookie', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const out = await gate(req('/', { headers: { 'sec-fetch-mode': { value: 'cors' } } }), '')
    expect(out?.statusCode).toBe(401)
    expect(out?.body).toBe('sign in required')
  })

  it('redirects rather than passing through on a tampered cookie signature', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const cookie = signSession(SECRET, Math.floor(Date.now() / 1000) + 3600)
    const tampered = cookie.slice(0, -1) + (cookie.at(-1) === '0' ? '1' : '0')
    const out = await gate(
      req('/', {
        headers: { 'sec-fetch-mode': { value: 'navigate' } },
        cookies: { [SESSION_COOKIE]: { value: tampered } },
      }),
      '',
    )
    expect(out?.statusCode).toBe(302)
  })

  it('redirects rather than passing through on an expired session', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const cookie = signSession(SECRET, Math.floor(Date.now() / 1000) - 10)
    const out = await gate(
      req('/', {
        headers: { 'sec-fetch-mode': { value: 'navigate' } },
        cookies: { [SESSION_COOKIE]: { value: cookie } },
      }),
      '',
    )
    expect(out?.statusCode).toBe(302)
  })

  it('503s when the KVS secret is missing', async () => {
    const gate = loadGate(source, {})
    const out = await gate(req('/', { headers: { 'sec-fetch-mode': { value: 'navigate' } } }), '')
    expect(out?.statusCode).toBe(503)
    expect(out?.body).toBe('auth unavailable')
    expect((out!.headers as Record<string, { value: string }>)['cache-control'].value).toBe('no-store')
  })

  it('sets the return cookie to the path only, not the query string', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const out = await gate(req('/some/deep/path'), '')
    const cookies = out!.cookies as Record<string, { value: string; attributes: string }>
    expect(cookies['__Host-cdkcore-return']?.value).toBe('/some/deep/path')
    expect(cookies['__Host-cdkcore-return']?.attributes).toContain('HttpOnly')
  })
})

describe('gate(request, pr), executed, with preview: true', () => {
  const source = renderGateSource({ ...GATE_PROPS, preview: true })

  it('appends ~<pr> to the emitted state, trailing the signature, when pr is truthy', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const out = await gate(req('/'), '15')
    expect(out?.statusCode).toBe(302)
    const location = (out!.headers as Record<string, { value: string }>).location.value
    const state = new URL(location).searchParams.get('state')
    expect(state).toMatch(/^[0-9]+\.[0-9a-f]{64}~15$/)
  })

  it('omits the ~<pr> suffix when pr is falsy', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const out = await gate(req('/'), '')
    const location = (out!.headers as Record<string, { value: string }>).location.value
    const state = new URL(location).searchParams.get('state')
    expect(state).toMatch(/^[0-9]+\.[0-9a-f]{64}$/)
  })
})

/**
 * PKCE: the gate derives `code_verifier` from the KVS session secret rather
 * than needing a CSPRNG at the edge, so the app client can stay public (the
 * existing `browser` client) instead of a new confidential one. This
 * assertion recomputes both the verifier and the challenge independently
 * with `node:crypto` -- not by importing `src/auth/session.ts` -- because
 * the point is to pin the value the callback Lambda must independently
 * re-derive, so the test must not share an implementation with either side.
 */
function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('gate(request, pr), executed: PKCE on the 302', () => {
  it('carries code_challenge_method=S256 and a well-formed code_challenge', async () => {
    const source = renderGateSource(GATE_PROPS)
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const out = await gate(req('/'), '')
    expect(out?.statusCode).toBe(302)
    const location = (out!.headers as Record<string, { value: string }>).location.value
    const url = new URL(location)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    const challenge = url.searchParams.get('code_challenge')
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('emits a code_challenge equal to base64url(sha256(hmac-sha256(secret, "pkce|" + body))), non-preview', async () => {
    const source = renderGateSource(GATE_PROPS)
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const out = await gate(req('/'), '')
    const location = (out!.headers as Record<string, { value: string }>).location.value
    const url = new URL(location)
    const state = url.searchParams.get('state')!
    const iat = state.split('.')[0]!
    const body = '' + iat
    const verifier = createHmac('sha256', SECRET).update('pkce|' + body).digest('hex')
    const expected = base64url(nodeCrypto.createHash('sha256').update(verifier).digest())
    expect(url.searchParams.get('code_challenge')).toBe(expected)
  })

  it('emits a code_challenge derived from the pr-suffixed body on a preview state', async () => {
    const source = renderGateSource({ ...GATE_PROPS, preview: true })
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    const out = await gate(req('/'), '15')
    const location = (out!.headers as Record<string, { value: string }>).location.value
    const url = new URL(location)
    const state = url.searchParams.get('state')!
    const iat = state.split('.')[0]!
    const body = `${iat}~15`
    const verifier = createHmac('sha256', SECRET).update('pkce|' + body).digest('hex')
    const expected = base64url(nodeCrypto.createHash('sha256').update(verifier).digest())
    expect(url.searchParams.get('code_challenge')).toBe(expected)
  })
})

/**
 * `ungatedPaths` folds into the same list `/auth` is in, so these cases are
 * as much about `/auth` still behaving as they are about the new entries.
 * The emitted check has exact-match-or-`<path>/` semantics and nothing else:
 * it is not a CloudFront path pattern, and `renderGateSource` throws at synth
 * rather than emit one that would read like one.
 */
describe('renderGateSource with ungatedPaths', () => {
  // The one line the whole feature turns on. Written out in full so a change
  // to how it is built shows up here as a diff, not as a byte count.
  const DEFAULT_CHECK = "  if (uri === '/auth' || uri.indexOf('/auth/') === 0) return null"

  it('emits exactly the pre-ungatedPaths check when none are given', () => {
    expect(renderGateSource(GATE_PROPS)).toContain(`${DEFAULT_CHECK}\n`)
  })

  it('emits byte-identical source for an absent and an empty ungatedPaths', () => {
    expect(renderGateSource({ ...GATE_PROPS, ungatedPaths: [] })).toBe(renderGateSource(GATE_PROPS))
  })

  it('appends one clause pair per path, after the /auth pair', () => {
    const source = renderGateSource({ ...GATE_PROPS, ungatedPaths: ['/api/health'] })
    expect(source).toContain(
      "  if (uri === '/auth' || uri.indexOf('/auth/') === 0 || uri === '/api/health' || uri.indexOf('/api/health/') === 0) return null",
    )
  })

  it('rejects a path that does not start with a slash', () => {
    expect(() => renderGateSource({ ...GATE_PROPS, ungatedPaths: ['api/health'] })).toThrow(/must start with/)
  })

  it('rejects "/" outright — it would ungate the whole site', () => {
    expect(() => renderGateSource({ ...GATE_PROPS, ungatedPaths: ['/'] })).toThrow(/whole site/)
  })

  it('rejects a trailing slash, which would emit a double slash in the prefix check', () => {
    expect(() => renderGateSource({ ...GATE_PROPS, ungatedPaths: ['/api/health/'] })).toThrow(/must not end with/)
  })

  it('rejects the CloudFront path-pattern characters it does not implement', () => {
    for (const path of ['/api/*', '/api/health?x', '/api/health#f', '/api/health check']) {
      expect(() => renderGateSource({ ...GATE_PROPS, ungatedPaths: [path] })).toThrow(/path pattern/)
    }
  })

  it('rejects a quote, which would break the single-quoted literal it is emitted into', () => {
    expect(() => renderGateSource({ ...GATE_PROPS, ungatedPaths: ["/api/'"] })).toThrow(/path pattern/)
  })

  it('rejects /auth and anything under it — already exempt, so listing it signals confusion', () => {
    expect(() => renderGateSource({ ...GATE_PROPS, ungatedPaths: ['/auth'] })).toThrow(/already ungated/)
    expect(() => renderGateSource({ ...GATE_PROPS, ungatedPaths: ['/auth/callback'] })).toThrow(/already ungated/)
  })

  it('rejects a duplicate', () => {
    expect(() => renderGateSource({ ...GATE_PROPS, ungatedPaths: ['/api/health', '/api/health'] })).toThrow(
      /listed twice/,
    )
  })
})

describe('gate(request, pr), executed, with ungatedPaths', () => {
  const source = renderGateSource({ ...GATE_PROPS, ungatedPaths: ['/api/health'] })

  it('lets an ungated path through with no cookie and an empty KVS', async () => {
    // The empty KVS is the assertion: it proves the check short-circuits
    // before the secret read, so an ungated path costs one fewer KVS read
    // than a gated one and cannot 503 during secret propagation.
    const gate = loadGate(source, {})
    expect(await gate(req('/api/health'), '')).toBeNull()
  })

  it('lets a path under an ungated path through', async () => {
    const gate = loadGate(source, {})
    expect(await gate(req('/api/health/deep'), '')).toBeNull()
  })

  it('does not let a sibling that merely shares the prefix through', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    expect((await gate(req('/api/healthz'), ''))?.statusCode).toBe(302)
    expect((await gate(req('/api/health-check'), ''))?.statusCode).toBe(302)
  })

  it('still gates everything else', async () => {
    const gate = loadGate(source, { [SECRET_KEY]: SECRET })
    expect((await gate(req('/'), ''))?.statusCode).toBe(302)
    expect((await gate(req('/api/v1/x'), ''))?.statusCode).toBe(302)
  })

  it('still lets /auth through once /auth is one entry in a longer list', async () => {
    const gate = loadGate(source, {})
    expect(await gate(req('/auth'), '')).toBeNull()
    expect(await gate(req('/auth/callback'), '')).toBeNull()
  })
})
