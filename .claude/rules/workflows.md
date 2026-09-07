---
paths:
  - ".github/workflows/**"
  - "plugins/cdk-core/skills/new-site/templates/**"
  - "packages/cdk-core/src/github-deploy-role.ts"
  - "packages/cdk-core/src/sweep/**"
---

# Workflows, the deploy role, and the sweeper

Loaded when you touch a workflow, a workflow template, the OIDC role or the sweeper. The CDK
side of all this — stacks, the router, origins — is `.claude/rules/cdk.md`, KVS writes are
`.claude/rules/streaming-and-kvs.md`, and the user pools are `.claude/rules/auth.md`.

## The five workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | every PR | `pnpm verify` + `pnpm e2e` against `pnpm dev`. **No credentials**, and the only one with `cancel-in-progress: true` |
| `deploy.yml` | push to `main`, dispatch | verify, local e2e, deploy `CdkCoreShared CdkCorePreview CdkCoreSite`, poll `/api/ping`, e2e against production |
| `pr-preview.yml` | PR opened/synchronize/reopened | `cdk deploy CdkCore-pr-$PR --exclusively -c pr=$PR`, poll the preview, e2e, sticky comment with URL + timings |
| `pr-teardown.yml` | PR closed | `delete-stack`, no wait. No checkout, no build, no CDK |
| `cleanup.yml` | daily cron, dispatch | `pnpm --filter infra exec cdk-core sweep` |

- **Everything that touches CloudFormation is `cancel-in-progress: false`**, and
  `pr-teardown.yml` shares `pr-preview.yml`'s concurrency group so a close can never race a
  deploy for the same PR. Cancelling a job does not cancel the CloudFormation operation it
  started; the next run would hit a stack stuck `UPDATE_IN_PROGRESS`.
- **Adding a workflow means adding a template** under
  `plugins/cdk-core/skills/new-site/templates/`, or `test/workflow-templates.test.ts` fails.
  It renders each template with this repo's values and asserts **byte** equality, and it pairs
  the two directories by "the workflow requests `id-token: write`" — which is what
  distinguishes an AWS-touching workflow from `ci.yml`.
- **`deploy.yml` runs on every push to `main`**, so merging an epoch branch deploys production.
  A broken `main` is a broken prod site.
- `actionlint .github/workflows/*.yml` before committing one. Its embedded shellcheck is why
  `"$PR"` is quoted everywhere.

## The things that bit

1. **The deploy role trusts `ref:refs/heads/main` and `pull_request`, and nothing else.** A
    `workflow_dispatch` from any other branch is refused at `sts:AssumeRoleWithWebIdentity`
    with `Not authorized to perform sts:AssumeRoleWithWebIdentity`. Testing a workflow change
    from a branch therefore does not work; open a PR, or change the trust policy on purpose.
2. **`cloudformation:DeleteStack` is IAM-scoped to `stack/CdkCore-pr-*`.** Verified with
    `aws iam simulate-principal-policy`: **implicitDeny** on `YahnAppStack-prod`,
    `ThaiLerDevSiteStack`, `CDKToolkit` and `CdkCoreSite`; **allowed** only on a PR stack. That
    is the guard that survives someone rewriting the sweeper or a workflow, so re-run the
    simulate if the role's policy changes.
3. **`pr-teardown.yml` has no checkout, so `gh` needs `GH_REPO`.** With no git remote,
    `gh pr comment` exits 1 with `failed to run git: fatal: not a git repository` — after the
    `delete-stack` has already succeeded, so the stack goes but the run is red. Having no
    checkout is the point (a PR whose branch no longer builds still has to tear down), so do
    not "fix" this by adding a checkout step.
4. **The role reads exactly one secret.** `pr-preview.yml` runs the e2e suite against the
    deployed preview, and the machine-auth fixture signs in as the preview pool's `claude`
    user — so the role has `secretsmanager:GetSecretValue` on
    `secret:<domain>/preview-machine-user-*` (the trailing `-*` is Secrets Manager's own ARN
    suffix, not a widening). `cognito-idp:InitiateAuth` is deliberately *not* granted:
    `InitiateAuth` is unauthenticated and the fixture calls it `--no-sign-request`.
5. **`CdkCoreGithubOidc` synthesizes on every CDK command**, CI included, and does two SSM
    lookups (`kvsArn`, `bucketName`) cached in the committed `infra/cdk.context.json`. If
    `CdkCorePreview` is ever recreated those values change and the file goes stale — the role
    ends up scoped to a dead ARN and the sweeper starts getting `AccessDenied`. Delete the two
    entries and re-synth with credentials.
6. **`Site`'s two `BucketDeployment`s have asymmetric `prune`** — `true` on the hashed half
    (with the unversioned globs excluded), `false` on the unversioned half. `true` on the
    second deletes every hashed asset the first just uploaded, because it only *includes* those
    globs.

