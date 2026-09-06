/**
 * The server half of cdk-core's auth: the one place a backend learns who is
 * calling. A route that reaches for a header itself is the thing that makes
 * Epoch 4 expensive.
 *
 * Mode comes from the `AUTH` environment variable, which the constructs set on
 * every backend Lambda (`AUTH=cognito` plus `AUTH_ISSUER`/`AUTH_CLIENT_ID`) and
 * `pnpm dev` sets to `local`. There is no default that trusts anything: an
 * unset `AUTH` is `none`, and `getUser` returns `null`.
 */

import { ID_TOKEN_HEADER } from '../config.js'

export { ID_TOKEN_HEADER } from '../config.js'

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
  readonly clientId: string
}

export interface Verifier {
  verify(idToken: string): Promise<AuthUser>
}

/**
 * A Cognito ID-token verifier (`aws-jwt-verify`, `tokenUse: 'id'`, one client
 * id). Epoch 4.
 */
export function createVerifier(config: VerifierConfig): Verifier {
  void config
  throw new Error('not implemented: Epoch 4 (aws-jwt-verify)')
}

/**
 * Who is calling, or `null`.
 *
 * In `local` mode a token is trusted iff it starts with `dev:` — no signature,
 * no expiry, no network. That is safe because the only way `AUTH=local` is set
 * is `pnpm dev` on a laptop: the constructs never emit it, and Epoch 4's
 * acceptance test asserts the deployed prod client has no password flow at all.
 */
export async function getUser(c: RequestLike): Promise<AuthUser | null> {
  const token = c.req.header(ID_TOKEN_HEADER)
  if (!token) return null

  switch (authMode()) {
    case 'none':
      return null
    case 'local':
      return parseDevToken(token)
    case 'cognito':
      throw new Error('not implemented: Epoch 4 (Cognito verification)')
  }
}

/** `dev:<name>` → a stable fake user. Exported for tests. */
export function parseDevToken(token: string): AuthUser | null {
  if (!token.startsWith('dev:')) return null
  const name = token.slice('dev:'.length).trim()
  if (!name) return null
  return { sub: `dev:${name}`, email: `${name}@local` }
}
