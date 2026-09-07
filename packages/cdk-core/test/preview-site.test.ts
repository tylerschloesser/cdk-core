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
import * as route53 from 'aws-cdk-lib/aws-route53'
import { describe, expect, it } from 'vitest'

import { PreviewSite } from '../src/preview-site.js'

const DOMAIN = 'cdk-core.ty.ler.dev'

function build(auth: boolean): { site: PreviewSite; template: Template } {
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
    ...(auth ? { auth: { domainPrefix: 'cdk-core-preview' } } : {}),
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
