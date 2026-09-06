/**
 * `PreviewDeployment` — the per-PR half of the preview topology. One of these
 * lives in each `<Prefix>-pr-<n>` stack alongside that PR's backend Lambdas,
 * and deleting the stack is the whole teardown story: the assets, the KVS key
 * and the CloudFront invoke permissions all go with it.
 *
 * It takes **no** construct references from `PreviewSite`. Everything it needs
 * about the shared preview infrastructure comes from SSM parameters, which is
 * what keeps `cdk deploy <Prefix>-pr-<n> --exclusively` working and stops a
 * dozen open PRs from becoming a dozen dependents of one stack.
 */

import { CustomResource, Duration, Fn, Stack, Tags } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as cr from 'aws-cdk-lib/custom-resources'
import { Construct } from 'constructs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SiteConfig } from './config.js'
import { previewParameterPrefix } from './preview-site.js'
import type { AuthEnvironment } from './types.js'

/**
 * The pre-bundled custom-resource handler, shipped inside the package so a
 * consumer's PR stack needs no bundler and no `node_modules` at deploy time.
 * `dist/preview-deployment.js` sits next to `dist/handlers/`, so this resolves
 * identically from a workspace link and from an installed tarball.
 */
function handlerAssetPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'handlers',
    'preview-resources',
  )
}

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
  readonly hostname: string
  /** `https://pr-<n>.preview.<domain>` */
  readonly url: string
  /** Env to spread onto each PR backend Lambda, or `{}` when the site has no auth. */
  readonly authEnvironment: AuthEnvironment | Record<string, never>

  constructor(scope: Construct, id: string, props: PreviewDeploymentProps) {
    super(scope, id)

    if (!Number.isInteger(props.pr) || props.pr < 0) {
      throw new Error(
        `PreviewDeployment: 'pr' must be a non-negative integer, got ${String(props.pr)}`,
      )
    }
    if (Object.keys(props.backends).length === 0) {
      throw new Error('PreviewDeployment: at least one backend is required')
    }

    const pr = props.pr
    this.hostname = `pr-${pr}.preview.${props.domain}`
    this.url = `https://${this.hostname}`
    // Epoch 4 fills this in from the preview pool's SSM parameters.
    this.authEnvironment = {}

    const prefix = props.parameterPrefix ?? previewParameterPrefix(props.domain)
    const read = (name: string): string =>
      ssm.StringParameter.valueForStringParameter(this, `${prefix}/${name}`)

    const bucketName = read('bucketName')
    const distributionId = read('distributionId')
    const distributionArn = read('distributionArn')
    const kvsArn = read('kvsArn')

    const bucket = s3.Bucket.fromBucketName(this, 'PreviewBucket', bucketName)
    const distribution = cloudfront.Distribution.fromDistributionAttributes(
      this,
      'PreviewDistribution',
      { distributionId, domainName: `*.preview.${props.domain}` },
    )

    // Every resource in the stack, and the stack itself, carries the PR number
    // so the sweeper (Epoch 3) and a human reading the console can tell at a
    // glance what a stray resource belongs to.
    Tags.of(Stack.of(this)).add('cdk-core:pr', String(pr))

    // ---- assets ----------------------------------------------------------

    const config: SiteConfig = {
      site: props.domain,
      mode: 'preview',
      pr,
    }

    // One deployment, not the two that `Site` will need in Epoch 3.
    // Previews are short-lived and redeployed on every push, so the value of
    // immutable caching for hashed assets is small next to the cost of a
    // second custom-resource invocation on the critical path of every deploy
    // (A1's ≤ 3 min repeat target). Everything is revalidated instead, and the
    // invalidation below makes that correct on the first request after a push.
    new s3deploy.BucketDeployment(this, 'Assets', {
      sources: [
        s3deploy.Source.asset(props.webDist),
        s3deploy.Source.jsonData('__config.json', config),
      ],
      destinationBucket: bucket,
      destinationKeyPrefix: `pr-${pr}`,
      // Scoped to the prefix, so one PR's deploy never touches another's.
      prune: true,
      retainOnDelete: false,
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=0, must-revalidate')],
      distribution,
      distributionPaths: [`/pr-${pr}/*`],
    })

    // ---- let CloudFront invoke this PR's function URLs --------------------

    for (const [key, functionUrl] of Object.entries(props.backends)) {
      const suffix = key.charAt(0).toUpperCase() + key.slice(1)
      // Both grants are required. Measured in the Epoch 2 spike: with only
      // `lambda:InvokeFunctionUrl` CloudFront gets a 403, and with only
      // `lambda:InvokeFunction` it also gets a 403. There is no signal on the
      // Lambda side when this is wrong — it never runs.
      new lambda.CfnPermission(this, `CloudFrontInvokeUrl${suffix}`, {
        action: 'lambda:InvokeFunctionUrl',
        functionName: functionUrl.functionArn,
        principal: 'cloudfront.amazonaws.com',
        sourceArn: distributionArn,
        functionUrlAuthType: 'AWS_IAM',
      })
      new lambda.CfnPermission(this, `CloudFrontInvoke${suffix}`, {
        action: 'lambda:InvokeFunction',
        functionName: functionUrl.functionArn,
        principal: 'cloudfront.amazonaws.com',
        sourceArn: distributionArn,
      })
    }

    // ---- the KVS route ---------------------------------------------------

    const backendHosts: Record<string, string> = {}
    for (const [key, functionUrl] of Object.entries(props.backends)) {
      // 'https://abc123.lambda-url.us-east-1.on.aws/' -> 'abc123.lambda-url...'
      backendHosts[key] = Fn.select(2, Fn.split('/', functionUrl.url))
    }

    const routeValue = Stack.of(this).toJsonString({
      v: 1,
      pr,
      assets: `/pr-${pr}`,
      backends: backendHosts,
      // Changes every synth, so every deploy re-puts the key. That is on
      // purpose: a preview whose key was swept or hand-deleted heals on the
      // next push instead of staying dark until someone notices.
      deployedAt: new Date().toISOString(),
    })

    const onEvent = new lambda.Function(this, 'PreviewResourcesHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(handlerAssetPath()),
      timeout: Duration.minutes(2),
      memorySize: 256,
      description: `cdk-core preview resources for pr-${pr}`,
    })
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudfront-keyvaluestore:DescribeKeyValueStore',
          'cloudfront-keyvaluestore:UpdateKeys',
        ],
        resources: [kvsArn],
      }),
    )

    const provider = new cr.Provider(this, 'PreviewResourcesProvider', {
      onEventHandler: onEvent,
    })

    new CustomResource(this, 'KvsRoute', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CdkCoreKvsRoute',
      properties: {
        ResourceType: 'KvsRoute',
        KvsArn: kvsArn,
        Key: this.hostname,
        Value: routeValue,
      },
    })
  }
}
