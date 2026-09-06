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
  /** Default `CachePolicy.CACHING_DISABLED`. Ignored in previews, which are always disabled. */
  readonly cachePolicy?: cloudfront.ICachePolicy
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
}

/** Env vars the constructs put on a backend Lambda so `auth/server` can verify tokens. */
export interface AuthEnvironment {
  readonly AUTH: 'cognito'
  readonly AUTH_ISSUER: string
  readonly AUTH_CLIENT_ID: string
}
