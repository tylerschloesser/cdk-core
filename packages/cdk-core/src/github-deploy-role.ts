/**
 * `GithubDeployRole` — the trust GitHub Actions assumes to deploy this repo.
 *
 * Deployed **by hand, once**, as `CdkCoreGithubOidc`: this is the stack that
 * grants CI its own credentials, so a workflow that deployed it would have to
 * already hold them. Its `roleArn` becomes the `AWS_DEPLOY_ROLE_ARN` repo
 * variable that `deploy.yml`, `pr-preview.yml` and `pr-teardown.yml` assume.
 */

import { CfnOutput, Duration, Stack } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import { Construct } from 'constructs'

import { previewParameterPrefix } from './preview-site.js'

export interface GithubDeployRoleProps {
  /** 'tylerschloesser/cdk-core' */
  readonly repo: string
  /** 'cdk-core-github-deploy' */
  readonly roleName: string
  /** Stack-name prefix; `DeleteStack` is scoped to `<stackPrefix>-pr-*`. */
  readonly stackPrefix: string
  /** Used to scope the KVS and preview-bucket permissions via SSM lookups. */
  readonly domain: string
  /** Default: import the account's existing provider. Never create one. */
  readonly oidcProviderArn?: string
  /**
   * GitHub's numeric owner id. With `repoId`, adds the immutable `sub` form.
   *
   * GitHub emits `repo:<owner>@<ownerId>/<name>@<repoId>:…` for repos created
   * after 2026-07-15, and the legacy `repo:<owner>/<name>:…` form otherwise.
   * Which one arrives on a given workflow run is a property of the repo, not
   * of this policy, so when both ids are known both forms are trusted —
   * keeping the trust correct whichever way GitHub's default has landed for
   * this particular repo.
   */
  readonly ownerId?: string
  /** GitHub's numeric repo id. With `ownerId`, adds the immutable `sub` form. */
  readonly repoId?: string
}

export class GithubDeployRole extends Construct {
  readonly role: iam.Role

  constructor(scope: Construct, id: string, props: GithubDeployRoleProps) {
    super(scope, id)

    const [owner, name] = props.repo.split('/')
    if (!owner || !name || props.repo.split('/').length !== 2) {
      throw new Error(
        `GithubDeployRole: 'repo' must be exactly 'owner/name', got '${props.repo}'`,
      )
    }

    const account = Stack.of(this).account
    const region = Stack.of(this).region

    // Imported, never created. Exactly one GitHub OIDC provider can exist per
    // account, and this account already has one — creating a second here
    // would fail the first deploy with "provider with this URL already
    // exists".
    const providerArn =
      props.oidcProviderArn ??
      `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`

    // The legacy `owner/name` form always applies. The immutable
    // `owner@ownerId/name@repoId` form is added alongside it when both ids
    // are known — see the doc comment on `ownerId`/`repoId` for why both are
    // trusted rather than choosing one.
    const bases = [`repo:${props.repo}`]
    if (props.ownerId && props.repoId) {
      bases.push(`repo:${owner}@${props.ownerId}/${name}@${props.repoId}`)
    }

    // Each base gets both a `ref:refs/heads/main` and a `pull_request` form:
    // `deploy.yml` runs on pushes to `main`, `pr-preview.yml` and
    // `pr-teardown.yml` run on pull_request events. A PR from a fork still
    // gets nothing — GitHub refuses `id-token: write` to fork PRs, so the
    // workflow cannot mint a token to present at all.
    const subjects = bases.flatMap((base) => [
      `${base}:ref:refs/heads/main`,
      `${base}:pull_request`,
    ])

    const role = new iam.Role(this, 'Role', {
      roleName: props.roleName,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': subjects,
        },
      }),
    })
    this.role = role

    // The role's only inherent power is to become the CDK bootstrap roles.
    // Every real permission — S3, CloudFront, Lambda, Route53 — belongs to
    // those, so this role grants nothing on its own and needs no revision
    // when a stack grows.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${account}:role/cdk-hnb659fds-*-${account}-${region}`],
      }),
    )

    // `cleanup.yml`'s sweeper talks to CloudFormation directly rather than
    // through CDK, so it needs the stack list from AWS itself, not from any
    // app it could synthesize. `ListStacks` supports no resource-level
    // permissions, hence the `*` — it is read-only and returns names, which
    // is all the sweep needs to decide what else to look at.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:ListStacks'],
        resources: ['*'],
      }),
    )

    // Scoping `DescribeStacks`/`DeleteStack` to `<stackPrefix>-pr-*` is what
    // makes IAM, not a shell loop, the thing that keeps `pr-teardown.yml` and
    // the sweeper away from every other stack in the account — including the
    // three other production sites. A bug in, or a rewrite of, the workflow's
    // own prefix filter still cannot reach them.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks', 'cloudformation:DeleteStack'],
        resources: [
          `arn:aws:cloudformation:${region}:${account}:stack/${props.stackPrefix}-pr-*`,
        ],
      }),
    )

    // The sweeper and `pr-teardown.yml` both read `PreviewSite`'s published
    // SSM parameters (bucket name, KVS ARN, ...) to know what to clean up,
    // the same way `PreviewDeployment` does.
    const parameterPrefix = previewParameterPrefix(props.domain)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        // An SSM parameter ARN is `.../parameter/cdk-core/<domain>/preview/*`;
        // `parameterPrefix` already starts with `/`, so no second one is added
        // between `parameter` and the prefix.
        resources: [`arn:aws:ssm:${region}:${account}:parameter${parameterPrefix}/*`],
      }),
    )

    // The KVS ARN and the preview bucket name are not known at synth time —
    // they are created by `PreviewSite`, a separate stack this one takes no
    // construct reference to. `valueFromLookup` is a synth-time context
    // lookup: it shells out (via the CDK CLI's context provider) to read the
    // real parameter value once and caches it as a literal in
    // `infra/cdk.context.json`, which is committed. That literal is required
    // here because `valueForStringParameter` returns a deploy-time
    // `{{resolve:ssm:...}}` token, which cannot appear inside an IAM resource
    // ARN. The cost is that the very first synth on a machine with no cached
    // context returns CDK's `dummy-value-for-...` placeholder instead of the
    // real value, until the lookup has actually run once (e.g. via `cdk
    // synth` with real credentials).
    const kvsArn = ssm.StringParameter.valueFromLookup(
      this,
      `${parameterPrefix}/kvsArn`,
    )
    const bucketName = ssm.StringParameter.valueFromLookup(
      this,
      `${parameterPrefix}/bucketName`,
    )

    // The sweeper and `pr-teardown.yml` remove a closed PR's route from the
    // shared KeyValueStore.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudfront-keyvaluestore:DescribeKeyValueStore',
          'cloudfront-keyvaluestore:ListKeys',
          'cloudfront-keyvaluestore:DeleteKey',
          'cloudfront-keyvaluestore:UpdateKeys',
        ],
        resources: [kvsArn],
      }),
    )

    // And they remove that PR's `pr-<n>/` prefix from the shared preview
    // bucket. `ListBucket` is a bucket-level action (needed to enumerate the
    // prefix); `DeleteObject` is object-level and so is scoped to `/*`.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [`arn:aws:s3:::${bucketName}`],
      }),
    )
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject'],
        resources: [`arn:aws:s3:::${bucketName}/*`],
      }),
    )

    new CfnOutput(this, 'RoleArn', { value: role.roleArn })
  }
}
