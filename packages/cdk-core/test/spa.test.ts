import { createHmac } from 'node:crypto'
import * as nodeCrypto from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { renderSpaSource } from '../src/router/spa.js'

const GATE_PROPS = {
  hostedUiDomain: 'cdk-core.auth.us-east-1.amazoncognito.com',
  clientId: 'browserclient123',
  redirectUri: 'https://cdk-core.ty.ler.dev/auth/callback',
}

/**
 * Executed, not grepped, for the same reason `router.test.ts` executes the
 * router: the bug this rule exists to prevent — rewriting `/auth/callback` to
 * `/auth/callback/index.html`, which 403s against an OAC bucket policy —
 * passed every substring assertion and was only caught against a live
 * distribution. Prod is one release behind the preview on that same rule, so
 * it gets the same kind of test.
 */
function loadSpa(source: string): (event: unknown) => Record<string, unknown> {
  const factory = new Function(`${source}\nreturn handler`) as () => (
    event: unknown,
  ) => Record<string, unknown>
  return factory()
}

function request(
  uri: string,
  opts: {
    headers?: Record<string, { value: string }>
    cookies?: Record<string, { value: string }>
  } = {},
): unknown {
  return {
    request: {
      method: 'GET',
      uri,
      querystring: {},
      headers: opts.headers ?? {},
      cookies: opts.cookies ?? {},
    },
  }
}

/**
 * With a gate, `handler` becomes async and reads `cf.kvs()` and `crypto`, the
 * same shape `router.test.ts` executes. The `cloudfront`/`crypto` imports are
 * stripped and a fake KVS plus Node's real `node:crypto` are injected.
 */
function loadGatedSpa(
  source: string,
  kvsStore: Record<string, string>,
): (event: unknown) => Promise<Record<string, unknown>> {
  const body = source
    .replace(/^import cf from 'cloudfront'\s*$/m, '')
    .replace(/^import crypto from 'crypto'\s*$/m, '')
  const fakeCf = {
    kvs: () => ({
      get: async (key: string) => {
        const value = kvsStore[key]
        if (value === undefined) throw new Error(`KeyNotFound: ${key}`)
        return value
      },
    }),
  }
  const factory = new Function('cf', 'crypto', `${body}\nreturn handler`) as (
    cfArg: unknown,
    cryptoArg: unknown,
  ) => (event: unknown) => Promise<Record<string, unknown>>
  return factory(fakeCf, nodeCrypto)
}

describe('renderSpaSource, executed', () => {
  const handler = loadSpa(renderSpaSource())

  it('serves the shell for the root and for deep client routes', () => {
    for (const uri of ['/', '/auth/callback', '/settings', '/a/b/c']) {
      expect(handler(request(uri)).uri).toBe('/index.html')
    }
  })

  it('leaves a real asset path alone', () => {
    for (const uri of ['/index.html', '/assets/index-2lZu2ZaV.js', '/favicon.ico', '/__config.json']) {
      expect(handler(request(uri)).uri).toBe(uri)
    }
  })

  it('keys on the last segment, not on the whole path', () => {
    // The form both prior-art sites use, `uri.indexOf('.') === -1`, gets this
    // pair backwards in both directions.
    expect(handler(request('/v1.2/settings')).uri).toBe('/index.html')
    expect(handler(request('/v1.2/app.js')).uri).toBe('/v1.2/app.js')
  })

  it('parses as valid JavaScript (esbuild)', async () => {
    const esbuild = await import('esbuild')
    await expect(
      esbuild.transform(renderSpaSource(), { loader: 'js', format: 'esm' }),
    ).resolves.not.toThrow()
  })

  it('is byte-identical to the original no-argument output, with no props and with an empty one', () => {
    // The no-auth, no-backend consumer path must be provably untouched by
    // adding `backends` and `gate`.
    const original = `function handler(event) {
  var request = event.request
  var uri = request.uri
  if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) request.uri = '/index.html'
  return request
}
`
    expect(renderSpaSource()).toBe(original)
    expect(renderSpaSource({})).toBe(original)
  })
})

describe('renderSpaSource, executed, with backends', () => {
  const handler = loadSpa(renderSpaSource({ backends: { api: { pathPattern: '/api/*' } } }))

  it('does not rewrite a backend path to /index.html', () => {
    expect(handler(request('/api/v1/feeds/top')).uri).toBe('/api/v1/feeds/top')
  })

  it('still rewrites everything else to the shell', () => {
    expect(handler(request('/settings')).uri).toBe('/index.html')
    expect(handler(request('/assets/app.js')).uri).toBe('/assets/app.js')
  })
})

describe('renderSpaSource, executed, with a gate', () => {
  const source = renderSpaSource({ gate: GATE_PROPS })
  const SECRET_KEY = '__cdkcore-session-secret'
  const SESSION_COOKIE = '__Host-cdkcore-session'
  const SECRET = 'prod-secret'

  function signSession(expSeconds: number): string {
    const payload = `sub123|${expSeconds}`
    const sig = createHmac('sha256', SECRET).update(payload).digest('hex')
    return `${payload}.${sig}`
  }

  it('never puts await inside a call\'s argument list', () => {
    expect(source).not.toMatch(/\(\s*await\b/)
    expect(source).not.toMatch(/,\s*await\b/)
  })

  it('passes a request with a valid session cookie through to the SPA rewrite', async () => {
    const handler = loadGatedSpa(source, { [SECRET_KEY]: SECRET })
    const cookie = signSession(Math.floor(Date.now() / 1000) + 3600)
    const out = await handler(request('/settings', { cookies: { [SESSION_COOKIE]: { value: cookie } } }))
    expect(out.uri).toBe('/index.html')
  })

  it('redirects a navigation with no cookie to the hosted UI authorize endpoint', async () => {
    const handler = loadGatedSpa(source, { [SECRET_KEY]: SECRET })
    const out = await handler(request('/settings', { headers: { 'sec-fetch-mode': { value: 'navigate' } } }))
    expect(out.statusCode).toBe(302)
    const headers = out.headers as Record<string, { value: string }>
    expect(
      headers.location?.value.startsWith('https://cdk-core.auth.us-east-1.amazoncognito.com/oauth2/authorize'),
    ).toBe(true)
  })

  it('401s a subresource fetch with no cookie', async () => {
    const handler = loadGatedSpa(source, { [SECRET_KEY]: SECRET })
    const out = await handler(request('/settings', { headers: { 'sec-fetch-mode': { value: 'cors' } } }))
    expect(out.statusCode).toBe(401)
  })

  it('503s when the KVS secret is missing', async () => {
    const handler = loadGatedSpa(source, {})
    const out = await handler(request('/settings', { headers: { 'sec-fetch-mode': { value: 'navigate' } } }))
    expect(out.statusCode).toBe(503)
  })

  it('lets /auth/callback through ungated even with no cookie', async () => {
    const handler = loadGatedSpa(source, {})
    const out = await handler(request('/auth/callback'))
    expect(out.uri).toBe('/index.html')
  })

  it('parses as valid JavaScript (esbuild)', async () => {
    const esbuild = await import('esbuild')
    await expect(esbuild.transform(source, { loader: 'js', format: 'esm' })).resolves.not.toThrow()
  })
})
