/**
 * The browser half of cdk-core's auth. One module for every mode the site can
 * be deployed in; which one is live is read from `__config.json` at runtime
 * (D11), never baked into the bundle.
 *
 * Epoch 1 implements **local mode** only: `login()` stores a `dev:<name>` token
 * that `auth/server` trusts when `AUTH=local`. The Cognito paths (PKCE, the
 * preview bounce, refresh) land in Epoch 4 and throw until then, so that a
 * misconfigured deploy fails loudly instead of silently serving an anonymous
 * page.
 */

import { AUTH_STORAGE_KEY, CONFIG_PATH, ID_TOKEN_HEADER, type SiteConfig } from '../config.js'
import { EMPTY_BODY_SHA256, sha256Hex } from '../hash.js'

export { readSse, type SseEvent } from '../sse.js'
export { sha256Hex, EMPTY_BODY_SHA256 } from '../hash.js'
export { AUTH_STORAGE_KEY, CONFIG_PATH, ID_TOKEN_HEADER } from '../config.js'
export type { SiteConfig, SiteAuthConfig } from '../config.js'

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
 * other mode it redirects to Cognito (Epoch 4) and does not return.
 */
export async function login(devUser?: string): Promise<void> {
  const config = await loadConfig()
  if (config.mode !== 'local') {
    throw new Error('not implemented: Epoch 4 (Cognito authorize redirect)')
  }

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
}

/** Completes the `/auth/callback` leg of a Cognito login. */
export async function handleCallback(): Promise<void> {
  const config = await loadConfig()
  if (config.mode === 'local') return
  throw new Error('not implemented: Epoch 4 (PKCE code exchange)')
}

/**
 * The ID token to send, or `null` when nobody is signed in. Refreshing an
 * expiring Cognito token is Epoch 4; a stored token that has expired is dropped
 * rather than sent, in every mode.
 */
export async function getToken(): Promise<string | null> {
  const stored = getStoredAuth()
  if (!stored) return null
  if (stored.expiresAt <= Date.now()) {
    logout()
    return null
  }
  return stored.idToken
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
