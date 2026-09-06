import { describe, expect, it } from 'vitest'

import { renderSpaSource } from '../src/router/spa.js'

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

function request(uri: string): unknown {
  return { request: { method: 'GET', uri, querystring: {}, headers: {}, cookies: {} } }
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
})
