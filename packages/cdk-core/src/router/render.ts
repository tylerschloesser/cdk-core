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

import { backendReadTimeoutSeconds } from '../backend.js'
import type { BackendProps } from '../types.js'
import { renderGateSource } from './gate.js'
import type { GateSourceProps } from './gate.js'

export interface RouterSourceProps {
  /** e.g. 'cdk-core.ty.ler.dev'. Previews live at `pr-<n>.preview.<domain>`. */
  readonly domain: string
  /** Same keys and shape as PreviewSite's `backends`. */
  readonly backends: Record<string, BackendProps>
  /** When set, splices the Google sign-in gate in front of every route. */
  readonly gate?: GateSourceProps
}

export interface BackendRoute {
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

/**
 * Derives each backend's route (prefix, exact-match flag, read timeout) from
 * its `pathPattern`, validating and checking for overlap along the way.
 * Shared by `renderRouterSource` and `renderSpaSource` so the two never
 * disagree on what a backend's prefix is — `derivePrefix` is not duplicated.
 */
export function deriveBackendRoutes(backends: Record<string, BackendProps>): BackendRoute[] {
  const routes: BackendRoute[] = Object.entries(backends).map(([key, backend]) => {
    const { prefix, matchExact } = derivePrefix(key, backend.pathPattern)
    const readTimeoutSeconds = backendReadTimeoutSeconds(key, backend)
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
  return routes
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

  if (Object.keys(props.backends).length === 0) {
    throw new Error('renderRouterSource requires at least one backend')
  }

  const routes = deriveBackendRoutes(props.backends)

  const bounceHost = `oauth.preview.${props.domain}`
  const previewSuffix = `.preview.${props.domain}`
  const backendBlocks = routes.map((route, index) => renderBackendBlock(route, index)).join('\n')

  const cryptoImport = props.gate ? `\nimport crypto from 'crypto'` : ''
  const gateFragment = props.gate ? `\n${renderGateSource(props.gate)}` : ''
  // Gating runs after the route lookup (below) so an unknown preview host
  // still 404s rather than sending a stranger to Google. That means a
  // gated preview does a second kvs.get on the main path -- a documented
  // deviation from .claude/rules/cdk.md rule 4 ("one kvs.get per request"),
  // because the gate needs the PR number to sign it into `state`, and the
  // PR number is only known once the route lookup above has resolved `host`.
  const gateCall = props.gate
    ? `
  // Deliberate second kvs.get on this path -- see the comment on \`gate\`
  // above and .claude/rules/cdk.md rule 4.
  var prMatch = /^pr-([0-9]+)\\./.exec(host)
  var gated = await gate(request, prMatch ? prMatch[1] : '')
  if (gated) return gated
`
    : ''

  return stripSourceComments(`import cf from 'cloudfront'${cryptoImport}

var kvs = cf.kvs()
${gateFragment}
var BOUNCE_HOST = ${JSON.stringify(bounceHost)}
var PREVIEW_SUFFIX = ${JSON.stringify(previewSuffix)}
var QUERY_ALLOWLIST = new RegExp(${JSON.stringify(QUERY_ALLOWLIST)})
// Two forms, tried in order. The gate's signed state is
// '<iat>.<hexsig>~<pr>' -- '~' is in QUERY_ALLOWLIST but is not a hex or
// base64url character, so the split is unambiguous. The legacy SPA state
// (auth/browser.ts) is '<nonce>.<pr>', digits only after the dot. The
// second pattern is deliberately not widened to allow '.' in its first
// group: a hex signature can end in a run of digits, and greedy
// backtracking would silently extract the wrong PR number.
var STATE_PATTERN_SIGNED = /^[A-Za-z0-9_.-]+~([0-9]+)$/
var STATE_PATTERN_LEGACY = /^[A-Za-z0-9_-]+\\.([0-9]+)$/

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
    var stateMatch = null
    if (stateParam) {
      stateMatch = STATE_PATTERN_SIGNED.exec(stateParam)
      if (!stateMatch) stateMatch = STATE_PATTERN_LEGACY.exec(stateParam)
    }
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
${gateCall}
  var uri = request.uri

${backendBlocks}

  // SPA fallback. A path whose last segment carries no extension is a client
  // route, not a file: it must serve the app shell, not <path>/index.html.
  // Appending was the first version of this, and every deep route 403d --
  // S3 answers a missing key AccessDenied rather than 404, because an OAC
  // bucket policy grants s3:GetObject and not s3:ListBucket. A request for a
  // genuinely missing *asset* still fails, which is what we want.
  if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) request.uri = route.assets + '/index.html'
  else request.uri = route.assets + uri
  return request
}
`)
}

/**
 * Drops comment-only lines from a generated function source.
 *
 * **This exists because of a hard quota, not for tidiness.** A CloudFront
 * Function's maximum size is 10,240 bytes and AWS states it is not
 * adjustable. Measured on the reference two-backend config, the gated preview
 * router came to 9,767 bytes, of which **3,388 were comments** — a third of
 * the artifact, and 473 bytes from a wall that a third backend (539 bytes)
 * would have gone straight through.
 *
 * Those comments are not lost: they live in the generators that emit them,
 * which is where someone changing this behaviour actually reads them.
 * `.claude/rules/cdk.md` already says the router is generated and never
 * edited as a deployed artifact, so the deployed copy is the one place the
 * explanations were doing no work.
 *
 * Line-based on purpose: it removes a line only when its first non-whitespace
 * characters are `//`. The emitted source contains `'https://'` inside string
 * literals, and a naive `//`-anywhere strip would corrupt them — but a string
 * literal never *starts* a line here. Blank lines are kept; 25 of them cost
 * 25 bytes and are what makes the remaining source readable in the console.
 */
export function stripSourceComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}
