# @tylerschloesser/cdk-core

CDK constructs for a personal site that needs cheap per-PR preview environments on one shared
CloudFront distribution, Google login through Cognito, and server-sent events through
CloudFront. Built for a solo developer running several small sites on one AWS account; see
[the plan](https://github.com/tylerschloesser/cdk-core/blob/main/plan.md) for the full design
and [`docs/prior-art.md`](https://github.com/tylerschloesser/cdk-core/blob/main/docs/prior-art.md)
for where the patterns came from.

## Install

```sh
npm i @tylerschloesser/cdk-core
```

`aws-cdk-lib` and `constructs` are **optional peer dependencies** — install them yourself if
you use the constructs (`Site`, `PreviewSite`, `PreviewDeployment`, `GithubDeployRole`,
`siteCertificate`):

```sh
npm i -D aws-cdk-lib constructs
```

`./auth/browser` and `./auth/server` need neither. A browser bundle that only wants
`auth/browser` never pulls in `aws-cdk-lib`, and a Lambda that only wants `auth/server` never
pulls in DOM-only code.

## The stacks

A consumer repo defines four stacks (the constructs never create stacks themselves):

| Stack | Deployed by | Holds |
| --- | --- | --- |
| `<Prefix>Shared` | your deploy workflow, and by hand | the one ACM certificate (`siteCertificate`) |
| `<Prefix>Site` | your deploy workflow, on push to `main` | `Site`: prod bucket, distribution, DNS apex, prod user pool, your backends' Lambdas |
| `<Prefix>Preview` | your deploy workflow (rarely changes) | `PreviewSite`: preview bucket, KVS, router function, preview distribution, wildcard DNS, preview user pool + machine user, SSM parameters |
| `<Prefix>-pr-<n>` | your PR-preview workflow, one per open PR; deleted on close | `PreviewDeployment` + that PR's backend Lambdas, plus any of your own per-PR data (`RemovalPolicy.DESTROY`) |
| `<Prefix>GithubOidc` | **by hand, once** | `GithubDeployRole` — the role your workflows assume |

`<Prefix>GithubOidc` is deployed by hand because a workflow cannot grant itself the trust it
needs to run: the role has to exist and be assumable before any workflow can authenticate.

## Constructs

### `siteCertificate(scope, id, props)`

One ACM certificate covering `domain` and `*.preview.<domain>` (plus `auth.<domain>` if you
pass `includeAuthHost: true`, for the Cognito custom-domain escape hatch). Must be created in
`us-east-1` — CloudFront's requirement — and throws at synth if the stack's region is anything
else. Props: `domain`, `zone` (an imported `route53.IHostedZone`), `includeAuthHost?`.

### `Site`

The production distribution: S3 bucket + CloudFront with an OAC default behavior, one
additional behavior per backend, apex DNS, and — if you pass `auth` — a Cognito user pool with
Google as the only identity provider. Key props: `domain`/`zone`, `certificate`, `webDist`
(absolute path to the built SPA), `backends` (a map of short id → `BackendProps &
{ functionUrl }`), `auth?: AuthProps`, `distributionOverrides?` and `additionalBehaviors?` as
escape hatches. Exposes `distribution`, `bucket`, `url`, `userPool?`, `userPoolClient?` and
`authEnvironment` (the `AUTH`/`AUTH_ISSUER`/`AUTH_CLIENT_ID` env to spread onto your backend
Lambdas, or `{}` when `auth` is omitted).

```ts
import { Stack } from 'aws-cdk-lib'
import { Site } from '@tylerschloesser/cdk-core'

const site = new Site(this, 'Site', {
  domain: 'example.com',
  zone,
  certificate,
  webDist: '/abs/path/to/apps/web/dist',
  backends: {
    api: { pathPattern: '/api/*', functionUrl: apiFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }) },
  },
  auth: { domainPrefix: 'example' },
})

for (const [key, value] of Object.entries(site.authEnvironment)) {
  apiFn.addEnvironment(key, value)
}
```

### `PreviewSite`

The shared preview infrastructure: one preview bucket, one CloudFront KeyValueStore, a
generated router CloudFront Function, one preview distribution with wildcard DNS, and — if you
pass `auth` — a separate preview user pool plus a machine user for headless login (Claude, or
CI). Same `backends` shape as `Site`, minus the origins (previews resolve origins dynamically
at request time). Publishes everything a PR stack needs — distribution ARN/id, bucket name, KVS
ARN, and the auth issuer/client ids — to SSM under `parameterPrefix` (default
`/cdk-core/<domain>/preview`), so PR stacks never take a construct reference to it.

### `PreviewDeployment`

One per PR, deployed in the PR's own stack. Builds that PR's slice of the preview: uploads
`webDist` under a `pr-<n>/` prefix in the shared preview bucket, writes its KVS entry, and
invalidates. Reads everything about the shared preview infrastructure from SSM — pass
`auth: true` if the site's `PreviewSite` was created with `auth`, since a missing SSM
parameter fails the deploy, not the synth, and there is nothing else to detect it from.
Exposes `hostname` (`pr-<n>.preview.<domain>`), `url`, and `authEnvironment`.

```ts
import { PreviewDeployment } from '@tylerschloesser/cdk-core'

const deployment = new PreviewDeployment(this, 'Deployment', {
  domain: 'example.com',
  pr: 12,
  webDist: '/abs/path/to/apps/web/dist',
  backends: { api: apiFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM }) },
  auth: true,
})

new CfnOutput(this, 'PreviewUrl', { value: deployment.url })
```

### `GithubDeployRole`

The IAM role your GitHub Actions workflows assume over OIDC, scoped to deploying and tearing
down `<stackPrefix>-pr-*` stacks and to the sweeper's read/delete permissions on the preview
KVS and bucket. Props: `repo`, `roleName`, `stackPrefix`, `domain`, and optionally `ownerId` +
`repoId` (GitHub's numeric ids — with both given, the role also trusts the immutable
`repo:<owner>@<ownerId>/<name>@<repoId>:…` subject alongside the legacy name-based one, which
matters if the repo is ever renamed or transferred). Imports the account's existing GitHub OIDC
provider rather than creating one.

## Runtime subpath exports

- **`@tylerschloesser/cdk-core/auth/browser`** — `loadConfig()`, `login(devUser?)`,
  `handleCallback()`, `getToken()`, `logout()`, `apiFetch()`, `readSse()`. DOM-only, no
  `aws-cdk-lib` dependency.
- **`@tylerschloesser/cdk-core/auth/server`** — `createVerifier({ issuer, clientId })`
  (built on `aws-jwt-verify`), `getUser(c)`, `authMode()`, `isLocalMode()`. Node-only; types
  its request argument structurally (`RequestLike`) instead of importing a web framework, so it
  has no runtime dependency on your framework or its major version.

## `cdk-core sweep`

A bin, `cdk-core`, installed with the package:

```sh
cdk-core sweep --site example.com --stack-prefix Example --repo you/example [--dry-run] [--region us-east-1]
```

Reconciles four things against GitHub's PR state: CloudFormation stacks matching
`^<prefix>-pr-(\d+)$`, KVS keys in the preview store, `pr-<n>/` prefixes in the preview bucket,
and CloudWatch log groups matching `^/aws/lambda/<prefix>-pr-(\d+)-` (which Lambda creates on
first invoke, so CloudFormation never deletes them with the stack). Anything whose PR is closed
or merged, and that a live stack no longer accounts for, is deleted. `--dry-run` deletes nothing and exits non-zero if it *would* delete something, so a
green dry run is a positive statement that nothing is orphaned.

## Hostnames

- Production: `<domain>`
- Previews: `pr-<n>.preview.<domain>`
- The OAuth bounce host previews use to come back from Google: `oauth.preview.<domain>`
- One ACM certificate, in `us-east-1`, with SANs `[<domain>, *.preview.<domain>]`

## Claude Code plugin

This repository also ships a Claude Code plugin (marketplace `tylerschloesser`, plugin
`cdk-core`) with `preview`, `preview-auth` and `new-site` skills that teach a consumer repo's
Claude how previews, preview auth, and onboarding work. See the
[repo's README](https://github.com/tylerschloesser/cdk-core#readme) for the `.claude/settings.json`
snippet that installs it.

## License

MIT
