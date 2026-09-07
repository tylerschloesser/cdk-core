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

## Proving the sweeper still deletes (A8)

It deletes nothing on a healthy account, so a green run says nothing. To re-prove it, break the
account on purpose: `cdk deploy CdkCore-pr-<n> --exclusively -c pr=<n>` for an **already-closed**
PR number, and separately hand-write a KVS key and a `pr-<m>/` S3 object under a *different*
closed PR. Both halves are needed — a stack delete removes its own key and prefix, so an
orphaned stack alone exercises one of the three paths and hides the other two.

**`pnpm --filter infra exec cdk-core sweep` prints a bare `undefined` after the table** whenever
the sweep exits non-zero. That is pnpm's error reporting, not the sweeper; `node
packages/cdk-core/dist/bin/sweep.js sweep ...` is clean. Nobody saw it for three epochs because
every live run printed `(nothing to reconcile)` and exited 0.

## A green publish run is not a published version

`v0.1.1` ran `publish.yml` to success — OIDC exchange 200, tag guard passed,
`consumer-smoke.sh --pack` passed, `✅ Published package @tylerschloesser/cdk-core@0.1.1` — and
the registry 404s for that version. npm **staged publishing** is the likely reason: a trusted
publisher can be configured stage-only, which accepts the version and holds it hidden until a
maintainer runs `npm stage approve`. That approval requires proof of presence, so **no workflow
can ever complete a stage-only publish**, and no amount of CI green will tell you.

Always confirm the tarball landed before believing a publish:

```
curl -fsS https://registry.npmjs.org/<pkg>/<version> > /dev/null && echo live
```

The version number is spent either way — a retry has to bump.

Two things about the npm the workflow installs. `npm install -g npm@latest` now resolves to
**npm 12**, whose engine range is `^22.22.2 || ^24.15.0 || >=26.0.0` — it works because
`setup-node`'s `node-version: 22` gives a recent 22.x, but pinning an older node would break
that step. And `npm stage` only exists from npm 12, so approving a staged release locally needs
`npx -y npm@latest stage list <pkg>` unless the local npm is current; `npm stage approve` takes
the **stage id** from that listing, not a package spec.

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

