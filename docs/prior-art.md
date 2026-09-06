# Prior art: thai.ler.dev vs yahn.ty.ler.dev

Both repos already implement per-PR previews, and both were built by Claude sessions in
September 2026 with the same conventions (pnpm catalog, oxlint, no formatter, `.claude/rules/`
with `paths`, sonnet `implementer`/`verifier` agents). They have diverged in the parts that
matter here. This document is the comparison behind the decisions in `plan.md`; it was written
2026-09-06 from a read of both trees.

## Shape at a glance

| | thai.ler.dev | yahn.ty.ler.dev |
| --- | --- | --- |
| Permanent stacks | `SharedStack` (cert), `SiteStack` (prod), `GithubOidcStack` | `SharedStack` (cert), `AppStack-prod`, `GithubOidcStack` |
| Preview stack | `PreviewStack` class, `ThaiLerDevPreview<n>Stack` | same `AppStack` class, `YahnAppStack-pr-<n>` |
| What a preview is | **a full CloudFront distribution + bucket + DNS per PR**; API is either prod's (`frontend` mode) or its own (`full-stack`) | **a full clone of everything per PR**: bucket, 2 Lambdas, table, distribution, DNS |
| Preview trigger | opt-in by label (`preview:frontend` / `preview:full-stack`) | every PR, automatically |
| Preview hostname | `pr-<n>.thai.ler.dev` | `pr-<n>.yahn.ty.ler.dev` |
| Certificate | one wildcard, `CfnOutput`+`Fn.importValue` (weak refs) | one wildcard, **ARN hard-coded** in `bin/app.ts` |
| OIDC provider | creates it (first in account) | imports it |
| Teardown | `aws cloudformation delete-stack` directly, no build, no wait | `cdk destroy` (needs a build), same concurrency group as deploy |
| Orphan sweeper | **none** (stack is tagged `thai-ler-dev:pr` for a janitor that was never written) | **`cleanup.yml`, daily** |
| Preview e2e | none (CI e2e is local-only) | Playwright against the preview after a `/api/health` gate |
| SSE | none (async worker + 3 s polling) | **proven**: `streamHandle` → `RESPONSE_STREAM` URL → `CACHING_DISABLED`, `readTimeout` 60 s |
| API caching | `CACHING_DISABLED` | custom policy, `defaultTtl 0 / maxTtl 300`, origin decides |
| Auth | seam only (`getUserId`, `x-id-token`, `AUTH=header` locally) | seam only (`getUserId` returns `null`) |
| Local dev | in-process API, memory store, fake model, header auth | in-process API, two ports mirroring two behaviors, no credentials |
| Measured timings | frontend preview 4m44s, full-stack 3m32s | create ~6 min (CloudFront ~4 of it), destroy ~4 min |

Shared, identical in both, and carried forward as-is:

- Everything in `us-east-1`; `env` explicit; `admin` profile has no default region.
- S3 with OAC, two `BucketDeployment`s (hashed assets `immutable` + `prune`, HTML `no-cache` +
  invalidation, explicit dependency), SPA fallback as a CloudFront **Function** on the default
  behavior only, `ALL_VIEWER_EXCEPT_HOST_HEADER`, `PRICE_CLASS_100`, HTTP2+3, IPv6.
- Lambda function URL origins with OAC, `AWS_IAM` auth, plus the explicit
  `lambda:InvokeFunction` grant (aws/aws-cdk#35872).
- `esbuild` as a root devDependency so `NodejsFunction` bundles without Docker.
- GitHub OIDC deploy role whose only broad power is assuming the CDK bootstrap roles, with
  `DeleteStack` scoped to the preview prefix; both `sub` forms in the trust policy.
- `pull_request.head.repo.full_name == github.repository` guard; fork PRs get nothing.
- `cancel-in-progress: false` on anything that touches CloudFormation.
- Sticky PR comment via `gh pr comment --edit-last --create-if-none`.

## What thai does that yahn doesn't

1. **Two preview modes.** `frontend` (bucket + distribution only, `/api/*` at *production*) and
   `full-stack`. Mode by label, conflict job fails on both labels. The frontend mode reuses a
   production function URL across stacks via a stub `ImportedFunctionUrl`, proving the OAC
   permission can live in the distribution's stack, not the function's.
2. **Opt-in previews** rather than every PR. Cheaper when previews are expensive; the new design
   makes previews cheap enough that yahn's every-PR default is the better trade.
3. **Teardown by raw `delete-stack`**, no checkout or build, with a `describe-stacks` look-before-
   comment. Faster and survives a PR whose branch no longer builds.
4. **Seeding a preview's data** after deploy from an absolute `--outputs-file`, and
   `-c modelProvider=fake` so a preview never spends real tokens.
5. **`--exclusively`** on preview deploys so a PR run can never touch a dependency stack.
6. **Stack-level tags** for a janitor (`this.tags.setTag`, not only `Tags.of`).
7. **e2e against a built app under `vite preview`** so the service worker is real.
8. A `verify-offline` skill and `research-issue` skill.

## What yahn does that thai doesn't

1. **`cleanup.yml`, the orphan sweeper.** Daily cron. Lists CloudFormation stacks by prefix,
   requires an anchored `^[0-9]+$` suffix, asks `gh pr view` for the PR state, deletes only
   `CLOSED`/`MERGED`, keeps sweeping past a failure and exits red at the end. The deploy role's
   `DeleteStack` is IAM-scoped to the prefix, so the guard survives a rewrite of the shell loop.
   **This is kept, and generalized, in `plan.md`.**
2. **SSE through CloudFront, measured.** Hono `streamHandle`, `RESPONSE_STREAM` function URL,
   `CACHING_DISABLED`, `readTimeout` 60 s, keepalive before model work, `compress: false`
   (measured a no-op: CloudFront does not compress `text/event-stream`), and the finding that a
   POST body under OAC needs `x-amz-content-sha256` so the streaming endpoint is a GET.
3. **Preview e2e in CI.** `pr-preview.yml` waits for `/api/health` (DNS propagation), installs
   chromium, runs the same Playwright suite with `PLAYWRIGHT_BASE_URL`, and the sticky comment
   reports deploy + e2e status.
4. **One Playwright config, two targets**, and a `pnpm verify` that never touches AWS.
5. **Origin-decides caching** for the API (`defaultTtl: 0`, `maxTtl: 300`, `no-store` on every
   non-2xx).
6. **Imports the OIDC provider** instead of creating it (the account already has one).
7. **Deploy role carries `ListStacks`** so the sweeper can see CloudFormation without CDK.
8. A cheaper, faster local loop: vitest for pure logic, structural-not-content Playwright.

## What neither does, and this design adds

- A **shared preview distribution** per site, routed by CloudFront Function + KeyValueStore.
  Both repos pay ~4 minutes of CloudFront creation per PR and 5–15 minutes of deletion. The
  new design pays that once.
- **Wildcard DNS** for previews, so no per-PR record and no NXDOMAIN gate.
- **Auth** (Cognito + Google) with a preview-safe callback and a machine login path.
- An **orphan check for the routing table and bucket prefixes**, not only stacks.
- **Claude skills** describing all of the above so a consumer repo does not re-learn it.

## Recommendation

Standardize on yahn's *lifecycle* (every PR gets a preview, three workflows, daily sweeper,
preview e2e in CI, `pnpm verify` credential-free) and thai's *mechanics* where they are better
(raw `delete-stack` teardown with a look-before-comment, `--exclusively`, stack tags, seeding
after deploy from an outputs file), on top of a new *topology* (one distribution per site,
KVS-routed). Drop thai's two-mode labels: the new preview is always full-stack because the
shared layer makes a full stack cheap, and pointing a preview at production data was only
ever a cost workaround. Keep the `frontend`-at-prod capability expressible by letting a PR
stack pass any function URL it likes as a backend, including an imported production one.
