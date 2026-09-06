/**
 * `@tylerschloesser/cdk-core` — the construct surface.
 *
 * Everything downstream derives from this file: the props here are the contract
 * between `Site` (prod), `PreviewSite` (one per site, shared by every PR) and
 * `PreviewDeployment` (one per PR, in the PR stack). See `plan.md` →
 * Construct API for the reasoning behind each default.
 *
 * **Epoch 1 ships the types and nothing else.** Every constructor throws. That
 * is deliberate: the API is the part worth reviewing before any of it is built,
 * and a stub that throws is honest where a stub that silently synthesizes
 * nothing is not. Bodies land in Epoch 2 (`siteCertificate`, `PreviewSite`,
 * `PreviewDeployment`), Epoch 3 (`Site`, `GithubDeployRole`) and Epoch 4
 * (the `auth` props on all of them).
 */

import { Construct } from 'constructs'
import type { Duration } from 'aws-cdk-lib'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import type * as cognito from 'aws-cdk-lib/aws-cognito'
import type * as iam from 'aws-cdk-lib/aws-iam'
import type * as lambda from 'aws-cdk-lib/aws-lambda'
import type * as route53 from 'aws-cdk-lib/aws-route53'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'

export type { SiteConfig, SiteAuthConfig } from './config.js'
export { AUTH_STORAGE_KEY, CONFIG_PATH, ID_TOKEN_HEADER } from './config.js'

const NOT_YET = (epoch: number, what: string) => new Error(`not implemented: Epoch ${epoch} (${what})`)

// ---------- shared ----------

/** Where the site lives. Everything is derived from these two values. */
export interface SiteDomain {
  /** e.g. 'cdk-core.ty.ler.dev'. Previews are `pr-<n>.preview.<domain>`. */
  readonly domain: string
  /** The hosted zone that contains `domain`. Imported by the consumer, never created here. */
  readonly zone: route53.IHostedZone
}

export interface SiteCertificateProps extends SiteDomain {
  /** Adds `auth.<domain>` as a third SAN, for the Cognito custom-domain escape hatch. */
  readonly includeAuthHost?: boolean
}

/**
 * One ACM certificate covering `domain` and `*.preview.<domain>` (and
 * `auth.<domain>` if asked). Must be created in us-east-1.
 */
export function siteCertificate(
  scope: Construct,
  id: string,
  props: SiteCertificateProps,
): acm.Certificate {
  void scope
  void id
  void props
  throw NOT_YET(2, 'siteCertificate')
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

// ---------- Site (prod) ----------

export interface SiteProps extends SiteDomain {
  readonly certificate: acm.ICertificate
  /** Absolute path to the built SPA (e.g. apps/web/dist). Throws at synth if missing. */
  readonly webDist: string
  /** Backends keyed by a short id ('api', 'events'). Keys must match PreviewSite/PreviewDeployment. */
  readonly backends: Record<string, BackendProps & { readonly functionUrl: lambda.IFunctionUrl }>
  /** Omit for a public site with no user pool. */
  readonly auth?: AuthProps
  /** File globs that must never be cached hard. Default ['*.html', 'sw.js', 'manifest.webmanifest', 'registerSW.js', '__config.json']. */
  readonly unversioned?: string[]
  /** Escape hatch merged into DistributionProps (priceClass, httpVersion, webAclId, logging, ...). Cannot replace behaviors. */
  readonly distributionOverrides?: Partial<cloudfront.DistributionProps>
  /** Extra behaviors the consumer owns entirely. Must not collide with `backends`. */
  readonly additionalBehaviors?: Record<string, cloudfront.BehaviorOptions>
}

export class Site extends Construct {
  readonly distribution!: cloudfront.Distribution
  readonly bucket!: s3.Bucket
  /** `https://<domain>` */
  readonly url!: string
  readonly userPool?: cognito.UserPool
  readonly userPoolClient?: cognito.UserPoolClient
  /** Env to spread onto each backend Lambda; `{}` when `auth` is omitted. */
  readonly authEnvironment!: AuthEnvironment | Record<string, never>

  constructor(scope: Construct, id: string, props: SiteProps) {
    super(scope, id)
    void props
    throw NOT_YET(3, 'Site')
  }
}

// ---------- PreviewSite (shared, one per site) ----------

export interface PreviewSiteProps extends SiteDomain {
  readonly certificate: acm.ICertificate
  /** Same keys as `Site.backends`; origins are dynamic, so only the routing props are used. */
  readonly backends: Record<string, BackendProps>
  /** Omit for a site with no auth. When present, creates the preview pool, machine client, machine user and secret. */
  readonly auth?: AuthProps
  /** Machine user name. Default 'claude'. Secret: '<domain>/preview-machine-user'. */
  readonly machineUserName?: string
  /** SSM namespace for what PR stacks read. Default '/cdk-core/<domain>/preview'. */
  readonly parameterPrefix?: string
  readonly distributionOverrides?: Partial<cloudfront.DistributionProps>
}

export class PreviewSite extends Construct {
  readonly distribution!: cloudfront.Distribution
  readonly bucket!: s3.Bucket
  readonly keyValueStore!: cloudfront.KeyValueStore
  readonly routerFunction!: cloudfront.Function
  readonly userPool?: cognito.UserPool
  readonly machineUserSecret?: secretsmanager.ISecret
  /** Published to SSM under this prefix: distributionArn, distributionId, bucketName, kvsArn, authIssuer, authClientId, machineSecretArn. */
  readonly parameterPrefix!: string

  constructor(scope: Construct, id: string, props: PreviewSiteProps) {
    super(scope, id)
    void props
    throw NOT_YET(2, 'PreviewSite')
  }
}

// ---------- PreviewDeployment (one per PR, in the PR stack) ----------

export interface PreviewDeploymentProps {
  readonly domain: string
  /** PR number. Validated `/^[0-9]+$/`. */
  readonly pr: number
  readonly webDist: string
  /** Same keys as `PreviewSite.backends`. Any IFunctionUrl works, including an imported production one. */
  readonly backends: Record<string, lambda.IFunctionUrl>
  /** Default '/cdk-core/<domain>/preview'. */
  readonly parameterPrefix?: string
  readonly unversioned?: string[]
}

export class PreviewDeployment extends Construct {
  /** `pr-<n>.preview.<domain>` */
  readonly hostname!: string
  /** `https://pr-<n>.preview.<domain>` */
  readonly url!: string
  /** Env to spread onto each PR backend Lambda, or `{}` when the site has no auth. */
  readonly authEnvironment!: AuthEnvironment | Record<string, never>

  constructor(scope: Construct, id: string, props: PreviewDeploymentProps) {
    super(scope, id)
    void props
    throw NOT_YET(2, 'PreviewDeployment')
  }
}

// ---------- GithubDeployRole (deployed by hand, once) ----------

export interface GithubDeployRoleProps {
  /** 'tylerschloesser/cdk-core' */
  readonly repo: string
  /** 'cdk-core-github-deploy' */
  readonly roleName: string
  /** Stack-name prefix; `DeleteStack` is scoped to `<stackPrefix>-pr-*`. */
  readonly stackPrefix: string
  /** Used to scope the KVS and preview-bucket permissions via SSM lookups. */
  readonly domain: string
  /** Default: import the account's existing provider. Never create one. */
  readonly oidcProviderArn?: string
}

export class GithubDeployRole extends Construct {
  readonly role!: iam.Role

  constructor(scope: Construct, id: string, props: GithubDeployRoleProps) {
    super(scope, id)
    void props
    throw NOT_YET(3, 'GithubDeployRole')
  }
}
