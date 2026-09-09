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
- **`pr-preview.yml`'s comment embeds a QR of the preview URL as an `api.qrserver.com` image**,
  so the preview is a scan away on a phone. A hosted image is the only form that works: GitHub
  strips `data:` URIs and inline `<svg>` from comments. Camo proxies and caches it, so an
  existing comment survives the service going away, and it renders in the GitHub mobile app.
  `qzone=2` is not optional — without a quiet zone the code sits flush against the page
  background and scanners fail in dark mode. Re-check the service with `curl -sSI` on the
  rendered URL, expecting `200` and `image/png`; a broken image in a *new* comment is that
  service, not the preview.
- `actionlint .github/workflows/*.yml` before committing one. Its embedded shellcheck is why
  `"$PR"` is quoted everywhere.

## Proving the sweeper still deletes (A8)

It deletes nothing on a healthy account, so a green run says nothing. To re-prove it, break the
account on purpose: `cdk deploy CdkCore-pr-<n> --exclusively -c pr=<n>` for an **already-closed**
PR number, and separately hand-write a KVS key and a `pr-<m>/` S3 object under a *different*
closed PR. Both halves are needed — a stack delete removes its own key and prefix, so an
orphaned stack alone exercises one of the four paths and hides the others.

**Log groups are the fourth path (issue #12), and re-proving them needs an *invoke*, not just a
deploy.** Lambda creates `/aws/lambda/<function-name>` on first invoke, so deploying a PR stack
alone produces only the ~3 deploy-time custom-resource groups; run `scripts/verify-preview.sh
<n>` against it to make `ApiFn`/`EventsFn` materialize theirs (~5 total). Then `delete-stack` —
which leaves every one of them behind, since CloudFormation never owned them — and sweep. The
groups are the one resource a stack delete does *not* take with it, so unlike the KVS key and
the S3 prefix, an orphaned stack is a perfectly good fixture for this path.

**`pnpm --filter infra exec cdk-core sweep` prints a bare `undefined` after the table** whenever
the sweep exits non-zero. That is pnpm's error reporting, not the sweeper; `node
packages/cdk-core/dist/bin/sweep.js sweep ...` is clean. Nobody saw it for three epochs because
every live run printed `(nothing to reconcile)` and exited 0.

## The registry lags a green publish

`v0.1.1` published through `publish.yml` with provenance, and for several minutes afterwards
`registry.npmjs.org/@tylerschloesser/cdk-core/0.1.1` still answered **404** — pnpm's
`✅ Published` line at 03:56:45 against the registry's own recorded publish time of 03:59:22,
and readable later still. Checked against the raw packument, not the npm CLI, and it 404s
either way. **Do not conclude a publish failed from a 404 taken minutes after a green run**;
confirm before retrying, because the version number is spent regardless and a retry has to bump.

```
curl -fsS https://registry.npmjs.org/<pkg>/<version> > /dev/null && echo live
```

There is a permanent version of this symptom worth knowing: npm **staged publishing**. A
trusted publisher can be configured stage-only, which accepts a version and holds it hidden
until a maintainer runs `npm stage approve` — proof of presence required, so **no workflow can
ever complete a stage-only publish**. This repo's publisher is not stage-only.

Two things about the npm the workflow installs. `npm install -g npm@latest` now resolves to
**npm 12**, whose engine range is `^22.22.2 || ^24.15.0 || >=26.0.0` — it works because
`setup-node`'s `node-version: 22` gives a recent 22.x, but pinning an older node would break
that step, and that step is what makes OIDC publishing work at all. And `npm stage` only exists
from npm 12, so a local npm 11 answers `Unknown command: "stage"`; use `npx -y npm@latest`.

**`--provenance` is undocumented in `pnpm publish --help` but works** — 0.1.1 carries a SLSA
provenance attestation.

## The things that bit

1. **The deploy role trusts `ref:refs/heads/main` and `pull_request`, and nothing else.** A
    `workflow_dispatch` from any other branch is refused at `sts:AssumeRoleWithWebIdentity`
    with `Not authorized to perform sts:AssumeRoleWithWebIdentity`. Testing a workflow change
    from a branch therefore does not work; open a PR, or change the trust policy on purpose.
2. **`cloudformation:DeleteStack` is IAM-scoped to `stack/CdkCore-pr-*`, and
    `logs:DeleteLogGroup` to `log-group:/aws/lambda/CdkCore-pr-*`.** Verified with
    `aws iam simulate-principal-policy`: **implicitDeny** on `YahnAppStack-prod`,
    `ThaiLerDevSiteStack`, `CDKToolkit` and `CdkCoreSite`; **allowed** only on a PR stack.
    Same simulate for `logs:DeleteLogGroup` after issue #12: **allowed** on
    `log-group:/aws/lambda/CdkCore-pr-11-ApiFn` (and on its `…:*` form — the ARN-suffix
    variant is *not* needed as a second resource), **implicitDeny** on the live
    `/aws/lambda/CdkCoreSite-ApiFnE0725F78-…` and
    `/aws/lambda/CdkCorePreview-PreviewPoolUserHandler6CDD0623-…`. `logs:DescribeLogGroups` is
    `*` on purpose — read-only, returns names, no resource-level permissions — mirroring
    `cloudformation:ListStacks`.
    That is the guard that survives someone rewriting the sweeper or a workflow, so re-run the
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

