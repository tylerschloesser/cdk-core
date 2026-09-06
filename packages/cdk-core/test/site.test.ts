import { App, Duration, Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { CachePolicies } from '../src/cache-policies.js'
import { Site } from '../src/site.js'

/**
 * A real directory, because `Site` refuses to synth against a missing
 * `webDist` — the single most common way to run a CDK command in this repo and
 * get a confusing error twenty seconds later. It has an `index.html` and one
 * hashed asset so the two-deployment split has something to split.
 */
const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-core-site-'))
fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>\n')
fs.mkdirSync(path.join(webDist, 'assets'))
fs.writeFileSync(path.join(webDist, 'assets', 'index-abc123.js'), 'export {}\n')

afterAll(() => {
  fs.rmSync(webDist, { recursive: true, force: true })
})

interface BuildOptions {
  /** Built inside the stack under test — a policy from another `App` cannot be referenced. */
  readonly cachePolicy?: (scope: Stack) => cloudfront.ICachePolicy
  readonly unversioned?: string[]
  readonly distributionOverrides?: Partial<cloudfront.DistributionProps>
  readonly additionalBehaviors?: Record<string, cloudfront.BehaviorOptions>
}

function build(options: BuildOptions = {}): { stack: Stack; template: Template } {
  const app = new App()
  const stack = new Stack(app, 'TestSite', {
    env: { account: '111122223333', region: 'us-east-1' },
  })
  const zone = route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
    hostedZoneId: 'Z0000000000000000000',
    zoneName: 'ty.ler.dev',
  })
  const certificate = acm.Certificate.fromCertificateArn(
    stack,
    'Cert',
    'arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-000000000000',
  )
  const apiFn = new lambda.Function(stack, 'ApiFn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'),
  })
  const eventsFn = new lambda.Function(stack, 'EventsFn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'),
  })

  new Site(stack, 'Site', {
    domain: 'cdk-core.ty.ler.dev',
    zone,
    certificate,
    webDist,
    unversioned: options.unversioned,
    distributionOverrides: options.distributionOverrides,
    additionalBehaviors: options.additionalBehaviors,
    backends: {
      api: {
        pathPattern: '/api/*',
        cachePolicy: options.cachePolicy?.(stack),
        functionUrl: apiFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }),
      },
      events: {
        pathPattern: '/events/*',
        streaming: true,
        functionUrl: eventsFn.addFunctionUrl({
          authType: lambda.FunctionUrlAuthType.AWS_IAM,
          invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
        }),
      },
    },
  })

  return { stack, template: Template.fromStack(stack) }
}

/** `cacheControl` lands in the custom resource's `SystemMetadata`, joined with ', '. */
function cacheControl(deployment: { Properties: Record<string, unknown> } | undefined): string {
  const metadata = deployment?.Properties.SystemMetadata as Record<string, string> | undefined
  return metadata?.['cache-control'] ?? ''
}

function distribution(template: Template): Record<string, unknown> {
  const resources = template.findResources('AWS::CloudFront::Distribution')
  const only = Object.values(resources)[0] as { Properties: { DistributionConfig: Record<string, unknown> } }
  return only.Properties.DistributionConfig
}

describe('Site', () => {
  it('deploys the assets and the unversioned shell as two separate BucketDeployments', () => {
    const { template } = build()
    const deployments = Object.values(
      template.findResources('Custom::CDKBucketDeployment'),
    ) as { Properties: Record<string, unknown> }[]
    expect(deployments).toHaveLength(2)

    // The hashed half: excluded globs, pruning on, a year and immutable.
    const assets = deployments.find((d) => d.Properties.Prune === true)
    expect(assets).toBeDefined()
    expect(assets?.Properties.Exclude).toContain('*.html')
    expect(cacheControl(assets)).toBe('public, max-age=31536000, immutable')
    expect(assets?.Properties.DistributionPaths).toBeUndefined()

    // The stable half: prune off — `true` here would delete every hashed asset
    // the other deployment just uploaded — no-cache, and the invalidation.
    const shell = deployments.find((d) => d.Properties.Prune === false)
    expect(shell).toBeDefined()
    expect(shell?.Properties.Exclude).toEqual(['*'])
    expect(shell?.Properties.Include).toContain('*.html')
    expect(shell?.Properties.Include).toContain('__config.json')
    expect(cacheControl(shell)).toBe('no-cache')
    expect(shell?.Properties.DistributionPaths).toEqual(['/*'])
  })

  it('grants CloudFront both lambda:InvokeFunctionUrl and lambda:InvokeFunction per backend', () => {
    const { template } = build()
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')) as {
      Properties: { Action: string }
    }[]
    const actions = permissions.map((p) => p.Properties.Action).sort()
    // Two backends x two grants. `withOriginAccessControl` contributes the
    // InvokeFunctionUrl half; the construct adds InvokeFunction, and either
    // alone is a 403 with nothing in the Lambda's logs (Epoch 2 spike).
    expect(actions).toEqual([
      'lambda:InvokeFunction',
      'lambda:InvokeFunction',
      'lambda:InvokeFunctionUrl',
      'lambda:InvokeFunctionUrl',
    ])
  })

  it('puts the SPA fallback on the default behavior only, and serves the shell rather than appending index.html', () => {
    const { template } = build()
    const config = distribution(template) as {
      DefaultCacheBehavior: { FunctionAssociations?: unknown[] }
      CacheBehaviors: { PathPattern: string; FunctionAssociations?: unknown[] }[]
    }
    expect(config.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1)
    for (const behavior of config.CacheBehaviors) {
      expect(behavior.FunctionAssociations).toBeUndefined()
    }

    const fn = Object.values(template.findResources('AWS::CloudFront::Function'))[0] as {
      Properties: { FunctionCode: string }
    }
    expect(fn.Properties.FunctionCode).toContain("request.uri = '/index.html'")
    expect(fn.Properties.FunctionCode).not.toContain("uri + '/index.html'")
  })

  it('gives every backend ALL_VIEWER_EXCEPT_HOST_HEADER, compress off, and CACHING_DISABLED by default', () => {
    const { template } = build()
    const config = distribution(template) as {
      CacheBehaviors: {
        PathPattern: string
        Compress: boolean
        CachePolicyId: string
        OriginRequestPolicyId: string
      }[]
    }
    const patterns = config.CacheBehaviors.map((b) => b.PathPattern).sort()
    expect(patterns).toEqual(['/api/*', '/events/*'])
    for (const behavior of config.CacheBehaviors) {
      expect(behavior.Compress).toBe(false)
      // The managed ids: CACHING_DISABLED and ALL_VIEWER_EXCEPT_HOST_HEADER.
      expect(behavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad')
      expect(behavior.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac')
    }
  })

  it('honors a backend cachePolicy in prod (unlike a preview, which forces caching off)', () => {
    const { template } = build({ cachePolicy: (stack) => CachePolicies.originDecides(stack) })
    const config = distribution(template) as {
      CacheBehaviors: { PathPattern: string; CachePolicyId: string }[]
    }
    const api = config.CacheBehaviors.find((b) => b.PathPattern === '/api/*')
    expect(api?.CachePolicyId).not.toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad')
  })

  it('sets the streaming backend origin read timeout to 60 s and the buffered one to 30 s', () => {
    const { template } = build()
    const config = distribution(template) as {
      Origins: { DomainName: unknown; CustomOriginConfig?: { OriginReadTimeout?: number } }[]
    }
    const timeouts = config.Origins.map((o) => o.CustomOriginConfig?.OriginReadTimeout).filter(
      (t): t is number => typeof t === 'number',
    )
    expect(timeouts.sort((a, b) => a - b)).toEqual([30, 60])
  })

  it('creates apex A and AAAA alias records', () => {
    const { template } = build()
    template.resourceCountIs('AWS::Route53::RecordSet', 2)
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'cdk-core.ty.ler.dev.',
    })
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'cdk-core.ty.ler.dev.',
    })
  })

  it('lets distributionOverrides change the price class but not the behaviors or domain names', () => {
    const { template } = build({
      distributionOverrides: {
        priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
        // Deliberately hostile: a consumer trying to replace what the
        // construct exists to get right.
        domainNames: ['evil.example.com'],
        additionalBehaviors: {},
      } as Partial<cloudfront.DistributionProps>,
    })
    const config = distribution(template) as {
      PriceClass: string
      Aliases: string[]
      CacheBehaviors: unknown[]
    }
    expect(config.PriceClass).toBe('PriceClass_All')
    expect(config.Aliases).toEqual(['cdk-core.ty.ler.dev'])
    expect(config.CacheBehaviors).toHaveLength(2)
  })

  it('keeps a consumer additionalBehavior alongside the backends', () => {
    const { template } = build({
      additionalBehaviors: {
        '/static-extra/*': {
          origin: new (class {
            bind() {
              return { originProperty: { id: 'extra', domainName: 'example.com', customOriginConfig: { originProtocolPolicy: 'https-only' } } }
            }
          })() as unknown as cloudfront.IOrigin,
        },
      },
    })
    const config = distribution(template) as { CacheBehaviors: { PathPattern: string }[] }
    expect(config.CacheBehaviors.map((b) => b.PathPattern).sort()).toEqual([
      '/api/*',
      '/events/*',
      '/static-extra/*',
    ])
  })

  it('rejects an additionalBehavior that collides with a backend path pattern', () => {
    expect(() =>
      build({ additionalBehaviors: { '/api/*': {} as cloudfront.BehaviorOptions } }),
    ).toThrow(/collides/)
  })

  it('rejects a missing webDist with the command that fixes it', () => {
    const app = new App()
    const stack = new Stack(app, 'Missing', { env: { account: '111122223333', region: 'us-east-1' } })
    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
      hostedZoneId: 'Z0000000000000000000',
      zoneName: 'ty.ler.dev',
    })
    const certificate = acm.Certificate.fromCertificateArn(
      stack,
      'Cert',
      'arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-000000000000',
    )
    const fn = new lambda.Function(stack, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    })
    expect(
      () =>
        new Site(stack, 'Site', {
          domain: 'cdk-core.ty.ler.dev',
          zone,
          certificate,
          webDist: path.join(webDist, 'does-not-exist'),
          backends: {
            api: {
              pathPattern: '/api/*',
              functionUrl: fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }),
            },
          },
        }),
    ).toThrow(/pnpm build/)
  })

  it('warns rather than silently ignoring an auth prop it does not implement yet', () => {
    const app = new App()
    const stack = new Stack(app, 'WithAuth', {
      env: { account: '111122223333', region: 'us-east-1' },
    })
    const zone = route53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', {
      hostedZoneId: 'Z0000000000000000000',
      zoneName: 'ty.ler.dev',
    })
    const certificate = acm.Certificate.fromCertificateArn(
      stack,
      'Cert',
      'arn:aws:acm:us-east-1:111122223333:certificate/00000000-0000-0000-0000-000000000000',
    )
    const fn = new lambda.Function(stack, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    })
    const site = new Site(stack, 'Site', {
      domain: 'cdk-core.ty.ler.dev',
      zone,
      certificate,
      webDist,
      auth: { idTokenValidity: Duration.hours(1) },
      backends: {
        api: {
          pathPattern: '/api/*',
          functionUrl: fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }),
        },
      },
    })
    expect(site.authEnvironment).toEqual({})
    const warnings = site.node.metadata.filter((m) => m.type === 'aws:cdk:warning')
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.data)).toContain('Epoch 4')
  })
})

describe('CachePolicies.originDecides', () => {
  it('lets the origin decide: zero default TTL, a five-minute ceiling, query strings in the key', () => {
    const app = new App()
    const stack = new Stack(app, 'Policies', {
      env: { account: '111122223333', region: 'us-east-1' },
    })
    CachePolicies.originDecides(stack)
    Template.fromStack(stack).hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        MinTTL: 0,
        DefaultTTL: 0,
        MaxTTL: 300,
        ParametersInCacheKeyAndForwardedToOrigin: {
          EnableAcceptEncodingBrotli: true,
          EnableAcceptEncodingGzip: true,
          HeadersConfig: { HeaderBehavior: 'none' },
          CookiesConfig: { CookieBehavior: 'none' },
          QueryStringsConfig: { QueryStringBehavior: 'all' },
        },
      },
    })
  })
})
