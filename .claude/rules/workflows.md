---
paths:
  - ".github/workflows/**"
  - "plugins/cdk-core/skills/new-site/templates/workflows/**"
  - "packages/cdk-core/src/github-deploy-role.ts"
  - "packages/cdk-core/src/sweep/**"
---

# Workflows, the deploy role, and the sweeper

Loaded when you touch a workflow, a workflow template, the OIDC role or the sweeper. The CDK
side of all this — stacks, the router, origins — is `.claude/rules/cdk.md`, KVS writes are
`.claude/rules/streaming-and-kvs.md`, and the user pools are `.claude/rules/auth.md`.

## The six workflows

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | every PR | `pnpm verify` + `pnpm e2e` against `pnpm dev`. **No credentials**, and the only one with `cancel-in-progress: true` |
| `deploy.yml` | push to `main`, dispatch | verify, local e2e, deploy `CdkCoreShared CdkCorePreview CdkCoreSite`, poll `/api/ping`, e2e against production |
| `pr-preview.yml` | PR opened/synchronize/reopened | `cdk deploy CdkCore-pr-$PR --exclusively -c pr=$PR`, poll the preview, e2e, sticky comment with URL + timings |
| `pr-teardown.yml` | PR closed | `delete-stack`, no wait. No checkout, no build, no CDK |
| `cleanup.yml` | daily cron, dispatch | `pnpm --filter infra exec cdk-core sweep` |
| `publish.yml` | push of tag `v*`, dispatch with `dry_run` | verify tag matches `package.json` version, `pnpm verify`, `consumer-smoke.sh --pack`, `pnpm publish --provenance --no-git-checks` to npm via OIDC. **No AWS**, and the only one authenticating to npm instead |

- **Everything that touches CloudFormation is `cancel-in-progress: false`**, and
  `pr-teardown.yml` shares `pr-preview.yml`'s concurrency group so a close can never race a
  deploy for the same PR. Cancelling a job does not cancel the CloudFormation operation it
  started; the next run would hit a stack stuck `UPDATE_IN_PROGRESS`.
- **Adding a workflow means adding a template** under
  `plugins/cdk-core/skills/new-site/templates/workflows/`, or `test/workflow-templates.test.ts` fails.
  It renders each template with this repo's values and asserts **byte** equality, and it pairs
  the two directories by "the workflow requests `id-token: write`" — which is what
  distinguishes a workflow that authenticates by OIDC (to AWS, or to npm for `publish.yml`)
  from `ci.yml`, the one workflow with no OIDC exchange at all.
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
7. **`publish.yml`'s filename is pinned by npm's trusted-publisher config**, which is
    configured against a workflow *filename* on npmjs.com, not its contents. Renaming the file
    breaks publishing silently from this repo's side — the workflow still runs and still fails,
    but only at the npm OIDC exchange, far from whatever renamed it.
8. **`publish.yml` uses `pnpm publish`, never `npm publish`**, for the same `catalog:` reason
    as everywhere else in this repo (typescript-config.md) — plus `--no-git-checks`, because a
    tag checks out as a detached HEAD and pnpm's default publish-branch check assumes
    `master`, so without it every tag-triggered publish fails before touching npm.
9. **pnpm/pnpm#11513 (an OIDC 404 on publish) was an outdated `pnpm/action-setup`, not a pnpm
    bug** — fixed by upgrading the action, not by changing the publish command. This repo
    already pins `pnpm/action-setup@v6`; do not "fix" a future OIDC failure by downgrading it.

