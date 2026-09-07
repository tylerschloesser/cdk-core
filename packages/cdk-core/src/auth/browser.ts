/**
 * The browser half of cdk-core's auth. One module for every mode the site can
 * be deployed in; which one is live is read from `__config.json` at runtime
 * (D11), never baked into the bundle.
 *
 * `local` mode: `login()` stores a `dev:<name>` token that `auth/server`
 * trusts when `AUTH=local`. `prod`/`preview` drive the Cognito hosted UI via
 * `auth/oidc` — PKCE S256, the preview bounce host (D5), and refresh within
 * 5 minutes of expiry.
 */

import { AUTH_STORAGE_KEY, CONFIG_PATH, ID_TOKEN_HEADER, type SiteConfig } from '../config.js'
import { EMPTY_BODY_SHA256, sha256Hex } from '../hash.js'
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  exchangeCode,
  formatState,
  parseState,
  randomUrlSafe,
  redirectUriFor,
  refreshTokens,
} from './oidc.js'

export { readSse, type SseEvent } from '../sse.js'
export { sha256Hex, EMPTY_BODY_SHA256 } from '../hash.js'
export { AUTH_STORAGE_KEY, CONFIG_PATH, ID_TOKEN_HEADER } from '../config.js'
export type { SiteConfig, SiteAuthConfig } from '../config.js'
export { buildAuthorizeUrl, formatState, parseState, redirectUriFor, type TokenSet } from './oidc.js'

/** `sessionStorage` key holding the in-flight PKCE verifier/nonce/return path. */
export const PKCE_STORAGE_KEY = 'cdkcore:pkce'

interface PkceState {
  readonly verifier: string
  readonly nonce: string
  readonly returnTo: string
}

/** What lives under `localStorage['cdkcore:auth']`. */
export interface StoredAuth {
  readonly idToken: string
  readonly accessToken: string
  readonly refreshToken?: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

let configPromise: Promise<SiteConfig> | undefined

/**
 * Fetches and caches `/__config.json`. Cached for the life of the page: the
 * file is deployed with the assets, so it cannot change under a loaded tab.
 */
export function loadConfig(): Promise<SiteConfig> {
  configPromise ??= fetch(CONFIG_PATH, { cache: 'no-store' }).then(async (res) => {
    if (!res.ok) throw new Error(`${CONFIG_PATH} → ${res.status}`)
    return (await res.json()) as SiteConfig
  })
  return configPromise
}

/** Test seam: drops the cached `__config.json`. */
export function resetConfigCache(): void {
  configPromise = undefined
}

/**
 * Starts a login.
 *
 * In `local` mode this is the whole flow: there is no identity provider, so the
 * name typed into the dev-login box becomes a `dev:<name>` token. In every
 * other mode it redirects to Cognito's hosted UI and does not return: the
 * PKCE verifier and nonce are stashed in `sessionStorage`, which survives the
 * preview bounce (D5) because the browser lands back on the same origin it
 * started from.
 */
export async function login(devUser?: string): Promise<void> {
  const config = await loadConfig()
  if (config.mode === 'local') {
    const name = (devUser ?? '').trim()
    if (!name) throw new Error('local login needs a user name')
    if (name.includes(':')) throw new Error('local user name must not contain ":"')

    setStoredAuth({
      idToken: `dev:${name}`,
      accessToken: `dev:${name}`,
      // Long enough that no local session expires mid-suite, short enough to be
      // obviously not a real token lifetime.
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    })
    return
  }

  if (!config.auth) {
    throw new Error('login: config.auth is missing — __config.json was not deployed with a user pool')
  }

  const verifier = randomUrlSafe(32)
  const nonce = randomUrlSafe(16)
  const returnTo = `${window.location.pathname}${window.location.search}` || '/'
  const pkce: PkceState = { verifier, nonce, returnTo }
  sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(pkce))

  const redirectUri = redirectUriFor(config)
  const state = formatState(config, nonce)
  const codeChallenge = await codeChallengeS256(verifier)
  const url = buildAuthorizeUrl(config.auth, { redirectUri, state, codeChallenge })
  // Navigates away; nothing after this line runs in a real browser.
  window.location.assign(url)
}

/**
 * Completes the `/auth/callback` leg of a Cognito login. Resolves to the path
 * the caller should return to.
 */
export async function handleCallback(search?: string): Promise<string> {
  const config = await loadConfig()
  if (config.mode === 'local') return '/'

  const params = new URLSearchParams(search ?? window.location.search)
  const error = params.get('error')
  if (error) throw new Error(`auth callback: ${error}`)

  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) throw new Error('auth callback: missing code or state')

  const raw = sessionStorage.getItem(PKCE_STORAGE_KEY)
  sessionStorage.removeItem(PKCE_STORAGE_KEY)
  if (!raw) throw new Error('auth callback: no PKCE state in this browser session')
  const pkce = JSON.parse(raw) as PkceState

  const parsed = parseState(state)
  // CSRF check: the nonce returned by Cognito must equal the one this browser
  // minted before redirecting, otherwise this is not our login attempt.
  if (!parsed || parsed.nonce !== pkce.nonce) {
    throw new Error('auth callback: state does not match this browser session')
  }

  if (!config.auth) {
    throw new Error('auth callback: config.auth is missing — __config.json was not deployed with a user pool')
  }

  const tokens = await exchangeCode(config.auth, {
    code,
    verifier: pkce.verifier,
    redirectUri: redirectUriFor(config),
  })
  setStoredAuth(tokens)
  return pkce.returnTo || '/'
}

/** How long before expiry a stored token is refreshed. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000

let refreshPromise: Promise<string | null> | undefined

/**
 * The ID token to send, or `null` when nobody is signed in. A token expiring
 * within 5 minutes is refreshed first, sharing one in-flight refresh across
 * concurrent callers. A refresh failure logs out — an expired session is a
 * logged-out session, not an error the UI has to render.
 */
export async function getToken(): Promise<string | null> {
  const stored = getStoredAuth()
  if (!stored) return null

  const expiringSoon = stored.expiresAt - Date.now() <= REFRESH_WINDOW_MS
  if (!expiringSoon) return stored.idToken

  if (!stored.refreshToken) {
    // No way to refresh: drop it once it has actually expired, exactly as
    // before refresh existed.
    if (stored.expiresAt <= Date.now()) {
      logout()
      return null
    }
    return stored.idToken
  }

  const refreshToken = stored.refreshToken
  refreshPromise ??= doRefresh(refreshToken)
  return refreshPromise
}

async function doRefresh(refreshToken: string): Promise<string | null> {
  try {
    const config = await loadConfig()
    if (!config.auth) throw new Error('getToken: config.auth is missing')
    const refreshed = await refreshTokens(config.auth, refreshToken)
    // Cognito does not return a new refresh_token on this grant — carry the
    // old one forward.
    const next: StoredAuth = { ...refreshed, refreshToken }
    setStoredAuth(next)
    return next.idToken
  } catch {
    logout()
    return null
  } finally {
    refreshPromise = undefined
  }
}

/** Test seam: drops the shared in-flight refresh promise. */
export function resetAuthState(): void {
  refreshPromise = undefined
}

export function logout(): void {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY)
  } catch {
    // A browser with storage disabled has nothing to clear.
  }
}

export function getStoredAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredAuth
    return typeof parsed?.idToken === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function setStoredAuth(auth: StoredAuth): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth))
}

/**
 * `fetch` for this site's backends. Adds two headers and nothing else:
 *
 * - `x-id-token`, because CloudFront's origin access control overwrites
 *   `Authorization` with its own SigV4 signature before the Lambda sees it.
 * - `x-amz-content-sha256` for any request with a body, because that same
 *   signature covers a payload hash CloudFront cannot compute — without it a
 *   POST 403s at the function URL (see `hash.ts`).
 *
 * The path is same-origin everywhere: Vite proxies it locally, CloudFront
 * routes it by behavior in prod and previews.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)

  const token = await getToken()
  if (token) headers.set(ID_TOKEN_HEADER, token)

  const body = init.body
  if (body === undefined || body === null) {
    headers.set('x-amz-content-sha256', EMPTY_BODY_SHA256)
  } else if (typeof body === 'string' || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    headers.set('x-amz-content-sha256', await sha256Hex(body))
  } else {
    // A stream or FormData body cannot be hashed without buffering it, and the
    // signature would be wrong if we guessed. Callers send strings.
    throw new Error('apiFetch: body must be a string, ArrayBuffer or ArrayBufferView')
  }

  return fetch(input, { ...init, headers })
}
