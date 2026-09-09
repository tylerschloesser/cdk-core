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
 *
 * [edge-gate] When `props.auth?.gate === 'edge'`, the router's CloudFront
 * Function also carries the Google-sign-in gate (`router/gate.ts`), backed by
 * a session-signing secret shared with the edge through the KeyValueStore
 * (`KvsSecret`) and a host-blind `/auth/*` Lambda behavior that does the
 * code<->token exchange a CloudFront Function cannot do itself. Because the
 * gate is embedded in the router's *source*, the pool — and the browser
 * client id it hands out — must exist before `new cloudfront.Function(this,
 * 'Router', …)` is constructed, which is why auth setup now runs before the
 * router rather than after the whole distribution, as it used to.
 */

import { CustomResource, Duration, RemovalPolicy, SecretValue } from 'aws-cdk-lib'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as cr from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'

import { SESSION_SECRET_KVS_KEY } from './auth/session.js'
import { backendBehavior, safeDistributionOverrides } from './behaviors.js'
import { authEndpointAssetPath, previewResourcesAssetPath } from './handler-asset.js'
import { KvsSecret } from './kvs-secret.js'
import { renderRouterSource } from './router/render.js'
import type { RouterSourceProps } from './router/render.js'
import type { AuthProps, BackendProps, SiteDomain } from './types.js'
import { defaultDomainPrefix, siteUserPool } from './user-pool.js'

/**
 * The origin every backend behavior is *assigned*, and which the router
 * function overrides on every request. It has to be a syntactically valid
 * domain — CloudFront accepts this one, verified at `CreateDistribution` in the
 * spike — and it must never resolve, so that a router that somehow fails to
 * override the origin fails loudly instead of quietly reaching a real host.
 */
const PLACEHOLDER_ORIGIN_DOMAIN = 'origin-placeholder.invalid'

/** `${domain}/preview-session-secret` — read here, and again by `PreviewDeployment` when `gate` is set. */
function sessionSecretName(domain: string): string {
  return `${domain}/preview-session-secret`
}

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
  /** The browser app client. Its only callback is the bounce host (plan.md D5). */
  readonly userPoolClient?: cognito.UserPoolClient
  /** The `machine` app client — password sign-in, no hosted UI. Preview only. */
  readonly machineUserPoolClient?: cognito.UserPoolClient
  readonly machineUserSecret?: secretsmanager.ISecret
  readonly parameterPrefix: string

  constructor(scope: Construct, id: string, props: PreviewSiteProps) {
    super(scope, id)

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

    // Auth setup moves here, *before* the router function, because the
    // router's source embeds the hosted-UI domain and the browser client id
    // when `auth.gate === 'edge'` — the pool has to exist first. It does not
    // reference the distribution, only `this.parameter(...)` and its own
    // resources, so moving it earlier changes creation order only; every
    // construct id below is unchanged from before, so CloudFormation replaces
    // nothing.
    let gateBehavior: cloudfront.BehaviorOptions | undefined
    let gateLambda: lambda.Function | undefined
    let hostedUiDomain: string | undefined
    let browserClientId: string | undefined
    if (props.auth) {
      const auth = this.createAuth(props, props.auth)
      this.userPool = auth.userPool
      this.userPoolClient = auth.userPoolClient
      this.machineUserPoolClient = auth.machineUserPoolClient
      this.machineUserSecret = auth.machineUserSecret
      hostedUiDomain = auth.hostedUiDomain
      browserClientId = auth.userPoolClient.userPoolClientId
      gateBehavior = auth.gateBehavior
      gateLambda = auth.gateLambda
    }

    const gate: RouterSourceProps['gate'] =
      props.auth?.gate === 'edge'
        ? {
            hostedUiDomain: hostedUiDomain!,
            clientId: browserClientId!,
            redirectUri: `https://oauth.preview.${props.domain}/`,
            preview: true,
            ...(props.auth.ungatedPaths ? { ungatedPaths: props.auth.ungatedPaths } : {}),
          }
        : undefined

    this.routerFunction = new cloudfront.Function(this, 'Router', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: this.keyValueStore,
      code: cloudfront.FunctionCode.fromInline(
        renderRouterSource({ domain: props.domain, backends: props.backends, ...(gate ? { gate } : {}) }),
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

    if (gateBehavior) {
      // '/auth/*' is reserved by the edge gate — it must carry no function
      // association at all (see the module comment on `createAuth`'s gate
      // branch), so it cannot be built through `backendBehavior` like the
      // routes above.
      if (additionalBehaviors['/auth/*']) {
        throw new Error(
          "PreviewSite: a backend's pathPattern collides with the reserved '/auth/*' behavior used by the edge gate",
        )
      }
      additionalBehaviors['/auth/*'] = gateBehavior
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

    // `withOriginAccessControl` on the auth Lambda's function URL grants only
    // `lambda:InvokeFunctionUrl`; both grants are required (aws/aws-cdk#35872
    // — measured in `.claude/rules/cloudfront-origins.md`, either alone is a
    // 403 with nothing in the Lambda's log), and the distribution ARN this
    // needs only exists once the distribution above is constructed.
    if (gateLambda) {
      new lambda.CfnPermission(this, 'CloudFrontInvokeAuthLambda', {
        action: 'lambda:InvokeFunction',
        functionName: gateLambda.functionArn,
        principal: 'cloudfront.amazonaws.com',
        sourceArn: this.distribution.distributionArn,
      })
    }

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

  /**
   * The preview pool, and the two things that exist only here: an app client
   * that can sign in with a password, and a native user to sign in as.
   *
   * Both are what make it possible for Claude to drive a preview with no
   * browser and no Google account (plan.md D6) — and both are absent from the
   * prod pool, which is why D6 can call machine sign-in structurally
   * impossible there rather than merely disabled.
   *
   * [edge-gate] When `auth.gate === 'edge'`, this also builds: the
   * session-signing secret (`SessionSecret`), its copy into the shared
   * KeyValueStore (`KvsSecret`, reusing the `PoolUserHandler`/`PoolUserProvider`
   * pair below rather than a second Lambda — see the quota note there), and
   * the host-blind `/auth/*` Lambda + behavior the gate's redirect hands off
   * to. The behavior itself is returned rather than attached here, because
   * `additionalBehaviors` is assembled by the caller alongside the backend
   * routes.
   */
  private createAuth(
    props: PreviewSiteProps,
    auth: AuthProps,
  ): {
    userPool: cognito.UserPool
    userPoolClient: cognito.UserPoolClient
    machineUserPoolClient: cognito.UserPoolClient
    machineUserSecret: secretsmanager.Secret
    hostedUiDomain: string
    gateBehavior?: cloudfront.BehaviorOptions
    gateLambda?: lambda.Function
  } {
    const machineUserName = props.machineUserName ?? 'claude'

    const pool = siteUserPool(this, 'Auth', {
      auth,
      // '-preview' is appended to the *default*; an explicit `domainPrefix` is
      // used verbatim, because it has to equal what was typed into the Google
      // OAuth client's redirect URIs and only a human knows that.
      domainPrefix: auth.domainPrefix ?? `${defaultDomainPrefix(props.domain)}-preview`,
      userPoolName: `${props.domain} previews`,
      // One callback for every PR. Cognito allows no wildcards, so the bounce
      // host is the fixed redirect_uri and `state` carries the PR number
      // (plan.md D5); the router function turns it back into a per-PR URL.
      callbackUrls: [`https://oauth.preview.${props.domain}/`],
      logoutUrls: [`https://oauth.preview.${props.domain}/`],
    })
    // `disableOAuth` is what keeps this client off the hosted UI entirely: no
    // callback URLs, no OAuth flows, nothing for a browser to start. It exists
    // for exactly one caller, `initiate-auth --auth-flow USER_PASSWORD_AUTH`.
    const machineUserPoolClient = new cognito.UserPoolClient(this, 'MachineClient', {
      userPool: pool.userPool,
      userPoolClientName: 'machine',
      generateSecret: false,
      disableOAuth: true,
      authFlows: { userPassword: true },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    })

    // The password is generated by Secrets Manager and read by the custom
    // resource at *runtime*: it never appears in the template, the change set,
    // or a CloudFormation event. Everything else in the JSON is what a caller
    // needs to turn it into a token, so `preview-login.sh` and the Playwright
    // fixture read one secret and nothing else.
    const machineUserSecret = new secretsmanager.Secret(this, 'MachineUser', {
      secretName: `${props.domain}/preview-machine-user`,
      description: `cdk-core preview machine user for ${props.domain}`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: machineUserName,
          userPoolId: pool.userPool.userPoolId,
          clientId: machineUserPoolClient.userPoolClientId,
        }),
        generateStringKey: 'password',
        // The pool's password policy requires no symbols precisely so this can
        // exclude punctuation: a generated password that the policy rejects
        // fails at `AdminSetUserPassword`, i.e. inside a custom resource, i.e.
        // as a stack rollback rather than a readable error.
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const onEvent = new lambda.Function(this, 'PoolUserHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(previewResourcesAssetPath()),
      timeout: Duration.minutes(2),
      memorySize: 256,
      description: `cdk-core preview machine user for ${props.domain}`,
    })
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminGetUser',
        ],
        resources: [pool.userPool.userPoolArn],
      }),
    )
    machineUserSecret.grantRead(onEvent)

    const provider = new cr.Provider(this, 'PoolUserProvider', { onEventHandler: onEvent })

    new CustomResource(this, 'MachineUserResource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CdkCorePoolUser',
      properties: {
        ResourceType: 'PoolUser',
        UserPoolId: pool.userPool.userPoolId,
        Username: machineUserName,
        // `/api/me` identifies a caller by email, so the machine user needs
        // one; it is not a deliverable address and nothing is ever sent to it
        // (AdminCreateUser runs with MessageAction: SUPPRESS).
        Email: `${machineUserName}@${props.domain}`,
        SecretArn: machineUserSecret.secretArn,
        PasswordKey: 'password',
      },
    })

    // What a PR stack and the e2e fixture read. `authDomain` is here because
    // the hosted-UI host cannot be derived from the issuer, and the browser
    // needs it to build both the authorize and the token URL.
    this.parameter('authIssuer', pool.issuer)
    this.parameter('authClientId', pool.userPoolClient.userPoolClientId)
    // Published separately from `authClientId` because the two are read for
    // different things: the browser puts `authClientId` in its authorize URL,
    // while the API must accept `aud` from *either* client (see
    // `AuthEnvironment.AUTH_CLIENT_ID`).
    this.parameter('authMachineClientId', machineUserPoolClient.userPoolClientId)
    this.parameter('authDomain', pool.authConfig.domain)
    this.parameter('machineSecretArn', machineUserSecret.secretArn)

    let gateBehavior: cloudfront.BehaviorOptions | undefined
    let gateLambda: lambda.Function | undefined
    if (auth.gate === 'edge') {
      // The whole safety property of the gate rests on the edge and the
      // origin agreeing on this secret; a CloudFront Function has no
      // environment variables, so it lives in Secrets Manager and is copied
      // into the KeyValueStore for the edge half to `kvs.get()`.
      const secretName = sessionSecretName(props.domain)
      const sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
        secretName,
        generateSecretString: {
          secretStringTemplate: '{}',
          generateStringKey: 'secret',
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.DESTROY,
      })

      // Reuses the `PoolUserHandler`/`PoolUserProvider` pair above rather than
      // a second Lambda and `cr.Provider` — the quota is one KeyValueStore
      // *per function*, and the router already spends its one on routing, so
      // the secret has to share the routing store; that is forced, not
      // chosen. Consequence: `src/github-deploy-role.ts` already grants
      // `cloudfront-keyvaluestore:ListKeys` on this store to the GitHub
      // Actions role, and `ListKeys` returns values, so the preview signing
      // key is readable by CI. Accepted because a preview key forges only
      // preview sessions — prod's is a different secret in a different store.
      new KvsSecret(this, 'SessionSecretKvs', {
        keyValueStore: this.keyValueStore,
        secret: sessionSecret,
        secretKey: 'secret',
        kvsKey: SESSION_SECRET_KVS_KEY,
        onEventHandler: onEvent,
        serviceToken: provider.serviceToken,
      })

      // The Lambda behind `/auth/*` — one for every PR, shared. It is
      // host-blind (`ALL_VIEWER_EXCEPT_HOST_HEADER` strips `Host` on the
      // behavior below) and must stay that way: nothing here may pass it a
      // hostname, or a redirect meant for one PR could land on another.
      gateLambda = new lambda.Function(this, 'AuthLambda', {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(authEndpointAssetPath()),
        timeout: Duration.seconds(10),
        memorySize: 256,
        description: `cdk-core preview auth endpoint for ${props.domain}`,
        environment: {
          AUTH_ISSUER: pool.issuer,
          // Both client ids, comma-separated, exactly like
          // `PreviewDeployment.authEnvironment` — `aud` is the client that
          // minted the token, not the pool.
          AUTH_CLIENT_ID: `${pool.userPoolClient.userPoolClientId},${machineUserPoolClient.userPoolClientId}`,
          AUTH_EDGE_CLIENT_ID: pool.userPoolClient.userPoolClientId,
          AUTH_HOSTED_UI_DOMAIN: pool.authConfig.domain,
          AUTH_REDIRECT_URI: `https://oauth.preview.${props.domain}/`,
          // Built from the secret's *literal name*, not its ARN: a dynamic
          // reference has to be a literal string in the template and cannot
          // contain a CloudFormation token (.claude/rules/auth.md item 3, same
          // reasoning for the Google client secret).
          AUTH_SESSION_SECRET: SecretValue.secretsManager(secretName, {
            jsonField: 'secret',
          }).unsafeUnwrap(),
        },
      })
      // A dynamic reference creates no implicit ordering; the secret must
      // exist before this function's template resolves it.
      gateLambda.node.addDependency(sessionSecret)

      const authFunctionUrl = gateLambda.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.AWS_IAM,
      })

      gateBehavior = {
        origin: origins.FunctionUrlOrigin.withOriginAccessControl(authFunctionUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        // The whole safety property, not a preference: a cached `Set-Cookie`
        // hands one visitor's session to the next.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Must exclude `host` and only `host` — same reasoning as
        // `behaviors.ts`: the deny list applies to the outbound headers, which
        // by then include the `Authorization` header OAC just added.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: false,
        // Deliberately no `functionAssociations`: the router must never run on
        // this path, or `/auth/callback` (no extension) gets rewritten to
        // `<pr's assets>/index.html` by the SPA-fallback rule and sent to the
        // auth Lambda origin instead of served.
      }
    }

    return {
      userPool: pool.userPool,
      userPoolClient: pool.userPoolClient,
      machineUserPoolClient,
      machineUserSecret,
      hostedUiDomain: pool.authConfig.domain,
      ...(gateBehavior ? { gateBehavior } : {}),
      ...(gateLambda ? { gateLambda } : {}),
    }
  }

  private parameter(name: string, value: string): void {
    new ssm.StringParameter(this, `Param${name[0]?.toUpperCase()}${name.slice(1)}`, {
      parameterName: `${this.parameterPrefix}/${name}`,
      stringValue: value,
    })
  }
}
