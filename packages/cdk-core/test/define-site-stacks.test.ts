/**
 * `defineSiteStacks()` composes five stack-shaped pieces
 * (`siteCertificate`, `Site`, `PreviewSite`, `PreviewDeployment`,
 * `GithubDeployRole`) into the four-permanent-stacks-plus-per-PR layout
 * `infra/bin/app.ts` used to write out by hand. These tests synthesize it
 * with `lambda.Function`/`Code.fromInline` backends — never `NodejsFunction`,
 * which would drag a bundler into a unit test — and assert the stack names,
 * the `-c pr=` gate, the function-URL wiring derived from `backends`, the
 * `authEnvironment` propagation onto every backend Lambda, and the error
 * paths that keep `functions` and `backends` from silently disagreeing.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import type { Construct } from 'constructs'
import { afterAll, describe, expect, it } from 'vitest'

import {
  defineSiteStacks,
  type BackendFunctions,
  type DefineSiteStacksProps,
  type SiteStacks,
} from '../src/define-site-stacks.js'
import { CachePolicies } from '../src/cache-policies.js'

const DOMAIN = 'cdk-core.ty.ler.dev'

/**
 * A real directory, because `Site` (reached through `defineSiteStacks`)
 * refuses to synth against a missing `webDist`.
 */
const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-core-define-site-stacks-'))
fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html>\n')

afterAll(() => {
  fs.rmSync(webDist, { recursive: true, force: true })
})

const BACKENDS: DefineSiteStacksProps['backends'] = {
  api: { pathPattern: '/api/*' },
  events: { pathPattern: '/events/*', streaming: true },
}

interface FunctionsOptions {
  /** Backend keys to omit from the returned map, to trigger the "no Lambda for backend" error. */
  readonly omit?: string[]
  /** Extra, undeclared keys to add, to trigger the "unknown backend" error. */
  readonly extra?: string[]
}

/** Builds a fresh `lambda.Function` per key, per call — a construct belongs to one stack only. */
function makeFunctions(options: FunctionsOptions = {}): BackendFunctions {
  return (scope: Construct) => {
    const inline = (id: string): lambda.Function =>
      new lambda.Function(scope, id, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('exports.handler = async () => ({})'),
      })
    const fns: Record<string, lambda.Function> = {}
    for (const key of Object.keys(BACKENDS)) {
      if (!options.omit?.includes(key)) {
        fns[key] = inline(`${key[0]!.toUpperCase()}${key.slice(1)}Fn`)
      }
    }
    for (const key of options.extra ?? []) {
      fns[key] = inline(`${key[0]!.toUpperCase()}${key.slice(1)}Fn`)
    }
    return fns
  }
}

function baseProps(overrides: Partial<DefineSiteStacksProps> = {}): DefineSiteStacksProps {
  return {
    env: { account: '111122223333', region: 'us-east-1' },
    stackPrefix: 'Test',
    domain: DOMAIN,
    zone: { hostedZoneId: 'Z0000000000000000000', zoneName: 'ty.ler.dev' },
    webDist,
    backends: BACKENDS,
    functions: makeFunctions(),
    ...overrides,
  }
}

interface Scenario {
  readonly app: App
  readonly result: SiteStacks
  readonly templates: {
    readonly shared: Template
    readonly preview: Template
    readonly site: Template
    readonly githubOidc?: Template
    readonly pr?: Template
  }
}

/**
 * Memoised per scenario name. `Template.fromStack` stages and zips every
 * `Code.fromAsset` (the provider-framework assets `PreviewSite` and
 * `GithubDeployRole`'s SSM lookups pull in), which is the slowest thing in
 * this file; each distinct scenario below is synthesized exactly once.
 */
const scenarios = new Map<string, Scenario>()

function scenario(
  name: string,
  build: () => { app: App; result: SiteStacks },
): Scenario {
  const cached = scenarios.get(name)
  if (cached) return cached
  const { app, result } = build()
  const templates: {
    shared: Template
    preview: Template
    site: Template
    githubOidc?: Template
    pr?: Template
  } = {
    shared: Template.fromStack(result.shared),
    preview: Template.fromStack(result.preview),
    site: Template.fromStack(result.site),
  }
  if (result.githubOidc) templates.githubOidc = Template.fromStack(result.githubOidc)
  if (result.pr) templates.pr = Template.fromStack(result.pr)
  const value = { app, result, templates }
  scenarios.set(name, value)
  return value
}

function distribution(template: Template): Record<string, unknown> {
  const resources = template.findResources('AWS::CloudFront::Distribution')
  const only = Object.values(resources)[0] as { Properties: { DistributionConfig: Record<string, unknown> } }
  return only.Properties.DistributionConfig
}

/** The `AWS::Lambda::Url` resource whose target is the function created with id `<prefix>Fn`. */
function functionUrlFor(template: Template, idPrefix: string): { Properties: Record<string, unknown> } {
  const urls = Object.entries(template.findResources('AWS::Lambda::Url')) as [
    string,
    { Properties: { TargetFunctionArn: { 'Fn::GetAtt': [string, string] } } },
  ][]
  const match = urls.find(([, resource]) =>
    resource.Properties.TargetFunctionArn['Fn::GetAtt'][0].startsWith(idPrefix),
  )
  if (!match) throw new Error(`no AWS::Lambda::Url found for a function id starting with ${idPrefix}`)
  return match[1] as unknown as { Properties: Record<string, unknown> }
}

/** Every `AWS::Lambda::Function`'s `Environment.Variables`, keyed by the function's logical id prefix. */
function environmentsByFunctionPrefix(
  template: Template,
  prefixes: string[],
): Record<string, Record<string, string>> {
  const functions = template.findResources('AWS::Lambda::Function') as Record<
    string,
    { Properties: { Environment?: { Variables?: Record<string, string> } } }
  >
  const found: Record<string, Record<string, string>> = {}
  for (const [logicalId, resource] of Object.entries(functions)) {
    const prefix = prefixes.find((p) => logicalId.startsWith(p))
    if (prefix) found[prefix] = resource.Properties.Environment?.Variables ?? {}
  }
  return found
}

describe('defineSiteStacks', () => {
  describe('the permanent stacks and the pr gate', () => {
    it('creates <prefix>Shared, <prefix>Preview and <prefix>Site, and no <prefix>-pr-* without pr context', () => {
      const { result, app } = scenario('base', () => {
        const app = new App()
        return { app, result: defineSiteStacks(app, baseProps()) }
      })
      expect(result.shared.stackName).toBe('TestShared')
      expect(result.preview.stackName).toBe('TestPreview')
      expect(result.site.stackName).toBe('TestSite')
      expect(result.pr).toBeUndefined()
      const stackIds = app.node.children.map((c) => c.node.id)
      expect(stackIds.some((id) => /^Test-pr-/.test(id))).toBe(false)
    })

    it('omits <prefix>GithubOidc when `github` is omitted', () => {
      const { result } = scenario('base', () => {
        const app = new App()
        return { app, result: defineSiteStacks(app, baseProps()) }
      })
      expect(result.githubOidc).toBeUndefined()
    })

    it('creates <prefix>GithubOidc, <prefix>-pr-<n> and the rest, all under one app, when github and pr context are both given', () => {
      const { result } = scenario('full', () => {
        const app = new App({ context: { pr: '42' } })
        const result = defineSiteStacks(
          app,
          baseProps({
            github: {
              repo: 'tylerschloesser/cdk-core',
              roleName: 'cdk-core-github-deploy',
              ownerId: '2300885',
              repoId: '1359473287',
            },
            auth: { domainPrefix: 'cdk-core', preview: { domainPrefix: 'cdk-core-preview' } },
          }),
        )
        return { app, result }
      })
      expect(result.shared.stackName).toBe('TestShared')
      expect(result.preview.stackName).toBe('TestPreview')
      expect(result.site.stackName).toBe('TestSite')
      expect(result.githubOidc?.stackName).toBe('TestGithubOidc')
      expect(result.pr?.stackName).toBe('Test-pr-42')
    })

    it('throws on a non-numeric pr context, because the sweeper anchors on ^<prefix>-pr-[0-9]+$', () => {
      const app = new App({ context: { pr: 'abc' } })
      expect(() => defineSiteStacks(app, baseProps())).toThrow(/pr/)
    })
  })

  describe('the pr stack\'s naming', () => {
    it('names it <prefix>-pr-<n> for the numeric context value given', () => {
      const { result } = scenario('full', () => {
        const app = new App({ context: { pr: '42' } })
        const result = defineSiteStacks(
          app,
          baseProps({
            github: {
              repo: 'tylerschloesser/cdk-core',
              roleName: 'cdk-core-github-deploy',
              ownerId: '2300885',
              repoId: '1359473287',
            },
            auth: { domainPrefix: 'cdk-core', preview: { domainPrefix: 'cdk-core-preview' } },
          }),
        )
        return { app, result }
      })
      expect(result.pr?.stackName).toBe('Test-pr-42')
    })
  })

  describe('function URLs derived from backends', () => {
    it('gives the streaming backend RESPONSE_STREAM and the non-streaming one no InvokeMode, both AWS_IAM', () => {
      const { templates } = scenario('base', () => {
        const app = new App()
        return { app, result: defineSiteStacks(app, baseProps()) }
      })
      const api = functionUrlFor(templates.site, 'ApiFn')
      const events = functionUrlFor(templates.site, 'EventsFn')
      expect(api.Properties.InvokeMode).toBeUndefined()
      expect(events.Properties.InvokeMode).toBe('RESPONSE_STREAM')
      expect(api.Properties.AuthType).toBe('AWS_IAM')
      expect(events.Properties.AuthType).toBe('AWS_IAM')
    })
  })

  describe('authEnvironment reaching the Lambdas', () => {
    it('puts AUTH, AUTH_ISSUER and AUTH_CLIENT_ID on every backend function in <prefix>Site and the pr stack, when auth is set', () => {
      const { templates } = scenario('full', () => {
        const app = new App({ context: { pr: '42' } })
        const result = defineSiteStacks(
          app,
          baseProps({
            github: {
              repo: 'tylerschloesser/cdk-core',
              roleName: 'cdk-core-github-deploy',
              ownerId: '2300885',
              repoId: '1359473287',
            },
            auth: { domainPrefix: 'cdk-core', preview: { domainPrefix: 'cdk-core-preview' } },
          }),
        )
        return { app, result }
      })
      const siteEnvs = environmentsByFunctionPrefix(templates.site, ['ApiFn', 'EventsFn'])
      expect(Object.keys(siteEnvs).sort()).toEqual(['ApiFn', 'EventsFn'])
      for (const env of Object.values(siteEnvs)) {
        expect(env.AUTH).toBe('cognito')
        expect(env.AUTH_ISSUER).toBeDefined()
        expect(env.AUTH_CLIENT_ID).toBeDefined()
      }

      const prEnvs = environmentsByFunctionPrefix(templates.pr!, ['ApiFn', 'EventsFn'])
      expect(Object.keys(prEnvs).sort()).toEqual(['ApiFn', 'EventsFn'])
      for (const env of Object.values(prEnvs)) {
        expect(env.AUTH).toBe('cognito')
        expect(env.AUTH_ISSUER).toBeDefined()
        expect(env.AUTH_CLIENT_ID).toBeDefined()
      }
    })

    it('puts AUTH_SESSION_SECRET on every backend function in both stacks when the gate is on', () => {
      const { templates } = scenario('gated', () => {
        const app = new App({ context: { pr: '42' } })
        return {
          app,
          result: defineSiteStacks(
            app,
            baseProps({
              auth: {
                domainPrefix: 'cdk-core',
                gate: 'edge',
                preview: { domainPrefix: 'cdk-core-preview' },
              },
            }),
          ),
        }
      })

      for (const env of Object.values(environmentsByFunctionPrefix(templates.site, ['ApiFn', 'EventsFn']))) {
        expect(JSON.stringify(env.AUTH_SESSION_SECRET)).toContain('{{resolve:secretsmanager:')
        expect(JSON.stringify(env.AUTH_SESSION_SECRET)).toContain(`${DOMAIN}/session-secret`)
      }

      // The PR stack reads the *preview* secret, which lives in the shared
      // preview stack — a different secret from prod's, which is what makes a
      // preview session cookie useless against production.
      for (const env of Object.values(environmentsByFunctionPrefix(templates.pr!, ['ApiFn', 'EventsFn']))) {
        expect(JSON.stringify(env.AUTH_SESSION_SECRET)).toContain(`${DOMAIN}/preview-session-secret`)
      }
    })

    it('makes each prod backend function depend on the session secret', () => {
      // `AUTH_SESSION_SECRET` is a `{{resolve:secretsmanager:...}}` dynamic
      // reference, and a dynamic reference creates no implicit dependency.
      // Without the explicit one, CloudFormation may create a backend Lambda
      // before the secret exists and the resolve fails the deploy.
      const { templates } = scenario('gated', () => {
        const app = new App({ context: { pr: '42' } })
        return {
          app,
          result: defineSiteStacks(
            app,
            baseProps({
              auth: {
                domainPrefix: 'cdk-core',
                gate: 'edge',
                preview: { domainPrefix: 'cdk-core-preview' },
              },
            }),
          ),
        }
      })
      const resources = templates.site.toJSON().Resources as Record<string, { Type: string; DependsOn?: string[] }>
      const secretIds = Object.entries(resources)
        .filter(([, r]) => r.Type === 'AWS::SecretsManager::Secret')
        .map(([id]) => id)
      expect(secretIds.length).toBeGreaterThan(0)

      const backends = Object.entries(resources).filter(
        ([id, r]) => r.Type === 'AWS::Lambda::Function' && (id.startsWith('ApiFn') || id.startsWith('EventsFn')),
      )
      expect(backends.length).toBe(2)
      for (const [, resource] of backends) {
        expect(secretIds.some((secretId) => (resource.DependsOn ?? []).includes(secretId))).toBe(true)
      }
    })

    it('puts no AUTH env var on any backend function when auth is omitted', () => {
      const { templates } = scenario('base', () => {
        const app = new App()
        return { app, result: defineSiteStacks(app, baseProps()) }
      })
      const siteEnvs = environmentsByFunctionPrefix(templates.site, ['ApiFn', 'EventsFn'])
      expect(Object.keys(siteEnvs).sort()).toEqual(['ApiFn', 'EventsFn'])
      for (const env of Object.values(siteEnvs)) {
        expect(env.AUTH).toBeUndefined()
      }
    })
  })

  describe('the functions/backends contract', () => {
    it('throws naming the key when functions returns no Lambda for a declared backend', () => {
      const app = new App()
      expect(() =>
        defineSiteStacks(app, baseProps({ functions: makeFunctions({ omit: ['events'] }) })),
      ).toThrow(/events/)
    })

    it('throws when functions returns a Lambda for an undeclared backend key', () => {
      const app = new App()
      expect(() =>
        defineSiteStacks(app, baseProps({ functions: makeFunctions({ extra: ['bogus'] }) })),
      ).toThrow(/bogus/)
    })

    it('throws when backends is empty', () => {
      const app = new App()
      expect(() => defineSiteStacks(app, baseProps({ backends: {} }))).toThrow(
        /at least one backend/,
      )
    })
  })

  describe('the returned SiteStacks', () => {
    it('wires shared, preview and site to the stacks with those names, and pr to undefined without context', () => {
      const { result } = scenario('base', () => {
        const app = new App()
        return { app, result: defineSiteStacks(app, baseProps()) }
      })
      expect(result.shared.stackName).toBe('TestShared')
      expect(result.preview.stackName).toBe('TestPreview')
      expect(result.site.stackName).toBe('TestSite')
      expect(result.pr).toBeUndefined()
    })

    it('wires pr to the <prefix>-pr-<n> stack when pr context is given', () => {
      const { result } = scenario('full', () => {
        const app = new App({ context: { pr: '42' } })
        const result = defineSiteStacks(
          app,
          baseProps({
            github: {
              repo: 'tylerschloesser/cdk-core',
              roleName: 'cdk-core-github-deploy',
              ownerId: '2300885',
              repoId: '1359473287',
            },
            auth: { domainPrefix: 'cdk-core', preview: { domainPrefix: 'cdk-core-preview' } },
          }),
        )
        return { app, result }
      })
      expect(result.pr).toBeDefined()
      expect(result.pr?.stackName).toBe('Test-pr-42')
    })
  })

  describe('GithubDeployRole\'s SSM lookup', () => {
    it('resolves to CDK\'s dummy placeholder rather than needing real credentials', () => {
      const { templates } = scenario('full', () => {
        const app = new App({ context: { pr: '42' } })
        const result = defineSiteStacks(
          app,
          baseProps({
            github: {
              repo: 'tylerschloesser/cdk-core',
              roleName: 'cdk-core-github-deploy',
              ownerId: '2300885',
              repoId: '1359473287',
            },
            auth: { domainPrefix: 'cdk-core', preview: { domainPrefix: 'cdk-core-preview' } },
          }),
        )
        return { app, result }
      })
      // `valueFromLookup` with no cached context in `cdk.context.json` — none
      // exists here — resolves synth-time to CDK's own placeholder, without
      // making any AWS call. If this ever throws or hangs, the lookup started
      // trying to reach AWS instead.
      const policies = Object.values(
        templates.githubOidc!.findResources('AWS::IAM::Policy'),
      ) as { Properties: { PolicyDocument: { Statement: { Resource: unknown }[] } } }[]
      const resources = JSON.stringify(policies.map((p) => p.Properties.PolicyDocument.Statement))
      expect(resources).toContain('dummy-value-for-')
    })
  })

  describe('a cachePolicy factory', () => {
    it('resolves a cachePolicy factory in the Site stack and ignores it in the preview', () => {
      // A different `backends` shape than `BACKENDS`, so this is built
      // directly rather than through the `scenario()` cache keyed by name —
      // reusing 'base' or 'full' here would synth the wrong backends.
      const app = new App()
      const result = defineSiteStacks(
        app,
        baseProps({
          backends: {
            api: { pathPattern: '/api/*', cachePolicy: (scope) => CachePolicies.originDecides(scope) },
            events: { pathPattern: '/events/*', streaming: true },
          },
        }),
      )

      const siteTemplate = Template.fromStack(result.site)
      const sitePolicies = siteTemplate.findResources('AWS::CloudFront::CachePolicy')
      const sitePolicyIds = Object.keys(sitePolicies)
      expect(sitePolicyIds).toHaveLength(1)
      const config = distribution(siteTemplate) as {
        CacheBehaviors: { PathPattern: string; CachePolicyId: unknown }[]
      }
      const api = config.CacheBehaviors.find((b) => b.PathPattern === '/api/*')
      expect(api?.CachePolicyId).toEqual({ Ref: sitePolicyIds[0] })

      const previewTemplate = Template.fromStack(result.preview)
      expect(Object.keys(previewTemplate.findResources('AWS::CloudFront::CachePolicy'))).toHaveLength(0)
      const previewConfig = distribution(previewTemplate) as {
        CacheBehaviors: { PathPattern: string; CachePolicyId: unknown }[]
      }
      for (const behavior of previewConfig.CacheBehaviors) {
        expect(behavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad')
      }
    })
  })
})
