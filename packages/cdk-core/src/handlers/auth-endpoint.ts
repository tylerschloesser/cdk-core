/**
 * The Lambda behind the `/auth/*` behavior: the code<->token exchange the
 * CloudFront Function gate (`../router/gate.ts`) cannot do itself, because a
 * CloudFront Function has no network access.
 *
 * Split the way `preview-resources.ts` is: a **pure** `handleAuthRequest`
 * exported for the unit tests, driven through injected ports
 * (`AuthEndpointPorts`) so a vitest run never touches the network, plus a
 * thin `handler` that reads `process.env` and builds the real ports.
 *
 * **Host-blind, on purpose.** The behavior sits behind
 * `ALL_VIEWER_EXCEPT_HOST_HEADER`, which strips `Host`, and on preview one
 * shared Lambda serves every `pr-N.preview.<domain>`. So this file must never
 * build an absolute URL back to the site: every redirect is a relative path,
 * and every cookie is host-only (`sessionCookieAttributes` sets no `Domain`,
 * which the `__Host-` prefix forbids anyway). Getting this wrong sends a
 * PR-7 user to PR-3.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'

import { ID_TOKEN_HEADER } from '../config.js'
import type { SiteAuthConfig } from '../config.js'
import { exchangeCode } from '../auth/oidc.js'
import type { TokenSet } from '../auth/oidc.js'
import { createVerifier } from '../auth/server.js'
import type { AuthUser, Verifier, VerifierConfig } from '../auth/server.js'
import {
  parseCookieHeader,
  pkceVerifier,
  RETURN_COOKIE,
  SESSION_COOKIE,
  sessionCookieAttributes,
  signSession,
  verifyState,
} from '../auth/session.js'

/** The environment this Lambda needs, resolved once per request (never at module load). */
export interface AuthEndpointConfig {
  readonly issuer: string
  /** The `AUTH_CLIENT_ID` list — comma-separated, one or two ids, as elsewhere in this repo. */
  readonly clientId: string
  readonly hostedUiDomain: string
  readonly edgeClientId: string
  readonly redirectUri: string
  readonly sessionSecret: string
  readonly sessionTtlSeconds: number
}

/**
 * The two calls this handler must not make directly, so a unit test can fake
 * them: `exchangeCode` hits Cognito's token endpoint over the network, and
 * `createVerifier` builds a JWKS-fetching verifier. Both are re-exports from
 * `oidc.js`/`server.js` in the real handler — no wrapping, so
 * `expect(ports.exchangeCode).toHaveBeenCalledWith(...)` in a test asserts
 * against the exact real signature.
 */
export interface AuthEndpointPorts {
  readonly exchangeCode: typeof exchangeCode
  readonly createVerifier: typeof createVerifier
}

/** The bit of the trigger event `handleAuthRequest` needs, decoupled from any one AWS event shape. */
export interface AuthEndpointRequest {
  readonly path: string
  /** Query string parameters, already split out by the trigger. */
  readonly query: Record<string, string | undefined>
  /** Request headers, keys as received (looked up case-insensitively). */
  readonly headers: Record<string, string | undefined>
  /** The raw `Cookie` header value, or the trigger's split `cookies` array re-joined. */
  readonly cookieHeader: string | undefined
}

export interface AuthEndpointResponse {
  readonly statusCode: number
  readonly headers: Record<string, string>
  readonly cookies: string[]
  readonly body: string
}

function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

/** Every response, whatever the route, must never be cached at the edge or by the browser. */
const NO_STORE = { 'cache-control': 'no-store' }

function textResponse(statusCode: number, body: string, extraHeaders: Record<string, string> = {}): AuthEndpointResponse {
  return {
    statusCode,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE, ...extraHeaders },
    cookies: [],
    body,
  }
}

function redirectResponse(location: string, cookies: string[] = []): AuthEndpointResponse {
  return {
    statusCode: 302,
    headers: { ...NO_STORE, location },
    cookies,
    body: '',
  }
}

function clearCookie(name: string): string {
  return `${name}=; ${sessionCookieAttributes(0)}`
}

function setSessionCookie(value: string, ttlSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; ${sessionCookieAttributes(ttlSeconds)}`
}

/**
 * A redirect target is only honoured if it is a same-origin relative path:
 * must start with `/`, must not start with `//` (a `Location: //evil.com` is
 * an open redirect — browsers treat a protocol-relative URL as absolute) and
 * must not be a `https://…`/`http://…` absolute URL. Anything else falls
 * back to `/`.
 */
function safeReturnPath(value: string | undefined): string {
  if (!value) return '/'
  if (!value.startsWith('/')) return '/'
  // `//evil.com` **and** `/\evil.com`. The backslash form is the one that
  // gets missed: the WHATWG URL parser treats `\` as `/` for http(s), so
  // `Location: /\evil.com` is parsed as an authority exactly like `//` and
  // is the same open redirect.
  const second = value.charAt(1)
  if (second === '/' || second === '\\') return '/'
  // No CR, LF or other control characters, so the value cannot smuggle a
  // second header into the response.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/'
  return value
}

const GOODBYE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Signed out</title>
  </head>
  <body>
    <p>Signed out.</p>
    <p><a href="/">Return to the site</a></p>
  </body>
</html>
`

async function handleCallback(
  request: AuthEndpointRequest,
  config: AuthEndpointConfig,
  ports: AuthEndpointPorts,
): Promise<AuthEndpointResponse> {
  const { query } = request

  // Cognito bounces the user back with `?error=…&state=…` (no `code`) when,
  // e.g., they cancel the Google consent screen. That is not a CSRF/tamper
  // case, so it is checked before `verifyState` and reported as its own 400.
  if (query.error) {
    const detail = query.error_description ? `${query.error}: ${query.error_description}` : query.error
    return textResponse(400, `oauth error: ${detail}`)
  }

  const state = verifyState(query.state, config.sessionSecret)
  if (!state) {
    return textResponse(400, 'invalid state')
  }

  const code = query.code
  if (!code) {
    return textResponse(400, 'missing code')
  }

  const verifier = pkceVerifier(state, config.sessionSecret)

  const auth: SiteAuthConfig = {
    issuer: config.issuer,
    clientId: config.edgeClientId,
    domain: config.hostedUiDomain,
  }

  let tokens: TokenSet
  try {
    tokens = await ports.exchangeCode(auth, { code, verifier, redirectUri: config.redirectUri })
  } catch (error) {
    // The code/verifier/redirect_uri were ours; a rejection here means
    // Cognito itself is misconfigured (wrong client, wrong redirect_uri),
    // not a bad caller — so this is a 502, not a 401 or 400.
    return textResponse(502, `token exchange failed: ${(error as Error).message}`)
  }

  const verifierConfig: VerifierConfig = { issuer: config.issuer, clientId: config.edgeClientId }
  let user: AuthUser
  try {
    const idTokenVerifier: Verifier = ports.createVerifier(verifierConfig)
    user = await idTokenVerifier.verify(tokens.idToken)
  } catch (error) {
    // Same reasoning as the exchange failure above: the token came straight
    // from Cognito, so a verification failure is misconfiguration.
    return textResponse(502, `id token verification failed: ${(error as Error).message}`)
  }

  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds
  const session = signSession({ sub: user.sub, email: user.email, exp }, config.sessionSecret)

  const cookies = parseCookieHeader(request.cookieHeader)
  const location = safeReturnPath(cookies[RETURN_COOKIE])

  return redirectResponse(location, [
    setSessionCookie(session, config.sessionTtlSeconds),
    clearCookie(RETURN_COOKIE),
  ])
}

function handleLogout(): AuthEndpointResponse {
  // Deliberately *not* a redirect to Cognito's own `/logout`: that endpoint
  // needs an absolute, pre-registered `logout_uri`, which this host-blind
  // Lambda — shared by every preview — cannot produce (it never sees which
  // `pr-N.preview.<domain>` the request actually came in on).
  return redirectResponse('/auth/goodbye', [clearCookie(SESSION_COOKIE)])
}

function handleGoodbye(): AuthEndpointResponse {
  // Clearing our own cookie does not end the user's Cognito hosted-UI
  // session, which survives independently. Without this terminal page, the
  // very next navigation would hit the gate, find no session cookie, bounce
  // to Cognito, and silently sign the user straight back in — "Sign out"
  // would look like it did nothing.
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE },
    cookies: [],
    body: GOODBYE_HTML,
  }
}

async function handleSession(
  request: AuthEndpointRequest,
  config: AuthEndpointConfig,
  ports: AuthEndpointPorts,
): Promise<AuthEndpointResponse> {
  const idToken = getHeader(request.headers, ID_TOKEN_HEADER)
  if (!idToken) {
    return textResponse(401, 'missing id token')
  }

  // This is a GET, not a POST, on purpose: `.claude/rules/cloudfront-origins.md`
  // records that a POST with a body through OAC 403s unless the caller
  // computes `x-amz-content-sha256` itself, which Playwright's plain
  // `request` API does not do. A cross-site GET cannot attach a custom
  // header (`x-id-token`) without triggering a CORS preflight that this
  // origin would refuse, so there is no CSRF exposure in making this a GET.
  try {
    const verifier = ports.createVerifier({ issuer: config.issuer, clientId: config.clientId })
    const user = await verifier.verify(idToken)
    const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds
    const session = signSession({ sub: user.sub, email: user.email, exp }, config.sessionSecret)
    return {
      statusCode: 204,
      headers: { ...NO_STORE },
      cookies: [setSessionCookie(session, config.sessionTtlSeconds)],
      body: '',
    }
  } catch {
    return textResponse(401, 'invalid id token')
  }
}

/**
 * The pure core: routes on `request.path`, never touches `process.env`,
 * never imports the AWS SDK. Exported for the unit tests.
 */
export async function handleAuthRequest(
  request: AuthEndpointRequest,
  config: AuthEndpointConfig,
  ports: AuthEndpointPorts,
): Promise<AuthEndpointResponse> {
  switch (request.path) {
    case '/auth/callback':
      return handleCallback(request, config, ports)
    case '/auth/logout':
      return handleLogout()
    case '/auth/goodbye':
      return handleGoodbye()
    case '/auth/session':
      return handleSession(request, config, ports)
    default:
      return textResponse(404, 'not found')
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required (AUTH_* env vars are set by the constructs; a Lambda missing one is a deployment bug)`)
  }
  return value
}

/** Reads `AuthEndpointConfig` from `process.env`, at request time — never cached at module load. */
function readConfig(): AuthEndpointConfig {
  const ttlRaw = process.env.AUTH_SESSION_TTL_SECONDS
  const sessionTtlSeconds = ttlRaw ? Number(ttlRaw) : 3600
  return {
    issuer: requireEnv('AUTH_ISSUER'),
    clientId: requireEnv('AUTH_CLIENT_ID'),
    hostedUiDomain: requireEnv('AUTH_HOSTED_UI_DOMAIN'),
    edgeClientId: requireEnv('AUTH_EDGE_CLIENT_ID'),
    redirectUri: requireEnv('AUTH_REDIRECT_URI'),
    sessionSecret: requireEnv('AUTH_SESSION_SECRET'),
    sessionTtlSeconds,
  }
}

function toRequest(event: APIGatewayProxyEventV2): AuthEndpointRequest {
  return {
    path: event.requestContext.http.path,
    query: event.queryStringParameters ?? {},
    headers: event.headers,
    cookieHeader: event.cookies && event.cookies.length > 0 ? event.cookies.join('; ') : getHeader(event.headers, 'cookie'),
  }
}

/** The real Lambda function URL handler: env in, real ports, delegates to `handleAuthRequest`. */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const config = readConfig()
  const response = await handleAuthRequest(toRequest(event), config, {
    exchangeCode,
    createVerifier,
  })
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    cookies: response.cookies,
    body: response.body,
  }
}
