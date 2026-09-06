# cdk-core

Shared AWS CDK constructs and Claude Code skills for personal websites that need a Vite
SPA, path-mounted Hono backends, server-sent events, Google sign-in, and cheap per-PR preview
environments on one CloudFront distribution per site.

Status: **planning complete, nothing built yet.** Read `plan.md` — its Status block is the
source of truth — and `docs/prior-art.md` for where the design comes from. Work happens one
epoch per Claude session: `/epoch <n>` to start, `/handoff` to finish.

Will contain, once built:

- `packages/cdk-core` → `@tylerschloesser/cdk-core` on npm: `Site`, `PreviewSite`,
  `PreviewDeployment`, `GithubDeployRole`, `siteCertificate`, `auth/browser`, `auth/server`,
  and the `cdk-core sweep` CLI.
- `plugins/cdk-core`: a Claude Code plugin (this repo is the marketplace) with the
  `preview`, `preview-auth`, and `new-site` skills.
- `apps/web`, `apps/api`, `infra`, `e2e`: the reference site at `cdk-core.ty.ler.dev`.
