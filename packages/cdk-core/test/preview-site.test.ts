/**
 * `PreviewSite`'s auth half. The distribution, router and KVS are covered by
 * `router.test.ts` and by four live preview deploys; what is new in Epoch 4 —
 * and what has no equivalent anywhere else — is a pool that *can* be signed
 * into with a password. These tests exist to pin the two halves of D6's claim:
 * the machine path is present here, and (`site.test.ts`) absent from prod.
 */

import { App, Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as route53 from 'aws-cdk-lib/aws-route53'
import { describe, expect, it } from 'vitest'

import { PreviewSite } from '../src/preview-site.js'

const DOMAIN = 'cdk-core.ty.ler.dev'

/**
 * Memoised per `auth`/`gate` combination. Synthesizing this stack stages
 * CDK's provider-framework asset, which is the slowest thing in the whole
 * vitest suite; the tests below only read the template, so one synth serves
 * each combination.
 */
const built = new Map<string, { site: PreviewSite; template: Template }>()

function build(auth: boolean, gate = false): { site: PreviewSite; template: Template } {
  const key = `${auth}:${gate}`
  const cached = built.get(key)
  if (cached) return cached
  const result = synth(auth, gate)
  built.set(key, result)
  return result
}

function synth(auth: boolean, gate: boolean): { site: PreviewSite; template: Template } {
  const app = new App()
  const stack = new Stack(app, 'Preview', {
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
  const site = new PreviewSite(stack, 'Preview', {
    domain: DOMAIN,
    zone,
    certificate,
    backends: {
      api: { pathPattern: '/api/*' },
      events: { pathPattern: '/events/*', streaming: true },
    },
    ...(auth
      ? { auth: { domainPrefix: 'cdk-core-preview', ...(gate ? { gate: 'edge' as const } : {}) } }
      : {}),
  })
  return { site, template: Template.fromStack(stack) }
}

function clientsByName(template: Template): Record<string, Record<string, unknown>> {
  const found: Record<string, Record<string, unknown>> = {}
  for (const resource of Object.values(
    template.findResources('AWS::Cognito::UserPoolClient'),
  ) as { Properties: Record<string, unknown> }[]) {
    found[resource.Properties.ClientName as string] = resource.Properties
  }
  return found
}

describe('PreviewSite auth', () => {
  it('gives the browser client one callback — the bounce host, not a PR hostname', () => {
    const { template } = build(true)
    // Cognito callbacks are exact-match with no wildcards, which is the entire
    // reason D5's bounce exists: one fixed URL serves every open PR, and the
    // router function turns `state`'s digits back into `pr-<n>.preview.<site>`.
    expect(clientsByName(template).browser).toMatchObject({
      CallbackURLs: ['https://oauth.preview.cdk-core.ty.ler.dev/'],
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      SupportedIdentityProviders: ['Google'],
    })
  })

  it('gives the machine client a password flow and no hosted UI at all', () => {
    const { template } = build(true)
    const machine = clientsByName(template).machine
    expect(machine).toMatchObject({
      ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      SupportedIdentityProviders: ['COGNITO'],
      GenerateSecret: false,
    })
    // `disableOAuth` — nothing for a browser to start. This client exists for
    // `initiate-auth --auth-flow USER_PASSWORD_AUTH` and nothing else.
    expect(machine?.AllowedOAuthFlows).toBeUndefined()
    expect(machine?.CallbackURLs).toBeUndefined()
    expect(machine?.AllowedOAuthFlowsUserPoolClient).toBe(false)
  })

  it('generates the machine password into Secrets Manager, never into the template', () => {
    const { template } = build(true)
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${DOMAIN}/preview-machine-user`,
      GenerateSecretString: {
        GenerateStringKey: 'password',
        ExcludePunctuation: true,
        PasswordLength: 32,
      },
    })
    // The custom resource is told where the password lives, not what it is.
    const resources = Object.values(
      template.findResources('Custom::CdkCorePoolUser'),
    ) as { Properties: Record<string, unknown> }[]
    expect(resources).toHaveLength(1)
    expect(resources[0]?.Properties).toMatchObject({
      ResourceType: 'PoolUser',
      Username: 'claude',
      Email: `claude@${DOMAIN}`,
      PasswordKey: 'password',
    })
    // The password itself is never a property of anything: the resource is
    // told where to read it, and reads it at runtime.
    expect(resources[0]?.Properties).not.toHaveProperty('Password')
    const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret')) as {
      Properties: { GenerateSecretString: { SecretStringTemplate: unknown } }
    }[]
    expect(JSON.stringify(secrets[0]?.Properties.GenerateSecretString.SecretStringTemplate)).not.toContain(
      'password',
    )
  })

  it('publishes the five auth parameters a PR stack and the e2e fixture read', () => {
    const { template } = build(true)
    const names = (
      Object.values(template.findResources('AWS::SSM::Parameter')) as {
        Properties: { Name: string }
      }[]
    ).map((p) => p.Properties.Name)
    expect(names).toEqual(
      expect.arrayContaining([
        `/cdk-core/${DOMAIN}/preview/authIssuer`,
        `/cdk-core/${DOMAIN}/preview/authClientId`,
        // Not derivable from the issuer, and the browser needs it for both the
        // authorize redirect and the token exchange.
        `/cdk-core/${DOMAIN}/preview/authDomain`,
        // Separate from `authClientId`: the browser authorizes with one client
        // and the machine user signs in through the other, so the API has to
        // accept `aud` from either.
        `/cdk-core/${DOMAIN}/preview/authMachineClientId`,
        `/cdk-core/${DOMAIN}/preview/machineSecretArn`,
      ]),
    )
  })

  it('builds no pool, no machine user and no secret when `auth` is omitted', () => {
    const { site, template } = build(false)
    template.resourceCountIs('AWS::Cognito::UserPool', 0)
    template.resourceCountIs('AWS::SecretsManager::Secret', 0)
    template.resourceCountIs('Custom::CdkCorePoolUser', 0)
    expect(site.userPool).toBeUndefined()
    expect(site.machineUserSecret).toBeUndefined()
  })
})

function distributionConfig(template: Template): Record<string, unknown> {
  const dist = Object.values(
    template.findResources('AWS::CloudFront::Distribution'),
  )[0] as { Properties: { DistributionConfig: Record<string, unknown> } }
  return dist.Properties.DistributionConfig
}

function findBehavior(
  config: Record<string, unknown>,
  pathPattern: string,
): Record<string, unknown> | undefined {
  const behaviors = config.CacheBehaviors as { PathPattern: string }[] | undefined
  return behaviors?.find((b) => b.PathPattern === pathPattern)
}

function authLambdaEnvironment(template: Template): Record<string, unknown> {
  const fns = Object.values(template.findResources('AWS::Lambda::Function')) as {
    Properties: { Environment?: { Variables: Record<string, unknown> }; Description?: string }
  }[]
  const match = fns.find((fn) => fn.Properties.Description?.includes('preview auth endpoint'))
  if (!match) throw new Error('no auth endpoint Lambda found')
  return match.Properties.Environment!.Variables
}

describe('PreviewSite edge gate', () => {
  it("adds a /auth/* behavior with caching disabled — the whole safety property, not a preference", () => {
    const { template } = build(true, true)
    const behavior = findBehavior(distributionConfig(template), '/auth/*')
    expect(behavior).toBeDefined()
    expect(behavior?.CachePolicyId).toBe(cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId)
  })

  it('gives /auth/* no FunctionAssociations, so the router can never mangle /auth/callback', () => {
    const { template } = build(true, true)
    const behavior = findBehavior(distributionConfig(template), '/auth/*')
    expect(behavior).not.toHaveProperty('FunctionAssociations')
  })

  it('leaves the default behavior and every backend behavior with exactly one viewer-request association', () => {
    const { template } = build(true, true)
    const config = distributionConfig(template)
    const behaviors = [
      config.DefaultCacheBehavior as Record<string, unknown>,
      findBehavior(config, '/api/*')!,
      findBehavior(config, '/events/*')!,
    ]
    for (const behavior of behaviors) {
      expect(behavior.FunctionAssociations).toHaveLength(1)
      expect((behavior.FunctionAssociations as { EventType: string }[])[0]?.EventType).toBe(
        'viewer-request',
      )
    }
  })

  it('is still one CloudFront Function — the gate is spliced into the router, not added beside it', () => {
    const { template } = build(true, true)
    template.resourceCountIs('AWS::CloudFront::Function', 1)
  })

  it('copies the session secret into the KVS and keeps the router associated with its store', () => {
    const { template } = build(true, true)
    template.resourceCountIs('Custom::CdkCoreKvsSecret', 1)
    const fns = Object.values(template.findResources('AWS::CloudFront::Function')) as {
      Properties: { FunctionConfig: { KeyValueStoreAssociations?: unknown[] } }
    }[]
    expect(fns[0]?.Properties.FunctionConfig.KeyValueStoreAssociations).toHaveLength(1)
  })

  it("gives the auth Lambda both client ids and a session secret dynamic reference", () => {
    const { template } = build(true, true)
    const env = authLambdaEnvironment(template)
    // aud is the client that minted the token, not the pool — exactly like
    // `PreviewDeployment.authEnvironment`.
    expect(JSON.stringify(env.AUTH_CLIENT_ID)).toMatch(/PreviewAuthClient/)
    expect(JSON.stringify(env.AUTH_CLIENT_ID)).toMatch(/PreviewMachineClient/)
    // Rendered form, whatever shape it took (a plain string here, or an
    // `Fn::Join` when a token like the partition is folded in elsewhere) —
    // assert on the serialized form per `.claude/rules/auth.md` item 3.
    expect(JSON.stringify(env.AUTH_SESSION_SECRET)).toContain('{{resolve:secretsmanager:')
    expect(JSON.stringify(env.AUTH_SESSION_SECRET)).toContain(
      `${DOMAIN}/preview-session-secret`,
    )
  })

  it('adds none of the above when `gate` is omitted — the ungated path is untouched', () => {
    const { template, site } = build(true, false)
    const behavior = findBehavior(distributionConfig(template), '/auth/*')
    expect(behavior).toBeUndefined()
    template.resourceCountIs('Custom::CdkCoreKvsSecret', 0)
    const fns = Object.values(template.findResources('AWS::CloudFront::Function')) as {
      Properties: { FunctionCode: string }
    }[]
    expect(fns).toHaveLength(1)
    expect(fns[0]?.Properties.FunctionCode).not.toContain('function gate(')
    expect(site.userPoolClient).toBeDefined()
  })
})
