/**
 * `PreviewSite` — the shared half of the preview topology. One per site,
 * deployed once, then left alone while PR stacks come and go.
 *
 * It owns everything a preview needs that is *not* per-PR: the asset bucket
 * (one, shared, with a `pr-<n>/` prefix per PR — plan.md D10), the
 * KeyValueStore that maps a preview hostname to its route, the CloudFront
 * Function that reads it, the distribution with the wildcard alias, and the
 * SSM parameters a PR stack reads instead of taking a cross-stack dependency.
 *
 * The interesting part is that backend origins are **not** origins of this
 * distribution. The router function calls `cf.updateRequestOrigin()` with an
 * inline OAC config to point each request at that PR's Lambda function URL,
 * which is what makes one distribution serve every open PR. That is the claim
 * `docs/spikes/2026-09-06-oac-routing-spike.md` was written to prove; it holds,
 * including SigV4 signing of a `RESPONSE_STREAM` URL that CloudFront has never
 * been told about.
 */

import { Annotations, Duration, RemovalPolicy } from 'aws-cdk-lib'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import type * as cognito from 'aws-cdk-lib/aws-cognito'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { Construct } from 'constructs'

import { backendBehavior, safeDistributionOverrides } from './behaviors.js'
import { renderRouterSource } from './router/render.js'
import type { AuthProps, BackendProps, SiteDomain } from './types.js'

/**
 * The origin every backend behavior is *assigned*, and which the router
 * function overrides on every request. It has to be a syntactically valid
 * domain — CloudFront accepts this one, verified at `CreateDistribution` in the
 * spike — and it must never resolve, so that a router that somehow fails to
 * override the origin fails loudly instead of quietly reaching a real host.
 */
const PLACEHOLDER_ORIGIN_DOMAIN = 'origin-placeholder.invalid'

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

/** The SSM keys a `PreviewDeployment` reads. Written here, nowhere else. */
export function previewParameterPrefix(domain: string): string {
  return `/cdk-core/${domain}/preview`
}

export class PreviewSite extends Construct {
  readonly distribution: cloudfront.Distribution
  readonly bucket: s3.Bucket
  readonly keyValueStore: cloudfront.KeyValueStore
  readonly routerFunction: cloudfront.Function
  readonly userPool?: cognito.UserPool
  readonly machineUserSecret?: secretsmanager.ISecret
  readonly parameterPrefix: string

  constructor(scope: Construct, id: string, props: PreviewSiteProps) {
    super(scope, id)

    if (props.auth) {
      Annotations.of(this).addWarningV2(
        '@tylerschloesser/cdk-core:previewAuthNotImplemented',
        'PreviewSite: `auth` is accepted but ignored until Epoch 4. No user pool, machine ' +
          'user or secret is created, and backends run with AUTH unset (= none).',
      )
    }

    this.parameterPrefix = props.parameterPrefix ?? previewParameterPrefix(props.domain)

    // Previews hold nothing worth keeping: `cdk destroy` on this stack must
    // leave no bucket behind for the next one to collide with.
    this.bucket = new s3.Bucket(this, 'Assets', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    this.keyValueStore = new cloudfront.KeyValueStore(this, 'Routes', {
      keyValueStoreName: `${props.domain.replace(/\./g, '-')}-preview`,
    })

    this.routerFunction = new cloudfront.Function(this, 'Router', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: this.keyValueStore,
      code: cloudfront.FunctionCode.fromInline(
        renderRouterSource({ domain: props.domain, backends: props.backends }),
      ),
      comment: `cdk-core preview router for ${props.domain}`,
    })

    const routerAssociation: cloudfront.FunctionAssociation[] = [
      {
        function: this.routerFunction,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      },
    ]

    // One placeholder shared by every backend behavior. Per-behavior read
    // timeouts are set by the router at request time via
    // `updateRequestOrigin.timeouts`, which allows 1-120 s; this origin's own
    // timeout only matters on the path where the router did not run, and that
    // path is a hard failure by design.
    const placeholderOrigin = new origins.HttpOrigin(PLACEHOLDER_ORIGIN_DOMAIN, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: Duration.seconds(60),
    })

    // The behavior shape itself is shared with `Site` — see `behaviors.ts` for
    // why that is code and not a convention. What is preview-specific is the
    // two arguments: the origin is a placeholder the router overrides per
    // request, and caching is forced off whatever the prod site does, because
    // one PR's API response must never be served to another PR and the router
    // cannot vary the cache key by host.
    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {}
    for (const backend of Object.values(props.backends)) {
      additionalBehaviors[backend.pathPattern] = backendBehavior(backend, {
        origin: placeholderOrigin,
        functionAssociations: routerAssociation,
        forceCachingDisabled: true,
      })
    }

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `cdk-core previews for ${props.domain}`,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      // Spread before the behaviors, the domain names and the certificate, so
      // it cannot replace them; `safeDistributionOverrides` strips those four
      // keys so a consumer gets a compile-time-legal no-op rather than a
      // distribution whose router is quietly gone.
      ...safeDistributionOverrides(props.distributionOverrides),
      certificate: props.certificate,
      domainNames: [`*.preview.${props.domain}`],
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: routerAssociation,
      },
      additionalBehaviors,
    })

    // A single wildcard record for every preview, so opening a PR needs no DNS
    // write and closing one needs no cleanup (plan.md D9). `*.preview.<domain>`
    // also covers the `oauth.preview.<domain>` bounce host from D5.
    const wildcard = `*.preview.${props.domain}`
    const recordTarget = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(this.distribution),
    )
    new route53.ARecord(this, 'WildcardA', {
      zone: props.zone,
      recordName: wildcard,
      target: recordTarget,
    })
    new route53.AaaaRecord(this, 'WildcardAaaa', {
      zone: props.zone,
      recordName: wildcard,
      target: recordTarget,
    })

    // What a PR stack reads. SSM rather than CloudFormation exports on
    // purpose: an export would make every PR stack a dependent of this one,
    // and `cdk deploy CdkCore-pr-<n> --exclusively` would stop working.
    this.parameter('distributionArn', this.distribution.distributionArn)
    this.parameter('distributionId', this.distribution.distributionId)
    this.parameter('bucketName', this.bucket.bucketName)
    this.parameter('kvsArn', this.keyValueStore.keyValueStoreArn)
  }

  private parameter(name: string, value: string): void {
    new ssm.StringParameter(this, `Param${name[0]?.toUpperCase()}${name.slice(1)}`, {
      parameterName: `${this.parameterPrefix}/${name}`,
      stringValue: value,
    })
  }
}
