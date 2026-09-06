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
import { siteCertificate, PreviewSite, PreviewDeployment } from '@tylerschloesser/cdk-core'

const ENV = { account: '063257577013', region: 'us-east-1' }
const DOMAIN = 'cdk-core.ty.ler.dev'
const ZONE_NAME = 'ty.ler.dev'
const ZONE_ID = 'Z038502736IM0QLQT7VFN'

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
      backends: {
        api: { pathPattern: '/api/*' },
        events: { pathPattern: '/events/*', streaming: true },
      },
    })
  }
}

// ---------- CdkCore-pr-<n> ----------

const API_ENTRY = fileURLToPath(new URL('../../apps/api/src/lambda-api.ts', import.meta.url))
const EVENTS_ENTRY = fileURLToPath(new URL('../../apps/api/src/lambda-events.ts', import.meta.url))
const WEB_DIST = fileURLToPath(new URL('../../apps/web/dist', import.meta.url))

interface CdkCorePrProps extends StackProps {
  readonly pr: number
}

class CdkCorePr extends Stack {
  constructor(scope: Construct, id: string, props: CdkCorePrProps) {
    super(scope, id, props)
    const { pr } = props

    const apiFn = new NodejsFunction(this, 'ApiFn', {
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
    const apiFnUrl = apiFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    })

    const eventsFn = new NodejsFunction(this, 'EventsFn', {
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
    const eventsFnUrl = eventsFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    })

    const deployment = new PreviewDeployment(this, 'Deployment', {
      domain: DOMAIN,
      pr,
      webDist: WEB_DIST,
      backends: { api: apiFnUrl, events: eventsFnUrl },
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

const prContext = app.node.tryGetContext('pr')
if (prContext !== undefined) {
  const prValue = String(prContext)
  if (!/^[0-9]+$/.test(prValue)) {
    throw new Error(`invalid pr context value: ${prValue}`)
  }
  new CdkCorePr(app, `CdkCore-pr-${prValue}`, { env: ENV, pr: Number(prValue) })
}
