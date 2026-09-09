/**
 * The prop types shared by every construct in the package.
 *
 * These live apart from the constructs because `src/router/render.ts` needs
 * `BackendProps` and must not pull `aws-cdk-lib`'s construct classes into a
 * module whose output is a plain string. `src/index.ts` re-exports everything
 * here, so the published surface is unchanged.
 */

import type { Duration } from 'aws-cdk-lib'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import type * as cognito from 'aws-cdk-lib/aws-cognito'
import type * as route53 from 'aws-cdk-lib/aws-route53'
import type { Construct } from 'constructs'

/** Where the site lives. Everything is derived from these two values. */
export interface SiteDomain {
  /** e.g. 'cdk-core.ty.ler.dev'. Previews are `pr-<n>.preview.<domain>`. */
  readonly domain: string
  /** The hosted zone that contains `domain`. Imported by the consumer, never created here. */
  readonly zone: route53.IHostedZone
}

/**
 * A backend mounted by path. The same shape is used by `Site` and
 * `PreviewSite`; only `Site` needs the origin, because a preview's origin is
 * chosen per request by the router function from the KeyValueStore.
 */
export interface BackendProps {
  /** CloudFront path pattern, e.g. '/api/*'. Must not overlap another backend or '/__config.json'. */
  readonly pathPattern: string
  /** Set when the Lambda URL is RESPONSE_STREAM. Forces compress:false, CACHING_DISABLED, readTimeout default 60s. */
  readonly streaming?: boolean
  /** Origin read timeout. Default 30s, or 60s when streaming. Max 120s without a quota increase. */
  readonly readTimeout?: Duration
  /**
   * Default `CACHING_DISABLED`. Accepts a construct, or a factory that `Site`
   * calls once per backend with the `Site` construct as scope — the form
   * `defineSiteStacks` consumers need, because `backends` is built before any
   * stack exists. Ignored in previews, which are always `CACHING_DISABLED`.
   */
  readonly cachePolicy?: cloudfront.ICachePolicy | ((scope: Construct) => cloudfront.ICachePolicy)
  /** Default `AllowedMethods.ALLOW_ALL`. */
  readonly allowedMethods?: cloudfront.AllowedMethods
  /** Escape hatch: merged last into the behavior. Cannot replace `origin` or `functionAssociations`. */
  readonly behaviorOverrides?: Partial<cloudfront.BehaviorOptions>
}

export interface AuthProps {
  /** Secrets Manager secret holding `{clientId, clientSecret}` for the Google OAuth client. Default 'cdk-core/google-oauth'. */
  readonly googleSecretName?: string
  /** Cognito domain prefix. Default: the domain with dots replaced by dashes (plus '-preview' for the preview pool). */
  readonly domainPrefix?: string
  /** Escape hatch: use `auth.<domain>` as a Cognito custom domain (max 4 per Region). Needs the cert to include it. */
  readonly customDomainCertificate?: acm.ICertificate
  /** Default 1h. */
  readonly idTokenValidity?: Duration
  /** Default 30d. */
  readonly refreshTokenValidity?: Duration
  /** Escape hatch applied to the `UserPool` props. */
  readonly userPoolOverrides?: Partial<cognito.UserPoolProps>
  /**
   * When set, the whole site is gated at the CloudFront edge: a request with
   * no valid session cookie never reaches an origin. The constructs create
   * the session secret, the KVS entry it is copied into, the `/auth/*`
   * Lambda behavior, and attach the gate to every CloudFront Function.
   *
   * A string union rather than a boolean so an origin-side variant could be
   * added later without a breaking change.
   */
  readonly gate?: 'edge'
  /**
   * Paths the edge gate lets through with **no authentication at all**, in
   * addition to `/auth/*` (which is always exempt and must not be listed).
   * Matched exactly the way `/auth` is: an exact match, or the path followed
   * by `/`. `'/api/health'` exempts `/api/health` and `/api/health/deep`, but
   * not `/api/healthz`.
   *
   * The intended use is a health check a deploy pipeline can poll without a
   * credential — prod has no machine identity by design (A7), so without this
   * nothing in CI can reach a prod origin.
   *
   * **What it costs.** An ungated path is reachable by anyone on the internet,
   * on prod *and* on every `pr-N.preview.<domain>` host, with no cookie and no
   * check of any kind — it leaks its own existence and liveness. It must
   * therefore return no user data and no site content. `'/'` is rejected at
   * synth, and any prefix of the SPA shell is exactly the wrong thing to list.
   *
   * Per-environment lists work: `preview` overrides this the way it overrides
   * every other `AuthProps` field.
   */
  readonly ungatedPaths?: readonly string[]
}

/** Env vars the constructs put on a backend Lambda so `auth/server` can verify tokens. */
export interface AuthEnvironment {
  readonly AUTH: 'cognito'
  readonly AUTH_ISSUER: string
  /**
   * The app client id a token's `aud` must match — or a **comma-separated
   * list** of them.
   *
   * Prod is one id. A preview is two, because the machine user signs in
   * through the `machine` client and a human through the `browser` one, and
   * `aud` is the client that minted the token, not the pool. Trusting both is
   * safe and trusting one is not enough: the isolation that matters is the
   * *pool* (D4), which the `iss` check enforces, and both clients live in the
   * preview pool. The prod verifier still rejects every preview token, because
   * its issuer is a different pool entirely.
   */
  readonly AUTH_CLIENT_ID: string
  /**
   * Present only when `AuthProps.gate` is set. The HMAC secret the origin
   * uses to re-verify the session cookie the edge gate checks, delivered as a
   * `{{resolve:secretsmanager:…}}` dynamic reference so it never appears in
   * the template. Optional because an ungated site has no such secret, and
   * `auth/server` treats its absence as "no gate", not as a deployment bug.
   */
  readonly AUTH_SESSION_SECRET?: string
}
