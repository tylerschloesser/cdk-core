/**
 * `Site` — the production half. One bucket, one distribution, the apex DNS
 * records, and (from Epoch 4) the prod user pool.
 *
 * It is deliberately the *smaller* of the two site constructs. `PreviewSite`
 * has to route by hostname because one distribution serves every open PR;
 * prod serves one thing, so its backends are ordinary origins and its SPA
 * fallback is five lines. What the two share — the backend behavior shape and
 * the extensionless-path rule — they share as code (`behaviors.ts`,
 * `router/spa.ts`), not as a convention.
 *
 * The one thing prod does that a preview deliberately does not is split the
 * upload in two: hashed assets go up `immutable` with a year's max-age and are
 * pruned, and the unversioned files — the HTML shell, `__config.json`, a
 * service worker if there is one — go up `no-cache` and invalidate the
 * distribution. A preview skips this (see plan.md, Epoch 2 deviation 7): it is
 * redeployed on every push and never lives long enough to collect the caching
 * win, while the second custom-resource invocation sits on the critical path
 * of every one of those pushes. Prod is the opposite trade on both counts.
 */

import { Annotations, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import type * as cognito from 'aws-cdk-lib/aws-cognito'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import { Construct } from 'constructs'
import * as fs from 'node:fs'

import { backendReadTimeoutSeconds } from './backend.js'
import { backendBehavior, safeDistributionOverrides } from './behaviors.js'
import type { SiteConfig } from './config.js'
import { renderSpaSource } from './router/spa.js'
import type { AuthEnvironment, AuthProps, BackendProps, SiteDomain } from './types.js'

/**
 * Files whose names are stable across builds and so must never be cached hard.
 * `__config.json` is on the list because it is the whole point of D11: the
 * bundle is byte-identical everywhere and learns its environment at runtime,
 * which only works if the environment description is not cached for a year.
 */
const DEFAULT_UNVERSIONED = [
  '*.html',
  'sw.js',
  'manifest.webmanifest',
  'registerSW.js',
  '__config.json',
]

export interface SiteProps extends SiteDomain {
  readonly certificate: acm.ICertificate
  /** Absolute path to the built SPA (e.g. apps/web/dist). Throws at synth if missing. */
  readonly webDist: string
  /** Backends keyed by a short id ('api', 'events'). Keys must match PreviewSite/PreviewDeployment. */
  readonly backends: Record<string, BackendProps & { readonly functionUrl: lambda.IFunctionUrl }>
  /** Omit for a public site with no user pool. */
  readonly auth?: AuthProps
  /** File globs that must never be cached hard. Defaults to `DEFAULT_UNVERSIONED`. */
  readonly unversioned?: string[]
  /** Escape hatch merged into DistributionProps (priceClass, httpVersion, webAclId, logging, ...). Cannot replace behaviors, domain names or the certificate. */
  readonly distributionOverrides?: Partial<cloudfront.DistributionProps>
  /** Extra behaviors the consumer owns entirely. Must not collide with `backends`. */
  readonly additionalBehaviors?: Record<string, cloudfront.BehaviorOptions>
}

export class Site extends Construct {
  readonly distribution: cloudfront.Distribution
  readonly bucket: s3.Bucket
  /** `https://<domain>` */
  readonly url: string
  readonly userPool?: cognito.UserPool
  readonly userPoolClient?: cognito.UserPoolClient
  /** Env to spread onto each backend Lambda; `{}` when `auth` is omitted. */
  readonly authEnvironment: AuthEnvironment | Record<string, never>

  constructor(scope: Construct, id: string, props: SiteProps) {
    super(scope, id)

    if (props.auth) {
      Annotations.of(this).addWarningV2(
        '@tylerschloesser/cdk-core:siteAuthNotImplemented',
        'Site: `auth` is accepted but ignored until Epoch 4. No user pool or app client is ' +
          'created, and backends run with AUTH unset (= none).',
      )
    }
    // Epoch 4 fills this in from the prod pool.
    this.authEnvironment = {}

    if (Object.keys(props.backends).length === 0) {
      throw new Error('Site: at least one backend is required')
    }
    // A missing dist is the single most common way to run a CDK command in
    // this repo and get a confusing error twenty seconds later, so it is
    // caught here with the instruction that fixes it. `pnpm build` must run
    // before any synth, deploy or destroy.
    if (!fs.existsSync(props.webDist)) {
      throw new Error(
        `Site: webDist does not exist: ${props.webDist}. Run \`pnpm build\` before any cdk command.`,
      )
    }

    this.url = `https://${props.domain}`

    // The bucket holds build output and nothing else — every byte in it is
    // reproducible from a deploy — so it is destroyable, and `cdk destroy` on
    // this stack leaves nothing for the next one to collide with.
    this.bucket = new s3.Bucket(this, 'Assets', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    const spaFallback = new cloudfront.Function(this, 'SpaFallback', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(renderSpaSource()),
      comment: `cdk-core SPA fallback for ${props.domain}`,
    })

    // ---- behaviors -------------------------------------------------------

    const backendBehaviors: Record<string, cloudfront.BehaviorOptions> = {}
    for (const [key, backend] of Object.entries(props.backends)) {
      if (backendBehaviors[backend.pathPattern]) {
        throw new Error(
          `Site: two backends share the path pattern ${JSON.stringify(backend.pathPattern)}`,
        )
      }
      backendBehaviors[backend.pathPattern] = backendBehavior(backend, {
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(backend.functionUrl, {
          readTimeout: Duration.seconds(backendReadTimeoutSeconds(key, backend)),
        }),
      })
    }

    for (const pattern of Object.keys(props.additionalBehaviors ?? {})) {
      if (backendBehaviors[pattern]) {
        throw new Error(
          `Site: additionalBehaviors[${JSON.stringify(pattern)}] collides with a backend's pathPattern`,
        )
      }
    }

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `cdk-core site ${props.domain}`,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      ...safeDistributionOverrides(props.distributionOverrides),
      certificate: props.certificate,
      domainNames: [props.domain],
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [
          { function: spaFallback, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: { ...props.additionalBehaviors, ...backendBehaviors },
    })

    // `FunctionUrlOrigin.withOriginAccessControl` grants only
    // `lambda:InvokeFunctionUrl`, and both grants are required — measured in
    // the Epoch 2 spike in each direction: either alone is a 403, and nothing
    // appears in the Lambda's logs because it is never invoked
    // (aws/aws-cdk#35872).
    const distributionArn = `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${this.distribution.distributionId}`
    for (const [key, backend] of Object.entries(props.backends)) {
      const suffix = key.charAt(0).toUpperCase() + key.slice(1)
      new lambda.CfnPermission(this, `CloudFrontInvoke${suffix}`, {
        action: 'lambda:InvokeFunction',
        functionName: backend.functionUrl.functionArn,
        principal: 'cloudfront.amazonaws.com',
        sourceArn: distributionArn,
      })
    }

    // ---- assets ----------------------------------------------------------

    const config: SiteConfig = { site: props.domain, mode: 'prod' }
    const unversioned = props.unversioned ?? DEFAULT_UNVERSIONED
    const source = s3deploy.Source.asset(props.webDist)

    // Hashed filenames, so a year and `immutable`. `prune` is safe here
    // because the sync's exclude list keeps it away from the unversioned files
    // the second deployment owns.
    const assets = new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [source],
      destinationBucket: this.bucket,
      exclude: unversioned,
      prune: true,
      retainOnDelete: false,
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(Duration.days(365)),
        s3deploy.CacheControl.immutable(),
      ],
    })

    // Stable filenames, so `no-cache` and an invalidation. `prune: false` is
    // not optional: `true` would delete every hashed asset the deployment
    // above just uploaded, because this one only *includes* the unversioned
    // globs.
    const shell = new s3deploy.BucketDeployment(this, 'DeployUnversioned', {
      sources: [source, s3deploy.Source.jsonData('__config.json', config)],
      destinationBucket: this.bucket,
      exclude: ['*'],
      include: unversioned,
      prune: false,
      retainOnDelete: false,
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution: this.distribution,
      distributionPaths: ['/*'],
    })
    // Ordering, not a data dependency: the shell must not become fetchable
    // before the assets it references exist.
    shell.node.addDependency(assets)

    // ---- DNS -------------------------------------------------------------

    const recordTarget = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(this.distribution),
    )
    new route53.ARecord(this, 'ApexA', {
      zone: props.zone,
      recordName: props.domain,
      target: recordTarget,
    })
    new route53.AaaaRecord(this, 'ApexAaaa', {
      zone: props.zone,
      recordName: props.domain,
      target: recordTarget,
    })
  }
}
