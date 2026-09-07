/**
 * The site's CDK app.
 *
 * Stack *knowledge* — which domain, which zone, which account, how many
 * Lambdas, how they're bundled — lives here and nowhere inside
 * `{{PACKAGE_NAME}}`. `defineSiteStacks()` composes the five stacks
 * out of the same constructs a consumer could wire by hand
 * (`siteCertificate`, `Site`, `PreviewSite`, `PreviewDeployment`,
 * `GithubDeployRole`); it removes the boilerplate, not the choices. A site
 * that needs a shape it cannot express drops back to the constructs.
 *
 * `{{STACK_PREFIX}}-pr-<n>` takes no construct reference to `{{STACK_PREFIX}}Preview` — it
 * reads the shared preview infrastructure (distribution ARN, KVS ARN, bucket
 * name, the pool) from the SSM parameters `PreviewSite` publishes. That is
 * what lets it deploy with `--exclusively`, without touching the shared
 * stacks on every PR.
 */

import { fileURLToPath } from 'node:url'
import { App, Duration } from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import type { Construct } from 'constructs'
import { defineSiteStacks } from '{{PACKAGE_NAME}}'

const API_ENTRY = fileURLToPath(new URL('../../apps/api/src/lambda-api.ts', import.meta.url))
const EVENTS_ENTRY = fileURLToPath(new URL('../../apps/api/src/lambda-events.ts', import.meta.url))
const WEB_DIST = fileURLToPath(new URL('../../apps/web/dist', import.meta.url))

/**
 * The two backend Lambdas, built identically in the prod stack and in every PR
 * stack — which is the point: a preview running different code would prove
 * nothing about what `main` is going to do. `/events` is a second function
 * rather than a route on the first only because `RESPONSE_STREAM` is fixed
 * when a function URL is created and a buffered URL cannot be promoted to one.
 * `defineSiteStacks` adds the URLs, taking `RESPONSE_STREAM` from the
 * `streaming` flag below.
 */
function backendFunctions(scope: Construct): Record<string, lambda.Function> {
  const bundling = { externalModules: ['@aws-sdk/*'], minify: true, sourceMap: false }
  return {
    api: new NodejsFunction(scope, 'ApiFn', {
      entry: API_ENTRY,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.seconds(30),
      bundling,
    }),
    events: new NodejsFunction(scope, 'EventsFn', {
      entry: EVENTS_ENTRY,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.seconds(120),
      bundling,
    }),
  }
}

defineSiteStacks(new App(), {
  env: { account: '{{ACCOUNT_ID}}', region: '{{REGION}}' },
  stackPrefix: '{{STACK_PREFIX}}',
  domain: '{{SITE_DOMAIN}}',
  zone: { hostedZoneId: '{{ZONE_ID}}', zoneName: '{{ZONE_NAME}}' },
  webDist: WEB_DIST,
  // The routing half of the backends contract, shared by both distributions.
  // A CloudFront Function cannot change which cache behavior was selected, so
  // these patterns are also what `apps/web`'s fetches and Vite's dev proxy
  // have to match.
  backends: {
    api: { pathPattern: '/api/*' },
    events: { pathPattern: '/events/*', streaming: true },
  },
  functions: backendFunctions,
  // Both prefixes are written out rather than derived, because they also exist
  // in a place CDK cannot reach: the Google OAuth client's authorized redirect
  // URIs (`https://<prefix>.auth.{{REGION}}.amazoncognito.com/oauth2/idpresponse`).
  // A mismatch is a `redirect_uri_mismatch` at Google with nothing in any AWS log.
  auth: { domainPrefix: '{{AUTH_PREFIX}}', preview: { domainPrefix: '{{PREVIEW_AUTH_PREFIX}}' } },
  // Deployed by hand, once, and never by a workflow: this is the stack that
  // grants CI its credentials. The numeric ids are GitHub's own, from
  // `gh api repos/<repo>`, and exist only to build the immutable `sub` claim
  // the trust policy also accepts alongside the legacy `owner/name` form.
  github: {
    repo: '{{REPO}}',
    roleName: '{{ROLE_NAME}}',
    ownerId: '{{REPO_OWNER_ID}}',
    repoId: '{{REPO_ID}}',
  },
})
