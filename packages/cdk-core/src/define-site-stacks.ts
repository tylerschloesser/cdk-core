/**
 * `defineSiteStacks()` — the whole four-stack layout in one call.
 *
 * [Epoch 5] This exists because A3 was missed by a mile. The plan's onboarding
 * target is "≤ 60 non-import CDK lines for four stacks"; the reference site's
 * hand-written `bin/app.ts` measured **178**, and almost none of that was a
 * decision anyone makes per site — it was five stack classes whose bodies are
 * one construct each, a zone import repeated four times, the `-c pr=` context
 * parse, and the "apply `authEnvironment` after the pool exists" dance. The
 * epoch's own instruction for this case is to add the convenience and re-count,
 * keeping the constructs primary.
 *
 * So this is a **function, not a construct**, and it is deliberately not the
 * only way in: it composes `siteCertificate`, `Site`, `PreviewSite`,
 * `PreviewDeployment` and `GithubDeployRole` exactly as a consumer would, and
 * returns every stack and construct it made. A site that needs a fifth stack, a
 * second distribution, or a backend the shape below cannot express drops back
 * to the constructs and loses nothing.
 *
 * Note that this is the one place in the package that creates `Stack`s. The
 * constructs never do — the sentence in `plan.md` → Architecture used to say
 * that without qualification, and now says it about the constructs.
 */

import { App, CfnOutput, Stack } from 'aws-cdk-lib'
import type { Environment, StackProps } from 'aws-cdk-lib'
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as route53 from 'aws-cdk-lib/aws-route53'
import type { Construct, IDependable } from 'constructs'

import { siteCertificate } from './certificate.js'
import { GithubDeployRole } from './github-deploy-role.js'
import { PreviewDeployment } from './preview-deployment.js'
import { PreviewSite } from './preview-site.js'
import { Site } from './site.js'
import type { AuthEnvironment, AuthProps, BackendProps } from './types.js'

/**
 * How a site's backend Lambdas get built.
 *
 * It is a callback rather than a list of functions because the *same* backends
 * are built twice — once in the prod stack and once in every PR stack — and a
 * construct belongs to exactly one stack. Returning them per scope is what
 * makes a preview run the same code prod is about to run, which is the only
 * reason a preview proves anything.
 *
 * Keys must match `backends`. The function URL is added by
 * `defineSiteStacks()`, from that key's `streaming` flag: `AWS_IAM` always
 * (OAC signs the request), `RESPONSE_STREAM` when streaming. `AuthType.NONE`
 * is not offered; see plan.md D1.
 */
export type BackendFunctions = (scope: Construct) => Record<string, lambda.Function>

export interface DefineSiteStacksProps {
  /** Explicit account and region. CloudFront needs us-east-1 for the certificate. */
  readonly env: Environment
  /** e.g. 'CdkCore'. Stacks: `<prefix>{Shared,Preview,Site,GithubOidc}` and `<prefix>-pr-<n>`. */
  readonly stackPrefix: string
  /** e.g. 'cdk-core.ty.ler.dev'. */
  readonly domain: string
  /** The hosted zone containing `domain`, imported by attributes — never created. */
  readonly zone: route53.HostedZoneAttributes
  /** Absolute path to the built SPA, e.g. `apps/web/dist`. */
  readonly webDist: string
  /**
   * The routing half of the backends contract, shared by the prod and preview
   * distributions so the two cannot disagree about which path is whose. A
   * CloudFront Function cannot change which cache behavior was selected, so
   * these patterns are also what the web app's fetches and the dev proxy match.
   */
  readonly backends: Record<string, BackendProps>
  readonly functions: BackendFunctions
  /**
   * Omit for a site with no user pool. When present, `Site` gets a prod pool
   * (no native users, refresh-only client) and `PreviewSite` gets a preview
   * pool with the machine user.
   *
   * `preview` is merged over the shared props for the preview pool only. Its
   * `domainPrefix` defaults to `<domainPrefix>-preview`, but both prefixes are
   * usually written out: they also exist in the Google OAuth client's
   * authorized redirect URIs, where a mismatch is a `redirect_uri_mismatch` at
   * Google with nothing in any AWS log.
   */
  readonly auth?: AuthProps & { readonly preview?: AuthProps }
  /**
   * Omit to skip `<prefix>GithubOidc` entirely. That stack is deployed **by
   * hand, once** — it is the stack that grants CI its credentials, so a
   * workflow that deployed it would already have to hold them.
   */
  readonly github?: {
    /** 'owner/name' */
    readonly repo: string
    readonly roleName: string
    /** GitHub's numeric ids, from `gh api repos/<repo>`. With both, the immutable `sub` form is trusted too. */
    readonly ownerId?: string
    readonly repoId?: string
    readonly oidcProviderArn?: string
  }
  /** Merged into every stack. `env` always wins. */
  readonly stackProps?: Omit<StackProps, 'env'>
  /** Escape hatch: extra props for `Site` only (`additionalBehaviors`, `distributionOverrides`, `unversioned`). */
  readonly siteOverrides?: Partial<Omit<SiteExtras, never>>
  /** Escape hatch: extra props for `PreviewSite` only. */
  readonly previewOverrides?: Partial<PreviewExtras>
}

/** The subset of `SiteProps` that is neither derived nor part of the backends contract. */
interface SiteExtras {
  readonly unversioned: string[]
  readonly distributionOverrides: NonNullable<ConstructorParameters<typeof Site>[2]['distributionOverrides']>
  readonly additionalBehaviors: NonNullable<ConstructorParameters<typeof Site>[2]['additionalBehaviors']>
}

interface PreviewExtras {
  readonly machineUserName: string
  readonly parameterPrefix: string
  readonly distributionOverrides: NonNullable<ConstructorParameters<typeof PreviewSite>[2]['distributionOverrides']>
}

export interface SiteStacks {
  readonly shared: Stack
  readonly certificate: acm.ICertificate
  readonly preview: Stack
  readonly previewSite: PreviewSite
  readonly site: Stack
  readonly siteConstruct: Site
  /** Absent when `github` was omitted. */
  readonly githubOidc?: Stack
  /** Present only when the app was synthesized with `-c pr=<n>`. */
  readonly pr?: Stack
  readonly previewDeployment?: PreviewDeployment
}

/**
 * Spread `authEnvironment` onto every backend Lambda.
 *
 * This runs *after* the site construct, not before, and that ordering is
 * forced: the construct needs the function URLs to build its behaviors, so the
 * pool cannot exist until the functions do, so the pool's issuer and client id
 * cannot be known when the functions are created.
 */
function applyAuthEnvironment(
  functions: Record<string, lambda.Function>,
  environment: AuthEnvironment | Record<string, never>,
  /**
   * The session secret, when the site is gated and owns it. `AUTH_SESSION_SECRET`
   * is a `{{resolve:secretsmanager:...}}` dynamic reference, and a dynamic
   * reference creates **no** implicit dependency — CloudFormation is free to
   * create a backend Lambda before the secret exists, and the resolve then fails
   * the deploy. Only prod passes this: a PR stack's secret lives in the shared
   * preview stack, which is always deployed first.
   */
  dependsOn?: IDependable,
): void {
  for (const fn of Object.values(functions)) {
    for (const [key, value] of Object.entries(environment)) {
      fn.addEnvironment(key, value)
    }
    if (dependsOn) fn.node.addDependency(dependsOn)
  }
}

function addFunctionUrls(
  functions: Record<string, lambda.Function>,
  backends: Record<string, BackendProps>,
): Record<string, lambda.IFunctionUrl> {
  const urls: Record<string, lambda.IFunctionUrl> = {}
  for (const [key, backend] of Object.entries(backends)) {
    const fn = functions[key]
    if (!fn) {
      throw new Error(
        `defineSiteStacks: 'functions' returned no Lambda for backend '${key}' (got: ${Object.keys(functions).join(', ') || 'nothing'})`,
      )
    }
    urls[key] = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      ...(backend.streaming ? { invokeMode: lambda.InvokeMode.RESPONSE_STREAM } : {}),
    })
  }
  for (const key of Object.keys(functions)) {
    if (!backends[key]) {
      throw new Error(`defineSiteStacks: 'functions' returned a Lambda for unknown backend '${key}'`)
    }
  }
  return urls
}

export function defineSiteStacks(app: App, props: DefineSiteStacksProps): SiteStacks {
  const { env, stackPrefix, domain, webDist, backends } = props
  const stackProps: StackProps = { ...props.stackProps, env }

  if (Object.keys(backends).length === 0) {
    throw new Error('defineSiteStacks: at least one backend is required')
  }

  const importZone = (scope: Construct): route53.IHostedZone =>
    route53.HostedZone.fromHostedZoneAttributes(scope, 'Zone', props.zone)

  // ---- <prefix>Shared: the one certificate ------------------------------
  const shared = new Stack(app, `${stackPrefix}Shared`, stackProps)
  const certificate = siteCertificate(shared, 'Certificate', {
    domain,
    zone: importZone(shared),
  })

  // ---- <prefix>Preview: the shared preview distribution -----------------
  //
  // The certificate crosses from Shared as an ordinary construct reference,
  // which is the exception to "PR stacks read SSM": these two stacks change
  // together and neither is per-PR.
  const preview = new Stack(app, `${stackPrefix}Preview`, stackProps)
  const previewSite = new PreviewSite(preview, 'Preview', {
    domain,
    zone: importZone(preview),
    certificate,
    backends,
    ...props.previewOverrides,
    ...(props.auth ? { auth: { ...props.auth, ...props.auth.preview } } : {}),
  })

  // ---- <prefix>Site: production -----------------------------------------
  const site = new Stack(app, `${stackPrefix}Site`, stackProps)
  const siteFunctions = props.functions(site)
  const siteUrls = addFunctionUrls(siteFunctions, backends)
  const siteConstruct = new Site(site, 'Site', {
    domain,
    zone: importZone(site),
    certificate,
    webDist,
    backends: Object.fromEntries(
      Object.entries(backends).map(([key, backend]) => [
        key,
        { ...backend, functionUrl: siteUrls[key]! },
      ]),
    ),
    ...props.siteOverrides,
    ...(props.auth ? { auth: stripPreview(props.auth) } : {}),
  })
  applyAuthEnvironment(siteFunctions, siteConstruct.authEnvironment, siteConstruct.sessionSecret)
  new CfnOutput(site, 'SiteUrl', { value: siteConstruct.url })

  // ---- <prefix>GithubOidc: by hand, once --------------------------------
  let githubOidc: Stack | undefined
  if (props.github) {
    githubOidc = new Stack(app, `${stackPrefix}GithubOidc`, stackProps)
    new GithubDeployRole(githubOidc, 'DeployRole', {
      repo: props.github.repo,
      roleName: props.github.roleName,
      stackPrefix,
      domain,
      ownerId: props.github.ownerId,
      repoId: props.github.repoId,
      oidcProviderArn: props.github.oidcProviderArn,
    })
  }

  // ---- <prefix>-pr-<n>: one per open PR ---------------------------------
  //
  // Selected by context, so `cdk list` shows only the permanent stacks unless
  // `-c pr=` is given. The digits-only check is not decoration: the sweeper
  // anchors on `^<prefix>-pr-[0-9]+$` and would not recognise — and so would
  // never delete — a stack whose name came from an arbitrary context string.
  let pr: Stack | undefined
  let previewDeployment: PreviewDeployment | undefined
  const prContext = app.node.tryGetContext('pr')
  if (prContext !== undefined) {
    const prValue = String(prContext)
    if (!/^[0-9]+$/.test(prValue)) {
      throw new Error(`invalid pr context value: ${prValue}`)
    }
    pr = new Stack(app, `${stackPrefix}-pr-${prValue}`, stackProps)
    const prFunctions = props.functions(pr)
    const prUrls = addFunctionUrls(prFunctions, backends)
    previewDeployment = new PreviewDeployment(pr, 'Deployment', {
      domain,
      pr: Number(prValue),
      webDist,
      backends: prUrls,
      auth: props.auth !== undefined,
      // The PR stack cannot read a construct reference, so — like `auth` — the
      // gate is stated rather than discovered. It only decides whether the
      // backend Lambdas get `AUTH_SESSION_SECRET`; the gate itself lives on the
      // shared preview distribution.
      gate: props.auth?.gate === 'edge',
    })
    applyAuthEnvironment(prFunctions, previewDeployment.authEnvironment)
    new CfnOutput(pr, 'PreviewUrl', { value: previewDeployment.url })
  }

  return {
    shared,
    certificate,
    preview,
    previewSite,
    site,
    siteConstruct,
    githubOidc,
    pr,
    previewDeployment,
  }
}

/** `auth` minus the preview-only overrides, so `Site` never sees a prop it does not have. */
function stripPreview(auth: AuthProps & { readonly preview?: AuthProps }): AuthProps {
  const { preview: _preview, ...rest } = auth
  return rest
}
