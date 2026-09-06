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
