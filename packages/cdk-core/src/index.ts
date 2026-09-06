/**
 * `@tylerschloesser/cdk-core` — the construct surface.
 *
 * Everything downstream derives from this file: the props here are the contract
 * between `Site` (prod), `PreviewSite` (one per site, shared by every PR) and
 * `PreviewDeployment` (one per PR, in the PR stack). See `plan.md` →
 * Construct API for the reasoning behind each default.
 *
 * As of Epoch 2 the preview half is real: `siteCertificate`, `PreviewSite` and
 * `PreviewDeployment` build resources. `Site` and `GithubDeployRole` are still
 * throwing stubs (Epoch 3), and the `auth` props on all of them are accepted
 * but ignored with a synth-time warning until Epoch 4.
 */

import { Construct } from 'constructs'
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import type * as cognito from 'aws-cdk-lib/aws-cognito'
import type * as iam from 'aws-cdk-lib/aws-iam'
import type * as lambda from 'aws-cdk-lib/aws-lambda'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'

import type { AuthEnvironment, AuthProps, BackendProps, SiteDomain } from './types.js'

export type { SiteConfig, SiteAuthConfig } from './config.js'
export { AUTH_STORAGE_KEY, CONFIG_PATH, ID_TOKEN_HEADER } from './config.js'
export type { SiteDomain, BackendProps, AuthProps, AuthEnvironment } from './types.js'

export { siteCertificate } from './certificate.js'
export type { SiteCertificateProps } from './certificate.js'

export { PreviewSite, previewParameterPrefix } from './preview-site.js'
export type { PreviewSiteProps } from './preview-site.js'

export { PreviewDeployment } from './preview-deployment.js'
export type { PreviewDeploymentProps } from './preview-deployment.js'

export { renderRouterSource } from './router/render.js'
export type { RouterSourceProps } from './router/render.js'

const NOT_YET = (epoch: number, what: string) => new Error(`not implemented: Epoch ${epoch} (${what})`)

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
