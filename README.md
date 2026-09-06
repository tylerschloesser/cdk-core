# cdk-core

Shared AWS CDK constructs and Claude Code skills for personal websites that need a Vite SPA,
path-mounted Hono backends, server-sent events, Google sign-in, and cheap per-PR preview
environments on one CloudFront distribution per site.

Status: **Epoch 1** — the monorepo, the reference app and the local loop exist; the constructs
are types with throwing bodies. Nothing is deployed and nothing is published yet. `plan.md`'s
Status block is the source of truth for what is real; `docs/prior-art.md` says where the design
came from.

## Getting started

```sh
pnpm install
pnpm --filter e2e exec playwright install chromium   # once, for `pnpm e2e`
pnpm dev      # http://localhost:5173, API on :3001, SSE on :3002
pnpm verify   # lint + typecheck + test + build
pnpm e2e      # Playwright against the local stack
```

`pnpm dev`, `pnpm verify` and `pnpm e2e` never touch AWS and need no credentials. That is a
property worth keeping: it is what lets a change be verified end to end before a PR exists.

To run the same e2e suite against a deployed preview instead of localhost:

```sh
PLAYWRIGHT_BASE_URL=https://pr-12.preview.cdk-core.ty.ler.dev pnpm e2e
```

## Layout

| Path | What |
| --- | --- |
| `packages/cdk-core` | `@tylerschloesser/cdk-core`: `Site`, `PreviewSite`, `PreviewDeployment`, `GithubDeployRole`, `siteCertificate`, `auth/browser`, `auth/server`, the `cdk-core sweep` CLI |
| `apps/web` | the reference SPA — ping, echo (a POST with a body), an SSE stream, dev login |
| `apps/api` | two Hono apps: a buffered API on `:3001` and a streaming one on `:3002`, mirroring two CloudFront behaviors and two Lambdas |
| `e2e` | Playwright; one config, two targets |
| `docs` | `prior-art.md`, `research/`, and later `spikes/` |

The reference site deploys to `cdk-core.ty.ler.dev` and dogfoods PR previews on this repo
(Epochs 2–3). A Claude Code plugin with the `preview`, `preview-auth` and `new-site` skills
lands in Epoch 5.

## How work happens here

One epoch per Claude session: `/epoch <n>` to start, `/handoff` to finish. `plan.md` is the
spec, `progress.md` the log, `CLAUDE.md` and `.claude/rules/` the invariants.
