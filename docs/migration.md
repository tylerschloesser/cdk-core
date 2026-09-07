# Migrating an existing site onto cdk-core

For a session working **inside** `thai.ler.dev` or `yahn.ty.ler.dev` (or any later site) that has
to plan a move onto `@tylerschloesser/cdk-core`. It is a planning document: it says what the
move consists of, what will fight you, and what each repo has to decide. It does not prescribe
an order of commits — that is the plan the session writes.

Written 2026-09-07 against `@tylerschloesser/cdk-core@0.1.1` and the state of both repos on that
date. Everything below was read from the repos or the account, not assumed. Where a claim is
inferred rather than measured, it says so.

The reference implementation of everything here is `cdk-core.ty.ler.dev` — this repo's own
`infra/bin/app.ts`, its five workflows, its `.claude/rules/`. When the doc and that repo
disagree, that repo is right and this doc is stale.

## Before you plan: read these

In `tylerschloesser/cdk-core` (public, so a session in another repo can fetch them):

- `plan.md` — the **Status block** first (what is true today, and the numbered `[revised]` list,
  which is the most settled part of it), then the **Construct API** and **D9/D10** for the
  hostname and asset-key schemes.
- `plugins/cdk-core/skills/new-site/SKILL.md` — the greenfield checklist. This document is the
  delta between that checklist and a site that already exists.
- `.claude/rules/cdk.md`, `workflows.md`, `streaming-and-kvs.md`, `auth.md` — the traps, each
  one paid for.
- Open issues. **#12 (log groups) affects every site the package onboards** — see below.

## What you are migrating to

Five stacks, composed by one function:

| Stack | Deployed by | Holds |
| --- | --- | --- |
| `<Prefix>Shared` | `deploy.yml`, and by hand first | the one ACM certificate |
| `<Prefix>Preview` | `deploy.yml` (rarely changes) | preview bucket, KVS, router function, preview distribution, wildcard DNS, SSM params, preview pool |
| `<Prefix>Site` | `deploy.yml` on `main` | prod bucket, distribution, apex DNS, prod pool, your backend Lambdas |
| `<Prefix>-pr-<n>` | `pr-preview.yml` per PR | `PreviewDeployment` + that PR's Lambdas |
| `<Prefix>GithubOidc` | **by hand, once** | the deploy role |

`defineSiteStacks()` builds all five from ~45 non-import lines. Previews stop being a stack
clone per PR and become **one shared preview distribution** whose CloudFront Function reads a
KeyValueStore keyed by hostname, rewriting assets to a `/pr-<n>/` prefix in a shared bucket and
re-pointing `/api/*` at that PR's Lambda URL. That is why a preview costs ~95 s instead of
~6 min, and why teardown is a stack delete plus a key delete.

## What the migration actually changes

1. **`infra/` collapses.** Both sites are ~650 lines of CDK; the replacement is `bin/app.ts` at
   roughly 45. Everything in `lib/` goes.
2. **Preview hostnames move one label**, from `pr-<n>.<site>` to `pr-<n>.preview.<site>`
   (D9). This forces a new certificate — see hazards.
3. **The certificate changes SANs**, from `[<site>, *.<site>]` to `[<site>, *.preview.<site>]`.
4. **Workflows are replaced** by the four templates under
   `plugins/cdk-core/skills/new-site/templates/workflows/` plus your own `ci.yml`. You gain
   `cleanup.yml` (the sweeper) and a real `pr-teardown.yml`.
5. **The deploy role is replaced** by `GithubDeployRole`, and `AWS_DEPLOY_ROLE_ARN` has to be
   repointed in the same change or CI loses AWS entirely.
6. **Auth is available but optional.** `defineSiteStacks`'s `auth` prop can be omitted
   entirely — "Omit for a site with no user pool." Neither site has a pool today, so a
   migration can land with auth off and add it later as its own piece of work.

What does **not** change: your `apps/`. Both sites call the API on same-origin relative paths,
which works identically under the new distribution. Neither needs `__config.json` until it wants
auth.

## Decisions the session has to make

Answer these before writing the plan; each one changes the shape of the work.

1. **Auth now, or later?** Landing without `auth` makes the migration a pure infrastructure
   swap and keeps the blast radius small. Adding it means a Cognito pool, a Google client
   redirect URI, the bounce host, and a browser flow neither app has today.
2. **What happens to the DynamoDB table?** Both sites keep real data in a `RemovalPolicy.RETAIN`
   table inside the site stack. Destroying that stack **orphans** the table — it is not deleted,
   and the new stack creates a different, empty one. Three options: accept the loss, `cdk import`
   the existing table into the new stack, or copy the rows. Decide deliberately; the default is
   silent data abandonment plus a table that keeps billing.
3. **Where do data constructs live now?** `defineSiteStacks` owns the five stacks. A table can be
   created inside the `functions` factory (it receives the stack scope), or in a sixth stack the
   repo defines itself. The factory is simpler; a separate stack survives a site-stack replace.
4. **Stack prefix and names.** New names mean CloudFormation builds fresh rather than trying to
   update the old stack into an incompatible shape. Whatever you choose propagates: the deploy
   role's `DeleteStack` scope is `stack/<Prefix>-pr-*`, and the sweeper's `--stack-prefix` must
   match, or the daily cleanup silently stops working.
5. **Which cdk-core version to pin**, and whether to wait for issue #12.
6. **Handoff mechanism.** Neither repo has `plan.md`/`progress.md`; both hand off through GitHub
   issues. The `epochs` plugin in this marketplace ships the plan/epoch/handoff loop if you want
   it. Not required, and not free — it is a different working style.

## Hazards, worst first

### 1. `ThaiLerDevGithubOidcStack` owns the account's GitHub OIDC provider

`infra/cdk/lib/github-oidc-stack.ts:10` calls `new iam.OpenIdConnectProvider(...)`. The account
confirms it: that stack holds `Custom::AWSCDKOpenIdConnectProvider` →
`oidc-provider/token.actions.githubusercontent.com`. Yahn's equivalent stack builds the ARN as a
string and imports it; so does cdk-core.

**Deleting that stack deletes the provider, and five roles across four repos stop being
assumable** — `thai-ler-dev-github-deploy`, `yahn-ty-ler-dev-github-deploy`,
`cdk-core-github-deploy`, `hrs-github-actions-deploy`, `hrs-website-deploy`. The last two deploy
Haitian Relief production.

This is not a thai-only problem: it is the reason the provider must be **orphaned before either
migration starts**, as its own small, reversible change. The shape: apply
`RemovalPolicy.RETAIN` to the provider's underlying `CfnResource`, deploy *that* change, confirm
the resource still lists under the stack with a retain policy, and only then delete the stack.
CloudFormation honours `DeletionPolicy: Retain` on custom resources by skipping the delete
handler. Verify afterwards with `aws iam list-open-id-connect-providers` **before** anything
else is destroyed. `GithubDeployRoleProps` already accepts `oidcProviderArn`, so nothing
downstream ever needs to create it again.

### 2. Two distributions cannot share an alias, so the cutover has downtime

CloudFront rejects a second distribution carrying an alias another one holds
(`CNAMEAlreadyExists`). `Site` always sets `domainNames`, and `safeDistributionOverrides()`
strips `domainNames` and `certificate` from any override — so you **cannot** stand the new site
up alongside the old one under the real hostname and swap.

The order is therefore forced: destroy the old site stack (which also removes its A/AAAA
records), then deploy the new one. Budget for the site being down for the length of a CloudFront
delete plus a create — the prior art measures a distribution create at ~4 min, and deletes are
slower. Both sites are new enough that this was judged acceptable; say so in the plan rather
than discovering it during the cutover.

### 3. The certificate has to be replaced, and cannot be deleted while in use

Old: `<site>` + `*.<site>`. New: `<site>` + `*.preview.<site>`. A wildcard covers exactly one
label, so the old certificate does not cover `pr-1.preview.<site>` and the new one does not
cover `pr-1.<site>`. New DNS validation records appear in the zone; the old ones become garbage.
An ACM certificate attached to a distribution cannot be deleted until that distribution is gone,
which is another reason the old site stack goes first.

Yahn additionally **hard-codes the certificate ARN** in `infra/cdk/bin/app.ts` rather than
importing it, so deleting `YahnSharedStack` breaks every yahn stack until that line changes.

### 4. Yahn's two backends have overlapping path prefixes and will not synth

`renderRouterSource` throws when one backend's derived prefix is a prefix of another's
(`packages/cdk-core/src/router/render.ts:111`). Yahn serves `/api/*` (buffered) and
`/api/v1/enrich/*` (streaming); `/api/` is a prefix of `/api/v1/enrich/`, so the router refuses
to render. CloudFront itself would pick the most specific behavior — this is cdk-core's
constraint, not CloudFront's, and it exists because a CloudFront Function cannot change which
behavior was selected.

So **yahn cannot migrate without re-rooting one of its two backends** — for example moving
enrichment to `/events/*`, which is what the reference site uses for its stream. That is a
visible change in `apps/api` routes, `apps/web`'s fetches, the Vite dev proxy and the e2e specs.
Plan it as its own chunk, landable and testable with no AWS at all, *before* the infrastructure
work.

Thai has a single `/api/*` backend and no such problem.

### 5. Thai's worker Lambda has no function URL, and the factory rejects it

`defineSiteStacks` throws if `functions` returns a Lambda whose key is not a routed backend
(`define-site-stacks.ts:172`). Thai's `Api` construct has two Lambdas: a request handler behind
a function URL, and a **worker** invoked asynchronously with a 10-minute timeout and no URL.

The workaround is straightforward and worth writing down: the `functions` factory receives the
stack scope, so the worker can be *created* inside it, wired, granted and referenced by the
request Lambda's environment — it simply must not be **returned**. Only routed backends go in
the returned record.

### 6. Both sites currently manage their Lambda log groups; cdk-core does not

Thai and yahn both create explicit `AWS::Logs::LogGroup` resources in their site stacks. cdk-core
does not, so Lambda creates them implicitly and nothing ever deletes them — that is **issue
#12**, ~5 orphaned never-expiring groups per PR stack. Migrating as things stand is a small
regression against what both repos already do correctly. Check #12's state before planning; if
it is fixed, pin a version that includes the fix.

### 7. `cdk.context.json` becomes required, and can go stale

`GithubDeployRole` reads the KVS ARN and preview bucket name with
`ssm.StringParameter.valueFromLookup`, because a `valueForStringParameter` dynamic reference
cannot appear inside an IAM resource ARN. That makes `infra/cdk.context.json` a **committed**
file. Neither repo has one today — both hard-code everything and deliberately avoid lookups.

If `<Prefix>Preview` is ever recreated, those cached values change, the role ends up scoped to a
dead ARN, and the sweeper starts failing with `AccessDenied`. The fix is to delete the two
entries and re-synth with credentials — worth writing into the repo's own rules.

### 8. Secrets

- The **Anthropic secret** (`thai-ler-dev/anthropic`, `yahn-ty-ler-dev/anthropic`) is hand-created
  and imported by name in both repos. It survives any teardown, and the replacement must import
  the identical name or the model calls silently fail.
- `PreviewSite` **creates** `<domain>/preview-machine-user`. If a migration is retried after a
  teardown, recreating a secret with a name still inside its recovery window fails; delete with
  `--force-delete-without-recovery` when you mean it.
- The **Google client secret** defaults to the shared name `cdk-core/google-oauth`
  (`user-pool.ts:24`), matching D4's one-client-for-all-sites decision — so an auth-enabled site
  needs no new secret. It is consumed as a CloudFormation dynamic reference, resolved at deploy
  time by the bootstrap execution role, which is why the deploy role's only secret grant is for
  the machine user. Verify that on the first auth-enabled deploy rather than trusting this
  paragraph.

### 9. Preview behaviour that has no equivalent

Thai's previews are **label-driven with two modes** (`preview:frontend` reuses production's API
and writes production data; `preview:full-stack` builds its own with a fake model). cdk-core has
one mode: a full preview stack per PR. The frontend mode disappears, and with it the sticky
comment that is the only place a human is warned about writing production data. Decide whether
that mode is wanted back; nothing in the package offers it.

Also: the two GitHub labels are repo state no code recreates, and thai's `preview.yml` carries
its teardown as an internal `destroy` job rather than a separate workflow.

### 10. Smaller things that will still cost an hour each

- **Node versions disagree.** Yahn pins node 24 in workflows with `NODEJS_24_X` Lambdas; thai
  and cdk-core use 22. Neither repo has `.nvmrc`, and both declare `engines.node: ">=22"`.
- **Both repos use pnpm `catalog:` with `catalogMode: prefer`**, so `@tylerschloesser/cdk-core`
  needs a catalog entry, and any manifest referencing it says `"catalog:"`. The package itself
  must never be packed with `npm` for the same reason.
- **Both sites' stacks throw at synth if `apps/web/dist` is missing**, so `pnpm build` precedes
  every CDK command including teardown. cdk-core has the same property.
- **The plugin's skills appear one session after `extraKnownMarketplaces` lands.** Register the
  marketplace, then start a new session. Do not debug the manifest.
- The `lambda:InvokeFunction`-alongside-`InvokeFunctionUrl` workaround, the
  `ALL_VIEWER_EXCEPT_HOST_HEADER` rule, the `x-amz-content-sha256` on POSTs, and the
  asymmetric-`prune` `BucketDeployment` pair are all already handled inside the package. Do not
  port the local versions; delete them and trust the constructs.

## A shape for the work

The useful property to design around: **everything up to the cutover is provable with no AWS
credentials.** `pnpm verify` plus `cdk synth` on all five stacks proves the code swap completely.
That keeps the irreversible window short.

- **Phase 0 — orphan the OIDC provider.** Account-wide, done once, before either site. Hazard 1.
- **Phase 1 — inventory and decide.** The six decisions above, written down.
- **Phase 2 — the offline swap.** Backend re-rooting where needed, `bin/app.ts`, workflows,
  catalog entry, `.claude/rules/` updates. Green `pnpm verify` and a clean `cdk synth` of all
  five stacks, with no credentials. Nothing has touched AWS yet.
- **Phase 3 — the cutover.** By hand, in order: destroy the old site stack, destroy the old
  shared stack, deploy `<Prefix>Shared <Prefix>Preview <Prefix>Site`, deploy `<Prefix>GithubOidc`
  by hand, repoint `AWS_DEPLOY_ROLE_ARN`.
- **Phase 4 — prove it.** `curl /api/ping` (or your health route); open a throwaway PR and watch
  `pr-preview.yml`; close it and watch `pr-teardown.yml`; then `verify-preview.sh <n>
  --expect-absent` and a `cdk-core sweep --dry-run` that exits 0.
- **Phase 5 — sweep the leftovers.** The old certificate, the old deploy role, the orphaned
  table decision from step 2, the old DNS validation records.

**Destroying anything requires explicit authorization in the plan.** Both repos carry the same
rule cdk-core does — never destroy a stack name you have not just read back from
`list-stacks`, and the account hosts other people's production. Yahn's `.claude/settings.json`
deliberately omits `cdk destroy` and `delete-stack` from its allowlist. Name the exact stacks in
the plan before the session starts, and re-read them from `list-stacks` at the moment of use.

## Where each site starts

Both are pnpm 11.25 monorepos with `catalog:`, `erasableSyntaxOnly` + `verbatimModuleSyntax`,
oxlint + stylelint, no formatter, no semicolons, single quotes — the same conventions as
cdk-core. Both have `.claude/rules/`, `implementer`/`verifier` agents, and hand off through
GitHub issues rather than a plan file. Neither has any Cognito, KVS, SSM parameter or budget.
Neither has a `cdk.context.json`.

| | `thai.ler.dev` | `yahn.ty.ler.dev` |
| --- | --- | --- |
| Zone | `ler.dev` | `ty.ler.dev` |
| Stacks | `ThaiLerDevSharedStack`, `ThaiLerDevSiteStack`, `ThaiLerDevGithubOidcStack` | `YahnSharedStack`, `YahnAppStack-prod`, `YahnGithubOidcStack` |
| Infra size | ~652 lines | ~614 lines |
| Backends | one, `/api/*` — **plus a URL-less worker** | two, `/api/*` and `/api/v1/enrich/*` — **overlapping** |
| Streaming | none; the client polls every 3 s | yes, `streamHandle` + SSE on the enrich URL |
| Preview today | per-PR stack at `pr-<n>.thai.ler.dev`, **label-driven, two modes** | per-PR stack at `pr-<n>.yahn.ty.ler.dev` |
| Teardown today | a `destroy` job inside `preview.yml` | `pr-teardown.yml` + a `cleanup.yml` cron |
| Durable data | DynamoDB, RETAIN **+ PITR**, all rows under `pk=USER#dev` | DynamoDB `EnrichTable`, RETAIN, 30-day TTL, costs Anthropic tokens to rebuild |
| OIDC provider | **creates it** (hazard 1) | imports it by ARN string |
| Node | 22, `NODEJS_22_X` | 24, `NODEJS_24_X` |
| Unit tests | none; Playwright only | vitest on `packages/hn` and the enrich module |
| Auth | `getUserId` returns a constant `'dev'` | `getUserId` returns `null` |

Both have `AWS_DEPLOY_ROLE_ARN` set as a repo variable and `CLAUDE_CODE_OAUTH_TOKEN` as a secret,
both are public, and both keep a `claude.yml` workflow cdk-core does not have — it survives the
migration untouched.

Thai's cross-stack values are `weak` references passed as named `CfnOutput` exports and
`Fn.importValue`; changing export names while a preview stack still imports them hits
CloudFormation's "export in use" wall. Yahn has no exports but hard-codes the certificate ARN.

**Suggested order: yahn first.** Its shape is closest to the reference — cdk-core's patterns were
copied from it — so it gives the cleanest first measurement, and its backend re-rooting is
self-contained. Thai second, because it proves the checklist generalizes to a second hosted zone
and because its OIDC stack is the one carrying the account-wide provider. Phase 0 still happens
before either.

## What to measure

The migration is the first real test of A3's second half: **≤ 30 minutes of human actions** to
onboard a site. Nobody has ever walked it end to end. Time the human steps on the first site —
the by-hand OIDC deploy, the repo variable, the Google redirect URI if auth is in scope, the
hosted-zone check — and report the number, not an impression. Also worth capturing, since both
are claims the package makes and neither has been observed on a second site: time from `git push`
to a green preview comment, and whether a torn-down preview is fully absent from the outside a
minute after the stack delete completes.

## Open in cdk-core that affects a migration

- **#12, log groups** — hazard 6. Both repos currently do better than the package here.
- The KVS retry path has never been observed retrying under a real conflict.
- `CachePolicies.originDecides` has never been used by anything. Yahn's `/api/*` is cached today
  with a 300 s max TTL, so its migration is the first real consumer of that policy.
- The refresh path has never refreshed a real Cognito token, and `logout()` is local-only —
  relevant only if auth is in scope.
