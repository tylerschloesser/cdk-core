/**
 * The reference site's CDK app.
 *
 * Stack *knowledge* — which domain, which zone, which account, how many
 * Lambdas, how they're bundled — lives here and nowhere inside
 * `@tylerschloesser/cdk-core`. The constructs only know shapes (`SiteDomain`,
 * `BackendProps`, ...); wiring them into an actual site is this app's job.
 * That split is what lets the same constructs back a different site with a
 * different `bin/app.ts`, and no changes to the package.
 *
 * `CdkCore-pr-<n>` does not take a construct reference to `CdkCorePreview` —
 * it reads everything it needs about the shared preview infrastructure
 * (distribution ARN, KVS ARN, bucket name, ...) from the SSM parameters that
 * `PreviewSite` publishes under `/cdk-core/<domain>/preview`. That is what
 * lets it be deployed with `cdk deploy CdkCore-pr-<n> --exclusively`, without
 * touching the shared stacks on every PR.
 */

import { fileURLToPath } from 'node:url'
import { App, Stack, Duration, CfnOutput } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as route53 from 'aws-cdk-lib/aws-route53'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import {
  siteCertificate,
  GithubDeployRole,
  PreviewSite,
  PreviewDeployment,
  Site,
} from '@tylerschloesser/cdk-core'

const ENV = { account: '063257577013', region: 'us-east-1' }
const DOMAIN = 'cdk-core.ty.ler.dev'
const ZONE_NAME = 'ty.ler.dev'
const ZONE_ID = 'Z038502736IM0QLQT7VFN'
const REPO = 'tylerschloesser/cdk-core'
// GitHub's numeric ids for `REPO`, from `gh api repos/<repo>`. They exist only
// to build the immutable `sub` claim the OIDC trust policy also accepts; see
// GithubDeployRole. Public information about a public repo.
const REPO_OWNER_ID = '2300885'
const REPO_ID = '1359473287'
const STACK_PREFIX = 'CdkCore'

function importZone(scope: Construct): route53.IHostedZone {
  return route53.HostedZone.fromHostedZoneAttributes(scope, 'Zone', {
    hostedZoneId: ZONE_ID,
    zoneName: ZONE_NAME,
  })
}

// ---------- CdkCoreShared ----------

class CdkCoreShared extends Stack {
  readonly certificate: acm.ICertificate

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)
    const zone = importZone(this)
    this.certificate = siteCertificate(this, 'Certificate', { domain: DOMAIN, zone })
  }
}

/**
 * The routing half of the backends contract, shared by `CdkCoreSite` and
 * `CdkCorePreview` so the two distributions cannot disagree about which path
 * belongs to which backend. A CloudFront Function cannot change which cache
 * behavior was selected, so these patterns are the contract `apps/web`'s
 * fetches and Vite's dev proxy have to match as well.
 */
const BACKEND_ROUTING = {
  api: { pathPattern: '/api/*' },
  events: { pathPattern: '/events/*', streaming: true },
} as const

// ---------- CdkCorePreview ----------

interface CdkCorePreviewProps extends StackProps {
  readonly certificate: acm.ICertificate
}

class CdkCorePreview extends Stack {
  constructor(scope: Construct, id: string, props: CdkCorePreviewProps) {
    super(scope, id, props)
    const zone = importZone(this)
    new PreviewSite(this, 'Preview', {
      domain: DOMAIN,
      zone,
      certificate: props.certificate,
      backends: BACKEND_ROUTING,
    })
  }
}

const API_ENTRY = fileURLToPath(new URL('../../apps/api/src/lambda-api.ts', import.meta.url))
const EVENTS_ENTRY = fileURLToPath(new URL('../../apps/api/src/lambda-events.ts', import.meta.url))
const WEB_DIST = fileURLToPath(new URL('../../apps/web/dist', import.meta.url))

/**
 * The two backend Lambdas, identical in a PR stack and in production — which
 * is the point: a preview that ran different code would prove nothing about
 * what `main` is going to do. `/events` is a second function rather than a
 * route on the first only because `RESPONSE_STREAM` is fixed when a function
 * URL is created and a buffered URL cannot be promoted to one.
 */
function backendFunctions(scope: Construct): {
  api: lambda.IFunctionUrl
  events: lambda.IFunctionUrl
} {
  const apiFn = new NodejsFunction(scope, 'ApiFn', {
    entry: API_ENTRY,
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'handler',
    memorySize: 512,
    timeout: Duration.seconds(30),
    bundling: {
      externalModules: ['@aws-sdk/*'],
      minify: true,
      sourceMap: false,
    },
  })
  const eventsFn = new NodejsFunction(scope, 'EventsFn', {
    entry: EVENTS_ENTRY,
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'handler',
    memorySize: 512,
    timeout: Duration.seconds(120),
    bundling: {
      externalModules: ['@aws-sdk/*'],
      minify: true,
      sourceMap: false,
    },
  })
  return {
    api: apiFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }),
    events: eventsFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    }),
  }
}

// ---------- CdkCoreSite ----------

interface CdkCoreSiteProps extends StackProps {
  readonly certificate: acm.ICertificate
}

class CdkCoreSite extends Stack {
  constructor(scope: Construct, id: string, props: CdkCoreSiteProps) {
    super(scope, id, props)
    const zone = importZone(this)
    const urls = backendFunctions(this)

    const site = new Site(this, 'Site', {
      domain: DOMAIN,
      zone,
      certificate: props.certificate,
      webDist: WEB_DIST,
      backends: {
        api: { ...BACKEND_ROUTING.api, functionUrl: urls.api },
        events: { ...BACKEND_ROUTING.events, functionUrl: urls.events },
      },
    })

    new CfnOutput(this, 'SiteUrl', { value: site.url })
  }
}

// ---------- CdkCoreGithubOidc ----------

class CdkCoreGithubOidc extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)
    new GithubDeployRole(this, 'DeployRole', {
      repo: REPO,
      roleName: 'cdk-core-github-deploy',
      stackPrefix: STACK_PREFIX,
      domain: DOMAIN,
      ownerId: REPO_OWNER_ID,
      repoId: REPO_ID,
    })
  }
}

// ---------- CdkCore-pr-<n> ----------

interface CdkCorePrProps extends StackProps {
  readonly pr: number
}

class CdkCorePr extends Stack {
  constructor(scope: Construct, id: string, props: CdkCorePrProps) {
    super(scope, id, props)
    const { pr } = props

    const urls = backendFunctions(this)

    const deployment = new PreviewDeployment(this, 'Deployment', {
      domain: DOMAIN,
      pr,
      webDist: WEB_DIST,
      backends: { api: urls.api, events: urls.events },
    })

    new CfnOutput(this, 'PreviewUrl', { value: deployment.url })
  }
}

// ---------- app ----------

const app = new App()

const shared = new CdkCoreShared(app, 'CdkCoreShared', { env: ENV })

new CdkCorePreview(app, 'CdkCorePreview', {
  env: ENV,
  certificate: shared.certificate,
})

new CdkCoreSite(app, 'CdkCoreSite', {
  env: ENV,
  certificate: shared.certificate,
})

// Deployed by hand, once, and never by a workflow: this is the stack that
// grants CI its credentials, so a workflow that deployed it would already have
// to hold them.
new CdkCoreGithubOidc(app, 'CdkCoreGithubOidc', { env: ENV })

const prContext = app.node.tryGetContext('pr')
if (prContext !== undefined) {
  const prValue = String(prContext)
  if (!/^[0-9]+$/.test(prValue)) {
    throw new Error(`invalid pr context value: ${prValue}`)
  }
  new CdkCorePr(app, `${STACK_PREFIX}-pr-${prValue}`, { env: ENV, pr: Number(prValue) })
}
