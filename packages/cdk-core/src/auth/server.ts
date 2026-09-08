/**
 * The server half of cdk-core's auth: the one place a backend learns who is
 * calling. A route that reaches for a header itself is the thing that makes
 * Epoch 4 expensive.
 *
 * Mode comes from the `AUTH` environment variable, which the constructs set on
 * every backend Lambda (`AUTH=cognito` plus `AUTH_ISSUER`/`AUTH_CLIENT_ID`) and
 * `pnpm dev` sets to `local`. There is no default that trusts anything: an
 * unset `AUTH` is `none`, and `getUser` returns `null`.
 *
 * There are two credentials `getUser` will accept, tried in that order:
 * an `x-id-token` header (a Cognito ID token, presented by machine callers —
 * the e2e fixture, `scripts/preview-login.sh`) and, in `cognito` mode only,
 * the `__Host-cdkcore-session` cookie a CloudFront Function sets at the edge
 * after Google sign-in. The cookie is HMAC-signed with `AUTH_SESSION_SECRET`,
 * a secret shared with the edge (see `auth/session.ts`), and the origin
 * re-verifies it rather than trusting anything the edge claims.
 */

import { CognitoJwtVerifier } from 'aws-jwt-verify'
import { ID_TOKEN_HEADER } from '../config.js'
import { SESSION_COOKIE, parseCookieHeader, verifySession } from './session.js'

export { ID_TOKEN_HEADER } from '../config.js'
export { SESSION_COOKIE } from './session.js'

export type AuthMode = 'none' | 'local' | 'cognito'

export interface AuthUser {
  readonly sub: string
  readonly email: string
}

/**
 * The bit of Hono's `Context` this needs. Structural on purpose: `auth/server`
 * must not drag `hono` into the package's dependency graph — a consumer might
 * be on a different Hono major, or not use Hono at all.
 */
export interface RequestLike {
  readonly req: {
    header(name: string): string | undefined
  }
}

export function authMode(): AuthMode {
  const raw = process.env.AUTH
  return raw === 'local' || raw === 'cognito' ? raw : 'none'
}

export function isLocalMode(): boolean {
  return authMode() === 'local'
}

export interface VerifierConfig {
  readonly issuer: string
  /**
   * One app client id, or a comma-separated list of them — the same shape as
   * the `AUTH_CLIENT_ID` the constructs emit. A preview passes two (browser
   * and machine); prod passes one.
   */
  readonly clientId: string
}

export interface Verifier {
  verify(idToken: string): Promise<AuthUser>
}

/** `https://cognito-idp.<region>.amazonaws.com/<poolId>` → `<poolId>`. */
const ISSUER_PATTERN = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/([^/]+)$/

function parseUserPoolId(issuer: string): string {
  const match = ISSUER_PATTERN.exec(issuer)
  if (!match) {
    throw new Error(
      `invalid Cognito issuer ${JSON.stringify(issuer)}: expected ` +
        'https://cognito-idp.<region>.amazonaws.com/<poolId>',
    )
  }
  return match[1]
}

/**
 * A Cognito ID-token verifier (`aws-jwt-verify`, `tokenUse: 'id'`, one client
 * id). `aws-jwt-verify` wants a bare user pool id, not the issuer URL, so it
 * is parsed out of `config.issuer` here rather than asked for separately —
 * `AUTH_ISSUER` is the one value the constructs already emit (D4).
 */
export function createVerifier(config: VerifierConfig): Verifier {
  const userPoolId = parseUserPoolId(config.issuer)
  const clientIds = config.clientId
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (clientIds.length === 0) {
    throw new Error('createVerifier: clientId is empty')
  }
  const jwtVerifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: 'id',
    // An array is still an allowlist: `aud` must be one of these exact ids.
    clientId: clientIds,
  })
  return {
    async verify(idToken) {
      const payload = await jwtVerifier.verify(idToken)
      const { email } = payload
      if (typeof email !== 'string') {
        throw new Error('Cognito ID token missing "email" claim')
      }
      return { sub: payload.sub, email }
    },
  }
}

/**
 * One verifier per (issuer, clientId), built once per process: `verify`
 * caches the JWKS inside the instance, and a fresh instance per request would
 * re-fetch it from Cognito every time. `resetVerifierCache` is a test seam.
 */
let verifierCache = new Map<string, Verifier>()

export function resetVerifierCache(): void {
  verifierCache = new Map()
}

function getCachedVerifier(config: VerifierConfig): Verifier {
  const key = `${config.issuer}|${config.clientId}`
  let verifier = verifierCache.get(key)
  if (!verifier) {
    verifier = createVerifier(config)
    verifierCache.set(key, verifier)
  }
  return verifier
}

/**
 * Who is calling, or `null`.
 *
 * In `local` mode a token is trusted iff it starts with `dev:` — no signature,
 * no expiry, no network. That is safe because the only way `AUTH=local` is set
 * is `pnpm dev` on a laptop: the constructs never emit it, and Epoch 4's
 * acceptance test asserts the deployed prod client has no password flow at all.
 *
 * The mode is decided first, then the `x-id-token` header is tried, then (in
 * `cognito` mode only) the session cookie — never the other order, or a
 * cookie-only browser caller would never get past a header check.
 */
export async function getUser(c: RequestLike): Promise<AuthUser | null> {
  const mode = authMode()
  if (mode === 'none') return null

  const token = c.req.header(ID_TOKEN_HEADER)
  if (token) {
    if (mode === 'local') {
      const user = parseDevToken(token)
      if (user) return user
    } else {
      const issuer = process.env.AUTH_ISSUER
      const clientId = process.env.AUTH_CLIENT_ID
      if (!issuer || !clientId) {
        throw new Error(
          'AUTH=cognito requires AUTH_ISSUER and AUTH_CLIENT_ID; a Lambda ' +
            'missing either is a deployment bug',
        )
      }
      const verifier = getCachedVerifier({ issuer, clientId })
      try {
        return await verifier.verify(token)
      } catch {
        // An invalid token — expired, wrong signature, or (the case that
        // matters) issued by a *different* pool — falls through to the
        // cookie below rather than short-circuiting to null: a caller
        // presenting `x-id-token` means it (a machine caller must not be
        // silently reinterpreted as someone else), but a browser carrying a
        // stale header alongside a good cookie is still a signed-in user.
        // The negative case is the interesting one: a preview-pool token
        // presented to the prod API must come back null here because its
        // `iss` does not match the prod pool this verifier was built for
        // (D4) — and prod has no session cookie to fall back to either.
      }
    }
  }

  // The cookie path only exists in `cognito` mode, and only when the edge
  // gate's shared secret is configured. A site with `AUTH=cognito` but no
  // CloudFront Function gate in front of it has no `AUTH_SESSION_SECRET` at
  // all — that is the normal shape of an ungated site, not a deployment bug,
  // so (unlike the ISSUER/CLIENT_ID check above) a missing secret does not
  // throw; it just means there is no cookie credential to try.
  if (mode === 'cognito') {
    const secret = process.env.AUTH_SESSION_SECRET
    if (secret) {
      const cookies = parseCookieHeader(c.req.header('cookie'))
      const payload = verifySession(cookies[SESSION_COOKIE], secret)
      if (payload) return { sub: payload.sub, email: payload.email }
    }
  }

  return null
}

/** `dev:<name>` → a stable fake user. Exported for tests. */
export function parseDevToken(token: string): AuthUser | null {
  if (!token.startsWith('dev:')) return null
  const name = token.slice('dev:'.length).trim()
  if (!name) return null
  return { sub: `dev:${name}`, email: `${name}@local` }
}
