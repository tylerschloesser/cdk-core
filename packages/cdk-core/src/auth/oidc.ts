/**
 * The pure half of Cognito auth: PKCE, `state` encoding, and the two token
 * endpoints. No DOM globals at module scope, so this is unit-testable in
 * plain Node and importable from `auth/server` fixtures without pulling in
 * `window`/`sessionStorage`. `auth/browser` is the half that touches those.
 */

import type { SiteAuthConfig, SiteConfig } from '../config.js'

/** `crypto.getRandomValues` → base64url, no padding. Used for the PKCE verifier and nonce. */
export function randomUrlSafe(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return base64UrlEncode(bytes)
}

/** base64url(SHA-256(verifier)), no padding — PKCE S256, the only method Cognito accepts. */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The exact-match redirect_uri Cognito was configured with (D5). Prod uses the
 * site's own `/auth/callback`; preview uses a fixed bounce host — never the
 * PR's own hostname — because Cognito's callback list has no wildcards and
 * the router CloudFront Function rewrites the bounce back to the PR.
 */
export function redirectUriFor(config: SiteConfig): string {
  if (config.mode === 'local') {
    throw new Error('redirectUriFor: local mode has no Cognito redirect_uri')
  }
  if (config.mode === 'preview') {
    if (config.pr === undefined) {
      throw new Error('redirectUriFor: preview mode requires config.pr')
    }
    return `https://oauth.preview.${config.site}/`
  }
  return `https://${config.site}/auth/callback`
}

/**
 * `state` per D5: never URL-encoded JSON (Cognito rejects that), and in
 * preview mode formatted as `<nonce>.<pr>` so it survives the router
 * function's `^[A-Za-z0-9._~-]+$` query-param allowlist.
 */
export function formatState(config: SiteConfig, nonce: string): string {
  if (config.mode === 'preview') {
    if (config.pr === undefined) {
      throw new Error('formatState: preview mode requires config.pr')
    }
    return `${nonce}.${config.pr}`
  }
  return nonce
}

/** Inverse of `formatState`. Returns null for anything that isn't that shape. */
export function parseState(state: string): { nonce: string; pr?: number } | null {
  const match = /^([A-Za-z0-9_-]+)(?:\.([0-9]+))?$/.exec(state)
  if (!match) return null
  const [, nonce, pr] = match
  if (!nonce) return null
  return pr === undefined ? { nonce } : { nonce, pr: Number(pr) }
}

/**
 * The Cognito hosted-UI authorize URL. `identity_provider=Google` is set so
 * the user never sees the Cognito page itself — it is a bounce, not a UI.
 */
export function buildAuthorizeUrl(
  auth: SiteAuthConfig,
  args: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: auth.clientId,
    redirect_uri: args.redirectUri,
    scope: 'openid email profile',
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
    identity_provider: 'Google',
  })
  return `https://${auth.domain}/oauth2/authorize?${params.toString()}`
}

export interface TokenSet {
  readonly idToken: string
  readonly accessToken: string
  readonly refreshToken?: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

interface TokenResponse {
  readonly id_token?: string
  readonly access_token?: string
  readonly refresh_token?: string
  readonly expires_in?: number
  readonly error?: string
}

async function postToken(auth: SiteAuthConfig, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(`https://${auth.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const parsed = (await res.json().catch(() => undefined)) as TokenResponse | undefined
  if (!res.ok) {
    const detail = parsed?.error ? `: ${parsed.error}` : ''
    throw new Error(`oauth2/token → ${res.status}${detail}`)
  }
  return parsed ?? {}
}

function toTokenSet(res: TokenResponse): TokenSet {
  if (!res.id_token || !res.access_token) {
    throw new Error('oauth2/token: response is missing id_token or access_token')
  }
  return {
    idToken: res.id_token,
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: Date.now() + (res.expires_in ?? 0) * 1000,
  }
}

/** Exchanges an authorization code for tokens. Public client: no client secret. */
export async function exchangeCode(
  auth: SiteAuthConfig,
  args: { code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: auth.clientId,
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.verifier,
  })
  return toTokenSet(await postToken(auth, body))
}

/**
 * Refreshes an ID/access token pair. Cognito does not return a new
 * `refresh_token` on this grant, so the caller must keep the old one.
 */
export async function refreshTokens(auth: SiteAuthConfig, refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: auth.clientId,
    refresh_token: refreshToken,
  })
  return toTokenSet(await postToken(auth, body))
}
