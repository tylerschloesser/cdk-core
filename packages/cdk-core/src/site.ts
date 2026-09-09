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

import { Duration, RemovalPolicy, SecretValue, Stack } from 'aws-cdk-lib'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import type * as cognito from 'aws-cdk-lib/aws-cognito'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as cr from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'
import * as fs from 'node:fs'

import { SESSION_SECRET_KVS_KEY } from './auth/session.js'
import { backendReadTimeoutSeconds } from './backend.js'
import { backendBehavior, safeDistributionOverrides } from './behaviors.js'
import type { SiteAuthConfig, SiteConfig } from './config.js'
import { authEndpointAssetPath, previewResourcesAssetPath } from './handler-asset.js'
import { KvsSecret } from './kvs-secret.js'
import type { GateSourceProps } from './router/gate.js'
import { renderSpaSource } from './router/spa.js'
import type { AuthEnvironment, AuthProps, BackendProps, SiteDomain } from './types.js'
import { defaultDomainPrefix, siteUserPool } from './user-pool.js'

/**
 * The `{{resolve:secretsmanager:…}}` dynamic reference for the gate's session
 * secret, built from its *literal* name rather than its ARN: a dynamic
 * reference must be a literal string in the template, so it cannot contain a
 * CloudFormation token (`secret.secretArn` is one). `.claude/rules/auth.md`
 * item 3 records the same mechanism for the Google client secret. Every
 * resource that embeds this string must also take an explicit
 * `node.addDependency` on the secret construct, because a dynamic reference
 * creates no implicit ordering.
 */
function sessionSecretDynamicRef(domain: string): string {
  return SecretValue.secretsManager(`${domain}/session-secret`, { jsonField: 'secret' }).unsafeUnwrap()
}

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
  /**
   * Present only when `auth.gate === 'edge'`. The HMAC secret the edge gate
   * signs and verifies the session cookie with. `defineSiteStacks` adds this
   * as a dependency on the consumer's backend Lambdas, since they read the
   * same value out of `authEnvironment.AUTH_SESSION_SECRET` via a dynamic
   * reference that creates no implicit ordering of its own.
   */
  readonly sessionSecret?: secretsmanager.Secret
  /** Env to spread onto each backend Lambda; `{}` when `auth` is omitted. */
  readonly authEnvironment: AuthEnvironment | Record<string, never>

  constructor(scope: Construct, id: string, props: SiteProps) {
    super(scope, id)

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

    // ---- the prod user pool ----------------------------------------------
    //
    // What makes this pool safe is as much what it does *not* have as what it
    // does: no native users, and an app client whose only auth flow is
    // refresh. D6 calls machine sign-in "structurally impossible" here, and
    // that is the shape of the claim — there is no flag to flip, because the
    // password flow is not merely disabled, it is absent from
    // `ExplicitAuthFlows`.
    let authConfig: SiteAuthConfig | undefined
    let issuer: string | undefined
    let clientId: string | undefined
    let hostedUiDomain: string | undefined
    if (props.auth) {
      const pool = siteUserPool(this, 'Auth', {
        auth: props.auth,
        domainPrefix: props.auth.domainPrefix ?? defaultDomainPrefix(props.domain),
        userPoolName: props.domain,
        callbackUrls: [`https://${props.domain}/auth/callback`],
        logoutUrls: [`https://${props.domain}/`],
      })
      this.userPool = pool.userPool
      this.userPoolClient = pool.userPoolClient
      authConfig = pool.authConfig
      issuer = pool.issuer
      clientId = pool.userPoolClient.userPoolClientId
      hostedUiDomain = pool.authConfig.domain
    }

    const gated = props.auth?.gate === 'edge'

    // ---- the edge gate's session secret and KeyValueStore -----------------
    //
    // Everything in this block exists only when `gate === 'edge'`: a site
    // with no auth, or with auth but no gate, must synthesize exactly as it
    // did before this feature existed.
    let gateStore: cloudfront.KeyValueStore | undefined
    if (gated) {
      // `RemovalPolicy.DESTROY` here has a trap that matches `PreviewSite`'s
      // `MachineUser` secret: Secrets Manager deletes with a recovery window
      // by default, so a `destroy` followed by a re-`deploy` of the same site
      // fails on "already scheduled for deletion" until the window elapses.
      this.sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
        secretName: `${props.domain}/session-secret`,
        description: `cdk-core edge-gate session secret for ${props.domain}`,
        generateSecretString: {
          secretStringTemplate: '{}',
          generateStringKey: 'secret',
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.DESTROY,
      })

      // Prod gets its own, secret-only store — never reused with anything
      // else. `ListKeys` returns values as well as key names and there is no
      // per-key IAM, so a store holding the signing key must never be
      // granted `ListKeys` to anything (`src/github-deploy-role.ts` grants it
      // on the *preview* store, which is why prod's key lives somewhere else
      // entirely).
      gateStore = new cloudfront.KeyValueStore(this, 'GateStore', {
        keyValueStoreName: `${props.domain.replace(/\./g, '-')}-gate`,
      })

      const kvsSecretHandler = new lambda.Function(this, 'KvsSecretHandler', {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(previewResourcesAssetPath()),
        timeout: Duration.minutes(2),
        memorySize: 256,
        description: `cdk-core edge-gate secret copy for ${props.domain}`,
      })
      const kvsSecretProvider = new cr.Provider(this, 'KvsSecretProvider', {
        onEventHandler: kvsSecretHandler,
      })

      new KvsSecret(this, 'GateStoreSecret', {
        keyValueStore: gateStore,
        secret: this.sessionSecret,
        secretKey: 'secret',
        kvsKey: SESSION_SECRET_KVS_KEY,
        onEventHandler: kvsSecretHandler,
        serviceToken: kvsSecretProvider.serviceToken,
      })
    }

    if (props.auth) {
      this.authEnvironment = {
        AUTH: 'cognito',
        AUTH_ISSUER: issuer!,
        AUTH_CLIENT_ID: clientId!,
        ...(gated ? { AUTH_SESSION_SECRET: sessionSecretDynamicRef(props.domain) } : {}),
      }
    } else {
      this.authEnvironment = {}
    }

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

    // With no gate, `renderSpaSource()` is called with no arguments at all —
    // byte-identical to the pre-gate output — because the ungated function is
    // associated on the default behavior only and never runs against a
    // backend path, so it needs no backend guards either.
    const gateProps: GateSourceProps | undefined = gated
      ? {
          hostedUiDomain: hostedUiDomain!,
          clientId: clientId!,
          redirectUri: `https://${props.domain}/auth/callback`,
          ...(props.auth?.ungatedPaths ? { ungatedPaths: props.auth.ungatedPaths } : {}),
        }
      : undefined

    const spaFallback = new cloudfront.Function(this, 'SpaFallback', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: gateStore,
      code: cloudfront.FunctionCode.fromInline(
        gateProps ? renderSpaSource({ backends: props.backends, gate: gateProps }) : renderSpaSource(),
      ),
      comment: `cdk-core SPA fallback for ${props.domain}`,
    })

    // ---- the /auth/* Lambda -------------------------------------------
    //
    // The code<->token exchange the CloudFront Function gate cannot do
    // itself (a CloudFront Function has no network access). Only built when
    // gated: an ungated site has no `/auth/*` behavior at all.
    let authLambda: lambda.Function | undefined
    let authBehavior: cloudfront.BehaviorOptions | undefined
    if (gated) {
      authLambda = new lambda.Function(this, 'AuthEndpoint', {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(authEndpointAssetPath()),
        timeout: Duration.seconds(10),
        memorySize: 256,
        description: `cdk-core auth endpoint for ${props.domain}`,
        environment: {
          AUTH_ISSUER: issuer!,
          AUTH_CLIENT_ID: clientId!,
          AUTH_EDGE_CLIENT_ID: clientId!,
          AUTH_HOSTED_UI_DOMAIN: hostedUiDomain!,
          AUTH_REDIRECT_URI: `https://${props.domain}/auth/callback`,
          AUTH_SESSION_SECRET: sessionSecretDynamicRef(props.domain),
        },
      })
      // A dynamic reference creates no implicit ordering of its own.
      authLambda.node.addDependency(this.sessionSecret!)

      const authFunctionUrl = authLambda.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.AWS_IAM,
      })

      authBehavior = {
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(authFunctionUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        // Not a preference — the whole safety property. A cached
        // `Set-Cookie` hands one visitor's session to the next.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: false,
        // No functionAssociations: the gate's own contract exempts `/auth/*`
        // (see `gate.ts`), so the function must not run here at all.
      }
    }

    // ---- behaviors -------------------------------------------------------

    // The gate must run on every behavior except `/auth/*`, or `/api/*` and
    // `/events/*` would be left open to anyone — see the module comment in
    // `router/spa.ts`. One function association, shared with the default
    // behavior's.
    const gateFunctionAssociations: cloudfront.FunctionAssociation[] | undefined = gated
      ? [{ function: spaFallback, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }]
      : undefined

    const backendBehaviors: Record<string, cloudfront.BehaviorOptions> = {}
    for (const [key, backend] of Object.entries(props.backends)) {
      if (backendBehaviors[backend.pathPattern]) {
        throw new Error(
          `Site: two backends share the path pattern ${JSON.stringify(backend.pathPattern)}`,
        )
      }
      if (gated && backend.pathPattern === '/auth/*') {
        throw new Error(
          `Site: backend '${key}' must not use the reserved path pattern '/auth/*' — it is the edge gate's auth endpoint`,
        )
      }
      // Resolve a cachePolicy factory once per backend, with `this` (the
      // `Site` construct) as scope. Two backends sharing one factory would
      // collide on the default construct id, so a consumer passing a factory
      // to two backends must give it distinct ids itself.
      const resolvedCachePolicy =
        typeof backend.cachePolicy === 'function' ? backend.cachePolicy(this) : backend.cachePolicy
      backendBehaviors[backend.pathPattern] = backendBehavior(
        { ...backend, cachePolicy: resolvedCachePolicy },
        {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(backend.functionUrl, {
            readTimeout: Duration.seconds(backendReadTimeoutSeconds(key, backend)),
          }),
          functionAssociations: gateFunctionAssociations,
        },
      )
    }

    for (const pattern of Object.keys(props.additionalBehaviors ?? {})) {
      if (backendBehaviors[pattern]) {
        throw new Error(
          `Site: additionalBehaviors[${JSON.stringify(pattern)}] collides with a backend's pathPattern`,
        )
      }
      if (gated && pattern === '/auth/*') {
        throw new Error(
          `Site: additionalBehaviors['/auth/*'] collides with the edge gate's auth endpoint`,
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
      additionalBehaviors: {
        ...props.additionalBehaviors,
        ...backendBehaviors,
        ...(authBehavior ? { '/auth/*': authBehavior } : {}),
      },
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
    if (authLambda) {
      new lambda.CfnPermission(this, 'CloudFrontInvokeAuth', {
        action: 'lambda:InvokeFunction',
        functionName: authLambda.functionArn,
        principal: 'cloudfront.amazonaws.com',
        sourceArn: distributionArn,
      })
    }

    // ---- assets ----------------------------------------------------------

    const config: SiteConfig = { site: props.domain, mode: 'prod', auth: authConfig }
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
