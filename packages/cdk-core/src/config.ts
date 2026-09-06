/**
 * The deployed environment description (D11). `Site` and `PreviewDeployment`
 * write this file into the asset prefix as `__config.json`; `pnpm dev` serves a
 * `mode: 'local'` one from Vite middleware.
 *
 * The point is that the web bundle is byte-identical across prod, every
 * preview and local: nothing about the environment is a build-time constant, so
 * one CI build serves the prod deploy and every PR.
 */
export interface SiteAuthConfig {
  /** Cognito issuer, `https://cognito-idp.<region>.amazonaws.com/<poolId>`. */
  readonly issuer: string
  /** The browser app client id. */
  readonly clientId: string
  /** Hosted-UI domain, e.g. `cdk-core.auth.us-east-1.amazoncognito.com`. */
  readonly domain: string
}

export interface SiteConfig {
  /** The site's apex domain, or `localhost` in local mode. */
  readonly site: string
  readonly mode: 'prod' | 'preview' | 'local'
  /** Present only when `mode` is `preview`. */
  readonly pr?: number
  /** Absent when the site has no user pool. */
  readonly auth?: SiteAuthConfig
}

/** Where the browser fetches `SiteConfig` from. Always same-origin. */
export const CONFIG_PATH = '/__config.json'

/** `localStorage` key holding `StoredAuth`. Ours, not Amplify's, so it is stable. */
export const AUTH_STORAGE_KEY = 'cdkcore:auth'

/** The header the ID token travels in (never `Authorization` — see `auth/browser`). */
export const ID_TOKEN_HEADER = 'x-id-token'
