# cdk-core

Shared AWS CDK constructs and Claude Code skills for personal websites that need a Vite SPA,
path-mounted Hono backends, server-sent events, Google sign-in, and cheap per-PR preview
environments on one CloudFront distribution per site.

Status: **Epochs 0–3 are done.** Every construct is real (`siteCertificate`, `Site`,
`PreviewSite`, `PreviewDeployment`, `GithubDeployRole`) and `cdk-core sweep` works.
`https://cdk-core.ty.ler.dev` is **live**, deployed by `deploy.yml`. Every PR on this repo gets
a preview at `https://pr-<n>.preview.cdk-core.ty.ler.dev`, its e2e runs against it, and closing
the PR tears it down. Still to come: Google auth (Epoch 4) and the npm publish plus the Claude
Code plugin skills (Epoch 5). `plan.md`'s Status block is the source of truth for what is real;
`docs/prior-art.md` says where the design came from.

## Getting started

```sh
pnpm install
pnpm --filter e2e exec playwright install chromium   # once, for `pnpm e2e`
pnpm dev      # http://localhost:5173, API on :3001, SSE on :3002
pnpm verify   # lint + typecheck + test + build
pnpm e2e      # Playwright against the local stack
```

`pnpm install` also builds `packages/cdk-core` (it has a `prepare` script), because pnpm only
links the `cdk-core` bin if the bin's target already exists at install time.

`pnpm dev`, `pnpm verify` and `pnpm e2e` never touch AWS and need no credentials. That is a
property worth keeping: it is what lets a change be verified end to end before a PR exists.

To run the same e2e suite against a deployed preview instead of localhost:

```sh
PLAYWRIGHT_BASE_URL=https://pr-12.preview.cdk-core.ty.ler.dev pnpm e2e
```

## Deploying

| Stack | Deployed by | Holds |
| --- | --- | --- |
| `CdkCoreShared` | `deploy.yml`, and by hand | the one ACM certificate, `cdk-core.ty.ler.dev` + `*.preview.cdk-core.ty.ler.dev` |
| `CdkCoreSite` | `deploy.yml` on push to `main` | the production bucket, distribution, SPA function and apex DNS |
| `CdkCorePreview` | `deploy.yml` (it rarely changes) | the shared preview bucket, KeyValueStore, router function, distribution and wildcard DNS |
| `CdkCore-pr-<n>` | `pr-preview.yml`, one per open PR | that PR's two Lambdas and its `PreviewDeployment` |
| `CdkCoreGithubOidc` | **by hand, once** | `GithubDeployRole` — the role every workflow assumes |

The workflows:

- `ci.yml` — credential-free, on every PR: `pnpm verify` and `pnpm e2e` against `pnpm dev`.
- `deploy.yml` — push to `main` or dispatch: verify, local e2e, deploy the three permanent
  stacks, wait for `/api/ping`, then e2e against production.
- `pr-preview.yml` — deploys the PR's stack, polls the preview, runs e2e against it, and
  sticky-comments the URL and timings on the PR.
- `pr-teardown.yml` — on close: `delete-stack`, nothing else. No checkout and no CDK, so a PR
  whose branch no longer builds still tears down.
- `cleanup.yml` — daily: runs `cdk-core sweep`.

`CdkCoreGithubOidc` is deployed by hand because a workflow cannot grant itself the trust it
needs to run — the role has to exist, and be assumable, before any workflow can authenticate.
These only need running again if the role's permissions change:

```sh
AWS_PROFILE=admin pnpm --filter infra exec cdk deploy CdkCoreGithubOidc --require-approval never
gh variable set AWS_DEPLOY_ROLE_ARN --body arn:aws:iam::063257577013:role/cdk-core-github-deploy
```

The sweeper:

```sh
AWS_PROFILE=admin pnpm --filter infra exec cdk-core sweep \
  --site cdk-core.ty.ler.dev --stack-prefix CdkCore --repo tylerschloesser/cdk-core --dry-run
```

`--dry-run` deletes nothing and exits non-zero if it *would* delete something, so a green dry
run is a positive statement that the account is clean.

**`pnpm build` must run before any `cdk` command, `destroy` included** — the constructs read
`apps/web/dist` and `packages/cdk-core/dist/handlers/` at synth time, so a CDK command against
a clean tree fails on a missing directory.

## Layout

| Path | What |
| --- | --- |
| `packages/cdk-core` | `@tylerschloesser/cdk-core`: `Site`, `PreviewSite`, `PreviewDeployment`, `GithubDeployRole`, `siteCertificate`, `auth/browser`, `auth/server`, the `cdk-core sweep` CLI |
| `apps/web` | the reference SPA — ping, echo (a POST with a body), an SSE stream, dev login |
| `apps/api` | two Hono apps: a buffered API on `:3001` and a streaming one on `:3002`, mirroring two CloudFront behaviors and two Lambdas |
| `e2e` | Playwright; one config, two targets |
| `docs` | `prior-art.md`, `research/`, `spikes/` |
| `plugins` | the Claude Code plugin — currently the workflow templates the `new-site` skill will use in Epoch 5 |

The reference site deploys to `cdk-core.ty.ler.dev` and dogfoods PR previews on this repo
(Epochs 2–3 built the previews, Epoch 3 wired the workflows). A Claude Code plugin with the
`preview`, `preview-auth` and `new-site` skills lands in Epoch 5.

## How work happens here

One epoch per Claude session: `/epoch <n>` to start, `/handoff` to finish. `plan.md` is the
spec, `progress.md` the log, `CLAUDE.md` and `.claude/rules/` the invariants.

