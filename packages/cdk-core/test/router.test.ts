import { Duration } from 'aws-cdk-lib'
import { describe, expect, it } from 'vitest'
import { renderRouterSource } from '../src/router/render.js'

const REFERENCE_BACKENDS = {
  api: { pathPattern: '/api/*' },
  events: { pathPattern: '/events/*', streaming: true },
}

describe('renderRouterSource', () => {
  it('renders under 10 KB for the reference config', () => {
    const source = renderRouterSource({ domain: 'cdk-core.ty.ler.dev', backends: REFERENCE_BACKENDS })
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(10 * 1024)
  })

  it('contains each backend key and its derived prefix', () => {
    const source = renderRouterSource({ domain: 'cdk-core.ty.ler.dev', backends: REFERENCE_BACKENDS })
    expect(source).toContain('/api/')
    expect(source).toContain('/events/')
    expect(source).toContain(JSON.stringify('api'))
    expect(source).toContain(JSON.stringify('events'))
  })

  it('defaults readTimeout to 30s for a plain backend and 60s for streaming', () => {
    const source = renderRouterSource({ domain: 'example.com', backends: REFERENCE_BACKENDS })
    expect(source).toContain('readTimeout: 30')
    expect(source).toContain('readTimeout: 60')
  })

  it('lets an explicit readTimeout override both defaults', () => {
    const source = renderRouterSource({
      domain: 'example.com',
      backends: {
        api: { pathPattern: '/api/*', readTimeout: Duration.seconds(45) },
        events: { pathPattern: '/events/*', streaming: true, readTimeout: Duration.seconds(90) },
      },
    })
    expect(source).toContain('readTimeout: 45')
    expect(source).toContain('readTimeout: 90')
    expect(source).not.toContain('readTimeout: 30')
    expect(source).not.toContain('readTimeout: 60')
  })

  it('derives the bounce host and the preview suffix from domain', () => {
    const source = renderRouterSource({ domain: 'cdk-core.ty.ler.dev', backends: REFERENCE_BACKENDS })
    expect(source).toContain('oauth.preview.cdk-core.ty.ler.dev')
    expect(source).toContain('.preview.cdk-core.ty.ler.dev')
  })

  it('never puts await inside a call\'s argument list (spike Finding 1: a syntax error at the edge)', () => {
    // `JSON.parse(await kvs.get(k))` and similar are rejected by cloudfront-js-2.0
    // with "SyntaxError: await in arguments not supported" — see
    // docs/spikes/2026-09-06-oac-routing-spike.md Finding 1. This is a simple,
    // honest approximation: no '(' or ',' immediately precedes 'await'.
    const source = renderRouterSource({ domain: 'cdk-core.ty.ler.dev', backends: REFERENCE_BACKENDS })
    expect(source).not.toMatch(/\(\s*await\b/)
    expect(source).not.toMatch(/,\s*await\b/)
  })

  it('calls kvs.get at most twice — once on the bounce path, once on the main path, only one executes per request', () => {
    const source = renderRouterSource({ domain: 'cdk-core.ty.ler.dev', backends: REFERENCE_BACKENDS })
    const matches = source.match(/kvs\.get\(/g) ?? []
    expect(matches.length).toBeLessThanOrEqual(2)
  })

  it('rejects a pathPattern of "/*"', () => {
    expect(() => renderRouterSource({ domain: 'example.com', backends: { api: { pathPattern: '/*' } } })).toThrow(
      /assets behavior/,
    )
  })

  it('rejects a pathPattern of "*"', () => {
    expect(() => renderRouterSource({ domain: 'example.com', backends: { api: { pathPattern: '*' } } })).toThrow()
  })

  it('rejects a "*" anywhere other than the last character', () => {
    expect(() =>
      renderRouterSource({ domain: 'example.com', backends: { api: { pathPattern: '/api/*/sub' } } }),
    ).toThrow(/trailing wildcard/)
  })

  it('rejects overlapping / duplicate derived prefixes', () => {
    expect(() =>
      renderRouterSource({
        domain: 'example.com',
        backends: {
          api: { pathPattern: '/api/*' },
          apiV2: { pathPattern: '/api/v2/*' },
        },
      }),
    ).toThrow(/overlapping/)
  })

  it('rejects a pathPattern of "/__config.json"', () => {
    expect(() =>
      renderRouterSource({ domain: 'example.com', backends: { api: { pathPattern: '/__config.json' } } }),
    ).toThrow(/__config\.json/)
  })

  it('rejects an empty backends record', () => {
    expect(() => renderRouterSource({ domain: 'example.com', backends: {} })).toThrow(/at least one backend/)
  })

  it('rejects an out-of-range readTimeout', () => {
    expect(() =>
      renderRouterSource({
        domain: 'example.com',
        backends: { api: { pathPattern: '/api/*', readTimeout: Duration.seconds(121) } },
      }),
    ).toThrow(/1 and 120/)
    expect(() =>
      renderRouterSource({
        domain: 'example.com',
        backends: { api: { pathPattern: '/api/*', readTimeout: Duration.seconds(0) } },
      }),
    ).toThrow(/1 and 120/)
  })

  it('rejects an invalid domain', () => {
    expect(() => renderRouterSource({ domain: '', backends: REFERENCE_BACKENDS })).toThrow()
    expect(() => renderRouterSource({ domain: 'has/slash.com', backends: REFERENCE_BACKENDS })).toThrow()
  })

  it('JSON-escapes a domain containing a quote character without unbalancing the string literal', () => {
    const source = renderRouterSource({
      domain: 'evil".com',
      backends: { api: { pathPattern: '/api/*' } },
    })
    expect(source).toContain(JSON.stringify('oauth.preview.evil".com'))
  })

  it('parses as valid JavaScript (esbuild)', async () => {
    const source = renderRouterSource({ domain: 'cdk-core.ty.ler.dev', backends: REFERENCE_BACKENDS })
    const esbuild = await import('esbuild')
    await expect(esbuild.transform(source, { loader: 'js', format: 'esm' })).resolves.not.toThrow()
  })
})

/**
 * The tests above assert things *about* the generated text. These run it.
 *
 * They exist because a substring assertion cannot tell a correct SPA fallback
 * from a broken one: the first version of the renderer appended
 * `/index.html` to an extensionless path, so `/auth/callback` asked S3 for
 * `pr-1/auth/callback/index.html` and every deep route came back 403. It
 * passed every text assertion and was only caught against a live
 * distribution. Executing the handler closes that gap.
 *
 * `import cf from 'cloudfront'` is a module the edge runtime provides and Node
 * does not, so the import line is stripped and `cf` is injected as a parameter.
 */
function loadRouter(
  source: string,
  cf: unknown,
): (event: unknown) => Promise<Record<string, unknown>> {
  const body = source.replace(/^import cf from 'cloudfront'\s*$/m, '')
  const factory = new Function('cf', `${body}\nreturn handler`) as (
    cfArg: unknown,
  ) => (event: unknown) => Promise<Record<string, unknown>>
  return factory(cf)
}

interface FakeCf {
  kvs(): { get(key: string): Promise<string> }
  updateRequestOrigin(config: Record<string, unknown>): void
}

function fakeCf(store: Record<string, string>): {
  cf: FakeCf
  origins: Record<string, unknown>[]
} {
  const origins: Record<string, unknown>[] = []
  const cf: FakeCf = {
    kvs: () => ({
      get: async (key: string) => {
        const value = store[key]
        if (value === undefined) throw new Error(`KeyNotFound: ${key}`)
        return value
      },
    }),
    updateRequestOrigin: (config) => {
      origins.push(config)
    },
  }
  return { cf, origins }
}

const ROUTE = JSON.stringify({
  v: 1,
  pr: 1,
  assets: '/pr-1',
  backends: {
    api: 'api123.lambda-url.us-east-1.on.aws',
    events: 'events456.lambda-url.us-east-1.on.aws',
  },
})

const STORE = { 'pr-1.preview.cdk-core.ty.ler.dev': ROUTE }

function request(
  host: string,
  uri: string,
  querystring: Record<string, { value: string }> = {},
): unknown {
  return {
    version: '1.0',
    context: { eventType: 'viewer-request' },
    request: {
      method: 'GET',
      uri,
      querystring,
      headers: { host: { value: host } },
      cookies: {},
    },
  }
}

describe('the generated router, executed', () => {
  const source = renderRouterSource({
    domain: 'cdk-core.ty.ler.dev',
    backends: REFERENCE_BACKENDS,
  })
  const PREVIEW = 'pr-1.preview.cdk-core.ty.ler.dev'

  it('rewrites the root to the PR prefix shell', async () => {
    const { cf } = fakeCf(STORE)
    const out = await loadRouter(source, cf)(request(PREVIEW, '/'))
    expect(out.uri).toBe('/pr-1/index.html')
  })

  it('serves the shell for a deep client route, not <path>/index.html', async () => {
    const { cf } = fakeCf(STORE)
    const handler = loadRouter(source, cf)
    for (const uri of ['/auth/callback', '/some/deep/path', '/settings']) {
      const out = await handler(request(PREVIEW, uri))
      expect(out.uri).toBe('/pr-1/index.html')
    }
  })

  it('leaves a real asset path alone apart from the prefix', async () => {
    const { cf } = fakeCf(STORE)
    const out = await loadRouter(source, cf)(
      request(PREVIEW, '/assets/index-2lZu2ZaV.js'),
    )
    expect(out.uri).toBe('/pr-1/assets/index-2lZu2ZaV.js')
  })

  it('overrides the origin for a backend path and leaves the URI untouched', async () => {
    const { cf, origins } = fakeCf(STORE)
    const out = await loadRouter(source, cf)(request(PREVIEW, '/events/tick'))
    expect(out.uri).toBe('/events/tick')
    expect(origins).toHaveLength(1)
    expect(origins[0]?.domainName).toBe('events456.lambda-url.us-east-1.on.aws')
    expect(origins[0]?.timeouts).toEqual({ readTimeout: 60 })
    expect(origins[0]?.originAccessControlConfig).toMatchObject({
      enabled: true,
      originType: 'lambda',
      signingBehavior: 'always',
      signingProtocol: 'sigv4',
    })
  })

  it('404s an unknown preview host without touching the origin', async () => {
    const { cf, origins } = fakeCf(STORE)
    const out = await loadRouter(source, cf)(
      request('pr-999.preview.cdk-core.ty.ler.dev', '/'),
    )
    expect(out.statusCode).toBe(404)
    expect(origins).toHaveLength(0)
  })

  it('bounces a valid state to the PR that owns it', async () => {
    const { cf } = fakeCf(STORE)
    const out = await loadRouter(source, cf)(
      request('oauth.preview.cdk-core.ty.ler.dev', '/', {
        code: { value: 'authcode123' },
        state: { value: 'noncevalue.1' },
      }),
    )
    expect(out.statusCode).toBe(302)
    const headers = out.headers as Record<string, { value: string }>
    expect(headers.location?.value).toBe(
      `https://${PREVIEW}/auth/callback?code=authcode123&state=noncevalue.1`,
    )
  })

  it('refuses to bounce to a PR with no KVS entry, and refuses a malformed state', async () => {
    const { cf } = fakeCf(STORE)
    const handler = loadRouter(source, cf)
    const bounceHost = 'oauth.preview.cdk-core.ty.ler.dev'
    for (const state of ['noncevalue.999', 'https://evil.example', 'nonce.1.2', '']) {
      const out = await handler(
        request(bounceHost, '/', { state: { value: state } }),
      )
      expect(out.statusCode).toBe(404)
    }
  })
})
