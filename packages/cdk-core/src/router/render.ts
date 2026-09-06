/**
 * Generates the source of the CloudFront Function (`cloudfront-js-2.0`) that
 * routes every request through the shared preview distribution: unknown-host
 * 404, the D5 auth bounce, backend origin override, and the assets SPA
 * rewrite. See `docs/spikes/2026-09-06-oac-routing-spike.md` for the proven
 * dialect this must stick to (no `await` inside a call's argument list, no
 * optional chaining / `??`, sequential `await`s only, one `kvs.get` per
 * request) and `plan.md` D5/D10 for why the logic is shaped this way.
 *
 * This module must stay free of any runtime dependency on `aws-cdk-lib`: its
 * output is a plain string, generated once at synth time and handed to the
 * `cloudfront.Function` construct, not a construct itself.
 */

import type { BackendProps } from '../types.js'

export interface RouterSourceProps {
  /** e.g. 'cdk-core.ty.ler.dev'. Previews live at `pr-<n>.preview.<domain>`. */
  readonly domain: string
  /** Same keys and shape as PreviewSite's `backends`. */
  readonly backends: Record<string, BackendProps>
}

interface BackendRoute {
  readonly key: string
  readonly prefix: string
  /** true when the pathPattern had no '*' and must match the full uri exactly. */
  readonly matchExact: boolean
  readonly readTimeoutSeconds: number
}

const QUERY_ALLOWLIST = '^[A-Za-z0-9._~-]+$'

function derivePrefix(key: string, pathPattern: string): { prefix: string; matchExact: boolean } {
  if (pathPattern === '/*' || pathPattern === '*') {
    throw new Error(
      `backend '${key}': pathPattern must not be '${pathPattern}' — that would swallow the assets behavior`,
    )
  }
  if (!pathPattern.startsWith('/')) {
    throw new Error(`backend '${key}': pathPattern must start with '/', got ${JSON.stringify(pathPattern)}`)
  }
  if (pathPattern === '/__config.json') {
    throw new Error(`backend '${key}': pathPattern must not be '/__config.json'`)
  }
  const starIndex = pathPattern.indexOf('*')
  if (starIndex === -1) {
    return { prefix: pathPattern, matchExact: true }
  }
  if (starIndex !== pathPattern.length - 1) {
    throw new Error(
      `backend '${key}': pathPattern ${JSON.stringify(pathPattern)} has '*' somewhere other than the ` +
        `last character — CloudFront allows that, but the generated matcher here only supports a ` +
        `trailing wildcard and would not faithfully implement it`,
    )
  }
  return { prefix: pathPattern.slice(0, -1), matchExact: false }
}

function deriveReadTimeoutSeconds(key: string, backend: BackendProps): number {
  const seconds = backend.readTimeout ? backend.readTimeout.toSeconds() : backend.streaming ? 60 : 30
  if (seconds < 1 || seconds > 120) {
    throw new Error(
      `backend '${key}': readTimeout must be between 1 and 120 seconds (CloudFront's documented ` +
        `limit), got ${seconds}`,
    )
  }
  return seconds
}

function renderBackendBlock(route: BackendRoute, index: number): string {
  const cond = route.matchExact
    ? `uri === ${JSON.stringify(route.prefix)}`
    : `uri.indexOf(${JSON.stringify(route.prefix)}) === 0`
  const originVar = `origin_${index}`
  return `  if (${cond}) {
    var ${originVar} = route.backends && route.backends[${JSON.stringify(route.key)}]
    if (!${originVar}) return NOT_FOUND
    cf.updateRequestOrigin({
      domainName: ${originVar},
      originAccessControlConfig: {
        enabled: true,
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
        originType: 'lambda',
      },
      customOriginConfig: { port: 443, protocol: 'https', sslProtocols: ['TLSv1.2'] },
      timeouts: { readTimeout: ${route.readTimeoutSeconds} },
      customHeaders: {},
    })
    return request
  }`
}

/**
 * Renders the router's CloudFront Function source from a site domain and its
 * backends. Throws (with the offending value in the message) if a backend's
 * `pathPattern` or `readTimeout` is unusable, or if two backends' derived
 * prefixes overlap.
 */
export function renderRouterSource(props: RouterSourceProps): string {
  if (!props.domain || props.domain.includes('/')) {
    throw new Error(`domain must be non-empty and contain no '/', got ${JSON.stringify(props.domain)}`)
  }

  const entries = Object.entries(props.backends)
  if (entries.length === 0) {
    throw new Error('renderRouterSource requires at least one backend')
  }

  const routes: BackendRoute[] = entries.map(([key, backend]) => {
    const { prefix, matchExact } = derivePrefix(key, backend.pathPattern)
    const readTimeoutSeconds = deriveReadTimeoutSeconds(key, backend)
    return { key, prefix, matchExact, readTimeoutSeconds }
  })

  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i]!
      const b = routes[j]!
      if (a.prefix.indexOf(b.prefix) === 0 || b.prefix.indexOf(a.prefix) === 0) {
        throw new Error(
          `backends '${a.key}' and '${b.key}' have overlapping path prefixes: ` +
            `${JSON.stringify(a.prefix)} vs ${JSON.stringify(b.prefix)}`,
        )
      }
    }
  }

  const bounceHost = `oauth.preview.${props.domain}`
  const previewSuffix = `.preview.${props.domain}`
  const backendBlocks = routes.map((route, index) => renderBackendBlock(route, index)).join('\n')

  return `import cf from 'cloudfront'

var kvs = cf.kvs()

var BOUNCE_HOST = ${JSON.stringify(bounceHost)}
var PREVIEW_SUFFIX = ${JSON.stringify(previewSuffix)}
var QUERY_ALLOWLIST = new RegExp(${JSON.stringify(QUERY_ALLOWLIST)})
var STATE_PATTERN = /^[A-Za-z0-9_-]+\\.([0-9]+)$/

var NOT_FOUND = {
  statusCode: 404,
  statusDescription: 'Not Found',
  headers: {
    'content-type': { value: 'text/plain' },
    'cache-control': { value: 'no-store' },
  },
  body: 'no such preview',
}

async function handler(event) {
  var request = event.request
  var headers = request.headers
  var host = headers.host && headers.host.value ? headers.host.value.toLowerCase() : ''
  var qs = request.querystring

  if (host === BOUNCE_HOST) {
    var stateParam = qs.state && qs.state.value
    var stateMatch = stateParam ? STATE_PATTERN.exec(stateParam) : null
    if (!stateMatch) return NOT_FOUND
    var prNumber = stateMatch[1]
    var previewHost = 'pr-' + prNumber + PREVIEW_SUFFIX

    // \`kvs.get\` must not be called with \`await\` inside its own argument list
    // (a syntax error in cloudfront-js-2.0 — see the spike's Finding 1), so the
    // awaited value is bound to a variable first.
    var bounceRaw
    try {
      bounceRaw = await kvs.get(previewHost)
    } catch (e) {
      return NOT_FOUND
    }
    if (!bounceRaw) return NOT_FOUND

    // The redirect target is built entirely from a fixed template
    // ('https://' + previewHost + '/auth/callback?') plus query parameters
    // that are each re-forwarded only if they match a conservative allowlist.
    // No part of the incoming URL or query string is ever placed into the
    // target verbatim, so this redirect is allowlisted by construction and
    // cannot be turned into an open redirector (RFC 9700 section 4.11.1:
    // "clients MUST NOT expose open redirectors").
    var params = []
    var code = qs.code && qs.code.value
    if (code && QUERY_ALLOWLIST.test(code)) params.push('code=' + code)
    var stateOut = qs.state && qs.state.value
    if (stateOut && QUERY_ALLOWLIST.test(stateOut)) params.push('state=' + stateOut)
    var error = qs.error && qs.error.value
    if (error && QUERY_ALLOWLIST.test(error)) params.push('error=' + error)

    return {
      statusCode: 302,
      statusDescription: 'Found',
      headers: {
        location: { value: 'https://' + previewHost + '/auth/callback?' + params.join('&') },
        'cache-control': { value: 'no-store' },
      },
    }
  }

  var raw
  try {
    raw = await kvs.get(host)
  } catch (e) {
    return NOT_FOUND
  }
  var route
  try {
    route = JSON.parse(raw)
  } catch (e) {
    return NOT_FOUND
  }
  if (!route || typeof route !== 'object') return NOT_FOUND

  var uri = request.uri

${backendBlocks}

  if (uri.slice(-1) === '/') uri = uri + 'index.html'
  else if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) uri = uri + '/index.html'
  request.uri = route.assets + uri
  return request
}
`
}
